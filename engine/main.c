// SPDX-License-Identifier: GPL-3.0-or-later
/*
    This file is part of Immage, built on darktable,
    Copyright (C) 2026 the Immage authors.

    Immage is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    Immage is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with Immage.  If not, see <http://www.gnu.org/licenses/>.
*/

// darktable-engine: a long-lived headless session that keeps one image open
// in a persistent pixelpipe, so an edit only reprocesses the modules after
// the one that changed. one JSON object per line on stdin, one reply per line
// on stdout. the catalog is in memory; the image's XMP sidecar is the only
// persistent store

#include "engine.h"

#ifdef _WIN32
// darktable links its programs with -municode: this supplies the wmain()
// that asks for, handing main() its arguments (paths) as UTF-8
#include "win/main_wrapper.h"
#endif

dt_engine_session_t _s = { 0 };

#if !defined(NDEBUG) || defined(ENG_LOCK_DEBUG)
// the ranks this thread holds, in the order taken (see the lock order in
// engine.h). unlocks may come in any order, so a drop removes its entry
#define _LOCK_DEPTH 16
static _Thread_local int _held[_LOCK_DEPTH];
static _Thread_local int _nheld = 0;

void engine_lock_taking(const eng_lock_rank_t rank)
{
  for(int i = 0; i < _nheld; i++)
    if(_held[i] >= (int)rank)
      g_error("lock order: taking rank %d while holding rank %d", (int)rank, _held[i]);
}

void engine_lock_taken(const eng_lock_rank_t rank)
{
  if(_nheld >= _LOCK_DEPTH) g_error("lock order: more than %d locks held", _LOCK_DEPTH);
  _held[_nheld++] = (int)rank;
}

void engine_lock_dropping(const eng_lock_rank_t rank)
{
  for(int i = _nheld - 1; i >= 0; i--)
    if(_held[i] == (int)rank)
    {
      memmove(&_held[i], &_held[i + 1], (_nheld - i - 1) * sizeof(int));
      _nheld--;
      return;
    }
  g_error("lock order: dropping rank %d, which this thread does not hold", (int)rank);
}
#endif

// the base render a `cancel_base` can stop, by its client id, and the
// latest id canceled: a cancel can come in before its base has started.
// the request reader (_read_requests) and the main thread share them
GMutex engine_cancel_lock;
static gint64 _base_running, _base_canceled;

// foreground work comes first: the main loop's requests (renders, edits,
// zoom) are what the user waits on, so the import and thumbnail threads
// call engine_background_yield() before each file and wait while the main loop is
// busy, has requests queued, or finished one moments ago. a bounded wait
// keeps a long edit session from starving them for good, and a client's
// batch from outrunning its timeout
static GAsyncQueue *_requests = NULL;
static GMutex _fg_lock;
static gboolean _fg_busy = FALSE;
static gint64 _fg_last = 0;
#define _FG_GRACE_US 300000
#define _FG_MAX_WAIT_US 2000000

static void _foreground(const gboolean busy)
{
  eng_lock(&_fg_lock, ENG_LOCK_FG);
  _fg_busy = busy;
  _fg_last = g_get_monotonic_time();
  eng_unlock(&_fg_lock, ENG_LOCK_FG);
}

void engine_background_yield(void)
{
  const gint64 start = g_get_monotonic_time();
  while(TRUE)
  {
    const gint64 now = g_get_monotonic_time();
    eng_lock(&_fg_lock, ENG_LOCK_FG);
    const gboolean quiet = !_fg_busy && now - _fg_last >= _FG_GRACE_US;
    eng_unlock(&_fg_lock, ENG_LOCK_FG);
    if(quiet && (!_requests || g_async_queue_length(_requests) <= 0)) return;
    if(now - start >= _FG_MAX_WAIT_US) return;
    g_usleep(15000);
  }
}

// exports, merges, prints, prefetch decodes and denoise run at a
// lower priority than the main loop, so a render the user waits on gets the
// cores first and the background work takes what is left; with nothing in
// the foreground it runs as fast as before. their pools are exclusive
// (main): GLib shares a non-exclusive pool's threads with every other such
// pool, and Linux lets an ordinary process lower a thread's priority but
// never raise it back. imports and thumbnails stay at normal priority, as
// they already yield (engine_background_yield) and starve without it, and so do
// AI masks (ai_run), which the user is waiting on. OpenMP
// workers created by a lowered thread inherit it on Linux (libgomp keeps a
// team per thread); libomp (macOS) shares its workers and Windows does not
// inherit, so there only the thread itself is lowered
void engine_background_priority(void)
{
  static _Thread_local gboolean lowered = FALSE;
  if(lowered) return;
  lowered = TRUE;
#if defined(__linux__)
  // nice is per thread on Linux, and who = 0 is the calling thread (kernel/sys.c)
  if(setpriority(PRIO_PROCESS, 0, 10))
    fprintf(stderr, "[engine] cannot lower a background thread's priority: %s\n", g_strerror(errno));
#elif defined(__APPLE__)
  const int rc = pthread_set_qos_class_self_np(QOS_CLASS_UTILITY, 0);
  if(rc) fprintf(stderr, "[engine] cannot lower a background thread's priority: %s\n", g_strerror(rc));
#elif defined(_WIN32)
  // not THREAD_MODE_BACKGROUND_BEGIN: it also lowers I/O and memory
  // priority, and exports would crawl
  if(!SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL))
    fprintf(stderr, "[engine] cannot lower a background thread's priority: error %lu\n", GetLastError());
#endif
}

#ifndef _WIN32
// a crash leaves its backtrace in the log (stderr), below the request it
// died on: darktable's own handler is for Linux only
// (common/system_signal_handling.c)
static void _crash(int sig)
{
  void *frames[64];
  const int n = backtrace(frames, G_N_ELEMENTS(frames));
  static const char msg[] = "[engine] crashed, backtrace:\n";
  if(write(STDERR_FILENO, msg, sizeof(msg) - 1) < 0) {}
  backtrace_symbols_fd(frames, n, STDERR_FILENO);
  signal(sig, SIG_DFL);
  raise(sig);
}
#endif

double engine_ms_since(const gint64 t0)
{
  return (g_get_monotonic_time() - t0) / 1000.0;
}

// the main loop and the thumbnail, export and denoise threads all reply
static GMutex _reply_lock;

// the "rid" of the request being handled; only the main loop sets it, so
// replies from pool threads never echo it (Engine::request in engine.rs
// matches untagged replies by it)
static _Thread_local gint64 _request_rid = -1;

void engine_reply(FILE *out, JsonBuilder *b)
{
  JsonGenerator *gen = json_generator_new();
  JsonNode *root = json_builder_get_root(b);
  if(_request_rid >= 0 && JSON_NODE_HOLDS_OBJECT(root))
    json_object_set_int_member(json_node_get_object(root), "rid", _request_rid);
  json_generator_set_root(gen, root);
  gchar *s = json_generator_to_data(gen, NULL);
  eng_lock(&_reply_lock, ENG_LOCK_REPLY);
  fprintf(out, "%s\n", s);
  fflush(out);
  eng_unlock(&_reply_lock, ENG_LOCK_REPLY);
  g_free(s);
  json_node_unref(root);
  g_object_unref(gen);
}

static void _reply_error(FILE *out, const char *fmt, ...)
{
  va_list ap;
  va_start(ap, fmt);
  gchar *msg = g_strdup_vprintf(fmt, ap);
  va_end(ap);
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, FALSE);
  json_builder_set_member_name(b, "error");
  json_builder_add_string_value(b, msg);
  json_builder_end_object(b);
  engine_reply(out, b);
  g_object_unref(b);
  g_free(msg);
}


// FALSE when base `id` was canceled before it could start. a stop request
// made before the run is kept by dt_dev_pixelpipe_process
// (pixelpipe_hb.c), so only one left from an earlier run is cleared here
static gboolean _base_start(const gint64 id)
{
  eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
  dt_atomic_set_int(&_s.base.pipe.shutdown, DT_DEV_PIXELPIPE_STOP_NO);
  const gboolean go = id > _base_canceled;
  _base_running = go ? id : 0;
  eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
  return go;
}

// whether the base just rendered was canceled meanwhile
static gboolean _base_end(void)
{
  eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
  const gboolean canceled = _base_running && _base_running <= _base_canceled;
  _base_running = 0;
  dt_atomic_set_int(&_s.base.pipe.shutdown, DT_DEV_PIXELPIPE_STOP_NO);
  eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
  return canceled;
}

// every base up to `id`: the one rendering stops at its next module, as the
// darkroom's pipes do for a new edit. a module late in the pipe finishes
// all the same (pixelpipe_hb.c, _module_pipe_stop)
static void _cancel_base(const gint64 id)
{
  eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
  _base_canceled = MAX(_base_canceled, id);
  if(_base_running && _base_running <= id)
    dt_atomic_set_int(&_s.base.pipe.shutdown, DT_DEV_PIXELPIPE_STOP_NODES);
  eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
}

#include "transient_output.h"

// transient_output.h keeps its state in file statics, so the other files
// write through this one copy
gboolean engine_transient_write(const char *path, const void *first, size_t a,
                                const void *second, size_t b)
{
  return transient_write(path, first, a, second, b);
}

#if defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
int engine_transient_shared_open(const char *name, size_t length)
{
  return transient_shared_open(name, length);
}
#endif

void engine_add_string(JsonBuilder *b, const char *name, const char *value)
{
  json_builder_set_member_name(b, name);
  json_builder_add_string_value(b, value ? value : "");
}

void engine_add_double(JsonBuilder *b, const char *name, const double value)
{
  json_builder_set_member_name(b, name);
  json_builder_add_double_value(b, value);
}

// darktable's OpenCL devices, for the GUI benchmark's report: the idle base
// render runs on one when OpenCL is up, and its driver differs between
// systems on the same machine
void engine_add_int(JsonBuilder *b, const char *name, const gint64 value)
{
  json_builder_set_member_name(b, name);
  json_builder_add_int_value(b, value);
}

void engine_add_bool(JsonBuilder *b, const char *name, const gboolean value)
{
  json_builder_set_member_name(b, name);
  json_builder_add_boolean_value(b, value);
}

// the commands, by name. _CMD_NEEDS_OPEN ones answer "no image open" before
// they run; _CMD_EDITS ones leave the open photo unsaved
#define _CMD_NEEDS_OPEN 1
#define _CMD_EDITS 2

typedef gboolean (*_cmd_fn)(JsonObject *req, JsonBuilder *b, char **err);

typedef struct eng_cmd_t
{
  const char *name;
  _cmd_fn fn;
  int flags;
} eng_cmd_t;

// when _handle() took the request, for the render reply's process_ms, which
// the handler writes (a handler has no access to _handle()'s locals)
static _Thread_local gint64 _req_t0;

static gboolean _cmd_open(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *path = json_object_get_string_member_with_default(req, "path", NULL);
// the full pipe's larger cache keeps demosaic output across edits, which
// the preview pipe's budget does not
  const char *kind = json_object_get_string_member_with_default(req, "pipe", "full");
  const dt_imgid_t version = json_object_get_int_member_with_default(req, "imgid", NO_IMGID);
  if(!path || !session_open_image(path, version, kind, err)) return FALSE;
  json_builder_set_member_name(b, "imgid");
  json_builder_add_int_value(b, _s.imgid);
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, _s.pipe.processed_width);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, _s.pipe.processed_height);
// the geometry modules ahead of flip (ashift, lens) work on the sensor
// frame after rawprepare's crop, in the camera's own orientation
  json_builder_set_member_name(b, "sensor_width");
  json_builder_add_int_value(b, _s.dev.image_storage.p_width);
  json_builder_set_member_name(b, "sensor_height");
  json_builder_add_int_value(b, _s.dev.image_storage.p_height);
  json_builder_set_member_name(b, "orientation");
  json_builder_add_int_value(b, _s.dev.image_storage.orientation);
// a raw gets the client's raw-only defaults, as Lightroom's do
  json_builder_set_member_name(b, "raw");
  json_builder_add_boolean_value(b, dt_image_is_raw(&_s.dev.image_storage));
  json_builder_set_member_name(b, "look");
  const char *look = looks_look_name();
  if(look) json_builder_add_string_value(b, look); else json_builder_add_null_value(b);
  json_builder_set_member_name(b, "look_amount");
  json_builder_add_double_value(b, looks_look_amount_value());
// whether its history holds anything yet, here or in darktable
  json_builder_set_member_name(b, "edited");
  json_builder_add_boolean_value(b, dt_image_altered(_s.imgid));
// no history at all before this open: the client's new-photo defaults
// apply. a photo stamped with them reads unedited, so "edited" cannot say
  json_builder_set_member_name(b, "fresh");
  json_builder_add_boolean_value(b, _s.fresh);
  return TRUE;
}

static gboolean _cmd_history(JsonObject *req, JsonBuilder *b, char **err)
{
// the open image's darktable history, oldest first, as darktable's
// history module lists it: the module, its instance label, on or off
  if(!_s.open) { *err = g_strdup("no image open"); return FALSE; }
  json_builder_set_member_name(b, "items");
  json_builder_begin_array(b);
// with "saved", the history as the last save stored it, compressed; the
// develop's own keeps every change of the session (session_save())
  if(json_object_get_boolean_member_with_default(req, "saved", FALSE))
    session_saved_history(b);
  else
  {
    int k = 0;
    for(GList *l = _s.dev.history; l && k < _s.dev.history_end; l = g_list_next(l), k++)
    {
      const dt_dev_history_item_t *h = l->data;
      session_history_item(b, h->op_name, h->module->name(), h->multi_name, h->multi_name_hand_edited,
                    h->enabled, h->multi_priority, h->module);
    }
  }
  json_builder_end_array(b);
  return TRUE;
}

static gboolean _cmd_folder(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *dir = json_object_get_string_member_with_default(req, "path", NULL);
  const gboolean recursive = json_object_get_boolean_member_with_default(req, "recursive", FALSE);
  if(!dir || !library_folder(dir, recursive, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_import(JsonObject *req, JsonBuilder *b, char **err)
{
  library_import_files(req, b, FALSE);
  return TRUE;
}

static gboolean _cmd_thumb(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *dest = json_object_get_string_member_with_default(req, "out", NULL);
  if(!dest || !library_thumb(json_object_get_int_member_with_default(req, "imgid", 0),
                      json_object_get_int_member_with_default(req, "size", 256),
                      json_object_get_boolean_member_with_default(req, "proof", FALSE), dest, b, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_prefetch(JsonObject *req, JsonBuilder *b, char **err)
{
// the reply does not wait for the decode. `imgids` in the order to
// decode them, or one `imgid`
  JsonArray *ids = json_object_has_member(req, "imgids") ? json_object_get_array_member(req, "imgids") : NULL;
  const guint n = ids ? MIN(json_array_get_length(ids), 16) : 1;
  dt_imgid_t list[16];
  for(guint k = 0; k < n; k++)
    list[k] = ids ? json_array_get_int_element(ids, k) : json_object_get_int_member_with_default(req, "imgid", 0);
  library_prefetch(list, n);
  return TRUE;
}

static gboolean _cmd_meta(JsonObject *req, JsonBuilder *b, char **err)
{
  // an id that is not in the library has no row for the image cache to read:
  // it answers an error, as the other commands do
  const dt_imgid_t imgid = json_object_get_int_member_with_default(req, "imgid", 0);
  if(!dt_is_valid_imgid(imgid) || !dt_image_exists(imgid))
  {
    *err = g_strdup("no such image");
    return FALSE;
  }
  json_builder_set_member_name(b, "image");
  library_image_json(b, imgid, TRUE);
  return TRUE;
}

static gboolean _cmd_keywords(JsonObject *req, JsonBuilder *b, char **err)
{
  library_all_keywords(b);
  return TRUE;
}

static gboolean _cmd_data_backup(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_data_backup(req, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_ai_accel(JsonObject *req, JsonBuilder *b, char **err)
{
#ifdef HAVE_AI
  device_ai_accel(b);
#else
  json_builder_set_member_name(b, "providers");
  json_builder_begin_array(b);
  json_builder_end_array(b);
#endif
  return TRUE;
}

static gboolean _cmd_opencl(JsonObject *req, JsonBuilder *b, char **err)
{
  device_opencl(b);
  return TRUE;
}

static gboolean _cmd_parity(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!device_parity(req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_keywords_set(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_keywords_set(json_object_get_int_member_with_default(req, "imgid", 0), req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_capture_times(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_capture_times(req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_meta_set(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_meta_set(json_object_get_int_member_with_default(req, "imgid", 0), req, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_export(JsonObject *req, JsonBuilder *b, char **err)
{
  const dt_imgid_t imgid = json_object_get_int_member_with_default(req, "imgid", 0);
// the open image's latest edits may not be in the library yet, and
// export reads its history from there; the frame's size needs its crop.
// in the Before view they went in as it came on ("before" below)
  if(_s.open && _s.imgid == imgid && !_s.before) dt_dev_write_history_ext(&_s.dev, imgid);
  if(!export_export(imgid, req, err)) return FALSE;
  return TRUE;
}

// printing (print.c): an untagged `print` renders in the main loop, as
// `export` does; the app's are tagged and run on the export thread
static gboolean _cmd_print(JsonObject *req, JsonBuilder *b, char **err)
{
  if(json_object_has_member(req, "pages"))
  {
    // the open photo's latest edits go to the library first, as for one photo
    if(_s.open && !_s.before) dt_dev_write_history_ext(&_s.dev, _s.imgid);
    if(!print_sheet(req, NULL, NULL, NULL, NULL, b, err)) return FALSE;
    return TRUE;
  }
  const dt_imgid_t imgid = json_object_get_int_member_with_default(req, "imgid", 0);
  if(_s.open && _s.imgid == imgid && !_s.before) dt_dev_write_history_ext(&_s.dev, imgid);
  if(!print_image(imgid, req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_print_profiles(JsonObject *req, JsonBuilder *b, char **err)
{
  json_builder_set_member_name(b, "profiles");
  print_profiles(b);
  return TRUE;
}

static gboolean _cmd_print_profile_add(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!print_profile_add(json_object_get_string_member_with_default(req, "path", NULL), b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_printers(JsonObject *req, JsonBuilder *b, char **err)
{
  json_builder_set_member_name(b, "available");
  json_builder_add_boolean_value(b, print_available());
  json_builder_set_member_name(b, "printers");
  print_printers(b);
  return TRUE;
}

static gboolean _cmd_printer(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!print_printer(json_object_get_string_member_with_default(req, "name", NULL), b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_softproof(JsonObject *req, JsonBuilder *b, char **err)
{
  gboolean changed = FALSE;
  if(!print_softproof(json_object_get_string_member_with_default(req, "mode", "off"),
                      json_object_get_string_member_with_default(req, "profile", NULL),
                      json_object_get_int_member_with_default(req, "intent", DT_INTENT_PERCEPTUAL),
                      &changed, err))
    return FALSE;
// colorout builds its proofing transform when committed, and the mode
// is in neither its params nor their hash (colorout.c, commit_params),
// so every pipe commits it again and drops what it kept from colorout
// on, as darktable's soft proof button does (darkroom.c)
  char *ignored = NULL;
  const dt_iop_module_t *cout = changed && _s.open ? session_module("colorout", &ignored) : NULL;
  g_free(ignored);
  if(cout)
  {
    masks_invalidate_from(cout->iop_order, "softproof ");
    session_changed(DT_DEV_PIPE_SYNCH);
  }
  json_builder_set_member_name(b, "changed");
  json_builder_add_boolean_value(b, changed);
  return TRUE;
}

// the photos a background export (tagged `export`s of this `job`) is to
// render, each as its edit is now
static gboolean _cmd_export_hold(JsonObject *req, JsonBuilder *b, char **err)
{
  if(_s.open && !_s.before) dt_dev_write_history_ext(&_s.dev, _s.imgid);
  session_hold(json_object_get_int_member_with_default(req, "job", 0),
        json_object_has_member(req, "imgids") ? json_object_get_array_member(req, "imgids") : NULL,
        _s.open ? _s.imgid : NO_IMGID);
  return TRUE;
}

static gboolean _cmd_fonts(JsonObject *req, JsonBuilder *b, char **err)
{
  export_fonts(b);
  return TRUE;
}

static gboolean _cmd_spektra_stocks(JsonObject *req, JsonBuilder *b, char **err)
{
  film_spektra_stocks(b);
  return TRUE;
}

static gboolean _cmd_spektra_fetch(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!film_spektra_fetch(req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_copy(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_copy(json_object_get_int_member_with_default(req, "imgid", 0), b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_remove_copy(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_remove_copy(json_object_get_int_member_with_default(req, "imgid", 0), b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_forget(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_forget(json_object_get_int_member_with_default(req, "imgid", 0), err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_sidecars(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_sidecars(json_object_get_int_member_with_default(req, "imgid", 0), b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_version(JsonObject *req, JsonBuilder *b, char **err)
{
// darktable's own, which picks the AI models' release
  json_builder_set_member_name(b, "version");
  json_builder_add_string_value(b, darktable_package_version);
// whether Merge to HDR can align brackets: darktable built with OpenCV
  json_builder_set_member_name(b, "hdr_align");
  json_builder_add_boolean_value(b, hdr_merge_can_align());
// whether Panorama Merge can stitch: the engine built with OpenCV's
// stitching module (CMakeLists.txt)
  json_builder_set_member_name(b, "pano");
#ifdef HAVE_PANO
  json_builder_add_boolean_value(b, TRUE);
#else
  json_builder_add_boolean_value(b, FALSE);
#endif
  return TRUE;
}

static gboolean _cmd_hdr_merge(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!export_hdr_merge(req, b, NULL, err)) return FALSE;
  return TRUE;
}

#ifdef HAVE_PANO
static gboolean _cmd_pano_merge(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!export_pano_merge(req, b, NULL, err)) return FALSE;
  return TRUE;
}
#endif

static gboolean _cmd_unpack(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!library_unpack(json_object_get_string_member_with_default(req, "archive", NULL),
              json_object_get_string_member_with_default(req, "dir", NULL), err)) return FALSE;
  return TRUE;
}

// the styles outlive this process (data.db), and looks_style_items() keeps the
// one it has by a name: a look imported under that name must replace it
static gboolean _cmd_style_forget(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  if(!name) return FALSE;
  dt_styles_delete_by_name_adv(name, FALSE, FALSE);
  return TRUE;
}

static gboolean _cmd_paste_batch(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!session_paste_batch(req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_set(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *op = json_object_get_string_member_with_default(req, "op", NULL);
  const char *field = json_object_get_string_member_with_default(req, "field", NULL);
  JsonNode *value = json_object_get_member(req, "value");
  const gboolean has_enabled = json_object_has_member(req, "enabled");
  const gboolean enabled = has_enabled && json_object_get_boolean_member(req, "enabled");
  JsonObject *params = json_object_has_member(req, "params")
    ? json_object_get_object_member(req, "params") : NULL;
  const char *after = json_object_get_string_member_with_default(req, "after", NULL);
  const char *before = json_object_get_string_member_with_default(req, "before", NULL);
  const char *instance = json_object_get_string_member_with_default(req, "instance", NULL);
  const char *mask = json_object_get_string_member_with_default(req, "mask", NULL);
  const gboolean invert = json_object_get_boolean_member_with_default(req, "invert", FALSE);
  const double opacity = json_object_get_double_member_with_default(req, "opacity", -1.0);
  JsonObject *refine = json_object_has_member(req, "refine")
    ? json_object_get_object_member(req, "refine") : NULL;
  if(!op || !session_set(op, field, value, params, has_enabled, enabled, after, before, instance, mask, invert, opacity,
                  refine, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_color_profiles(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!session_color_profiles(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_lenses(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!session_lens_menu(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_module_state(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!session_module_state(json_object_get_string_member_with_default(req, "op", NULL),
                    json_object_get_int_member_with_default(req, "priority", 0),
                    json_object_has_member(req, "enabled"),
                    json_object_get_boolean_member_with_default(req, "enabled", FALSE),
                    json_object_get_boolean_member_with_default(req, "reset", FALSE),
                    json_object_has_member(req, "restore")
                      ? json_object_get_object_member(req, "restore") : NULL,
                    b, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_get(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonObject *ops = json_object_has_member(req, "modules")
    ? json_object_get_object_member(req, "modules") : NULL;
  if(!ops || !session_get(ops, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_render(JsonObject *req, JsonBuilder *b, char **err)
{
// "draft": a slider drag's frame, on the drag pipe so the main pipe's
// cache keeps the full frame's earlier modules for the release. "base":
// the idle whole-image render, on the base pipe and a GPU if one is free
  dt_engine_follower_t *f = json_object_get_boolean_member_with_default(req, "draft", FALSE) ? &_s.drag
    : json_object_get_boolean_member_with_default(req, "base", FALSE) ? &_s.base : NULL;
  if(f && !session_follower_ready(f, err)) return FALSE;
  dt_dev_pixelpipe_t *pipe = f ? &f->pipe : &_s.pipe;
// a base's id, which `cancel_base` names; without one it runs to the end
  const gint64 base_id = f == &_s.base ? json_object_get_int_member_with_default(req, "id", 0) : 0;
  if(base_id && !_base_start(base_id))
  {
    *err = g_strdup("canceled");
    return FALSE;
  }
// the export pipe's device priority, which allows the GPU; the full
// pipes' allows it only with the app's GPU edits (engine.rs, gpu_edits)
  const int devid = f == &_s.base && dt_opencl_running()
    ? dt_opencl_lock_device(DT_DEV_PIXELPIPE_EXPORT) : DT_DEVICE_NONE;
// "skip": ops left out of this one frame, every instance, so a slider
// drag need not wait on grain or diffuse. a disabled piece carries
// DT_INVALID_HASH (imageop.c, dt_iop_commit_params), which keeps these
// frames off the full frames' cachelines. history is not touched
  JsonArray *skip = json_object_has_member(req, "skip")
    ? json_object_get_array_member(req, "skip") : NULL;
  typedef struct { dt_dev_pixelpipe_iop_t *piece; dt_hash_t hash; } skipped_t;
  GArray *skipped = g_array_new(FALSE, FALSE, sizeof(skipped_t));
  for(GList *n = skip ? pipe->nodes : NULL; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *piece = n->data;
    if(!piece->enabled) continue;
    for(guint k = 0; k < json_array_get_length(skip); k++)
      if(!g_strcmp0(piece->module->op, json_array_get_string_element(skip, k)))
      {
        const skipped_t s = { piece, piece->hash };
        g_array_append_val(skipped, s);
        piece->enabled = FALSE;
        piece->hash = DT_INVALID_HASH;
        break;
      }
  }
// "have": the client's frames, by hash; one of them is named, not sent
  JsonArray *have = json_object_has_member(req, "have")
    ? json_object_get_array_member(req, "have") : NULL;
  int w = 0, h = 0, ox = 0, oy = 0;
  dt_hash_t kept = DT_INVALID_HASH;
  const char *ppm = json_object_get_string_member_with_default(req, "out", NULL);
  const char *rgba = json_object_get_string_member_with_default(req, "rgba", NULL);
  preview_output_t output = { .path = rgba };
// PPM and non-byte consumers retain their ordinary owned back buffer.
  preview_output_t *sink = rgba && !ppm ? &output : NULL;
  const int cl_errors = darktable.opencl->error_count;
  const gboolean ok = session_render(pipe, devid, json_object_get_int_member_with_default(req, "width", 2048),
                              json_object_get_int_member_with_default(req, "height", 2048),
                              json_object_get_double_member_with_default(req, "scale", 0.0),
                              json_object_get_int_member_with_default(req, "x", 0),
                              json_object_get_int_member_with_default(req, "y", 0),
                              have, &w, &h, &ox, &oy, &kept, sink, err);
  if(base_id && _base_end() && !ok)
  {
    // a stop on the GPU leaves the previous module's cacheline holding a
    // hash but no pixels: its data was on the device only, and the early
    // shutdown test releases it without invalidating the line
    // (pixelpipe_hb.c, _pipe_has_shutdown in _dev_pixelpipe_process_rec).
    // the darkroom rebuilds its pipes after such a stop; this one is kept.
    // a CPU's lines are written whole, so they stay
    if(devid > DT_DEVICE_CPU) dt_dev_pixelpipe_cache_flush(pipe);
    g_free(*err);
    *err = g_strdup("canceled");
  }
  for(guint k = 0; k < skipped->len; k++)
  {
    const skipped_t *s = &g_array_index(skipped, skipped_t, k);
    s->piece->enabled = TRUE;
    s->piece->hash = s->hash;
  }
  g_array_free(skipped, TRUE);
  if(devid > DT_DEVICE_CPU) dt_opencl_unlock_device(devid);
  if(!ok) return FALSE;
// the image's size at 100%, after every geometry change, so a client
// can place a zoomed window
// a pipe that failed on its device and was rerun on the CPU
// (pixelpipe_hb.c, dt_dev_pixelpipe_process); the GPU check reads it
  engine_add_int(b, "cl_errors", darktable.opencl->error_count - cl_errors);
  json_builder_set_member_name(b, "full_width");
  json_builder_add_int_value(b, pipe->processed_width);
  json_builder_set_member_name(b, "full_height");
  json_builder_add_int_value(b, pipe->processed_height);
  json_builder_set_member_name(b, "x");
  json_builder_add_int_value(b, ox);
  json_builder_set_member_name(b, "y");
  json_builder_add_int_value(b, oy);
  const double process_ms = engine_ms_since(_req_t0);
  if(kept != DT_INVALID_HASH)
  {
    // a frame of no size, with the hash of the one the client holds
    json_builder_set_member_name(b, "width");
    json_builder_add_int_value(b, 0);
    json_builder_set_member_name(b, "height");
    json_builder_add_int_value(b, 0);
    gchar *hash = g_strdup_printf("%016" PRIx64, kept);
    engine_add_string(b, "hash", hash);
    g_free(hash);
    json_builder_set_member_name(b, "kept");
    json_builder_add_boolean_value(b, TRUE);
    json_builder_set_member_name(b, "process_ms");
    json_builder_add_double_value(b, process_ms);
  }
  else
  {
    if(ppm && !session_write_ppm(ppm, pipe->backbuf, w, h))
    {
      *err = g_strdup_printf("could not write '%s'", ppm);
      return FALSE;
    }
    const gint64 t1 = g_get_monotonic_time();
    double output_ms[4] = {0};
    if(sink) memcpy(output_ms, output.timings, sizeof(output_ms));
    if(rgba && !sink && !session_write_rgba(rgba, pipe->backbuf, w, h, output_ms))
    {
      *err = g_strdup_printf("could not write '%s'", rgba);
      return FALSE;
    }
    json_builder_set_member_name(b, "width");
    json_builder_add_int_value(b, w);
    json_builder_set_member_name(b, "height");
    json_builder_add_int_value(b, h);
    // the frame's hash, the same for one rendered again with nothing
    // changed: a client can tell that frame from a new one
    gchar *hash = g_strdup_printf("%016" PRIx64, session_frame_hash(pipe->backbuf_hash));
    engine_add_string(b, "hash", hash);
    g_free(hash);
    json_builder_set_member_name(b, "process_ms");
    json_builder_add_double_value(b, process_ms);
    json_builder_set_member_name(b, "write_ms");
    json_builder_add_double_value(b, engine_ms_since(t1));
    if(sink)
    {
      // This output work is already included in process_ms, not write_ms.
      json_builder_set_member_name(b, "process_output_ms");
      json_builder_add_double_value(b, output.elapsed_ms);
    }
    if(rgba)
    {
      const char *keys[] = { "allocate_ms", "convert_ms", "file_ms", "free_ms" };
      json_builder_set_member_name(b, "output_ms");
      json_builder_begin_object(b);
      for(size_t k = 0; k < G_N_ELEMENTS(keys); k++)
      {
        json_builder_set_member_name(b, keys[k]);
        json_builder_add_double_value(b, output_ms[k]);
      }
      json_builder_end_object(b);
    }
  }
  session_settle(pipe);
  return TRUE;
}

static gboolean _cmd_mask(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  JsonArray *shapes = json_object_has_member(req, "shapes")
    ? json_object_get_array_member(req, "shapes") : NULL;
  if(!name || !masks_mask(name, shapes, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_combine(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  JsonArray *members = json_object_has_member(req, "members")
    ? json_object_get_array_member(req, "members") : NULL;
  JsonNode *rn = json_object_get_member(req, "ranges");
  JsonArray *ranges = rn && JSON_NODE_HOLDS_ARRAY(rn) ? json_node_get_array(rn) : NULL;
  if(!name || !masks_combine(name, members, ranges, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_spots(JsonObject *req, JsonBuilder *b, char **err)
{
// with `spots`, they replace the image's; the reply is them as kept
  if(json_object_has_member(req, "spots")
     && !masks_spots_set(json_object_get_array_member(req, "spots"), err))
    return FALSE;
  if(!masks_spots_json(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_spots_enable(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!masks_spots_enable(json_object_get_boolean_member_with_default(req, "on", TRUE), err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_spot_source(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonObject *spot = json_object_has_member(req, "spot") ? json_object_get_object_member(req, "spot") : NULL;
  if(!spot)
  {
    *err = g_strdup("no spot given");
    return FALSE;
  }
  if(!masks_spot_source(spot, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_masks(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonObject *fields = json_object_has_member(req, "fields")
    ? json_object_get_object_member(req, "fields") : NULL;
  if(!masks_masks(fields, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_sample(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!masks_sample(json_object_get_double_member_with_default(req, "x", 0.5),
              json_object_get_double_member_with_default(req, "y", 0.5),
              json_object_has_member(req, "box") && !json_object_get_null_member(req, "box")
                ? json_object_get_array_member(req, "box") : NULL,
              !g_strcmp0(json_object_get_string_member_with_default(req, "stage", NULL), "negadoctor")
                ? _STAGE_NEGADOCTOR : _STAGE_ANCHOR,
              b, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_tone_key(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!masks_tone_key(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_agx_auto(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!masks_agx_auto(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_upright(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonArray *guides = json_object_has_member(req, "guides")
    ? json_object_get_array_member(req, "guides") : NULL;
  if(!masks_upright(json_object_get_string_member_with_default(req, "mode", "auto"), guides,
               json_object_get_double_member_with_default(req, "aspect", 1.0), b, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_points(JsonObject *req, JsonBuilder *b, char **err)
{
  masks_points(json_object_has_member(req, "points") ? json_object_get_array_member(req, "points") : NULL,
          !g_strcmp0(json_object_get_string_member_with_default(req, "to", "shown"), "shown"), b);
  return TRUE;
}

static gboolean _cmd_ai_object(JsonObject *req, JsonBuilder *b, char **err)
{
#ifdef HAVE_AI
  if(!ai_select(req, b, err)) return FALSE;
#else
  *err = g_strdup("this engine was built without AI (USE_AI=OFF)");
  return FALSE;
#endif
  return TRUE;
}

static gboolean _cmd_ai_denoise(JsonObject *req, JsonBuilder *b, char **err)
{
#ifdef HAVE_AI
  if(!ai_denoise(json_object_get_double_member_with_default(req, "strength", 1.0),
                  json_object_get_int_member_with_default(req, "tag", 0), b, err))
    return FALSE;
#else
  *err = g_strdup("this engine was built without AI (USE_AI=OFF)");
  return FALSE;
#endif
  return TRUE;
}

static gboolean _cmd_ai_denoise_preview(JsonObject *req, JsonBuilder *b, char **err)
{
#ifdef HAVE_AI
  if(!ai_denoise_preview(json_object_get_double_member_with_default(req, "u", 0.5),
                          json_object_get_double_member_with_default(req, "v", 0.5),
                          json_object_get_int_member_with_default(req, "size", 512),
                          json_object_get_string_member_with_default(req, "out", NULL), b, err))
    return FALSE;
#else
  *err = g_strdup("this engine was built without AI (USE_AI=OFF)");
  return FALSE;
#endif
  return TRUE;
}

static gboolean _cmd_ai_depth(JsonObject *req, JsonBuilder *b, char **err)
{
#ifdef HAVE_AI
  if(!ai_select(req, b, err)) return FALSE;
#else
  *err = g_strdup("this engine was built without AI (USE_AI=OFF)");
  return FALSE;
#endif
  return TRUE;
}

static gboolean _cmd_ai_mask(JsonObject *req, JsonBuilder *b, char **err)
{
#ifdef HAVE_AI
  if(!ai_select(req, b, err)) return FALSE;
#else
  *err = g_strdup("this engine was built without AI (USE_AI=OFF)");
  return FALSE;
#endif
  return TRUE;
}

static gboolean _cmd_range_map(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonArray *ranges = json_object_has_member(req, "ranges")
    ? json_object_get_array_member(req, "ranges") : NULL;
  const char *dest = json_object_get_string_member_with_default(req, "out", NULL);
  const int w = json_object_get_int_member_with_default(req, "width", 320);
  const int h = json_object_get_int_member_with_default(req, "height", 213);
  if(!dest || !masks_range_map(ranges, w, h, dest, err)) return FALSE;
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, h);
  return TRUE;
}

static gboolean _cmd_zones(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *dest = json_object_get_string_member_with_default(req, "out", NULL);
  const int w = json_object_get_int_member_with_default(req, "width", 320);
  const int h = json_object_get_int_member_with_default(req, "height", 213);
  const float tw = CLAMP(json_object_get_double_member_with_default(req, "transition", 0.5), 0.05, 1.0);
  const char *st = json_object_get_string_member_with_default(req, "stage", "before");
  const _stage_t stage = !g_strcmp0(st, "after") ? _STAGE_TONEMAPPER
    : !g_strcmp0(st, "unplaced") ? _STAGE_UNPLACED : _STAGE_ANCHOR;
  if(!dest || w < 1 || h < 1 || !masks_zones(w, h, tw, stage, dest, b, err)) return FALSE;
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, h);
  return TRUE;
}

static gboolean _cmd_mask_map(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  const char *op = json_object_get_string_member_with_default(req, "op", NULL);
  const char *dest = json_object_get_string_member_with_default(req, "out", NULL);
  int w = json_object_get_int_member_with_default(req, "width", 320);
  int h = json_object_get_int_member_with_default(req, "height", 213);
// a view, as `render` takes one: the map is of that window
  const double scale = json_object_get_double_member_with_default(req, "scale", 0.0);
  const int x = json_object_get_int_member_with_default(req, "x", 0);
  const int y = json_object_get_int_member_with_default(req, "y", 0);
  if((!name && !op) || !dest || !masks_mask_map(name, op, &w, &h, scale, x, y, dest, err)) return FALSE;
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, h);
  return TRUE;
}

static gboolean _cmd_mask_rename(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  const char *to = json_object_get_string_member_with_default(req, "to", NULL);
  if(!name || !masks_mask_rename(name, to, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_mask_delete(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  if(!name || !masks_mask_delete(name, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_look(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *path = json_object_get_string_member_with_default(req, "path", NULL);
  if(!looks_look(path, err)) return FALSE;
  json_builder_set_member_name(b, "look");
  const char *name = looks_look_name();
  if(name) json_builder_add_string_value(b, name); else json_builder_add_null_value(b);
  return TRUE;
}

static gboolean _cmd_agx_presets(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!looks_agx_presets(req, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_look_amount(JsonObject *req, JsonBuilder *b, char **err)
{
  looks_look_amount(json_object_get_double_member_with_default(req, "amount", 100.0));
  return TRUE;
}

static gboolean _cmd_preview(JsonObject *req, JsonBuilder *b, char **err)
{
  int w = 0, h = 0;
  const char *rgba = json_object_get_string_member_with_default(req, "rgba", NULL);
  if(!rgba || !session_preview(req, &w, &h, err)) return FALSE;
  if(!session_write_rgba(rgba, _s.ppipe.backbuf, w, h, NULL))
  {
    *err = g_strdup_printf("could not write '%s'", rgba);
    return FALSE;
  }
  session_settle(&_s.ppipe);
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, h);
  return TRUE;
}

static gboolean _cmd_save(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!session_save(err)) return FALSE;
  json_builder_set_member_name(b, "edited");
  json_builder_add_boolean_value(b, _s.open && dt_image_altered(_s.imgid));
  return TRUE;
}

// the user's first change to a new photo: what is unsaved of the
// defaults goes into the baseline first, and later saves leave it be
static gboolean _cmd_baseline_end(JsonObject *req, JsonBuilder *b, char **err)
{
  if(_s.open && _s.baseline && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
  _s.baseline = FALSE;
  return TRUE;
}

static gboolean _cmd_before(JsonObject *req, JsonBuilder *b, char **err)
{
  const gboolean on = json_object_get_boolean_member_with_default(req, "on", FALSE);
// the client sends this ahead of the Before view's settings, so the
// edit is still here for export to find in the library (export_export)
  if(on && !_s.before && _s.open && _s.unsaved) dt_dev_write_history_ext(&_s.dev, _s.imgid);
  _s.before = on;
  return TRUE;
}

static gboolean _cmd_close(JsonObject *req, JsonBuilder *b, char **err)
{
  session_close_session();
  return TRUE;
}

static gboolean _cmd_quit(JsonObject *req, JsonBuilder *b, char **err)
{
  session_save_pending();
  session_close_session();
  return TRUE;
}

// the commands the stdin reader and the export pool answer themselves
// (_read_requests), listed so the table names every command. one that comes
// here anyway is as unknown as before
static gboolean _cmd_reader_only(JsonObject *req, JsonBuilder *b, char **err)
{
  *err = g_strdup_printf("unknown cmd '%s'", json_object_get_string_member(req, "cmd"));
  return FALSE;
}

static const eng_cmd_t _commands[] =
{
  { "open", _cmd_open, 0 },
  { "history", _cmd_history, 0 },
  { "folder", _cmd_folder, 0 },
  { "import", _cmd_import, 0 },
  { "thumb", _cmd_thumb, 0 },
  { "prefetch", _cmd_prefetch, 0 },
  { "meta", _cmd_meta, 0 },
  { "keywords", _cmd_keywords, 0 },
  { "data_backup", _cmd_data_backup, 0 },
  { "ai_accel", _cmd_ai_accel, 0 },
  { "opencl", _cmd_opencl, 0 },
  { "parity", _cmd_parity, 0 },
  { "keywords_set", _cmd_keywords_set, 0 },
  { "capture_times", _cmd_capture_times, 0 },
  { "meta_set", _cmd_meta_set, 0 },
  { "export", _cmd_export, 0 },
  { "print", _cmd_print, 0 },
  { "print_profiles", _cmd_print_profiles, 0 },
  { "print_profile_add", _cmd_print_profile_add, 0 },
  { "printers", _cmd_printers, 0 },
  { "printer", _cmd_printer, 0 },
  { "softproof", _cmd_softproof, 0 },
  { "export_hold", _cmd_export_hold, 0 },
  { "fonts", _cmd_fonts, 0 },
  { "spektra_stocks", _cmd_spektra_stocks, 0 },
  { "spektra_fetch", _cmd_spektra_fetch, 0 },
  { "copy", _cmd_copy, 0 },
  { "remove_copy", _cmd_remove_copy, 0 },
  { "forget", _cmd_forget, 0 },
  { "sidecars", _cmd_sidecars, 0 },
  { "version", _cmd_version, 0 },
  { "hdr_merge", _cmd_hdr_merge, 0 },
#ifdef HAVE_PANO
  { "pano_merge", _cmd_pano_merge, 0 },
  { "pano_preview", _cmd_pano_merge, 0 },
#endif
  { "unpack", _cmd_unpack, 0 },
  { "style_forget", _cmd_style_forget, 0 },
  { "paste_batch", _cmd_paste_batch, 0 },
  { "set", _cmd_set, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "color_profiles", _cmd_color_profiles, _CMD_NEEDS_OPEN },
  { "lenses", _cmd_lenses, _CMD_NEEDS_OPEN },
  { "module_state", _cmd_module_state, _CMD_NEEDS_OPEN },
  { "get", _cmd_get, _CMD_NEEDS_OPEN },
  { "render", _cmd_render, _CMD_NEEDS_OPEN },
  { "mask", _cmd_mask, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "combine", _cmd_combine, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "spots", _cmd_spots, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "spots_enable", _cmd_spots_enable, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "spot_source", _cmd_spot_source, _CMD_NEEDS_OPEN },
  { "masks", _cmd_masks, _CMD_NEEDS_OPEN },
  { "sample", _cmd_sample, _CMD_NEEDS_OPEN },
  { "tone_key", _cmd_tone_key, _CMD_NEEDS_OPEN },
  { "agx_auto", _cmd_agx_auto, _CMD_NEEDS_OPEN },
  { "upright", _cmd_upright, _CMD_NEEDS_OPEN },
  { "points", _cmd_points, _CMD_NEEDS_OPEN },
  { "ai_object", _cmd_ai_object, _CMD_NEEDS_OPEN },
  { "ai_denoise", _cmd_ai_denoise, _CMD_NEEDS_OPEN },
  { "ai_denoise_preview", _cmd_ai_denoise_preview, _CMD_NEEDS_OPEN },
  { "ai_depth", _cmd_ai_depth, _CMD_NEEDS_OPEN },
  { "ai_mask", _cmd_ai_mask, _CMD_NEEDS_OPEN },
  { "range_map", _cmd_range_map, _CMD_NEEDS_OPEN },
  { "zones", _cmd_zones, _CMD_NEEDS_OPEN },
  { "mask_map", _cmd_mask_map, _CMD_NEEDS_OPEN },
  { "mask_rename", _cmd_mask_rename, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "mask_delete", _cmd_mask_delete, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "look", _cmd_look, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "agx_presets", _cmd_agx_presets, _CMD_NEEDS_OPEN },
  { "look_amount", _cmd_look_amount, _CMD_NEEDS_OPEN | _CMD_EDITS },
  { "preview", _cmd_preview, _CMD_NEEDS_OPEN },
  { "save", _cmd_save, _CMD_NEEDS_OPEN },
  { "baseline_end", _cmd_baseline_end, _CMD_NEEDS_OPEN },
  { "before", _cmd_before, _CMD_NEEDS_OPEN },
  { "close", _cmd_close, _CMD_NEEDS_OPEN },
  { "quit", _cmd_quit, 0 },
  { "cancel_base", _cmd_reader_only, _CMD_NEEDS_OPEN },
  { "export_release", _cmd_reader_only, _CMD_NEEDS_OPEN },
  { "merge_cancel", _cmd_reader_only, _CMD_NEEDS_OPEN },
};

static void _handle(JsonObject *req, FILE *out)
{
  const char *cmd = json_object_has_member(req, "cmd")
    ? json_object_get_string_member(req, "cmd") : NULL;
  char *err = NULL;
  const gint64 t0 = g_get_monotonic_time();
  _req_t0 = t0;

  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);

  const eng_cmd_t *entry = NULL;
  for(size_t k = 0; k < G_N_ELEMENTS(_commands); k++)
    if(!g_strcmp0(cmd, _commands[k].name))
    {
      entry = &_commands[k];
      break;
    }

  // a request the table does not know, and any that needs an open photo,
  // is refused first while none is open (quit is the one that never is)
  if((!entry || (entry->flags & _CMD_NEEDS_OPEN)) && !_s.open && g_strcmp0(cmd, "quit"))
  {
    err = g_strdup("no image open");
    goto fail;
  }
  if(!entry)
  {
    err = g_strdup_printf("unknown cmd '%s'", cmd ? cmd : "(none)");
    goto fail;
  }
  if(!entry->fn(req, b, &err)) goto fail;

  if(_s.open && (entry->flags & _CMD_EDITS)) _s.unsaved = TRUE;
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, TRUE);
  json_builder_set_member_name(b, "ms");
  json_builder_add_double_value(b, engine_ms_since(t0));
  json_builder_end_object(b);
  engine_reply(out, b);
  g_object_unref(b);
  return;

fail:
  g_object_unref(b);
  _reply_error(out, "%s", err ? err : "failed");
  g_free(err);
}

// one request line from stdin, however long, into `s`, with what was read
// past it kept in `rest` for the next; FALSE at the end of input. read()
// rather than stdio: a thread waiting in fgets() holds stdin's lock, and
// glibc's exit() (2.43 on Ubuntu) takes every stream's lock to flush it, so
// the engine never exited after `quit` on Linux
static gboolean _read_line(GString *s, GString *rest)
{
  char buf[65536];
  g_string_assign(s, rest->str);
  g_string_truncate(rest, 0);
  gsize scanned = 0;
  for(;;)
  {
    const char *nl = memchr(s->str + scanned, '\n', s->len - scanned);
    if(nl)
    {
      const gsize end = nl - s->str + 1;
      g_string_append_len(rest, s->str + end, s->len - end);
      g_string_truncate(s, end);
      return TRUE;
    }
    scanned = s->len;
    const ssize_t got = read(STDIN_FILENO, buf, sizeof(buf));
    if(got < 0 && errno == EINTR) continue;
    if(got <= 0) return s->len > 0;
    g_string_append_len(s, buf, got);
  }
}

// the end of input, on the request queue
static char _end_of_input[] = "";

// after this long without a request, the session's pipes drop invalid and
// over-limit cachelines, and the C library gives back its freed pages; the
// lines the next edit reuses stay. under memory pressure the caches are
// emptied before a request, at most once a while (_trim)
#define _IDLE_TRIM_US (20 * G_USEC_PER_SEC)
#define _PRESSURE_POLL_US (2 * G_USEC_PER_SEC)
#define _PRESSURE_TRIM_US (5 * G_USEC_PER_SEC)

#if defined(__APPLE__)
// the system's memory pressure level, from a dispatch source on a queue of
// its own (_pressure_watch)
static gint _pressure_level = 0;

static void _pressure_event(void *source)
{
  const unsigned long level = dispatch_source_get_data((dispatch_source_t)source);
  g_atomic_int_set(&_pressure_level,
                   level & (DISPATCH_MEMORYPRESSURE_WARN | DISPATCH_MEMORYPRESSURE_CRITICAL) ? 1 : 0);
}
#elif defined(_WIN32)
static HANDLE _low_memory = NULL;
#endif

static void _pressure_watch(void)
{
#if defined(__APPLE__)
  dispatch_source_t source =
    dispatch_source_create(DISPATCH_SOURCE_TYPE_MEMORYPRESSURE, 0,
                           DISPATCH_MEMORYPRESSURE_NORMAL | DISPATCH_MEMORYPRESSURE_WARN
                           | DISPATCH_MEMORYPRESSURE_CRITICAL,
                           dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_DEFAULT, 0));
  if(!source) return;
  dispatch_set_context(source, source);
  dispatch_source_set_event_handler_f(source, _pressure_event);
  dispatch_resume(source);
#elif defined(_WIN32)
  _low_memory = CreateMemoryResourceNotification(LowMemoryResourceNotification);
#endif
}

// whether the system is short of memory: on Linux, less than a tenth of
// it available (the kernel's MemAvailable, which counts reclaimable cache)
gboolean engine_memory_pressure(void)
{
#if defined(__APPLE__)
  return g_atomic_int_get(&_pressure_level) != 0;
#elif defined(_WIN32)
  BOOL low = FALSE;
  return _low_memory && QueryMemoryResourceNotification(_low_memory, &low) && low;
#elif defined(__linux__)
  FILE *f = g_fopen("/proc/meminfo", "r");
  if(!f) return FALSE;
  unsigned long long total = 0, avail = 0, v;
  char key[64];
  while((!total || !avail) && fscanf(f, "%63s %llu kB\n", key, &v) == 2)
  {
    if(!strcmp(key, "MemTotal:")) total = v;
    else if(!strcmp(key, "MemAvailable:")) avail = v;
  }
  fclose(f);
  return total && avail && avail < total / 10;
#else
  return FALSE;
#endif
}

// idle: only what is invalid or over its limit goes, so a pause leaves the
// lines the next edit reuses. pressure: darktable's own trim, which empties
// every cache but the lines in use below 6 GB of available memory. halving
// the limits instead kept about 2.5 GB through a film render on a 12 GB
// computer, and the next render's 2 GB peak then left under 1 GB free
static void _trim_pipe(dt_dev_pixelpipe_t *pipe, const gboolean pressure)
{
  dt_dev_pixelpipe_cache_checkmem(pipe, pressure);
}

static void _trim(const gboolean pressure)
{
  if(_s.open)
  {
    _trim_pipe(&_s.pipe, pressure);
    if(_s.ppipe_ok) _trim_pipe(&_s.ppipe, pressure);
    if(_s.drag.ok) _trim_pipe(&_s.drag.pipe, pressure);
    if(_s.base.ok) _trim_pipe(&_s.base.pipe, pressure);
    if(_s.check.ok) _trim_pipe(&_s.check.pipe, pressure);
  }
#if defined(__GLIBC__)
  malloc_trim(0);
#elif defined(__APPLE__)
  malloc_zone_pressure_relief(NULL, 0);
#elif defined(_WIN32)
  _heapmin();
#endif
}

// stdin is read on a thread of its own, so a `cancel_base` (written by the
// client while it waits on a base's reply) stops that base at once, and a
// `merge_cancel` a merge before its next photo. neither gets a reply. a
// tagged `thumb` goes to the thumbnail threads (library_thumb_run), a tagged
// `export`, `export_release`, `hdr_merge`, `pano_merge` or `pano_preview` to the export
// thread (export_run), a tagged `import` to the import thread (library_import_run);
// every other line goes to the main loop, in order. a tagged `ai_denoise`,
// `ai_object`, `ai_mask` or `ai_depth` is among them: the main loop
// answers it, then hands the model's work to a thread (ai_denoise_run,
// ai_run), which answers again with the tag
static gpointer _read_requests(gpointer data)
{
  GAsyncQueue *queue = data;
  GString *line = g_string_new(NULL), *rest = g_string_new(NULL);
  while(_read_line(line, rest))
  {
    gboolean taken = FALSE;
    if(strstr(line->str, "\"tag\"")
       || (line->len < 1024 && (strstr(line->str, "\"cancel_base\"") || strstr(line->str, "\"merge_cancel\""))))
    {
      JsonParser *parser = json_parser_new();
      if(json_parser_load_from_data(parser, line->str, line->len, NULL)
         && JSON_NODE_HOLDS_OBJECT(json_parser_get_root(parser)))
      {
        JsonObject *req = json_node_get_object(json_parser_get_root(parser));
        const char *cmd = json_object_get_string_member_with_default(req, "cmd", "");
        if(!g_strcmp0(cmd, "cancel_base"))
        {
          fprintf(stderr, "[engine] > %.*s\n", (int)strcspn(line->str, "\r\n"), line->str);
          _cancel_base(json_object_get_int_member_with_default(req, "id", 0));
          taken = TRUE;
        }
        else if(!g_strcmp0(cmd, "merge_cancel"))
        {
          fprintf(stderr, "[engine] > %.*s\n", (int)strcspn(line->str, "\r\n"), line->str);
          export_merge_cancel(json_object_get_int_member_with_default(req, "job", 0));
          taken = TRUE;
        }
        else if(!g_strcmp0(cmd, "thumb") && json_object_has_member(req, "tag"))
        {
          fprintf(stderr, "[engine] thumb %.*s\n", (int)strcspn(line->str, "\r\n"), line->str);
          // the pool frees the parser
          if(library_thumb_queue(parser)) parser = NULL;
          taken = TRUE;
        }
        else if((!g_strcmp0(cmd, "export") || !g_strcmp0(cmd, "export_release")
                 || !g_strcmp0(cmd, "print") || !g_strcmp0(cmd, "hdr_merge") || !g_strcmp0(cmd, "pano_merge")
                 || !g_strcmp0(cmd, "pano_preview"))
                && json_object_has_member(req, "tag"))
        {
          fprintf(stderr, "[engine] export %.*s\n", (int)strcspn(line->str, "\r\n"), line->str);
          if(export_queue(parser)) parser = NULL;
          taken = TRUE;
        }
        else if(!g_strcmp0(cmd, "import") && json_object_has_member(req, "tag"))
        {
          fprintf(stderr, "[engine] import %.*s\n", (int)MIN(300, strcspn(line->str, "\r\n")), line->str);
          const gint64 job = json_object_get_int_member_with_default(req, "job", 0);
          if(job)
          {
            eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
            library_import_latest = job;
            eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
          }
          if(library_import_queue(parser)) parser = NULL;
          taken = TRUE;
        }
      }
      if(parser) g_object_unref(parser);
    }
    if(!taken) g_async_queue_push(queue, g_strndup(line->str, line->len));
  }
  g_string_free(line, TRUE);
  g_string_free(rest, TRUE);
  g_async_queue_push(queue, _end_of_input);
  return NULL;
}

int main(int argc, char **argv)
{
  // reserve the real stdout for replies: libdarktable prints to stdout in places
  fflush(stdout);
  FILE *out = fdopen(dup(STDOUT_FILENO), "w");
  dup2(STDERR_FILENO, STDOUT_FILENO);

  // everything after "--core" goes to dt_init, as for darktable-mcp. the
  // catalog lives in memory unless the caller names one
  GPtrArray *m = g_ptr_array_new();
  g_ptr_array_add(m, (gpointer)"darktable-engine");
  g_ptr_array_add(m, (gpointer)"--library");
  g_ptr_array_add(m, (gpointer)":memory:");
  int i = 1;
  while(i < argc && g_strcmp0(argv[i], "--core"))
  {
#ifdef HAVE_AI
    // where the AI models are; given, AI features are on
    if(!g_strcmp0(argv[i], "--models") && i + 1 < argc) ai_models_dir = argv[++i];
#endif
    i++;
  }
  for(i++; i < argc; i++) g_ptr_array_add(m, argv[i]);

#ifdef HAVE_AI
  // The registry checks installed model versions during dt_init. It must
  // inspect the same directory as the inference environment, including on
  // profiles that already have AI enabled or a different saved model path.
  g_autofree char *models_conf = NULL;
  if(ai_models_dir)
  {
    models_conf = g_strdup_printf("plugins/ai/models_path=%s", ai_models_dir);
    g_ptr_array_add(m, (gpointer)"--conf");
    g_ptr_array_add(m, models_conf);
    g_ptr_array_add(m, (gpointer)"--conf");
    g_ptr_array_add(m, (gpointer)"plugins/ai/enabled=true");
  }
#endif

  if(dt_init(m->len, (char **)m->pdata, FALSE, TRUE, NULL))
  {
    fprintf(stderr, "darktable-engine: dt_init failed\n");
    g_ptr_array_free(m, TRUE);
    return 1;
  }
#ifndef _WIN32
  const int fatal[] = { SIGSEGV, SIGBUS, SIGABRT, SIGFPE, SIGILL };
  for(size_t k = 0; k < G_N_ELEMENTS(fatal); k++) signal(fatal[k], _crash);
#endif

  // edits persist only through the sidecar, which the engine writes itself
  // (library_write_sidecar)
  dt_conf_set_string("write_sidecar_files", "never");
#ifdef HAVE_AI
#ifdef __linux__
  // darktable's "auto" tries CUDA, MIGraphX and OpenVINO in turn for each
  // model (backend_common.c, _auto_candidates), with the same check as
  // device_ort_exports describes
  if(!device_ort_exports(DT_AI_PROVIDER_CUDA) && !device_ort_exports(DT_AI_PROVIDER_MIGRAPHX)
     && !device_ort_exports(DT_AI_PROVIDER_OPENVINO))
    dt_conf_set_string(DT_AI_CONF_PROVIDER, "CPU");
#endif
#endif
  // the library is in memory, so image ids are reused across runs; a
  // thumbnail cache on disk, keyed by id, would show another run's images
  dt_conf_set_bool("cache_disk_backend", FALSE);
  dt_conf_set_bool("cache_disk_backend_full", FALSE);
  // Lightroom imports unrated; darktable's default gives every image a star
  dt_conf_set_int("ui_last/import_initial_rating", 0);
  // imports run with sidecar writing muted, and darktable then imports a
  // sidecar's text metadata only for fields flagged to be imported
  // (metadata.c, dt_metadata_set_import()), so flag the ones edited here
  for(size_t k = 0; k < G_N_ELEMENTS(library_meta_keys); k++)
  {
    gchar *setting = g_strdup_printf("plugins/lighttable/metadata/%s_flag",
                                     dt_metadata_get_tag_subkey(library_meta_keys[k][1]));
    dt_conf_set_int(setting, dt_conf_get_int(setting) | DT_METADATA_FLAG_IMPORTED);
    g_free(setting);
  }

  library_thumb_pool = g_thread_pool_new(library_thumb_run, out, _THUMB_THREADS, FALSE, NULL);
  export_pool = g_thread_pool_new(export_run, out, 1, TRUE, NULL);
  library_import_pool = g_thread_pool_new(library_import_run, out, 1, FALSE, NULL);
#ifdef HAVE_AI
  ai_denoise_pool = g_thread_pool_new(ai_denoise_run, out, 1, TRUE, NULL);
  ai_pool = g_thread_pool_new(ai_run, out, 1, FALSE, NULL);
  g_thread_unref(g_thread_new("ai idle", ai_idle_watch, NULL));
#endif
  GAsyncQueue *requests = g_async_queue_new();
  _requests = requests;
  g_thread_unref(g_thread_new("requests", _read_requests, requests));
  _pressure_watch();
  gboolean quit = FALSE, trimmed = TRUE;
  gint64 last_request = g_get_monotonic_time(), last_trim = 0;
  char *line;
  while(!quit)
  {
    line = g_async_queue_timeout_pop(requests, _PRESSURE_POLL_US);
    const gint64 now = g_get_monotonic_time();
    const gboolean due = now - last_trim >= _PRESSURE_TRIM_US;
    if(!line)
    {
      const gboolean pressure = due && engine_memory_pressure();
      if((!trimmed && now - last_request >= _IDLE_TRIM_US) || pressure)
      {
        _trim(pressure);
        trimmed = TRUE;
        last_trim = now;
      }
      continue;
    }
    if(line == _end_of_input) break;
    if(due && engine_memory_pressure())
    {
      _trim(TRUE);
      last_trim = now;
    }
    trimmed = FALSE;
    // each request's start, which a crash's backtrace then follows; shapes
    // can run to megabytes
    fprintf(stderr, "[engine] > %.*s\n", (int)MIN(300, strcspn(line, "\r\n")), line);
    JsonParser *parser = json_parser_new();
    if(json_parser_load_from_data(parser, line, -1, NULL)
       && JSON_NODE_HOLDS_OBJECT(json_parser_get_root(parser)))
    {
      JsonObject *req = json_node_get_object(json_parser_get_root(parser));
      quit = !g_strcmp0(json_object_get_string_member_with_default(req, "cmd", ""), "quit");
      const gboolean cache_trace = json_object_get_boolean_member_with_default(req, "cache_trace", FALSE);
      dt_dev_pixelpipe_cache_trace_set(cache_trace);
      if(cache_trace)
        fprintf(stderr, "[engine-cache] begin %" G_GINT64_FORMAT " %s\n",
                json_object_get_int_member_with_default(req, "diagnostic_request", 0),
                json_object_get_string_member_with_default(req, "cmd", ""));
      _foreground(TRUE);
      if(json_object_has_member(req, "rid")
         && json_node_get_value_type(json_object_get_member(req, "rid")) == G_TYPE_INT64)
        _request_rid = json_object_get_int_member(req, "rid");
      _handle(req, out);
      _request_rid = -1;
      _foreground(FALSE);
      if(cache_trace) fprintf(stderr, "[engine-cache] end\n");
      dt_dev_pixelpipe_cache_trace_set(FALSE);
    }
    else
      _reply_error(out, "request is not a JSON object");
    g_object_unref(parser);
    g_free(line);
    // idle counts from a request's end: a long export is not idle time
    last_request = g_get_monotonic_time();
  }
  // the client gone without a quit: its edits are kept all the same
  if(!quit) session_save_pending();

  library_thumb_wait();
  library_import_wait();
  export_wait();
#ifdef HAVE_AI
  ai_denoise_wait();
  ai_wait();
#endif
  session_close_session();
  library_prefetch_wait();
  if(session_paste_batches) g_hash_table_destroy(session_paste_batches);
  dt_cleanup();
  g_ptr_array_free(m, TRUE);
  return 0;
}

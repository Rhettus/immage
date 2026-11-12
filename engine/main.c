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
  g_mutex_lock(&_fg_lock);
  _fg_busy = busy;
  _fg_last = g_get_monotonic_time();
  g_mutex_unlock(&_fg_lock);
}

void engine_background_yield(void)
{
  const gint64 start = g_get_monotonic_time();
  while(TRUE)
  {
    const gint64 now = g_get_monotonic_time();
    g_mutex_lock(&_fg_lock);
    const gboolean quiet = !_fg_busy && now - _fg_last >= _FG_GRACE_US;
    g_mutex_unlock(&_fg_lock);
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
  g_mutex_lock(&_reply_lock);
  fprintf(out, "%s\n", s);
  fflush(out);
  g_mutex_unlock(&_reply_lock);
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


// the edit changed: the main pipe follows now, the others before their next
// frame. synch_top takes only the latest history item, so a second change
// in between makes that a whole synch
static void _follow(dt_engine_follower_t *f, const dt_dev_pixelpipe_change_t flags)
{
  f->pending = f->pending ? f->pending | flags | DT_DEV_PIPE_SYNCH : flags;
}

void session_changed(const dt_dev_pixelpipe_change_t flags)
{
  _s.pipe.changed |= flags;
  dt_dev_pixelpipe_change(&_s.pipe, &_s.dev);
  _follow(&_s.drag, flags);
  _follow(&_s.base, flags);
  _follow(&_s.check, flags);
}

// FALSE when base `id` was canceled before it could start. a stop request
// made before the run is kept by dt_dev_pixelpipe_process
// (pixelpipe_hb.c), so only one left from an earlier run is cleared here
static gboolean _base_start(const gint64 id)
{
  g_mutex_lock(&engine_cancel_lock);
  dt_atomic_set_int(&_s.base.pipe.shutdown, DT_DEV_PIXELPIPE_STOP_NO);
  const gboolean go = id > _base_canceled;
  _base_running = go ? id : 0;
  g_mutex_unlock(&engine_cancel_lock);
  return go;
}

// whether the base just rendered was canceled meanwhile
static gboolean _base_end(void)
{
  g_mutex_lock(&engine_cancel_lock);
  const gboolean canceled = _base_running && _base_running <= _base_canceled;
  _base_running = 0;
  dt_atomic_set_int(&_s.base.pipe.shutdown, DT_DEV_PIXELPIPE_STOP_NO);
  g_mutex_unlock(&engine_cancel_lock);
  return canceled;
}

// every base up to `id`: the one rendering stops at its next module, as the
// darkroom's pipes do for a new edit. a module late in the pipe finishes
// all the same (pixelpipe_hb.c, _module_pipe_stop)
static void _cancel_base(const gint64 id)
{
  g_mutex_lock(&engine_cancel_lock);
  _base_canceled = MAX(_base_canceled, id);
  if(_base_running && _base_running <= id)
    dt_atomic_set_int(&_s.base.pipe.shutdown, DT_DEV_PIXELPIPE_STOP_NODES);
  g_mutex_unlock(&engine_cancel_lock);
}

void session_follower_cleanup(dt_engine_follower_t *f)
{
  if(f->ok) dt_dev_pixelpipe_cleanup(&f->pipe);
  f->ok = FALSE;
  f->pending = DT_DEV_PIPE_UNCHANGED;
}

void session_close_session(void)
{
  if(!_s.open) return;
#ifdef HAVE_AI
  ai_denoise_forget();
#endif
  if(_s.ppipe_ok) dt_dev_pixelpipe_cleanup(&_s.ppipe);
  _s.ppipe_ok = FALSE;
  session_follower_cleanup(&_s.drag);
  session_follower_cleanup(&_s.base);
  session_follower_cleanup(&_s.check);
  dt_dev_pixelpipe_cleanup(&_s.pipe);
  dt_mipmap_cache_release(&_s.buf);
  dt_dev_cleanup(&_s.dev);
  _s.open = FALSE;
  _s.unsaved = FALSE;
  _s.before = FALSE;
  _s.fresh = FALSE;
  _s.baseline = FALSE;
}

// the photos each background export is to render, by job: imgid to its
// snapshot, or to NO_IMGID until one is needed. a photo's edit changes only
// while it is open, so the open photo is copied when the export is asked
// for (`export_hold`) and the others as they are opened (_hold_open), or
// when the export reaches them (session_hold_take). either way the export renders
// the edit as it was when it was asked for
GMutex session_hold_lock;
GHashTable *session_holds = NULL;

static void _hold_free(gpointer data)
{
  GHashTableIter it;
  gpointer key, value;
  g_hash_table_iter_init(&it, data);
  while(g_hash_table_iter_next(&it, &key, &value)) library_snapshot_remove(GPOINTER_TO_INT(value));
  g_hash_table_destroy(data);
}

// `open_imgid` is the photo open in the editor, its edit already in the
// library, or NO_IMGID
static void _hold(const gint64 job, JsonArray *imgids, const dt_imgid_t open_imgid)
{
  g_mutex_lock(&session_hold_lock);
  if(!session_holds) session_holds = g_hash_table_new_full(g_int64_hash, g_int64_equal, g_free, _hold_free);
  gint64 *key = g_new(gint64, 1);
  *key = job;
  GHashTable *held = g_hash_table_new(NULL, NULL);
  for(guint k = 0; imgids && k < json_array_get_length(imgids); k++)
  {
    const dt_imgid_t imgid = json_array_get_int_element(imgids, k);
    if(!dt_is_valid_imgid(imgid) || g_hash_table_contains(held, GINT_TO_POINTER(imgid))) continue;
    g_hash_table_insert(held, GINT_TO_POINTER(imgid),
                        GINT_TO_POINTER(imgid == open_imgid ? library_snapshot(imgid) : NO_IMGID));
  }
  g_hash_table_replace(session_holds, key, held);
  g_mutex_unlock(&session_hold_lock);
}

// a photo about to be opened: every export still to render it gets its
// edit before the editor can change it
static void _hold_open(const dt_imgid_t imgid)
{
  g_mutex_lock(&session_hold_lock);
  GHashTableIter it;
  gpointer key, held;
  if(session_holds) g_hash_table_iter_init(&it, session_holds);
  while(session_holds && g_hash_table_iter_next(&it, &key, &held))
  {
    gpointer snap;
    if(g_hash_table_lookup_extended(held, GINT_TO_POINTER(imgid), NULL, &snap)
       && !dt_is_valid_imgid(GPOINTER_TO_INT(snap)))
      g_hash_table_insert(held, GINT_TO_POINTER(imgid), GINT_TO_POINTER(library_snapshot(imgid)));
  }
  g_mutex_unlock(&session_hold_lock);
}

// the snapshot job's export of `imgid` renders, now the caller's to remove;
// NO_IMGID when the job does not hold the photo
dt_imgid_t session_hold_take(const gint64 job, const dt_imgid_t imgid)
{
  g_mutex_lock(&session_hold_lock);
  GHashTable *held = session_holds ? g_hash_table_lookup(session_holds, &job) : NULL;
  gpointer snap = NULL;
  dt_imgid_t taken = NO_IMGID;
  if(held && g_hash_table_lookup_extended(held, GINT_TO_POINTER(imgid), NULL, &snap))
  {
    // under the lock, so the photo can't be opened while it is copied
    taken = dt_is_valid_imgid(GPOINTER_TO_INT(snap)) ? GPOINTER_TO_INT(snap) : library_snapshot(imgid);
    g_hash_table_remove(held, GINT_TO_POINTER(imgid));
  }
  g_mutex_unlock(&session_hold_lock);
  return taken;
}

// the job's photos it will not export after all, with their snapshots
void session_hold_release(const gint64 job)
{
  g_mutex_lock(&session_hold_lock);
  if(session_holds) g_hash_table_remove(session_holds, &job);
  g_mutex_unlock(&session_hold_lock);
}

// whether the history holds entries a later one of the same module
// supersedes, or masks from more than one point in it. every save used to
// add to it, and a sidecar's masks are stored again for each entry that
// changes them, so an edited photo's sidecar grew to megabytes that
// darktable reads back in quadratic time (exif.cc, _read_masks_v3())
static gboolean _history_bloated(const dt_imgid_t imgid)
{
  sqlite3_stmt *stmt;
  gboolean bloated = FALSE;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT (SELECT COUNT(*) FROM main.history"
                              "         WHERE imgid = ?1 AND operation != 'mask_manager')"
                              "       > (SELECT COUNT(*) FROM (SELECT DISTINCT operation, multi_priority"
                              "                                FROM main.history"
                              "                                WHERE imgid = ?1 AND operation != 'mask_manager'))"
                              "    OR (SELECT COUNT(DISTINCT num) FROM main.masks_history WHERE imgid = ?1) > 1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  if(sqlite3_step(stmt) == SQLITE_ROW) bloated = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);
  return bloated;
}

static const char *_mask_name(const char *full);
static dt_masks_form_t *_instance_group(const dt_iop_module_t *m);

// whether instance `multi_name` of `op` is switched off yet holds a mask's
// settings: a hidden mask's instances, or those of a mask sharing them
// (_combine()). they are still attached to the mask, which a deleted
// mask's instances no longer are (_mask_delete())
static gboolean _holds_mask_settings(const char *op, const char *multi_name)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(m->enabled || g_strcmp0(m->op, op) || g_strcmp0(m->multi_name, multi_name)) continue;
    const dt_masks_form_t *grp = _instance_group(m);
    if(grp && _mask_name(grp->name)) return TRUE;
  }
  return FALSE;
}

// whether `op` is one the photo's conversion switches off, keeping its
// settings for when the photo is turned back (manifest.ts, NEG_OFF, SF_OFF
// and their _UNMAPPED sets): a converted negative's, while negadoctor is
// on, or a film simulation's tone mappers, while spektrafilm is. their
// entries stay
static gboolean _held_for_mode(const char *op)
{
  static const char *negative[] = { "channelmixerrgb", "exposure", "toneequal", "hazeremoval", "agx", "sigmoid",
                                    "filmicrgb", "basecurve", NULL };
  static const char *film[] = { "agx", "sigmoid", "filmicrgb", "basecurve", NULL };
  static const struct { const char *mode; const char **held; } modes[] = {
    { "negadoctor", negative }, { "spektrafilm", film },
  };
  for(size_t k = 0; k < G_N_ELEMENTS(modes); k++)
  {
    const dt_iop_module_t *m = dt_iop_get_module_by_op_priority(_s.dev.iop, modes[k].mode, 0);
    if(!m || !m->enabled) continue;
    for(int i = 0; modes[k].held[i]; i++)
      if(!g_strcmp0(op, modes[k].held[i])) return TRUE;
  }
  return FALSE;
}

// drops the entries of modules switched off that darktable does not start
// switched on: they do nothing, and a deleted mask leaves its instances so.
// the shapes of masks all deleted go too. a mask's own instances that hold
// its settings stay (_holds_mask_settings()), or a hidden or sharing mask
// would come back without them, as do those a negative or a film simulation
// holds (_held_for_mode()).
// one darktable starts on keeps its entry, or replaying the history would
// switch it back on. needs the image open, for each module's default.
// returns whether anything went
static gboolean _prune_off(const dt_imgid_t imgid)
{
  if(!_s.open || _s.imgid != imgid) return FALSE;
  int pruned = 0;
  GHashTable *done = g_hash_table_new(g_str_hash, g_str_equal);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(m->default_enabled || g_hash_table_contains(done, m->op) || _held_for_mode(m->op)) continue;
    g_hash_table_add(done, (gpointer)m->op);
    GArray *drop = g_array_new(FALSE, FALSE, sizeof(int));
    sqlite3_stmt *stmt;
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "SELECT num, multi_name FROM main.history"
                                " WHERE imgid = ?1 AND operation = ?2 AND enabled = 0",
                                -1, &stmt, NULL);
    DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
    DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 2, m->op, -1, SQLITE_TRANSIENT);
    while(sqlite3_step(stmt) == SQLITE_ROW)
    {
      const int num = sqlite3_column_int(stmt, 0);
      if(!_holds_mask_settings(m->op, (const char *)sqlite3_column_text(stmt, 1))) g_array_append_val(drop, num);
    }
    sqlite3_finalize(stmt);
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "DELETE FROM main.history WHERE imgid = ?1 AND num = ?2", -1, &stmt, NULL);
    for(guint k = 0; k < drop->len; k++)
    {
      DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
      DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, g_array_index(drop, int, k));
      sqlite3_step(stmt);
      pruned += sqlite3_changes(dt_database_get(darktable.db));
      sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    g_array_free(drop, TRUE);
  }
  g_hash_table_destroy(done);
  // with the last mask deleted, the entry deleting it carries no shapes,
  // and compress would keep the last one that did
  if(!_s.dev.forms)
  {
    sqlite3_stmt *stmt;
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "DELETE FROM main.masks_history WHERE imgid = ?1", -1, &stmt, NULL);
    DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    pruned += sqlite3_changes(dt_database_get(darktable.db));
  }
  return pruned > 0;
}

// the history down to one entry per module instance, as darktable's
// "compress history stack", less the modules switched off; the client
// keeps its own undo. dt_history_compress() writes the sidecar itself
static void _compress_history(const dt_imgid_t imgid)
{
  if(_history_bloated(imgid)) dt_history_compress(imgid);
  // after the compress, so only an instance's last entry decides; the
  // second compress closes the gaps in the numbering
  if(_prune_off(imgid)) dt_history_compress(imgid);
}

// an entry of the `history` reply: the module, its instance label, on or off.
// `mod` is the instance the entry is for, NULL if the develop has none: what
// the History panel may switch off or delete (`module_state`)
static void _history_item(JsonBuilder *b, const char *op, const char *name, const char *multi_name,
                          const gboolean hand_edited, const gboolean enabled,
                          const int priority, const dt_iop_module_t *mod)
{
  const gboolean labeled = multi_name && multi_name[0] && g_strcmp0(multi_name, "0");
  gchar *label = !labeled ? NULL
    : hand_edited ? g_strdup(multi_name)
    : dt_util_localize_segmented_name(multi_name, FALSE);
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "op");
  json_builder_add_string_value(b, op);
  json_builder_set_member_name(b, "name");
  json_builder_add_string_value(b, name ? name : op);
  json_builder_set_member_name(b, "label");
  if(label) json_builder_add_string_value(b, label); else json_builder_add_null_value(b);
  json_builder_set_member_name(b, "enabled");
  json_builder_add_boolean_value(b, enabled);
  json_builder_set_member_name(b, "priority");
  json_builder_add_int_value(b, priority);
  json_builder_set_member_name(b, "default_enabled");
  json_builder_add_boolean_value(b, mod && mod->default_enabled);
  // no switch in darktable either: the pipe needs it, or it has none
  json_builder_set_member_name(b, "fixed");
  json_builder_add_boolean_value(b, !mod || mod->hide_enable_button);
  json_builder_set_member_name(b, "masked");
  json_builder_add_boolean_value(b, mod && mod->blend_params && mod->blend_params->mask_id > 0);
  json_builder_end_object(b);
  g_free(label);
}

// the open image's history in the library, up to its history_end
static void _saved_history(JsonBuilder *b)
{
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT h.operation, h.multi_name, h.multi_name_hand_edited, h.enabled,"
                              "       h.multi_priority"
                              " FROM main.history AS h, main.images AS i"
                              " WHERE h.imgid = ?1 AND i.id = h.imgid AND h.num < i.history_end"
                              " ORDER BY h.num",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, _s.imgid);
  while(sqlite3_step(stmt) == SQLITE_ROW)
  {
    const char *op = (const char *)sqlite3_column_text(stmt, 0);
    if(!op) continue;
    const int priority = sqlite3_column_int(stmt, 4);
    _history_item(b, op, dt_iop_get_localized_name(op), (const char *)sqlite3_column_text(stmt, 1),
                  sqlite3_column_int(stmt, 2), sqlite3_column_int(stmt, 3), priority,
                  dt_iop_get_module_by_op_priority(_s.dev.iop, op, priority));
  }
  sqlite3_finalize(stmt);
}

static gboolean _has_history(const dt_imgid_t imgid)
{
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT 1 FROM main.history WHERE imgid = ?1 LIMIT 1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  const gboolean found = sqlite3_step(stmt) == SQLITE_ROW;
  sqlite3_finalize(stmt);
  return found;
}

// `version` picks one of the file's versions by imgid, and any other value
// its lowest
static gboolean _open_image(const char *path, const dt_imgid_t version, const char *pipe_kind,
                            char **err)
{
  session_close_session();

  dt_imgid_t imgid = library_import(path);
  if(!dt_is_valid_imgid(imgid))
  {
    *err = g_strdup_printf("could not import '%s'", path);
    return FALSE;
  }
  GList *ids = library_image_versions(imgid);
  if(ids) imgid = GPOINTER_TO_INT(ids->data);
  if(g_list_find(ids, GINT_TO_POINTER(version))) imgid = version;
  g_list_free(ids);
  _hold_open(imgid);

  // a sidecar saved before history was compressed is compressed now, once,
  // so this session starts from the short history and saves stay small
  _compress_history(imgid);

  // before loading, which writes darktable's automatic presets to history
  const gboolean fresh = !_has_history(imgid);

  dt_dev_init(&_s.dev, FALSE);
  dt_dev_load_image(&_s.dev, imgid);
  // load_image reads the history but does not replay it into module params
  dt_dev_pop_history_items_ext(&_s.dev, _s.dev.history_end);

  dt_mipmap_cache_get(&_s.buf, imgid, DT_MIPMAP_FULL, DT_MIPMAP_BLOCKING, 'r');
  if(!_s.buf.buf || !_s.buf.width || !_s.buf.height)
  {
    dt_mipmap_cache_release(&_s.buf);
    dt_dev_cleanup(&_s.dev);
    *err = g_strdup_printf("could not load pixels of '%s'", path);
    return FALSE;
  }

  const int wd = _s.dev.image_storage.width;
  const int ht = _s.dev.image_storage.height;
  const gboolean ok = g_strcmp0(pipe_kind, "export") == 0
    ? dt_dev_pixelpipe_init_export(&_s.pipe, wd, ht, IMAGEIO_RGB | IMAGEIO_INT8, FALSE)
    : g_strcmp0(pipe_kind, "full") == 0
    ? dt_dev_pixelpipe_init(&_s.pipe)
    : dt_dev_pixelpipe_init_preview(&_s.pipe);
  if(!ok)
  {
    dt_mipmap_cache_release(&_s.buf);
    dt_dev_cleanup(&_s.dev);
    *err = g_strdup("could not allocate the pixelpipe");
    return FALSE;
  }

  dt_ioppr_resync_modules_order(&_s.dev);
  dt_dev_pixelpipe_set_icc(&_s.pipe, DT_COLORSPACE_SRGB, NULL, DT_INTENT_LAST);
  dt_dev_pixelpipe_set_input(&_s.pipe, &_s.dev, (float *)_s.buf.buf,
                             _s.buf.width, _s.buf.height, _s.buf.iscale);
  dt_dev_pixelpipe_create_nodes(&_s.pipe, &_s.dev);
  dt_dev_pixelpipe_synch_all(&_s.pipe, &_s.dev);
  // colorin's commit marks an image with an sRGB or Adobe RGB input profile
  // as USER_RGB, in the image cache only (iop_profile.c,
  // dt_ioppr_set_pipe_input_profile_info). darktable's import thumbnails do
  // that before the darkroom loads a photo; the engine's import does not, so
  // a photo's first session would scale its input without gamma correction
  // (pixelpipe_hb.c, clip&zoom) and render unlike every later session
  const dt_image_t *cimg = dt_image_cache_get(imgid, 'r');
  if(cimg)
  {
    _s.dev.image_storage.colorspace = cimg->colorspace;
    dt_image_cache_read_release(cimg);
  }
  dt_dev_pixelpipe_get_dimensions(&_s.pipe, &_s.dev, _s.pipe.iwidth, _s.pipe.iheight,
                                  &_s.pipe.processed_width, &_s.pipe.processed_height);
  _s.imgid = imgid;
  _s.open = TRUE;
  _s.fresh = _s.baseline = fresh;
  return TRUE;
}

dt_iop_module_t *session_module(const char *op, char **err)
{
  dt_iop_module_t *mod = op ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, 0) : NULL;
  if(!mod) *err = g_strdup_printf("module '%s' not in the pipe", op ? op : "(none)");
  return mod;
}

// resolve a path such as "exposure", "tonecurve_nodes[0]" or
// "tonecurve[0][3].x" inside `base` (params or default_params). get_f()
// describes an array element only as its first one, so indices and members
// are walked with the introspection helpers instead (introspection.md)
void *session_field_in(dt_iop_module_t *mod, void *base, const char *path,
                       dt_introspection_field_t **f, char **err)
{
  *f = NULL;
  void *p = NULL;
  gchar **parts = g_strsplit(path, ".", -1);
  for(int i = 0; parts[i]; i++)
  {
    gchar *bracket = strchr(parts[i], '[');
    gchar *name = g_strndup(parts[i], bracket ? bracket - parts[i] : strlen(parts[i]));
    if(i == 0)
    {
      *f = mod->so->have_introspection ? mod->get_f(name) : NULL;
      p = *f ? (uint8_t *)base + (*f)->header.offset : NULL;
    }
    else
      p = dt_introspection_get_child(*f, p, name, f);
    g_free(name);

    for(gchar *b = bracket; p && b && *b == '['; b = strchr(b + 1, '['))
    {
      char *end = NULL;
      const unsigned long k = strtoul(b + 1, &end, 10);
      if(!end || *end != ']') { p = NULL; break; }
      p = dt_introspection_access_array(*f, p, k, f);
    }
    if(!p) break;
  }
  g_strfreev(parts);

  if(!p) *err = g_strdup_printf("'%s' has no field '%s'", mod->op, path);
  return p;
}

static gboolean _write_field_in(dt_iop_module_t *mod, void *base, const char *name,
                                const double num, char **err)
{
  dt_introspection_field_t *f = NULL;
  void *p = session_field_in(mod, base, name, &f, err);
  if(!p) return FALSE;
  switch(f->header.type)
  {
    case DT_INTROSPECTION_TYPE_FLOAT:  *(float *)p = (float)num; break;
    case DT_INTROSPECTION_TYPE_DOUBLE: *(double *)p = num; break;
    case DT_INTROSPECTION_TYPE_INT:
    case DT_INTROSPECTION_TYPE_ENUM:   *(int *)p = (int)num; break;
    case DT_INTROSPECTION_TYPE_UINT:   *(unsigned int *)p = (unsigned int)num; break;
    case DT_INTROSPECTION_TYPE_BOOL:   *(gboolean *)p = num != 0.0; break;
    default:
      *err = g_strdup_printf("'%s.%s' is not a settable scalar", mod->op, name);
      return FALSE;
  }
  return TRUE;
}

// "blend.details", besides the params: darktable's details threshold, which
// keeps the module to the raw's detailed areas (> 0) or its flat ones (< 0).
// it acts only through a mask, so a module without one gets a whole-image
// drawn mask with no shapes (blend.c fills it with 1) while it is non-zero
#define BLEND_DETAILS "blend.details"
#define WHOLE_IMAGE_MASK (DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI)

static gboolean _write_details(dt_iop_module_t *mod, const double num, char **err)
{
  dt_develop_blend_params_t *bp = mod->blend_params;
  if(!bp || !(mod->flags() & IOP_FLAGS_SUPPORTS_BLENDING))
  {
    *err = g_strdup_printf("'%s' does not blend", mod->op);
    return FALSE;
  }
  bp->details = CLAMP(num, -1.0, 1.0);
  const gboolean on = !feqf(bp->details, 0.0f, 1e-6f);
  if(on && bp->mask_mode <= DEVELOP_MASK_ENABLED)
  {
    bp->mask_mode = WHOLE_IMAGE_MASK;
    bp->mask_id = 0;
    bp->mask_combine = 0;
  }
  else if(!on && bp->mask_mode == WHOLE_IMAGE_MASK && bp->mask_id == 0)
    bp->mask_mode = DEVELOP_MASK_DISABLED;
  return TRUE;
}

// "lens_pick" of the lens module, besides its params: 0 for the lens
// darktable matched from the EXIF (the default params'), else lenses_hash()
// of the Lensfun lens chosen in its place. the params keep the lens's name
// and its geometry, as the module's own lens menu sets them, and the method
// is Lensfun's: a raw that carries its own correction defaults to the
// embedded one, which has no use for a lens of the database
#define LENS_PICK "lens_pick"
#define LENS_METHOD_LENSFUN 1

static gboolean _write_lens_pick(dt_iop_module_t *mod, const double num, char **err)
{
  dt_introspection_field_t *f = NULL;
  char *lens = session_field_in(mod, mod->params, "lens", &f, err);
  const char *auto_lens = lens ? session_field_in(mod, mod->default_params, "lens", &f, err) : NULL;
  int *geom = session_field_in(mod, mod->params, "target_geom", &f, err);
  const int *auto_geom = geom ? session_field_in(mod, mod->default_params, "target_geom", &f, err) : NULL;
  int *method = session_field_in(mod, mod->params, "method", &f, err);
  const int *auto_method = method ? session_field_in(mod, mod->default_params, "method", &f, err) : NULL;
  if(!lens || !auto_lens || !geom || !auto_geom || !method || !auto_method) return FALSE;
  if(num <= 0.0)
  {
    g_strlcpy(lens, auto_lens, 128);
    *geom = *auto_geom;
    *method = *auto_method;
    return TRUE;
  }
  char model[128];
  int type = 0;
  if(!lenses_find((unsigned)num, model, sizeof model, &type))
  {
    *err = g_strdup("no such lens in the Lensfun database");
    return FALSE;
  }
  g_strlcpy(lens, model, 128);
  *geom = type ? type : *auto_geom;
  *method = LENS_METHOD_LENSFUN;
  return TRUE;
}

// Scalar choices for colorin's (type, filename) pairs. Zero restores this
// image's defaults; built-ins use type + 1, ICC files a stable filename hash.
// Keep the filename in native params/XMP, never the menu index.
static guint64 _profile_id(const int type, const char *filename)
{
  // Match darktable's basename-based ICC lookup, including sidecars copied
  // between operating systems with different path separators.
  const char *base = filename;
  for(const char *c = filename; *c; c++) if(*c == '/' || *c == '\\') base = c + 1;
  return type == DT_COLORSPACE_FILE ? 256ULL + g_str_hash(base) : (guint64)type + 1;
}

static gboolean _profile_fields(dt_iop_module_t *mod, void *params, const gboolean work,
                                 int **type, char **filename, char **err)
{
  dt_introspection_field_t *f = NULL;
  *type = session_field_in(mod, params, work ? "type_work" : "type", &f, err);
  *filename = *type ? session_field_in(mod, params, work ? "filename_work" : "filename", &f, err) : NULL;
  return *type && *filename;
}

static gboolean _read_profile(dt_iop_module_t *mod, const gboolean defaults, const gboolean work,
                              double *num, char **err)
{
  int *type; char *filename;
  if(!_profile_fields(mod, defaults ? mod->default_params : mod->params, work, &type, &filename, err))
    return FALSE;
  *num = _profile_id(*type, filename);
  return TRUE;
}

static gboolean _write_profile(dt_iop_module_t *mod, const gboolean work, const double num, char **err)
{
  int *type; char *filename;
  if(!_profile_fields(mod, mod->params, work, &type, &filename, err)) return FALSE;
  if(num == 0)
  {
    int *def_type; char *def_filename;
    if(!_profile_fields(mod, mod->default_params, work, &def_type, &def_filename, err)) return FALSE;
    *type = *def_type;
    g_strlcpy(filename, def_filename, DT_IOP_COLOR_ICC_LEN);
    return TRUE;
  }
  // Unavailable profiles kept in a sidecar must survive edits to the other
  // choice. Choosing a different unavailable file is an error.
  if(num == _profile_id(*type, filename)) return TRUE;
  const dt_colorspaces_color_profile_t *chosen = NULL;
  for(const GList *l = darktable.color_profiles->profiles; l; l = l->next)
  {
    const dt_colorspaces_color_profile_t *p = l->data;
    if((work ? p->work_pos : p->in_pos) < 0 || num != _profile_id(p->type, p->filename)) continue;
    if(chosen && (p->type != chosen->type || strcmp(p->filename, chosen->filename)))
    {
      *err = g_strdup("ambiguous color profile identifier");
      return FALSE;
    }
    chosen = p;
  }
  // Camera profiles are image-specific, outside the global profile list.
  if(!chosen && !work && (num == DT_COLORSPACE_STANDARD_MATRIX + 1
                         || num == DT_COLORSPACE_ENHANCED_MATRIX + 1))
  {
    *type = (int)num - 1;
    filename[0] = '\0';
    return TRUE;
  }
  if(!chosen)
  {
    *err = g_strdup("color profile unavailable or unsuitable for this role");
    return FALSE;
  }
  *type = chosen->type;
  g_strlcpy(filename, chosen->filename, DT_IOP_COLOR_ICC_LEN);
  return TRUE;
}

gboolean session_write_field(dt_iop_module_t *mod, const char *name, const double num,
                             char **err)
{
  if(!g_strcmp0(mod->op, "colorin")
     && (!g_strcmp0(name, "input_profile") || !g_strcmp0(name, "working_profile")))
    return _write_profile(mod, !strcmp(name, "working_profile"), num, err);
  if(!g_strcmp0(name, BLEND_DETAILS)) return _write_details(mod, num, err);
  if(!g_strcmp0(name, LENS_PICK) && !g_strcmp0(mod->op, "lens")) return _write_lens_pick(mod, num, err);
  return _write_field_in(mod, mod->params, name, num, err);
}

// read from the live params, or from the defaults the image was given
static gboolean _read_field(dt_iop_module_t *mod, const char *name,
                            const gboolean from_defaults, double *num, char **err)
{
  if(!g_strcmp0(mod->op, "colorin")
     && (!g_strcmp0(name, "input_profile") || !g_strcmp0(name, "working_profile")))
    return _read_profile(mod, from_defaults, !strcmp(name, "working_profile"), num, err);
  if(!g_strcmp0(name, BLEND_DETAILS))
  {
    const dt_develop_blend_params_t *bp = from_defaults ? mod->default_blendop_params : mod->blend_params;
    *num = bp ? bp->details : 0.0;
    return TRUE;
  }
  if(!g_strcmp0(name, LENS_PICK) && !g_strcmp0(mod->op, "lens"))
  {
    dt_introspection_field_t *lf = NULL;
    const char *lens = from_defaults ? NULL : session_field_in(mod, mod->params, "lens", &lf, err);
    const char *auto_lens = from_defaults ? NULL : session_field_in(mod, mod->default_params, "lens", &lf, err);
    *num = lens && auto_lens && g_strcmp0(lens, auto_lens) ? lenses_hash(lens) : 0.0;
    return TRUE;
  }
  dt_introspection_field_t *f = NULL;
  const void *p = session_field_in(mod, from_defaults ? mod->default_params : mod->params,
                            name, &f, err);
  if(!p) return FALSE;
  switch(f->header.type)
  {
    case DT_INTROSPECTION_TYPE_FLOAT:  *num = *(const float *)p; break;
    case DT_INTROSPECTION_TYPE_DOUBLE: *num = *(const double *)p; break;
    case DT_INTROSPECTION_TYPE_INT:
    case DT_INTROSPECTION_TYPE_ENUM:   *num = *(const int *)p; break;
    case DT_INTROSPECTION_TYPE_UINT:   *num = *(const unsigned int *)p; break;
    case DT_INTROSPECTION_TYPE_BOOL:   *num = *(const gboolean *)p ? 1.0 : 0.0; break;
    default:
      *err = g_strdup_printf("'%s.%s' is not a readable scalar", mod->op, name);
      return FALSE;
  }
  return TRUE;
}

// apply `params` ({ field: number }) and/or a single field/value to one
// module as one history item
// with `after`, the module is first moved behind that one if it runs
// earlier, as a client may want a curve to act after the tone mapper. the
// order becomes the image's own, kept in the library and the sidecar
static dt_iop_module_t *_named_instance(const char *op, const char *name, const gboolean anchored,
                                        char **err);
static dt_iop_module_t *_find_named(const char *op, const char *name);
static dt_dev_pixelpipe_iop_t *_piece(dt_dev_pixelpipe_t *pipe, const dt_iop_module_t *m);
static void _apply_ranges(dt_iop_module_t *m, dt_masks_form_t *root, const gboolean invert);
static void _ranges_json(JsonBuilder *b, const dt_develop_blend_params_t *bp);
static gboolean _attach_mask(dt_iop_module_t *m, const char *name, const gboolean invert, char **err);
static void _preview_commit(dt_iop_module_t *m, void *params, dt_develop_blend_params_t *blend,
                            const gboolean enabled);

// a mask's refinements in an instance's blend parameters, from `refine`'s
// feather (px, 0-250), blur (px, 0-100), detail and contrast (-1-1); a
// missing one is left
static void _refine_into(dt_develop_blend_params_t *bp, JsonObject *refine)
{
  if(!refine) return;
  if(json_object_has_member(refine, "feather"))
    bp->feathering_radius = CLAMP(json_object_get_double_member(refine, "feather"), 0.0, 250.0);
  if(json_object_has_member(refine, "blur"))
    bp->blur_radius = CLAMP(json_object_get_double_member(refine, "blur"), 0.0, 100.0);
  if(json_object_has_member(refine, "detail"))
    bp->details = CLAMP(json_object_get_double_member(refine, "detail"), -1.0, 1.0);
  if(json_object_has_member(refine, "contrast"))
    bp->contrast = CLAMP(json_object_get_double_member(refine, "contrast"), -1.0, 1.0);
}

// with `instance`, the instance of that name (made when missing) instead
// of the first; with `mask`, the mask group of that name drives it, at
// `opacity` (0-100; negative leaves it) and with `refine` (_refine_into())
// the module a placement names: "op" is its first instance, "op#name" the
// instance so named; one not made yet is no constraint
static dt_iop_module_t *_place_target(const char *name)
{
  const char *hash = strchr(name, '#');
  if(!hash) return dt_iop_get_module_by_op_priority(_s.dev.iop, name, -1);
  gchar *op = g_strndup(name, hash - name);
  dt_iop_module_t *m = _find_named(op, hash + 1);
  g_free(op);
  return m;
}

// move `mod` behind each of `after` (a comma-separated list, in order) that
// it runs ahead of, then ahead of `before` if it runs behind it, by the
// rules darktable's own module reordering obeys. a list keeps an instance
// behind modules that may each come last, such as the Zone System's
// placement behind both the color equalizer and the B&W conversion
static gboolean _place(dt_iop_module_t *mod, const char *after, const char *before, gboolean *moved,
                       char **err)
{
  gchar **prevs = after ? g_strsplit(after, ",", -1) : NULL;
  for(int k = 0; prevs && prevs[k]; k++)
  {
    dt_iop_module_t *prev = _place_target(prevs[k]);
    if(!prev || prev == mod || mod->iop_order > prev->iop_order) continue;
    if(!dt_ioppr_check_can_move_after_iop(_s.dev.iop, mod, prev)
       || !dt_ioppr_move_iop_after(&_s.dev, mod, prev))
    {
      *err = g_strdup_printf("cannot move '%s' after '%s'", mod->op, prevs[k]);
      g_strfreev(prevs);
      return FALSE;
    }
    *moved = TRUE;
  }
  g_strfreev(prevs);
  dt_iop_module_t *next = before ? _place_target(before) : NULL;
  if(next && next != mod && mod->iop_order > next->iop_order)
  {
    if(!dt_ioppr_check_can_move_before_iop(_s.dev.iop, mod, next)
       || !dt_ioppr_move_iop_before(&_s.dev, mod, next))
    {
      *err = g_strdup_printf("cannot move '%s' before '%s'", mod->op, before);
      return FALSE;
    }
    *moved = TRUE;
  }
  // the preview pipe's nodes follow the new order too
  if(*moved) _s.iop_gen++;
  return TRUE;
}

static gboolean _set(const char *op, const char *field, JsonNode *value,
                     JsonObject *params, const gboolean has_enabled,
                     const gboolean enabled, const char *after, const char *before,
                     const char *instance, const char *mask, const gboolean invert,
                     const double opacity, JsonObject *refine, char **err)
{
  const int gen = _s.iop_gen;
  // an instance placed by `after` or `before` is not also put after the
  // mask anchor, which would leave it behind modules it must precede
  dt_iop_module_t *mod = instance ? _named_instance(op, instance, !after && !before, err)
                                  : session_module(op, err);
  if(!mod) return FALSE;
  // kept to tell a request that changes nothing (_named_instance() bumps
  // iop_gen for a new instance, which always gets its history item)
  void *was = gen == _s.iop_gen && !mask ? g_malloc(mod->params_size) : NULL;
  if(was) memcpy(was, mod->params, mod->params_size);
  // and the blend params, which "blend.details" alone changes
  dt_develop_blend_params_t was_blend = { 0 };
  if(mod->blend_params) memcpy(&was_blend, mod->blend_params, sizeof(was_blend));
  const gboolean was_enabled = mod->enabled;

  gboolean moved = FALSE;
  if(!_place(mod, after, before, &moved, err)) return FALSE;

  gboolean any = FALSE;
  if(field)
  {
    const double num = value && JSON_NODE_HOLDS_VALUE(value) ? json_node_get_double(value) : 0.0;
    if(!session_write_field(mod, field, num, err)) return FALSE;
    any = TRUE;
  }
  if(params)
  {
    GList *names = json_object_get_members(params);
    for(GList *n = names; n; n = g_list_next(n))
    {
      if(!session_write_field(mod, n->data, json_object_get_double_member(params, n->data), err))
      {
        g_list_free(names);
        return FALSE;
      }
      any = TRUE;
    }
    g_list_free(names);
  }

  if(has_enabled) mod->enabled = enabled;
  else if(any) mod->enabled = TRUE;
  if(mask && !_attach_mask(mod, mask, invert, err)) return FALSE;
  if(mask && opacity >= 0.0) mod->blend_params->opacity = CLAMP(opacity, 0.0, 100.0);
  if(mask) _refine_into(mod->blend_params, refine);
  // a client may send a module it keeps off and at neutral alongside the
  // one doing the work, as the app does for a tool's unchosen module. an
  // item for it would split the other module's items, which darktable
  // merges only when they follow each other, and the preview pipe replays
  // every item on each render (session_ppipe_ready()); the tone equalizer's
  // commit is costly enough that its 160 px previews grew 14 -> 105 ms
  const gboolean same = was && !moved && mod->enabled == was_enabled
                        && !memcmp(was, mod->params, mod->params_size)
                        && (!mod->blend_params
                            || !memcmp(&was_blend, mod->blend_params, sizeof(was_blend)));
  g_free(was);
  if(same) return TRUE;
  // with a mask, the history item carries the shapes too
  if(mask) dt_dev_add_masks_history_item_ext(&_s.dev, mod, mod->enabled, TRUE);
  else dt_dev_add_history_item_ext(&_s.dev, mod, mod->enabled, TRUE);
  // the module a drag moves next, whose input a GPU pipe then copies back
  // to the pipe cache (patched pixelpipe_hb.c, important_input); without
  // it every GPU frame reran from the raw. no_image above leaves it unset
  if(mod->enabled) _s.dev.history_last_module = mod;

  // a new order means new pipe nodes; otherwise only the top item changed
  session_changed(moved ? DT_DEV_PIPE_REMOVE : DT_DEV_PIPE_TOP_CHANGED);
  return TRUE;
}

// an instance's whole state, params and blend params in base64, as
// `module_state` replies it and takes it back for undo
static void _module_state_json(JsonBuilder *b, const dt_iop_module_t *mod)
{
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "enabled");
  json_builder_add_boolean_value(b, mod->enabled);
  gchar *params = g_base64_encode(mod->params, mod->params_size);
  json_builder_set_member_name(b, "params");
  json_builder_add_string_value(b, params);
  g_free(params);
  gchar *blend = mod->blend_params
    ? g_base64_encode((const guchar *)mod->blend_params, sizeof(dt_develop_blend_params_t)) : NULL;
  json_builder_set_member_name(b, "blend");
  if(blend) json_builder_add_string_value(b, blend); else json_builder_add_null_value(b);
  g_free(blend);
  json_builder_end_object(b);
}

// a blob of _module_state_json() back into `dst`, if it is the right size
static gboolean _unbase64_into(const char *text, void *dst, const size_t size)
{
  if(!text) return FALSE;
  gsize len = 0;
  guchar *raw = g_base64_decode(text, &len);
  const gboolean fits = len == size;
  if(fits) memcpy(dst, raw, size);
  g_free(raw);
  return fits;
}

// the History panel's switch and delete for one instance of the history,
// found by op and multi_priority: `enabled` switches it, `reset` puts it
// back to its defaults, on or off as darktable starts it, and `restore`
// to a state an earlier reply gave (undo). modules without a switch and
// masked modules permit reset/restore, but not an independent switch. replies the state
// before and after
static gboolean _module_state(const char *op, const int priority, const gboolean has_enabled,
                              const gboolean enabled, const gboolean reset, JsonObject *restore,
                              JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = op ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, priority) : NULL;
  if(!mod)
  {
    *err = g_strdup_printf("module '%s' %d not in the pipe", op ? op : "(none)", priority);
    return FALSE;
  }
  if(!reset && !restore
     && (mod->hide_enable_button || (mod->blend_params && mod->blend_params->mask_id > 0)))
  {
    *err = g_strdup_printf("module '%s' cannot be switched here", op);
    return FALSE;
  }
  json_builder_set_member_name(b, "was");
  _module_state_json(b, mod);
  void *was = g_malloc(mod->params_size);
  memcpy(was, mod->params, mod->params_size);
  dt_develop_blend_params_t was_blend = { 0 };
  if(mod->blend_params) memcpy(&was_blend, mod->blend_params, sizeof(was_blend));
  const gboolean was_enabled = mod->enabled;
  if(restore)
  {
    if(!_unbase64_into(json_object_get_string_member_with_default(restore, "params", NULL),
                       mod->params, mod->params_size))
    {
      g_free(was);
      *err = g_strdup_printf("params do not fit module '%s'", op);
      return FALSE;
    }
    if(mod->blend_params)
      _unbase64_into(json_object_get_string_member_with_default(restore, "blend", NULL),
                     mod->blend_params, sizeof(dt_develop_blend_params_t));
    mod->enabled = json_object_get_boolean_member_with_default(restore, "enabled", mod->enabled);
  }
  else if(reset)
  {
    dt_iop_load_default_params(mod);
    mod->enabled = has_enabled ? enabled : mod->default_enabled;
  }
  else if(has_enabled) mod->enabled = enabled;
  const gboolean same = mod->enabled == was_enabled && !memcmp(was, mod->params, mod->params_size)
    && (!mod->blend_params || !memcmp(&was_blend, mod->blend_params, sizeof(was_blend)));
  g_free(was);
  if(!same)
  {
    dt_dev_add_history_item_ext(&_s.dev, mod, mod->enabled, TRUE);
    session_changed(DT_DEV_PIPE_TOP_CHANGED);
  }
  json_builder_set_member_name(b, "now");
  _module_state_json(b, mod);
  return TRUE;
}

// a frame's identity for the client: darktable's hash of the pipe, and
// every shape of the edit (drawn masks, spots). darktable takes a piece's
// mask shapes from darktable.develop (imageop.c, dt_iop_commit_params),
// which is not this engine's develop, so its hash alone stays the same
// when a mask is reshaped, and `have` would hand back the frame from before.
// the soft proof is in no params either (print_proof_hash)
static dt_hash_t _frame_hash(const dt_hash_t pipe_hash)
{
  dt_hash_t hash = print_proof_hash(pipe_hash);
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
    hash = dt_masks_group_hash_ext(hash, l->data, _s.dev.forms);
  return hash;
}

static gboolean _preview_output_sink(void *user, const uint8_t *pixels, int w, int h);

// darktable checks a pipe's cache against its limit only when the next run
// starts (pixelpipe_hb.c, dt_dev_pixelpipe_process), so a pipe keeps what its
// last run needed until then: a base pipe holds about 2 GB after a 16
// megapixel frame against a limit of a few hundred MB. called once the frame
// is out of the backbuf and any device is released. the newest line, which
// is the backbuf, is never evicted (pixelpipe_cache.c, _get_oldest_cacheline)
static void _settle(dt_dev_pixelpipe_t *pipe)
{
  dt_dev_pixelpipe_cache_checkmem(pipe, FALSE);
}

// Process byte pixels into the optional output sink or the pipe's backbuf.
// with scale <= 0, fit the whole image into bw x bh. otherwise render the
// bw x bh window at (x, y) of the image scaled by `scale` (1 is 100%), the
// way the darkroom's zoomed view does; the window is clipped to the image
// `have`: hashes of frames the client holds (hex). when this view's frame
// would be one of them, it is not rendered: *kept is set to that hash
gboolean session_render(dt_dev_pixelpipe_t *pipe, const int devid, const int bw, const int bh,
                        const double req_scale, const int x, const int y, JsonArray *have,
                        int *ow, int *oh, int *ox_out, int *oy_out, dt_hash_t *kept, preview_output_t *output, char **err)
{
  *kept = DT_INVALID_HASH;
  double scale = req_scale;
  int w, h, ox = 0, oy = 0;
  if(scale <= 0.0)
  {
    const double sx = bw > 0 ? (double)bw / pipe->processed_width : 1.0;
    const double sy = bh > 0 ? (double)bh / pipe->processed_height : 1.0;
    scale = fmin(1.0, fmin(sx, sy));
    w = floor(scale * pipe->processed_width);
    h = floor(scale * pipe->processed_height);
  }
  else
  {
    const int sw = floor(scale * pipe->processed_width);
    const int sh = floor(scale * pipe->processed_height);
    w = MIN(bw, sw);
    h = MIN(bh, sh);
    ox = CLAMP(x, 0, sw - w);
    oy = CLAMP(y, 0, sh - h);
  }

  if(have && json_array_get_length(have))
  {
    // the hash dt_dev_pixelpipe_process() gives its backbuf (pixelpipe_hb.c),
    // from the pieces' hashes, which the pipe's sync has brought current.
    // the same hash is darktable's own test for reusing a cacheline. the
    // edit's shapes go in as for the frames it sends (_frame_hash)
    const dt_iop_roi_t roi = { ox, oy, w, h, (float)scale };
    const dt_hash_t hash = _frame_hash(dt_dev_pixelpipe_cache_hash(&roi, pipe, g_list_length(pipe->iop)));
    gchar *hex = g_strdup_printf("%016" PRIx64, hash);
    for(guint k = 0; k < json_array_get_length(have); k++)
      if(!g_strcmp0(json_array_get_string_element(have, k), hex)) *kept = hash;
    g_free(hex);
    if(*kept != DT_INVALID_HASH)
    {
      *ow = w;
      *oh = h;
      *ox_out = ox;
      *oy_out = oy;
      return TRUE;
    }
  }
  pipe->output_sink = output ? _preview_output_sink : NULL;
  pipe->output_sink_user = output;
  const gboolean failed = dt_dev_pixelpipe_process(pipe, &_s.dev, ox, oy, w, h, scale, devid);
  pipe->output_sink = NULL;
  pipe->output_sink_user = NULL;
  if(failed || (output ? !output->completed : !pipe->backbuf))
  {
    *err = g_strdup("pixelpipe processing failed or was interrupted");
    return FALSE;
  }
  *ow = pipe->backbuf_width;
  *oh = pipe->backbuf_height;
  *ox_out = ox;
  *oy_out = oy;
  return TRUE;
}

// the backbuf is 8-bit in display byte order (BGRA), as the export path keeps it
static gboolean _write_ppm(const char *path, const uint8_t *in, const int w, const int h)
{
  FILE *f = g_fopen(path, "wb");
  if(!f) return FALSE;
  fprintf(f, "P6\n%d %d\n255\n", w, h);
  uint8_t *row = g_malloc((size_t)3 * w);
  for(int j = 0; j < h; j++)
  {
    for(int i = 0; i < w; i++)
    {
      const uint8_t *px = in + 4 * ((size_t)j * w + i);
      row[3 * i + 0] = px[2];
      row[3 * i + 1] = px[1];
      row[3 * i + 2] = px[0];
    }
    fwrite(row, 1, (size_t)3 * w, f);
  }
  g_free(row);
  fclose(f);
  return TRUE;
}

#include "transient_output.h"

// transient_output.h keeps its state in file statics, so the other files
// write through this one copy
gboolean engine_transient_write(const char *path, const void *first, size_t a,
                                const void *second, size_t b)
{
  return transient_write(path, first, a, second, b);
}

#include "rgba_output.h"

// headerless RGBA, ready for a canvas ImageData; the size is in the reply.
// written over the file in place: g_file_set_contents() would write a
// temporary file, sync it and rename it, for every frame of a slider drag.
// the client reads it while the engine is still its own, so no half-written
// frame is ever read
static gboolean _write_rgba(const char *path, const uint8_t *in, const int w, const int h, double *timings)
{
  const gint64 started = g_get_monotonic_time();
  if(w <= 0 || h <= 0 || (size_t)w > SIZE_MAX / 4 / (size_t)h) return FALSE;
  const size_t n = (size_t)w * h;
#ifdef _WIN32
  // The CLI can still request an ordinary RGBA file; app output is mapped.
  const gboolean mapped = g_str_has_prefix(path, "shm:");
  uint8_t *rgba = mapped ? rgba_output_acquire(path, 4 * n) : g_try_malloc(4 * n);
#else
  const gboolean mapped = TRUE;
  uint8_t *rgba = rgba_output_acquire(path, 4 * n);
#endif
  if(!rgba) return FALSE;
  const gint64 allocated = g_get_monotonic_time();
  DT_OMP_FOR()
  for(size_t k = 0; k < n; k++)
  {
    rgba[4 * k + 0] = in[4 * k + 2];
    rgba[4 * k + 1] = in[4 * k + 1];
    rgba[4 * k + 2] = in[4 * k + 0];
    rgba[4 * k + 3] = 255;
  }
  const gint64 converted = g_get_monotonic_time();
  // MAP_SHARED writes are visible before the JSON completion reply. No file
  // write, flush, or intermediate RGBA allocation is needed for mapped output.
  gboolean ok = mapped || engine_transient_write(path, rgba, 4 * n, NULL, 0);
  const gint64 written = g_get_monotonic_time();
  if(!mapped) g_free(rgba);
  const gint64 freed = g_get_monotonic_time();
  if(timings)
  {
    timings[0] = (allocated - started) / 1000.0;
    timings[1] = (converted - allocated) / 1000.0;
    timings[2] = (written - converted) / 1000.0;
    timings[3] = (freed - written) / 1000.0;
  }
  return ok;
}

static gboolean _preview_output_sink(void *user, const uint8_t *pixels, int w, int h)
{
  preview_output_t *output = user;
  const gint64 started = g_get_monotonic_time();
  output->completed = _write_rgba(output->path, pixels, w, h, output->timings);
  output->elapsed_ms = engine_ms_since(started);
  return output->completed;
}

// { op: [field, ...] } ->
//   { op: { enabled, default_enabled, params: { field: value }, defaults: { ... } } }
// the instance of `op` named `name`, if there is one
static dt_iop_module_t *_find_named(const char *op, const char *name)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(!g_strcmp0(m->op, op) && m->multi_name_hand_edited && !g_strcmp0(m->multi_name, name)) return m;
  }
  return NULL;
}

// a key "op#name" reads the instance so named; one not made yet reads as
// the first instance's defaults, switched off
static gboolean _get(JsonObject *ops, JsonBuilder *b, char **err)
{
  json_builder_set_member_name(b, "modules");
  json_builder_begin_object(b);
  GList *names = json_object_get_members(ops);
  for(GList *n = names; n; n = g_list_next(n))
  {
    const char *key = n->data, *hash = strchr(key, '#');
    gchar *op = hash ? g_strndup(key, hash - key) : g_strdup(key);
    dt_iop_module_t *named = hash ? _find_named(op, hash + 1) : NULL;
    dt_iop_module_t *mod = named ? named : session_module(op, err);
    g_free(op);
    if(!mod) { g_list_free(names); return FALSE; }
    const gboolean missing = hash && !named;
    json_builder_set_member_name(b, n->data);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, missing ? FALSE : mod->enabled);
    json_builder_set_member_name(b, "default_enabled");
    json_builder_add_boolean_value(b, mod->default_enabled);
    JsonArray *fields = json_object_get_array_member(ops, n->data);
    for(int pass = 0; pass < 2; pass++)
    {
      json_builder_set_member_name(b, pass ? "defaults" : "params");
      json_builder_begin_object(b);
      for(guint i = 0; fields && i < json_array_get_length(fields); i++)
      {
        const char *name = json_array_get_string_element(fields, i);
        double num = 0.0;
        if(!_read_field(mod, name, pass || missing, &num, err)) { g_list_free(names); return FALSE; }
        json_builder_set_member_name(b, name);
        json_builder_add_double_value(b, num);
      }
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
  }
  g_list_free(names);
  json_builder_end_object(b);
  return TRUE;
}

typedef struct { JsonBuilder *b; GHashTable *seen; } _lens_menu_t;

static void _lens_menu_add(const char *maker, const char *model, void *user)
{
  _lens_menu_t *m = user;
  if(!model || !*model || g_hash_table_contains(m->seen, model)) return;
  g_hash_table_add(m->seen, g_strdup(model));
  json_builder_begin_object(m->b);
  engine_add_string(m->b, "name", model);
  engine_add_string(m->b, "maker", maker);
  json_builder_set_member_name(m->b, "hash");
  json_builder_add_int_value(m->b, lenses_hash(model));
  json_builder_end_object(m->b);
}

static gboolean _lens_menu(JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = session_module("lens", err);
  if(!mod) return FALSE;
  dt_introspection_field_t *f = NULL;
  const char *lens = session_field_in(mod, mod->params, "lens", &f, err);
  const char *auto_lens = lens ? session_field_in(mod, mod->default_params, "lens", &f, err) : NULL;
  if(!lens || !auto_lens) return FALSE;
  // the database's name for the lens the file names, as the module matches it
  const dt_image_t *img = &_s.dev.image_storage;
  char matched[128];
  g_strlcpy(matched, auto_lens, sizeof matched);
  lenses_match(img->exif_maker, img->exif_model, auto_lens, matched, sizeof matched);
  engine_add_string(b, "auto", matched);
  double pick = 0.0;
  if(!_read_field(mod, LENS_PICK, FALSE, &pick, err)) return FALSE;
  json_builder_set_member_name(b, "pick");
  json_builder_add_int_value(b, (gint64)pick);
  json_builder_set_member_name(b, "lenses");
  json_builder_begin_array(b);
  _lens_menu_t m = { b, g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL) };
  lenses_list(img->exif_maker, img->exif_model, _lens_menu_add, &m);
  // a lens kept from another camera's edit, or the matched one, is listed
  if(*lens && g_strcmp0(lens, auto_lens)) _lens_menu_add("", lens, &m);
  if(*matched) _lens_menu_add("", matched, &m);
  g_hash_table_destroy(m.seen);
  json_builder_end_array(b);
  return TRUE;
}

static void _profile_option(JsonBuilder *b, const char *label, const guint64 id)
{
  json_builder_begin_array(b);
  json_builder_add_string_value(b, label);
  json_builder_add_int_value(b, id);
  json_builder_end_array(b);
}

static gboolean _color_profiles(JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = session_module("colorin", err);
  if(!mod) return FALSE;
  for(int work = 0; work < 2; work++)
  {
    json_builder_set_member_name(b, work ? "working" : "input");
    json_builder_begin_array(b);
    _profile_option(b, "Default for Photo", 0);
    if(!work)
    {
      _profile_option(b, "Camera Standard Matrix", DT_COLORSPACE_STANDARD_MATRIX + 1);
      _profile_option(b, "Camera Enhanced Matrix", DT_COLORSPACE_ENHANCED_MATRIX + 1);
    }
    int *type; char *filename;
    if(!_profile_fields(mod, mod->params, work, &type, &filename, err)) return FALSE;
    const guint64 current = _profile_id(*type, filename);
    gboolean found = !work && (*type == DT_COLORSPACE_STANDARD_MATRIX || *type == DT_COLORSPACE_ENHANCED_MATRIX);
    for(const GList *l = darktable.color_profiles->profiles; l; l = l->next)
    {
      const dt_colorspaces_color_profile_t *p = l->data;
      if((work ? p->work_pos : p->in_pos) < 0) continue;
      const guint64 id = _profile_id(p->type, p->filename);
      _profile_option(b, p->name, id);
      found |= id == current;
    }
    if(!found)
    {
      gchar *label = g_strdup_printf("%s (current)",
        *type == DT_COLORSPACE_FILE ? filename : dt_colorspaces_get_name(*type, filename));
      _profile_option(b, label, current);
      g_free(label);
    }
    json_builder_end_array(b);
  }
  return TRUE;
}

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

// ------------------------------------------------------------------ masks
// a client's mask (Lightroom's local adjustments) is a darktable mask group
// named "immage: <name>" holding its shapes, shared by the module
// instances named "<name>" that carry the mask's adjustments. all of it is
// ordinary darktable history, so stock darktable shows the same masks
#define _MASK_PREFIX "immage: "

// a client mask's name from its group's, or NULL for a group that is not one
static const char *_mask_name(const char *full)
{
  if(g_str_has_prefix(full, _MASK_PREFIX)) return full + strlen(_MASK_PREFIX);
  return NULL;
}
// the mask anchor: masks' instances run right after it, all on one input,
// so a range sampled at its output holds for every one of them
// (app/docs/dev/masks.md, "Where the instances run")
#define _MASK_ANCHOR "colorbalancergb"
// the instances masks share are named so (app/src/localMerge.ts SHARED_PREFIX)
#define _SHARED_PREFIX "immage local: "

static dt_masks_form_t *_mask_group(const char *name)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if(!(f->type & DT_MASKS_GROUP)) continue;
    const char *n = _mask_name(f->name);
    if(n && !g_strcmp0(n, name)) return f;
  }
  return NULL;
}

// a combined mask: masks' groups summed, each at an opacity of its own, so
// one instance can carry the same adjustment for several masks at their
// own strengths, as Lightroom's local adjustments add up, instead of one
// instance per mask each running the whole module. not a client mask, so
// _masks() passes over it
#define _COMBINED_PREFIX "immage combined: "

static dt_masks_form_t *_combined_group(const char *name)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if((f->type & DT_MASKS_GROUP) && g_str_has_prefix(f->name, _COMBINED_PREFIX)
       && !g_strcmp0(f->name + strlen(_COMBINED_PREFIX), name))
      return f;
  }
  return NULL;
}

// masks are darktable's flexi masks (dev-doc/masks_data_model.md). a
// mask's group, "immage: <name>", holds its drawn shapes. its range
// components are parametric elements multiplied into them, as darktable
// converts a classic drawn and parametric mask (masks/migrate_legacy.c,
// _migrate_drawn_and_parametric), in a group of their own named after the
// mask's: the instances blending in scene-referred RGB, where the ranges
// were measured, take that one, and the rest the shapes alone
#define _RANGES_PREFIX "immage ranges: "

static dt_masks_form_t *_group_named(const char *full)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if((f->type & DT_MASKS_GROUP) && !g_strcmp0(f->name, full)) return f;
  }
  return NULL;
}

// a mask's group or a combined mask's
static gboolean _is_root(const dt_masks_form_t *f)
{
  return f && (f->type & DT_MASKS_GROUP)
         && (g_str_has_prefix(f->name, _MASK_PREFIX) || g_str_has_prefix(f->name, _COMBINED_PREFIX));
}

// the group with the ranges of `root`, or NULL when it has none
static dt_masks_form_t *_ranges_group(const dt_masks_form_t *root)
{
  char full[sizeof(root->name)];
  g_snprintf(full, sizeof(full), "%s%s", _RANGES_PREFIX, root->name);
  return _group_named(full);
}

static const char *_mask_instance_tag(const dt_iop_module_t *m, const char *name);

// the mask (its group, or a combined mask's) instance `m` carries, or NULL.
// an edit made before flexi masks was converted when it was loaded, which
// gives every instance with ranges a group of its own, unnamed
// (migrate_legacy.c): its instances are known by their names then
static dt_masks_form_t *_instance_group(const dt_iop_module_t *m)
{
  const dt_develop_blend_params_t *bp = m->blend_params;
  if(!bp || !(bp->mask_mode & DEVELOP_MASK_ENABLED)) return NULL;
  dt_masks_form_t *g = dt_is_valid_maskid(bp->mask_id) ? dt_masks_get_from_id(&_s.dev, bp->mask_id) : NULL;
  if(g && (g->type & DT_MASKS_GROUP))
  {
    if(_is_root(g)) return g;
    if(g_str_has_prefix(g->name, _RANGES_PREFIX))
    {
      dt_masks_form_t *root = _group_named(g->name + strlen(_RANGES_PREFIX));
      if(root) return root;
    }
  }
  if(!m->multi_name_hand_edited) return NULL;
  if(g_str_has_prefix(m->multi_name, _SHARED_PREFIX))
    return _combined_group(m->multi_name + strlen(_SHARED_PREFIX));
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    const char *name = (f->type & DT_MASKS_GROUP) ? _mask_name(f->name) : NULL;
    if(name && _mask_instance_tag(m, name)) return f;
  }
  return NULL;
}

// whether mask `root` holds anything to fold: an empty one is its marker
static gboolean _has_members(const dt_masks_form_t *root)
{
  for(const GList *l = root ? root->points : NULL; l; l = g_list_next(l))
    if(!dt_masks_point_is_marker(l->data)) return TRUE;
  return FALSE;
}

// `f` and every form under it into `set`
static void _reach(const dt_masks_form_t *f, GHashTable *set, const int depth)
{
  if(!f || depth > DT_MASKS_NESTING_MAX || g_hash_table_contains(set, f)) return;
  g_hash_table_add(set, (gpointer)f);
  if(!(f->type & DT_MASKS_GROUP)) return;
  for(const GList *l = f->points; l; l = g_list_next(l))
  {
    const dt_masks_point_group_t *pt = l->data;
    if(!dt_masks_point_is_marker(pt)) _reach(dt_masks_get_from_id(&_s.dev, pt->formid), set, depth + 1);
  }
}

// the forms mask `root` (a mask's group or a combined mask's) renders with:
// its tree, its ranges' and those of its instances, which for an older
// edit are trees of their own. darktable's conversion copies a group held
// twice, under the same name, so those go with it as well
static GHashTable *_mask_forms(const dt_masks_form_t *root)
{
  GHashTable *set = g_hash_table_new(NULL, NULL);
  _reach(root, set, 0);
  _reach(_ranges_group(root), set, 0);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(_instance_group(m) == root) _reach(dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id), set, 0);
  }
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    const dt_masks_form_t *f = l->data;
    if(f != root && (f->type & DT_MASKS_GROUP) && !g_strcmp0(f->name, root->name)) _reach(f, set, 0);
  }
  return set;
}

// the forms in `old` that nothing uses any more leave the image, and `old`
// is freed: before a history item is added, which keeps all of the
// develop's forms. used is what a module renders, a mask's group, a
// combined mask's and their ranges' (the first of a name), and whatever
// another group holds
static void _free_unreached(GHashTable *old)
{
  GHashTable *live = g_hash_table_new(NULL, NULL);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(!m->blend_params) continue;
    _reach(dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id), live, 0);
    _reach(dt_masks_get_from_id(&_s.dev, m->blend_params->blend_mask_id), live, 0);
  }
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    const dt_masks_form_t *f = l->data;
    if(!(f->type & DT_MASKS_GROUP)) continue;
    const gboolean named = (_is_root(f) || g_str_has_prefix(f->name, _RANGES_PREFIX))
                           && _group_named(f->name) == f;
    if(named || !g_hash_table_contains(old, f)) _reach(f, live, 0);
  }
  for(GList *l = _s.dev.forms; l;)
  {
    GList *next = g_list_next(l);
    dt_masks_form_t *f = l->data;
    if(g_hash_table_contains(old, f) && !g_hash_table_contains(live, f))
    {
      _s.dev.forms = g_list_delete_link(_s.dev.forms, l);
      dt_masks_free_form(f);
    }
    l = next;
  }
  g_hash_table_destroy(live);
  g_hash_table_destroy(old);
}

// a member of `grp` referring to form `formid`
static dt_masks_point_group_t *_member(dt_masks_form_t *grp, const dt_mask_id_t formid, const int state,
                                       const float opacity)
{
  dt_masks_point_group_t *pt = calloc(1, sizeof(dt_masks_point_group_t));
  pt->formid = formid;
  pt->parentid = grp->formid;
  pt->state = state;
  pt->opacity = opacity;
  pt->group_opacity = 1.0f;
  grp->points = g_list_append(grp->points, pt);
  return pt;
}

// whether member `pt` of a combined mask is mask `root`: by reference, or,
// in an older edit, as the shape darktable put there in its place
static gboolean _holds_mask(const dt_masks_point_group_t *pt, const dt_masks_form_t *root)
{
  if(dt_masks_point_is_marker(pt)) return FALSE;
  if(pt->formid == root->formid) return TRUE;
  const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, pt->formid);
  const size_t n = strlen(root->name);
  return f && !strncmp(f->name, root->name, n) && !strncmp(f->name + n, " #", 2);
}

// the combined masks holding mask `root` in an older edit's way, as one of
// its shapes, hold its group instead, whatever becomes of its shapes
static void _combined_adopt(const dt_masks_form_t *root)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *grp = l->data;
    if(!(grp->type & DT_MASKS_GROUP) || !g_str_has_prefix(grp->name, _COMBINED_PREFIX)) continue;
    gboolean held = FALSE;
    for(GList *p = grp->points; p;)
    {
      GList *next = g_list_next(p);
      dt_masks_point_group_t *pt = p->data;
      if(_holds_mask(pt, root))
      {
        if(held)
        {
          grp->points = g_list_delete_link(grp->points, p);
          free(pt);
        }
        else
          pt->formid = root->formid;
        held = TRUE;
      }
      p = next;
    }
  }
}

// the instance of `op` named `name`, made (switched off) when missing.
// `anchored`, a new one runs after the mask anchor
static dt_iop_module_t *_named_instance(const char *op, const char *name, const gboolean anchored,
                                        char **err)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(!g_strcmp0(m->op, op) && m->multi_name_hand_edited && !g_strcmp0(m->multi_name, name)) return m;
  }
  dt_iop_module_t *base = dt_iop_get_module_by_op_priority(_s.dev.iop, op, 0);
  dt_iop_module_t *m = base ? dt_dev_module_duplicate_ext(&_s.dev, base, TRUE) : NULL;
  if(!m)
  {
    *err = g_strdup_printf("cannot add an instance of '%s'", op);
    return NULL;
  }
  g_strlcpy(m->multi_name, name, sizeof(m->multi_name));
  m->multi_name_hand_edited = TRUE;
  m->enabled = FALSE;
  // a new instance starts from the defaults for this image, not the base
  // instance's edit; the image's defaults (denoise's noise profile) come
  // from reload_defaults, which duplicating does not run
  dt_iop_reload_defaults(m);
  memcpy(m->params, m->default_params, m->params_size);
  // mask instances run together after the anchor, in the working space,
  // where a range mask's sampled values hold for all of them
  // except denoise (profiled), whose noise profile holds only for the
  // camera's data where it normally runs, and haze removal, whose ambient
  // light estimate goes negative on the exposed values after the anchor,
  // which leaves a positive strength nothing to remove (hazeremoval.c,
  // t_min)
  dt_iop_module_t *anchor = dt_iop_get_module_by_op_priority(_s.dev.iop, _MASK_ANCHOR, 0);
  if(anchored && anchor && m->iop_order < anchor->iop_order && g_strcmp0(op, "denoiseprofile")
     && g_strcmp0(op, "hazeremoval")
     && dt_ioppr_check_can_move_after_iop(_s.dev.iop, m, anchor))
    dt_ioppr_move_iop_after(&_s.dev, m, anchor);
  // a mask's own instance runs after the instances masks share
  // (app/src/localMerge.ts), so editing it alone, as a mask lifted out of
  // them for a drag is, leaves their output to the pipe cache
  if(anchored && !g_str_has_prefix(name, _SHARED_PREFIX))
  {
    dt_iop_module_t *last = NULL;
    for(GList *l = _s.dev.iop; l; l = g_list_next(l))
    {
      dt_iop_module_t *s = l->data;
      if(s != m && !g_strcmp0(s->op, op) && g_str_has_prefix(s->multi_name, _SHARED_PREFIX)
         && (!last || s->iop_order > last->iop_order))
        last = s;
    }
    if(last && m->iop_order < last->iop_order && dt_ioppr_check_can_move_after_iop(_s.dev.iop, m, last))
      dt_ioppr_move_iop_after(&_s.dev, m, last);
  }
  _s.iop_gen++;
  session_changed(DT_DEV_PIPE_REMOVE);
  return m;
}

// a point of the shown image (0-1 across its width and height) as darktable
// stores shape points: in the input image, before any distortion, 0-1
static void _to_input(const float x, const float y, float *ix, float *iy)
{
  float p[2] = { x * _s.pipe.processed_width, y * _s.pipe.processed_height };
  dt_dev_distort_backtransform_plus(&_s.dev, &_s.pipe, 0, DT_DEV_TRANSFORM_DIR_ALL, p, 1);
  *ix = p[0] / _s.pipe.iwidth;
  *iy = p[1] / _s.pipe.iheight;
}

// distances and angles survive the distortion only approximately; they are
// measured between transformed points, in input pixels
static void _to_input_vec(const float x, const float y, const float dx, const float dy,
                          float *len, float *angle)
{
  float ax, ay, bx, by;
  _to_input(x, y, &ax, &ay);
  _to_input(x + dx, y + dy, &bx, &by);
  const float vx = (bx - ax) * _s.pipe.iwidth, vy = (by - ay) * _s.pipe.iheight;
  *len = hypotf(vx, vy);
  *angle = atan2f(vy, vx);
}

// one shape of a mask, from the client's description in shown-image units:
//   ellipse: x, y (center), rx, ry (radii, both as fractions of the shown
//            width, so rx = ry is a circle), angle (degrees, clockwise),
//            feather (0-1, inward)
//   gradient: x, y (where it is half on), angle (degrees, the direction it
//             fades toward), width (the fade, as a fraction of the shown
//             image's diagonal)
//   brush:   points [[x, y], ...], size (fraction of the shown width),
//            hardness (0-1), density (0-1)
static dt_masks_form_t *_shape(JsonObject *o, char **err)
{
  const char *type = json_object_get_string_member_with_default(o, "type", "");
  const float x = json_object_get_double_member_with_default(o, "x", 0.5);
  const float y = json_object_get_double_member_with_default(o, "y", 0.5);
  const float pw = _s.pipe.processed_width, ph = _s.pipe.processed_height;
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);

  if(!g_strcmp0(type, "ellipse"))
  {
    const float rx = json_object_get_double_member_with_default(o, "rx", 0.2);
    const float ry = json_object_get_double_member_with_default(o, "ry", 0.2);
    const float a = json_object_get_double_member_with_default(o, "angle", 0.0) * M_PI / 180.0;
    const float feather = CLAMP(json_object_get_double_member_with_default(o, "feather", 0.5), 0.0, 0.95);
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_ELLIPSE);
    dt_masks_point_ellipse_t *e = calloc(1, sizeof(dt_masks_point_ellipse_t));
    _to_input(x, y, &e->center[0], &e->center[1]);
    float la, lb, aa, ab;
    // the two semi-axes as offsets in shown-image units, y scaled to width
    _to_input_vec(x, y, rx * cosf(a), rx * sinf(a) * pw / ph, &la, &aa);
    _to_input_vec(x, y, -ry * sinf(a), ry * cosf(a) * pw / ph, &lb, &ab);
    // feather inward, as Lightroom's: the full effect stops short of the
    // edge by the feather, and darktable's border carries it to the edge
    e->radius[0] = MAX(0.002f, la * (1.0f - feather) / imin);
    e->radius[1] = MAX(0.002f, lb * (1.0f - feather) / imin);
    e->rotation = aa * 180.0f / M_PI;
    e->flags = DT_MASKS_ELLIPSE_PROPORTIONAL;
    e->border = MAX(0.001f, feather / (1.0f - feather));
    f->points = g_list_append(f->points, e);
    return f;
  }
  if(!g_strcmp0(type, "gradient"))
  {
    const float a = json_object_get_double_member_with_default(o, "angle", 90.0) * M_PI / 180.0;
    const float width = CLAMP(json_object_get_double_member_with_default(o, "width", 0.3), 0.001, 2.0);
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_GRADIENT);
    dt_masks_point_gradient_t *g = calloc(1, sizeof(dt_masks_point_gradient_t));
    _to_input(x, y, &g->anchor[0], &g->anchor[1]);
    float len, ang;
    _to_input_vec(x, y, cosf(a) * 0.01f, sinf(a) * 0.01f * pw / ph, &len, &ang);
    g->rotation = -ang * 180.0f / M_PI + 90.0f;
    // darktable fades over twice the compression, in input diagonals
    g->compression = width / 2.0f * hypotf(pw, ph) / hypotf(_s.pipe.iwidth, _s.pipe.iheight);
    g->steepness = 0.0f;
    g->curvature = 0.0f;
    g->state = DT_MASKS_GRADIENT_STATE_LINEAR;
    f->points = g_list_append(f->points, g);
    return f;
  }
  if(!g_strcmp0(type, "brush"))
  {
    JsonArray *pts = json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
    const guint n = pts ? json_array_get_length(pts) : 0;
    if(n == 0)
    {
      *err = g_strdup("a brush stroke needs points");
      return NULL;
    }
    const float size = json_object_get_double_member_with_default(o, "size", 0.05);
    const float hardness = CLAMP(json_object_get_double_member_with_default(o, "hardness", 0.5), 0.0, 1.0);
    const float density = CLAMP(json_object_get_double_member_with_default(o, "density", 1.0), 0.0, 1.0);
    // the stroke's radius in input units, as darktable's brush keeps it
    float len, ang;
    _to_input_vec(x, y, size / 2.0f, 0.0f, &len, &ang);
    const float border = MAX(0.0005f, len / imin);
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_BRUSH);
    for(guint k = 0; k < n; k++)
    {
      JsonArray *p = json_array_get_array_element(pts, k);
      dt_masks_point_brush_t *b = calloc(1, sizeof(dt_masks_point_brush_t));
      _to_input(json_array_get_double_element(p, 0), json_array_get_double_element(p, 1),
                &b->corner[0], &b->corner[1]);
      b->ctrl1[0] = b->ctrl2[0] = b->corner[0];
      b->ctrl1[1] = b->ctrl2[1] = b->corner[1];
      b->border[0] = b->border[1] = border;
      b->hardness = hardness;
      b->density = density;
      b->state = DT_MASKS_POINT_STATE_NORMAL;
      f->points = g_list_append(f->points, b);
    }
    return f;
  }
  *err = g_strdup_printf("unknown shape '%s'", type);
  return NULL;
}

// `paths` of component k as darktable path shapes, appended to `grp`
// and named "#k.i", `mark` before a hole's "-". `*bottom` while nothing
// is under them in the group: the first then takes no operator. `off`,
// kept but disabled, which darktable's group passes over (masks/group.c)
static gboolean _object_paths(dt_masks_form_t *grp, JsonArray *paths, const char *name, const guint k,
                              const char *tag, const char *mark, const float feather,
                              const gboolean subtract, const gboolean off, gboolean *bottom)
{
  gboolean any = FALSE;
  for(guint i = 0; paths && i < json_array_get_length(paths); i++)
  {
    JsonObject *po = json_array_get_object_element(paths, i);
    JsonArray *pts = json_object_get_array_member(po, "points");
    const guint n = pts ? json_array_get_length(pts) : 0;
    if(n < 3) continue;
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_PATH);
    for(guint j = 0; j < n; j++)
    {
      JsonArray *c = json_array_get_array_element(pts, j);
      dt_masks_point_path_t *pt = calloc(1, sizeof(dt_masks_point_path_t));
      _to_input(json_array_get_double_element(c, 0), json_array_get_double_element(c, 1), &pt->corner[0], &pt->corner[1]);
      _to_input(json_array_get_double_element(c, 2), json_array_get_double_element(c, 3), &pt->ctrl1[0], &pt->ctrl1[1]);
      _to_input(json_array_get_double_element(c, 4), json_array_get_double_element(c, 5), &pt->ctrl2[0], &pt->ctrl2[1]);
      pt->border[0] = pt->border[1] = feather;
      pt->state = DT_MASKS_POINT_STATE_USER;
      f->points = g_list_append(f->points, pt);
    }
    // the name keeps which component a path belongs to, and whether it is a
    // hole, for reading the component back
    const gboolean hole = json_object_get_boolean_member_with_default(po, "hole", FALSE);
    g_snprintf(f->name, sizeof(f->name), "%s%s #%u.%u%s%s%s", _MASK_PREFIX, name, k + 1, i + 1, tag, mark,
               hole ? "-" : "");
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
    gp->formid = f->formid;
    gp->parentid = grp->formid;
    gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    // a hole takes away from the object; a subtracted object's outline
    // takes away from the mask
    if(!*bottom)
      gp->state |= (hole != subtract) ? DT_MASKS_STATE_DIFFERENCE : DT_MASKS_STATE_UNION;
    if(off) gp->state |= DT_MASKS_STATE_DISABLE;
    gp->opacity = 1.0f;
    grp->points = g_list_append(grp->points, gp);
    if(!off) *bottom = FALSE;
    any = TRUE;
  }
  return any;
}

static void _set_channel(dt_develop_blend_params_t *bp, const int ch, const float lim[4], const gboolean invert);

// component k's backdrop: a parametric shape taking hz window `range` out,
// named "#k~", or "#k~off" turned off, intersecting what is in `grp` so
// far, or `disabled`. darktable evaluates a parametric shape with the
// module's blend parameters (masks/parametric.c), which never invert it
// (_apply_ranges), so its own channel takes the color out
static void _backdrop_shape(dt_masks_form_t *grp, JsonArray *range, const char *name, const guint k,
                            const gboolean turned_off, const gboolean disabled)
{
  dt_develop_blend_params_t bp = { 0 };
  float lim[4];
  for(int i = 0; i < 4; i++) lim[i] = CLAMP(json_array_get_double_element(range, i), 0.0, 1.0);
  _set_channel(&bp, DEVELOP_BLENDIF_hz_in, lim, TRUE);
  dt_masks_form_t *f = dt_masks_create(DT_MASKS_PARAMETRIC);
  dt_masks_point_parametric_t *pp = calloc(1, sizeof(dt_masks_point_parametric_t));
  pp->blendif = bp.blendif;
  memcpy(pp->blendif_parameters, bp.blendif_parameters, sizeof(pp->blendif_parameters));
  memcpy(pp->blendif_boost_factors, bp.blendif_boost_factors, sizeof(pp->blendif_boost_factors));
  pp->colorspace = DEVELOP_BLEND_CS_RGB_SCENE;
  // the channel darktable's mask panel shows it as
  const dt_iop_gui_blendif_channel_t *chans = dt_develop_blendif_channels_for_csp(DEVELOP_BLEND_CS_RGB_SCENE);
  for(int c = 0; chans && chans[c].label; c++)
    if(chans[c].param_channels[0] == DEVELOP_BLENDIF_hz_in) pp->channel = c;
  f->points = g_list_append(f->points, pp);
  g_snprintf(f->name, sizeof(f->name), "%s%s #%u~%s", _MASK_PREFIX, name, k + 1, turned_off ? "off" : "");
  _s.dev.forms = g_list_append(_s.dev.forms, f);
  dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
  gp->formid = f->formid;
  gp->parentid = grp->formid;
  gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_INTERSECTION;
  if(disabled) gp->state |= DT_MASKS_STATE_DISABLE;
  gp->opacity = 1.0f;
  grp->points = g_list_append(grp->points, gp);
}

// a component's backdrop shape, "#k~" or "#k~off"
static gboolean _is_backdrop_shape(const dt_masks_form_t *f)
{
  const char *hash = strrchr(f->name, '#');
  return (f->type & DT_MASKS_PARAMETRIC) && hash && strchr(hash, '~');
}

// an "object" component's paths as darktable path shapes, appended to `grp`.
// with a `backdrop` {range, paths, plain} (_backdrop), as the mask's first
// shape: its edge outline, less the backdrop's color, or its outline inset
// a whole feather, whose feather ends at the edge. the edge's feather ends
// at the color, and the subject keeps the inset outline's mask.
// darktable's group folds in list order, union by max and intersection by
// min (masks/group.c), so the edge outline goes first, then the backdrop
// shape, then the inset outline. anywhere else the backdrop shape would
// take the color out of the shapes before it, so there, or turned `off`,
// the plain outline "#k.i^" serves, as a selection without a backdrop
// would be traced. the parts not used are kept disabled, so turning it
// back on, or moving the shape first, finds them
static gboolean _object_shapes(dt_masks_form_t *grp, JsonObject *o, const char *name, const guint k,
                               const gboolean first, char **err)
{
  JsonArray *paths = json_object_has_member(o, "paths") ? json_object_get_array_member(o, "paths") : NULL;
  const gboolean subtract = !g_strcmp0(json_object_get_string_member_with_default(o, "mode", "add"), "subtract");
  const float feather = CLAMP(json_object_get_double_member_with_default(o, "feather", _OBJECT_FEATHER), 0.0, 0.1);
  // a Depth Range's band rides along in the names, as nothing else in
  // darktable's shapes can carry it
  JsonArray *depth = json_object_has_member(o, "depth") ? json_object_get_array_member(o, "depth") : NULL;
  gchar tag[3 * G_ASCII_DTOSTR_BUF_SIZE + 4] = "";
  if(depth && json_array_get_length(depth) == 2)
  {
    gchar lo[G_ASCII_DTOSTR_BUF_SIZE], hi[G_ASCII_DTOSTR_BUF_SIZE], fe[G_ASCII_DTOSTR_BUF_SIZE];
    g_ascii_formatd(lo, sizeof(lo), "%.3f", json_array_get_double_element(depth, 0));
    g_ascii_formatd(hi, sizeof(hi), "%.3f", json_array_get_double_element(depth, 1));
    g_ascii_formatd(fe, sizeof(fe), "%.4f", feather);
    g_snprintf(tag, sizeof(tag), "@%s,%s,%s", lo, hi, fe);
  }
  JsonObject *bd = json_object_has_member(o, "backdrop") ? json_object_get_object_member(o, "backdrop") : NULL;
  JsonArray *range = bd && json_object_has_member(bd, "range") ? json_object_get_array_member(bd, "range") : NULL;
  JsonArray *edge = bd && json_object_has_member(bd, "paths") ? json_object_get_array_member(bd, "paths") : NULL;
  JsonArray *plain = bd && json_object_has_member(bd, "plain") ? json_object_get_array_member(bd, "plain") : NULL;
  const gboolean off = bd && json_object_get_boolean_member_with_default(bd, "off", FALSE);
  gboolean bottom = first;
  gboolean any;
  if(range && json_array_get_length(range) == 4 && edge && json_array_get_length(edge))
  {
    // a backdrop made before the plain outline was kept has none: its
    // inset outline stands in
    const gboolean use = first && !subtract && !depth && !off;
    const gboolean have_plain = plain && json_array_get_length(plain);
    _object_paths(grp, edge, name, k, tag, "~", feather, subtract, !use, &bottom);
    _backdrop_shape(grp, range, name, k, off, !use);
    any = _object_paths(grp, paths, name, k, tag, "", feather, subtract, !use && have_plain, &bottom);
    if(have_plain) any |= _object_paths(grp, plain, name, k, tag, "^", feather, subtract, use, &bottom);
  }
  else
    any = _object_paths(grp, paths, name, k, tag, "", feather, subtract, FALSE, &bottom);
  if(!any) *err = g_strdup("an object component needs paths");
  return any;
}

// a path just beyond the input image's edges, first in `grp`, named "#0"
// so reading the mask back passes over it
static void _base_shape(dt_masks_form_t *grp, const char *name)
{
  static const float corners[4][2] = { { -0.1f, -0.1f }, { 1.1f, -0.1f }, { 1.1f, 1.1f }, { -0.1f, 1.1f } };
  dt_masks_form_t *f = dt_masks_create(DT_MASKS_PATH);
  for(int j = 0; j < 4; j++)
  {
    dt_masks_point_path_t *pt = calloc(1, sizeof(dt_masks_point_path_t));
    pt->corner[0] = pt->ctrl1[0] = pt->ctrl2[0] = corners[j][0];
    pt->corner[1] = pt->ctrl1[1] = pt->ctrl2[1] = corners[j][1];
    pt->state = DT_MASKS_POINT_STATE_USER;
    f->points = g_list_append(f->points, pt);
  }
  g_snprintf(f->name, sizeof(f->name), "%s%s #0", _MASK_PREFIX, name);
  _s.dev.forms = g_list_append(_s.dev.forms, f);
  dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
  gp->formid = f->formid;
  gp->parentid = grp->formid;
  gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
  gp->opacity = 1.0f;
  grp->points = g_list_append(grp->points, gp);
}

// a mask's whole-frame base, from _base_shape()
static gboolean _is_base_shape(const dt_masks_form_t *f)
{
  return g_str_has_suffix(f->name, " #0");
}

// the shapes that narrow a mask as darktable's parametric masks, rather
// than drawing it: they go into the instances' blend parameters
static gboolean _is_range(const char *type)
{
  return !g_strcmp0(type, "luminance") || !g_strcmp0(type, "color") || !g_strcmp0(type, "parametric");
}

static void _combined_member_changed(const dt_masks_form_t *root, const gboolean removed);
static void _ranges_into(dt_develop_blend_params_t *bp, JsonArray *list);

// the ranges `list` of mask `root` as its ranges group (_RANGES_PREFIX):
// one parametric element per channel, as darktable converts a classic
// mask's channels (migrate_legacy.c, _build_channel_forms), multiplied
// together and into `root`'s shapes when it has any. without ranges the
// group is left unnamed and empty, for _free_unreached()
static void _set_ranges_group(dt_masks_form_t *root, JsonArray *list)
{
  dt_develop_blend_params_t bp = { 0 };
  _ranges_into(&bp, list);
  dt_masks_form_t *grp = _ranges_group(root);
  if(!bp.blendif)
  {
    if(grp)
    {
      g_list_free_full(grp->points, free);
      grp->points = NULL;
      grp->name[0] = '\0';
    }
    return;
  }
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_snprintf(grp->name, sizeof(grp->name), "%s%s", _RANGES_PREFIX, root->name);
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  g_list_free_full(grp->points, free);
  // cleared first: the marker's new id is checked against every group's
  // points in the forms, this one's included (masks.c, _id_taken)
  grp->points = NULL;
  grp->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, grp, DT_MASKS_STATE_FLEXI_PRODUCT));
  if(_has_members(root))
    _member(grp, root->formid, DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_UNION, 1.0f);
  const dt_iop_gui_blendif_channel_t *chans = dt_develop_blendif_channels_for_csp(DEVELOP_BLEND_CS_RGB_SCENE);
  for(int c = 0; chans && chans[c].label; c++)
  {
    const uint32_t bits = (1u << chans[c].param_channels[0]) | (1u << chans[c].param_channels[1]);
    if(!(bp.blendif & bits)) continue;
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_PARAMETRIC);
    dt_masks_point_parametric_t *p = calloc(1, sizeof(dt_masks_point_parametric_t));
    p->blendif = bp.blendif & (bits | (bits << 16));
    memcpy(p->blendif_parameters, bp.blendif_parameters, 4 * DEVELOP_BLENDIF_SIZE * sizeof(float));
    memcpy(p->blendif_boost_factors, bp.blendif_boost_factors, DEVELOP_BLENDIF_SIZE * sizeof(float));
    p->colorspace = DEVELOP_BLEND_CS_RGB_SCENE;
    p->channel = c;
    f->points = g_list_append(NULL, p);
    dt_masks_assign_unique_name(&_s.dev, f);
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    _member(grp, f->formid, DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_UNION, 1.0f);
  }
}

// whether instance `m` inverts its mask: as Immage sets it, as classic
// darktable inverted a drawn and parametric mask, or as darktable's
// conversion of an older edit leaves a group one module renders, on the
// group (migrate_legacy.c, _move_history_polarity)
static gboolean _instance_inverted(const dt_iop_module_t *m)
{
  const dt_develop_blend_params_t *bp = m->blend_params;
  if(bp->mask_combine & (DEVELOP_COMBINE_INV | DEVELOP_COMBINE_MASKS_POS)) return TRUE;
  const dt_masks_form_t *g = dt_masks_get_from_id(&_s.dev, bp->mask_id);
  const dt_masks_point_group_t *mk = g && (g->type & DT_MASKS_GROUP) ? dt_masks_group_marker(g) : NULL;
  return mk && (mk->state & DT_MASKS_STATE_OP_INVERT);
}

// the dt_dev_pixelpipe_cache_invalidate_later of every pipe the engine runs
void masks_invalidate_from(const int order, const char *why)
{
  dt_dev_pixelpipe_cache_invalidate_later(&_s.pipe, order, why);
  if(_s.ppipe_ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, order, why);
  if(_s.drag.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.drag.pipe, order, why);
  if(_s.base.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.base.pipe, order, why);
}

// Disabled, marker-only groups carry recipe chunks in ordinary mask history/XMP.
// They render nothing, and avoid a separate metadata store drifting from history.
#define _AI_RECIPE "immage-ai-v1:"
static void _recipe_coordinates(JsonObject *o, void (*transform)(float, float, float *, float *))
{
  JsonArray *points = json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
  if(points)
  {
    JsonArray *to = json_array_new();
    for(guint i = 0; i < json_array_get_length(points); i++)
    {
      JsonArray *point = json_array_get_array_element(points, i);
      if(!point || json_array_get_length(point) != 3) continue;
      float x, y;
      transform(json_array_get_double_element(point, 0), json_array_get_double_element(point, 1), &x, &y);
      JsonArray *v = json_array_new();
      json_array_add_double_element(v, x); json_array_add_double_element(v, y);
      json_array_add_double_element(v, json_array_get_double_element(point, 2));
      json_array_add_array_element(to, v);
    }
    json_object_set_array_member(o, "points", to);
  }
  JsonArray *box = json_object_has_member(o, "box") ? json_object_get_array_member(o, "box") : NULL;
  if(box && json_array_get_length(box) == 4)
  {
    float x0, y0, x1, y1;
    transform(json_array_get_double_element(box, 0), json_array_get_double_element(box, 1), &x0, &y0);
    transform(json_array_get_double_element(box, 2), json_array_get_double_element(box, 3), &x1, &y1);
    JsonArray *to = json_array_new();
    json_array_add_double_element(to, MIN(x0,x1)); json_array_add_double_element(to, MIN(y0,y1));
    json_array_add_double_element(to, MAX(x0,x1)); json_array_add_double_element(to, MAX(y0,y1));
    json_object_set_array_member(o, "box", to);
  }
}

static void _store_recipes(dt_masks_form_t *grp, JsonArray *shapes)
{
  for(guint k = 0; shapes && k < json_array_get_length(shapes); k++)
  {
    JsonObject *shape = json_array_get_object_element(shapes, k);
    if(!json_object_has_member(shape, "ai")) continue;
    // Copy deeply: coordinate conversion must not mutate the incoming request.
    gchar *original = json_to_string(json_object_get_member(shape, "ai"), FALSE);
    JsonNode *copy = json_from_string(original, NULL);
    g_free(original);
    if(!copy || !JSON_NODE_HOLDS_OBJECT(copy)) { if(copy) json_node_free(copy); continue; }
    _recipe_coordinates(json_node_get_object(copy), _to_input);
    gchar *json = json_to_string(copy, FALSE);
    gchar *encoded = g_base64_encode((const guchar *)json, strlen(json));
    for(guint offset = 0, chunk = 0; offset < strlen(encoded); offset += 80, chunk++)
    {
      dt_masks_form_t *f = dt_masks_create(DT_MASKS_GROUP);
      g_snprintf(f->name, sizeof(f->name), _AI_RECIPE "%u:%u:%.80s", k + 1, chunk, encoded + offset);
      _s.dev.forms = g_list_append(_s.dev.forms, f);
      f->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, f, 0));
      _member(grp, f->formid, DT_MASKS_STATE_USE | DT_MASKS_STATE_DISABLE | DT_MASKS_STATE_UNION, 1.0f);
    }
    g_free(encoded); g_free(json); json_node_free(copy);
  }
}

// replace the shapes of mask `name` (made when missing); each shape adds
// to the mask, or with "subtract" takes away from it
static gboolean _mask(const char *name, JsonArray *shapes, char **err)
{
  dt_masks_form_t *grp = _mask_group(name);
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_snprintf(grp->name, sizeof(grp->name), "%s%s", _MASK_PREFIX, name);
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  // the old shapes go, whatever darktable made of an older edit; a mask is
  // small, and redrawing it whole keeps the client the only owner of its
  // geometry
  GHashTable *old = _mask_forms(grp);
  g_hash_table_remove(old, grp);
  // its instances, and whether each inverts it, as they had it
  GPtrArray *users = g_ptr_array_new();
  GArray *inverts = g_array_new(FALSE, FALSE, sizeof(gboolean));
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(_instance_group(m) != grp) continue;
    const gboolean inv = _instance_inverted(m);
    g_ptr_array_add(users, m);
    g_array_append_val(inverts, inv);
  }
  _combined_adopt(grp);
  g_list_free_full(grp->points, free);
  grp->points = NULL;

  // range components are not shapes: they multiply into them
  JsonArray *ranges = json_array_new();
  gboolean ok = TRUE;
  guint drawn = 0;
  // a shape taking away before any adds takes from the whole image, as it
  // does when only ranges come first; darktable's group starts from its
  // first shape, so the whole frame goes in as that
  for(guint k = 0; shapes && k < json_array_get_length(shapes); k++)
  {
    JsonObject *o = json_array_get_object_element(shapes, k);
    const char *type = json_object_get_string_member_with_default(o, "type", "");
    if(_is_range(type)) continue;
    if(!g_strcmp0(json_object_get_string_member_with_default(o, "mode", "add"), "subtract"))
    {
      _base_shape(grp, name);
      drawn++;
    }
    break;
  }
  for(guint k = 0; ok && shapes && k < json_array_get_length(shapes); k++)
  {
    JsonObject *o = json_array_get_object_element(shapes, k);
    const char *type = json_object_get_string_member_with_default(o, "type", "");
    if(_is_range(type))
    {
      json_array_add_object_element(ranges, json_object_ref(o));
      continue;
    }
    if(!g_strcmp0(type, "object"))
    {
      ok = _object_shapes(grp, o, name, k, drawn == 0, err);
      drawn++;
      continue;
    }
    dt_masks_form_t *f = _shape(o, err);
    if(!f)
    {
      ok = FALSE;
      break;
    }
    g_snprintf(f->name, sizeof(f->name), "%s%s #%u", _MASK_PREFIX, name, k + 1);
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    dt_masks_point_group_t *pt = calloc(1, sizeof(dt_masks_point_group_t));
    pt->formid = f->formid;
    pt->parentid = grp->formid;
    pt->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    if(drawn++ > 0)
      pt->state |= !g_strcmp0(json_object_get_string_member_with_default(o, "mode", "add"), "subtract")
        ? DT_MASKS_STATE_DIFFERENCE : DT_MASKS_STATE_UNION;
    pt->opacity = json_object_get_double_member_with_default(o, "opacity", 1.0);
    pt->group_opacity = 1.0f;
    grp->points = g_list_append(grp->points, pt);
  }

  // the shapes as a classic group lists them, folded as darktable converts
  // one: where the operator changes, what comes before becomes a group of
  // its own (dt_masks_group_mark_classic_runs)
  dt_masks_group_mark_classic_runs(&_s.dev.forms, grp, NULL);
  if(!dt_masks_group_marker(grp)) grp->points = g_list_prepend(grp->points, dt_masks_marker_new(_s.dev.forms, grp, 0));
  _store_recipes(grp, shapes);
  _set_ranges_group(grp, ranges);
  json_array_unref(ranges);

  // the instances using it take the new shapes and ranges into their history
  for(guint i = 0; i < users->len; i++)
    _apply_ranges(g_ptr_array_index(users, i), grp, g_array_index(inverts, gboolean, i));
  _free_unreached(old);
  for(guint i = 0; i < users->len; i++)
  {
    dt_iop_module_t *m = g_ptr_array_index(users, i);
    dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    // a piece's cache hash takes its mask's shapes from darktable.develop
    // (imageop.c, dt_iop_commit_params), which is not this engine's
    // develop, so a reshaped mask would be served the old render
    masks_invalidate_from(m->iop_order, "mask ");
  }
  g_ptr_array_free(users, TRUE);
  g_array_free(inverts, TRUE);
  _combined_member_changed(grp, FALSE);
  session_changed(DT_DEV_PIPE_SYNCH);
  return ok;
}

// a combined mask's members holding an empty mask are disabled: classic's
// group folded an empty one as nothing, where a flexi group would take it
// as the whole image (masks/group.c). TRUE when that changed
static gboolean _combined_sync(dt_masks_form_t *grp)
{
  gboolean changed = FALSE;
  for(GList *p = grp->points; p; p = g_list_next(p))
  {
    dt_masks_point_group_t *pt = p->data;
    const dt_masks_form_t *f = dt_masks_point_is_marker(pt) ? NULL : dt_masks_get_from_id(&_s.dev, pt->formid);
    if(!_is_root(f)) continue;
    const int state = _has_members(f) ? pt->state & ~DT_MASKS_STATE_DISABLE : pt->state | DT_MASKS_STATE_DISABLE;
    changed |= state != pt->state;
    pt->state = state;
  }
  return changed;
}

// whether a combined mask has a member to fold
static gboolean _combined_live(const dt_masks_form_t *grp)
{
  for(const GList *p = grp->points; p; p = g_list_next(p))
  {
    const dt_masks_point_group_t *pt = p->data;
    if(!dt_masks_point_is_marker(pt) && !(pt->state & DT_MASKS_STATE_DISABLE)) return TRUE;
  }
  return FALSE;
}

// the instances combined mask `grp` drives, after its members changed:
// with `record`, into history (the group's new members with them), after
// the forms in `old` nothing uses any more go (_free_unreached). with no
// members left they are switched off, since a group without any lets them
// work on the whole image. their cachelines go: all those after
// the first instance of each one's module, not just from the instance on,
// because a new mask's instance, put after the anchor or (denoise) after
// that first instance, moves them later, and a line left at an old
// iop_order has the same hash (neither the members nor the position are in
// it). the first instance's own line stays; for color balance rgb that is
// the anchor
static void _combined_refresh(dt_masks_form_t *grp, const gboolean record, GHashTable *old)
{
  const gboolean live = _combined_live(grp);
  int order = INT_MAX;
  GPtrArray *users = g_ptr_array_new();
  GArray *write = g_array_new(FALSE, FALSE, sizeof(gboolean));
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(_instance_group(m) != grp) continue;
    const dt_iop_module_t *first = dt_iop_get_module_by_op_priority(_s.dev.iop, m->op, 0);
    order = MIN(order, first && first != m ? first->iop_order + 1 : m->iop_order);
    const gboolean off = !live && m->enabled;
    if(off) m->enabled = FALSE;
    if(record) _apply_ranges(m, grp, FALSE);
    const gboolean w = off || record;
    g_ptr_array_add(users, m);
    g_array_append_val(write, w);
  }
  if(old) _free_unreached(old);
  for(guint i = 0; i < users->len; i++)
  {
    dt_iop_module_t *m = g_ptr_array_index(users, i);
    if(g_array_index(write, gboolean, i)) dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  }
  g_ptr_array_free(users, TRUE);
  g_array_free(write, TRUE);
  if(order != INT_MAX) masks_invalidate_from(order, "combine ");
}

// mask `root` reshaped, or with `removed` deleted: the combined masks
// holding it let go of it, and their instances render again. a reshape
// needs no history of their own, the mask's own instances carry the
// shapes, unless it left a member empty or filled one (_combined_sync)
static void _combined_member_changed(const dt_masks_form_t *root, const gboolean removed)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *grp = l->data;
    if(!(grp->type & DT_MASKS_GROUP) || !g_str_has_prefix(grp->name, _COMBINED_PREFIX)) continue;
    gboolean held = FALSE;
    for(GList *p = grp->points; p;)
    {
      GList *next = g_list_next(p);
      dt_masks_point_group_t *pt = p->data;
      if(_holds_mask(pt, root))
      {
        held = TRUE;
        if(removed)
        {
          grp->points = g_list_delete_link(grp->points, p);
          free(pt);
        }
      }
      p = next;
    }
    if(!held) continue;
    const gboolean changed = _combined_sync(grp);
    _combined_refresh(grp, removed || changed, NULL);
  }
}

// replace combined mask `name`'s members (made when missing): each
// {mask, opacity 0-1, invert}. the members are the masks' own groups, which
// stay theirs; only the references go. `ranges`, the range components the
// members all have, multiply into the sum (_set_ranges_group)
static gboolean _combine(const char *name, JsonArray *members, JsonArray *ranges, char **err)
{
  for(guint k = 0; members && k < json_array_get_length(members); k++)
  {
    JsonObject *o = json_array_get_object_element(members, k);
    const char *mask = json_object_get_string_member_with_default(o, "mask", NULL);
    if(!mask || !_mask_group(mask))
    {
      *err = g_strdup_printf("no mask '%s'", mask ? mask : "(none)");
      return FALSE;
    }
  }
  dt_masks_form_t *grp = _combined_group(name);
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_snprintf(grp->name, sizeof(grp->name), "%s%s", _COMBINED_PREFIX, name);
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  GHashTable *old = _mask_forms(grp);
  g_hash_table_remove(old, grp);
  g_list_free_full(grp->points, free);
  grp->points = NULL; // as in _set_ranges_group(), before the marker's id is chosen
  // the first member goes onto the fold's empty start, and the rest add to
  // it, up to 1 (masks/group.c)
  grp->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, grp, DT_MASKS_STATE_FLEXI_SUM));
  for(guint k = 0; members && k < json_array_get_length(members); k++)
  {
    JsonObject *o = json_array_get_object_element(members, k);
    const dt_masks_form_t *mg = _mask_group(json_object_get_string_member(o, "mask"));
    int state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    if(json_object_get_boolean_member_with_default(o, "invert", FALSE)) state |= DT_MASKS_STATE_INVERSE;
    _member(grp, mg->formid, state, CLAMP(json_object_get_double_member_with_default(o, "opacity", 1.0), 0.0, 1.0));
  }
  _combined_sync(grp);
  _set_ranges_group(grp, ranges);
  _combined_refresh(grp, TRUE, old);
  session_changed(DT_DEV_PIPE_SYNCH);
  return TRUE;
}

// the reverse of _to_input(): an input point as a point of the shown image
static void _to_shown(const float ix, const float iy, float *x, float *y)
{
  float p[2] = { ix * _s.pipe.iwidth, iy * _s.pipe.iheight };
  dt_dev_distort_transform_plus(&_s.dev, &_s.pipe, 0, DT_DEV_TRANSFORM_DIR_ALL, p, 1);
  *x = p[0] / _s.pipe.processed_width;
  *y = p[1] / _s.pipe.processed_height;
}

// an input vector at an input point, as length (in shown pixels) and angle
// (degrees, clockwise) in the shown image
static void _to_shown_vec(const float ix, const float iy, const float dx, const float dy,
                          float *len, float *angle)
{
  float ax, ay, bx, by;
  _to_shown(ix, iy, &ax, &ay);
  _to_shown(ix + dx / _s.pipe.iwidth, iy + dy / _s.pipe.iheight, &bx, &by);
  const float vx = (bx - ax) * _s.pipe.processed_width, vy = (by - ay) * _s.pipe.processed_height;
  *len = hypotf(vx, vy);
  *angle = atan2f(vy, vx) * 180.0f / M_PI;
}

void masks_add_num(JsonBuilder *b, const char *name, const double v)
{
  json_builder_set_member_name(b, name);
  json_builder_add_double_value(b, v);
}

// one shape as _shape() takes it
static void _shape_json(JsonBuilder *b, const dt_masks_form_t *f, const gboolean subtract)
{
  const float pw = _s.pipe.processed_width;
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "mode");
  json_builder_add_string_value(b, subtract ? "subtract" : "add");
  float x, y, len, ang;
  if((f->type & DT_MASKS_ELLIPSE) && f->points)
  {
    const dt_masks_point_ellipse_t *e = f->points->data;
    const float k = e->flags & DT_MASKS_ELLIPSE_PROPORTIONAL ? 1.0f + e->border
      : 1.0f + e->border / fmaxf(1e-6f, fminf(e->radius[0], e->radius[1]));
    const float r = e->rotation * M_PI / 180.0f;
    _to_shown(e->center[0], e->center[1], &x, &y);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "ellipse");
    masks_add_num(b, "x", x);
    masks_add_num(b, "y", y);
    _to_shown_vec(e->center[0], e->center[1], e->radius[0] * imin * cosf(r), e->radius[0] * imin * sinf(r), &len, &ang);
    masks_add_num(b, "rx", len * k / pw);
    masks_add_num(b, "angle", ang);
    _to_shown_vec(e->center[0], e->center[1], -e->radius[1] * imin * sinf(r), e->radius[1] * imin * cosf(r), &len, &ang);
    masks_add_num(b, "ry", len * k / pw);
    masks_add_num(b, "feather", 1.0f - 1.0f / k);
  }
  else if((f->type & DT_MASKS_GRADIENT) && f->points)
  {
    const dt_masks_point_gradient_t *g = f->points->data;
    const float a = (90.0f - g->rotation) * M_PI / 180.0f;
    _to_shown(g->anchor[0], g->anchor[1], &x, &y);
    _to_shown_vec(g->anchor[0], g->anchor[1], cosf(a) * 10.0f, sinf(a) * 10.0f, &len, &ang);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "gradient");
    masks_add_num(b, "x", x);
    masks_add_num(b, "y", y);
    masks_add_num(b, "angle", ang);
    masks_add_num(b, "width", g->compression * 2.0f * hypotf(_s.pipe.iwidth, _s.pipe.iheight)
                         / hypotf(pw, _s.pipe.processed_height));
  }
  else if((f->type & DT_MASKS_BRUSH) && f->points)
  {
    const dt_masks_point_brush_t *p0 = f->points->data;
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "brush");
    _to_shown_vec(p0->corner[0], p0->corner[1], p0->border[0] * imin, 0.0f, &len, &ang);
    masks_add_num(b, "size", 2.0f * len / pw);
    masks_add_num(b, "hardness", p0->hardness);
    masks_add_num(b, "density", p0->density);
    json_builder_set_member_name(b, "points");
    json_builder_begin_array(b);
    for(const GList *l = f->points; l; l = g_list_next(l))
    {
      const dt_masks_point_brush_t *pt = l->data;
      _to_shown(pt->corner[0], pt->corner[1], &x, &y);
      json_builder_begin_array(b);
      json_builder_add_double_value(b, x);
      json_builder_add_double_value(b, y);
      json_builder_end_array(b);
    }
    json_builder_end_array(b);
  }
  json_builder_end_object(b);
}

// ------------------------------------------------------------ heal and clone
// Lightroom's Heal and Clone spots, as darktable's retouch module keeps
// them: shapes in the module's mask group, each with its source (where it
// copies from) in the shape, and its algorithm in the module's rt_forms.
// the client edits heal and clone on the whole image; what else an edit
// made in darktable holds (blur, fill, wavelet scales) is left as it was
#define _SPOTS_GROUP "immage spots"

// the retouch module's mask group, or one of ours not yet attached
static dt_masks_form_t *_spots_group(const dt_iop_module_t *m)
{
  dt_masks_form_t *grp = m->blend_params ? dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id) : NULL;
  if(grp && (grp->type & DT_MASKS_GROUP)) return grp;
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if((f->type & DT_MASKS_GROUP) && !g_strcmp0(f->name, _SPOTS_GROUP))
      return f;
  }
  return NULL;
}

// rt_forms in the module's params: where it starts, its elements' size and
// their number, from introspection, as the struct is private to retouch.c
static uint8_t *_rt_forms(dt_iop_module_t *m, size_t *size, size_t *count)
{
  dt_introspection_field_t *f = m->so->have_introspection ? m->get_f("rt_forms") : NULL;
  if(!f || f->header.type != DT_INTROSPECTION_TYPE_ARRAY) return NULL;
  *count = f->Array.count;
  *size = f->Array.field->header.size;
  return (uint8_t *)m->params + f->header.offset;
}

// the rt_forms index of a shape, -1 when it has none; with `ours`, whether
// it is a spot the client edits: heal or clone, on the whole image
static int _rt_index(dt_iop_module_t *m, const size_t count, const dt_mask_id_t formid, gboolean *ours,
                     char **err)
{
  gchar field[64];
  for(size_t k = 0; k < count; k++)
  {
    double id = 0, algo = 0, scale = 0;
    g_snprintf(field, sizeof(field), "rt_forms[%zu].formid", k);
    if(!_read_field(m, field, FALSE, &id, err)) return -1;
    if((int)id != formid) continue;
    g_snprintf(field, sizeof(field), "rt_forms[%zu].algorithm", k);
    if(!_read_field(m, field, FALSE, &algo, err)) return -1;
    g_snprintf(field, sizeof(field), "rt_forms[%zu].scale", k);
    if(!_read_field(m, field, FALSE, &scale, err)) return -1;
    // retouch's algorithm enum: clone 1, heal 2
    *ours = (algo == 1 || algo == 2) && scale == 0;
    return k;
  }
  return -1;
}

// one spot from the client, in shown-image units:
//   circle: x, y, r (radius, a fraction of the shown width)
//   brush:  points [[x, y], ...], size (diameter, a fraction of the width)
// both: sx, sy (where the center, or the first point, copies from),
// feather (0-1)
static dt_masks_form_t *_spot_shape(JsonObject *o, char **err)
{
  const char *type = json_object_get_string_member_with_default(o, "type", "circle");
  const float feather = CLAMP(json_object_get_double_member_with_default(o, "feather", 0.5), 0.0, 0.95);
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);
  const float sx = json_object_get_double_member_with_default(o, "sx", 0.5);
  const float sy = json_object_get_double_member_with_default(o, "sy", 0.5);
  dt_masks_form_t *f = NULL;
  if(!g_strcmp0(type, "brush"))
  {
    JsonArray *pts = json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
    const guint n = pts ? json_array_get_length(pts) : 0;
    if(n < 2)
    {
      *err = g_strdup("a brush spot needs two points or more");
      return NULL;
    }
    JsonArray *p0 = json_array_get_array_element(pts, 0);
    float len, ang;
    _to_input_vec(json_array_get_double_element(p0, 0), json_array_get_double_element(p0, 1),
                  json_object_get_double_member_with_default(o, "size", 0.05) / 2.0f, 0.0f, &len, &ang);
    const float border = MAX(0.0005f, len / imin);
    f = dt_masks_create(DT_MASKS_BRUSH | DT_MASKS_CLONE);
    for(guint k = 0; k < n; k++)
    {
      JsonArray *p = json_array_get_array_element(pts, k);
      dt_masks_point_brush_t *b = calloc(1, sizeof(dt_masks_point_brush_t));
      _to_input(json_array_get_double_element(p, 0), json_array_get_double_element(p, 1),
                &b->corner[0], &b->corner[1]);
      b->ctrl1[0] = b->ctrl2[0] = b->corner[0];
      b->ctrl1[1] = b->ctrl2[1] = b->corner[1];
      b->border[0] = b->border[1] = border;
      b->hardness = 1.0f - feather;
      b->density = 1.0f;
      b->state = DT_MASKS_POINT_STATE_NORMAL;
      f->points = g_list_append(f->points, b);
    }
  }
  else
  {
    const float x = json_object_get_double_member_with_default(o, "x", 0.5);
    const float y = json_object_get_double_member_with_default(o, "y", 0.5);
    float len, ang;
    _to_input_vec(x, y, json_object_get_double_member_with_default(o, "r", 0.02), 0.0f, &len, &ang);
    f = dt_masks_create(DT_MASKS_CIRCLE | DT_MASKS_CLONE);
    dt_masks_point_circle_t *c = calloc(1, sizeof(dt_masks_point_circle_t));
    _to_input(x, y, &c->center[0], &c->center[1]);
    // feathered inward, as Lightroom's: darktable's border lies outside
    c->radius = MAX(0.001f, len * (1.0f - feather) / imin);
    c->border = MAX(0.001f, len * feather / imin);
    f->points = g_list_append(f->points, c);
  }
  _to_input(sx, sy, &f->source[0], &f->source[1]);
  return f;
}

static gboolean _spots_set(JsonArray *spots, char **err)
{
  dt_iop_module_t *m = session_module("retouch", err);
  if(!m) return FALSE;
  size_t esize = 0, count = 0;
  uint8_t *rt = _rt_forms(m, &esize, &count);
  if(!rt)
  {
    *err = g_strdup("retouch has no rt_forms");
    return FALSE;
  }
  dt_masks_form_t *grp = _spots_group(m);
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_strlcpy(grp->name, _SPOTS_GROUP, sizeof(grp->name));
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  // the spots the client edits go, to be made again; the others stay, in
  // their order, their rt_forms entries kept whole
  uint8_t *kept = g_malloc0(esize * count);
  size_t nk = 0;
  GList *keep = NULL;
  for(GList *l = grp->points; l; l = g_list_next(l))
  {
    dt_masks_point_group_t *gp = l->data;
    dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, gp->formid);
    gboolean ours = TRUE;
    const int k = f ? _rt_index(m, count, gp->formid, &ours, err) : -1;
    // darktable's ellipse and path spots are not the client's to edit
    ours = ours && f && (f->type & (DT_MASKS_CIRCLE | DT_MASKS_BRUSH));
    if(*err)
    {
      g_free(kept);
      g_list_free(keep);
      return FALSE;
    }
    if(k >= 0 && !ours && nk < count)
    {
      memcpy(kept + nk++ * esize, rt + k * esize, esize);
      keep = g_list_append(keep, gp);
      continue;
    }
    if(f)
    {
      _s.dev.forms = g_list_remove(_s.dev.forms, f);
      dt_masks_free_form(f);
    }
    free(gp);
  }
  g_list_free(grp->points);
  grp->points = keep;
  memset(rt, 0, esize * count);
  memcpy(rt, kept, esize * nk);
  g_free(kept);

  const guint n = MIN(json_array_get_length(spots), count - nk);
  for(guint k = 0; k < n; k++)
  {
    JsonObject *o = json_array_get_object_element(spots, k);
    dt_masks_form_t *f = _spot_shape(o, err);
    if(!f) return FALSE;
    g_snprintf(f->name, sizeof(f->name), "immage spot #%u", k + 1);
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
    gp->formid = f->formid;
    gp->parentid = grp->formid;
    gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    if(grp->points) gp->state |= DT_MASKS_STATE_UNION;
    gp->opacity = CLAMP(json_object_get_double_member_with_default(o, "opacity", 1.0), 0.0, 1.0);
    grp->points = g_list_append(grp->points, gp);
    const gboolean clone = !g_strcmp0(json_object_get_string_member_with_default(o, "mode", "heal"), "clone");
    gchar field[64];
    // the values of retouch's algorithm enum (clone 1, heal 2)
    const struct { const char *name; double v; } fields[] = {
      { "formid", f->formid }, { "scale", 0 }, { "algorithm", clone ? 1 : 2 }, { "distort_mode", 2 },
    };
    for(int i = 0; i < 4; i++)
    {
      g_snprintf(field, sizeof(field), "rt_forms[%zu].%s", nk + k, fields[i].name);
      if(!session_write_field(m, field, fields[i].v, err)) return FALSE;
    }
  }
  m->blend_params->mask_id = grp->formid;
  m->enabled = grp->points != NULL;
  dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  // the piece's cache hash misses the shapes, as a mask's does (see _mask())
  dt_dev_pixelpipe_cache_invalidate_later(&_s.pipe, m->iop_order, "spots ");
  if(_s.ppipe_ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, m->iop_order, "spots ");
  if(_s.drag.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.drag.pipe, m->iop_order, "spots ");
  if(_s.base.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.base.pipe, m->iop_order, "spots ");
  session_changed(DT_DEV_PIPE_SYNCH);
  return TRUE;
}

// the spots as _spot_shape() takes them, and whether the module is on
static gboolean _spots_json(JsonBuilder *b, char **err)
{
  dt_iop_module_t *m = session_module("retouch", err);
  if(!m) return FALSE;
  size_t esize = 0, count = 0;
  if(!_rt_forms(m, &esize, &count))
  {
    *err = g_strdup("retouch has no rt_forms");
    return FALSE;
  }
  const dt_masks_form_t *grp = m->blend_params ? dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id) : NULL;
  const float pw = _s.pipe.processed_width;
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);
  json_builder_set_member_name(b, "enabled");
  json_builder_add_boolean_value(b, m->enabled);
  json_builder_set_member_name(b, "spots");
  json_builder_begin_array(b);
  for(const GList *l = grp && (grp->type & DT_MASKS_GROUP) ? grp->points : NULL; l; l = g_list_next(l))
  {
    const dt_masks_point_group_t *gp = l->data;
    const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, gp->formid);
    if(!f || !f->points || !(f->type & (DT_MASKS_CIRCLE | DT_MASKS_BRUSH))) continue;
    // darktable's own spots too, those _spots_set() would remake
    gboolean ours = FALSE;
    const int k = _rt_index(m, count, f->formid, &ours, err);
    if(*err) return FALSE;
    if(k < 0 || !ours) continue;
    double algo = 0;
    gchar field[64];
    g_snprintf(field, sizeof(field), "rt_forms[%d].algorithm", k);
    if(!_read_field(m, field, FALSE, &algo, err)) return FALSE;
    float x, y, len, ang;
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "mode");
    json_builder_add_string_value(b, algo == 1 ? "clone" : "heal");
    masks_add_num(b, "opacity", gp->opacity);
    _to_shown(f->source[0], f->source[1], &x, &y);
    masks_add_num(b, "sx", x);
    masks_add_num(b, "sy", y);
    if(f->type & DT_MASKS_CIRCLE)
    {
      const dt_masks_point_circle_t *c = f->points->data;
      const float r = c->radius + c->border;
      _to_shown(c->center[0], c->center[1], &x, &y);
      json_builder_set_member_name(b, "type");
      json_builder_add_string_value(b, "circle");
      masks_add_num(b, "x", x);
      masks_add_num(b, "y", y);
      _to_shown_vec(c->center[0], c->center[1], r * imin, 0.0f, &len, &ang);
      masks_add_num(b, "r", len / pw);
      masks_add_num(b, "feather", c->border / fmaxf(r, 1e-6f));
    }
    else if(f->type & DT_MASKS_BRUSH)
    {
      const dt_masks_point_brush_t *p0 = f->points->data;
      json_builder_set_member_name(b, "type");
      json_builder_add_string_value(b, "brush");
      _to_shown_vec(p0->corner[0], p0->corner[1], p0->border[0] * imin, 0.0f, &len, &ang);
      masks_add_num(b, "size", 2.0f * len / pw);
      masks_add_num(b, "feather", 1.0f - p0->hardness);
      json_builder_set_member_name(b, "points");
      json_builder_begin_array(b);
      for(const GList *q = f->points; q; q = g_list_next(q))
      {
        const dt_masks_point_brush_t *pt = q->data;
        _to_shown(pt->corner[0], pt->corner[1], &x, &y);
        json_builder_begin_array(b);
        json_builder_add_double_value(b, x);
        json_builder_add_double_value(b, y);
        json_builder_end_array(b);
      }
      json_builder_end_array(b);
    }
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

// the retouch module off and on again, shapes kept (the Before view)
static gboolean _spots_enable(const gboolean on, char **err)
{
  dt_iop_module_t *m = session_module("retouch", err);
  if(!m) return FALSE;
  const dt_masks_form_t *grp = _spots_group(m);
  const gboolean want = on && grp && grp->points;
  if(m->enabled == want) return TRUE;
  m->enabled = want;
  dt_dev_add_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  session_changed(DT_DEV_PIPE_TOP_CHANGED);
  return TRUE;
}

// where a new spot should copy from, as Lightroom picks it: the nearby
// place whose surroundings look most like the spot's own, which are
// untouched. measured on a small render, gray, over a ring just outside
// the spot, the spot itself kept clear of its source
static gboolean _spot_source(JsonObject *o, JsonBuilder *b, char **err)
{
  int W = 0, H = 0;
  uint8_t *rgb = ai_shown_rgb(768, FALSE, &W, &H, err);
  if(!rgb) return FALSE;
  const size_t n = (size_t)W * H;
  float *gray = g_malloc(n * sizeof(float));
  for(size_t k = 0; k < n; k++)
    gray[k] = 0.299f * rgb[3 * k] + 0.587f * rgb[3 * k + 1] + 0.114f * rgb[3 * k + 2];
  g_free(rgb);

  // the spot as a polyline (one point for a circle) and a radius, in pixels
  const char *type = json_object_get_string_member_with_default(o, "type", "circle");
  const gboolean brush = !g_strcmp0(type, "brush");
  JsonArray *pts = brush && json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
  const guint np = pts ? MAX(1, json_array_get_length(pts)) : 1;
  float *line = g_malloc(2 * np * sizeof(float));
  for(guint k = 0; k < np; k++)
  {
    JsonArray *p = pts ? json_array_get_array_element(pts, k) : NULL;
    line[2 * k] = (p ? json_array_get_double_element(p, 0) : json_object_get_double_member_with_default(o, "x", 0.5)) * W;
    line[2 * k + 1] = (p ? json_array_get_double_element(p, 1) : json_object_get_double_member_with_default(o, "y", 0.5)) * H;
  }
  const float r = MAX(2.0f, (brush ? json_object_get_double_member_with_default(o, "size", 0.05) / 2.0f
                                   : json_object_get_double_member_with_default(o, "r", 0.02)) * W);
  float x0 = W, y0 = H, x1 = 0, y1 = 0;
  for(guint k = 0; k < np; k++)
  {
    x0 = fminf(x0, line[2 * k]); x1 = fmaxf(x1, line[2 * k]);
    y0 = fminf(y0, line[2 * k + 1]); y1 = fmaxf(y1, line[2 * k + 1]);
  }
  // the ring's pixels: between r and 1.6 r from the spot, at most a few
  // thousand of them, evenly picked
  const float ring = 1.6f * r;
  GArray *ringpx = g_array_new(FALSE, FALSE, sizeof(int) * 2);
  for(int y = MAX(0, (int)(y0 - ring)); y <= MIN(H - 1, (int)(y1 + ring)); y++)
    for(int x = MAX(0, (int)(x0 - ring)); x <= MIN(W - 1, (int)(x1 + ring)); x++)
    {
      float best = INFINITY;
      for(guint k = 0; k < np; k++)
      {
        const float ax = line[2 * k], ay = line[2 * k + 1];
        const float bx = line[2 * MIN(k + 1, np - 1)], by = line[2 * MIN(k + 1, np - 1) + 1];
        const float lx = bx - ax, ly = by - ay, l2 = lx * lx + ly * ly;
        const float t = l2 > 0.0f ? CLAMP(((x - ax) * lx + (y - ay) * ly) / l2, 0.0f, 1.0f) : 0.0f;
        best = fminf(best, hypotf(x - (ax + t * lx), y - (ay + t * ly)));
      }
      if(best > r && best <= ring)
      {
        const int xy[2] = { x, y };
        g_array_append_val(ringpx, xy);
      }
    }
  const float fx = line[0], fy = line[1];
  g_free(line);
  const guint nr = ringpx->len, step = MAX(1, nr / 3000);

  // candidates on a grid around the spot, far enough that the source
  // keeps clear of it, near enough to share its light
  const float extent = fmaxf(x1 - x0, y1 - y0) + 2.0f * r;
  const float reach = fmaxf(3.0f * extent, 0.12f * MAX(W, H));
  const float grid = fmaxf(1.0f, r / 2.0f);
  float best = INFINITY, bdx = extent, bdy = 0.0f;
  for(float dy = -reach; dy <= reach; dy += grid)
    for(float dx = -reach; dx <= reach; dx += grid)
    {
      if(fabsf(dx) < extent && fabsf(dy) < extent) continue;
      const float d = hypotf(dx, dy);
      if(d > reach || x0 - r + dx < 0 || y0 - r + dy < 0 || x1 + r + dx >= W || y1 + r + dy >= H) continue;
      double ssd = 0.0;
      int cnt = 0;
      for(guint k = 0; k < nr; k += step)
      {
        const int *xy = &g_array_index(ringpx, int, 2 * k);
        const int sx = xy[0] + (int)dx, sy = xy[1] + (int)dy;
        if(sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const float e = gray[(size_t)xy[1] * W + xy[0]] - gray[(size_t)sy * W + sx];
        ssd += e * e;
        cnt++;
      }
      if(!cnt) continue;
      // a little for distance, so of two alike the nearer wins
      const float score = ssd / cnt * (1.0f + 0.5f * d / reach);
      if(score < best)
      {
        best = score;
        bdx = dx;
        bdy = dy;
      }
    }
  g_array_free(ringpx, TRUE);
  g_free(gray);
  masks_add_num(b, "sx", (fx + bdx) / W);
  masks_add_num(b, "sy", (fy + bdy) / H);
  return TRUE;
}

// a mask's instances are named after it, or after it and "#tag" for a
// second instance of one module (diffuse serves Texture and Sharpening).
// the tag, "" for none, when `m` is one of them, else NULL
static const char *_mask_instance_tag(const dt_iop_module_t *m, const char *name)
{
  const size_t n = strlen(name);
  if(!m->multi_name_hand_edited || strncmp(m->multi_name, name, n)) return NULL;
  if(!m->multi_name[n]) return "";
  return m->multi_name[n] == '#' ? m->multi_name + n + 1 : NULL;
}

// a path of an object component as _object_paths() takes it
static void _object_path_json(JsonBuilder *b, const dt_masks_form_t *f, const gboolean hole)
{
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "hole");
  json_builder_add_boolean_value(b, hole);
  json_builder_set_member_name(b, "points");
  json_builder_begin_array(b);
  for(const GList *q = f->points; q; q = g_list_next(q))
  {
    const dt_masks_point_path_t *pp = q->data;
    float c[6];
    _to_shown(pp->corner[0], pp->corner[1], &c[0], &c[1]);
    _to_shown(pp->ctrl1[0], pp->ctrl1[1], &c[2], &c[3]);
    _to_shown(pp->ctrl2[0], pp->ctrl2[1], &c[4], &c[5]);
    json_builder_begin_array(b);
    for(int j = 0; j < 6; j++) json_builder_add_double_value(b, c[j]);
    json_builder_end_array(b);
  }
  json_builder_end_array(b);
  json_builder_end_object(b);
}

// a run of an object component's paths read back, into `*run`
static void _object_run_close(JsonBuilder *b, const char *member, JsonBuilder **run)
{
  if(!*run) return;
  json_builder_end_array(*run);
  json_builder_set_member_name(b, member);
  json_builder_add_value(b, json_builder_get_root(*run));
  g_object_unref(*run);
  *run = NULL;
}

// the end of an object component read back: its paths, then its backdrop
// from the edge paths in `*edge`, the plain ones in `*plain` and the
// backdrop shape `bd`, if it had them
static void _object_close(JsonBuilder *b, JsonBuilder **edge, JsonBuilder **plain, const dt_masks_form_t *bd)
{
  json_builder_end_array(b);
  if(*edge && bd && bd->points)
  {
    const dt_masks_point_parametric_t *pp = bd->points->data;
    const int ch = DEVELOP_BLENDIF_hz_in;
    json_builder_set_member_name(b, "backdrop");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "range");
    json_builder_begin_array(b);
    for(int i = 0; i < 4; i++)
      json_builder_add_double_value(b, (double)pp->blendif_parameters[4 * ch + i] * exp2(pp->blendif_boost_factors[ch]));
    json_builder_end_array(b);
    _object_run_close(b, "paths", edge);
    _object_run_close(b, "plain", plain);
    json_builder_set_member_name(b, "off");
    json_builder_add_boolean_value(b, g_str_has_suffix(bd->name, "~off"));
    json_builder_end_object(b);
  }
  json_builder_end_object(b);
  if(*edge) g_object_unref(*edge);
  if(*plain) g_object_unref(*plain);
  *edge = *plain = NULL;
}

// a mask's shape read back: its form, whether it takes away, and whether
// it is kept switched off (_object_shapes)
typedef struct _flat_t
{
  const dt_masks_form_t *f;
  gboolean subtract, off;
} _flat_t;

// the shapes of mask tree `grp` in the order a classic group lists them,
// each adding or taking away (`sub` for the first), the reverse of
// dt_masks_group_mark_classic_runs, which nests what comes before an
// operator's run as its first member. its parametric channels, which
// multiply into the shapes, go to `chans`. an older edit's tree, as
// darktable converted it, reads the same way
static void _flatten(const dt_masks_form_t *grp, const gboolean sub, GArray *shapes, GPtrArray *chans,
                     const int depth)
{
  if(depth > DT_MASKS_NESTING_MAX) return;
  const dt_masks_point_group_t *mk = dt_masks_group_marker(grp);
  const gboolean difference = mk && (mk->state & DT_MASKS_STATE_FLEXI_DIFFERENCE);
  gboolean first = TRUE;
  for(const GList *l = grp->points; l; l = g_list_next(l))
  {
    const dt_masks_point_group_t *pt = l->data;
    if(dt_masks_point_is_marker(pt)) continue;
    const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, pt->formid);
    if(!f) continue;
    const gboolean off = (pt->state & (DT_MASKS_STATE_DISABLE | DT_MASKS_STATE_HIDDEN)) != 0;
    if((f->type & DT_MASKS_PARAMETRIC) && !_is_backdrop_shape(f))
    {
      if(!off) g_ptr_array_add(chans, (gpointer)f);
      continue;
    }
    // a classic group, which a conversion leaves nested in another, keeps
    // the operator on each member
    const gboolean s = first ? sub
                     : mk ? difference : (pt->state & DT_MASKS_STATE_DIFFERENCE) != 0;
    if(f->type & DT_MASKS_GROUP)
      _flatten(f, s, shapes, chans, depth + 1);
    else
    {
      const _flat_t e = { f, s, off };
      g_array_append_val(shapes, e);
    }
    if(!off) first = FALSE;
  }
}

static void _read_recipe(JsonBuilder *b, const dt_masks_form_t *grp, const guint component)
{
  GHashTable *forms = _mask_forms(grp);
  GString *encoded = g_string_new(NULL);
  for(guint chunk = 0; chunk < 4096; chunk++)
  {
    gchar prefix[64];
    g_snprintf(prefix, sizeof(prefix), _AI_RECIPE "%u:%u:", component, chunk);
    GHashTableIter it; gpointer key; const char *part = NULL;
    g_hash_table_iter_init(&it, forms);
    while(g_hash_table_iter_next(&it, &key, NULL))
    {
      const dt_masks_form_t *f = key;
      if(g_str_has_prefix(f->name, prefix)) { part = f->name + strlen(prefix); break; }
    }
    if(!part) break;
    g_string_append(encoded, part);
  }
  if(encoded->len)
  {
    gsize size; guchar *json = g_base64_decode(encoded->str, &size);
    gchar *terminated = g_strndup((const gchar *)json, size);
    JsonNode *node = json_from_string(terminated, NULL);
    if(node && JSON_NODE_HOLDS_OBJECT(node))
    {
      _recipe_coordinates(json_node_get_object(node), _to_shown);
      json_builder_set_member_name(b, "ai"); json_builder_add_value(b, node);
    }
    else if(node) json_node_free(node);
    g_free(terminated); g_free(json);
  }
  g_string_free(encoded, TRUE); g_hash_table_destroy(forms);
}

// the tree mask `grp` is read from: its ranges group, or in an older edit
// an instance's tree of its own, one blending in scene-referred RGB first
// (the others have no ranges), else its group
static const dt_masks_form_t *_mask_tree(const dt_masks_form_t *grp)
{
  const dt_masks_form_t *ranged = _ranges_group(grp);
  if(ranged) return ranged;
  const dt_masks_form_t *best = grp;
  int rank = 0;
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(_instance_group(m) != grp) continue;
    const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id);
    if(!f || !(f->type & DT_MASKS_GROUP) || f == grp) continue;
    const int r = 1 + 2 * (m->blend_params->blend_cst == DEVELOP_BLEND_CS_RGB_SCENE) + m->enabled;
    if(r > rank)
    {
      rank = r;
      best = f;
    }
  }
  return best;
}

// parametric channels `chans` as the range components they make
static void _channels_json(JsonBuilder *b, const GPtrArray *chans)
{
  dt_develop_blend_params_t bp = { 0 };
  bp.blend_cst = DEVELOP_BLEND_CS_RGB_SCENE;
  for(guint i = 0; i < chans->len; i++)
  {
    const dt_masks_form_t *f = g_ptr_array_index(chans, i);
    const dt_masks_point_parametric_t *p = f->points ? f->points->data : NULL;
    if(!p || p->colorspace != DEVELOP_BLEND_CS_RGB_SCENE) continue;
    const dt_iop_gui_blendif_channel_t *table = dt_develop_blendif_channels_for_csp(DEVELOP_BLEND_CS_RGB_SCENE);
    for(int slot = 0; slot < DEVELOP_BLENDIF_SIZE; slot++)
    {
      if(!(p->blendif & (1u << slot))) continue;
      if(table && (((p->disabled & 1) && table[p->channel].param_channels[0] == slot)
                   || ((p->disabled & 2) && table[p->channel].param_channels[1] == slot)))
        continue;
      bp.blendif |= (1u << slot) | (p->blendif & (1u << (slot + 16)));
      memcpy(bp.blendif_parameters + 4 * slot, p->blendif_parameters + 4 * slot, 4 * sizeof(float));
      bp.blendif_boost_factors[slot] = p->blendif_boost_factors[slot];
    }
  }
  if(bp.blendif) _ranges_json(b, &bp);
}

// every client mask: its shapes, whether it is inverted, and for each
// instance it drives, whether it is on and the asked-for fields
// ({ op: [field, ...] } in `fields`; a tagged instance is "op#tag")
static gboolean _masks(JsonObject *fields, JsonBuilder *b, char **err)
{
  json_builder_set_member_name(b, "masks");
  json_builder_begin_array(b);
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    const dt_masks_form_t *grp = l->data;
    const char *name = (grp->type & DT_MASKS_GROUP) ? _mask_name(grp->name) : NULL;
    // a second group of the name is a conversion's copy (_mask_forms)
    if(!name || _mask_group(name) != grp) continue;
    GArray *flat = g_array_new(FALSE, FALSE, sizeof(_flat_t));
    GPtrArray *chans = g_ptr_array_new();
    _flatten(_mask_tree(grp), FALSE, flat, chans, 0);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, name);
    json_builder_set_member_name(b, "shapes");
    json_builder_begin_array(b);
    // an object component is several paths in a row, named "#k.i"; with
    // a backdrop, its edge paths "#k.i~" and backdrop shape "#k~" first,
    // and its plain paths "#k.i^" last
    int open_obj = -1;
    JsonBuilder *edge = NULL, *plain = NULL;
    const dt_masks_form_t *bd = NULL;
    for(guint i = 0; i < flat->len; i++)
    {
      const _flat_t *e = &g_array_index(flat, _flat_t, i);
      const dt_masks_form_t *f = e->f;
      if(_is_base_shape(f)) continue;
      const char *hash = strrchr(f->name, '#');
      unsigned comp = 0, part = 0;
      const gboolean is_bd = _is_backdrop_shape(f) && hash && sscanf(hash + 1, "%u", &comp) == 1;
      const gboolean is_obj = is_bd
        || ((f->type & DT_MASKS_PATH) && hash && sscanf(hash + 1, "%u.%u", &comp, &part) == 2);
      if(open_obj >= 0 && (!is_obj || (int)comp != open_obj))
      {
        _object_close(b, &edge, &plain, bd);
        bd = NULL;
        open_obj = -1;
      }
      if(!is_obj)
      {
        _shape_json(b, f, e->subtract);
        continue;
      }
      if(is_bd)
      {
        bd = f;
        continue;
      }
      const gboolean hole = f->name[strlen(f->name) - 1] == '-';
      const gboolean is_edge = strchr(hash, '~') != NULL, is_plain = strchr(hash, '^') != NULL;
      if(open_obj < 0)
      {
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "type");
        json_builder_add_string_value(b, "object");
        _read_recipe(b, grp, comp);
        // the mode from its first path that is not off: darktable's
        // conversion moves one that is off into the run before it
        gboolean mode_sub = e->subtract != hole;
        for(guint j = i; j < flat->len; j++)
        {
          const _flat_t *q = &g_array_index(flat, _flat_t, j);
          const char *qh = strrchr(q->f->name, '#');
          unsigned qc = 0, qp = 0;
          if(!(q->f->type & DT_MASKS_PATH) || !qh || sscanf(qh + 1, "%u.%u", &qc, &qp) != 2 || qc != comp) continue;
          if(q->off) continue;
          mode_sub = q->subtract != (q->f->name[strlen(q->f->name) - 1] == '-');
          break;
        }
        json_builder_set_member_name(b, "mode");
        json_builder_add_string_value(b, mode_sub ? "subtract" : "add");
        const char *at = strchr(hash, '@');
        if(at)
        {
          // "@near,far,feather", as _object_shapes() wrote it
          gchar **v = g_strsplit(at + 1, ",", 3);
          if(g_strv_length(v) == 3)
          {
            json_builder_set_member_name(b, "depth");
            json_builder_begin_array(b);
            json_builder_add_double_value(b, g_ascii_strtod(v[0], NULL));
            json_builder_add_double_value(b, g_ascii_strtod(v[1], NULL));
            json_builder_end_array(b);
            masks_add_num(b, "feather", g_ascii_strtod(v[2], NULL));
          }
          g_strfreev(v);
        }
        else if(f->points)
        {
          // an AI object's soft edge is its outline's border, as
          // _object_shapes() set it on every point
          masks_add_num(b, "feather", ((const dt_masks_point_path_t *)f->points->data)->border[0]);
        }
        json_builder_set_member_name(b, "paths");
        json_builder_begin_array(b);
        open_obj = comp;
      }
      JsonBuilder **run = is_edge ? &edge : is_plain ? &plain : NULL;
      if(run && !*run)
      {
        *run = json_builder_new();
        json_builder_begin_array(*run);
      }
      _object_path_json(run ? *run : b, f, hole);
    }
    if(open_obj >= 0) _object_close(b, &edge, &plain, bd);
    // the ranges, from its parametric channels
    _channels_json(b, chans);
    g_array_free(flat, TRUE);
    g_ptr_array_free(chans, TRUE);
    json_builder_end_array(b);
    gboolean invert = FALSE;
    double opacity = 100.0;
    const dt_develop_blend_params_t *refined = NULL;
    json_builder_set_member_name(b, "instances");
    json_builder_begin_object(b);
    for(GList *m = _s.dev.iop; m; m = g_list_next(m))
    {
      dt_iop_module_t *mod = m->data;
      const char *tag = _mask_instance_tag(mod, name);
      if(!tag) continue;
      // an instance that is on, else one that is off: a hidden mask has
      // all of them off, and keeps its settings
      if(_instance_group(mod) == grp && (mod->enabled || !refined))
      {
        invert = _instance_inverted(mod);
        opacity = mod->blend_params->opacity;
        refined = mod->blend_params;
      }
      gchar *key = tag[0] ? g_strdup_printf("%s#%s", mod->op, tag) : g_strdup(mod->op);
      JsonArray *want = fields && json_object_has_member(fields, key)
        ? json_object_get_array_member(fields, key) : NULL;
      json_builder_set_member_name(b, key);
      g_free(key);
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "enabled");
      json_builder_add_boolean_value(b, mod->enabled);
      json_builder_set_member_name(b, "params");
      json_builder_begin_object(b);
      for(guint i = 0; want && i < json_array_get_length(want); i++)
      {
        const char *field = json_array_get_string_element(want, i);
        double num = 0.0;
        if(!_read_field(mod, field, FALSE, &num, err)) return FALSE;
        masks_add_num(b, field, num);
      }
      json_builder_end_object(b);
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
    json_builder_set_member_name(b, "invert");
    json_builder_add_boolean_value(b, invert);
    masks_add_num(b, "opacity", opacity);
    json_builder_set_member_name(b, "refine");
    json_builder_begin_object(b);
    masks_add_num(b, "feather", refined ? refined->feathering_radius : 0.0);
    masks_add_num(b, "blur", refined ? refined->blur_radius : 0.0);
    masks_add_num(b, "detail", refined ? refined->details : 0.0);
    masks_add_num(b, "contrast", refined ? refined->contrast : 0.0);
    json_builder_end_object(b);
    // the combined masks it is in: its adjustments there are carried by
    // shared instances, and its own instances are off without it being hidden
    json_builder_set_member_name(b, "merged_in");
    json_builder_begin_array(b);
    for(GList *c = _s.dev.forms; c; c = g_list_next(c))
    {
      const dt_masks_form_t *cg = c->data;
      if(!(cg->type & DT_MASKS_GROUP) || !g_str_has_prefix(cg->name, _COMBINED_PREFIX)
         || _combined_group(cg->name + strlen(_COMBINED_PREFIX)) != cg)
        continue;
      for(const GList *p = cg->points; p; p = g_list_next(p))
        if(_holds_mask(p->data, grp))
        {
          json_builder_add_string_value(b, cg->name + strlen(_COMBINED_PREFIX));
          break;
        }
    }
    json_builder_end_array(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

// take a mask away: its instances are switched off and let go of it, and
// its shapes leave the image
static gboolean _mask_delete(const char *name, char **err)
{
  dt_masks_form_t *grp = _mask_group(name);
  if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name);
    return FALSE;
  }
  _combined_adopt(grp);
  _combined_member_changed(grp, TRUE);
  GHashTable *old = _mask_forms(grp);
  GPtrArray *users = g_ptr_array_new();
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(_instance_group(m) != grp) continue;
    m->enabled = FALSE;
    m->blend_params->mask_mode = DEVELOP_MASK_DISABLED;
    m->blend_params->mask_id = 0;
    g_ptr_array_add(users, m);
  }
  // unnamed, nothing keeps the group or its ranges' (_free_unreached)
  dt_masks_form_t *ranged = _ranges_group(grp);
  if(ranged) ranged->name[0] = '\0';
  grp->name[0] = '\0';
  _free_unreached(old);
  for(guint i = 0; i < users->len; i++)
    dt_dev_add_masks_history_item_ext(&_s.dev, g_ptr_array_index(users, i), FALSE, TRUE);
  g_ptr_array_free(users, TRUE);
  session_changed(DT_DEV_PIPE_SYNCH);
  return TRUE;
}

// a mask renamed: its group, its shapes (named after it, with their
// component after the last '#'), its ranges' group and the instances
// carrying its adjustments, all ordinary history, so darktable shows the
// new name too
static gboolean _mask_rename(const char *name, const char *to, char **err)
{
  dt_masks_form_t *grp = _mask_group(name);
  if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name);
    return FALSE;
  }
  if(!to || !to[0] || _mask_group(to))
  {
    *err = g_strdup_printf("there is already a mask named '%s'", to ? to : "");
    return FALSE;
  }
  dt_masks_form_t *ranged = _ranges_group(grp);
  GHashTable *forms = _mask_forms(grp);
  gchar *full = g_strdup(grp->name);
  const size_t n = strlen(full);
  GHashTableIter it;
  gpointer key;
  g_hash_table_iter_init(&it, forms);
  while(g_hash_table_iter_next(&it, &key, NULL))
  {
    dt_masks_form_t *f = key;
    if(!strcmp(f->name, full))
      g_snprintf(f->name, sizeof(f->name), "%s%s", _MASK_PREFIX, to);
    else if(!strncmp(f->name, full, n) && !strncmp(f->name + n, " #", 2))
    {
      gchar *rest = g_strdup(f->name + n);
      g_snprintf(f->name, sizeof(f->name), "%s%s%s", _MASK_PREFIX, to, rest);
      g_free(rest);
    }
  }
  g_hash_table_destroy(forms);
  g_free(full);
  if(ranged) g_snprintf(ranged->name, sizeof(ranged->name), "%s%s", _RANGES_PREFIX, grp->name);
  gboolean recorded = FALSE;
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    const char *tag = _mask_instance_tag(m, name);
    if(!tag) continue;
    gchar *renamed = tag[0] ? g_strdup_printf("%s#%s", to, tag) : g_strdup(to);
    g_strlcpy(m->multi_name, renamed, sizeof(m->multi_name));
    g_free(renamed);
    // the first carries the renamed shapes into the history with it
    if(!recorded) dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    else dt_dev_add_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    recorded = TRUE;
  }
  return TRUE;
}

// where _working_at() reads: the mask instances' input (the anchor's
// output); the tone mapper's input, with every mask instance's adjustment
// in it; the Zone System placement's input, which it has not placed yet;
// rotate and perspective's input, larger, for Upright's line detection; or
// negadoctor's input, the negative as its pickers read it
typedef enum _stage_t
{
  _STAGE_ANCHOR,
  _STAGE_TONEMAPPER,
  _STAGE_UNPLACED,
  _STAGE_ASHIFT,
  _STAGE_NEGADOCTOR,
} _stage_t;

// the app's instance of the tone equalizer that places the zones
// (manifest.ts, "toneequal#zone placement")
#define _ZONE_PLACEMENT_OP "toneequal"
#define _ZONE_PLACEMENT_NAME "zone placement"

// the pipe caches what modules that ran put out; the mask instances' input
// is that of the last one to run up to the anchor, which may be switched off
// itself. reader, if asked for, gets the first module on that runs after it
static dt_dev_pixelpipe_iop_t *_stage_piece(const _stage_t stage, const dt_iop_module_t *anchor,
                                            const dt_iop_module_t *placement, const dt_iop_module_t *ashift,
                                            const dt_iop_module_t *negadoctor, dt_iop_module_t **reader)
{
  dt_dev_pixelpipe_iop_t *piece = NULL;
  GList *n = _s.ppipe.nodes;
  for(; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *pc = n->data;
    if(stage == _STAGE_TONEMAPPER)
    {
      if(pc->enabled && (!g_strcmp0(pc->module->op, "sigmoid") || !g_strcmp0(pc->module->op, "agx")
                         || !g_strcmp0(pc->module->op, "filmicrgb")
                         || !g_strcmp0(pc->module->op, "colorout")))
        break;
    }
    else if(placement && placement->enabled)
    {
      if(pc->module == placement) break;
    }
    else if(stage == _STAGE_ASHIFT)
    {
      if(pc->module->iop_order >= ashift->iop_order) break;
    }
    else if(stage == _STAGE_NEGADOCTOR)
    {
      if(pc->module->iop_order >= negadoctor->iop_order) break;
    }
    else if(pc->module->iop_order > anchor->iop_order)
      break;
    if(pc->enabled) piece = pc;
  }
  if(reader)
  {
    *reader = NULL;
    for(; n && !*reader; n = g_list_next(n))
    {
      dt_dev_pixelpipe_iop_t *pc = n->data;
      if(pc->enabled) *reader = pc->module;
    }
  }
  return piece;
}

static gboolean _working_at(_working_t *w, const _stage_t stage, char **err)
{
  dt_iop_module_t *anchor = dt_iop_get_module_by_op_priority(_s.dev.iop, _MASK_ANCHOR, 0);
  // without a placement, what is unplaced is the anchor's output
  dt_iop_module_t *placement = stage == _STAGE_UNPLACED ? _find_named(_ZONE_PLACEMENT_OP, _ZONE_PLACEMENT_NAME) : NULL;
  dt_iop_module_t *ashift = stage == _STAGE_ASHIFT ? dt_iop_get_module_by_op_priority(_s.dev.iop, "ashift", 0) : NULL;
  dt_iop_module_t *negadoctor = stage == _STAGE_NEGADOCTOR
    ? dt_iop_get_module_by_op_priority(_s.dev.iop, "negadoctor", 0) : NULL;
  if(stage == _STAGE_ASHIFT) anchor = ashift;
  if(stage == _STAGE_NEGADOCTOR) anchor = negadoctor;
  if(!anchor || !session_ppipe_ready(err))
  {
    if(!*err) *err = g_strdup("no anchor module to sample at");
    return FALSE;
  }
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  // line detection finds too few lines at the masks' size
  const double scale = fmin(1.0, (stage == _STAGE_ASHIFT ? 1600.0 : 768.0) / MAX(pw, ph));
  dt_dev_pixelpipe_iop_t *piece = NULL;
  float *data = NULL;
  dt_iop_buffer_dsc_t *dsc = NULL;
  dt_iop_roi_t roi = { 0 };
  // on the GPU, darktable keeps a module's output in the pipe cache only
  // as the input of the last edited module (patches/darktable-engine.patch,
  // important_input), so the module that reads the sampled image stands in
  // for it during the render
  dt_iop_module_t *reader = NULL;
  _stage_piece(stage, anchor, placement, ashift, negadoctor, &reader);
  dt_iop_module_t *last = _s.dev.history_last_module;
  // a render served from the cache leaves pieces made since (a new
  // instance remakes them all) with no region and their output uncached,
  // and the others with the region of the last render that ran them, such
  // as a zoomed mask_map's: the second pass makes them run
  for(int pass = 0; pass < 2 && !data; pass++)
  {
    // upright reads before geometry: crop, orientation and perspective can
    // request an offset input region. force its producer to run so that a
    // previous render's region cannot be mistaken for this sample's
    if(pass || stage == _STAGE_ASHIFT)
    {
      if(!piece) piece = _stage_piece(stage, anchor, placement, ashift, negadoctor, NULL);
      if(piece) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, piece->module->iop_order, "working ");
    }
    _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
    if(reader) _s.dev.history_last_module = reader;
    const int failed = dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, 0, 0, MAX(1, floor(scale * pw)),
                                                MAX(1, floor(scale * ph)), scale, DT_DEVICE_NONE);
    _s.dev.history_last_module = last;
    if(failed)
    {
      *err = g_strdup("the sample render failed");
      return FALSE;
    }
    piece = _stage_piece(stage, anchor, placement, ashift, negadoctor, NULL);
    if(!piece)
    {
      *err = g_strdup("nothing runs before the anchor");
      return FALSE;
    }
    roi = piece->processed_roi_out;
    // only the whole image at this render's scale: another region's output
    // can still be in the cache, and points outside it are clamped to its
    // edges (the range map's stripes)
    // upright_detect uses the region's origin when locating its lines;
    // mask sampling still needs an image starting at the origin
    const gboolean whole = (stage == _STAGE_ASHIFT || (roi.x == 0 && roi.y == 0))
                           && fabs(roi.scale - scale) < 1e-6 * scale;
    const size_t size = (size_t)roi.width * roi.height * 4 * sizeof(float);
    const dt_hash_t hash = dt_dev_pixelpipe_cache_hash(&roi, &_s.ppipe, piece->module->position);
    data = NULL;
    dsc = NULL;
    if(whole && size && dt_dev_pixelpipe_cache_available(&_s.ppipe, hash, size))
      dt_dev_pixelpipe_cache_get(&_s.ppipe, hash, size, (void **)&data, &dsc, NULL, FALSE);
  }
  if(!data || !dsc || dsc->channels != 4 || dsc->datatype != TYPE_FLOAT)
  {
    *err = g_strdup("the working-space image is not at hand");
    return FALSE;
  }
  // with nothing in RGB after it, colorin hands on Lab: a JPEG or TIFF has
  // no RGB module on ahead of the anchor. the mask instances get it as the
  // work profile's RGB, which darktable converts their input to, so it is
  // read that way. the conversion is kept until the next one
  static float *converted = NULL;
  static dt_iop_buffer_dsc_t converted_dsc;
  if(stage != _STAGE_ASHIFT && dsc->cst == IOP_CS_LAB)
  {
    if(converted) dt_free_align(converted);
    converted = dt_alloc_align_float((size_t)4 * roi.width * roi.height);
    if(!converted)
    {
      *err = g_strdup("out of memory for the working-space image");
      return FALSE;
    }
    dt_iop_colorspace_type_t cst = IOP_CS_LAB;
    dt_ioppr_transform_image_colorspace(piece->module, data, converted, roi.width, roi.height, IOP_CS_LAB,
                                        IOP_CS_RGB, &cst, dt_ioppr_get_pipe_work_profile_info(&_s.ppipe));
    converted_dsc = *dsc;
    converted_dsc.cst = IOP_CS_RGB;
    data = converted;
    dsc = &converted_dsc;
  }
  if(stage != _STAGE_ASHIFT && dsc->cst != IOP_CS_RGB)
  {
    *err = g_strdup("the image is not in RGB at the mask stage");
    return FALSE;
  }
  // ahead of colorin there is no working profile, nor need of one: line
  // detection reads the camera's RGB as it is
  if(stage != _STAGE_ASHIFT
     && !dt_develop_blendif_init_masking_profile(piece, &w->profile, DEVELOP_BLEND_CS_RGB_SCENE))
  {
    *err = g_strdup("no masking profile");
    return FALSE;
  }
  w->data = data;
  w->roi = roi;
  w->pw = pw;
  w->ph = ph;
  w->piece = piece;
  w->dsc = dsc;
  return TRUE;
}

gboolean masks_working(_working_t *w, char **err)
{
  return _working_at(w, _STAGE_ANCHOR, err);
}

// points of the shown image (pairs, 0-1) as pixels of the working buffer
void masks_to_working(const _working_t *w, float *pts, const size_t n)
{
  for(size_t k = 0; k < n; k++)
  {
    pts[2 * k] *= w->pw;
    pts[2 * k + 1] *= w->ph;
  }
  dt_dev_distort_backtransform_plus(&_s.dev, &_s.ppipe, w->piece->module->iop_order,
                                    DT_DEV_TRANSFORM_DIR_FORW_EXCL, pts, n);
  for(size_t k = 0; k < n; k++)
  {
    pts[2 * k] = pts[2 * k] * w->roi.scale - w->roi.x;
    pts[2 * k + 1] = pts[2 * k + 1] * w->roi.scale - w->roi.y;
  }
}

// a working-space pixel's luminance and JzCzhz, as the blend code sees them
void masks_blend_values(const _working_t *w, const float *rgb_in, float *Y, dt_aligned_pixel_t JzCzhz)
{
  dt_aligned_pixel_t rgb = { rgb_in[0], rgb_in[1], rgb_in[2], 0.0f };
  const dt_iop_order_iccprofile_info_t *pr = &w->profile;
  *Y = dt_ioppr_get_rgb_matrix_luminance(rgb, pr->matrix_in, pr->lut_in, pr->unbounded_coeffs_in,
                                         pr->lutsize, pr->nonlinearlut);
  dt_aligned_pixel_t XYZ, JzAzBz;
  dt_ioppr_rgb_matrix_to_xyz(rgb, XYZ, pr->matrix_out_transposed, pr->lut_in, pr->unbounded_coeffs_in,
                             pr->lutsize, pr->nonlinearlut);
  dt_XYZ_2_JzAzBz(XYZ, JzAzBz);
  dt_JzAzBz_2_JzCzhz(JzAzBz, JzCzhz);
}

// darktable's scene-referred input channels, by the names its parametric
// mask tabs give them; a parametric component holds any of them
#define _N_CHANS 7
#define _HZ_CHAN 6
static const struct { const char *name; int ch; } _chans[_N_CHANS] = {
  { "g", DEVELOP_BLENDIF_GRAY_in }, { "R", DEVELOP_BLENDIF_RED_in }, { "G", DEVELOP_BLENDIF_GREEN_in },
  { "B", DEVELOP_BLENDIF_BLUE_in }, { "Jz", DEVELOP_BLENDIF_Jz_in }, { "Cz", DEVELOP_BLENDIF_Cz_in },
  { "hz", DEVELOP_BLENDIF_hz_in },
};

// a working-space pixel's value in each of _chans
static void _chan_values(const _working_t *w, const float *rgb, float v[_N_CHANS])
{
  float Y;
  dt_aligned_pixel_t JzCzhz;
  masks_blend_values(w, rgb, &Y, JzCzhz);
  v[0] = Y;
  for(int c = 0; c < 3; c++) v[1 + c] = rgb[c];
  for(int c = 0; c < 3; c++) v[4 + c] = JzCzhz[c];
}

// a hue's opposite, half way round
static inline float _hue_flip(const float h)
{
  return h < 0.5f ? h + 0.5f : h - 0.5f;
}

// the values at a point of the shown image (a few pixels across, as a
// picker's box), or over a box of it {x0, y0, x1, y1}; with each channel
// of _chans's least, mean and most, for the parametric mask's pickers;
// read at the mask instances' input, or at another stage
static gboolean _sample(const float x, const float y, JsonArray *box, const _stage_t stage, JsonBuilder *b,
                        char **err)
{
  _working_t w;
  if(!_working_at(&w, stage, err)) return FALSE;
  const dt_iop_roi_t roi = w.roi;
  const float *data = w.data;
  int i0, j0, i1, j1;
  if(box && json_array_get_length(box) == 4)
  {
    // the box's corners may land skewed in the working buffer (rotated,
    // distorted); what they span
    float p[8];
    for(int k = 0; k < 4; k++)
    {
      p[2 * k] = json_array_get_double_element(box, k & 1 ? 2 : 0);
      p[2 * k + 1] = json_array_get_double_element(box, k & 2 ? 3 : 1);
    }
    masks_to_working(&w, p, 4);
    float lo[2] = { FLT_MAX, FLT_MAX }, hi[2] = { -FLT_MAX, -FLT_MAX };
    for(int k = 0; k < 4; k++)
      for(int c = 0; c < 2; c++)
      {
        lo[c] = fminf(lo[c], p[2 * k + c]);
        hi[c] = fmaxf(hi[c], p[2 * k + c]);
      }
    i0 = (int)lo[0];
    j0 = (int)lo[1];
    i1 = (int)hi[0];
    j1 = (int)hi[1];
  }
  else
  {
    float p[2] = { x, y };
    masks_to_working(&w, p, 1);
    i0 = (int)p[0] - 2;
    j0 = (int)p[1] - 2;
    i1 = (int)p[0] + 2;
    j1 = (int)p[1] + 2;
  }
  i0 = MAX(i0, 0);
  j0 = MAX(j0, 0);
  i1 = MIN(i1, roi.width - 1);
  j1 = MIN(j1, roi.height - 1);

  dt_aligned_pixel_t rgb = { 0.0f };
  float lo[_N_CHANS], hi[_N_CHANS], sum[_N_CHANS] = { 0.0f };
  // hue seen from its opposite too, for a spread across 0/1; and its
  // circular mean
  float flo = FLT_MAX, fhi = -FLT_MAX, hs = 0.0f, hc = 0.0f;
  for(int c = 0; c < _N_CHANS; c++)
  {
    lo[c] = FLT_MAX;
    hi[c] = -FLT_MAX;
  }
  int n = 0;
  for(int j = j0; j <= j1; j++)
    for(int i = i0; i <= i1; i++)
    {
      const float *px = data + 4 * ((size_t)j * roi.width + i);
      float v[_N_CHANS];
      _chan_values(&w, px, v);
      for(int c = 0; c < 3; c++) rgb[c] += px[c];
      for(int c = 0; c < _N_CHANS; c++)
      {
        lo[c] = fminf(lo[c], v[c]);
        hi[c] = fmaxf(hi[c], v[c]);
        sum[c] += v[c];
      }
      const float f = _hue_flip(v[_HZ_CHAN]);
      flo = fminf(flo, f);
      fhi = fmaxf(fhi, f);
      hs += sinf(2.0f * M_PI * v[_HZ_CHAN]);
      hc += cosf(2.0f * M_PI * v[_HZ_CHAN]);
      n++;
    }
  if(!n)
  {
    *err = g_strdup("the point is outside the image");
    return FALSE;
  }
  for(int c = 0; c < 3; c++) rgb[c] /= n;
  float Y;
  dt_aligned_pixel_t JzCzhz;
  masks_blend_values(&w, rgb, &Y, JzCzhz);
  masks_add_num(b, "luminance", Y);
  masks_add_num(b, "ev", log2f(fmaxf(Y, 1e-6f)));
  masks_add_num(b, "jz", JzCzhz[0]);
  masks_add_num(b, "chroma", JzCzhz[1]);
  masks_add_num(b, "hue", JzCzhz[2]);

  json_builder_set_member_name(b, "channels");
  json_builder_begin_object(b);
  for(int c = 0; c < _N_CHANS; c++)
  {
    float mn = lo[c], mx = hi[c], mean = sum[c] / n;
    if(c == _HZ_CHAN)
    {
      const float m = atan2f(hs, hc) / (2.0f * M_PI);
      mean = m < 0.0f ? m + 1.0f : m;
      // hues either side of 0/1 span less seen from the opposite side, as
      // blend_gui.c's picker takes them: then the least is above the most
      if(fhi - flo < mx - mn && flo < 0.5f && fhi > 0.5f)
      {
        mn = _hue_flip(flo);
        mx = _hue_flip(fhi);
      }
    }
    json_builder_set_member_name(b, _chans[c].name);
    json_builder_begin_object(b);
    masks_add_num(b, "min", mn);
    masks_add_num(b, "mean", mean);
    masks_add_num(b, "max", mx);
    json_builder_end_object(b);
  }
  json_builder_end_object(b);
  // negadoctor's pickers read the box as darktable's do, denoised: a raw
  // pixel's noise can read below zero, which its densities take for an
  // infinite one
  if(stage == _STAGE_NEGADOCTOR)
  {
    const int pbox[4] = { i0, j0, i1 + 1, j1 + 1 };
    lib_colorpicker_stats pick;
    dt_color_picker_helper(w.dsc, w.data, &w.roi, pbox, TRUE, pick, w.dsc->cst, IOP_CS_NONE, NULL);
    json_builder_set_member_name(b, "picker");
    json_builder_begin_object(b);
    const char *stat[] = { "min", "mean", "max" };
    const int at[] = { DT_PICK_MIN, DT_PICK_MEAN, DT_PICK_MAX };
    for(int k = 0; k < 3; k++)
    {
      json_builder_set_member_name(b, stat[k]);
      json_builder_begin_array(b);
      for(int c = 0; c < 3; c++) json_builder_add_double_value(b, pick[at[k]][c]);
      json_builder_end_array(b);
    }
    json_builder_end_object(b);
  }
  return TRUE;
}

// AgX's "auto tune levels" (agx.c, _apply_auto_tune_exposure): its input
// over darktable's default picker box, 2% in from each edge (lib.c,
// dt_lib_colorpicker_reset_box_area), denoised as its picker asks, and
// the darkest and brightest channel as black and white relative exposure
static gboolean _agx_auto(JsonBuilder *b, char **err)
{
  dt_iop_module_t *agx = session_module("agx", err);
  if(!agx) return FALSE;
  if(!agx->enabled)
  {
    *err = g_strdup("auto tune needs the AgX tone mapper");
    return FALSE;
  }
  double scaling = 0.0;
  if(!_read_field(agx, "dynamic_range_scaling", FALSE, &scaling, err)) return FALSE;
  _working_t w;
  if(!_working_at(&w, _STAGE_TONEMAPPER, err)) return FALSE;
  const int box[4] = { (int)(0.02f * w.roi.width), (int)(0.02f * w.roi.height),
                       (int)(0.98f * w.roi.width), (int)(0.98f * w.roi.height) };
  lib_colorpicker_stats pick;
  dt_color_picker_helper(w.dsc, w.data, &w.roi, box, TRUE, pick, w.dsc->cst, IOP_CS_NONE, NULL);
  const float black = fminf(pick[DT_PICK_MIN][0], fminf(pick[DT_PICK_MIN][1], pick[DT_PICK_MIN][2]));
  const float white = fmaxf(pick[DT_PICK_MAX][0], fmaxf(pick[DT_PICK_MAX][1], pick[DT_PICK_MAX][2]));
  // agx.c's _epsilon
  const float eps = 1e-6f;
  masks_add_num(b, "black_ev", CLAMPF(log2f(fmaxf(eps, black) / 0.18f) * (1.f + scaling), -20.f, -0.1f));
  masks_add_num(b, "white_ev", CLAMPF(log2f(fmaxf(eps, white) / 0.18f) * (1.f + scaling), 0.1f, 20.f));
  return TRUE;
}

// Lightroom's Upright: rotate and perspective's rotation and lens shifts
// that make the photo's lines level and plumb (upright.c). mode is
// "level", "vertical", "full", "auto" or "guided"; guided fits `guides`,
// the lines drawn (x1, y1, x2, y2 in the input image, 0-1), in place of
// the lines found. the fit starts from neutral, as it only reads the
// image ahead of rotate and perspective; `aspect` is held fixed
static gboolean _upright(const char *mode, JsonArray *guides, const double aspect, JsonBuilder *b,
                         char **err)
{
  dt_iop_module_t *ashift = session_module("ashift", err);
  if(!ashift) return FALSE;
  _working_t w;
  if(!_working_at(&w, _STAGE_ASHIFT, err)) return FALSE;
  dt_dev_pixelpipe_iop_t *piece = _piece(&_s.ppipe, ashift);
  if(!piece)
  {
    *err = g_strdup("rotate and perspective is not in the pipe");
    return FALSE;
  }
  const int width = piece->buf_in.width, height = piece->buf_in.height;

  // whether the frame turns by 90 degrees after rotate and perspective,
  // which swaps its fit's axes; worked out as ashift.c's process() does
  float corners[4] = { 0.0f, 0.0f, width, height };
  const float ivec[2] = { corners[2] - corners[0], corners[3] - corners[1] };
  dt_dev_distort_backtransform_plus(&_s.dev, &_s.ppipe, ashift->iop_order,
                                    DT_DEV_TRANSFORM_DIR_FORW_EXCL, corners, 2);
  const float ovec[2] = { corners[2] - corners[0], corners[3] - corners[1] };
  const float alpha = acosf(CLAMP((ivec[0] * ovec[0] + ivec[1] * ovec[1])
                                  / (hypotf(ivec[0], ivec[1]) * hypotf(ovec[0], ovec[1])), -1.0f, 1.0f));
  const gboolean flipped = fabsf(fmodf(alpha + M_PI_F, M_PI_F) - M_PI_2f) < M_PI_4f;

  const gboolean guided = !g_strcmp0(mode, "guided");
  upright_lines_t *lines = NULL;
  if(guided)
  {
    const guint n = guides ? json_array_get_length(guides) / 4 : 0;
    if(n)
    {
      float *pts = g_new(float, 4 * n);
      for(guint k = 0; k < 2 * n; k++)
      {
        pts[2 * k] = json_array_get_double_element(guides, 2 * k) * _s.ppipe.iwidth;
        pts[2 * k + 1] = json_array_get_double_element(guides, 2 * k + 1) * _s.ppipe.iheight;
      }
      // into rotate and perspective's input, through the modules ahead of it
      dt_dev_distort_transform_plus(&_s.dev, &_s.ppipe, ashift->iop_order,
                                    DT_DEV_TRANSFORM_DIR_BACK_EXCL, pts, 2 * n);
      lines = upright_drawn(pts, n);
      g_free(pts);
    }
  }
  else
  {
    // line detection works on the image in place
    const size_t size = (size_t)4 * w.roi.width * w.roi.height;
    float *buf = dt_alloc_align_float(size);
    if(buf)
    {
      memcpy(buf, w.data, size * sizeof(float));
      lines = upright_detect(buf, w.roi.width, w.roi.height, w.roi.x, w.roi.y, w.roi.scale,
                             dt_image_is_raw(&_s.dev.image_storage));
      dt_free_align(buf);
    }
  }
  int vertical = 0, horizontal = 0;
  float vweight = 0.0f, hweight = 0.0f;
  upright_lines_counts(lines, &vertical, &horizontal, &vweight, &hweight);

  // the fits to try, in turn. Auto corrects both axes only when the
  // horizontal lines carry weight against the vertical ones, else it
  // keeps to Vertical, and to Level when even that fails. Guided corrects
  // the axes it has two lines for
  upright_fit_t tries[3];
  int count = 0;
  if(!g_strcmp0(mode, "level")) tries[count++] = UPRIGHT_LEVEL;
  else if(!g_strcmp0(mode, "vertical")) tries[count++] = UPRIGHT_VERTICAL;
  else if(!g_strcmp0(mode, "full")) tries[count++] = UPRIGHT_FULL;
  else if(guided)
    tries[count++] = vertical >= 2 && horizontal >= 2 ? UPRIGHT_FULL
                   : vertical >= 2 ? UPRIGHT_VERTICAL
                   : horizontal >= 2 ? UPRIGHT_HORIZONTAL : UPRIGHT_LEVEL;
  else
  {
    if(hweight >= 0.25f * vweight) tries[count++] = UPRIGHT_FULL;
    tries[count++] = UPRIGHT_VERTICAL;
    tries[count++] = UPRIGHT_LEVEL;
  }

  float rotation = 0.0f, shift_v = 0.0f, shift_h = 0.0f;
  upright_result_t res = UPRIGHT_NOT_ENOUGH_LINES;
  upright_fit_t used = tries[0];
  for(int k = 0; k < count && res != UPRIGHT_OK; k++)
  {
    used = tries[k];
    res = upright_fit(lines, used, width, height, flipped, aspect, &rotation, &shift_v, &shift_h);
  }
  upright_lines_free(lines);
  if(res != UPRIGHT_OK)
  {
    *err = g_strdup(res == UPRIGHT_NOT_ENOUGH_LINES
                    ? (guided ? "draw at least two guides" : "not enough straight lines found in the photo")
                    : "the correction failed: try another mode, or correct by hand");
    return FALSE;
  }
  masks_add_num(b, "rotation", rotation);
  masks_add_num(b, "lensshift_v", shift_v);
  masks_add_num(b, "lensshift_h", shift_h);
  json_builder_set_member_name(b, "fit");
  json_builder_add_string_value(b, used == UPRIGHT_LEVEL ? "level"
                                   : used == UPRIGHT_VERTICAL ? "vertical"
                                   : used == UPRIGHT_HORIZONTAL ? "horizontal" : "full");
  return TRUE;
}

// points (x, y pairs, 0-1) of the shown image as points of the input
// image, before any distortion, or the reverse: where Guided's lines,
// kept in the input, show
static void _points(JsonArray *pts, const gboolean to_shown, JsonBuilder *b)
{
  json_builder_set_member_name(b, "points");
  json_builder_begin_array(b);
  const guint n = pts ? json_array_get_length(pts) / 2 : 0;
  for(guint k = 0; k < n; k++)
  {
    const float x = json_array_get_double_element(pts, 2 * k);
    const float y = json_array_get_double_element(pts, 2 * k + 1);
    float ox, oy;
    if(to_shown) _to_shown(x, y, &ox, &oy);
    else _to_input(x, y, &ox, &oy);
    json_builder_add_double_value(b, ox);
    json_builder_add_double_value(b, oy);
  }
  json_builder_end_array(b);
}

// the photo's key: the mean log2 luminance at the tone mapper's input, over
// the same box, as auto exposure takes it; middle gray reads -2.47
static gboolean _tone_key(JsonBuilder *b, char **err)
{
  _working_t w;
  if(!_working_at(&w, _STAGE_TONEMAPPER, err)) return FALSE;
  const dt_iop_order_iccprofile_info_t *pr = &w.profile;
  const int i0 = 0.02f * w.roi.width, j0 = 0.02f * w.roi.height;
  const int i1 = 0.98f * w.roi.width, j1 = 0.98f * w.roi.height;
  double sum = 0.0;
  size_t n = 0;
  for(int j = j0; j < j1; j++)
    for(int i = i0; i < i1; i++)
    {
      const float *px = w.data + 4 * ((size_t)j * w.roi.width + i);
      const dt_aligned_pixel_t rgb = { px[0], px[1], px[2], 0.0f };
      const float Y = dt_ioppr_get_rgb_matrix_luminance(rgb, pr->matrix_in, pr->lut_in, pr->unbounded_coeffs_in,
                                                        pr->lutsize, pr->nonlinearlut);
      sum += log2f(fmaxf(Y, 1e-6f));
      n++;
    }
  if(!n)
  {
    *err = g_strdup("the image is empty");
    return FALSE;
  }
  masks_add_num(b, "ev", sum / n);
  return TRUE;
}

// the top of an open-ended luminance range: a power of two, so the scaled
// limits land on exactly 1
#define _OPEN_TOP_EV 20.0f

// one channel's four limits, scaled into the parameters by the channel's
// boost so values above 1 fit
static void _set_channel(dt_develop_blend_params_t *bp, const int ch, const float lim[4], const gboolean invert)
{
  const float top = fmaxf(fmaxf(lim[2], lim[3]), 1e-6f);
  const float boost = top > 1.0f ? ceilf(log2f(top)) : 0.0f;
  bp->blendif_boost_factors[ch] = boost;
  for(int k = 0; k < 4; k++) bp->blendif_parameters[4 * ch + k] = lim[k] / exp2f(boost);
  bp->blendif |= 1u << ch;
  if(invert) bp->blendif |= 1u << (ch + 16);
  else bp->blendif &= ~(1u << (ch + 16));
}

// range components `list` as darktable's parametric channels in
// scene-referred RGB, set in `bp`; the channels multiply
static void _ranges_into(dt_develop_blend_params_t *bp, JsonArray *list)
{
  const guint n = list ? json_array_get_length(list) : 0;
  bp->blendif = 0;
  bp->blend_cst = DEVELOP_BLEND_CS_RGB_SCENE;
  for(guint k = 0; k < n; k++)
  {
    JsonObject *r = json_array_get_object_element(list, k);
    const char *type = json_object_get_string_member_with_default(r, "type", "");
    if(!g_strcmp0(type, "luminance"))
    {
      // a null end is open, which darktable takes from limits at 0 and at
      // the top of the boosted scale
      const gboolean open_lo = json_object_has_member(r, "lo") && json_object_get_null_member(r, "lo");
      const gboolean open_hi = json_object_has_member(r, "hi") && json_object_get_null_member(r, "hi");
      const float lo = open_lo ? 0.0f : json_object_get_double_member_with_default(r, "lo", -2.0);
      const float hi = open_hi ? 0.0f : json_object_get_double_member_with_default(r, "hi", 2.0);
      const float f = fmaxf(0.05f, json_object_get_double_member_with_default(r, "feather", 1.0));
      // the limits in EV, as luminance
      float lim[4] = { exp2f(lo - f), exp2f(lo), exp2f(hi), exp2f(hi + f) };
      if(open_lo) lim[0] = lim[1] = 0.0f;
      if(open_hi) lim[2] = lim[3] = exp2f(_OPEN_TOP_EV);
      _set_channel(bp, DEVELOP_BLENDIF_GRAY_in, lim, FALSE);
    }
    else if(!g_strcmp0(type, "color"))
    {
      const float h = json_object_get_double_member_with_default(r, "hue", 0.0);
      const float w = CLAMP(json_object_get_double_member_with_default(r, "width", 0.05), 0.005, 0.45);
      const float f = fminf(0.5f - w, CLAMP(json_object_get_double_member_with_default(r, "feather", 0.05), 0.002, 0.25));
      float lim[4] = { h - w - f, h - w, h + w, h + w + f };
      // a band across 0/1 cannot be one window; its complement can, inverted
      if(lim[0] < 0.0f || lim[3] > 1.0f)
      {
        const float c = h < 0.5f ? h + 0.5f : h - 0.5f;
        const float cw = 0.5f - w - f;
        const float inv[4] = { c - cw - f, c - cw, c + cw, c + cw + f };
        _set_channel(bp, DEVELOP_BLENDIF_hz_in, inv, TRUE);
      }
      else
        _set_channel(bp, DEVELOP_BLENDIF_hz_in, lim, FALSE);
      // near-neutral pixels have no hue to speak of; they stay out
      const float cmin = fmaxf(0.0f, json_object_get_double_member_with_default(r, "chroma", 0.002));
      const float chroma[4] = { cmin * 0.5f, cmin, 1e3f, 1e3f };
      _set_channel(bp, DEVELOP_BLENDIF_Cz_in, chroma, FALSE);
    }
    else if(!g_strcmp0(type, "parametric"))
    {
      // darktable's own numbers, per channel: the four markers in the
      // boosted 0-1 scale, polarity and boost
      JsonObject *chans = json_object_has_member(r, "channels") ? json_object_get_object_member(r, "channels") : NULL;
      for(int c = 0; chans && c < _N_CHANS; c++)
      {
        if(!json_object_has_member(chans, _chans[c].name)) continue;
        JsonObject *o = json_object_get_object_member(chans, _chans[c].name);
        JsonArray *pa = o && json_object_has_member(o, "p") ? json_object_get_array_member(o, "p") : NULL;
        if(!pa || json_array_get_length(pa) != 4) continue;
        const int ch = _chans[c].ch;
        float p[4];
        for(int i = 0; i < 4; i++)
        {
          p[i] = CLAMP(json_array_get_double_element(pa, i), 0.0, 1.0);
          if(i) p[i] = fmaxf(p[i], p[i - 1]);
          bp->blendif_parameters[4 * ch + i] = p[i];
        }
        bp->blendif_boost_factors[ch] = json_object_get_double_member_with_default(
          o, "boost", ch == DEVELOP_BLENDIF_Jz_in || ch == DEVELOP_BLENDIF_Cz_in ? -6.64385619 : 0.0);
        // a channel spanning everything selects all, whatever its polarity,
        // as darktable's own sliders leave it (blend_gui.c:873)
        if(p[1] <= 0.0f && p[2] >= 1.0f) continue;
        bp->blendif |= 1u << ch;
        if(json_object_get_boolean_member_with_default(o, "invert", FALSE)) bp->blendif |= 1u << (ch + 16);
      }
    }
  }
}

// instance `m` takes mask `root` (a mask's group or a combined mask's):
// its ranges group (_set_ranges_group) when it blends in scene-referred
// RGB, where ranges are measured, else its shapes alone. a module blending
// in another space (denoise in camera RGB, defringe in Lab) keeps it:
// forcing it into RGB blacked its output out. `invert` flips the whole
// mask, as darktable's conversion leaves a group more than one module
// renders (migrate_legacy.c, _polarity_movable)
static void _apply_ranges(dt_iop_module_t *m, dt_masks_form_t *root, const gboolean invert)
{
  dt_develop_blend_params_t *bp = m->blend_params;
  const dt_develop_blend_colorspace_t cst = dt_develop_blend_default_module_blend_colorspace(m);
  const dt_masks_form_t *ranges = cst == DEVELOP_BLEND_CS_RGB_SCENE ? _ranges_group(root) : NULL;
  bp->blend_cst = cst;
  // the module's own parametric mask would multiply into the group's again
  // (blend.c), as darktable's conversion clears it (_clear_toplevel_blendif)
  bp->blendif = 0;
  memset(bp->blendif_parameters, 0, sizeof(bp->blendif_parameters));
  memset(bp->blendif_boost_factors, 0, sizeof(bp->blendif_boost_factors));
  bp->mask_mode = DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI;
  bp->mask_id = (ranges ? ranges : root)->formid;
  bp->mask_combine &= ~(DEVELOP_COMBINE_INV | DEVELOP_COMBINE_MASKS_POS | DEVELOP_COMBINE_INCL);
  if(invert) bp->mask_combine |= DEVELOP_COMBINE_MASKS_POS;
}

// darktable's per-channel factor (blendif_rgb_jzczhz.c), for range_map
static float _range_factor(const float v, const gboolean invert, const float *p)
{
  float f = 0.0f;
  if(v <= p[0]) f = 0.0f;
  else if(v < p[1]) f = (v - p[0]) * p[4];
  else if(v <= p[2]) f = 1.0f;
  else if(v < p[3]) f = 1.0f - (v - p[2]) * p[5];
  return invert ? 1.0f - f : f;
}

// how much `ranges` select at each point of a width x height grid over
// the shown image, 0-255, written to `out`
static gboolean _range_map(JsonArray *ranges, const int width, const int height, const char *out,
                           char **err)
{
  _working_t w;
  if(!masks_working(&w, err)) return FALSE;
  dt_develop_blend_params_t bp = { 0 };
  _ranges_into(&bp, ranges);
  float params[DEVELOP_BLENDIF_PARAMETER_ITEMS * DEVELOP_BLENDIF_SIZE];
  dt_develop_blendif_process_parameters(params, &bp);
  const size_t n = (size_t)width * height;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < height; j++)
    for(int i = 0; i < width; i++)
    {
      pts[2 * ((size_t)j * width + i)] = (i + 0.5f) / width;
      pts[2 * ((size_t)j * width + i) + 1] = (j + 0.5f) / height;
    }
  masks_to_working(&w, pts, n);
  uint8_t *map = g_malloc(n);
  for(size_t k = 0; k < n; k++)
  {
    const int x = CLAMP((int)pts[2 * k], 0, w.roi.width - 1), y = CLAMP((int)pts[2 * k + 1], 0, w.roi.height - 1);
    float vals[_N_CHANS];
    _chan_values(&w, w.data + 4 * ((size_t)y * w.roi.width + x), vals);
    float f = 1.0f;
    for(int c = 0; c < _N_CHANS; c++)
      if(bp.blendif & (1u << _chans[c].ch))
        f *= _range_factor(vals[c], (bp.blendif >> 16) & (1u << _chans[c].ch),
                           params + DEVELOP_BLENDIF_PARAMETER_ITEMS * _chans[c].ch);
    map[k] = (uint8_t)CLAMP(f * 255.0f + 0.5f, 0.0f, 255.0f);
  }
  const gboolean ok = engine_transient_write(out, map, n, NULL, 0);
  g_free(map);
  g_free(pts);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

// ------------------------------------------------------------ zone system
// Ansel Adams' zones on the scene-referred B&W image the mask instances
// get: zone V is middle gray, one stop per zone, 0 and X open-ended. zone
// k's soft membership is the luminance range the app sends for it, ramps
// linear in Y as blendif's are, so neighbors' weights add up to 1 and
// what the histogram counts is what a zone mask selects

#define _ZONE_GRAY 0.1845f
#define _ZONE_COUNT 11
#define _ZONE_FINE 10

// zone k's weight for luminance Y, with ramps `w` EV across
static float _zone_weight(const float Y, const int k, const float w)
{
  const float c = log2f(_ZONE_GRAY) + (k - 5);
  float f = 1.0f;
  if(k > 0)
  {
    const float a = exp2f(c - 0.5f - w / 2.0f), b = exp2f(c - 0.5f + w / 2.0f);
    f = Y <= a ? 0.0f : Y < b ? (Y - a) / (b - a) : 1.0f;
  }
  if(k < _ZONE_COUNT - 1)
  {
    const float a = exp2f(c + 0.5f - w / 2.0f), b = exp2f(c + 0.5f + w / 2.0f);
    f *= Y <= a ? 1.0f : Y < b ? (b - Y) / (b - a) : 0.0f;
  }
  return f;
}

static int _zone_cmp(const void *a, const void *b)
{
  const float x = *(const float *)a, y = *(const float *)b;
  return (x > y) - (x < y);
}

// the zone of each point of a width x height grid over the shown image,
// written to `out` as (z + 1) * 20 in a byte, and the zones' statistics
static gboolean _zones(const int width, const int height, const float w, const _stage_t stage,
                       const char *out, JsonBuilder *b, char **err)
{
  _working_t wk;
  if(!_working_at(&wk, stage, err)) return FALSE;
  const size_t n = (size_t)width * height;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < height; j++)
    for(int i = 0; i < width; i++)
    {
      pts[2 * ((size_t)j * width + i)] = (i + 0.5f) / width;
      pts[2 * ((size_t)j * width + i) + 1] = (j + 0.5f) / height;
    }
  masks_to_working(&wk, pts, n);
  uint8_t *map = g_malloc(n);
  float *zs = g_malloc(n * sizeof(float));
  double pop[_ZONE_COUNT] = { 0.0 };
  double fine[_ZONE_COUNT * _ZONE_FINE] = { 0.0 };
  double below = 0.0, above = 0.0, sum = 0.0;
  for(size_t k = 0; k < n; k++)
  {
    const int x = CLAMP((int)pts[2 * k], 0, wk.roi.width - 1), y = CLAMP((int)pts[2 * k + 1], 0, wk.roi.height - 1);
    float Y;
    dt_aligned_pixel_t JzCzhz;
    masks_blend_values(&wk, wk.data + 4 * ((size_t)y * wk.roi.width + x), &Y, JzCzhz);
    // pure black has no zone in stops; it is darker than anything shown
    const float z = CLAMP(5.0f + log2f(fmaxf(Y, 1e-9f) / _ZONE_GRAY), -1.0f, 11.75f);
    zs[k] = z;
    sum += z;
    map[k] = (uint8_t)CLAMP((z + 1.0f) * 20.0f + 0.5f, 0.0f, 255.0f);
    for(int zk = MAX(0, (int)floorf(z) - 1); zk <= MIN(_ZONE_COUNT - 1, (int)ceilf(z) + 1); zk++)
      pop[zk] += _zone_weight(Y, zk, w);
    if(z < -0.5f) below += 1.0;
    else if(z >= _ZONE_COUNT - 0.5f) above += 1.0;
    else fine[CLAMP((int)((z + 0.5f) * _ZONE_FINE), 0, _ZONE_COUNT * _ZONE_FINE - 1)] += 1.0;
  }
  const gboolean ok = engine_transient_write(out, map, n, NULL, 0);
  qsort(zs, n, sizeof(float), _zone_cmp);

  json_builder_set_member_name(b, "zones");
  json_builder_begin_array(b);
  for(int k = 0; k < _ZONE_COUNT; k++) json_builder_add_double_value(b, pop[k] / n);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "fine");
  json_builder_begin_array(b);
  for(int k = 0; k < _ZONE_COUNT * _ZONE_FINE; k++) json_builder_add_double_value(b, fine[k] / n);
  json_builder_end_array(b);
  masks_add_num(b, "below", below / n);
  masks_add_num(b, "above", above / n);
  masks_add_num(b, "mean", sum / n);
  masks_add_num(b, "p5", zs[(size_t)(0.05 * (n - 1))]);
  masks_add_num(b, "p50", zs[(size_t)(0.50 * (n - 1))]);
  masks_add_num(b, "p95", zs[(size_t)(0.95 * (n - 1))]);
  masks_add_num(b, "gray", _ZONE_GRAY);

  g_free(zs);
  g_free(map);
  g_free(pts);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

// mask `name` as darktable makes it, refinements and all, 0-255 over a
// width x height grid of the shown image, written to `out`: the mask of the
// first instance of it that is on, kept by the preview pipe (it stores every
// piece's mask), without the instance's opacity. with `op` instead of a
// name ("diffuse#sharpen"), that module's own mask, such as the whole-image
// one its details threshold refines (_write_details()).
// with `scale` > 0, the map is of a window instead, as session_render() places
// one: *width x *height at (x, y) of the image scaled by `scale`, one point
// per pixel, made at that scale. refinements depend on the scale (the
// feather's window grows with its square root, the detail mask is found
// at the pipe's size), so this is the mask a render of that view used.
// the window is clipped to the image, and *width, *height say what is left
static gboolean _mask_map(const char *name, const char *op, int *width, int *height,
                          const double vscale, const int vx, const int vy, const char *out, char **err)
{
  dt_masks_form_t *grp = name ? _mask_group(name) : NULL;
  dt_iop_module_t *mod = NULL;
  if(op)
  {
    const char *hash = strchr(op, '#');
    gchar *base = hash ? g_strndup(op, hash - op) : g_strdup(op);
    mod = hash ? _find_named(base, hash + 1) : session_module(base, err);
    g_free(base);
    if(!mod)
    {
      if(!*err) *err = g_strdup_printf("no module '%s'", op);
      return FALSE;
    }
    // without a mask the pipe may still hold an earlier one
    if(!mod->blend_params || mod->blend_params->mask_mode <= DEVELOP_MASK_ENABLED)
    {
      *err = g_strdup_printf("'%s' has no mask", op);
      return FALSE;
    }
    name = op;
  }
  else if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name ? name : "(none)");
    return FALSE;
  }
  if(!session_ppipe_ready(err)) return FALSE;
  _s.ppipe.store_all_raster_masks = TRUE;
  // a mask with no adjustment yet has only an instance that is off, holding
  // its refinements (session.ts, REFINE_CARRIER), and an instance that is off
  // makes no mask: it is turned on in the preview pipe alone, whose output
  // is not shown, until synch_all turns it off again on the pipe's next use
  if(!mod)
  {
    dt_dev_pixelpipe_iop_t *on = NULL, *off = NULL;
    for(GList *n = _s.ppipe.nodes; n && !on; n = g_list_next(n))
    {
      dt_dev_pixelpipe_iop_t *pc = n->data;
      const dt_develop_blend_params_t *bp = pc->module->blend_params;
      if(!bp || _instance_group(pc->module) != grp || !_mask_instance_tag(pc->module, name)) continue;
      if(pc->enabled) on = pc;
      else if(!off) off = pc;
    }
    if(!on && off) _preview_commit(off->module, off->module->params, off->module->blend_params, TRUE);
  }
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  const double scale = vscale > 0.0 ? vscale : fmin(1.0, 768.0 / MAX(pw, ph));
  int ox = 0, oy = 0, rw = MAX(1, floor(scale * pw)), rh = MAX(1, floor(scale * ph));
  if(vscale > 0.0)
  {
    *width = MAX(1, MIN(*width, rw));
    *height = MAX(1, MIN(*height, rh));
    ox = CLAMP(vx, 0, rw - *width);
    oy = CLAMP(vy, 0, rh - *height);
    rw = *width;
    rh = *height;
  }
  dt_dev_pixelpipe_iop_t *piece = NULL;
  float *mask = NULL;
  // a piece served from the cache keeps no mask: the second pass makes it
  // run again
  for(int pass = 0; pass < 2 && !mask; pass++)
  {
    if(pass) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, piece->module->iop_order, "mask map ");
    _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
    if(dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, ox, oy, rw, rh, scale, DT_DEVICE_NONE))
    {
      *err = g_strdup("the mask render failed");
      return FALSE;
    }
    piece = NULL;
    for(GList *n = _s.ppipe.nodes; n && !piece; n = g_list_next(n))
    {
      dt_dev_pixelpipe_iop_t *pc = n->data;
      const dt_develop_blend_params_t *bp = pc->module->blend_params;
      if(mod ? pc->enabled && pc->module == mod
             : pc->enabled && bp && _instance_group(pc->module) == grp && _mask_instance_tag(pc->module, name))
        piece = pc;
    }
    if(!piece)
    {
      *err = g_strdup_printf("mask '%s' drives nothing that is on", name);
      return FALSE;
    }
    mask = piece->raster_masks ? g_hash_table_lookup(piece->raster_masks, GINT_TO_POINTER(BLEND_RASTER_ID)) : NULL;
  }
  if(!mask)
  {
    *err = g_strdup_printf("no mask kept for '%s'", name);
    return FALSE;
  }
  const _working_t w = { .roi = piece->processed_roi_out, .pw = pw, .ph = ph, .piece = piece };
  const float opacity = fmaxf(1e-3f, piece->module->blend_params->opacity / 100.0f);
  const int gw = *width, gh = *height;
  const size_t n = (size_t)gw * gh;
  // the grid's points as fractions of the whole shown image
  const double ux = vscale > 0.0 ? 1.0 / (scale * pw) : 1.0 / gw;
  const double uy = vscale > 0.0 ? 1.0 / (scale * ph) : 1.0 / gh;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < gh; j++)
    for(int i = 0; i < gw; i++)
    {
      pts[2 * ((size_t)j * gw + i)] = (ox + i + 0.5) * ux;
      pts[2 * ((size_t)j * gw + i) + 1] = (oy + j + 0.5) * uy;
    }
  masks_to_working(&w, pts, n);
  uint8_t *map = g_malloc(n);
  // bilinear: the grid is finer than the pipe's mask at times, and nearest
  // points would show its pixels as steps
  const int mw = w.roi.width, mh = w.roi.height;
  for(size_t k = 0; k < n; k++)
  {
    const float fx = CLAMP(pts[2 * k] - 0.5f, 0.0f, mw - 1.0f), fy = CLAMP(pts[2 * k + 1] - 0.5f, 0.0f, mh - 1.0f);
    const int x0 = (int)fx, y0 = (int)fy, x1 = MIN(x0 + 1, mw - 1), y1 = MIN(y0 + 1, mh - 1);
    const float ax = fx - x0, ay = fy - y0;
    const float top = mask[(size_t)y0 * mw + x0] * (1.0f - ax) + mask[(size_t)y0 * mw + x1] * ax;
    const float bot = mask[(size_t)y1 * mw + x0] * (1.0f - ax) + mask[(size_t)y1 * mw + x1] * ax;
    const float v = (top * (1.0f - ay) + bot * ay) / opacity;
    map[k] = (uint8_t)CLAMP(v * 255.0f + 0.5f, 0.0f, 255.0f);
  }
  const gboolean ok = engine_transient_write(out, map, n, NULL, 0);
  g_free(map);
  g_free(pts);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

// the ranges in an instance's blend parameters, as _apply_ranges() takes them
// whether blend parameters are exactly what _ranges_into makes of a
// luminance and a color range; anything else (darktable's own parametric
// masks, the app's parametric component) reads back as a parametric one
static gboolean _simple_ranges(const dt_develop_blend_params_t *bp)
{
  const float *p = bp->blendif_parameters;
  const uint32_t on = bp->blendif & 0xffffu, inv = bp->blendif >> 16;
  const uint32_t gray = 1u << DEVELOP_BLENDIF_GRAY_in, cz = 1u << DEVELOP_BLENDIF_Cz_in,
                 hz = 1u << DEVELOP_BLENDIF_hz_in;
  if(on & ~(gray | cz | hz)) return FALSE;
  if(!(on & cz) != !(on & hz)) return FALSE;
  if(on & gray)
  {
    const float *g = p + 4 * DEVELOP_BLENDIF_GRAY_in;
    if(inv & gray) return FALSE;
    const gboolean open_lo = g[0] <= 0.0f && g[1] <= 0.0f, open_hi = g[2] >= 1.0f && g[3] >= 1.0f;
    // one feather, in EV, for both ends
    const float flo = open_lo ? NAN : log2f(fmaxf(g[1], 1e-9f) / fmaxf(g[0], 1e-9f));
    const float fhi = open_hi ? NAN : log2f(fmaxf(g[3], 1e-9f) / fmaxf(g[2], 1e-9f));
    if((!open_lo && flo < 0.049f) || (!open_hi && fhi < 0.049f)) return FALSE;
    if(!open_lo && !open_hi && fabsf(flo - fhi) > 1e-3f) return FALSE;
  }
  if(on & hz)
  {
    const float *h = p + 4 * DEVELOP_BLENDIF_hz_in, *c = p + 4 * DEVELOP_BLENDIF_Cz_in;
    if(inv & cz) return FALSE;
    if(fabsf((h[1] - h[0]) - (h[3] - h[2])) > 1e-4f) return FALSE;
    // the chroma floor: half way up from 0, open at the top
    if(fabsf(c[0] * 2.0f - c[1]) > 1e-5f || c[2] != c[3]) return FALSE;
  }
  return TRUE;
}

static void _ranges_json(JsonBuilder *b, const dt_develop_blend_params_t *bp)
{
  const float *p = bp->blendif_parameters;
  const float *boost = bp->blendif_boost_factors;
  // _chans are scene-referred RGB's; another space's channels mean other things
  if(bp->blend_cst != DEVELOP_BLEND_CS_RGB_SCENE) return;
  if(!_simple_ranges(bp))
  {
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "parametric");
    json_builder_set_member_name(b, "channels");
    json_builder_begin_object(b);
    for(int c = 0; c < _N_CHANS; c++)
    {
      const int ch = _chans[c].ch;
      if(!(bp->blendif & (1u << ch))) continue;
      json_builder_set_member_name(b, _chans[c].name);
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "p");
      json_builder_begin_array(b);
      for(int k = 0; k < 4; k++) json_builder_add_double_value(b, p[4 * ch + k]);
      json_builder_end_array(b);
      json_builder_set_member_name(b, "invert");
      json_builder_add_boolean_value(b, (bp->blendif >> 16) & (1u << ch));
      masks_add_num(b, "boost", boost[ch]);
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
    json_builder_end_object(b);
    return;
  }
  if(bp->blendif & (1u << DEVELOP_BLENDIF_GRAY_in))
  {
    const int c = DEVELOP_BLENDIF_GRAY_in;
    const float k = exp2f(boost[c]);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "luminance");
    const gboolean open_lo = p[4 * c] <= 0.0f && p[4 * c + 1] <= 0.0f;
    const gboolean open_hi = p[4 * c + 2] >= 1.0f && p[4 * c + 3] >= 1.0f;
    if(open_lo)
    {
      json_builder_set_member_name(b, "lo");
      json_builder_add_null_value(b);
    }
    else
      masks_add_num(b, "lo", log2f(fmaxf(p[4 * c + 1] * k, 1e-9f)));
    if(open_hi)
    {
      json_builder_set_member_name(b, "hi");
      json_builder_add_null_value(b);
    }
    else
      masks_add_num(b, "hi", log2f(fmaxf(p[4 * c + 2] * k, 1e-9f)));
    // with the low end open, the feather is the high end's
    masks_add_num(b, "feather", open_lo
             ? log2f(fmaxf(p[4 * c + 3], 1e-9f) / fmaxf(p[4 * c + 2], 1e-9f))
             : log2f(fmaxf(p[4 * c + 1], 1e-9f) / fmaxf(p[4 * c + 0], 1e-9f)));
    json_builder_end_object(b);
  }
  if(bp->blendif & (1u << DEVELOP_BLENDIF_hz_in))
  {
    const int c = DEVELOP_BLENDIF_hz_in;
    const gboolean inv = (bp->blendif >> 16) & (1u << c);
    const float k = exp2f(boost[c]);
    const float l0 = p[4 * c] * k, l1 = p[4 * c + 1] * k, l2 = p[4 * c + 2] * k, l3 = p[4 * c + 3] * k;
    const float f = l1 - l0, mid = (l1 + l2) / 2.0f;
    const float h = inv ? (mid < 0.5f ? mid + 0.5f : mid - 0.5f) : mid;
    const float w = inv ? 0.5f - (l2 - l1) / 2.0f - f : (l2 - l1) / 2.0f;
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "color");
    masks_add_num(b, "hue", h);
    masks_add_num(b, "width", w);
    masks_add_num(b, "feather", f);
    (void)l3;
    if(bp->blendif & (1u << DEVELOP_BLENDIF_Cz_in))
      masks_add_num(b, "chroma", p[4 * DEVELOP_BLENDIF_Cz_in + 1] * exp2f(boost[DEVELOP_BLENDIF_Cz_in]));
    json_builder_end_object(b);
  }
}

// attach mask `name` to an instance; `invert` flips where it applies
static gboolean _attach_mask(dt_iop_module_t *m, const char *name, const gboolean invert, char **err)
{
  // a shared instance's mask is the combined one, whatever a client mask
  // is called
  const gboolean shared = g_str_has_prefix(m->multi_name, _SHARED_PREFIX);
  dt_masks_form_t *grp = shared ? _combined_group(name) : _mask_group(name);
  if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name);
    return FALSE;
  }
  if(!(m->flags() & IOP_FLAGS_SUPPORTS_BLENDING))
  {
    *err = g_strdup_printf("'%s' cannot take a mask", m->op);
    return FALSE;
  }
  _apply_ranges(m, grp, invert);
  return TRUE;
}

// ---------------------------------------------------------------- previews

static dt_dev_pixelpipe_iop_t *_piece(dt_dev_pixelpipe_t *pipe, const dt_iop_module_t *m)
{
  for(GList *n = pipe->nodes; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *piece = n->data;
    if(piece->module == m) return piece;
  }
  return NULL;
}

// the pipe cache the base and check pipes may keep, as a fraction of
// darktable's memory (pixelpipe_cache.c, dt_dev_pixelpipe_cache_checkmem):
// the darkroom's preview pipe's 1/32 rather than a full pipe's 1/8. both
// render the whole image, a 1 GB line at 60 megapixels, so even 1/8 kept
// few lines: a base reran as many modules either way (benchmark, heavy
// edit, 11 GB of memory), while its lines stayed until the next (_settle
// now cuts them back after each frame). the drag and preview pipes keep
// the full pipe's share: their small lines are what a drag draws from, and
// with less a rotate drag reran 13 modules, not 9
#define _WHOLE_PIPE_FRACTION 32

// the preview pipe, made on first use, with nodes for every instance and
// the edit as it stands
gboolean session_ppipe_ready(char **err)
{
  if(!_s.ppipe_ok)
  {
    if(!dt_dev_pixelpipe_init(&_s.ppipe))
    {
      *err = g_strdup("could not allocate the preview pipe");
      return FALSE;
    }
    dt_dev_pixelpipe_set_icc(&_s.ppipe, DT_COLORSPACE_SRGB, NULL, DT_INTENT_LAST);
    dt_dev_pixelpipe_set_input(&_s.ppipe, &_s.dev, (float *)_s.buf.buf,
                               _s.buf.width, _s.buf.height, _s.buf.iscale);
    dt_dev_pixelpipe_create_nodes(&_s.ppipe, &_s.dev);
    _s.ppipe_gen = _s.iop_gen;
    _s.ppipe_ok = TRUE;
  }
  else if(_s.ppipe_gen != _s.iop_gen)
  {
    dt_dev_pixelpipe_cleanup_nodes(&_s.ppipe);
    dt_dev_pixelpipe_create_nodes(&_s.ppipe, &_s.dev);
    _s.ppipe_gen = _s.iop_gen;
  }
  dt_dev_pixelpipe_synch_all(&_s.ppipe, &_s.dev);
  return TRUE;
}

// a follower pipe brought to the edit as it stands: unchanged pieces keep
// their hashes, so its cache holds
gboolean session_follower_ready(dt_engine_follower_t *f, char **err)
{
  if(f->ok)
  {
    if(f->gen != _s.iop_gen) f->pending |= DT_DEV_PIPE_REMOVE;
    f->gen = _s.iop_gen;
    f->pipe.changed = f->pending;
    dt_dev_pixelpipe_change(&f->pipe, &_s.dev);
    f->pending = DT_DEV_PIPE_UNCHANGED;
    return TRUE;
  }
  if(!dt_dev_pixelpipe_init(&f->pipe))
  {
    *err = g_strdup("could not allocate a pixelpipe");
    return FALSE;
  }
  if(f != &_s.drag) f->pipe.cache.mem_fraction = _WHOLE_PIPE_FRACTION;
  dt_dev_pixelpipe_set_icc(&f->pipe, DT_COLORSPACE_SRGB, NULL, DT_INTENT_LAST);
  dt_dev_pixelpipe_set_input(&f->pipe, &_s.dev, (float *)_s.buf.buf,
                             _s.buf.width, _s.buf.height, _s.buf.iscale);
  dt_dev_pixelpipe_create_nodes(&f->pipe, &_s.dev);
  dt_dev_pixelpipe_synch_all(&f->pipe, &_s.dev);
  dt_dev_pixelpipe_get_dimensions(&f->pipe, &_s.dev, f->pipe.iwidth, f->pipe.iheight,
                                  &f->pipe.processed_width, &f->pipe.processed_height);
  f->gen = _s.iop_gen;
  f->pending = DT_DEV_PIPE_UNCHANGED;
  f->ok = TRUE;
  return TRUE;
}

// give a preview piece these settings, for this render only
static void _preview_commit(dt_iop_module_t *m, void *params, dt_develop_blend_params_t *blend,
                            const gboolean enabled)
{
  dt_dev_pixelpipe_iop_t *piece = _piece(&_s.ppipe, m);
  if(!piece) return;
  piece->enabled = enabled;
  // older pins hash module->params; keep the upstream mask-tree and bypass
  // hashes while giving that path the preview's temporary parameters too
  void *saved_params = m->params;
  dt_develop_blend_params_t *saved_blend = m->blend_params;
  dt_develop_blend_params_t preview_blend = *blend;
  m->params = params;
  // The upstream commit copies into module->blend_params as well as the
  // piece. Give it request-local storage so a tile cannot overwrite the
  // applied look's mask id, opacity or other blend settings.
  m->blend_params = &preview_blend;
  dt_iop_commit_params(m, params, blend, &_s.ppipe, piece);
  m->blend_params = saved_blend;
  m->params = saved_params;
  // darktable.develop is not the engine's develop, so hash its own forms
  // explicitly, as _frame_hash does for retained main frames
  if(enabled)
  {
    dt_masks_form_t *form = dt_masks_get_from_id_ext(_s.dev.forms, blend->mask_id);
    if(form) piece->hash = dt_masks_group_hash_ext(piece->hash, form, _s.dev.forms);
    form = dt_masks_get_from_id_ext(_s.dev.forms, blend->blend_mask_id);
    if(form) piece->hash = dt_masks_group_hash_ext(piece->hash, form, _s.dev.forms);
  }
}

// the edit as it stands, plus `edits` ([{ op, params: { field: value },
// enabled, instance, after, before }], a named instance placed as "set"
// places it) and, when the request has "look", that style (a path) or no
// look (null), fitted into size x size on the preview pipe
static gboolean _preview_render(JsonObject *req, int *ow, int *oh, char **err)
{
  const int size = json_object_get_int_member_with_default(req, "size", 160);
  const gboolean has_look = json_object_has_member(req, "look");
  const char *look = has_look ? json_object_get_string_member_with_default(req, "look", NULL) : NULL;

  // the look's instances must exist before the preview pipe's nodes do
  gchar *label = NULL;
  GList *items = look ? looks_style_items(look, &label, err) : NULL;
  g_free(label);
  if(look && !items) return FALSE;
  for(GList *l = items; l; l = g_list_next(l))
    if(!looks_look_instance(((dt_style_item_t *)l->data)->operation, TRUE))
    {
      g_list_free_full(items, dt_style_item_free);
      *err = g_strdup("cannot add the look's modules");
      return FALSE;
    }

  // so must a named instance's that the preview switches on. one it leaves
  // off and that is not made yet has nothing to show
  JsonArray *edits = json_object_has_member(req, "edits")
    ? json_object_get_array_member(req, "edits") : NULL;
  for(guint k = 0; edits && k < json_array_get_length(edits); k++)
  {
    JsonObject *e = json_array_get_object_element(edits, k);
    const char *op = json_object_get_string_member_with_default(e, "op", NULL);
    const char *instance = json_object_get_string_member_with_default(e, "instance", NULL);
    if(!op || !instance || _find_named(op, instance)
       || !json_object_get_boolean_member_with_default(e, "enabled", FALSE))
      continue;
    const char *after = json_object_get_string_member_with_default(e, "after", NULL);
    const char *before = json_object_get_string_member_with_default(e, "before", NULL);
    gboolean moved = FALSE;
    dt_iop_module_t *m = _named_instance(op, instance, !after && !before, err);
    if(!m || !_place(m, after, before, &moved, err))
    {
      g_list_free_full(items, dt_style_item_free);
      return FALSE;
    }
  }

  if(!session_ppipe_ready(err))
  {
    g_list_free_full(items, dt_style_item_free);
    return FALSE;
  }

  gboolean ok = TRUE;
  for(guint k = 0; ok && edits && k < json_array_get_length(edits); k++)
  {
    JsonObject *e = json_array_get_object_element(edits, k);
    const char *op = json_object_get_string_member_with_default(e, "op", NULL);
    const char *instance = json_object_get_string_member_with_default(e, "instance", NULL);
    if(instance && op && !_find_named(op, instance)) continue;
    dt_iop_module_t *m = instance ? _find_named(op, instance) : session_module(op, err);
    if(!m) { ok = FALSE; break; }
    void *params = g_malloc(m->params_size);
    memcpy(params, m->params, m->params_size);
    JsonObject *fields = json_object_has_member(e, "params") ? json_object_get_object_member(e, "params") : NULL;
    GList *names = fields ? json_object_get_members(fields) : NULL;
    for(GList *n = names; ok && n; n = g_list_next(n))
      ok = _write_field_in(m, params, n->data, json_object_get_double_member(fields, n->data), err);
    g_list_free(names);
    if(ok)
      _preview_commit(m, params, m->blend_params,
                      json_object_get_boolean_member_with_default(e, "enabled", m->enabled));
    g_free(params);
  }

  if(ok && has_look)
  {
    GList *used = NULL;
    for(GList *l = items; ok && l; l = g_list_next(l))
    {
      const dt_style_item_t *si = l->data;
      dt_iop_module_t *m = looks_look_instance(si->operation, FALSE);
      void *params = g_malloc(m->params_size);
      dt_develop_blend_params_t *blend = g_malloc(sizeof(dt_develop_blend_params_t));
      ok = looks_item_params(m, si, params, blend);
      if(ok) _preview_commit(m, params, blend, si->enabled);
      else *err = g_strdup_printf("cannot apply the style's '%s'", si->operation);
      g_free(params);
      g_free(blend);
      used = g_list_prepend(used, m);
    }
    for(GList *l = _s.dev.iop; l; l = g_list_next(l))
    {
      dt_iop_module_t *m = l->data;
      dt_dev_pixelpipe_iop_t *piece = looks_is_look(m) && !g_list_find(used, m) ? _piece(&_s.ppipe, m) : NULL;
      if(piece) piece->enabled = FALSE;
    }
    g_list_free(used);
  }
  g_list_free_full(items, dt_style_item_free);
  if(!ok) return FALSE;

  _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  if(pw <= 0 || ph <= 0)
  {
    *err = g_strdup("the preview has no size");
    return FALSE;
  }
  const double scale = fmin(1.0, fmin((double)size / pw, (double)size / ph));
  const int w = MAX(1, floor(scale * pw)), h = MAX(1, floor(scale * ph));
  if(dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, 0, 0, w, h, scale, DT_DEVICE_NONE)
     || !_s.ppipe.backbuf)
  {
    *err = g_strdup("the preview failed");
    return FALSE;
  }
  *ow = _s.ppipe.backbuf_width;
  *oh = _s.ppipe.backbuf_height;
  return TRUE;
}

static gboolean _preview(JsonObject *req, int *ow, int *oh, char **err)
{
  // Creating a missing preview instance changes module order. Keep those
  // instances request-local too: saving after a preview must not change the
  // edit's hash and invalidate a paste's Undo/Redo snapshot.
  GList *saved_iop = g_list_copy(_s.dev.iop);
  GList *saved_order = dt_ioppr_iop_order_copy_deep(_s.dev.iop_order_list);
  const int gen = _s.iop_gen;
  const char *look = json_object_get_string_member_with_default(req, "look", NULL);
  GList *saved_forms = _s.dev.forms;
  if(look) _s.dev.forms = dt_masks_dup_forms_deep(saved_forms, NULL);
  const gboolean ok = _preview_render(req, ow, oh, err);
  if(look)
  {
    g_list_free_full(_s.dev.forms, (GDestroyNotify)dt_masks_free_form);
    _s.dev.forms = saved_forms;
  }
  if(gen != _s.iop_gen)
  {
    // Drop nodes before freeing modules they reference. cleanup_nodes keeps
    // the preview backbuffer, which the caller still needs to write out.
    dt_dev_pixelpipe_cleanup_nodes(&_s.pipe);
    if(_s.ppipe_ok) dt_dev_pixelpipe_cleanup_nodes(&_s.ppipe);
    session_follower_cleanup(&_s.drag);
    session_follower_cleanup(&_s.base);
    session_follower_cleanup(&_s.check);
    for(GList *l = _s.dev.iop; l; l = g_list_next(l))
      if(!g_list_find(saved_iop, l->data))
      {
        dt_iop_cleanup_module(l->data);
        free(l->data);
      }
    g_list_free(_s.dev.iop);
    _s.dev.iop = saved_iop;
    g_list_free_full(_s.dev.iop_order_list, free);
    _s.dev.iop_order_list = saved_order;
    dt_ioppr_resync_modules_order(&_s.dev);
    _s.iop_gen++;
    session_changed(DT_DEV_PIPE_REMOVE);
  }
  else
  {
    g_list_free(saved_iop);
    g_list_free_full(saved_order, free);
  }
  return ok;
}

// the edit into the library and the XMP sidecar
gboolean session_save(char **err)
{
  dt_dev_write_history_ext(&_s.dev, _s.imgid);
  // the database only: this session's own history stays in memory, as
  // reloading it calls into the GUI (dt_dev_reload_history_items())
  _compress_history(_s.imgid);
  // whether the photo is altered is darktable's history hash, which the
  // sidecar carries (exif.cc), so darktable's lighttable agrees with the
  // client. hashed after the compress, which renumbers the history
  dt_history_hash_write_from_history(_s.imgid, _s.baseline
                                     ? DT_HISTORY_HASH_AUTO | DT_HISTORY_HASH_CURRENT
                                     : DT_HISTORY_HASH_CURRENT);
  // and darktable's tag for an edited photo, which it attaches in
  // dt_dev_add_history_item(), a GUI path the engine never takes
  if(dt_image_altered(_s.imgid))
  {
    guint tagid = 0;
    dt_tag_new("darktable|changed", &tagid);
    dt_tag_attach(tagid, _s.imgid, FALSE, FALSE);
  }
  else
    dt_tag_detach_by_string("darktable|changed", _s.imgid, FALSE, FALSE);
  // direct rather than dt_image_synch_xmp(), whose queue is drained by a
  // background job this process may outlive. TRUE means it failed
  if(library_write_sidecar(_s.imgid))
  {
    *err = g_strdup(library_sidecar_error ? library_sidecar_error : "could not write the XMP sidecar");
    return FALSE;
  }
  dt_mipmap_cache_remove(_s.imgid);
  _s.unsaved = FALSE;
  return TRUE;
}

// Complete native histories for one frontend batch. These private image versions
// never appear in listings and are released with their undo entries or on exit.
typedef struct paste_image_t
{
  dt_imgid_t imgid, before, after;
  dt_history_hash_values_t before_hash, after_hash;
} paste_image_t;
typedef struct paste_batch_t
{
  GArray *images;
  gboolean committed;
} paste_batch_t;
static GHashTable *_paste_batches = NULL;
static guint _paste_serial = 0;

static void _paste_free(gpointer data)
{
  paste_batch_t *batch = data;
  for(guint k = 0; k < batch->images->len; k++)
  {
    paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
    library_snapshot_remove(i->before);
    library_snapshot_remove(i->after);
    dt_history_hash_free(&i->before_hash);
    dt_history_hash_free(&i->after_hash);
  }
  g_array_free(batch->images, TRUE);
  g_free(batch);
}

static dt_imgid_t _paste_snapshot(const dt_imgid_t imgid)
{
  const dt_imgid_t snap = library_snapshot(imgid);
  // The history API logs raster-copy failures without propagating them.
  // Verify the data transfer before relying on a snapshot for undo.
  if(dt_is_valid_imgid(snap) && !dt_dtdata_merge(imgid, snap))
  { library_snapshot_remove(snap); return NO_IMGID; }
  return snap;
}

static gboolean _paste_same_hash(const dt_history_hash_values_t *a,
                                 const dt_history_hash_values_t *b)
{
  return a->current_len == b->current_len
    && (!a->current_len || !memcmp(a->current, b->current, a->current_len));
}

static gboolean _paste_batch(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *action = json_object_get_string_member_with_default(req, "action", "");
  const guint token = json_object_get_int_member_with_default(req, "token", 0);
  if(!_paste_batches) _paste_batches = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, _paste_free);
  paste_batch_t *batch = g_hash_table_lookup(_paste_batches, GUINT_TO_POINTER(token));
  if(!g_strcmp0(action, "begin"))
  {
    JsonArray *ids = json_object_get_array_member(req, "imgids");
    if(!ids || !json_array_get_length(ids)) { *err = g_strdup("no paste targets"); return FALSE; }
    // Validate the whole list before allocating snapshots or writing anything.
    for(guint k = 0; k < json_array_get_length(ids); k++)
    {
      const dt_imgid_t id = json_array_get_int_element(ids, k);
      char path[PATH_MAX] = { 0 };
      gboolean cache = FALSE;
      if(dt_is_valid_imgid(id) && !library_is_snapshot(id)) dt_image_full_path(id, path, sizeof(path), &cache);
      if(!path[0] || !g_file_test(path, G_FILE_TEST_IS_REGULAR))
      { *err = g_strdup_printf("paste target %d is missing", id); return FALSE; }
      for(guint j = 0; j < k; j++) if(json_array_get_int_element(ids, j) == id)
      { *err = g_strdup("duplicate paste target"); return FALSE; }
    }
    if(_s.open && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
    batch = g_new0(paste_batch_t, 1);
    batch->images = g_array_new(FALSE, TRUE, sizeof(paste_image_t));
    for(guint k = 0; k < json_array_get_length(ids); k++)
    {
      paste_image_t i = { .imgid = json_array_get_int_element(ids, k) };
      dt_history_hash_read(i.imgid, &i.before_hash);
      i.before = _paste_snapshot(i.imgid);
      g_array_append_val(batch->images, i);
      if(!dt_is_valid_imgid(i.before))
      { _paste_free(batch); *err = g_strdup("could not snapshot paste targets"); return FALSE; }
    }
    const guint made = ++_paste_serial;
    g_hash_table_insert(_paste_batches, GUINT_TO_POINTER(made), batch);
    json_builder_set_member_name(b, "token");
    json_builder_add_int_value(b, made);
    return TRUE;
  }
  if(!batch) { *err = g_strdup("paste undo is no longer available"); return FALSE; }
  if(!g_strcmp0(action, "release"))
  { g_hash_table_remove(_paste_batches, GUINT_TO_POINTER(token)); return TRUE; }
  if(!g_strcmp0(action, "commit"))
  {
    if(batch->committed) { *err = g_strdup("paste already committed"); return FALSE; }
    if(_s.open && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
    for(guint k = 0; k < batch->images->len; k++)
    {
      paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
      i->after = _paste_snapshot(i->imgid);
      dt_history_hash_read(i->imgid, &i->after_hash);
      if(!dt_is_valid_imgid(i->after)) { *err = g_strdup("could not snapshot pasted settings"); return FALSE; }
    }
    batch->committed = TRUE;
    return TRUE;
  }
  const gboolean back = !g_strcmp0(action, "undo") || !g_strcmp0(action, "abort");
  const gboolean aborting = !g_strcmp0(action, "abort");
  if(!back && g_strcmp0(action, "redo")) { *err = g_strdup("unknown paste action"); return FALSE; }
  if(!aborting && !batch->committed) { *err = g_strdup("paste is not committed"); return FALSE; }
  // Refuse stale undo/redo before changing any photo. Retrying a failed sidecar
  // write is allowed when the database already holds the requested state.
  if(!aborting && _s.open && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
  for(guint k = 0; !aborting && k < batch->images->len; k++)
  {
    paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
    dt_history_hash_values_t now = { 0 };
    dt_history_hash_read(i->imgid, &now);
    const gboolean same = _paste_same_hash(&now, &i->before_hash) || _paste_same_hash(&now, &i->after_hash);
    dt_history_hash_free(&now);
    if(!same) { *err = g_strdup_printf("photo %d changed since the paste; undo stopped", i->imgid); return FALSE; }
  }
  if(_s.open)
    for(guint k = 0; k < batch->images->len; k++)
      if(g_array_index(batch->images, paste_image_t, k).imgid == _s.imgid) { session_close_session(); break; }
  json_builder_set_member_name(b, "updates");
  json_builder_begin_array(b);
  for(guint k = 0; k < batch->images->len; k++)
  {
    paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
    const dt_imgid_t snap = back ? i->before : i->after;
    const dt_history_hash_values_t *hash = back ? &i->before_hash : &i->after_hash;
    _hold_open(i->imgid);
    const gboolean copied = dt_history_copy_and_paste_on_image(snap, i->imgid, FALSE, NULL, TRUE, TRUE, FALSE)
      && dt_dtdata_merge(snap, i->imgid);
    if(copied)
    {
      // dt_history_hash_write consumes its buffers despite its const argument.
      dt_history_hash_values_t owned = *hash;
      owned.basic = hash->basic_len ? g_malloc(hash->basic_len) : NULL;
      owned.auto_apply = hash->auto_apply_len ? g_malloc(hash->auto_apply_len) : NULL;
      owned.current = hash->current_len ? g_malloc(hash->current_len) : NULL;
      if(hash->basic_len) memcpy(owned.basic, hash->basic, hash->basic_len);
      if(hash->auto_apply_len) memcpy(owned.auto_apply, hash->auto_apply, hash->auto_apply_len);
      if(hash->current_len) memcpy(owned.current, hash->current, hash->current_len);
      dt_history_hash_write(i->imgid, &owned);
    }
    const gboolean edited = dt_image_altered(i->imgid);
    if(copied)
    {
      if(edited)
      {
        guint tag = 0;
        dt_tag_new("darktable|changed", &tag);
        dt_tag_attach(tag, i->imgid, FALSE, FALSE);
      }
      else dt_tag_detach_by_string("darktable|changed", i->imgid, FALSE, FALSE);
    }
    const gboolean failed = !copied || library_write_sidecar(i->imgid);
    dt_mipmap_cache_remove(i->imgid);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "imgid"); json_builder_add_int_value(b, i->imgid);
    json_builder_set_member_name(b, "edited"); json_builder_add_boolean_value(b, edited);
    json_builder_set_member_name(b, "error");
    if(failed) json_builder_add_string_value(b, copied ? "could not write the XMP sidecar" : "could not restore history");
    else json_builder_add_null_value(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

// on the way out, the edits the client's own save has not reached yet
static void _save_pending(void)
{
  if(!_s.open || !_s.unsaved || _s.before) return;
  char *err = NULL;
  if(!session_save(&err)) fprintf(stderr, "[engine] save on quit: %s\n", err);
  g_free(err);
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
  if(!path || !_open_image(path, version, kind, err)) return FALSE;
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
    _saved_history(b);
  else
  {
    int k = 0;
    for(GList *l = _s.dev.history; l && k < _s.dev.history_end; l = g_list_next(l), k++)
    {
      const dt_dev_history_item_t *h = l->data;
      _history_item(b, h->op_name, h->module->name(), h->multi_name, h->multi_name_hand_edited,
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
  json_builder_set_member_name(b, "image");
  library_image_json(b, json_object_get_int_member_with_default(req, "imgid", 0), TRUE);
  return TRUE;
}

static gboolean _cmd_keywords(JsonObject *req, JsonBuilder *b, char **err)
{
  library_all_keywords(b);
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
  _hold(json_object_get_int_member_with_default(req, "job", 0),
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
  if(!_paste_batch(req, b, err)) return FALSE;
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
  if(!op || !_set(op, field, value, params, has_enabled, enabled, after, before, instance, mask, invert, opacity,
                  refine, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_color_profiles(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_color_profiles(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_lenses(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_lens_menu(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_module_state(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_module_state(json_object_get_string_member_with_default(req, "op", NULL),
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
  if(!ops || !_get(ops, b, err)) return FALSE;
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
    if(ppm && !_write_ppm(ppm, pipe->backbuf, w, h))
    {
      *err = g_strdup_printf("could not write '%s'", ppm);
      return FALSE;
    }
    const gint64 t1 = g_get_monotonic_time();
    double output_ms[4] = {0};
    if(sink) memcpy(output_ms, output.timings, sizeof(output_ms));
    if(rgba && !sink && !_write_rgba(rgba, pipe->backbuf, w, h, output_ms))
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
    gchar *hash = g_strdup_printf("%016" PRIx64, _frame_hash(pipe->backbuf_hash));
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
  _settle(pipe);
  return TRUE;
}

static gboolean _cmd_mask(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  JsonArray *shapes = json_object_has_member(req, "shapes")
    ? json_object_get_array_member(req, "shapes") : NULL;
  if(!name || !_mask(name, shapes, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_combine(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  JsonArray *members = json_object_has_member(req, "members")
    ? json_object_get_array_member(req, "members") : NULL;
  JsonNode *rn = json_object_get_member(req, "ranges");
  JsonArray *ranges = rn && JSON_NODE_HOLDS_ARRAY(rn) ? json_node_get_array(rn) : NULL;
  if(!name || !_combine(name, members, ranges, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_spots(JsonObject *req, JsonBuilder *b, char **err)
{
// with `spots`, they replace the image's; the reply is them as kept
  if(json_object_has_member(req, "spots")
     && !_spots_set(json_object_get_array_member(req, "spots"), err))
    return FALSE;
  if(!_spots_json(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_spots_enable(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_spots_enable(json_object_get_boolean_member_with_default(req, "on", TRUE), err)) return FALSE;
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
  if(!_spot_source(spot, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_masks(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonObject *fields = json_object_has_member(req, "fields")
    ? json_object_get_object_member(req, "fields") : NULL;
  if(!_masks(fields, b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_sample(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_sample(json_object_get_double_member_with_default(req, "x", 0.5),
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
  if(!_tone_key(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_agx_auto(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_agx_auto(b, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_upright(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonArray *guides = json_object_has_member(req, "guides")
    ? json_object_get_array_member(req, "guides") : NULL;
  if(!_upright(json_object_get_string_member_with_default(req, "mode", "auto"), guides,
               json_object_get_double_member_with_default(req, "aspect", 1.0), b, err))
    return FALSE;
  return TRUE;
}

static gboolean _cmd_points(JsonObject *req, JsonBuilder *b, char **err)
{
  _points(json_object_has_member(req, "points") ? json_object_get_array_member(req, "points") : NULL,
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
  if(!dest || !_range_map(ranges, w, h, dest, err)) return FALSE;
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
  if(!dest || w < 1 || h < 1 || !_zones(w, h, tw, stage, dest, b, err)) return FALSE;
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
  if((!name && !op) || !dest || !_mask_map(name, op, &w, &h, scale, x, y, dest, err)) return FALSE;
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
  if(!name || !_mask_rename(name, to, err)) return FALSE;
  return TRUE;
}

static gboolean _cmd_mask_delete(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *name = json_object_get_string_member_with_default(req, "name", NULL);
  if(!name || !_mask_delete(name, err)) return FALSE;
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
  if(!rgba || !_preview(req, &w, &h, err)) return FALSE;
  if(!_write_rgba(rgba, _s.ppipe.backbuf, w, h, NULL))
  {
    *err = g_strdup_printf("could not write '%s'", rgba);
    return FALSE;
  }
  _settle(&_s.ppipe);
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
  _save_pending();
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
            g_mutex_lock(&engine_cancel_lock);
            library_import_latest = job;
            g_mutex_unlock(&engine_cancel_lock);
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
  if(!quit) _save_pending();

  library_thumb_wait();
  library_import_wait();
  export_wait();
#ifdef HAVE_AI
  ai_denoise_wait();
  ai_wait();
#endif
  session_close_session();
  library_prefetch_wait();
  if(_paste_batches) g_hash_table_destroy(_paste_batches);
  dt_cleanup();
  g_ptr_array_free(m, TRUE);
  return 0;
}

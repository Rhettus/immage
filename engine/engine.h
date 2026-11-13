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

#pragma once

// what the engine's source files share: the session, and the functions and
// globals one file calls in another (named for the file that defines them:
// engine_ for main.c, session_ for session.c, and so on)

#include "common/color_picker.h"
#include "common/colorlabels.h"
#include "common/darktable.h"
#include "common/database.h"
#include "common/datetime.h"
#include "common/debug.h"
#include "common/dtdata.h"
#include "common/file_location.h"
#include "common/film.h"
#include "common/history.h"
#include "common/image.h"
#include "common/image_cache.h"
#include "common/introspection.h"
#include "common/iop_order.h"
#include "common/metadata.h"
#include "common/mipmap_cache.h"
#include "common/presets.h"
#include "common/ratings.h"
#include <libxml/parser.h>
#include <sqlite3.h>
#include "common/styles.h"
#include "common/spektra_fetch.h"
#include "common/spektra_sim.h"
#include "common/tags.h"
#include "control/conf.h"
#include "common/exif.h"
#include "develop/blend.h"
#include "develop/develop.h"
#include "develop/imageop.h"
#include "develop/masks.h"
#include "develop/pixelpipe_cache.h"
#include "hdrmerge.h"
#include "dng.h"
#ifdef HAVE_PANO
#include "pano.h"
#endif
#include "lenses.h"
#include "print.h"
#include "strip.h"
#include "upright.h"
#ifdef HAVE_AI
#include "ai/backend.h"
#include "common/ai_models.h"
#include "common/ai/segmentation.h"
#include "common/ai/restore.h"
#include "common/ai/restore_common.h"
#include "common/ai/restore_rgb.h"
#include "common/ai/restore_raw_bayer.h"
#include "common/ai/restore_raw_linear.h"
#include "common/ras2vect.h"
#include "imageio/imageio_dng.h"
#include "imageio/imageio_jpeg.h"
#endif
#include "common/iop_profile.h"
#include "develop/pixelpipe.h"
#include "imageio/imageio_common.h"
#include "imageio/imageio_module.h"
#include "views/view.h"

#include <glib.h>
#include <glib/gstdio.h>
#ifndef _WIN32
#include <execinfo.h>
#endif
#if defined(__GLIBC__)
#include <malloc.h>
#elif defined(__APPLE__)
#include <dispatch/dispatch.h>
#include <malloc/malloc.h>
#elif defined(_WIN32)
#include <malloc.h>
#include <windows.h>
#endif
#ifndef _WIN32
#include <signal.h>
#endif
#if defined(__linux__)
#include <sys/resource.h>
#elif defined(__APPLE__)
#include <pthread/qos.h>
#endif
#include <archive.h>
#include <archive_entry.h>
#include <json-glib/json-glib.h>
#include <pango/pangocairo.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

// a pipe on the session's develop that is brought to the edit before each
// frame it renders, made on first use
typedef struct dt_engine_follower_t
{
  dt_dev_pixelpipe_t pipe;
  gboolean ok;
  int gen;
  // the main pipe's changes since this pipe's last frame
  dt_dev_pixelpipe_change_t pending;
} dt_engine_follower_t;

typedef struct dt_engine_session_t
{
  gboolean open;
  dt_imgid_t imgid;
  dt_develop_t dev;
  dt_dev_pixelpipe_t pipe;
  dt_mipmap_buffer_t buf;
  // a second, small pipe on the same develop for previews (`preview`), so
  // trying a setting never touches the edit or the main pipe's cache
  dt_dev_pixelpipe_t ppipe;
  gboolean ppipe_ok;
  // a slider drag's smaller frames (`render` with "draft"): in the main
  // pipe they filled its 64 cachelines, and after some 30 of them the
  // release reran from the raw
  dt_engine_follower_t drag;
  // the client's idle whole-image render (`render` with "base"), on the GPU
  // when there is one: 2-3x the CPU's speed for a whole pipe. the main and
  // drag pipes keep to the CPU, where the pipe cache serves their edits
  dt_engine_follower_t base;
  // the GPU check's pipe (`parity`): its cache is flushed between its CPU
  // and GPU renders, which would otherwise cost the other pipes their lines
  dt_engine_follower_t check;
  // bumped whenever an instance is added, so each pipe rebuilds its nodes
  int iop_gen, ppipe_gen;
  // edits made since the last save, which quitting saves
  gboolean unsaved;
  // the client is showing its Before view, whose settings the engine holds
  // meanwhile: they are not the edit, and quitting must not save them
  gboolean before;
  // the photo had no history when opened; until the client's `baseline_end`,
  // saves record what it applies to a new photo as darktable's automatic
  // baseline (history_auto_hash), so those defaults do not mark it altered
  gboolean fresh, baseline;
  // instances Advanced mode deleted (`instance` "delete"): switched off and
  // left out of `instances` until undone, their entries dropped at each save.
  // kept, not freed, so undo brings one back at the same priority
  GList *deleted;
} dt_engine_session_t;

typedef struct preview_output_t {
  const char *path;
  double timings[4];
  double elapsed_ms;
  gboolean completed;
} preview_output_t;

// a `thumb` with a `tag` runs here rather than in the main loop, so a
// folder's thumbnails come in while the photo is edited and rendered.
// darktable's lighttable builds them from its job threads the same way:
// the mipmap cache and the library (SQLITE_CONFIG_SERIALIZED, database.c)
// take callers on many threads. two threads, so a render keeps most of the
// cores. the reply carries the tag, and can come between another request
// and its reply
#define _THUMB_THREADS 2

#ifdef HAVE_AI
// GPU execution providers, the only ones the upscale model runs on: on the
// CPU, ONNX Runtime expands RealPLKSR's large kernels into intermediate
// buffers of over 8 GB for a single 512-pixel tile, where Core ML stays
// under 2 GB (4x under 4). OpenVINO is left out, as it may be the CPU.
// each with darktable's name for it in its settings: kept here rather than
// read from dt_ai_providers, data that a Windows DLL does not hand to an
// executable, which then links darktable's AI library a second time
static const struct { dt_ai_provider_t p; const char *id; } _gpu_providers[] = {
  { DT_AI_PROVIDER_COREML, "CoreML" }, { DT_AI_PROVIDER_DIRECTML, "DirectML" },
  { DT_AI_PROVIDER_CUDA, "CUDA" }, { DT_AI_PROVIDER_MIGRAPHX, "MIGraphX" },
};

#endif
// an object component's feather when none is given: a path's border, as
// a share of the image's shorter side (path.c)
#define _OBJECT_FEATHER 0.003

// ------------------------------------------------------------ range masks
// Lightroom's Color Range and Luminance Range as darktable's parametric
// masks in the scene-referred RGB blend space, multiplied into the drawn
// mask. their values come from `sample`: the working-space pixel at the
// mask instances' input, the anchor's output

// the working-space image the mask instances get, small, from the preview
// pipe's cache: its buffer, region, size of the shown image it maps to,
// the piece that made it, and the masking profile for its values
typedef struct _working_t
{
  const float *data;
  dt_iop_roi_t roi;
  int pw, ph;
  dt_dev_pixelpipe_iop_t *piece;
  dt_iop_buffer_dsc_t *dsc;
  dt_iop_order_iccprofile_info_t profile;
} _working_t;

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

// lock order. every engine mutex has a rank; a thread takes locks in
// ascending rank only, so no two threads can wait on each other in a cycle.
// debug builds (no NDEBUG, or -DENG_LOCK_DEBUG) keep each thread's held ranks
// and abort on a take that is not above all of them; release builds compile
// eng_lock to a plain g_mutex_lock. same-rank locks are never held together
// (the check rejects it). the engine's locks sit outside darktable's: no
// darktable lock is held when an engine lock is taken, apart from callbacks
// that only reach the leaf locks (cancel, reply).
//
//   1  up              the AI upscale state, for a whole export. outer to the
//                      AI load lock: export -> _upscale_ctx loads a model
//   2  import          film roll and image lookup and insert
//   3  hold            per-job photo snapshots
//   4  format_conf     darktable format conf keys around get_params
//   5  ai_load         AI provider conf while a model loads (slow)
//   6  ai_cache        segmentation and mask caches
//   7  pool            the five thread-pool pointers, and the prefetch queue
//   8  probe           quarantine table; a folder probe's finished flag
//   9  cancel, fg      base and merge cancel flags; foreground busy flag
//   10 reply           stdout line writes (taken from everywhere, leaf)
typedef enum eng_lock_rank_t
{
  ENG_LOCK_UP = 1,
  ENG_LOCK_IMPORT,
  ENG_LOCK_HOLD,
  ENG_LOCK_FORMAT_CONF,
  ENG_LOCK_AI_LOAD,
  ENG_LOCK_AI_CACHE,
  ENG_LOCK_POOL,
  ENG_LOCK_PROBE,
  ENG_LOCK_CANCEL,
  ENG_LOCK_FG = ENG_LOCK_CANCEL,
  ENG_LOCK_REPLY,
} eng_lock_rank_t;

#if !defined(NDEBUG) || defined(ENG_LOCK_DEBUG)
// main.c: the per-thread stack of held ranks
void engine_lock_taking(const eng_lock_rank_t rank);
void engine_lock_taken(const eng_lock_rank_t rank);
void engine_lock_dropping(const eng_lock_rank_t rank);

static inline void eng_lock(GMutex *m, const eng_lock_rank_t rank)
{
  engine_lock_taking(rank);
  g_mutex_lock(m);
  engine_lock_taken(rank);
}

static inline void eng_unlock(GMutex *m, const eng_lock_rank_t rank)
{
  engine_lock_dropping(rank);
  g_mutex_unlock(m);
}
#else
static inline void eng_lock(GMutex *m, const eng_lock_rank_t rank)
{
  (void)rank;
  g_mutex_lock(m);
}

static inline void eng_unlock(GMutex *m, const eng_lock_rank_t rank)
{
  (void)rank;
  g_mutex_unlock(m);
}
#endif

extern dt_engine_session_t _s;

// main.c
gboolean engine_transient_write(const char *path, const void *first, size_t a,
                                const void *second, size_t b);
#if defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
int engine_transient_shared_open(const char *name, size_t length);
#endif
extern GMutex engine_cancel_lock;
void engine_background_yield(void);
void engine_background_priority(void);
double engine_ms_since(const gint64 t0);
void engine_reply(FILE *out, JsonBuilder *b);
void engine_add_string(JsonBuilder *b, const char *name, const char *value);
void engine_add_double(JsonBuilder *b, const char *name, const double value);
void engine_add_int(JsonBuilder *b, const char *name, const gint64 value);
void engine_add_bool(JsonBuilder *b, const char *name, const gboolean value);
gboolean engine_memory_pressure(void);

// session.c
void session_changed(const dt_dev_pixelpipe_change_t flags);
void session_follower_cleanup(dt_engine_follower_t *f);
void session_close_session(void);
extern GMutex session_hold_lock;
extern GHashTable *session_holds;
void session_hold(const gint64 job, JsonArray *imgids, const dt_imgid_t open_imgid);
dt_imgid_t session_hold_take(const gint64 job, const dt_imgid_t imgid);
void session_hold_release(const gint64 job);
void session_history_item(JsonBuilder *b, const char *op, const char *name, const char *multi_name,
                          const gboolean hand_edited, const gboolean enabled,
                          const int priority, const dt_iop_module_t *mod);
void session_saved_history(JsonBuilder *b);
gboolean session_open_image(const char *path, const dt_imgid_t version, const char *pipe_kind,
                            char **err);
dt_iop_module_t *session_module(const char *op, char **err);
dt_iop_module_t *session_module_at(const char *op, const int priority, char **err);
void *session_field_in(dt_iop_module_t *mod, void *base, const char *path,
                       dt_introspection_field_t **f, char **err);
gboolean session_write_field_in(dt_iop_module_t *mod, void *base, const char *name,
                               const double num, char **err);
gboolean session_write_field(dt_iop_module_t *mod, const char *name, const double num,
                             char **err);
gboolean session_read_field(dt_iop_module_t *mod, const char *name,
                            const gboolean from_defaults, double *num, char **err);

// wb.c: the temperature module's "temp_k" and "tint" fields, engine-own
// like the lens module's "lens_pick"
#define WB_TEMP "temp_k"
#define WB_TINT "tint"
gboolean wb_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults, double *num,
                 char **err);
gboolean wb_write(dt_iop_module_t *mod, const char *name, const double num, char **err);
// the settings combobox ("wb_setting") and finetune slider ("wb_tune"), and
// the camera presets that fill the menu
#define WB_SETTING "wb_setting"
#define WB_TUNE "wb_tune"
gboolean wb_setting_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults,
                         double *num, char **err);
gboolean wb_setting_write(dt_iop_module_t *mod, const char *name, const double num, char **err);
void wb_mark_user(dt_iop_module_t *mod);
gboolean wb_presets(JsonBuilder *b, char **err);
// files.c: the file-name params no number can hold, edited as the hash of the
// name like the lens module's "lens_pick": lut3d's "lut_file" (filepath, a
// file in the LUT folder) and watermark's "wm_marker" (filename, a marker in
// the watermarks folders). 0 is none; a write finds the file by its hash
#define FILES_LUT "lut_file"
#define FILES_MARKER "wm_marker"
gboolean files_is_field(const dt_iop_module_t *mod, const char *name);
gboolean files_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults, double *num,
                    char **err);
gboolean files_write(dt_iop_module_t *mod, const char *name, const double num, char **err);
void files_set_lut_folder(const char *folder);
gboolean files_lut(JsonObject *req, JsonBuilder *b, char **err);
gboolean files_watermarks(JsonBuilder *b, char **err);
// Composite's photo: a write of overlay's `imgid` (see files.c)
gboolean files_overlay_write(dt_iop_module_t *mod, const double num, char **err);
void files_overlay_sync(const dt_imgid_t imgid);
gboolean session_set(const char *op, const char *field, JsonNode *value,
                     JsonObject *params, const gboolean has_enabled,
                     const gboolean enabled, const char *after, const char *before,
                     const char *instance, const char *mask, const gboolean invert,
                     const double opacity, JsonObject *refine, const int priority, char **err);
gboolean session_module_state(const char *op, const int priority, const gboolean has_enabled,
                              const gboolean enabled, const gboolean reset, JsonObject *restore,
                              const char *preset, JsonBuilder *b, char **err);
gboolean session_presets(const char *op, const int priority, JsonBuilder *b, char **err);
dt_hash_t session_frame_hash(const dt_hash_t pipe_hash);
void session_settle(dt_dev_pixelpipe_t *pipe);
gboolean session_render(dt_dev_pixelpipe_t *pipe, const int devid, const int bw, const int bh,
                        const double req_scale, const int x, const int y, JsonArray *have,
                        int *ow, int *oh, int *ox_out, int *oy_out, dt_hash_t *kept, preview_output_t *output, char **err);
gboolean session_write_ppm(const char *path, const uint8_t *in, const int w, const int h);
gboolean session_write_rgba(const char *path, const uint8_t *in, const int w, const int h, double *timings);
dt_iop_module_t *session_find_named(const char *op, const char *name);
gboolean session_get(JsonObject *ops, JsonBuilder *b, char **err);
gboolean session_module_schema(const char *op, JsonBuilder *b, char **err);
void session_instances(JsonBuilder *b);
gboolean session_instance(const char *action, const char *op, const int priority, const char *name,
                          const int other, const gboolean after, JsonBuilder *b, char **err);
gboolean session_lens_menu(JsonBuilder *b, char **err);
gboolean session_color_profiles(JsonBuilder *b, char **err);
dt_dev_pixelpipe_iop_t *session_piece(dt_dev_pixelpipe_t *pipe, const dt_iop_module_t *m);
gboolean session_ppipe_ready(char **err);
gboolean session_follower_ready(dt_engine_follower_t *f, char **err);
void session_preview_commit(dt_iop_module_t *m, void *params, dt_develop_blend_params_t *blend,
                            const gboolean enabled);
gboolean session_preview(JsonObject *req, int *ow, int *oh, char **err);
gboolean session_save(char **err);
extern GHashTable *session_paste_batches;
gboolean session_paste_batch(JsonObject *req, JsonBuilder *b, char **err);
void session_save_pending(void);

// masks.c
const char *masks_mask_name(const char *full);
dt_masks_form_t *masks_instance_group(const dt_iop_module_t *m);
const char *masks_instance_owner(const dt_iop_module_t *m);
dt_iop_module_t *masks_named_instance(const char *op, const char *name, const gboolean anchored,
                                      char **err);
void masks_invalidate_from(const int order, const char *why);
gboolean masks_mask(const char *name, JsonArray *shapes, char **err);
// one-point brush strokes, which an older Immage saved, get a second point
void masks_repair_brushes(void);
gboolean masks_combine(const char *name, JsonArray *members, JsonArray *ranges, char **err);
void masks_add_num(JsonBuilder *b, const char *name, const double v);
gboolean masks_spots_set(JsonArray *spots, char **err);
gboolean masks_spots_json(JsonBuilder *b, char **err);
gboolean masks_spots_enable(const gboolean on, char **err);
gboolean masks_spot_source(JsonObject *o, JsonBuilder *b, char **err);
gboolean masks_masks(JsonObject *fields, JsonBuilder *b, char **err);
gboolean masks_mask_delete(const char *name, char **err);
gboolean masks_mask_rename(const char *name, const char *to, char **err);
gboolean masks_working(_working_t *w, char **err);
void masks_to_working(const _working_t *w, float *pts, const size_t n);
void masks_blend_values(const _working_t *w, const float *rgb_in, float *Y, dt_aligned_pixel_t JzCzhz);
gboolean masks_sample(const float x, const float y, JsonArray *box, const _stage_t stage, JsonBuilder *b,
                      char **err);
gboolean masks_agx_auto(JsonBuilder *b, char **err);
gboolean masks_upright(const char *mode, JsonArray *guides, const double aspect, JsonBuilder *b,
                       char **err);
void masks_points(JsonArray *pts, const gboolean to_shown, JsonBuilder *b);
gboolean masks_tone_key(JsonBuilder *b, char **err);
gboolean masks_range_map(JsonArray *ranges, const int width, const int height, const char *out,
                         char **err);
gboolean masks_zones(const int width, const int height, const float w, const _stage_t stage,
                     const char *out, JsonBuilder *b, char **err);
gboolean masks_mask_map(const char *name, const char *op, int *width, int *height,
                        const double vscale, const int vx, const int vy, const char *out, char **err);
gboolean masks_attach_mask(dt_iop_module_t *m, const char *name, const gboolean invert, char **err);

// library.c
void library_prefetch(const dt_imgid_t *imgids, const guint n);
void library_prefetch_wait(void);
extern gchar *library_sidecar_error;
gboolean library_write_sidecar(const dt_imgid_t imgid);
dt_imgid_t library_import(const char *path);
gboolean library_is_snapshot(const dt_imgid_t imgid);
dt_imgid_t library_snapshot(const dt_imgid_t imgid);
void library_snapshot_remove(const dt_imgid_t snap);
extern const char *library_meta_keys[6][2];
void library_all_keywords(JsonBuilder *b);
gboolean library_data_backup(JsonObject *req, char **err);
gboolean library_keywords_set(const dt_imgid_t imgid, JsonObject *req, JsonBuilder *b, char **err);
void library_image_json(JsonBuilder *b, const dt_imgid_t imgid, const gboolean full);
GList *library_image_versions(const dt_imgid_t imgid);
gboolean library_copy(const dt_imgid_t src, JsonBuilder *b, char **err);
gboolean library_remove_copy(const dt_imgid_t imgid, JsonBuilder *b, char **err);
gboolean library_forget(const dt_imgid_t imgid, char **err);
gboolean library_sidecars(const dt_imgid_t imgid, JsonBuilder *b, char **err);
gboolean library_unpack(const char *archive, const char *dir, char **err);
gboolean library_folder(const char *dir, const gboolean recursive, JsonBuilder *b, char **err);
extern gint64 library_import_latest;
void library_import_files(JsonObject *req, JsonBuilder *b, const gboolean background);
extern GThreadPool *library_import_pool;
void library_import_run(gpointer data, gpointer user_data);
gboolean library_import_queue(JsonParser *parser);
void library_import_wait(void);
gboolean library_thumb(const dt_imgid_t imgid, const int size, const gboolean proof, const char *out,
                       JsonBuilder *b, char **err);
extern GThreadPool *library_thumb_pool;
void library_thumb_run(gpointer data, gpointer user_data);
gboolean library_thumb_queue(JsonParser *parser);
void library_thumb_wait(void);
gboolean library_meta_set(const dt_imgid_t imgid, JsonObject *req, char **err);
gboolean library_capture_times(JsonObject *req, JsonBuilder *b, char **err);

// export.c
void export_merge_cancel(const gint64 job);
extern gint export_jobs;
#ifdef HAVE_AI
extern GMutex export_ai_load_lock;
#endif
void export_fonts(JsonBuilder *b);
gboolean export_export(const dt_imgid_t imgid, JsonObject *req, char **err);
extern GThreadPool *export_pool;
gboolean export_hdr_merge(JsonObject *req, JsonBuilder *b, FILE *out, char **err);
#ifdef HAVE_PANO
gboolean export_pano_merge(JsonObject *req, JsonBuilder *b, FILE *out, char **err);
#endif
void export_run(gpointer data, gpointer user_data);
gboolean export_queue(JsonParser *parser);
void export_wait(void);

// ai.c
uint8_t *ai_shown_rgb(const int size, const gboolean color, int *w, int *h, char **err);
#ifdef HAVE_AI
extern const char *ai_models_dir;
extern GThreadPool *ai_pool;
gpointer ai_idle_watch(gpointer data);
void ai_run(gpointer data, gpointer user_data);
void ai_wait(void);
gboolean ai_select(JsonObject *req, JsonBuilder *b, char **err);
void ai_denoise_forget(void);
gboolean ai_denoise_preview(const float u, const float v, const int size, const char *out,
                            JsonBuilder *b, char **err);
extern GThreadPool *ai_denoise_pool;
void ai_denoise_run(gpointer data, gpointer user_data);
void ai_denoise_wait(void);
gboolean ai_denoise(const float strength, const gint64 tag, JsonBuilder *b, char **err);
#endif

// device.c
#ifdef HAVE_AI
#ifdef __linux__
gboolean device_ort_exports(const dt_ai_provider_t p);
#endif
gboolean device_gpu_usable(const dt_ai_provider_t p);
#endif
void device_opencl(JsonBuilder *b);
#ifdef HAVE_AI
void device_ai_accel(JsonBuilder *b);
#endif
gboolean device_parity(JsonObject *req, JsonBuilder *b, char **err);

// looks.c
gboolean looks_is_look(const dt_iop_module_t *m);
GList *looks_style_items(const char *path, gchar **label, char **err);
dt_iop_module_t *looks_look_instance(const char *op, const gboolean create);
gboolean looks_item_params(dt_iop_module_t *m, const dt_style_item_t *si,
                           void *params, dt_develop_blend_params_t *blend);
gboolean looks_agx_presets(JsonObject *req, JsonBuilder *b, char **err);
const char *looks_look_name(void);
double looks_look_amount_value(void);
void looks_look_amount(const double amount);
gboolean looks_look(const char *path, char **err);

// film.c
void film_spektra_stocks(JsonBuilder *b);
gboolean film_spektra_fetch(JsonObject *req, JsonBuilder *b, char **err);

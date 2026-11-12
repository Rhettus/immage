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
} dt_engine_session_t;

typedef struct preview_output_t {
  const char *path;
  double timings[4];
  double elapsed_ms;
  gboolean completed;
} preview_output_t;

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

extern dt_engine_session_t _s;

// main.c
double engine_ms_since(const gint64 t0);
void engine_add_string(JsonBuilder *b, const char *name, const char *value);
void engine_add_int(JsonBuilder *b, const char *name, const gint64 value);
void engine_add_bool(JsonBuilder *b, const char *name, const gboolean value);

// session.c
void session_changed(const dt_dev_pixelpipe_change_t flags);
void session_follower_cleanup(dt_engine_follower_t *f);
dt_iop_module_t *session_module(const char *op, char **err);
void *session_field_in(dt_iop_module_t *mod, void *base, const char *path,
                       dt_introspection_field_t **f, char **err);
gboolean session_render(dt_dev_pixelpipe_t *pipe, const int devid, const int bw, const int bh,
                        const double req_scale, const int x, const int y, JsonArray *have,
                        int *ow, int *oh, int *ox_out, int *oy_out, dt_hash_t *kept, preview_output_t *output, char **err);
gboolean session_follower_ready(dt_engine_follower_t *f, char **err);

// masks.c
void masks_invalidate_from(const int order, const char *why);

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

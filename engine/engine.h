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

extern dt_engine_session_t _s;

// main.c
void engine_add_string(JsonBuilder *b, const char *name, const char *value);

// session.c
void session_changed(const dt_dev_pixelpipe_change_t flags);

// masks.c
void masks_invalidate_from(const int order, const char *why);

// film.c
void film_spektra_stocks(JsonBuilder *b);
gboolean film_spektra_fetch(JsonObject *req, JsonBuilder *b, char **err);

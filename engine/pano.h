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

#include <glib.h>

G_BEGIN_DECLS

// Lightroom's Photo Merge › Panorama on OpenCV's stitching module, which
// darktable does not have. the frames come in linear, in the camera's own
// color, and the panorama goes out so, to be written as a raw (dng.h)

typedef struct pano_t pano_t;

typedef enum pano_projection_t
{
  PANO_AUTO = 0,        // from the panorama's field of view
  PANO_SPHERICAL,
  PANO_CYLINDRICAL,
  PANO_PERSPECTIVE,
} pano_projection_t;

pano_t *pano_new(void);
void pano_free(pano_t *p);

// a frame: `rgba` linear floats, 4 per pixel as darktable's pipe gives
// them, each channel multiplied by `scale`, copied in at half precision,
// so the caller frees its buffer. `focal` is the lens's focal length in
// the frame's pixels, 0 when not known
gboolean pano_add(pano_t *p, const float *rgba, int width, int height, const float scale[3], double focal,
                  char **err);

// called as the stitch goes: `stage` ("finding features", "aligning",
// "finding seams", "blending"), `done` of `total` of it. FALSE stops the
// stitch, which then fails with "stopped"
typedef gboolean (*pano_step_t)(const char *stage, int done, int total, void *data);

// the frames stitched: linear RGB floats, 3 per pixel, to g_free(), or
// NULL with *err. `crop` cuts the largest rectangle the frames cover.
// `used` is how many of the frames the panorama holds: those that overlap
// none of the others are left out
float *pano_stitch(pano_t *p, pano_projection_t projection, gboolean crop, pano_step_t step, void *data,
                   int *width, int *height, int *used, char **err);

G_END_DECLS

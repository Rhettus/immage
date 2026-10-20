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

// Lightroom's Upright on darktable's rotate and perspective (ashift):
// its structure detection and parameter fit, which darktable runs only in
// its GUI, taken out of src/iop/ashift.c (see upright.c)

typedef struct upright_lines_t upright_lines_t;

// what the fit corrects
typedef enum upright_fit_t
{
  UPRIGHT_LEVEL,      // rotation, from both kinds of line
  UPRIGHT_VERTICAL,   // rotation and vertical lens shift
  UPRIGHT_HORIZONTAL, // rotation and horizontal lens shift
  UPRIGHT_FULL,       // rotation and both lens shifts
} upright_fit_t;

typedef enum upright_result_t
{
  UPRIGHT_OK = 0,
  UPRIGHT_NOT_ENOUGH_LINES = 1,
  UPRIGHT_DID_NOT_CONVERGE = 2,
  UPRIGHT_INSANE = 3,
} upright_result_t;

// lines found in `in` (4 channels, width x height, a region at x_off,
// y_off of an input scaled by `scale`), with outliers removed, in the
// unscaled input's pixels. NULL when none are found. `in` is overwritten
upright_lines_t *upright_detect(float *in, int width, int height, int x_off, int y_off,
                                float scale, gboolean is_raw);

// drawn lines, each x1, y1, x2, y2 in the input's pixels; vertical or
// horizontal by their larger extent, as ashift's drawn lines are
upright_lines_t *upright_drawn(const float *pts, int count);

void upright_lines_free(upright_lines_t *lines);

// the counts and weights of the vertical and horizontal lines kept
void upright_lines_counts(const upright_lines_t *lines, int *vertical, int *horizontal,
                          float *vweight, float *hweight);

// fits ashift's rotation and lens shifts for an input of width x height,
// starting from zero. `flipped` is whether the frame turns 90 degrees
// after ashift, as ashift's own fit asks; `aspect` is held fixed
upright_result_t upright_fit(const upright_lines_t *lines, upright_fit_t fit, int width, int height,
                             gboolean flipped, float aspect,
                             float *rotation, float *lensshift_v, float *lensshift_h);

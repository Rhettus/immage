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

struct dt_image_t;

G_BEGIN_DECLS

// a demosaiced raw as a DNG, as Lightroom writes its merged panoramas:
// LinearRaw, 16-bit floats, deflate-compressed with the floating-point
// predictor, which darktable's rawspeed reads (DngDecoder.cpp,
// DeflateDecompressor.cpp). `rgb` is 3 floats a pixel in the camera's own
// color, white balance not applied, 1.0 the sensor's white; values above
// it are kept. `img` gives the camera, its color matrix and the white
// balance as shot, so the DNG opens as `img` did; `exif` is written over
// it. `progress`, if any, follows the rows written, some 50 times. 0 when
// written, else the file is removed
int dng_write_linear_half(const char *filename, const float *rgb, int width, int height,
                          const struct dt_image_t *img, const void *exif, int exif_len,
                          void (*progress)(int done, int total, void *data), void *data);

G_END_DECLS

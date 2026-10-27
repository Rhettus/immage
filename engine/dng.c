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

// darktable's linear DNG writer (src/imageio/imageio_dng.c,
// dt_imageio_dng_write_linear) stores 16-bit integers clipped at the
// sensor's white, which would cut a panorama's highlights, and its float
// writer only a mosaic. this one keeps the metadata that writer's
// _set_dng_shared_metadata() gives, for floats

#include "dng.h"

#include "common/darktable.h"
#include "common/exif.h"
#include "common/image.h"

#include <glib/gstdio.h>
#include <math.h>
#include <string.h>
#include <tiffio.h>

// IEEE 754 binary16, rounded to nearest even; past 65504 it is infinite,
// far above any white this holds
static uint16_t _half(const float f)
{
  union { float f; uint32_t u; } v = { .f = f };
  const uint32_t sign = (v.u >> 16) & 0x8000;
  const uint32_t a = v.u & 0x7fffffff;
  if(a >= 0x7f800000) return sign | 0x7c00 | (a > 0x7f800000 ? 0x200 : 0);
  if(a >= 0x477ff000) return sign | 0x7c00;
  if(a < 0x38800000)
  {
    // subnormal: the value in units of 2^-24
    if(a < 0x33000000) return sign;
    const uint32_t m = (a & 0x7fffff) | 0x800000;
    const int shift = 126 - (int)(a >> 23);
    const uint32_t h = m >> shift, rest = m & ((1u << shift) - 1), mid = 1u << (shift - 1);
    return sign | (h + (rest > mid || (rest == mid && (h & 1))));
  }
  const uint32_t h = ((a - 0x38000000) >> 13), rest = a & 0x1fff;
  return sign | (h + (rest > 0x1000 || (rest == 0x1000 && (h & 1))));
}

int dng_write_linear_half(const char *filename, const float *rgb, const int width, const int height,
                          const dt_image_t *img, const void *exif, const int exif_len,
                          void (*progress)(int done, int total, void *data), void *data)
{
#ifdef _WIN32
  wchar_t *wfilename = g_utf8_to_utf16(filename, -1, NULL, NULL, NULL);
  TIFF *tif = TIFFOpenW(wfilename, "w");
  g_free(wfilename);
#else
  TIFF *tif = TIFFOpen(filename, "w");
#endif
  if(!tif) return 1;

  TIFFSetField(tif, TIFFTAG_SUBFILETYPE, 0);
  TIFFSetField(tif, TIFFTAG_IMAGEWIDTH, (uint32_t)width);
  TIFFSetField(tif, TIFFTAG_IMAGELENGTH, (uint32_t)height);
  TIFFSetField(tif, TIFFTAG_BITSPERSAMPLE, (uint16_t)16);
  TIFFSetField(tif, TIFFTAG_SAMPLESPERPIXEL, (uint16_t)3);
  TIFFSetField(tif, TIFFTAG_SAMPLEFORMAT, SAMPLEFORMAT_IEEEFP);
  TIFFSetField(tif, TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG);
  TIFFSetField(tif, TIFFTAG_PHOTOMETRIC, 34892); // LinearRaw
  TIFFSetField(tif, TIFFTAG_COMPRESSION, COMPRESSION_ADOBE_DEFLATE);
  TIFFSetField(tif, TIFFTAG_PREDICTOR, PREDICTOR_FLOATINGPOINT);
  TIFFSetField(tif, TIFFTAG_ORIENTATION, ORIENTATION_TOPLEFT);
  // strips of some 256 KB, each compressed on its own
  TIFFSetField(tif, TIFFTAG_ROWSPERSTRIP, (uint32_t)MAX(1, 262144 / (width * 6)));

  const uint8_t version[4] = { 1, 4, 0, 0 }, backward[4] = { 1, 4, 0, 0 };
  TIFFSetField(tif, TIFFTAG_DNGVERSION, version);
  TIFFSetField(tif, TIFFTAG_DNGBACKWARDVERSION, backward);
  if(img->camera_maker[0]) TIFFSetField(tif, TIFFTAG_MAKE, img->camera_maker);
  if(img->camera_model[0]) TIFFSetField(tif, TIFFTAG_MODEL, img->camera_model);
  if(img->camera_makermodel[0]) TIFFSetField(tif, TIFFTAG_UNIQUECAMERAMODEL, img->camera_makermodel);
  gchar *software = g_strdup_printf("Immage, on darktable %s", darktable_package_version);
  TIFFSetField(tif, TIFFTAG_SOFTWARE, software);
  g_free(software);

  // floats are normalized already: black 0, white 1.0 (rawspeed divides by
  // an integer WhiteLevel, DngDecoder.cpp)
  const float black[3] = { 0.0f, 0.0f, 0.0f };
  const uint32_t white = 1;
  TIFFSetField(tif, TIFFTAG_BLACKLEVEL, 3, black);
  TIFFSetField(tif, TIFFTAG_WHITELEVEL, 1, &white);
  TIFFSetField(tif, TIFFTAG_BASELINEEXPOSURE, 0.0f);

  // the camera's matrix (XYZ D65 to its RGB) and its white balance as shot
  float matrix[9];
  for(int k = 0; k < 3; k++)
    for(int i = 0; i < 3; i++) matrix[k * 3 + i] = img->adobe_XYZ_to_CAM[k][i];
  TIFFSetField(tif, TIFFTAG_COLORMATRIX1, 9, matrix);
  TIFFSetField(tif, TIFFTAG_CALIBRATIONILLUMINANT1, (uint16_t)21); // D65
  if(img->wb_coeffs[0] > 0.0f && img->wb_coeffs[1] > 0.0f && img->wb_coeffs[2] > 0.0f)
  {
    float neutral[3];
    for(int i = 0; i < 3; i++) neutral[i] = 1.0f / img->wb_coeffs[i];
    const float m = fmaxf(neutral[0], fmaxf(neutral[1], neutral[2]));
    for(int i = 0; i < 3; i++) neutral[i] /= m;
    TIFFSetField(tif, TIFFTAG_ASSHOTNEUTRAL, 3, neutral);
  }

  int res = 0;
  uint16_t *row = g_try_malloc((size_t)width * 3 * sizeof(uint16_t));
  if(!row) res = 1;
  const int every = MAX(1, height / 50);
  for(int y = 0; y < height && !res; y++)
  {
    const float *in = rgb + (size_t)y * width * 3;
    for(int x = 0; x < width * 3; x++) row[x] = _half(in[x]);
    if(TIFFWriteScanline(tif, row, y, 0) < 0) res = 1;
    if(progress && y % every == 0) progress(y, height, data);
  }
  g_free(row);
  TIFFClose(tif);

  if(!res && exif && exif_len > 0) dt_exif_write_blob((uint8_t *)exif, (uint32_t)exif_len, filename, 0);
  if(res) g_unlink(filename);
  return res;
}

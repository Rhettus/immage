// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
#pragma once
#include "imageio/imageio_jpeg.h"
#include <setjmp.h>

// The export dialog always requests sRGB JPEG quality 85. Render through the
// original export pipe, but encode its RGB bytes without a temporary container
// or metadata read/write pass. Match jpeg.c's quality-85 sampling and optimizer.
typedef struct preview_jpeg_t {
  struct jpeg_compress_struct cinfo;
  struct jpeg_error_mgr error;
  jmp_buf jump;
  unsigned char *bytes;
  unsigned long size;
  uint8_t *row;
} preview_jpeg_t;

static void preview_jpeg_error(j_common_ptr cinfo)
{
  preview_jpeg_t *p = cinfo->client_data;
  longjmp(p->jump, 1);
}

static int preview_jpeg_write(dt_imageio_module_data_t *data, const char *path, const void *input,
                              dt_colorspaces_color_profile_type_t over_type, const char *over_filename,
                              void *exif, int exif_len, dt_imgid_t imgid, int num, int total,
                              struct dt_dev_pixelpipe_t *pipe, const gboolean export_masks)
{
  if(data->width <= 0 || data->height <= 0) return 1;
  preview_jpeg_t *p = g_try_new0(preview_jpeg_t, 1);
  if(!p) return 1;
  p->cinfo.err = jpeg_std_error(&p->error);
  p->error.error_exit = preview_jpeg_error;
  p->cinfo.client_data = p;
  if(setjmp(p->jump))
  {
    jpeg_destroy_compress(&p->cinfo);
    free(p->bytes);
    g_free(p->row);
    g_free(p);
    return 1;
  }
  jpeg_create_compress(&p->cinfo);
  jpeg_mem_dest(&p->cinfo, &p->bytes, &p->size);
  p->cinfo.image_width = data->width;
  p->cinfo.image_height = data->height;
  p->cinfo.input_components = 3;
  p->cinfo.in_color_space = JCS_RGB;
  jpeg_set_defaults(&p->cinfo);
  jpeg_set_quality(&p->cinfo, 85, TRUE);
  p->cinfo.optimize_coding = 1;
  const int sample = dt_conf_get_int("plugins/imageio/format/jpeg/subsample");
  if(sample >= 1 && sample <= 4)
  {
    p->cinfo.comp_info[0].h_samp_factor = sample >= 3 ? 2 : 1;
    p->cinfo.comp_info[0].v_samp_factor = sample == 2 || sample == 4 ? 2 : 1;
  }
  p->cinfo.density_unit = 1;
  p->cinfo.X_density = p->cinfo.Y_density = dt_conf_get_int("metadata/resolution");
  p->row = g_try_malloc_n((size_t)data->width, 3);
  if(!p->row) { jpeg_destroy_compress(&p->cinfo); free(p->bytes); g_free(p); return 1; }
  jpeg_start_compress(&p->cinfo, TRUE);
  while(p->cinfo.next_scanline < p->cinfo.image_height)
  {
    const uint8_t *src = (const uint8_t *)input + (size_t)p->cinfo.next_scanline * data->width * 4;
    for(int x = 0; x < data->width; x++) memcpy(p->row + 3 * x, src + 4 * x, 3);
    JSAMPROW row = p->row;
    jpeg_write_scanlines(&p->cinfo, &row, 1);
  }
  jpeg_finish_compress(&p->cinfo);
  const gboolean ok = transient_write(path, p->bytes, p->size, NULL, 0);
  jpeg_destroy_compress(&p->cinfo);
  free(p->bytes);
  g_free(p->row);
  g_free(p);
  return ok ? 0 : 1;
}

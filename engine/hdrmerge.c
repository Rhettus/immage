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

// darktable's HDR merge, which it runs only as a lighttable job on the
// selection (dt_control_merge_hdr): the job is static, and the engine
// starts no job threads. darktable's source is left as it is, so the merge
// is copied here from src/control/jobs/control_jobs.c at fecc1b00e2
// (dt_control_merge_hdr_t, the format callbacks, _envelope,
// _control_merge_hdr_process, _control_merge_hdr_validate) with only its
// messages changed: dt_control_log() becomes the error handed back. the
// job's run is rewritten as hdr_merge(), without the job's progress, the
// collection reload and the import, which the engine does itself. compare
// these with control_jobs.c when taking a new darktable release

#include "hdrmerge.h"

#include "common/darktable.h"
#include "common/debug.h"
#include "common/exif.h"
#include "common/hdr_alignment.h"
#include "common/image.h"
#include "common/image_cache.h"
#include "control/conf.h"
#include "develop/imageop_math.h"
#include "imageio/imageio_common.h"
#include "imageio/imageio_dng.h"
#include "imageio/imageio_module.h"
#include "imageio/imageio_rawspeed.h"

#include <float.h>
#include <glib/gstdio.h>

typedef struct dt_control_merge_hdr_t
{
  dt_imgid_t first_imgid;
  uint32_t first_filter;
  uint8_t first_xtrans[6][6];

  float *pixels, *weight;

  int wd;
  int ht;
  dt_image_orientation_t orientation;

  float whitelevel;
  float epsw;
  dt_aligned_pixel_t wb_coeffs;
  float adobe_XYZ_to_CAM[4][3];
  char camera_makermodel[128];

  // auto-alignment of exposure brackets (handheld / shaky tripod). When
  // enabled, the first frame seeds the reference and every later frame is
  // registered onto it before accumulation. NULL/disabled => legacy behavior.
  dt_hdr_align_t *align;
  gboolean align_enabled;
  float *aligned_buf;  // scratch holding the warped moving frame (wd*ht)

  // auto-reference pre-pass: pick the richest-feature frame as the reference.
  gboolean probe_mode;          // set during the feature-probe pre-pass
  int probe_best_count;         // best SIFT feature count seen so far
  dt_imgid_t probe_best_imgid;  // imgid of the richest frame

  // 0 - ok; 1 - errors, abort
  gboolean abort;
  // why it aborted, for the caller (darktable logs it instead)
  char *err;
} dt_control_merge_hdr_t;

typedef struct dt_control_merge_hdr_format_t
{
  dt_imageio_module_data_t parent;
  dt_control_merge_hdr_t *d;
} dt_control_merge_hdr_format_t;

static int _control_merge_hdr_bpp(dt_imageio_module_data_t *data)
{
  return 32;
}

static int _control_merge_hdr_levels(dt_imageio_module_data_t *data)
{
  return IMAGEIO_RGB | IMAGEIO_FLOAT;
}

static const char *_control_merge_hdr_mime(dt_imageio_module_data_t *data)
{
  return "memory";
}

static float _envelope(const float xx)
{
  const float x = CLAMPS(xx, 0.0f, 1.0f);
  // const float alpha = 2.0f;
  const float beta = 0.5f;
  if(x < beta)
  {
    // return 1.0f-fabsf(x/beta-1.0f)^2
    const float tmp = fabsf(x / beta - 1.0f);
    return 1.0f - tmp * tmp;
  }
  else
  {
    const float tmp1 = (1.0f - x) / (1.0f - beta);
    const float tmp2 = tmp1 * tmp1;
    const float tmp3 = tmp2 * tmp1;
    return 3.0f * tmp2 - 2.0f * tmp3;
  }
}

static int _control_merge_hdr_process(dt_imageio_module_data_t *datai,
                                        const char *filename,
                                        const void *const ivoid,
                                        dt_colorspaces_color_profile_type_t over_type,
                                        const char *over_filename,
                                        void *exif,
                                        int exif_len,
                                        dt_imgid_t imgid,
                                        int num,
                                        int total,
                                        dt_dev_pixelpipe_t *pipe,
                                        const gboolean export_masks)
{
  const dt_control_merge_hdr_format_t *data = (dt_control_merge_hdr_format_t *)datai;
  dt_control_merge_hdr_t *d = data->d;

  // just take a copy. also do it after blocking read, so filters will make sense.
  const dt_image_t *img = dt_image_cache_get(imgid, 'r');
  const dt_image_t image = *img;
  dt_image_cache_read_release(img);

  // Auto-reference pre-pass: just probe each frame's feature richness and keep
  // the richest as the reference; do not accumulate anything.
  if(d->probe_mode)
  {
    if(image.buf_dsc.filters != 0u
       && image.buf_dsc.channels == 1
       && image.buf_dsc.datatype == TYPE_UINT16)
    {
      const int n = dt_hdr_alignment_probe_features((const float *)ivoid,
                                                    datai->width, datai->height);
      dt_print(DT_DEBUG_HDR_MERGE,
               "[hdr merge] auto-reference probe: imgid %d -> %d features", imgid, n);
      if(n > d->probe_best_count)
      {
        d->probe_best_count = n;
        d->probe_best_imgid = imgid;
      }
    }
    return 0;
  }

  if(!d->pixels)
  {
    d->first_imgid = imgid;
    d->first_filter = dt_rawspeed_crop_dcraw_filters(image.buf_dsc.filters, image.crop_x, image.crop_y);
    // sensor layout is just passed on to be written to dng.
    // we offset it to the crop of the image here, so we don't
    // need to load in the FCxtrans dependency into the dng writer.
    // for some stupid reason the dng needs this layout wrt cropped
    // offsets, not globally.
    dt_iop_roi_t roi = {0};
    roi.x = image.crop_x;
    roi.y = image.crop_y;
    for(int j=0;j<6;j++)
      for(int i = 0; i < 6; i++)
        d->first_xtrans[j][i] = FCxtrans(j, i, &roi, image.buf_dsc.xtrans);

    d->pixels = calloc((size_t)datai->width * datai->height, sizeof(float));
    d->weight = calloc((size_t)datai->width * datai->height, sizeof(float));
    d->wd = datai->width;
    d->ht = datai->height;
    d->orientation = image.orientation;
    for(int i = 0; i < 3; i++)
      d->wb_coeffs[i] = image.wb_coeffs[i];
    // give priority to DNG embedded matrix: see
    // dt_colorspaces_conversion_matrices_xyz() and its call from
    // iop/temperature.c with image_storage.adobe_XYZ_to_CAM[][] and
    // image_storage.d65_color_matrix[] as inputs
    if(dt_is_valid_colormatrix(image.d65_color_matrix[0]))
    {
        for(int i = 0; i < 9; ++i)
          d->adobe_XYZ_to_CAM[i/3][i%3] = image.d65_color_matrix[i];
        for(int i = 0; i < 3; ++i)
          d->adobe_XYZ_to_CAM[3][i] = 0.0f;
    }
    else
      for(int k = 0; k < 4; ++k)
        for(int i = 0; i < 3; ++i)
          d->adobe_XYZ_to_CAM[k][i] = image.adobe_XYZ_to_CAM[k][i];
  }
  if(!d->pixels || !d->weight)
  {
    d->err = g_strdup("unable to allocate memory for HDR merge");
    d->abort = TRUE;
    return 1;
  }

  // Authoritative per-frame guard on the *decoded* buffer.
  // _control_merge_hdr_validate() only sees cached image flags, which are
  // metadata-derived and can lag the decode -- a monochrome raw carries
  // DT_IMAGE_RAW yet decodes to filters == 0. The loop below indexes a raw CFA
  // mosaic and writes a CFA DNG, so anything else must abort here.
  if(image.buf_dsc.filters == 0u
     || image.buf_dsc.channels != 1
     || image.buf_dsc.datatype != TYPE_UINT16)
  {
    d->err = g_strdup("exposure bracketing only works on raw images");
    d->abort = TRUE;
    return 1;
  }
  // Re-check size / orientation too: the accumulation loop indexes the current
  // frame's buffer with the first frame's stride.
  if(datai->width != d->wd
     || datai->height != d->ht
     || d->orientation != image.orientation)
  {
    d->err = g_strdup("images have to be of same size and orientation");
    d->abort = TRUE;
    return 1;
  }

  // if no valid exif data can be found, assume peleng fisheye at
  // f/16, 8mm, with half of the light lost in the system => f/22
  const float eap = image.exif_aperture > 0.0f ? image.exif_aperture : 22.0f;
  const float efl = image.exif_focal_length > 0.0f ? image.exif_focal_length : 8.0f;
  const float rad = .5f * efl / eap;
  const float aperture = M_PI_F * rad * rad;
  const float iso = image.exif_iso > 0.0f ? image.exif_iso : 100.0f;
  const float exp = image.exif_exposure > 0.0f ? image.exif_exposure : 1.0f;
  const float cal = 100.0f / (aperture * exp * iso);
  // about proportional to how many photons we can expect from this shot:
  const float photoncnt = 100.0f * aperture * exp / iso;
  float saturation = 1.0f;
  d->whitelevel = fmaxf(d->whitelevel, saturation * cal);

  // Auto-align this frame onto the reference before accumulation.  The first
  // frame becomes the reference; every later frame is registered onto it and
  // accumulated from a warped scratch buffer.  On any failure (or when
  // alignment is disabled / built without OpenCV) we fall back to the raw
  // unaligned mosaic, i.e. the legacy behavior.
  const float *in_buf = (const float *)ivoid;
  if(d->align_enabled && d->align)
  {
    dt_print(DT_DEBUG_HDR_MERGE, "Processing image %d/%d: imgid %d", num, total, imgid);
    if(imgid == d->first_imgid)
    {
      dt_print(DT_DEBUG_HDR_MERGE, "  Reference image (no alignment needed)");
      if(dt_hdr_alignment_set_reference(d->align, (const float *)ivoid, d->wd, d->ht,
                                        d->first_filter, d->first_xtrans))
        d->aligned_buf = dt_alloc_align_float((size_t)d->wd * d->ht);
    }
    else if(d->aligned_buf)
    {
      if(dt_hdr_alignment_align_frame(d->align, (const float *)ivoid, d->aligned_buf,
                                      d->wd, d->ht, d->first_filter, d->first_xtrans, NULL))
        in_buf = d->aligned_buf;
    }
  }

  DT_OMP_FOR(collapse(2))
  for(int y = 0; y < d->ht; y++)
    for(int x = 0; x < d->wd; x++)
    {
      // read unclamped raw value with subtracted black and rescaled
      // to 1.0 saturation.  this is the output of the rawprepare iop
      // (optionally registered onto the reference frame, see in_buf above).
      const float in = in_buf[x + d->wd * y];
      // weights based on siggraph 12 poster zijian zhu, zhengguo li,
      // susanto rahardja, pasi fraenti 2d denoising factor for high
      // dynamic range imaging
      float w = photoncnt;

      // need some safety margin due to upsampling and 16-bit quantization + dithering?
      float offset = 3000.0f / (float)UINT16_MAX;

      // cannot do an envelope based on single pixel values here, need
      // to get maximum value of all color channels. to find that, go
      // through the pattern block (we conservatively do a 3x3 for
      // bayer or xtrans):
      int xx = x & ~1, yy = y & ~1;
      float M = 0.0f, m = FLT_MAX;
      if(xx < d->wd - 2 && yy < d->ht - 2)
      {
        for(int i = 0; i < 3; i++)
          for(int j = 0; j < 3; j++)
          {
            M = MAX(M, in_buf[xx + i + d->wd * (yy + j)]);
            m = MIN(m, in_buf[xx + i + d->wd * (yy + j)]);
          }
        // move envelope a little to allow non-zero weight even for
        // clipped regions.  this is because even if the 2x2 block is
        // clipped somewhere, the other channels might still prove
        // useful. we'll check for individual channel saturation
        // below.
        w *= d->epsw + _envelope((M + offset) / saturation);
      }

      if(M + offset >= saturation)
      {
        if(d->weight[x + d->wd * y] <= 0.0f)
        { // only consider saturated pixels in case we have nothing better:
          if(d->weight[x + d->wd * y] == 0 || m < -d->weight[x + d->wd * y])
          {
            if(m + offset >= saturation)
              d->pixels[x + d->wd * y] = 1.0f; // let's admit we were completely clipped, too
            else
              d->pixels[x + d->wd * y] = in * cal / d->whitelevel;
            d->weight[x + d->wd * y]
                = -m; // could use -cal here, but m is per pixel and
                      // safer for varying illumination conditions
          }
        }
        // else silently ignore, others have filled in a better color here already
      }
      else
      {
        if(d->weight[x + d->wd * y] <= 0.0)
        { // cleanup potentially blown highlights from earlier images
          d->pixels[x + d->wd * y] = 0.0f;
          d->weight[x + d->wd * y] = 0.0f;
        }
        d->pixels[x + d->wd * y] += w * in * cal;
        d->weight[x + d->wd * y] += w;
      }
    }

  return 0;
}

// Validate that the selected images form a consistent raw exposure bracket.
// Reject non-raw inputs, already-merged HDR DNGs, or images with mismatched
// resolution/orientation before expensive decode/align work. Returns TRUE if
// mergeable, otherwise sets *err naming the odd file and returns FALSE.
static gboolean _control_merge_hdr_validate(GList *images, char **err)
{
  gboolean have_ref = FALSE;
  int32_t ref_width = 0, ref_height = 0;
  dt_image_orientation_t ref_orientation = ORIENTATION_NONE;

  for(GList *l = images; l; l = g_list_next(l))
  {
    const dt_imgid_t imgid = GPOINTER_TO_INT(l->data);
    const dt_image_t *img = dt_image_cache_get(imgid, 'r');
    if(!img) continue;

    const int32_t flags = img->flags;
    const int32_t width = img->width;
    const int32_t height = img->height;
    const dt_image_orientation_t orientation = img->orientation;
    char filename[DT_MAX_FILENAME_LEN];
    g_strlcpy(filename, img->filename, sizeof(filename));
    dt_image_cache_read_release(img);

    // Exposure bracketing operates on the raw CFA mosaic, so reject non-raws,
    // already-merged HDR DNGs (float raws carry DT_IMAGE_HDR) and monochrome
    // raws (no CFA). These flags are metadata-derived and may not be set yet for
    // an undecoded frame; _control_merge_hdr_process() is the real guard.
    if(!(flags & DT_IMAGE_RAW) || (flags & DT_IMAGE_HDR) || (flags & DT_IMAGE_MONOCHROME))
    {
      *err = g_strdup_printf("%s is not a raw exposure"
                             " (already merged HDR, monochrome or non-raw image)", filename);
      return FALSE;
    }

    if(!have_ref)
    {
      ref_width = width;
      ref_height = height;
      ref_orientation = orientation;
      have_ref = TRUE;
    }
    else if(width != ref_width
            || height != ref_height
            || orientation != ref_orientation)
    {
      *err = g_strdup_printf("%s has a different size or orientation", filename);
      return FALSE;
    }
  }
  return TRUE;
}

gboolean hdr_merge_can_align(void)
{
  dt_hdr_align_t *a = dt_hdr_alignment_new(NULL);
  if(a) dt_hdr_alignment_free(a);
  return a != NULL;
}

// one pass of the export pipe over a frame, stopped before rawprepare, as
// _control_merge_hdr_job_run() runs it
static void _merge_frame(const dt_imgid_t imgid, dt_imageio_module_format_t *buf,
                         dt_control_merge_hdr_format_t *dat, const int num, const int total)
{
  dt_imageio_export_with_flags(imgid, "unused", buf, (dt_imageio_module_data_t *)dat,
                               TRUE, FALSE, TRUE, TRUE, FALSE, 1.0,
                               FALSE, "pre:rawprepare", FALSE,
                               FALSE, DT_COLORSPACE_NONE, NULL, DT_INTENT_LAST, NULL,
                               NULL, num, total, NULL, -1);
}

gchar *hdr_merge(GList *imgids, const gboolean align, char **err)
{
  GList *t = g_list_copy(imgids);
  const guint total = g_list_length(t);
  gchar *result = NULL;
  if(total < 2)
  {
    *err = g_strdup("merging to HDR needs two photos or more");
    g_list_free(t);
    return NULL;
  }
  if(!_control_merge_hdr_validate(t, err))
  {
    g_list_free(t);
    return NULL;
  }

  dt_control_merge_hdr_t d = (dt_control_merge_hdr_t){.epsw = 1e-8f, .abort = FALSE };

  // the alignment's tuning is darktable's, from its preferences
  // (darktableconfig.xml.in); whether to align is the caller's
  d.align_enabled = align;
  if(d.align_enabled)
  {
    dt_hdr_align_params_t align_params;
    dt_hdr_alignment_default_params(&align_params);
    align_params.proxy_scale = dt_conf_get_float("plugins/lighttable/hdr_merge_proxy_scale");
    align_params.feature_gamma = dt_conf_get_float("plugins/lighttable/hdr_merge_feature_gamma");
    align_params.clahe_clip = dt_conf_get_float("plugins/lighttable/hdr_merge_clahe_clip");
    align_params.sift_keypoints = dt_conf_get_int("plugins/lighttable/hdr_merge_sift_keypoints");
    align_params.debug_images = dt_conf_get_bool("plugins/lighttable/hdr_merge_debug_images");
    d.align = dt_hdr_alignment_new(&align_params);
    if(!d.align)
      d.align_enabled = FALSE;
  }

  dt_imageio_module_format_t buf = (dt_imageio_module_format_t)
    {.mime = _control_merge_hdr_mime,
     .levels = _control_merge_hdr_levels,
     .bpp = _control_merge_hdr_bpp,
     .write_image = _control_merge_hdr_process };

  dt_control_merge_hdr_format_t dat =
    (dt_control_merge_hdr_format_t){.parent = { 0 }, .d = &d };

  // Auto-reference pre-pass: probe every frame's feature richness and move the
  // richest one to the front, so it becomes both the geometry seed and the
  // alignment reference. Costs one extra decode pass, hence opt-in.
  if(d.align_enabled && dt_conf_get_bool("plugins/lighttable/hdr_merge_auto_reference"))
  {
    d.probe_mode = TRUE;
    d.probe_best_count = -1;
    d.probe_best_imgid = NO_IMGID;
    int pnum = 1;
    for(GList *p = t; p && !d.abort; p = g_list_next(p))
      _merge_frame(GPOINTER_TO_INT(p->data), &buf, &dat, pnum++, total);
    d.probe_mode = FALSE;
    if(d.abort) goto end;
    if(dt_is_valid_imgid(d.probe_best_imgid))
    {
      t = g_list_remove(t, GINT_TO_POINTER(d.probe_best_imgid));
      t = g_list_prepend(t, GINT_TO_POINTER(d.probe_best_imgid));
      dt_print(DT_DEBUG_HDR_MERGE,
               "[hdr merge] auto-reference: imgid %d selected (%d features)",
               d.probe_best_imgid, d.probe_best_count);
    }
  }

  int num = 1;
  for(GList *p = t; p && !d.abort; p = g_list_next(p))
    _merge_frame(GPOINTER_TO_INT(p->data), &buf, &dat, num++, total);

  if(d.abort) goto end;
  if(!d.pixels)
  {
    d.err = g_strdup("the photos could not be read");
    goto end;
  }

// normalize by white level to make clipping at 1.0 work as expected

  DT_OMP_FOR(shared(d))
  for(size_t k = 0; k < (size_t)d.wd * d.ht; k++)
  {
    if(d.weight[k] > 0.0)
      d.pixels[k] = fmaxf(0.0f, d.pixels[k] / (d.whitelevel * d.weight[k]));
  }

  // output hdr as digital negative with exif data.
  uint8_t *exif = NULL;
  char pathname[PATH_MAX] = { 0 };
  gboolean from_cache = TRUE;
  dt_image_full_path(d.first_imgid, pathname, sizeof(pathname), &from_cache);

  // last param is dng mode
  const int exif_len = dt_exif_read_blob(&exif, pathname, d.first_imgid, FALSE, d.wd, d.ht, TRUE);
  char *c = pathname + strlen(pathname);
  while(*c != '.' && c > pathname) c--;
  const size_t free_space = sizeof(pathname) - (c - pathname);

  // don't overwrite an existing merge: append a numeric suffix
  // (-hdr_01.dng, -hdr_02.dng, ...) until we find a free filename,
  // matching the behavior of export and raw denoise
  g_strlcpy(c, "-hdr.dng", free_space);
  for(int seq = 1; g_file_test(pathname, G_FILE_TEST_EXISTS); seq++)
    snprintf(c, free_space, "-hdr_%02d.dng", seq);

  // written under another name and renamed once whole, so a folder read
  // meanwhile never imports half of it, as the engine's AI denoise does.
  // the writer reports no failure, so the file's being there is the test
  gchar *part = g_strdup_printf("%s.part", pathname);
  dt_imageio_dng_write_float(part,
                             d.pixels,
                             d.wd,
                             d.ht,
                             exif,
                             exif_len,
                             d.first_filter,
                             (const uint8_t (*)[6])d.first_xtrans,
                             1.0f,
                             (const float (*))d.wb_coeffs,
                             d.adobe_XYZ_to_CAM);
  free(exif);
  if(!g_file_test(part, G_FILE_TEST_IS_REGULAR) || g_rename(part, pathname))
  {
    g_unlink(part);
    d.err = g_strdup_printf("cannot write %s", pathname);
  }
  else
    result = g_strdup(pathname);
  g_free(part);

end:
  free(d.pixels);
  free(d.weight);
  if(d.aligned_buf) dt_free_align(d.aligned_buf);
  if(d.align) dt_hdr_alignment_free(d.align);
  g_list_free(t);
  if(!result)
    *err = d.err ? d.err : g_strdup("merging to HDR failed");
  else
    g_free(d.err);
  return result;
}

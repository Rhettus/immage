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

// AI masks, Select Objects, depth and raw denoise, over darktable's segmentation and restore libraries

#include "engine.h"

// the image as shown, about `size` across, as 8-bit RGB (the AI models'
// input, and the spot tool's search). `color`: without the color
// equalizer, which is the app's black and white, so the models still see
// a black and white photo's sky and foliage in color
uint8_t *ai_shown_rgb(const int size, const gboolean color, int *w, int *h, char **err)
{
  if(!session_ppipe_ready(err)) return NULL;
  _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  const double scale = fmin(1.0, (double)size / MAX(pw, ph));
  // off for this render alone: the cache leaves out a piece whose module
  // and piece are both off (pixelpipe_cache.c), so its lines are this
  // render's own, and the next sync takes the piece from the history again
  GList *off = NULL;
  for(GList *n = color ? _s.ppipe.nodes : NULL; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *pc = n->data;
    if(!g_strcmp0(pc->module->op, "colorequal") && pc->enabled)
    {
      pc->enabled = FALSE;
      pc->module->enabled = FALSE;
      off = g_list_prepend(off, pc);
    }
  }
  const gboolean failed = dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, 0, 0, MAX(1, floor(scale * pw)),
                                                   MAX(1, floor(scale * ph)), scale, DT_DEVICE_NONE);
  for(GList *l = off; l; l = g_list_next(l))
  {
    dt_dev_pixelpipe_iop_t *pc = l->data;
    pc->enabled = TRUE;
    pc->module->enabled = TRUE;
  }
  g_list_free(off);
  if(failed || !_s.ppipe.backbuf)
  {
    *err = g_strdup("could not render the image for the model");
    return NULL;
  }
  *w = _s.ppipe.backbuf_width;
  *h = _s.ppipe.backbuf_height;
  const size_t n = (size_t)*w * *h;
  uint8_t *rgb = g_malloc(3 * n);
  const uint8_t *in = _s.ppipe.backbuf;  // BGRA
  for(size_t k = 0; k < n; k++)
  {
    rgb[3 * k + 0] = in[4 * k + 2];
    rgb[3 * k + 1] = in[4 * k + 1];
    rgb[3 * k + 2] = in[4 * k + 0];
  }
  return rgb;
}

#ifdef HAVE_AI
// --------------------------------------------------------------- AI masks
// Lightroom's Select Objects: darktable's segmentation (SAM) on the image as
// edited, prompted with clicks or a box, vectorized into path shapes the way
// darktable's object mask does it (masks/object.c). the paths go to the
// client, which sends them back as an "object" component of a mask, so the
// model runs only on a click
const char *ai_models_dir = NULL;
static dt_ai_environment_t *_ai_env = NULL;
static dt_seg_context_t *_seg = NULL;
// the photo encoded, NO_IMGID while none is
static dt_imgid_t _seg_imgid = NO_IMGID;
static int _seg_w = 0, _seg_h = 0;
static int _seg_pw = 0, _seg_ph = 0;  // the image size the encoding was made at
// the models' last results (_seg_*, _mask_cache), which the AI thread
// (ai_run) makes and the main loop looks at, to tell whether a request
// needs the photo rendered for its model
static GMutex _ai_cache_lock;
// when a selection last asked for a model (g_get_monotonic_time()), and
// the use its models were last released after (_ai_release)
static gint64 _ai_used = 0, _ai_released = 0;

// an AI selection, as the main loop hands it to the AI thread
typedef struct _ai_job_t
{
  gint64 tag;
  JsonObject *req;
  int kind;          // in _mask_kinds, or -1 for an object
  gboolean map;      // ai_depth: the depth map itself
  dt_imgid_t imgid;
  int pw, ph;        // the image's size, which the model's result holds for
  uint8_t *rgb;      // the model's input, unless its last result holds
  int w, h;
  GBytes *guide;     // the photo at _TRACE_SIZE, which outlines are traced at
  int gw, gh;
  float *hues;       // the request's `backdrop`: _hue_map() at half the guide's size
  int hw, hh;
} _ai_job_t;

// outlines are traced at this size, about twice the models' own, against
// the photo rendered at it (_snap_edges). it is kept for the image at its
// size as the models' results are, and the models' inputs are made from it
#define _TRACE_SIZE 2048
static struct { GBytes *rgb; int w, h, pw, ph; dt_imgid_t imgid; } _guide = { NULL, 0, 0, 0, 0, NO_IMGID };

#define _SEG_MODEL "mask-object-sam21-small"
// how far _snap_edges() may move an object's outline, in pixels at
// _TRACE_SIZE: a cell of SAM's 256 decoder grid there is 8
#define _SEG_SNAP 6.0f

// the models run on the CPU: ONNX Runtime's CoreML provider compiles each
// model for the Neural Engine on load, which took minutes for BiRefNet and
// hung for good when two engines loaded at once
static dt_ai_environment_t *_ai_env_new(void)
{
  dt_ai_environment_t *env = dt_ai_env_init(ai_models_dir);
  if(env) dt_ai_env_set_provider(env, DT_AI_PROVIDER_CPU);
  return env;
}
#define _SEG_SIZE 1024

// the input a result was made from is gone once a job for another photo or
// size has replaced it, as when the photo is switched while a model runs
static gboolean _ai_input(const _ai_job_t *job, char **err)
{
  if(job->rgb) return TRUE;
  *err = g_strdup("the photo changed while the model ran");
  return FALSE;
}

static gboolean _seg_ready(const _ai_job_t *job, char **err)
{
  if(!_ai_env) _ai_env = _ai_env_new();
  // the model may have been downloaded since the folder was last looked at
  if(!_seg && _ai_env)
  {
    g_mutex_lock(&export_ai_load_lock);
    dt_ai_env_refresh(_ai_env);
    dt_ai_models_refresh_status();
    _seg = dt_seg_load(_ai_env, _SEG_MODEL);
    g_mutex_unlock(&export_ai_load_lock);
  }
  if(!_seg)
  {
    *err = g_strdup_printf("cannot load the '%s' model from %s", _SEG_MODEL, ai_models_dir);
    return FALSE;
  }
  // the encoding holds for this image at this size; color edits do not
  // move objects, geometry edits do
  g_mutex_lock(&_ai_cache_lock);
  const gboolean held = _seg_imgid == job->imgid && job->pw == _seg_pw && job->ph == _seg_ph;
  g_mutex_unlock(&_ai_cache_lock);
  if(held) return TRUE;
  if(!_ai_input(job, err)) return FALSE;
  g_mutex_lock(&_ai_cache_lock);
  _seg_imgid = NO_IMGID;
  g_mutex_unlock(&_ai_cache_lock);
  dt_seg_reset_encoding(_seg);
  if(!dt_seg_encode_image(_seg, job->rgb, job->w, job->h))
  {
    *err = g_strdup("the model could not encode the image");
    return FALSE;
  }
  g_mutex_lock(&_ai_cache_lock);
  _seg_imgid = job->imgid;
  _seg_w = job->w;
  _seg_h = job->h;
  _seg_pw = job->pw;
  _seg_ph = job->ph;
  g_mutex_unlock(&_ai_cache_lock);
  return TRUE;
}

// a sw x sh grid of values spread over the image, scaled smoothly to w x h
static float *_resample(const float *src, const int sw, const int sh, const int w, const int h)
{
  float *p = g_malloc((size_t)w * h * sizeof(float));
  DT_OMP_FOR()
  for(int j = 0; j < h; j++)
    for(int i = 0; i < w; i++)
    {
      const float gx = (i + 0.5f) * sw / w - 0.5f, gy = (j + 0.5f) * sh / h - 0.5f;
      const int x0 = CLAMP((int)floorf(gx), 0, sw - 1), y0 = CLAMP((int)floorf(gy), 0, sh - 1);
      const int x1 = MIN(x0 + 1, sw - 1), y1 = MIN(y0 + 1, sh - 1);
      const float ax = CLAMP(gx - x0, 0.0f, 1.0f), ay = CLAMP(gy - y0, 0.0f, 1.0f);
      p[(size_t)j * w + i] = (1 - ay) * ((1 - ax) * src[y0 * sw + x0] + ax * src[y0 * sw + x1])
                           + ay * ((1 - ax) * src[y1 * sw + x0] + ax * src[y1 * sw + x1]);
    }
  return p;
}

// the guide's RGB averaged down to fit `size` across, as ai_shown_rgb() would
// have rendered it
static uint8_t *_shrink_rgb(const uint8_t *in, const int W, const int H, const int size, int *w, int *h)
{
  const double scale = fmin(1.0, (double)size / MAX(W, H));
  *w = MAX(1, (int)floor(scale * W));
  *h = MAX(1, (int)floor(scale * H));
  const int ow = *w, oh = *h;
  uint8_t *out = g_malloc((size_t)3 * ow * oh);
  DT_OMP_FOR()
  for(int j = 0; j < oh; j++)
  {
    const int y0 = (int)((double)j * H / oh), y1 = MAX(y0 + 1, (int)((double)(j + 1) * H / oh));
    for(int i = 0; i < ow; i++)
    {
      const int x0 = (int)((double)i * W / ow), x1 = MAX(x0 + 1, (int)((double)(i + 1) * W / ow));
      int s[3] = { 0, 0, 0 };
      for(int y = y0; y < y1; y++)
        for(int x = x0; x < x1; x++)
          for(int c = 0; c < 3; c++) s[c] += in[3 * ((size_t)y * W + x) + c];
      const int n = (y1 - y0) * (x1 - x0);
      for(int c = 0; c < 3; c++) out[3 * ((size_t)j * ow + i) + c] = (s[c] + n / 2) / n;
    }
  }
  return out;
}

// the mean over a (2r+1)^2 window, in place, of the pixels inside the image
static void _box_mean(float *const buf, float *const tmp, const int w, const int h, const int r)
{
  DT_OMP_FOR()
  for(int y = 0; y < h; y++)
  {
    const float *in = buf + (size_t)y * w;
    float *out = tmp + (size_t)y * w;
    double s = 0.0;
    for(int x = 0; x <= MIN(r, w - 1); x++) s += in[x];
    for(int x = 0; x < w; x++)
    {
      out[x] = s / (MIN(w - 1, x + r) - MAX(0, x - r) + 1);
      if(x + r + 1 < w) s += in[x + r + 1];
      if(x - r >= 0) s -= in[x - r];
    }
  }
  DT_OMP_FOR()
  for(int x = 0; x < w; x++)
  {
    double s = 0.0;
    for(int y = 0; y <= MIN(r, h - 1); y++) s += tmp[(size_t)y * w + x];
    for(int y = 0; y < h; y++)
    {
      buf[(size_t)y * w + x] = s / (MIN(h - 1, y + r) - MAX(0, y - r) + 1);
      if(y + r + 1 < h) s += tmp[(size_t)(y + r + 1) * w + x];
      if(y - r >= 0) s -= tmp[(size_t)(y - r) * w + x];
    }
  }
}

// a model's probabilities (w x h, the guide's size) moved onto the photo's
// own edges: a guided filter (He, Sun and Tang) with the photo's luminance
// as the guide, so the 0.5 the outline is traced at falls on an edge. it
// changes only the band where the model is unsure, widened by `radius`:
// elsewhere the model's value stays. darktable's feathering (Edge Aware)
// filters the whole mask instead, which reaches edges far from the
// outline and leaves halos at weak ones
static void _snap_edges(float *p, const int w, const int h, const uint8_t *guide, const float radius)
{
  const int r = MAX(1, (int)lroundf(radius));
  const size_t n = (size_t)w * h;
  float *I = g_malloc(n * sizeof(float)), *mI = g_malloc(n * sizeof(float)), *mp = g_malloc(n * sizeof(float));
  float *mIp = g_malloc(n * sizeof(float)), *mII = g_malloc(n * sizeof(float));
  float *band = g_malloc(n * sizeof(float)), *tmp = g_malloc(n * sizeof(float));
  DT_OMP_FOR()
  for(size_t k = 0; k < n; k++)
  {
    I[k] = (0.2126f * guide[3 * k] + 0.7152f * guide[3 * k + 1] + 0.0722f * guide[3 * k + 2]) / 255.0f;
    mI[k] = I[k];
    mp[k] = p[k];
    mIp[k] = I[k] * p[k];
    mII[k] = I[k] * I[k];
    band[k] = p[k] > 0.02f && p[k] < 0.98f;
  }
  _box_mean(mI, tmp, w, h, r);
  _box_mean(mp, tmp, w, h, r);
  _box_mean(mIp, tmp, w, h, r);
  _box_mean(mII, tmp, w, h, r);
  _box_mean(band, tmp, w, h, r);
  // eps sets how strong an edge must be to hold the outline: about 3% of
  // the luminance range, as a standard deviation
  const float eps = 1e-3f;
  DT_OMP_FOR()
  for(size_t k = 0; k < n; k++)
  {
    const float a = (mIp[k] - mI[k] * mp[k]) / (mII[k] - mI[k] * mI[k] + eps);
    mIp[k] = a;
    mII[k] = mp[k] - a * mI[k];
  }
  _box_mean(mIp, tmp, w, h, r);
  _box_mean(mII, tmp, w, h, r);
  DT_OMP_FOR()
  for(size_t k = 0; k < n; k++)
    if(band[k] > 0.0f) p[k] = CLAMP(mIp[k] * I[k] + mII[k], 0.0f, 1.0f);
  g_free(I);
  g_free(mI);
  g_free(mp);
  g_free(mIp);
  g_free(mII);
  g_free(band);
  g_free(tmp);
}

// a mask's probabilities (w x h) as the paths _ai_object() replies with
static void _paths_json(JsonBuilder *b, const char *member, float *mask, const int mw, const int mh)
{
  const size_t len = (size_t)mw * mh;
  // ras2forms traces where the mask is below the threshold, so it gets
  // the mask inverted, as object.c gives it
  for(size_t k = 0; k < len; k++) mask[k] = 1.0f - mask[k];
  GList *signs = NULL;
  // specks under the area potrace's default leaves out at 1024 pixels
  // across, the size the models' outlines were traced at before
  const double across = MAX(mw, mh) / 1024.0;
  GList *forms = ras2forms(mask, mw, mh, NULL, 0.5f, MAX(1, (int)lround(50.0 * across * across)), 1.0, &signs);
  json_builder_set_member_name(b, member);
  json_builder_begin_array(b);
  GList *sg = signs;
  for(GList *l = forms; l; l = g_list_next(l), sg = sg ? g_list_next(sg) : NULL)
  {
    const dt_masks_form_t *f = l->data;
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "hole");
    json_builder_add_boolean_value(b, sg && GPOINTER_TO_INT(sg->data) == '-');
    json_builder_set_member_name(b, "points");
    json_builder_begin_array(b);
    for(const GList *p = f->points; p; p = g_list_next(p))
    {
      const dt_masks_point_path_t *pt = p->data;
      json_builder_begin_array(b);
      json_builder_add_double_value(b, pt->corner[0] / mw);
      json_builder_add_double_value(b, pt->corner[1] / mh);
      json_builder_add_double_value(b, pt->ctrl1[0] / mw);
      json_builder_add_double_value(b, pt->ctrl1[1] / mh);
      json_builder_add_double_value(b, pt->ctrl2[0] / mw);
      json_builder_add_double_value(b, pt->ctrl2[1] / mh);
      json_builder_end_array(b);
    }
    json_builder_end_array(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  g_list_free_full(forms, (GDestroyNotify)dt_masks_free_form);
  g_list_free(signs);
}

// the selection (p >= 0.5) shrunk by `r` pixels, as 0 or 1, in place.
// beyond the image counts as inside, so a sky reaching the frame's edge
// keeps it
static void _inset(float *p, const int w, const int h, const float r)
{
  const int R = (int)ceilf(r);
  GArray *disc = g_array_new(FALSE, FALSE, sizeof(int) * 2);
  for(int dy = -R; dy <= R; dy++)
    for(int dx = -R; dx <= R; dx++)
      if((dx || dy) && dx * dx + dy * dy <= r * r) g_array_append_val(disc, ((int[2]){ dx, dy }));
  const int *d = (const int *)disc->data;
  const int nd = disc->len;
  uint8_t *in = g_malloc((size_t)w * h);
  for(size_t k = 0; k < (size_t)w * h; k++) in[k] = p[k] >= 0.5f;
  DT_OMP_FOR()
  for(int y = 0; y < h; y++)
    for(int x = 0; x < w; x++)
    {
      gboolean keep = in[(size_t)y * w + x];
      for(int k = 0; keep && k < nd; k++)
      {
        const int u = x + d[2 * k], v = y + d[2 * k + 1];
        if(u >= 0 && u < w && v >= 0 && v < h && !in[(size_t)v * w + u]) keep = FALSE;
      }
      p[(size_t)y * w + x] = keep ? 1.0f : 0.0f;
    }
  g_free(in);
  g_array_free(disc, TRUE);
}

// probabilities at the guide's size, snapped to its edges by `snap`
// pixels at _TRACE_SIZE, traced into the reply's paths. darktable feathers
// a path outward only, fading linearly (path.c), so a selection the mask
// adds (the request's `inset`, by default) is traced half a default
// feather inside its edge: the mask is about half on there, as a soft
// matte's edge is. traced on the edge, the feather carried the adjustment
// into the background around it; a whole feather inside, the subject's
// own rim, its crest or a beak's edge, was left out. a selection the mask
// takes away, or inverts (Background), is traced on its edge, its feather
// already falling on the side that is selected
static gboolean _backdrop(const _ai_job_t *job, const float *p, JsonBuilder *b);

static void _trace_json(const _ai_job_t *job, JsonBuilder *b, float *p, const float snap, const gboolean add)
{
  if(snap > 0.0f)
    _snap_edges(p, job->gw, job->gh, g_bytes_get_data(job->guide, NULL),
                snap * MAX(job->gw, job->gh) / _TRACE_SIZE);
  // with a backdrop's edge outline as well, a whole feather inside, so its
  // feather ends at the edge (_object_shapes)
  if(add && json_object_get_boolean_member_with_default(job->req, "inset", TRUE))
  {
    const gboolean bd = job->hues && _backdrop(job, p, b);
    _inset(p, job->gw, job->gh, (bd ? 1.0f : 0.5f) * _OBJECT_FEATHER * MIN(job->gw, job->gh));
  }
  _paths_json(b, "paths", p, job->gw, job->gh);
}

// select an object: `points` [[x, y, include], ...] and/or `box`
// [x0, y0, x1, y1], in shown-image units. replies with its outline as
// paths, each a list of [x, y, c1x, c1y, c2x, c2y] corners, holes marked
static gboolean _ai_object(const _ai_job_t *job, JsonBuilder *b, char **err)
{
  if(!_seg_ready(job, err)) return FALSE;
  JsonObject *req = job->req;
  JsonArray *pts = json_object_has_member(req, "points") ? json_object_get_array_member(req, "points") : NULL;
  JsonArray *box = json_object_has_member(req, "box") ? json_object_get_array_member(req, "box") : NULL;
  const guint np = pts ? json_array_get_length(pts) : 0;
  dt_seg_point_t *sp = g_new0(dt_seg_point_t, np + 2);
  int n = 0;
  for(guint k = 0; k < np; k++)
  {
    JsonArray *p = json_array_get_array_element(pts, k);
    sp[n].x = json_array_get_double_element(p, 0) * _seg_w;
    sp[n].y = json_array_get_double_element(p, 1) * _seg_h;
    sp[n].label = json_array_get_length(p) > 2 && json_array_get_double_element(p, 2) == 0.0 ? 0 : 1;
    n++;
  }
  if(box && json_array_get_length(box) == 4 && dt_seg_supports_box(_seg))
  {
    sp[n++] = (dt_seg_point_t){ json_array_get_double_element(box, 0) * _seg_w,
                                json_array_get_double_element(box, 1) * _seg_h, 2 };
    sp[n++] = (dt_seg_point_t){ json_array_get_double_element(box, 2) * _seg_w,
                                json_array_get_double_element(box, 3) * _seg_h, 3 };
  }
  if(!n)
  {
    g_free(sp);
    *err = g_strdup("no prompt: give points or a box");
    return FALSE;
  }
  dt_seg_reset_prev_mask(_seg);
  int mw = 0, mh = 0;
  float *mask = dt_seg_compute_mask(_seg, sp, n, &mw, &mh);
  g_free(sp);
  if(!mask)
  {
    *err = g_strdup("the model produced no mask");
    return FALSE;
  }
  float *p = _resample(mask, mw, mh, job->gw, job->gh);
  g_free(mask);
  _trace_json(job, b, p, _SEG_SNAP, TRUE);
  g_free(p);
  return TRUE;
}

// one-click masks (Lightroom's Select Subject and friends): a model that
// labels every pixel, run on the image as shown, its result vectorized
// like an object's. each model sits in the models folder in darktable's
// layout (<id>/config.json, model.onnx)
typedef struct _mask_model_t
{
  const char *id;       // the model's folder and config id
  int size;             // square input, in pixels
  float mean[3], std[3];
  // a scene model's output: `classes` class scores on an out x out grid.
  // without classes, one logit per input pixel
  int classes, out;
  // a depth model's output instead: one relative disparity per input pixel
  gboolean depth;
  // how far _snap_edges() may move the outline, in pixels at _TRACE_SIZE:
  // about the model's output cell there
  float snap;
} _mask_model_t;

#define _IMAGENET { 0.485f, 0.456f, 0.406f }, { 0.229f, 0.224f, 0.225f }
static const _mask_model_t _mask_models[] = {
  // BiRefNet lite: the salient object
  { "mask-subject-birefnet-lite", 1024, _IMAGENET, 0, 0, FALSE, 4.0f },
  // SegFormer B2 on ADE20K: 150 classes at a quarter of its input. it takes
  // any input size; 1024 rather than its 512 halves its cells' size
  { "mask-scene-segformer-b2", 768, _IMAGENET, 150, 192, FALSE, 11.0f },
  // Depth Anything V2 small: relative depth, at a multiple of its 14px patch
  { "mask-depth-da2-small", 518, _IMAGENET, 0, 0, TRUE, 0.0f },
};

// what the client asks for: a model, and for a scene model the ADE20K
// classes that make it up (their numbers from the model's id2label; -1
// ends the list), grouped as Lightroom's Landscape choices are
typedef struct _mask_kind_t
{
  const char *kind;
  int model;
  int pick[16];
} _mask_kind_t;

static const _mask_kind_t _mask_kinds[] = {
  { "subject", 0, { -1 } },
  { "sky", 1, { 2, -1 } },
  { "people", 1, { 12, -1 } },
  // water, sea, river, lake, waterfall, fountain, swimming pool
  { "water", 1, { 21, 26, 60, 128, 113, 104, 109, -1 } },
  // tree, grass, plant, flower, palm, field
  { "vegetation", 1, { 4, 9, 17, 66, 72, 29, -1 } },
  // mountain, hill
  { "mountains", 1, { 16, 68, -1 } },
  // earth, rock, sand, land, dirt track
  { "ground", 1, { 13, 34, 46, 94, 91, -1 } },
  // wall, building, house, skyscraper, tower, bridge, hovel, column, fence,
  // awning
  { "architecture", 1, { 0, 1, 25, 48, 84, 61, 79, 42, 32, 86, -1 } },
  // floor, road, sidewalk, path, runway, stairs, stairway, step, pier
  { "artificial_ground", 1, { 3, 6, 11, 52, 54, 53, 59, 121, 140, -1 } },
  // Depth Range: a band of the depth map, given with the request
  { "depth", 2, { -1 } },
};

static dt_ai_context_t *_mask_ctx[G_N_ELEMENTS(_mask_models)] = { NULL };
// the last result, per model: per-pixel probabilities on the model's grid
// (each class's softmax share, the one sigmoid, or depth from 0, the
// nearest, to 1, the farthest), and the render's size.
// a run takes seconds on the CPU, and Background after Subject, or Water
// after Sky, asks the same again. it holds for the image at its size, as
// an object's encoding does; color edits do not move it
static struct { float *p; int w, h, pw, ph; dt_imgid_t imgid; } _mask_cache[G_N_ELEMENTS(_mask_models)];

static int _float_cmp(const void *a, const void *b)
{
  const float x = *(const float *)a, y = *(const float *)b;
  return (x > y) - (x < y);
}

// the model's output for the image as shown, rendered about `size` across
// (W x H): C planes of O x O probabilities, 0-1
static float *_mask_probability(const _mask_model_t *mm, dt_ai_context_t *ctx, const uint8_t *rgb,
                                const int W, const int H, char **err)
{
  const int S = mm->size;
  // stretched to the model's square, normalized, planar
  float *in = g_malloc((size_t)3 * S * S * sizeof(float));
  for(int j = 0; j < S; j++)
    for(int i = 0; i < S; i++)
    {
      const float fx = (i + 0.5f) * W / S - 0.5f, fy = (j + 0.5f) * H / S - 0.5f;
      const int x0 = CLAMP((int)floorf(fx), 0, W - 1), y0 = CLAMP((int)floorf(fy), 0, H - 1);
      const int x1 = MIN(x0 + 1, W - 1), y1 = MIN(y0 + 1, H - 1);
      const float ax = CLAMP(fx - x0, 0.0f, 1.0f), ay = CLAMP(fy - y0, 0.0f, 1.0f);
      for(int c = 0; c < 3; c++)
      {
        const float v = (1 - ay) * ((1 - ax) * rgb[3 * (y0 * W + x0) + c] + ax * rgb[3 * (y0 * W + x1) + c])
                      + ay * ((1 - ax) * rgb[3 * (y1 * W + x0) + c] + ax * rgb[3 * (y1 * W + x1) + c]);
        in[(size_t)c * S * S + (size_t)j * S + i] = (v / 255.0f - mm->mean[c]) / mm->std[c];
      }
    }
  const int C = mm->classes ? mm->classes : 1, O = mm->classes ? mm->out : S;
  float *out = g_malloc((size_t)C * O * O * sizeof(float));
  int64_t ishape[4] = { 1, 3, S, S }, oshape[4] = { 1, C, O, O }, dshape[3] = { 1, S, S };
  dt_ai_tensor_t ti = { in, DT_AI_FLOAT, ishape, 4 };
  dt_ai_tensor_t to = mm->depth ? (dt_ai_tensor_t){ out, DT_AI_FLOAT, dshape, 3 }
                                : (dt_ai_tensor_t){ out, DT_AI_FLOAT, oshape, 4 };
  const int rc = dt_ai_run(ctx, &ti, 1, &to, 1);
  g_free(in);
  if(rc)
  {
    g_free(out);
    *err = g_strdup_printf("the '%s' model failed to run", mm->id);
    return NULL;
  }
  const size_t plane = (size_t)O * O;
  if(mm->depth)
  {
    // disparity, larger when nearer, spread over 0-1 between its 1st and
    // 99th percentiles so a stray pixel does not squeeze the range, and
    // flipped so 0 is the nearest
    float *sorted = g_malloc(plane * sizeof(float));
    memcpy(sorted, out, plane * sizeof(float));
    qsort(sorted, plane, sizeof(float), _float_cmp);
    // not "near" and "far": windows.h defines both as empty macros
    const float nearest = sorted[(size_t)(0.99 * (plane - 1))], farthest = sorted[(size_t)(0.01 * (plane - 1))];
    g_free(sorted);
    const float span = fmaxf(nearest - farthest, 1e-6f);
    for(size_t q = 0; q < plane; q++) out[q] = CLAMP((nearest - out[q]) / span, 0.0f, 1.0f);
    return out;
  }
  // a sigmoid of the one logit, or each class's softmax share, in place
  for(size_t q = 0; q < plane; q++)
  {
    if(!mm->classes)
    {
      out[q] = 1.0f / (1.0f + expf(-out[q]));
      continue;
    }
    float top = -INFINITY;
    for(int c = 0; c < C; c++) top = fmaxf(top, out[c * plane + q]);
    float sum = 0.0f;
    for(int c = 0; c < C; c++) sum += out[c * plane + q] = expf(out[c * plane + q] - top);
    for(int c = 0; c < C; c++) out[c * plane + q] /= sum;
  }
  return out;
}

// a kind's probability at w x h, from its model's cached output: the sum
// of its classes per grid cell, scaled up smoothly, as a coarse grid would
// show as steps
static float *_mask_kind_probability(const _mask_kind_t *mk, const int w, const int h)
{
  const _mask_model_t *mm = &_mask_models[mk->model];
  const float *out = _mask_cache[mk->model].p;
  const int O = mm->classes ? mm->out : mm->size;
  const size_t plane = (size_t)O * O;
  float *grid = g_malloc0(plane * sizeof(float));
  if(!mm->classes)
    memcpy(grid, out, plane * sizeof(float));
  else
    for(int k = 0; k < 16 && mk->pick[k] >= 0; k++)
      for(size_t q = 0; q < plane; q++) grid[q] += out[mk->pick[k] * plane + q];
  float *p = _resample(grid, O, O, w, h);
  g_free(grid);
  for(size_t q = 0; q < (size_t)w * h; q++) p[q] = MIN(1.0f, p[q]);
  return p;
}

// the job's kind, its model's output for the image as shown cached
static const _mask_kind_t *_mask_run(const _ai_job_t *job, char **err)
{
  const _mask_kind_t *mk = &_mask_kinds[job->kind];
  const int k = mk->model;
  const _mask_model_t *mm = &_mask_models[k];
  if(!_ai_env) _ai_env = _ai_env_new();
  if(!_mask_ctx[k] && _ai_env)
  {
    g_mutex_lock(&export_ai_load_lock);
    dt_ai_env_refresh(_ai_env);
    _mask_ctx[k] = dt_ai_load_model(_ai_env, mm->id, NULL, DT_AI_PROVIDER_CPU);
    g_mutex_unlock(&export_ai_load_lock);
  }
  if(!_mask_ctx[k])
  {
    *err = g_strdup_printf("cannot load the '%s' model from %s", mm->id, ai_models_dir);
    return NULL;
  }
  g_mutex_lock(&_ai_cache_lock);
  const gboolean held = _mask_cache[k].p && _mask_cache[k].imgid == job->imgid
                        && _mask_cache[k].pw == job->pw && _mask_cache[k].ph == job->ph;
  g_mutex_unlock(&_ai_cache_lock);
  if(!held)
  {
    if(!_ai_input(job, err)) return NULL;
    float *p = _mask_probability(mm, _mask_ctx[k], job->rgb, job->w, job->h, err);
    if(!p) return NULL;
    // only this thread reads the probabilities: the main loop looks at the
    // rest
    g_mutex_lock(&_ai_cache_lock);
    g_free(_mask_cache[k].p);
    _mask_cache[k].p = p;
    _mask_cache[k].w = job->w;
    _mask_cache[k].h = job->h;
    _mask_cache[k].pw = job->pw;
    _mask_cache[k].ph = job->ph;
    _mask_cache[k].imgid = job->imgid;
    g_mutex_unlock(&_ai_cache_lock);
  }
  return mk;
}

// `range` [near, far] picks a band of a depth kind, 0-1 from the nearest
static gboolean _ai_mask(const _ai_job_t *job, JsonBuilder *b, char **err)
{
  const _mask_kind_t *mk = _mask_run(job, err);
  if(!mk) return FALSE;
  JsonArray *range = json_object_has_member(job->req, "range") ? json_object_get_array_member(job->req, "range") : NULL;
  const _mask_model_t *mm = &_mask_models[mk->model];
  const int w = job->gw, h = job->gh;
  float *p = _mask_kind_probability(mk, w, h);
  if(mm->depth)
  {
    // in the band or not, as a ramp steep enough to trace sharply, and
    // open at either end the band reaches
    const float lo = range && json_array_get_length(range) == 2 ? json_array_get_double_element(range, 0) : 0.0f;
    const float hi = range && json_array_get_length(range) == 2 ? json_array_get_double_element(range, 1) : 1.0f;
    const float l = lo <= 0.0f ? -1.0f : lo, r = hi >= 1.0f ? 2.0f : hi;
    for(size_t q = 0; q < (size_t)w * h; q++)
      p[q] = CLAMP(0.5f + 50.0f * fminf(p[q] - l, r - p[q]), 0.0f, 1.0f);
  }
  // a Depth Range keeps its band's own feather, and its edge
  _trace_json(job, b, p, mm->snap, !mm->depth);
  g_free(p);
  return TRUE;
}

// the depth map, about `size` across, as 0 (nearest) to 255 by rows: for
// the client to preview a band and pick a depth without a round trip
static gboolean _ai_depth(const _ai_job_t *job, JsonBuilder *b, char **err)
{
  const _mask_kind_t *mk = _mask_run(job, err);
  if(!mk) return FALSE;
  const int size = json_object_get_int_member_with_default(job->req, "size", 256);
  const int W = _mask_cache[mk->model].w, H = _mask_cache[mk->model].h;
  const double scale = fmin(1.0, (double)size / MAX(W, H));
  const int w = MAX(1, (int)round(W * scale)), h = MAX(1, (int)round(H * scale));
  float *p = _mask_kind_probability(mk, w, h);
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, h);
  json_builder_set_member_name(b, "data");
  json_builder_begin_array(b);
  for(size_t q = 0; q < (size_t)w * h; q++) json_builder_add_int_value(b, lroundf(255.0f * p[q]));
  json_builder_end_array(b);
  g_free(p);
  return TRUE;
}

static void _ai_job_free(_ai_job_t *job)
{
  json_object_unref(job->req);
  g_free(job->rgb);
  g_free(job->hues);
  if(job->guide) g_bytes_unref(job->guide);
  g_free(job);
}

// the main loop's part of an AI selection: what the model needs of the
// open photo, which is its render when the model's last result does not
// hold for it
static float *_hue_map(const int w, const int h, char **err);

static _ai_job_t *_ai_job(JsonObject *req, char **err)
{
  const char *cmd = json_object_get_string_member_with_default(req, "cmd", "");
  int kind = -1;
  if(g_strcmp0(cmd, "ai_object"))
  {
    const char *name = !g_strcmp0(cmd, "ai_depth") ? "depth" : json_object_get_string_member_with_default(req, "kind", NULL);
    for(int i = 0; i < (int)G_N_ELEMENTS(_mask_kinds); i++)
      if(!g_strcmp0(_mask_kinds[i].kind, name)) kind = i;
    if(kind < 0)
    {
      *err = g_strdup_printf("no model for '%s'", name ? name : "(none)");
      return NULL;
    }
  }
  if(!ai_models_dir)
  {
    *err = g_strdup("no models folder given (--models)");
    return NULL;
  }
  if(!session_ppipe_ready(err)) return NULL;
  _ai_job_t *job = g_new0(_ai_job_t, 1);
  job->req = json_object_ref(req);
  job->kind = kind;
  job->map = !g_strcmp0(cmd, "ai_depth");
  job->imgid = _s.imgid;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &job->pw, &job->ph);
  const int model = kind < 0 ? -1 : _mask_kinds[kind].model;
  g_mutex_lock(&_ai_cache_lock);
  _ai_used = g_get_monotonic_time();
  const gboolean held = model < 0
    ? _seg_imgid == job->imgid && _seg_pw == job->pw && _seg_ph == job->ph
    : _mask_cache[model].p && _mask_cache[model].imgid == job->imgid
      && _mask_cache[model].pw == job->pw && _mask_cache[model].ph == job->ph;
  const gboolean guide_held = _guide.rgb && _guide.imgid == job->imgid && _guide.pw == job->pw && _guide.ph == job->ph;
  g_mutex_unlock(&_ai_cache_lock);
  // a model that runs again sees the photo as it is now, as before the guide
  if(!held || !guide_held)
  {
    int gw = 0, gh = 0;
    uint8_t *rgb = ai_shown_rgb(_TRACE_SIZE, TRUE, &gw, &gh, err);
    if(!rgb)
    {
      _ai_job_free(job);
      return NULL;
    }
    g_mutex_lock(&_ai_cache_lock);
    if(_guide.rgb) g_bytes_unref(_guide.rgb);
    _guide.rgb = g_bytes_new_take(rgb, (size_t)3 * gw * gh);
    _guide.w = gw;
    _guide.h = gh;
    _guide.pw = job->pw;
    _guide.ph = job->ph;
    _guide.imgid = job->imgid;
    g_mutex_unlock(&_ai_cache_lock);
  }
  g_mutex_lock(&_ai_cache_lock);
  job->guide = g_bytes_ref(_guide.rgb);
  job->gw = _guide.w;
  job->gh = _guide.h;
  g_mutex_unlock(&_ai_cache_lock);
  if(json_object_get_boolean_member_with_default(req, "backdrop", FALSE) && !job->map)
  {
    // without the map, the selection is made as it would be without asking
    char *e = NULL;
    job->hw = MAX(1, job->gw / 2);
    job->hh = MAX(1, job->gh / 2);
    job->hues = _hue_map(job->hw, job->hh, &e);
    g_free(e);
  }
  if(!held)
    job->rgb = _shrink_rgb(g_bytes_get_data(job->guide, NULL), job->gw, job->gh,
                           model < 0 ? _SEG_SIZE : _mask_models[model].size, &job->w, &job->h);
  return job;
}

static gboolean _ai_do(const _ai_job_t *job, JsonBuilder *b, char **err)
{
  return job->kind < 0 ? _ai_object(job, b, err) : job->map ? _ai_depth(job, b, err) : _ai_mask(job, b, err);
}

// a tagged AI selection runs here once the main loop has rendered what it
// needs, so the photo is edited while the model takes its seconds. one
// thread, in order: an object's click needs the encoding the request
// before it made
GThreadPool *ai_pool = NULL;
static GMutex _ai_pool_lock;

// the selection models are let go once none has been asked for in this
// long. ONNX Runtime keeps a session's peak working memory in its arena
// until the session goes: after Select Subject, about 14 GB of a 24 GB
// Mac, which darktable gives no option to turn off. loading them again
// costs little beside a run (BiRefNet's is within a run's own variation),
// and their last results stay, so the same photo needs no model at all
#define _AI_IDLE_US (30 * G_USEC_PER_SEC)
static _ai_job_t _ai_release_job;
static gint _ai_release_queued = 0;

// on the AI thread, between selections. SAM's encoding goes with it, so a
// click after this renders the photo for it again (_ai_job)
static void _ai_release(void)
{
  g_mutex_lock(&_ai_cache_lock);
  const gboolean idle = _ai_used != _ai_released && g_get_monotonic_time() - _ai_used >= _AI_IDLE_US;
  if(idle)
  {
    _ai_released = _ai_used;
    _seg_imgid = NO_IMGID;
  }
  g_mutex_unlock(&_ai_cache_lock);
  if(!idle) return;
  g_mutex_lock(&export_ai_load_lock);
  if(_seg) dt_seg_free(_seg);
  _seg = NULL;
  for(size_t k = 0; k < G_N_ELEMENTS(_mask_ctx); k++)
  {
    if(_mask_ctx[k]) dt_ai_unload_model(_mask_ctx[k]);
    _mask_ctx[k] = NULL;
  }
  g_mutex_unlock(&export_ai_load_lock);
}

// queues _ai_release() once the models have been idle long enough,
// until the engine stops
gpointer ai_idle_watch(gpointer data)
{
  for(;;)
  {
    g_usleep(5 * G_USEC_PER_SEC);
    g_mutex_lock(&_ai_cache_lock);
    const gboolean due = _ai_used != _ai_released && g_get_monotonic_time() - _ai_used >= _AI_IDLE_US;
    g_mutex_unlock(&_ai_cache_lock);
    g_mutex_lock(&_ai_pool_lock);
    const gboolean running = ai_pool != NULL;
    if(running && due && g_atomic_int_compare_and_exchange(&_ai_release_queued, 0, 1))
      g_thread_pool_push(ai_pool, &_ai_release_job, NULL);
    g_mutex_unlock(&_ai_pool_lock);
    if(!running) return NULL;
  }
}

void ai_run(gpointer data, gpointer user_data)
{
  if(data == &_ai_release_job)
  {
    g_atomic_int_set(&_ai_release_queued, 0);
    _ai_release();
    return;
  }
  _ai_job_t *job = data;
  FILE *out = user_data;
  char *err = NULL;
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, job->tag);
  const gboolean ok = _ai_do(job, b, &err);
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, ok);
  if(!ok)
  {
    json_builder_set_member_name(b, "error");
    json_builder_add_string_value(b, err ? err : "AI selection failed");
  }
  json_builder_end_object(b);
  _ai_job_free(job);
  engine_reply(out, b);
  g_object_unref(b);
  g_free(err);
}

// before darktable's caches go: the selections asked for finish
void ai_wait(void)
{
  g_mutex_lock(&_ai_pool_lock);
  GThreadPool *pool = ai_pool;
  ai_pool = NULL;
  g_mutex_unlock(&_ai_pool_lock);
  if(pool) g_thread_pool_free(pool, FALSE, TRUE);
}

// ai_object, ai_mask or ai_depth. with a `tag`, the model runs on the AI
// thread and this replies at once; the selection's reply then comes with
// the tag
gboolean ai_select(JsonObject *req, JsonBuilder *b, char **err)
{
  _ai_job_t *job = _ai_job(req, err);
  if(!job) return FALSE;
  job->tag = json_object_get_int_member_with_default(req, "tag", 0);
  if(!job->tag)
  {
    const gboolean ok = _ai_do(job, b, err);
    _ai_job_free(job);
    return ok;
  }
  g_mutex_lock(&_ai_pool_lock);
  const gboolean queued = ai_pool != NULL;
  if(queued) g_thread_pool_push(ai_pool, job, NULL);
  g_mutex_unlock(&_ai_pool_lock);
  if(!queued)
  {
    _ai_job_free(job);
    *err = g_strdup("the engine is stopping");
    return FALSE;
  }
  return TRUE;
}

// ------------------------------------------------------------- AI denoise
// Lightroom's Denoise as darktable's neural restore does its raw denoise
// (src/libs/neural_restore.c, _process_raw_denoise_one): the model runs
// over the raw, the result is a new DNG beside it, and that DNG is a photo
// of its own, here starting with the raw's edit. the lib's functions are
// static, so the job is repeated here on the same public calls
#define _DENOISE_MODEL "rawdenoise-nind"

static struct
{
  dt_restore_env_t *env;
  dt_restore_context_t *ctx;
  dt_restore_sensor_class_t cls;
  // the open raw for previews, kept while it stays open as moving the
  // preview reads it again: the mosaic as floats (Bayer), or darktable's
  // demosaic of it (linear, dt_free_align)
  dt_imgid_t imgid;
  gboolean linear;
  float *full;
  int fw, fh;
} _dn = { .cls = DT_RESTORE_SENSOR_CLASS_UNSUPPORTED, .imgid = NO_IMGID };

// set while a denoise runs on its thread (ai_denoise_run), which has the
// model's context to itself until then: neither a preview nor another
// denoise may load or use it
static gint _dn_busy = 0;

void ai_denoise_forget(void)
{
  if(_dn.linear) dt_free_align(_dn.full);
  else g_free(_dn.full);
  _dn.full = NULL;
  _dn.imgid = NO_IMGID;
}

// the model for this sensor, kept between photos, on the CPU (see
// _ai_env_new). X-Trans and the rest run through the linear variant
static dt_restore_context_t *_denoise_ctx(const dt_restore_sensor_class_t cls, char **err)
{
  if(!ai_models_dir)
  {
    *err = g_strdup("no models folder given (--models)");
    return NULL;
  }
  if(_dn.ctx && _dn.cls == cls) return _dn.ctx;
  if(_dn.ctx) dt_restore_unref(_dn.ctx);
  _dn.ctx = NULL;
  if(!_dn.env)
  {
    _dn.env = g_new0(dt_restore_env_t, 1);
    _dn.env->ai_env = dt_ai_env_init(ai_models_dir);
  }
  g_mutex_lock(&export_ai_load_lock);
  dt_ai_env_refresh(_dn.env->ai_env);
  // restore finds its model through darktable's active-model and provider
  // settings rather than taking them as arguments
  dt_conf_set_string("plugins/ai/models/active/rawdenoise", _DENOISE_MODEL);
  dt_conf_set_string(DT_AI_CONF_PROVIDER, "CPU");
  _dn.ctx = cls == DT_RESTORE_SENSOR_CLASS_BAYER  ? dt_restore_load_rawdenoise_bayer(_dn.env)
          : cls == DT_RESTORE_SENSOR_CLASS_XTRANS ? dt_restore_load_rawdenoise_xtrans(_dn.env)
                                                  : dt_restore_load_rawdenoise_linear(_dn.env);
  g_mutex_unlock(&export_ai_load_lock);
  if(!_dn.ctx)
  {
    *err = g_strdup_printf("cannot load the '%s' model from %s", _DENOISE_MODEL, ai_models_dir);
    return NULL;
  }
  _dn.cls = cls;
  return _dn.ctx;
}

// the camera's own JPEG preview, as the DNG's thumbnail. caller g_free()s
// (neural_restore.c, _extract_source_jpeg_preview)
static uint8_t *_denoise_preview(const char *src, dt_imageio_dng_preview_t *preview)
{
  uint8_t *raw = NULL;
  size_t size = 0;
  char *mime = NULL;
  if(dt_exif_get_thumbnail(src, &raw, &size, &mime) || !raw)
  {
    free(raw);
    free(mime);
    return NULL;
  }
  const gboolean jpeg = !g_strcmp0(mime, "image/jpeg");
  free(mime);
  dt_imageio_jpeg_t jpg;
  if(!jpeg || size == 0 || size > INT_MAX || dt_imageio_jpeg_decompress_header(raw, size, &jpg)
     || jpg.width <= 0 || jpg.height <= 0)
  {
    free(raw);
    return NULL;
  }
  uint8_t *out = g_malloc(size);
  memcpy(out, raw, size);
  free(raw);
  preview->data = out;
  preview->len = (int)size;
  preview->width = jpg.width;
  preview->height = jpg.height;
  return out;
}

// the raw mosaic as floats, as the Bayer model takes it, or NULL. caller
// g_free()s
static float *_denoise_cfa(const dt_image_t *meta)
{
  dt_mipmap_buffer_t mbuf;
  dt_mipmap_cache_get(&mbuf, meta->id, DT_MIPMAP_FULL, DT_MIPMAP_BLOCKING, 'r');
  const size_t n = (size_t)meta->width * meta->height;
  float *in = mbuf.buf ? g_try_malloc(n * sizeof(float)) : NULL;
  if(in && meta->buf_dsc.datatype == TYPE_UINT16)
    for(size_t k = 0; k < n; k++) in[k] = ((const uint16_t *)mbuf.buf)[k];
  else if(in && meta->buf_dsc.datatype == TYPE_FLOAT)
    memcpy(in, mbuf.buf, n * sizeof(float));
  else
    g_clear_pointer(&in, g_free);
  dt_mipmap_cache_release(&mbuf);
  return in;
}

// the denoised raw written to `out` as a DNG, a CFA one for Bayer sensors
// and a demosaiced linear one for the rest. the linear one is demosaiced
// through the history of `edit`, a snapshot of the raw's
static gboolean _denoise_write(const dt_restore_sensor_class_t cls, const dt_image_t *meta, const dt_imgid_t edit,
                               const char *src, const char *out, const float strength, char **err)
{
  const dt_imgid_t imgid = meta->id;
  int w = meta->width, h = meta->height;
  uint16_t *cfa = NULL;
  float *rgb = NULL;
  if(cls == DT_RESTORE_SENSOR_CLASS_BAYER)
  {
    const size_t n = (size_t)w * h;
    float *in = _denoise_cfa(meta);
    cfa = in ? g_try_malloc(n * sizeof(uint16_t)) : NULL;
    const gboolean ok = cfa && !dt_restore_raw_bayer(_dn.ctx, meta, in, w, h, cfa, strength, NULL);
    g_free(in);
    if(!ok)
    {
      g_free(cfa);
      *err = g_strdup("the denoise model failed on this photo");
      return FALSE;
    }
  }
  else if(dt_restore_raw_linear(_dn.ctx, edit, &rgb, &w, &h, strength, NULL) || !rgb)
  {
    dt_free_align(rgb);
    *err = g_strdup("the denoise model failed on this photo");
    return FALSE;
  }

  uint8_t *exif = NULL;
  const int exif_len = dt_exif_read_blob(&exif, src, imgid, FALSE, w, h, TRUE);
  dt_imageio_dng_preview_t preview = { 0 };
  uint8_t *jpeg = _denoise_preview(src, &preview);
  int res = cfa ? dt_imageio_dng_write_cfa_bayer(out, cfa, w, h, meta, NULL, 0, jpeg ? &preview : NULL)
                : dt_imageio_dng_write_linear(out, rgb, w, h, meta, NULL, 0, jpeg ? &preview : NULL);
  if(!res && !rendered_metadata(out, exif, exif_len, TRUE)) res = 1;
  if(!res && !denoised_metadata(out, dt_image_orientation(meta))) res = 1;
  g_free(jpeg);
  free(exif);
  g_free(cfa);
  dt_free_align(rgb);
  if(res)
  {
    g_unlink(out);
    *err = g_strdup_printf("cannot write %s", out);
    return FALSE;
  }
  return TRUE;
}

// what the user gave the raw, given to the DNG too, as neural_restore.c's
// _import_image does it, and the raw's edit by darktable's safe paste,
// which leaves out the modules unsafe to copy (history.h,
// dt_history_module_skip_copy): rawprepare's levels, demosaic and the like
static void _denoise_inherit(const dt_imgid_t src, const dt_imgid_t dst)
{
  dt_ratings_apply_on_image(dst, dt_ratings_get(src), FALSE, FALSE, FALSE);
  const int labels = dt_colorlabels_get_labels(src);
  for(int c = 0; c < DT_COLORLABELS_LAST; c++)
    if(labels & (1 << c)) dt_colorlabels_set_label(dst, c);
  dt_image_geoloc_t geo = { NAN, NAN, NAN };
  dt_image_get_location(src, &geo);
  if(!isnan(geo.longitude) && !isnan(geo.latitude)) dt_image_set_location(dst, &geo, FALSE, FALSE);
  GList *meta = dt_metadata_get_list_id(src);
  if(meta)
  {
    GList *imgs = g_list_prepend(NULL, GINT_TO_POINTER(dst));
    dt_metadata_set_list_id(imgs, meta, FALSE, FALSE);
    g_list_free(imgs);
    g_list_free_full(meta, g_free);
  }
  GList *tags = NULL;
  if(dt_tag_get_attached(src, &tags, TRUE))
  {
    GList *imgs = g_list_prepend(NULL, GINT_TO_POINTER(dst));
    for(GList *t = tags; t; t = g_list_next(t)) dt_tag_attach_images(((dt_tag_t *)t->data)->id, imgs, FALSE);
    g_list_free(imgs);
  }
  dt_tag_free_result(&tags);
  dt_history_copy_and_paste_on_image(src, dst, FALSE, NULL, TRUE, FALSE, FALSE);
}

// the open raw, saved, described and classified, with its model loaded.
// both the DNG and the preview start from the edit as the client sees it,
// and the preview's pipe reads it from the library
static gboolean _denoise_source(dt_image_t *meta, dt_restore_sensor_class_t *cls, char **err)
{
  if(!_s.open)
  {
    *err = g_strdup("no image open");
    return FALSE;
  }
  if(g_atomic_int_get(&_dn_busy))
  {
    *err = g_strdup("AI Denoise is still writing a DNG");
    return FALSE;
  }
  if(_s.unsaved && !_s.before && !session_save(err)) return FALSE;
  // load the raw so that buf_dsc describes the sensor
  dt_mipmap_buffer_t warm;
  dt_mipmap_cache_get(&warm, _s.imgid, DT_MIPMAP_FULL, DT_MIPMAP_BLOCKING, 'r');
  const gboolean loaded = warm.buf != NULL;
  dt_mipmap_cache_release(&warm);
  const dt_image_t *img = loaded ? dt_image_cache_get(_s.imgid, 'r') : NULL;
  if(!img)
  {
    *err = g_strdup("cannot load the photo");
    return FALSE;
  }
  *meta = *img;
  dt_image_cache_read_release(img);
  *cls = dt_restore_classify_sensor(meta);
  if(*cls == DT_RESTORE_SENSOR_CLASS_UNSUPPORTED)
  {
    *err = g_strdup("AI denoise works on raw photos only");
    return FALSE;
  }
  return _denoise_ctx(*cls, err) != NULL;
}

// a preview of AI denoise, as neural_restore.c's raw preview makes it
// (_preview_raw_worker): a crop about `size` pixels square centered on
// (u, v) of the edited photo, rendered through the edit from the raw and
// from the raw denoised at full strength. both go to `out` as float linear
// Rec.709 RGB, before then after; the client mixes them at the Amount
gboolean ai_denoise_preview(const float u, const float v, const int size, const char *out,
                            JsonBuilder *b, char **err)
{
  if(!out)
  {
    *err = g_strdup("no output file given");
    return FALSE;
  }
  dt_image_t meta;
  dt_restore_sensor_class_t cls;
  if(!_denoise_source(&meta, &cls, err)) return FALSE;
  const gboolean linear = cls != DT_RESTORE_SENSOR_CLASS_BAYER;
  if(_dn.imgid != meta.id || _dn.linear != linear || !_dn.full)
  {
    ai_denoise_forget();
    _dn.linear = linear;
    if(linear)
    {
      if(dt_restore_raw_linear_prepare(_dn.ctx, meta.id, &_dn.full, &_dn.fw, &_dn.fh)) ai_denoise_forget();
    }
    else
    {
      _dn.full = _denoise_cfa(&meta);
      _dn.fw = meta.width;
      _dn.fh = meta.height;
    }
    if(!_dn.full)
    {
      *err = g_strdup("cannot read the raw");
      return FALSE;
    }
    _dn.imgid = meta.id;
  }

  // one model tile, less its overlap: the Bayer model works at half size
  // (neural_restore.c, max_disp)
  const int T = dt_restore_get_tile_size(_dn.ctx);
  const int most = linear ? T - 64 : 2 * T - 128;
  int cw = MIN(MIN(size, most), _dn.fw), ch = MIN(MIN(size, most), _dn.fh);
  if(!linear)
  {
    cw &= ~1;
    ch &= ~1;
  }
  if(cw <= 0 || ch <= 0)
  {
    *err = g_strdup("the preview is too small");
    return FALSE;
  }
  // (u, v) is on the edited photo, so its crop, rotation and lens
  // geometry are undone; the linear buffer starts at rawprepare's crop
  int x = 0, y = 0;
  if(!dt_restore_display_to_sensor(meta.id, meta.width, meta.height, u, v, cw, ch, linear ? 1 : 2, &x, &y))
  {
    if(linear)
    {
      x -= meta.crop_x;
      y -= meta.crop_y;
    }
  }
  else
  {
    // orientation alone, right for an uncropped photo
    const dt_image_orientation_t ori = dt_image_orientation(&meta);
    const gboolean swap = (ori & ORIENTATION_SWAP_XY) != 0;
    const float dx = u * (swap ? _dn.fh : _dn.fw), dy = v * (swap ? _dn.fw : _dn.fh);
    float sx = swap ? dy : dx, sy = swap ? dx : dy;
    if(ori & ORIENTATION_FLIP_X) sx = _dn.fw - sx;
    if(ori & ORIENTATION_FLIP_Y) sy = _dn.fh - sy;
    x = (int)sx - cw / 2;
    y = (int)sy - ch / 2;
  }
  x = CLAMP(x, 0, _dn.fw - cw);
  y = CLAMP(y, 0, _dn.fh - ch);
  if(!linear)
  {
    x &= ~1;
    y &= ~1;
  }

  float *before = NULL, *after = NULL;
  int w = 0, h = 0;
  const int res = linear
    ? dt_restore_raw_linear_preview_piped(_dn.ctx, &meta, meta.id, _dn.full, _dn.fw, _dn.fh, x, y, cw, ch,
                                          &before, &after, &w, &h)
    : dt_restore_raw_bayer_preview_piped(_dn.ctx, &meta, meta.id, _dn.full, _dn.fw, _dn.fh, x, y, cw, ch,
                                         &before, &after, &w, &h);
  if(res || !before || !after || w <= 0 || h <= 0)
  {
    g_free(before);
    g_free(after);
    *err = g_strdup("the denoise model failed on this photo");
    return FALSE;
  }
  const size_t n = (size_t)w * h * 3 * sizeof(float);
  const gboolean written = engine_transient_write(out, before, n, after, n);
  g_free(before);
  g_free(after);
  if(!written)
  {
    *err = g_strdup_printf("could not write '%s'", out);
    return FALSE;
  }
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, h);
  // its share of the edited photo, for the client's rectangle
  json_builder_set_member_name(b, "rect_w");
  json_builder_add_double_value(b, _s.pipe.processed_width > 0 ? (double)w / _s.pipe.processed_width : 0.0);
  json_builder_set_member_name(b, "rect_h");
  json_builder_add_double_value(b, _s.pipe.processed_height > 0 ? (double)h / _s.pipe.processed_height : 0.0);
  return TRUE;
}

// a denoise asked for: the raw as it was then, which its snapshot holds
// (library_snapshot), and the DNG to write
typedef struct
{
  gint64 tag;
  dt_image_t meta;
  dt_restore_sensor_class_t cls;
  dt_imgid_t snap;
  float strength;
  char *path, *out;
} _denoise_job_t;

static void _denoise_job_free(_denoise_job_t *job)
{
  library_snapshot_remove(job->snap);
  g_free(job->path);
  g_free(job->out);
  g_free(job);
}

// the DNG written, imported and given the raw's edit. it is written under
// another name and renamed once whole, so a folder read meanwhile never
// imports half of it
static gboolean _denoise_do(_denoise_job_t *job, JsonBuilder *b, char **err)
{
  const gint64 t0 = g_get_monotonic_time();
  gchar *part = g_strdup_printf("%s.part", job->out);
  const gboolean written = _denoise_write(job->cls, &job->meta, job->snap, job->path, part, job->strength, err);
  if(written && g_rename(part, job->out))
  {
    g_unlink(part);
    *err = g_strdup_printf("cannot write %s", job->out);
  }
  g_free(part);
  if(*err) return FALSE;
  const dt_imgid_t newid = library_import(job->out);
  if(!dt_is_valid_imgid(newid))
  {
    *err = g_strdup_printf("cannot import %s", job->out);
    return FALSE;
  }
  _denoise_inherit(job->snap, newid);
  if(library_write_sidecar(newid))
  {
    *err = g_strdup("could not write the DNG's XMP sidecar");
    return FALSE;
  }
  engine_add_string(b, "path", job->out);
  engine_add_string(b, "original", job->path);
  json_builder_set_member_name(b, "image");
  library_image_json(b, newid, FALSE);
  json_builder_set_member_name(b, "seconds");
  json_builder_add_double_value(b, engine_ms_since(t0) / 1000.0);
  return TRUE;
}

// a tagged `ai_denoise` runs here once the main loop has taken its
// snapshot, so the photo is edited while the model takes its minute. one
// at a time (_dn_busy); the job then answers with its tag
GThreadPool *ai_denoise_pool = NULL;
static GMutex _denoise_pool_lock;

void ai_denoise_run(gpointer data, gpointer user_data)
{
  _denoise_job_t *job = data;
  FILE *out = user_data;
  engine_background_priority();
  // once, before the model starts: dt_restore_raw_* take no per-tile hook
  engine_background_yield();
  char *err = NULL;
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, job->tag);
  const gboolean ok = _denoise_do(job, b, &err);
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, ok);
  if(!ok)
  {
    json_builder_set_member_name(b, "error");
    json_builder_add_string_value(b, err ? err : "AI denoise failed");
  }
  json_builder_end_object(b);
  _denoise_job_free(job);
  g_atomic_int_set(&_dn_busy, 0);
  engine_reply(out, b);
  g_object_unref(b);
  g_free(err);
}

// before darktable's caches go: a denoise under way finishes
void ai_denoise_wait(void)
{
  g_mutex_lock(&_denoise_pool_lock);
  GThreadPool *pool = ai_denoise_pool;
  ai_denoise_pool = NULL;
  g_mutex_unlock(&_denoise_pool_lock);
  if(pool) g_thread_pool_free(pool, FALSE, TRUE);
}

// the open raw denoised at `strength` (0-1) into <name>_raw-denoise.dng
// beside it, darktable's default name (neural_restore/output_pattern), or
// _1, _2... when taken. with a `tag`, the denoise goes to its thread and
// this replies at once; the DNG's reply then comes with the tag
gboolean ai_denoise(const float strength, const gint64 tag, JsonBuilder *b, char **err)
{
  _denoise_job_t *job = g_new0(_denoise_job_t, 1);
  job->tag = tag;
  job->strength = CLAMP(strength, 0.0f, 1.0f);
  if(!_denoise_source(&job->meta, &job->cls, err))
  {
    g_free(job);
    return FALSE;
  }
  job->snap = library_snapshot(job->meta.id);
  if(!dt_is_valid_imgid(job->snap))
  {
    g_free(job);
    *err = g_strdup("cannot copy the photo's edit");
    return FALSE;
  }

  char path[PATH_MAX] = { 0 };
  gboolean from_cache = FALSE;
  dt_image_full_path(job->meta.id, path, sizeof(path), &from_cache);
  job->path = g_strdup(path);
  gchar *dot = strrchr(path, '.');
  gchar *base = g_strdup_printf("%.*s_raw-denoise", dot ? (int)(dot - path) : (int)strlen(path), path);
  job->out = g_strdup_printf("%s.dng", base);
  for(int k = 1; g_file_test(job->out, G_FILE_TEST_EXISTS) && k < 10000; k++)
  {
    g_free(job->out);
    job->out = g_strdup_printf("%s_%d.dng", base, k);
  }
  g_free(base);

  if(!tag)
  {
    const gboolean ok = _denoise_do(job, b, err);
    _denoise_job_free(job);
    return ok;
  }
  // the job is the thread's once queued
  gchar *name = g_strdup(job->out);
  g_mutex_lock(&_denoise_pool_lock);
  const gboolean queued = ai_denoise_pool != NULL;
  if(queued)
  {
    g_atomic_int_set(&_dn_busy, 1);
    g_thread_pool_push(ai_denoise_pool, job, NULL);
  }
  g_mutex_unlock(&_denoise_pool_lock);
  if(!queued)
  {
    _denoise_job_free(job);
    g_free(name);
    *err = g_strdup("the engine is stopping");
    return FALSE;
  }
  engine_add_string(b, "path", name);
  g_free(name);
  return TRUE;
}

// the mask instances' input as blendif's hue (hz), how colorful it is
// for its lightness (Cz / Jz: dark water is as plainly blue as a bright
// sky at a tenth of its chroma) and its lightness (Jz), over a w x h grid
// on the shown image: triples by rows
static float *_hue_map(const int w, const int h, char **err)
{
  _working_t wk;
  if(!masks_working(&wk, err)) return NULL;
  const size_t n = (size_t)w * h;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < h; j++)
    for(int i = 0; i < w; i++)
    {
      pts[2 * ((size_t)j * w + i)] = (i + 0.5f) / w;
      pts[2 * ((size_t)j * w + i) + 1] = (j + 0.5f) / h;
    }
  masks_to_working(&wk, pts, n);
  float *hc = g_malloc(3 * n * sizeof(float));
  DT_OMP_FOR()
  for(size_t k = 0; k < n; k++)
  {
    const int x = CLAMP((int)pts[2 * k], 0, wk.roi.width - 1), y = CLAMP((int)pts[2 * k + 1], 0, wk.roi.height - 1);
    float Y;
    dt_aligned_pixel_t JzCzhz;
    masks_blend_values(&wk, wk.data + 4 * ((size_t)y * wk.roi.width + x), &Y, JzCzhz);
    hc[3 * k] = JzCzhz[2];
    hc[3 * k + 1] = JzCzhz[1] / fmaxf(JzCzhz[0], 1e-4f);
    hc[3 * k + 2] = JzCzhz[0];
  }
  g_free(pts);
  return hc;
}

// a hue's distance from another, round the circle
static inline float _hue_dist(const float a, const float b)
{
  const float d = fabsf(a - b);
  return fminf(d, 1.0f - d);
}

// _backdrop()'s limits, from photos of birds, people and flowers: a pixel
// is colorful where its Cz / Jz passes _BACKDROP_CHROMA; a background is
// one color where _BACKDROP_COVER of the ring round the selection is
// colorful and near its hue, and vivid where the ring's median Cz / Jz
// passes _BACKDROP_VIVID; and the edge is clear where under
// _BACKDROP_UNCLEAR of the band just outside it is dull, or near the
// window's ends. a dull or unclear edge speckles: its pixels' hues drop in
// and out of the window with the noise, and each shows where the edge
// outline is on and the inset one is not. a child before a cream wall
// (median 0.16) and a face before green leaves (18% unclear) speckled at
// +1 EV; a stilt over dark water is 0.42 and 4%, a kingfisher on blue sky
// 1.39 and 1%
#define _BACKDROP_CHROMA 0.1f
#define _BACKDROP_COVER 0.75f
#define _BACKDROP_VIVID 0.25f
#define _BACKDROP_UNCLEAR 0.1f

// a selection over a plain, colorful background (water, sky, a backdrop)
// gets that color's hue range and its outline on its edge as well as
// inset. darktable feathers a path outward only, so even inset half a
// feather (_trace_json) the outline left the adjustment on the background
// for a few pixels, which shows as a halo once it lifts a stop. the mask
// takes the edge outline less the color, or the outline inset a whole
// feather (_object_shapes): the feather ends at the color, and the subject
// keeps the inset outline's mask wherever its own colors fall. on the
// stilt the mask 1-3 px out fell from 49% to 31%, and 4-10 px from 16% to
// 11%, its rim 1-3 px in rose from 70% to 80%. replies, for such a background, with
// `backdrop` {hue, range, paths, plain}: range is the hz window an inverted
// parametric channel takes the color out with, paths the edge outline,
// plain the outline inset half a feather, as without a backdrop
static gboolean _backdrop(const _ai_job_t *job, const float *p, JsonBuilder *b)
{
  const int w = job->hw, h = job->hh;
  const size_t n = (size_t)w * h;
  const float *hc = job->hues;
  float *near_mean = g_malloc(n * sizeof(float));
  float *far_mean = g_malloc(n * sizeof(float)), *tmp = g_malloc(n * sizeof(float));
  for(int j = 0; j < h; j++)
    for(int i = 0; i < w; i++)
    {
      const int x = MIN(job->gw - 1, (int)((i + 0.5f) * job->gw / w));
      const int y = MIN(job->gh - 1, (int)((j + 0.5f) * job->gh / h));
      const size_t k = (size_t)j * w + i;
      near_mean[k] = far_mean[k] = p[(size_t)y * job->gw + x] >= 0.5f;
    }
  // the ring outside, clear of the edge, whose pixels at the working
  // image's size are part either side
  const int r0 = MAX(2, MAX(w, h) / 340), r1 = MAX(6, MAX(w, h) / 85);
  _box_mean(near_mean, tmp, w, h, r0);
  _box_mean(far_mean, tmp, w, h, r1);
  uint8_t *ring = g_malloc(n);
  size_t rn = 0;
  int hist[72] = { 0 };
  for(size_t k = 0; k < n; k++)
  {
    ring[k] = near_mean[k] == 0.0f && far_mean[k] > 0.0f;
    rn += ring[k];
    if(ring[k] && hc[3 * k + 1] >= _BACKDROP_CHROMA) hist[MIN(71, (int)(hc[3 * k] * 72))]++;
  }
  // its hue: the busiest 35 degrees of the colorful ring, then their mean
  int peak = 0, best = -1;
  for(int k = 0; k < 72; k++)
  {
    int c = 0;
    for(int d = -3; d <= 3; d++) c += hist[(k + d + 72) % 72];
    if(c > best)
    {
      best = c;
      peak = k;
    }
  }
  const float h0 = (peak + 0.5f) / 72.0f;
  double hs = 0.0, hcs = 0.0;
  for(size_t k = 0; k < n; k++)
    if(ring[k] && hc[3 * k + 1] >= _BACKDROP_CHROMA && _hue_dist(hc[3 * k], h0) < 0.15f)
    {
      hs += sin(2.0 * M_PI * hc[3 * k]);
      hcs += cos(2.0 * M_PI * hc[3 * k]);
    }
  float hue = atan2(hs, hcs) / (2.0 * M_PI);
  if(hue < 0.0f) hue += 1.0f;
  // the window holds 90% of the hues near it, with a margin; no narrower
  // than the stilt's water needed
  int spread[101] = { 0 }, close = 0;
  for(size_t k = 0; k < n; k++)
    if(ring[k] && hc[3 * k + 1] >= _BACKDROP_CHROMA && _hue_dist(hc[3 * k], hue) < 0.2f)
    {
      spread[MIN(100, (int)(_hue_dist(hc[3 * k], hue) * 500))]++;
      close++;
    }
  int q = 0;
  for(int c = 0; q < 100 && (c += spread[q]) < 0.9f * close; q++);
  const float a = CLAMP(q / 500.0f + 0.045f, 0.085f, 0.14f), o = a + 0.08f;
  size_t cover = 0;
  for(size_t k = 0; k < n; k++)
    if(ring[k] && hc[3 * k + 1] >= _BACKDROP_CHROMA && _hue_dist(hc[3 * k], hue) <= a) cover++;
  // the ring's median colorfulness
  int vivid[201] = { 0 };
  for(size_t k = 0; k < n; k++)
    if(ring[k]) vivid[MIN(200, (int)(hc[3 * k + 1] * 100))]++;
  int med = 0;
  for(size_t c = 0; med < 200 && (c += vivid[med]) < rn / 2; med++);
  // the band just outside the edge: how much of it is dull, or near the
  // window's ends, widened by the noise of the full-size photo
  size_t bn = 0, unclear = 0;
  for(int j = 0; j < h; j++)
    for(int i = 0; i < w; i++)
    {
      const size_t k = (size_t)j * w + i;
      const int x = MIN(job->gw - 1, (int)((i + 0.5f) * job->gw / w));
      const int y = MIN(job->gh - 1, (int)((j + 0.5f) * job->gh / h));
      if(p[(size_t)y * job->gw + x] >= 0.5f || near_mean[k] == 0.0f) continue;
      const float d = _hue_dist(hc[3 * k], hue);
      bn++;
      unclear += hc[3 * k + 1] < _BACKDROP_CHROMA || (d > a && d < o + 0.08f);
    }
  g_free(near_mean);
  g_free(far_mean);
  g_free(tmp);
  g_free(ring);
  // hz runs 0-1 without wrapping: a window over its ends cannot be made
  if(!rn || cover < _BACKDROP_COVER * rn || med < 100 * _BACKDROP_VIVID || !bn || unclear > _BACKDROP_UNCLEAR * bn
     || hue - o < 0.0f || hue + o > 1.0f)
    return FALSE;
  json_builder_set_member_name(b, "backdrop");
  json_builder_begin_object(b);
  masks_add_num(b, "hue", hue);
  json_builder_set_member_name(b, "range");
  json_builder_begin_array(b);
  const float r[4] = { hue - o, hue - a, hue + a, hue + o };
  for(int k = 0; k < 4; k++) json_builder_add_double_value(b, r[k]);
  json_builder_end_array(b);
  // and the outline as it would be without one, for a shape that leaves
  // its backdrop out (_object_shapes)
  float *edge = g_malloc(sizeof(float) * job->gw * job->gh);
  memcpy(edge, p, sizeof(float) * job->gw * job->gh);
  _paths_json(b, "paths", edge, job->gw, job->gh);
  memcpy(edge, p, sizeof(float) * job->gw * job->gh);
  _inset(edge, job->gw, job->gh, 0.5f * _OBJECT_FEATHER * MIN(job->gw, job->gh));
  _paths_json(b, "plain", edge, job->gw, job->gh);
  g_free(edge);
  json_builder_end_object(b);
  return TRUE;
}
#endif

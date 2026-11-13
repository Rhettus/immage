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

// the color mapping card's "acquire as source" and "acquire as target"
// (iop/colormapping.c). darktable acquires in its GUI only: the button sets
// ACQUIRE and GET_SOURCE or GET_TARGET in the params, process() keeps a copy
// of the preview pipe's input (a Lab image), and process_clusters(), on the
// preview pipe's finish, runs the analysis below on that copy, writes the
// result into the module's params and adds a history item. The engine has no
// GUI data, so `colormapping_acquire` does the analysis on the module's input
// as the preview-sized pipe delivers it (masks_working_colormapping()) and
// keeps the result under a number; the card then writes that number to the
// field `cm_source` or `cm_target`, which is the params' write. Those two
// fields are what an edit, undo and the card's snapshot carry, as no number
// can hold the arrays: 0 means no source (or target), else the content hash
// of its histogram, means, deviations and weights. A write of a number the
// engine has seen restores those arrays and sets HAS_SOURCE or HAS_TARGET;
// 0 clears them and the flag, as colormapping.c's gui_changed does when the
// number of clusters moves.
//
// capture_histogram(), invert_histogram() and kmeans() are copied from
// colormapping.c, with the random start from darktable's own generator.

#include "engine.h"
#include "common/points.h"

#define HISTN (1 << 11)
#define MAXN 5

typedef float float2[2];

// colormapping.c's dt_iop_colormapping_flags_t
#define HAS_SOURCE (1 << 0)
#define HAS_TARGET (1 << 1)

typedef struct cmap_clusters_t
{
  // source: the inverted histogram (floats); target: the histogram (ints)
  unsigned char hist[HISTN * 4];
  float2 mean[MAXN];
  float2 var[MAXN];
  float weight[MAXN];
} cmap_clusters_t;

static GHashTable *_seen[2] = { NULL, NULL };
static GMutex _seen_lock;

// the params' arrays of one side
typedef struct cmap_ptrs_t
{
  void *hist;
  float2 *mean;
  float2 *var;
  float *weight;
  int *flag;
} cmap_ptrs_t;

static gboolean _ptrs(dt_iop_module_t *mod, void *base, const gboolean target, cmap_ptrs_t *p, char **err)
{
  dt_introspection_field_t *f = NULL;
  p->flag = session_field_in(mod, base, "flag", &f, err);
  p->hist = p->flag ? session_field_in(mod, base, target ? "target_hist" : "source_ihist", &f, err) : NULL;
  p->mean = p->hist ? session_field_in(mod, base, target ? "target_mean" : "source_mean", &f, err) : NULL;
  p->var = p->mean ? session_field_in(mod, base, target ? "target_var" : "source_var", &f, err) : NULL;
  p->weight = p->var ? session_field_in(mod, base, target ? "target_weight" : "source_weight", &f, err) : NULL;
  return p->weight != NULL;
}

// FNV-1a over the arrays, 48 bits so the hash is a whole number in a double;
// the side is in it, so that a source and a target never share a number
static double _hash(const gboolean target, const cmap_clusters_t *c)
{
  guint64 h = 14695981039346656037ull;
  h = (h ^ (target ? 't' : 's')) * 1099511628211ull;
  for(const unsigned char *b = (const unsigned char *)c; b < (const unsigned char *)(c + 1); b++)
    h = (h ^ *b) * 1099511628211ull;
  h &= 0xffffffffffffull;
  return h ? (double)h : 1.0;
}

static void _remember(const gboolean target, const double hash, const cmap_clusters_t *c)
{
  g_mutex_lock(&_seen_lock);
  if(!_seen[target]) _seen[target] = g_hash_table_new_full(g_int64_hash, g_int64_equal, g_free, g_free);
  gint64 key = (gint64)hash;
  if(!g_hash_table_contains(_seen[target], &key))
  {
    gint64 *k = g_new(gint64, 1);
    *k = key;
    cmap_clusters_t *copy = g_new(cmap_clusters_t, 1);
    *copy = *c;
    g_hash_table_insert(_seen[target], k, copy);
  }
  g_mutex_unlock(&_seen_lock);
}

static void _take(const cmap_ptrs_t *p, cmap_clusters_t *c)
{
  memset(c, 0, sizeof *c);
  memcpy(c->hist, p->hist, sizeof c->hist);
  memcpy(c->mean, p->mean, sizeof c->mean);
  memcpy(c->var, p->var, sizeof c->var);
  memcpy(c->weight, p->weight, sizeof c->weight);
}

// introspection lists the clusters' float2 elements as opaque, so no path can
// reach a mean or deviation: "source_mean[k][j]", "source_var[k][j]" and the
// target's are read and written here, j 0 for a and 1 for b. NULL for a name
// that is none of them
static float *_pair(dt_iop_module_t *mod, void *base, const char *name, char **err)
{
  char side[8] = "", what[8] = "", tail = 0;
  int k = -1, j = -1;
  if(sscanf(name, "%7[a-z]_%7[a-z][%d][%d]%c", side, what, &k, &j, &tail) != 4
     || (strcmp(side, "source") && strcmp(side, "target")) || (strcmp(what, "mean") && strcmp(what, "var")))
    return NULL;
  if(k < 0 || k >= MAXN || j < 0 || j > 1)
  {
    *err = g_strdup_printf("'%s' has no field '%s'", mod->op, name);
    return NULL;
  }
  cmap_ptrs_t p;
  if(!_ptrs(mod, base, !strcmp(side, "target"), &p, err)) return NULL;
  return (strcmp(what, "mean") ? p.var[k] : p.mean[k]) + j;
}

static gboolean _is_pair(const char *name)
{
  char side[8] = "", what[8] = "", tail = 0;
  int k, j;
  return sscanf(name, "%7[a-z]_%7[a-z][%d][%d]%c", side, what, &k, &j, &tail) == 4
         && (!strcmp(side, "source") || !strcmp(side, "target")) && (!strcmp(what, "mean") || !strcmp(what, "var"));
}

gboolean cmap_is_field(const dt_iop_module_t *mod, const char *name)
{
  return !g_strcmp0(mod->op, "colormapping")
         && (!g_strcmp0(name, CMAP_SOURCE) || !g_strcmp0(name, CMAP_TARGET) || _is_pair(name));
}

gboolean cmap_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults, double *num, char **err)
{
  if(_is_pair(name))
  {
    const float *v = _pair(mod, from_defaults ? mod->default_params : mod->params, name, err);
    if(!v) return FALSE;
    *num = *v;
    return TRUE;
  }
  const gboolean target = !g_strcmp0(name, CMAP_TARGET);
  cmap_ptrs_t p;
  if(!_ptrs(mod, mod->params, target, &p, err)) return FALSE;
  if(from_defaults || !(*p.flag & (target ? HAS_TARGET : HAS_SOURCE)))
  {
    *num = 0.0;
    return TRUE;
  }
  cmap_clusters_t c;
  _take(&p, &c);
  *num = _hash(target, &c);
  _remember(target, *num, &c);
  return TRUE;
}

gboolean cmap_write(dt_iop_module_t *mod, const char *name, const double num, char **err)
{
  if(_is_pair(name))
  {
    float *v = _pair(mod, mod->params, name, err);
    if(!v) return FALSE;
    *v = (float)num;
    return TRUE;
  }
  const gboolean target = !g_strcmp0(name, CMAP_TARGET);
  cmap_ptrs_t p;
  if(!_ptrs(mod, mod->params, target, &p, err)) return FALSE;
  const int has = target ? HAS_TARGET : HAS_SOURCE;
  if(num == 0.0)
  {
    memset(p.hist, 0, HISTN * 4);
    memset(p.mean, 0, sizeof(float2) * MAXN);
    memset(p.var, 0, sizeof(float2) * MAXN);
    memset(p.weight, 0, sizeof(float) * MAXN);
    *p.flag &= ~has;
    return TRUE;
  }
  g_mutex_lock(&_seen_lock);
  gint64 key = (gint64)num;
  const cmap_clusters_t *c = _seen[target] ? g_hash_table_lookup(_seen[target], &key) : NULL;
  if(c)
  {
    memcpy(p.hist, c->hist, HISTN * 4);
    memcpy(p.mean, c->mean, sizeof c->mean);
    memcpy(p.var, c->var, sizeof c->var);
    memcpy(p.weight, c->weight, sizeof c->weight);
    *p.flag |= has;
  }
  g_mutex_unlock(&_seen_lock);
  if(!c)
  {
    *err = g_strdup_printf("no clusters of that number were acquired in this session (%s)", name);
    return FALSE;
  }
  return TRUE;
}

// colormapping.c: capture_histogram
static void _capture_histogram(const float *col, const int width, const int height, int *hist)
{
  // build separate histogram
  memset(hist, 0, sizeof(int) * HISTN);
  for(int k = 0; k < height; k++)
    for(int i = 0; i < width; i++)
    {
      const int bin = CLAMP(HISTN * col[4 * (k * width + i) + 0] / 100.0, 0, HISTN - 1);
      hist[bin]++;
    }

  // accumulated start distribution of G1 G2
  for(int k = 1; k < HISTN; k++) hist[k] += hist[k - 1];
  for(int k = 0; k < HISTN; k++)
    hist[k] = (int)CLAMP(hist[k] * (HISTN / (float)hist[HISTN - 1]), 0, HISTN - 1);
}

// colormapping.c: invert_histogram
static void _invert_histogram(const int *hist, float *inv_hist)
{
  // invert non-normalised accumulated hist
  int last = 31;
  for(int i = 0; i <= last; i++) inv_hist[i] = 100.0f * i / (float)HISTN;
  for(int i = last + 1; i < HISTN; i++)
    for(int k = last; k < HISTN; k++)
      if(hist[k] >= i)
      {
        last = k;
        inv_hist[i] = 100.0f * k / (float)HISTN;
        break;
      }
}

// colormapping.c: get_cluster
static int _get_cluster(const float *col, const int n, float2 *mean)
{
  float mdist = FLT_MAX;
  int cluster = 0;
  for(int k = 0; k < n; k++)
  {
    const float dist = (col[1] - mean[k][0]) * (col[1] - mean[k][0])
                       + (col[2] - mean[k][1]) * (col[2] - mean[k][1]);
    if(dist < mdist)
    {
      mdist = dist;
      cluster = k;
    }
  }
  return cluster;
}

// colormapping.c: kmeans
static void _kmeans(const float *col, const int width, const int height, const int n, float2 *mean_out,
                    float2 *var_out, float *weight_out)
{
  const int nit = 40;                       // max number of iterations

  float2 *const mean = malloc(sizeof(float2) * n);
  float2 *const var = malloc(sizeof(float2) * n);
  int *const cnt = malloc(sizeof(int) * n);
  int count;

  float a_min = FLT_MAX, b_min = FLT_MAX, a_max = -FLT_MAX, b_max = -FLT_MAX;

  const size_t npixels = (size_t)height * width;
  // find the extremes of a/b color channels
  DT_OMP_FOR(reduction(min: a_min, b_min) reduction(max: a_max, b_max))
  for(size_t k = 0; k < npixels; k++)
  {
    const float a = col[4 * k + 1];
    const float b = col[4 * k + 2];
    a_min = fminf(a, a_min);
    a_max = fmaxf(a, a_max);
    b_min = fminf(b, b_min);
    b_max = fmaxf(b, b_max);
  }

  // init n clusters for a, b channels at random
  for(int k = 0; k < n; k++)
  {
    mean_out[k][0] = 0.9f * (a_min + (a_max - a_min) * dt_points_get());
    mean_out[k][1] = 0.9f * (b_min + (b_max - b_min) * dt_points_get());
    var_out[k][0] = var_out[k][1] = weight_out[k] = 0.0f;
    mean[k][0] = mean[k][1] = var[k][0] = var[k][1] = 0.0f;
  }
  for(int it = 0; it < nit; it++)
  {
    size_t cnt_size;
    int *cnt_perthread = dt_calloc_perthread(n,sizeof(int),&cnt_size);
    size_t var_size;
    float2 *var_perthread = dt_calloc_perthread(n,sizeof(float2),&var_size);
    size_t mean_size;
    float2 *mean_perthread = dt_calloc_perthread(n,sizeof(float2),&mean_size);
    DT_OMP_FOR()
    for(size_t k = 0; k < npixels; k++)
    {
      const unsigned int threadnum = dt_get_thread_num();
      float2 *t_var = dt_get_bythread(var_perthread,var_size,threadnum);
      float2 *t_mean = dt_get_bythread(mean_perthread,mean_size,threadnum);
      int *t_cnt = dt_get_bythread(cnt_perthread,cnt_size,threadnum);
      dt_aligned_pixel_t Lab;
      copy_pixel(Lab, col + 4*k);
      const int c = _get_cluster(Lab, n, mean_out);
      t_cnt[c]++;
      // update mean, var
      t_var[c][0] += Lab[1] * Lab[1];
      t_var[c][1] += Lab[2] * Lab[2];
      t_mean[c][0] += Lab[1];
      t_mean[c][1] += Lab[2];
    }
    // accumulate the per-thread statistics
    for(size_t clus = 0; clus < n; clus++)
    {
      cnt[clus] = 0;
      mean[clus][0] = mean[clus][1] = 0.0f;
      var[clus][0] = var[clus][1] = 0.0f;
      for(size_t t = 0; t < dt_get_num_threads(); t++)
      {
        const int *t_cnt = dt_get_bythread(cnt_perthread,cnt_size,t);
        cnt[clus] += t_cnt[clus];
        const float2 *t_mean = dt_get_bythread(mean_perthread,mean_size,t);
        mean[clus][0] += t_mean[clus][0];
        mean[clus][1] += t_mean[clus][1];
        const float2 *t_var = dt_get_bythread(var_perthread,var_size,t);
        var[clus][0] += t_var[clus][0];
        var[clus][1] += t_var[clus][1];
      }
    }
    dt_free_align(cnt_perthread);
    dt_free_align(var_perthread);
    dt_free_align(mean_perthread);
    // swap old/new means
    for(int k = 0; k < n; k++)
    {
      if(cnt[k] == 0) continue;
      mean_out[k][0] = mean[k][0] / cnt[k];
      mean_out[k][1] = mean[k][1] / cnt[k];
      var_out[k][0] = var[k][0] / cnt[k] - mean_out[k][0] * mean_out[k][0];
      var_out[k][1] = var[k][1] / cnt[k] - mean_out[k][1] * mean_out[k][1];
      mean[k][0] = mean[k][1] = var[k][0] = var[k][1] = 0.0f;
    }

    // determine weight of clusters
    count = 0;
    for(int k = 0; k < n; k++) count += cnt[k];
    for(int k = 0; k < n; k++) weight_out[k] = (count > 0) ? (float)cnt[k] / count : 0.0f;
  }

  free(cnt);
  free(var);
  free(mean);

  for(int k = 0; k < n; k++)
  {
    // "eliminate" clusters with a variance of zero
    if(var_out[k][0] == 0.0f || var_out[k][1] == 0.0f)
      mean_out[k][0] = mean_out[k][1] = var_out[k][0] = var_out[k][1] = weight_out[k] = 0;

    // we actually want the std deviation.
    var_out[k][0] = sqrtf(var_out[k][0]);
    var_out[k][1] = sqrtf(var_out[k][1]);
  }

  // simple bubblesort of clusters in order of ascending weight: just a convenience for the user to keep
  // cluster display a bit more consistent in GUI
  for(int i = 0; i < n - 1; i++)
  {
    for(int j = 0; j < n - 1 - i; j++)
    {
      if(weight_out[j] > weight_out[j + 1])
      {
        float2 temp_mean = { mean_out[j + 1][0], mean_out[j + 1][1] };
        float2 temp_var = { var_out[j + 1][0], var_out[j + 1][1] };
        float temp_weight = weight_out[j + 1];

        mean_out[j + 1][0] = mean_out[j][0];
        mean_out[j + 1][1] = mean_out[j][1];
        var_out[j + 1][0] = var_out[j][0];
        var_out[j + 1][1] = var_out[j][1];
        weight_out[j + 1] = weight_out[j];

        mean_out[j][0] = temp_mean[0];
        mean_out[j][1] = temp_mean[1];
        var_out[j][0] = temp_var[0];
        var_out[j][1] = temp_var[1];
        weight_out[j] = temp_weight;
      }
    }
  }
}

// colormapping.c: process_clusters, for the image at the module's input.
// `which` is "source" or "target"; n (1-5) is the number of clusters the
// card has set. Replies the number to write to cm_source or cm_target, and
// the clusters found, for the card's previews
gboolean cmap_acquire(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *which = json_object_get_string_member_with_default(req, "which", "");
  const gboolean target = !g_strcmp0(which, "target");
  if(!target && g_strcmp0(which, "source"))
  {
    *err = g_strdup("which must be \"source\" or \"target\"");
    return FALSE;
  }
  dt_iop_module_t *mod = session_module("colormapping", err);
  if(!mod) return FALSE;
  double n_now = 0.0;
  if(json_object_has_member(req, "n")) n_now = json_object_get_double_member(req, "n");
  else if(!session_read_field(mod, "n", FALSE, &n_now, err)) return FALSE;
  const int n = (int)n_now;
  // kmeans() writes n clusters into the fixed MAXN arrays
  if(n < 1 || n > MAXN)
  {
    *err = g_strdup("the number of clusters must be 1 to 5");
    return FALSE;
  }

  _working_t w;
  if(!masks_working_colormapping(&w, err)) return FALSE;
  const int width = w.roi.width, height = w.roi.height;

  cmap_clusters_t c;
  memset(&c, 0, sizeof c);
  int hist[HISTN];
  // get histogram of L
  _capture_histogram(w.data, width, height, hist);
  if(target)
    memcpy(c.hist, hist, sizeof hist);
  else
    // invert histogram
    _invert_histogram(hist, (float *)c.hist);
  // get n color clusters
  _kmeans(w.data, width, height, n, c.mean, c.var, c.weight);

  const double hash = _hash(target, &c);
  _remember(target, hash, &c);

  json_builder_set_member_name(b, "hash");
  json_builder_add_double_value(b, hash);
  json_builder_set_member_name(b, "n");
  json_builder_add_int_value(b, n);
  json_builder_set_member_name(b, "mean");
  json_builder_begin_array(b);
  for(int k = 0; k < MAXN; k++)
    for(int j = 0; j < 2; j++) json_builder_add_double_value(b, c.mean[k][j]);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "var");
  json_builder_begin_array(b);
  for(int k = 0; k < MAXN; k++)
    for(int j = 0; j < 2; j++) json_builder_add_double_value(b, c.var[k][j]);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "weight");
  json_builder_begin_array(b);
  for(int k = 0; k < MAXN; k++) json_builder_add_double_value(b, c.weight[k]);
  json_builder_end_array(b);
  return TRUE;
}

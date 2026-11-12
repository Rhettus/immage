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

// the compute devices: OpenCL, the AI execution providers, and the GPU check that compares CPU and GPU renders

#include "engine.h"

#ifdef HAVE_AI
#ifdef __linux__
// whether ONNX Runtime has this provider's entry point. darktable checks the
// driver behind MIGraphX before it looks for the entry point
// (backend_onnx.c, _try_provider), and that check starts ROCm's HIP, whose
// compiler aborted the engine at start when Mesa's RustiCL OpenCL had loaded
// another LLVM ("Option ... registered more than once"; RX 9070 XT, Ubuntu
// 26.04). the bundled ONNX Runtime is the CPU build, so a missing entry point
// keeps darktable from checking at all
gboolean device_ort_exports(const dt_ai_provider_t p)
{
  static const struct { dt_ai_provider_t p; const char *symbol; } eps[] = {
    { DT_AI_PROVIDER_CUDA, "OrtSessionOptionsAppendExecutionProvider_CUDA" },
    { DT_AI_PROVIDER_MIGRAPHX, "OrtSessionOptionsAppendExecutionProvider_MIGraphX" },
    { DT_AI_PROVIDER_MIGRAPHX, "OrtSessionOptionsAppendExecutionProvider_ROCM" },
    { DT_AI_PROVIDER_OPENVINO, "OrtSessionOptionsAppendExecutionProvider_OpenVINO" },
  };
  // the library darktable opens: by name, else from its plugin folder
  // (backend_onnx.c, _init_ort_api)
  GModule *ort = g_module_open("libonnxruntime.so", G_MODULE_BIND_LAZY | G_MODULE_BIND_LOCAL);
  if(!ort && darktable.plugindir)
  {
    gchar *path = g_build_filename(darktable.plugindir, "libonnxruntime.so", NULL);
    ort = g_module_open(path, G_MODULE_BIND_LAZY | G_MODULE_BIND_LOCAL);
    g_free(path);
  }
  if(!ort) return FALSE;
  gboolean found = FALSE;
  for(size_t k = 0; k < G_N_ELEMENTS(eps); k++)
  {
    gpointer f = NULL;
    if(eps[k].p == p && g_module_symbol(ort, eps[k].symbol, &f)) found = TRUE;
  }
  g_module_close(ort);
  return found;
}

#endif
// a provider usable here: darktable's runtime check attaches it to a
// session, and fails one this platform's ONNX Runtime does not have
gboolean device_gpu_usable(const dt_ai_provider_t p)
{
#ifdef __linux__
  if(!device_ort_exports(p)) return FALSE;
#endif
  return dt_ai_probe_provider(p);
}

// a device darktable lists that is no GPU: Windows' software renderer, a
// virtual machine's only adapter, which DirectML would run on the CPU
static gboolean _soft_device(const dt_ai_device_t *d)
{
  return d->name && strstr(d->name, "Basic Render");
}

#endif
// for the GPU check, also each device's memory, its settings and how many
// of darktable's kernel programs it built: a kernel missing from a package,
// or one its driver cannot compile, leaves its module on the CPU unseen
void device_opencl(JsonBuilder *b)
{
  engine_add_bool(b, "running", dt_opencl_running());
  const dt_opencl_t *cl = darktable.opencl;
  engine_add_bool(b, "inited", cl && cl->inited);
  // a pipe that failed on a device and restarted on the CPU counts one
  // error; at DT_OPENCL_MAX_ERRORS darktable stops OpenCL for the session
  // (pixelpipe_hb.c, dt_dev_pixelpipe_process)
  engine_add_int(b, "error_count", cl ? cl->error_count : 0);
  engine_add_bool(b, "stopped", cl && cl->stopped);
  json_builder_set_member_name(b, "devices");
  json_builder_begin_array(b);
#ifdef HAVE_OPENCL
  for(int k = 0; cl && cl->inited && k < cl->num_devs; k++)
  {
    const dt_opencl_device_t *dev = &cl->dev[k];
    json_builder_begin_object(b);
    engine_add_string(b, "name", dev->fullname);
    engine_add_string(b, "platform", dev->platform);
    engine_add_string(b, "version", dev->device_version);
    engine_add_string(b, "cname", dev->cname);
    engine_add_string(b, "options", dev->options);
    engine_add_bool(b, "disabled", dev->disabled);
    engine_add_bool(b, "unified_memory", dev->unified_memory);
    engine_add_bool(b, "tunehead", dev->tunehead);
    engine_add_bool(b, "asyncmode", dev->asyncmode);
    engine_add_int(b, "headroom", dev->headroom);
    engine_add_int(b, "compute_units", dev->compute_units);
    engine_add_int(b, "max_global_mem", dev->max_global_mem);
    engine_add_int(b, "max_mem_alloc", dev->max_mem_alloc);
    // darktable counts device memory only under -d memory -d opencl
    // (opencl.c, _opencl_memory_statistics); otherwise both read 0
    if((darktable.unmuted & DT_DEBUG_MEMORY) && (darktable.unmuted & DT_DEBUG_OPENCL))
    {
      engine_add_int(b, "memory_in_use", dev->memory_in_use);
      engine_add_int(b, "peak_memory", dev->peak_memory);
    }
    engine_add_int(b, "total_events", dev->totalevents);
    engine_add_int(b, "lost_events", dev->totallost);
    int programs = 0, kernels = 0;
    for(int p = 0; p < DT_OPENCL_MAX_PROGRAMS; p++) programs += dev->program[p] != NULL;
    for(int q = 0; q < DT_OPENCL_MAX_KERNELS; q++) kernels += dev->kernel_used[q] != 0;
    engine_add_int(b, "programs", programs);
    engine_add_int(b, "kernels", kernels);
    json_builder_end_object(b);
  }
#endif
  json_builder_end_array(b);
}

#ifdef HAVE_AI
// the GPU providers this computer can use, each with its devices where the
// provider lets one be chosen; a provider whose only devices are software
// ones is left out
void device_ai_accel(JsonBuilder *b)
{
  json_builder_set_member_name(b, "providers");
  json_builder_begin_array(b);
  for(size_t k = 0; k < G_N_ELEMENTS(_gpu_providers); k++)
  {
    const dt_ai_provider_t p = _gpu_providers[k].p;
    if(!device_gpu_usable(p)) continue;
    GList *devices = dt_ai_enum_devices_for_provider(p);
    int hardware = 0;
    for(GList *d = devices; d; d = g_list_next(d)) hardware += !_soft_device(d->data);
    if(devices && !hardware)
    {
      g_list_free_full(devices, dt_ai_device_free);
      continue;
    }
    json_builder_begin_object(b);
    engine_add_string(b, "id", _gpu_providers[k].id);
    engine_add_string(b, "name", dt_ai_provider_to_string(p));
    json_builder_set_member_name(b, "devices");
    json_builder_begin_array(b);
    for(GList *d = devices; d; d = g_list_next(d))
    {
      const dt_ai_device_t *dev = d->data;
      if(_soft_device(dev)) continue;
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "id");
      json_builder_add_int_value(b, dev->id);
      engine_add_string(b, "name", dev->name);
      json_builder_end_object(b);
    }
    json_builder_end_array(b);
    json_builder_end_object(b);
    g_list_free_full(devices, dt_ai_device_free);
  }
  json_builder_end_array(b);
}

#endif
// the GPU check: the edit rendered on the CPU and then on an OpenCL device,
// on a pipe of its own, and the two frames compared. darktable's
// integration tests accept dE < 2 between the two (src/tests/integration)

static float _srgb_linear(const float v)
{
  return v <= 0.04045f ? v / 12.92f : powf((v + 0.055f) / 1.055f, 2.4f);
}

static float _lab_f(const float t)
{
  return t > 216.0f / 24389.0f ? cbrtf(t) : (24389.0f / 27.0f * t + 16.0f) / 116.0f;
}

// display bytes (BGRA) to CIE Lab, D65
static void _bgra_lab(const uint8_t *px, float lab[3])
{
  const float r = _srgb_linear(px[2] / 255.0f), g = _srgb_linear(px[1] / 255.0f),
              b = _srgb_linear(px[0] / 255.0f);
  const float x = (0.4124564f * r + 0.3575761f * g + 0.1804375f * b) / 0.95047f;
  const float y = 0.2126729f * r + 0.7151522f * g + 0.0721750f * b;
  const float z = (0.0193339f * r + 0.1191920f * g + 0.9503041f * b) / 1.08883f;
  const float fx = _lab_f(x), fy = _lab_f(y), fz = _lab_f(z);
  lab[0] = 116.0f * fy - 16.0f;
  lab[1] = 500.0f * (fx - fy);
  lab[2] = 200.0f * (fy - fz);
}

typedef struct parity_pass_t
{
  uint8_t *pixels;
  int w, h;
  double ms;
  int devid;
  int cl_errors;
} parity_pass_t;

// one render of the check pipe from an empty cache: without the flush the
// second pass would reuse the first's cachelines and compare a frame with
// itself. gpu FALSE turns OpenCL off for the length of the render, as
// dt_dev_pixelpipe_process() takes the pipe's device from dt_opencl_running()
static gboolean _parity_pass(const char *name, const gboolean gpu, const int size, parity_pass_t *out, char **err)
{
  dt_dev_pixelpipe_t *pipe = &_s.check.pipe;
  dt_dev_pixelpipe_cache_flush(pipe);
  dt_opencl_t *cl = darktable.opencl;
  const gboolean enabled = cl->enabled;
  int devid = DT_DEVICE_NONE;
  if(gpu) devid = dt_opencl_lock_device(DT_DEV_PIXELPIPE_EXPORT);
  else cl->enabled = FALSE;
  // its marker line splits the request's -d perf module timings by pass
  // (engine.rs, read_stderr)
  fprintf(stderr, "[engine] | %s\n", name);
  fflush(stderr);
  const int errors = cl->error_count;
  const gint64 t0 = g_get_monotonic_time();
  int w = 0, h = 0, ox = 0, oy = 0;
  dt_hash_t kept = DT_INVALID_HASH;
  const gboolean ok = session_render(pipe, devid, size, size, 0.0, 0, 0, NULL, &w, &h, &ox, &oy, &kept, NULL, err);
  out->ms = engine_ms_since(t0);
  out->cl_errors = cl->error_count - errors;
  out->devid = devid;
  if(devid > DT_DEVICE_CPU) dt_opencl_unlock_device(devid);
  cl->enabled = enabled;
  if(!ok) return FALSE;
  out->w = w;
  out->h = h;
  out->pixels = g_malloc((size_t)4 * w * h);
  memcpy(out->pixels, pipe->backbuf, (size_t)4 * w * h);
  return TRUE;
}

// the difference, amplified 8x, so a failing case shows where it differs
static void _parity_diff_png(const char *path, const parity_pass_t *a, const parity_pass_t *b)
{
  cairo_surface_t *surf = cairo_image_surface_create(CAIRO_FORMAT_RGB24, a->w, a->h);
  uint8_t *dst = cairo_image_surface_get_data(surf);
  const int stride = cairo_image_surface_get_stride(surf);
  cairo_surface_flush(surf);
  for(int j = 0; j < a->h; j++)
    for(int i = 0; i < a->w; i++)
    {
      const size_t k = 4 * ((size_t)j * a->w + i);
      uint8_t *d = dst + (size_t)j * stride + 4 * i;
      for(int c = 0; c < 3; c++) d[c] = MIN(255, 8 * abs((int)a->pixels[k + c] - (int)b->pixels[k + c]));
      d[3] = 255;
    }
  cairo_surface_mark_dirty(surf);
  cairo_surface_write_to_png(surf, path);
  cairo_surface_destroy(surf);
}

static void _parity_pass_json(JsonBuilder *b, const char *name, const parity_pass_t *p)
{
  json_builder_set_member_name(b, name);
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "ms");
  json_builder_add_double_value(b, p->ms);
  engine_add_int(b, "devid", p->devid);
#ifdef HAVE_OPENCL
  if(p->devid > DT_DEVICE_CPU) engine_add_string(b, "device", darktable.opencl->dev[p->devid].fullname);
#endif
  engine_add_int(b, "cl_errors", p->cl_errors);
  json_builder_end_object(b);
}

gboolean device_parity(JsonObject *req, JsonBuilder *b, char **err)
{
  if(!_s.open)
  {
    *err = g_strdup("no image open");
    return FALSE;
  }
  const int size = CLAMP(json_object_get_int_member_with_default(req, "size", 1024), 64, 8192);
  // "self": both passes on the CPU, a check of the comparison itself
  const gboolean self = json_object_get_boolean_member_with_default(req, "self", FALSE);
  if(!self && !dt_opencl_running())
  {
    *err = g_strdup("no OpenCL device");
    return FALSE;
  }
  if(!session_follower_ready(&_s.check, err)) return FALSE;
  parity_pass_t cpu = { 0 }, gpu = { 0 };
  gboolean ok = _parity_pass("cpu", FALSE, size, &cpu, err)
                && _parity_pass("gpu", !self, size, &gpu, err);
  // a pass whose device failed comes back from the CPU, flushed: the next
  // render of the check pipe starts clean either way
  if(ok && (cpu.w != gpu.w || cpu.h != gpu.h))
  {
    *err = g_strdup_printf("the passes differ in size: %dx%d and %dx%d", cpu.w, cpu.h, gpu.w, gpu.h);
    ok = FALSE;
  }
  if(ok)
  {
    const size_t n = (size_t)cpu.w * cpu.h;
    float *de = g_malloc(sizeof(float) * n);
    double sum = 0.0, chan_sum[3] = { 0 };
    float de_max = 0.0f;
    int chan_max[3] = { 0 };
    size_t over = 0;
    for(size_t k = 0; k < n; k++)
    {
      const uint8_t *p = cpu.pixels + 4 * k, *q = gpu.pixels + 4 * k;
      float l1[3], l2[3];
      _bgra_lab(p, l1);
      _bgra_lab(q, l2);
      const float d = sqrtf((l1[0] - l2[0]) * (l1[0] - l2[0]) + (l1[1] - l2[1]) * (l1[1] - l2[1])
                            + (l1[2] - l2[2]) * (l1[2] - l2[2]));
      de[k] = d;
      sum += d;
      de_max = fmaxf(de_max, d);
      over += d > 2.0f;
      // RGB order out of BGRA
      for(int c = 0; c < 3; c++)
      {
        const int diff = abs((int)p[2 - c] - (int)q[2 - c]);
        chan_sum[c] += diff;
        chan_max[c] = MAX(chan_max[c], diff);
      }
    }
    // p99 by a histogram of 0.01 steps up to 100
    guint *hist = g_malloc0(sizeof(guint) * 10001);
    for(size_t k = 0; k < n; k++) hist[MIN(10000, (int)(de[k] * 100.0f))]++;
    size_t seen = 0;
    int p99 = 0;
    while(p99 < 10000 && (seen += hist[p99]) < (size_t)ceil(0.99 * n)) p99++;
    g_free(hist);
    g_free(de);
    engine_add_int(b, "width", cpu.w);
    engine_add_int(b, "height", cpu.h);
    engine_add_bool(b, "self", self);
    _parity_pass_json(b, "cpu", &cpu);
    _parity_pass_json(b, "gpu", &gpu);
    json_builder_set_member_name(b, "de");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "mean");
    json_builder_add_double_value(b, sum / n);
    json_builder_set_member_name(b, "p99");
    json_builder_add_double_value(b, p99 / 100.0);
    json_builder_set_member_name(b, "max");
    json_builder_add_double_value(b, de_max);
    json_builder_set_member_name(b, "over2");
    json_builder_add_double_value(b, (double)over / n);
    json_builder_end_object(b);
    const char *names[] = { "r", "g", "b" };
    json_builder_set_member_name(b, "rgb");
    json_builder_begin_object(b);
    for(int c = 0; c < 3; c++)
    {
      json_builder_set_member_name(b, names[c]);
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "mean");
      json_builder_add_double_value(b, chan_sum[c] / n);
      engine_add_int(b, "max", chan_max[c]);
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
    const char *diff = json_object_get_string_member_with_default(req, "diff", NULL);
    if(diff && p99 >= 200)
    {
      _parity_diff_png(diff, &cpu, &gpu);
      engine_add_string(b, "diff", diff);
    }
  }
  g_free(cpu.pixels);
  g_free(gpu.pixels);
  // the check pipe's cache holds two full passes (about 500 MB after a 1024
  // pixel check on 16 megapixels) and a check is rare: the next one makes it
  // again (session_follower_ready)
  session_follower_cleanup(&_s.check);
  return ok;
}

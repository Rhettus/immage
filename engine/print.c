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

// darktable's print view keeps its job in the GTK library module
// (libs/print_settings.c: _export_image, _create_pdf, _print_job_run). the
// parts below follow it, without its screen layout: the client sends the
// page and the image's area in millimeters

#include "print.h"

#include "common/colorspaces.h"
#include "common/darktable.h"
#include "common/file_location.h"
#include "common/utility.h"
#include "imageio/imageio_common.h"
#include "imageio/imageio_module.h"

#ifdef HAVE_PRINT
#include "common/pdf.h"
#include "common/printing.h"
#include "common/printprof.h"
#ifdef _WIN32
// in the print view's order (print_settings.c)
#include "win/win32_print.h"
#include <windows.h>
#include <prntvpt.h>
#include <objidl.h>
#include <winspool.h>
#else
#include <cups/cups.h>
// macOS's SDK and newer CUPS mark cupsGetDests() and its kind deprecated,
// which -Werror would make fatal; darktable's cups_print.c does the same
#pragma GCC diagnostic ignored "-Wdeprecated-declarations"
#endif
#endif

#include <glib/gstdio.h>
#include <lcms2.h>
#include <string.h>

static void _member_string(JsonBuilder *b, const char *name, const char *value)
{
  json_builder_set_member_name(b, name);
  json_builder_add_string_value(b, value ? value : "");
}

// ---------------------------------------------------------------- profiles

// what an ICC header says: device class at byte 12, data color space at 16
static gboolean _header(const char *path, guint32 *cls, guint32 *space)
{
  FILE *f = g_fopen(path, "rb");
  if(!f) return FALSE;
  guint8 h[20];
  const gboolean ok = fread(h, 1, sizeof(h), f) == sizeof(h);
  fclose(f);
  if(!ok) return FALSE;
  *cls = (guint32)h[12] << 24 | (guint32)h[13] << 16 | (guint32)h[14] << 8 | h[15];
  *space = (guint32)h[16] << 24 | (guint32)h[17] << 16 | (guint32)h[18] << 8 | h[19];
  return TRUE;
}

static gboolean _is_icc(const char *name)
{
  const char *dot = strrchr(name, '.');
  return dot && (!g_ascii_strcasecmp(dot, ".icc") || !g_ascii_strcasecmp(dot, ".icm"));
}

static const dt_colorspaces_color_profile_t *_listed(const char *file)
{
  return dt_colorspaces_get_profile(DT_COLORSPACE_FILE, file, DT_PROFILE_DIRECTION_OUT);
}

// add an RGB profile that can be printed to (lcms can make an output
// transform with it) to darktable's output profiles, which colorout looks
// the soft proof's up in. darktable reads them only at startup
// (colorspaces.c, dt_colorspaces_init). the entry goes on the front of the
// list: a thread walking it meanwhile (an export reading its profile) holds
// the old head and never sees the change, and one starting later reads the
// new head, whole before it is published. only the main loop adds
static const dt_colorspaces_color_profile_t *_register(const char *file)
{
  const dt_colorspaces_color_profile_t *had = _listed(file);
  if(had) return had;

  size_t len = 0;
  char *data = dt_read_file(file, &len);
  if(!data) return NULL;
  cmsHPROFILE h = cmsOpenProfileFromMem(data, len);
  free(data);
  if(!h) return NULL;
  if(cmsGetColorSpace(h) != cmsSigRgbData
     || !cmsIsIntentSupported(h, INTENT_RELATIVE_COLORIMETRIC, LCMS_USED_AS_OUTPUT))
  {
    cmsCloseProfile(h);
    return NULL;
  }

  dt_colorspaces_color_profile_t *p = calloc(1, sizeof(dt_colorspaces_color_profile_t));
  if(!p)
  {
    cmsCloseProfile(h);
    return NULL;
  }
  const char *lang = g_getenv("LANG");
  if(!lang || strlen(lang) < 5) lang = "en_US";
  char language[3] = { lang[0], lang[1], 0 }, country[3] = { lang[3], lang[4], 0 };
  dt_colorspaces_get_profile_name(h, language, country, p->name, sizeof(p->name));
  if(!*p->name)
  {
    gchar *base = g_path_get_basename(file);
    g_strlcpy(p->name, base, sizeof(p->name));
    g_free(base);
  }
  g_strlcpy(p->filename, file, sizeof(p->filename));
  p->type = DT_COLORSPACE_FILE;
  p->profile = h;
  int out_pos = -1;
  for(const GList *l = darktable.color_profiles->profiles; l; l = g_list_next(l))
    out_pos = MAX(out_pos, ((const dt_colorspaces_color_profile_t *)l->data)->out_pos);
  p->in_pos = p->display_pos = p->display2_pos = p->category_pos = p->work_pos = -1;
  p->out_pos = out_pos + 1;

  pthread_rwlock_wrlock(&darktable.color_profiles->xprofile_lock);
  darktable.color_profiles->profiles = g_list_prepend(darktable.color_profiles->profiles, p);
  pthread_rwlock_unlock(&darktable.color_profiles->xprofile_lock);
  return p;
}

// printer profiles under `dir`, as printer drivers install them: in
// folders of their own, a few levels down
static void _scan(const char *dir, const int depth)
{
  GDir *d = g_dir_open(dir, 0, NULL);
  if(!d) return;
  const char *name;
  while((name = g_dir_read_name(d)))
  {
    gchar *path = g_build_filename(dir, name, NULL);
    guint32 cls = 0, space = 0;
    if(g_file_test(path, G_FILE_TEST_IS_DIR))
    {
      if(depth > 0) _scan(path, depth - 1);
    }
    // only output (printer) profiles: the system folders hold the
    // screens' and the working spaces' too
    else if(_is_icc(name) && _header(path, &cls, &space) && cls == cmsSigOutputClass && space == cmsSigRgbData)
      _register(path);
    g_free(path);
  }
  g_dir_close(d);
}

static void _scan_system(void)
{
#if defined(_WIN32)
  const char *root = g_getenv("SystemRoot");
  gchar *dir = g_build_filename(root ? root : "C:\\Windows", "System32", "spool", "drivers", "color", NULL);
  _scan(dir, 2);
  g_free(dir);
#elif defined(__APPLE__)
  gchar *user = g_build_filename(g_get_home_dir(), "Library", "ColorSync", "Profiles", NULL);
  _scan(user, 3);
  g_free(user);
  _scan("/Library/ColorSync/Profiles", 3);
  // Epson's and Canon's drivers keep theirs inside the driver
  _scan("/Library/Printers", 6);
#else
  for(const gchar *const *d = g_get_system_data_dirs(); *d; d++)
  {
    gchar *dir = g_build_filename(*d, "color", "icc", NULL);
    _scan(dir, 3);
    g_free(dir);
  }
  gchar *user = g_build_filename(g_get_user_data_dir(), "icc", NULL);
  _scan(user, 3);
  g_free(user);
  gchar *old = g_build_filename(g_get_home_dir(), ".color", "icc", NULL);
  _scan(old, 3);
  g_free(old);
#endif
}

static gint _by_name(gconstpointer a, gconstpointer b)
{
  return g_utf8_collate(((const dt_colorspaces_color_profile_t *)a)->name,
                        ((const dt_colorspaces_color_profile_t *)b)->name);
}

void print_profiles(JsonBuilder *b)
{
  _scan_system();
  // the ones added in Immage, kept with darktable's own
  char conf[PATH_MAX] = { 0 };
  dt_loc_get_user_config_dir(conf, sizeof(conf));
  gchar *own = g_build_filename(conf, "color", "out", NULL);
  GDir *d = g_dir_open(own, 0, NULL);
  const char *name;
  while(d && (name = g_dir_read_name(d)))
    if(_is_icc(name))
    {
      gchar *path = g_build_filename(own, name, NULL);
      _register(path);
      g_free(path);
    }
  if(d) g_dir_close(d);
  g_free(own);

  GList *sorted = NULL;
  for(GList *l = darktable.color_profiles->profiles; l; l = g_list_next(l))
  {
    const dt_colorspaces_color_profile_t *p = l->data;
    if(p->type == DT_COLORSPACE_FILE && p->out_pos > -1) sorted = g_list_prepend(sorted, (gpointer)p);
  }
  sorted = g_list_sort(sorted, _by_name);
  json_builder_begin_array(b);
  for(GList *l = sorted; l; l = g_list_next(l))
  {
    const dt_colorspaces_color_profile_t *p = l->data;
    json_builder_begin_object(b);
    _member_string(b, "name", p->name);
    _member_string(b, "file", p->filename);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  g_list_free(sorted);
}

gboolean print_profile_add(const char *path, JsonBuilder *b, char **err)
{
  guint32 cls = 0, space = 0;
  if(!path || !_header(path, &cls, &space))
  {
    *err = g_strdup("that file can't be read as an ICC profile");
    return FALSE;
  }
  if(space != cmsSigRgbData)
  {
    *err = g_strdup("only RGB printer profiles can be used: the printer driver takes RGB");
    return FALSE;
  }
  char conf[PATH_MAX] = { 0 };
  dt_loc_get_user_config_dir(conf, sizeof(conf));
  gchar *dir = g_build_filename(conf, "color", "out", NULL);
  g_mkdir_with_parents(dir, 0755);
  gchar *base = g_path_get_basename(path);
  gchar *target = g_build_filename(dir, base, NULL);
  // one already there by that name: the same file is that one, another
  // gets a number
  for(int n = 2; g_file_test(target, G_FILE_TEST_EXISTS); n++)
  {
    size_t la = 0, lb = 0;
    char *a = dt_read_file(path, &la), *c = dt_read_file(target, &lb);
    const gboolean same = a && c && la == lb && !memcmp(a, c, la);
    free(a);
    free(c);
    if(same) break;
    g_free(target);
    const char *dot = strrchr(base, '.');
    gchar *stem = g_strndup(base, dot ? (gsize)(dot - base) : strlen(base));
    gchar *numbered = g_strdup_printf("%s-%d%s", stem, n, dot ? dot : "");
    target = g_build_filename(dir, numbered, NULL);
    g_free(stem);
    g_free(numbered);
  }
  g_free(dir);
  g_free(base);
  if(!g_file_test(target, G_FILE_TEST_EXISTS)) dt_copy_file(path, target);
  const dt_colorspaces_color_profile_t *p = g_file_test(target, G_FILE_TEST_EXISTS) ? _register(target) : NULL;
  if(!p)
  {
    if(g_file_test(target, G_FILE_TEST_EXISTS) && !_listed(target)) g_unlink(target);
    *err = g_strdup_printf("'%s' can't be used to print with", path);
    g_free(target);
    return FALSE;
  }
  _member_string(b, "name", p->name);
  _member_string(b, "file", p->filename);
  g_free(target);
  return TRUE;
}

// ---------------------------------------------------------------- soft proof

// colorout proofs with the display intent (colorout.c, commit_params:
// cmsCreateProofingTransform takes out_intent, the display's, for the step
// into the proof profile), so it is the print's while proofing, and the
// display's own again after
static dt_iop_color_intent_t _display_intent = DT_INTENT_PERCEPTUAL;

gboolean print_softproof(const char *mode, const char *file, const int intent, gboolean *changed, char **err)
{
  dt_colorspaces_t *cp = darktable.color_profiles;
  const dt_colorspaces_color_profile_t *p = NULL;
  dt_colorspaces_color_mode_t next = DT_PROFILE_NORMAL;
  if(!g_strcmp0(mode, "proof")) next = DT_PROFILE_SOFTPROOF;
  else if(!g_strcmp0(mode, "gamut")) next = DT_PROFILE_GAMUTCHECK;
  else if(g_strcmp0(mode, "off"))
  {
    *err = g_strdup_printf("no soft proof mode '%s'", mode ? mode : "");
    return FALSE;
  }
  if(next != DT_PROFILE_NORMAL)
  {
    p = file && *file ? _register(file) : NULL;
    if(!p)
    {
      *err = g_strdup_printf("the profile '%s' can't be used to proof", file ? file : "");
      return FALSE;
    }
  }
  const dt_iop_color_intent_t want = intent >= 0 && intent < DT_INTENT_LAST ? intent : DT_INTENT_PERCEPTUAL;
  // lcms paints out of gamut colors with its alarm codes, 50% gray unless
  // set, which a photo hides; colorout looks for cyan (colorout.c,
  // _transform_lcms) but never sets them. they are read only by transforms
  // made with cmsFLAGS_GAMUTCHECK
  static const cmsUInt16Number cyan[cmsMAXCHANNELS] = { 0, 0xffff, 0xffff };
  if(next == DT_PROFILE_GAMUTCHECK) cmsSetAlarmCodes(cyan);

  pthread_rwlock_wrlock(&cp->xprofile_lock);
  const gboolean was = cp->mode != DT_PROFILE_NORMAL;
  *changed = cp->mode != next
             || (next != DT_PROFILE_NORMAL
                 && (cp->softproof_type != DT_COLORSPACE_FILE || strcmp(cp->softproof_filename, p->filename)
                     || cp->display_intent != want));
  if(next == DT_PROFILE_NORMAL)
  {
    if(was) cp->display_intent = _display_intent;
  }
  else
  {
    if(!was) _display_intent = cp->display_intent;
    cp->softproof_type = DT_COLORSPACE_FILE;
    g_strlcpy(cp->softproof_filename, p->filename, sizeof(cp->softproof_filename));
    cp->softproof_intent = want;
    cp->display_intent = want;
  }
  cp->mode = next;
  pthread_rwlock_unlock(&cp->xprofile_lock);
  return TRUE;
}

dt_hash_t print_proof_hash(const dt_hash_t hash)
{
  const dt_colorspaces_t *cp = darktable.color_profiles;
  if(cp->mode == DT_PROFILE_NORMAL) return hash;
  const int what[2] = { cp->mode, cp->display_intent };
  const dt_hash_t h = dt_hash(hash, what, sizeof(what));
  return dt_hash(h, cp->softproof_filename, strlen(cp->softproof_filename));
}

// ---------------------------------------------------------------- printers

#ifdef HAVE_PRINT
static void _member_double(JsonBuilder *b, const char *name, const double value)
{
  json_builder_set_member_name(b, name);
  json_builder_add_double_value(b, value);
}

gboolean print_available(void)
{
  return TRUE;
}

void print_printers(JsonBuilder *b)
{
  json_builder_begin_array(b);
#ifdef _WIN32
  wchar_t def[512] = { 0 };
  DWORD deflen = G_N_ELEMENTS(def);
  gchar *default_name = GetDefaultPrinterW(def, &deflen) ? g_utf16_to_utf8((const gunichar2 *)def, -1, NULL, NULL, NULL) : NULL;
  DWORD needed = 0, count = 0;
  const DWORD flags = PRINTER_ENUM_LOCAL | PRINTER_ENUM_CONNECTIONS;
  EnumPrintersW(flags, NULL, 4, NULL, 0, &needed, &count);
  PRINTER_INFO_4W *list = needed ? g_malloc(needed) : NULL;
  if(list && EnumPrintersW(flags, NULL, 4, (LPBYTE)list, needed, &needed, &count))
    for(DWORD k = 0; k < count; k++)
    {
      gchar *name = g_utf16_to_utf8((const gunichar2 *)list[k].pPrinterName, -1, NULL, NULL, NULL);
      if(!name) continue;
      json_builder_begin_object(b);
      _member_string(b, "name", name);
      _member_string(b, "description", name);
      json_builder_set_member_name(b, "default");
      json_builder_add_boolean_value(b, !g_strcmp0(name, default_name));
      json_builder_end_object(b);
      g_free(name);
    }
  g_free(list);
  g_free(default_name);
#else
  cups_dest_t *dests = NULL;
  const int n = cupsGetDests(&dests);
  for(int k = 0; k < n; k++)
  {
    const cups_dest_t *d = &dests[k];
    if(d->instance) continue;
    const char *info = cupsGetOption("printer-info", d->num_options, d->options);
    json_builder_begin_object(b);
    _member_string(b, "name", d->name);
    _member_string(b, "description", info && *info ? info : d->name);
    json_builder_set_member_name(b, "default");
    json_builder_add_boolean_value(b, d->is_default);
    json_builder_end_object(b);
  }
  cupsFreeDests(n, dests);
#endif
  json_builder_end_array(b);
}

gboolean print_printer(const char *name, JsonBuilder *b, char **err)
{
  if(!name || !*name)
  {
    *err = g_strdup("no printer named");
    return FALSE;
  }
  dt_printer_info_t pr;
  memset(&pr, 0, sizeof(pr));
  dt_get_printer_info(name, &pr);
  if(!*pr.name)
  {
    *err = g_strdup_printf("no printer '%s'", name);
    return FALSE;
  }
  json_builder_set_member_name(b, "resolution");
  json_builder_add_int_value(b, pr.resolution > 0 ? pr.resolution : 300);
  json_builder_set_member_name(b, "margins");
  json_builder_begin_object(b);
  _member_double(b, "top", pr.hw_margin_top);
  _member_double(b, "bottom", pr.hw_margin_bottom);
  _member_double(b, "left", pr.hw_margin_left);
  _member_double(b, "right", pr.hw_margin_right);
  json_builder_end_object(b);

  // the paper the printer is set to, as CUPS names it
  const char *media = NULL;
#ifndef _WIN32
  cups_dest_t *dests = NULL;
  const int n = cupsGetDests(&dests);
  const cups_dest_t *d = cupsGetDest(name, NULL, n, dests);
  if(d) media = cupsGetOption("media", d->num_options, d->options);
#endif
  _member_string(b, "default_paper", media);
#ifndef _WIN32
  cupsFreeDests(n, dests);
#endif

  GList *papers = dt_get_papers(&pr);
  json_builder_set_member_name(b, "papers");
  json_builder_begin_array(b);
  for(GList *l = papers; l; l = g_list_next(l))
  {
    const dt_paper_info_t *p = l->data;
    json_builder_begin_object(b);
    _member_string(b, "name", p->name);
    _member_string(b, "common_name", p->common_name);
    _member_double(b, "width", p->width);
    _member_double(b, "height", p->height);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  g_list_free_full(papers, free);

  GList *media_types = dt_get_media_type(&pr);
  json_builder_set_member_name(b, "media");
  json_builder_begin_array(b);
  for(GList *l = media_types; l; l = g_list_next(l))
  {
    const dt_medium_info_t *m = l->data;
    json_builder_begin_object(b);
    _member_string(b, "name", m->name);
    _member_string(b, "common_name", m->common_name);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  g_list_free_full(media_types, free);
  return TRUE;
}

// ---------------------------------------------------------------- printing

// the format the export writes through: the pixels into memory, RGB
// without alpha, 8 or 16 bits (print_settings.c, write_image)
typedef struct _print_format_t
{
  dt_imageio_module_data_t head;
  int bpp;
  void *buf;
} _print_format_t;

static int _bpp(dt_imageio_module_data_t *data)
{
  return ((_print_format_t *)data)->bpp;
}

static int _levels(dt_imageio_module_data_t *data)
{
  return IMAGEIO_RGB | (((_print_format_t *)data)->bpp == 8 ? IMAGEIO_INT8 : IMAGEIO_INT16);
}

static const char *_mime(dt_imageio_module_data_t *data)
{
  return "memory";
}

static int _flags(dt_imageio_module_data_t *data)
{
  return 0;
}

static int _write_image(dt_imageio_module_data_t *data, const char *filename, const void *in,
                        dt_colorspaces_color_profile_type_t over_type, const char *over_filename, void *exif,
                        int exif_len, const dt_imgid_t imgid, const int num, const int total,
                        struct dt_dev_pixelpipe_t *pipe, const gboolean export_masks)
{
  _print_format_t *d = (_print_format_t *)data;
  const size_t bytes = d->bpp / 8, npx = (size_t)d->head.width * d->head.height;
  d->buf = g_try_malloc(3 * bytes * npx);
  if(!d->buf) return 1;
  const guint8 *src = in;
  guint8 *dst = d->buf;
  for(size_t k = 0; k < npx; k++, src += 4 * bytes, dst += 3 * bytes) memcpy(dst, src, 3 * bytes);
  return 0;
}

static double _number(JsonObject *o, const char *name)
{
  return o && json_object_has_member(o, name) ? json_object_get_double_member(o, name) : 0.0;
}

static const char *_string(JsonObject *o, const char *name, const char *fallback)
{
  return o ? json_object_get_string_member_with_default(o, name, fallback) : fallback;
}

// the ICC of the printed pixels: the printer profile's, or sRGB's
static guint8 *_icc_data(const char *profile, size_t *len)
{
  if(profile && *profile)
  {
    char *data = dt_read_file(profile, len);
    return (guint8 *)data;
  }
  cmsHPROFILE srgb = dt_colorspaces_get_profile(DT_COLORSPACE_SRGB, "", DT_PROFILE_DIRECTION_OUT)->profile;
  cmsUInt32Number n = 0;
  if(!cmsSaveProfileToMem(srgb, NULL, &n) || !n) return NULL;
  guint8 *data = malloc(n);
  if(data && !cmsSaveProfileToMem(srgb, data, &n))
  {
    free(data);
    return NULL;
  }
  *len = n;
  return data;
}

// the page as a PDF, as _create_pdf writes it. `embed`: the pixels tagged
// with their profile, as a saved PDF and macOS's printing want them; on
// Linux the CUPS filters would convert tagged pixels back to sRGB
// (print_settings.c, _create_pdf)
static gboolean _write_pdf(const char *path, const dt_images_box *imgs, const float page_w, const float page_h,
                           const int dpi, const char *profile, const gboolean embed)
{
  dt_pdf_t *pdf = dt_pdf_start(path, dt_pdf_mm_to_point(page_w), dt_pdf_mm_to_point(page_h), dpi,
                               DT_PDF_STREAM_ENCODER_FLATE);
  if(!pdf) return FALSE;
  int icc_id = 0;
  if(embed)
  {
    size_t len = 0;
    guint8 *icc = _icc_data(profile, &len);
    if(icc) icc_id = dt_pdf_add_icc_from_data(pdf, icc, len);
    free(icc);
  }
  const dt_image_box *box = &imgs->box[0];
  dt_pdf_image_t *image = dt_pdf_add_image(pdf, box->buf, box->exp_width, box->exp_height, box->img_bpp, icc_id, 0.0);
  if(!image)
  {
    dt_pdf_finish(pdf, NULL, 0);
    return FALSE;
  }
  image->rotate_to_fit = FALSE;
  // the PDF's origin is at the bottom left, as box->print's
  image->bb_x = dt_pdf_pixel_to_point(box->print.x, dpi);
  image->bb_y = dt_pdf_pixel_to_point(box->print.y, dpi);
  image->bb_width = dt_pdf_pixel_to_point(box->print.width, dpi);
  image->bb_height = dt_pdf_pixel_to_point(box->print.height, dpi);
  dt_pdf_page_t *page = dt_pdf_add_page(pdf, &image, 1);
  dt_pdf_finish(pdf, &page, page ? 1 : 0);
  free(image);
  free(page);
  return page != NULL;
}

#ifdef _WIN32
// the job's settings for the driver, as the print view's
// _win_build_print_ticket makes them from the printer's DEVMODE with the
// paper and orientation chosen (print_settings.c)
static gboolean _win_ticket(dt_win32_print_ctx_t *ctx, void **out, size_t *size)
{
  *out = NULL;
  *size = 0;
  if(!ctx || !ctx->cached_dm || !ctx->base || !*ctx->base->printer.name) return FALSE;
  gunichar2 *wprinter = g_utf8_to_utf16(ctx->base->printer.name, -1, NULL, NULL, NULL);
  if(!wprinter) return FALSE;
  HPTPROVIDER provider = NULL;
  HRESULT hr = PTOpenProvider((PCWSTR)wprinter, 1, &provider);
  g_free(wprinter);
  if(FAILED(hr) || !provider) return FALSE;
  gboolean ok = FALSE;
  IStream *stream = NULL;
  hr = CreateStreamOnHGlobal(NULL, TRUE, &stream);
  if(SUCCEEDED(hr) && stream)
  {
    hr = PTConvertDevModeToPrintTicket(provider, ctx->cached_dm->dmSize + ctx->cached_dm->dmDriverExtra,
                                       (PDEVMODE)ctx->cached_dm, kPTJobScope, stream);
    STATSTG st = { 0 };
    HGLOBAL global = NULL;
    if(SUCCEEDED(hr) && SUCCEEDED(stream->lpVtbl->Stat(stream, &st, STATFLAG_NONAME))
       && st.cbSize.QuadPart > 0 && SUCCEEDED(GetHGlobalFromStream(stream, &global)) && global)
    {
      const void *src = GlobalLock(global);
      if(src)
      {
        *out = malloc((size_t)st.cbSize.QuadPart);
        if(*out)
        {
          memcpy(*out, src, (size_t)st.cbSize.QuadPart);
          *size = (size_t)st.cbSize.QuadPart;
          ok = TRUE;
        }
        GlobalUnlock(global);
      }
    }
    stream->lpVtbl->Release(stream);
  }
  PTCloseProvider(provider);
  return ok;
}
#endif

gboolean print_image(const dt_imgid_t imgid, JsonObject *req, JsonBuilder *b, char **err)
{
  const char *pdf_path = json_object_get_string_member_with_default(req, "pdf", NULL);
  const char *printer = json_object_get_string_member_with_default(req, "printer", NULL);
  const char *profile = json_object_get_string_member_with_default(req, "profile", "");
  const char *title = json_object_get_string_member_with_default(req, "title", "Immage");
  const int intent = json_object_get_int_member_with_default(req, "intent", DT_INTENT_PERCEPTUAL);
  const gboolean bpc = json_object_get_boolean_member_with_default(req, "bpc", TRUE);
  JsonObject *page = json_object_has_member(req, "page") ? json_object_get_object_member(req, "page") : NULL;
  JsonObject *area = json_object_has_member(req, "area") ? json_object_get_object_member(req, "area") : NULL;
  // the page as it is laid out, landscape already turned
  const float page_w = _number(page, "width"), page_h = _number(page, "height");
  const float ax = _number(area, "x"), ay = _number(area, "y"), aw = _number(area, "width"),
              ah = _number(area, "height");
  if(!pdf_path && !(printer && *printer))
  {
    *err = g_strdup("print needs a printer or a PDF to write");
    return FALSE;
  }
  if(page_w <= 0.0f || page_h <= 0.0f || aw <= 0.0f || ah <= 0.0f || ax < 0.0f || ay < 0.0f
     || ax + aw > page_w + 0.01f || ay + ah > page_h + 0.01f)
  {
    *err = g_strdup("the photo's area does not fit on the page");
    return FALSE;
  }

  dt_print_info_t prt;
  dt_init_print_info(&prt);
  if(!pdf_path)
  {
    dt_get_printer_info(printer, &prt.printer);
    if(!*prt.printer.name)
    {
      *err = g_strdup_printf("no printer '%s'", printer);
      return FALSE;
    }
    JsonObject *paper = json_object_has_member(req, "paper") ? json_object_get_object_member(req, "paper") : NULL;
    // the printer's own entry for the paper, with what the client does not
    // know (Windows' DEVMODE paper id)
    GList *papers = dt_get_papers(&prt.printer);
    const dt_paper_info_t *known = dt_get_paper(papers, _string(paper, "name", ""));
    if(known) prt.paper = *known;
    g_list_free_full(papers, free);
    if(!known)
    {
      g_strlcpy(prt.paper.name, _string(paper, "name", ""), sizeof(prt.paper.name));
      g_strlcpy(prt.paper.common_name, _string(paper, "common_name", prt.paper.name),
                sizeof(prt.paper.common_name));
      prt.paper.width = _number(paper, "width");
      prt.paper.height = _number(paper, "height");
    }
    g_strlcpy(prt.medium.name, json_object_get_string_member_with_default(req, "medium", ""),
              sizeof(prt.medium.name));
    prt.page.landscape = page_w > page_h;
    prt.printer.intent = intent;
    if(profile && *profile) g_strlcpy(prt.printer.profile, profile, sizeof(prt.printer.profile));
  }
  int dpi = json_object_get_int_member_with_default(req, "dpi", 0);
  if(dpi <= 0) dpi = prt.printer.resolution > 0 ? prt.printer.resolution : 300;
  dpi = CLAMP(dpi, 72, 1440);

  // one image on the page, at its area (printing.c lays the boxes out)
  dt_images_box *imgs = calloc(1, sizeof(dt_images_box));
  if(!imgs)
  {
    *err = g_strdup("out of memory");
    return FALSE;
  }
  imgs->count = 1;
  dt_image_box *box = &imgs->box[0];
  box->imgid = imgid;
  box->pos = (dt_image_pos){ ax / page_w, ay / page_h, aw / page_w, ah / page_h };
  // printing.c sizes the box as shown on screen too; nothing is shown
  box->screen = (dt_image_pos){ 0.0f, 0.0f, 1e9f, 1e9f };
  dt_printing_setup_page(imgs, page_w, page_h, dpi);

  // a printer profile takes 16 bits in ProPhoto, which holds every color a
  // printer has; without one, the driver is given sRGB to manage
  const gboolean managed = profile && *profile;
  _print_format_t data = { .bpp = managed ? 16 : 8 };
  data.head.max_width = box->max_width;
  data.head.max_height = box->max_height;
  data.head.style_append = TRUE;
  dt_imageio_module_format_t fmt;
  memset(&fmt, 0, sizeof(fmt));
  fmt.mime = _mime;
  fmt.levels = _levels;
  fmt.bpp = _bpp;
  fmt.flags = _flags;
  fmt.write_image = _write_image;
  const dt_colorspaces_color_profile_type_t icc = managed ? DT_COLORSPACE_PROPHOTO_RGB : DT_COLORSPACE_SRGB;
  // NB: returns TRUE on failure. upscaled to fill the area, as the print
  // view does
  const gboolean failed = dt_imageio_export_with_flags(
      imgid, "unused", &fmt, &data.head, TRUE /*ignore_exif*/, FALSE, TRUE /*high_quality*/, TRUE /*upscale*/,
      FALSE, 1.0, FALSE, NULL, FALSE, FALSE, icc, NULL, DT_INTENT_PERCEPTUAL, NULL, NULL, 1, 1, NULL, -1);
  if(failed || !data.buf)
  {
    g_free(data.buf);
    free(imgs);
    *err = g_strdup("could not render the photo");
    return FALSE;
  }

  if(managed)
  {
    cmsHPROFILE out = cmsOpenProfileFromFile(profile, "r");
    const dt_colorspaces_color_profile_t *in = dt_colorspaces_get_profile(icc, "", DT_PROFILE_DIRECTION_OUT);
    // dt_apply_printer_profile replaces the buffer, g_free()ing this one
    const int bad = !out || !in
                    || dt_apply_printer_profile(&data.buf, data.head.width, data.head.height, 16, in->profile, out,
                                                intent, bpc);
    if(out) cmsCloseProfile(out);
    if(bad)
    {
      g_free(data.buf);
      free(imgs);
      *err = g_strdup_printf("could not convert the photo with the profile '%s'", profile);
      return FALSE;
    }
  }

  // its place on the page, aligned in its area
  const int align = CLAMP(json_object_get_int_member_with_default(req, "alignment", ALIGNMENT_CENTER),
                          ALIGNMENT_TOP_LEFT, ALIGNMENT_BOTTOM_RIGHT);
  dt_printing_setup_image(imgs, 0, imgid, data.head.width, data.head.height, align);
  box->buf = data.buf;
  box->img_bpp = data.bpp;
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, data.head.width);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, data.head.height);
  json_builder_set_member_name(b, "dpi");
  json_builder_add_int_value(b, dpi);

#ifdef _WIN32
  if(!pdf_path)
  {
    dt_win32_print_ctx_t *ctx = dt_win32_print_ctx_new(&prt);
    void *ticket = NULL;
    size_t ticket_size = 0;
    if(ctx && ctx->cached_dm)
    {
      dt_sync_print_settings_to_dm(ctx->cached_dm, &prt);
      _win_ticket(ctx, &ticket, &ticket_size);
    }
    size_t icc_len = 0;
    guint8 *icc_data = _icc_data(profile, &icc_len);
    const gboolean ok = dt_win_print_file(imgs, title, &prt, ticket, ticket_size, icc_data, icc_len,
                                          ctx ? ctx->is_color_device : TRUE, page_w, page_h);
    free(icc_data);
    free(ticket);
    if(ctx) dt_win32_print_ctx_free(ctx);
    g_free(box->buf);
    free(imgs);
    if(!ok) *err = g_strdup_printf("printing on '%s' failed", printer);
    return ok;
  }
#endif

  // the PDF wants 16 bits big endian
  if(box->img_bpp == 16)
  {
    guint16 *px = box->buf;
    for(size_t k = 0; k < (size_t)3 * box->exp_width * box->exp_height; k++) px[k] = GUINT16_TO_BE(px[k]);
  }

  gboolean ok = TRUE;
  if(pdf_path)
  {
    gchar *dir = g_path_get_dirname(pdf_path);
    g_mkdir_with_parents(dir, 0755);
    g_free(dir);
    ok = _write_pdf(pdf_path, imgs, page_w, page_h, dpi, profile, TRUE);
    if(!ok) *err = g_strdup_printf("could not write '%s'", pdf_path);
  }
#ifndef _WIN32
  else
  {
    char tmp[PATH_MAX] = { 0 };
    dt_loc_get_tmp_dir(tmp, sizeof(tmp));
    gchar *file = g_build_filename(tmp, "immage-print-XXXXXX.pdf", NULL);
    const gint fd = g_mkstemp(file);
    if(fd == -1)
    {
      ok = FALSE;
      *err = g_strdup("could not make a file to print");
    }
    else
    {
      close(fd);
#ifdef __APPLE__
      const gboolean embed = managed;
#else
      const gboolean embed = FALSE;
#endif
      ok = _write_pdf(file, imgs, page_w, page_h, dpi, profile, embed);
      if(!ok) *err = g_strdup("could not write the page to print");
      else
      {
        // dt_print_file says nothing back; CUPS keeps the last error
        dt_print_file(imgid, file, title, &prt);
        if(cupsLastError() > IPP_STATUS_OK_EVENTS_COMPLETE)
        {
          ok = FALSE;
          *err = g_strdup_printf("printing on '%s' failed: %s", printer, cupsLastErrorString());
        }
      }
      g_unlink(file);
    }
    g_free(file);
  }
#endif
  g_free(box->buf);
  free(imgs);
  return ok;
}

#else

gboolean print_available(void)
{
  return FALSE;
}

void print_printers(JsonBuilder *b)
{
  json_builder_begin_array(b);
  json_builder_end_array(b);
}

gboolean print_printer(const char *name, JsonBuilder *b, char **err)
{
  *err = g_strdup("this engine was built without printing");
  return FALSE;
}

gboolean print_image(const dt_imgid_t imgid, JsonObject *req, JsonBuilder *b, char **err)
{
  *err = g_strdup("this engine was built without printing");
  return FALSE;
}
#endif

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
#include <pango/pangocairo.h>
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

gboolean print_proof_pixels(uint8_t *rgba, const int width, const int height, const int color_space)
{
  dt_colorspaces_t *cp = darktable.color_profiles;
  pthread_rwlock_rdlock(&cp->xprofile_lock);
  const int mode = cp->mode;
  const int intent = cp->display_intent;
  const dt_colorspaces_color_profile_t *prof
    = mode == DT_PROFILE_NORMAL ? NULL
      : dt_colorspaces_get_profile(cp->softproof_type, cp->softproof_filename, DT_PROFILE_DIRECTION_OUT);
  const dt_colorspaces_color_profile_t *in
    = prof ? dt_colorspaces_get_profile(color_space, "", DT_PROFILE_DIRECTION_ANY) : NULL;
  const dt_colorspaces_color_profile_t *srgb
    = prof ? dt_colorspaces_get_profile(DT_COLORSPACE_SRGB, "", DT_PROFILE_DIRECTION_ANY) : NULL;
  // colorout's flags (colorout.c, commit_params); the temporary profile
  // is what makes lcms quantize a parametric profile's curves
  cmsHPROFILE proof = prof && in && srgb ? dt_colorspaces_make_temporary_profile(prof->profile) : NULL;
  cmsHTRANSFORM xform = NULL;
  if(proof)
  {
    uint32_t flags = cmsFLAGS_SOFTPROOFING | cmsFLAGS_NOCACHE | cmsFLAGS_BLACKPOINTCOMPENSATION;
    if(mode == DT_PROFILE_GAMUTCHECK) flags |= cmsFLAGS_GAMUTCHECK;
    xform = cmsCreateProofingTransform(in->profile, TYPE_RGBA_8, srgb->profile, TYPE_RGBA_8, proof, intent,
                                       INTENT_RELATIVE_COLORIMETRIC, flags);
    cmsCloseProfile(proof);
  }
  pthread_rwlock_unlock(&cp->xprofile_lock);
  if(!xform) return FALSE;
  // alpha is the cache's 0 or 255; lcms carries it through only as is
  for(int y = 0; y < height; y++)
  {
    uint8_t *row = rgba + (size_t)4 * width * y;
    cmsDoTransform(xform, row, row, width);
  }
  cmsDeleteTransform(xform);
  return TRUE;
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

// a PDF written a page at a time, as _create_pdf writes it. `embed`: the
// pixels tagged with their profile, as a saved PDF and macOS's printing want
// them; on Linux the CUPS filters would convert tagged pixels back to sRGB
// (print_settings.c, _create_pdf). dt_pdf_add_image writes the pixels to the
// file as it is called, so a page's buffer can go as soon as it is added
typedef struct _pdf_out_t
{
  dt_pdf_t *pdf;
  int icc_id, dpi;
  GPtrArray *pages;
} _pdf_out_t;

static gboolean _pdf_open(_pdf_out_t *o, const char *path, const float page_w, const float page_h, const int dpi,
                          const char *profile, const gboolean embed)
{
  memset(o, 0, sizeof(*o));
  o->pdf = dt_pdf_start(path, dt_pdf_mm_to_point(page_w), dt_pdf_mm_to_point(page_h), dpi,
                        DT_PDF_STREAM_ENCODER_FLATE);
  if(!o->pdf) return FALSE;
  o->dpi = dpi;
  o->pages = g_ptr_array_new_with_free_func(free);
  if(embed)
  {
    size_t len = 0;
    guint8 *icc = _icc_data(profile, &len);
    if(icc) o->icc_id = dt_pdf_add_icc_from_data(o->pdf, icc, len);
    free(icc);
  }
  return TRUE;
}

// `box`'s pixels as the next page, at its print position
static gboolean _pdf_page(_pdf_out_t *o, const dt_image_box *box)
{
  dt_pdf_image_t *image = dt_pdf_add_image(o->pdf, box->buf, box->exp_width, box->exp_height, box->img_bpp,
                                           o->icc_id, 0.0);
  if(!image) return FALSE;
  image->rotate_to_fit = FALSE;
  // the PDF's origin is at the bottom left, as box->print's
  image->bb_x = dt_pdf_pixel_to_point(box->print.x, o->dpi);
  image->bb_y = dt_pdf_pixel_to_point(box->print.y, o->dpi);
  image->bb_width = dt_pdf_pixel_to_point(box->print.width, o->dpi);
  image->bb_height = dt_pdf_pixel_to_point(box->print.height, o->dpi);
  dt_pdf_page_t *page = dt_pdf_add_page(o->pdf, &image, 1);
  free(image);
  if(!page) return FALSE;
  g_ptr_array_add(o->pages, page);
  return TRUE;
}

// the file, with the pages added; it is finished whatever came before
static gboolean _pdf_close(_pdf_out_t *o)
{
  const gboolean ok = o->pages->len > 0;
  dt_pdf_finish(o->pdf, (dt_pdf_page_t **)o->pages->pdata, o->pages->len);
  g_ptr_array_free(o->pages, TRUE);
  return ok;
}

static gboolean _write_pdf(const char *path, const dt_images_box *imgs, const float page_w, const float page_h,
                           const int dpi, const char *profile, const gboolean embed)
{
  _pdf_out_t out;
  if(!_pdf_open(&out, path, page_w, page_h, dpi, profile, embed)) return FALSE;
  const gboolean added = _pdf_page(&out, &imgs->box[0]);
  return _pdf_close(&out) && added;
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

// what a print job is, from the request: where it goes, the page, the
// printer's paper and the resolution. print_image and print_sheet share it
typedef struct _job_t
{
  const char *pdf_path, *printer, *profile, *title;
  int intent, dpi;
  gboolean bpc;
  float page_w, page_h;
  dt_print_info_t prt;
} _job_t;

static gboolean _job_setup(JsonObject *req, _job_t *job, char **err)
{
  memset(job, 0, sizeof(*job));
  job->pdf_path = json_object_get_string_member_with_default(req, "pdf", NULL);
  job->printer = json_object_get_string_member_with_default(req, "printer", NULL);
  job->profile = json_object_get_string_member_with_default(req, "profile", "");
  job->title = json_object_get_string_member_with_default(req, "title", "Immage");
  job->intent = json_object_get_int_member_with_default(req, "intent", DT_INTENT_PERCEPTUAL);
  job->bpc = json_object_get_boolean_member_with_default(req, "bpc", TRUE);
  JsonObject *page = json_object_has_member(req, "page") ? json_object_get_object_member(req, "page") : NULL;
  // the page as it is laid out, landscape already turned
  job->page_w = _number(page, "width");
  job->page_h = _number(page, "height");
  if(!job->pdf_path && !(job->printer && *job->printer))
  {
    *err = g_strdup("print needs a printer or a PDF to write");
    return FALSE;
  }
  if(job->page_w <= 0.0f || job->page_h <= 0.0f)
  {
    *err = g_strdup("the page has no size");
    return FALSE;
  }

  dt_print_info_t *prt = &job->prt;
  dt_init_print_info(prt);
  if(!job->pdf_path)
  {
    dt_get_printer_info(job->printer, &prt->printer);
    if(!*prt->printer.name)
    {
      *err = g_strdup_printf("no printer '%s'", job->printer);
      return FALSE;
    }
    JsonObject *paper = json_object_has_member(req, "paper") ? json_object_get_object_member(req, "paper") : NULL;
    // the printer's own entry for the paper, with what the client does not
    // know (Windows' DEVMODE paper id)
    GList *papers = dt_get_papers(&prt->printer);
    const dt_paper_info_t *known = dt_get_paper(papers, _string(paper, "name", ""));
    if(known) prt->paper = *known;
    g_list_free_full(papers, free);
    if(!known)
    {
      g_strlcpy(prt->paper.name, _string(paper, "name", ""), sizeof(prt->paper.name));
      g_strlcpy(prt->paper.common_name, _string(paper, "common_name", prt->paper.name),
                sizeof(prt->paper.common_name));
      prt->paper.width = _number(paper, "width");
      prt->paper.height = _number(paper, "height");
    }
    g_strlcpy(prt->medium.name, json_object_get_string_member_with_default(req, "medium", ""),
              sizeof(prt->medium.name));
    prt->page.landscape = job->page_w > job->page_h;
    prt->printer.intent = job->intent;
    if(job->profile && *job->profile) g_strlcpy(prt->printer.profile, job->profile, sizeof(prt->printer.profile));
  }
  int dpi = json_object_get_int_member_with_default(req, "dpi", 0);
  if(dpi <= 0) dpi = prt->printer.resolution > 0 ? prt->printer.resolution : 300;
  job->dpi = CLAMP(dpi, 72, 1440);
  return TRUE;
}

#ifdef _WIN32
// one page to the spooler; its imgs hold the page's one box
static gboolean _win_print_page(_job_t *job, const dt_images_box *imgs)
{
  dt_win32_print_ctx_t *ctx = dt_win32_print_ctx_new(&job->prt);
  void *ticket = NULL;
  size_t ticket_size = 0;
  if(ctx && ctx->cached_dm)
  {
    dt_sync_print_settings_to_dm(ctx->cached_dm, &job->prt);
    _win_ticket(ctx, &ticket, &ticket_size);
  }
  size_t icc_len = 0;
  guint8 *icc_data = _icc_data(job->profile, &icc_len);
  const gboolean ok = dt_win_print_file(imgs, job->title, &job->prt, ticket, ticket_size, icc_data, icc_len,
                                        ctx ? ctx->is_color_device : TRUE, job->page_w, job->page_h);
  free(icc_data);
  free(ticket);
  if(ctx) dt_win32_print_ctx_free(ctx);
  return ok;
}
#endif

gboolean print_image(const dt_imgid_t imgid, JsonObject *req, JsonBuilder *b, char **err)
{
  _job_t job;
  if(!_job_setup(req, &job, err)) return FALSE;
  const char *pdf_path = job.pdf_path;
  const char *printer = job.printer;
  const char *profile = job.profile;
  const int intent = job.intent;
  const gboolean bpc = job.bpc;
  const float page_w = job.page_w, page_h = job.page_h;
  const int dpi = job.dpi;
  JsonObject *area = json_object_has_member(req, "area") ? json_object_get_object_member(req, "area") : NULL;
  const float ax = _number(area, "x"), ay = _number(area, "y"), aw = _number(area, "width"),
              ah = _number(area, "height");
  if(aw <= 0.0f || ah <= 0.0f || ax < 0.0f || ay < 0.0f || ax + aw > page_w + 0.01f || ay + ah > page_h + 0.01f)
  {
    *err = g_strdup("the photo's area does not fit on the page");
    return FALSE;
  }

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
    const gboolean ok = _win_print_page(&job, imgs);
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
        dt_print_file(imgid, file, job.title, &job.prt);
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

// ------------------------------------------------------------ the Cells layout

// the sheet's pages: each is a list of cells, a photo box and the text under
// it, in millimeters from the page's top left (app/src/print.ts, cellsLayout).
// darktable's page holds 20 boxes (MAX_IMAGE_PER_PAGE), so the page is put
// together here in one buffer and goes out as the one image of its page,
// through the same PDF, CUPS and spooler code as a single photo

static int _px(const double mm, const int dpi)
{
  return (int)lround(mm / 25.4 * dpi);
}

// `text` in black over the page's pixels, centered in the strip at x, y, w, h
// (pixels). its edges are the layout's alpha, taken from a mask Pango draws
static void _draw_label(void *page, const int pw, const int ph, const int bpp, const int x, const int y,
                        const int w, const int h, const char *text, const double points, const int dpi)
{
  if(w < 2 || h < 2 || !text || !*text) return;
  cairo_surface_t *mask = cairo_image_surface_create(CAIRO_FORMAT_A8, w, h);
  if(cairo_surface_status(mask) != CAIRO_STATUS_SUCCESS)
  {
    cairo_surface_destroy(mask);
    return;
  }
  cairo_t *cr = cairo_create(mask);
  PangoLayout *layout = pango_cairo_create_layout(cr);
  pango_cairo_context_set_resolution(pango_layout_get_context(layout), dpi);
  PangoFontDescription *font = pango_font_description_from_string("Sans");
  pango_font_description_set_size(font, (gint)(points * PANGO_SCALE));
  pango_layout_set_font_description(layout, font);
  pango_layout_set_width(layout, w * PANGO_SCALE);
  // the middle goes, so a long name keeps its extension
  pango_layout_set_ellipsize(layout, PANGO_ELLIPSIZE_MIDDLE);
  pango_layout_set_alignment(layout, PANGO_ALIGN_CENTER);
  pango_layout_set_text(layout, text, -1);
  int tw = 0, th = 0;
  pango_layout_get_pixel_size(layout, &tw, &th);
  cairo_set_source_rgba(cr, 0.0, 0.0, 0.0, 1.0);
  cairo_move_to(cr, 0.0, MAX(0.0, (h - th) / 2.0));
  pango_cairo_show_layout(cr, layout);
  cairo_surface_flush(mask);
  const guint8 *alpha = cairo_image_surface_get_data(mask);
  const int stride = cairo_image_surface_get_stride(mask);
  for(int j = 0; j < h; j++)
  {
    if(y + j < 0 || y + j >= ph) continue;
    for(int i = 0; i < w; i++)
    {
      if(x + i < 0 || x + i >= pw) continue;
      const int a = alpha[(size_t)j * stride + i];
      if(!a) continue;
      const size_t px = 3 * ((size_t)(y + j) * pw + x + i);
      for(int c = 0; c < 3; c++)
      {
        if(bpp == 16)
          ((guint16 *)page)[px + c] = (guint16)((guint32)((guint16 *)page)[px + c] * (255 - a) / 255);
        else
          ((guint8 *)page)[px + c] = (guint8)((guint32)((guint8 *)page)[px + c] * (255 - a) / 255);
      }
    }
  }
  pango_font_description_free(font);
  g_object_unref(layout);
  cairo_destroy(cr);
  cairo_surface_destroy(mask);
}

// `snap`'s photo, fitted inside max_w x max_h and upscaled to fill it as
// print_image does, in `data`: RGB, 16 bits in ProPhoto when a printer
// profile is to follow, else 8 in sRGB. the caller g_free()s data->buf
static gboolean _render_photo(const dt_imgid_t snap, const int max_w, const int max_h, const gboolean managed,
                              _print_format_t *data)
{
  memset(data, 0, sizeof(*data));
  data->bpp = managed ? 16 : 8;
  data->head.max_width = max_w;
  data->head.max_height = max_h;
  data->head.style_append = TRUE;
  dt_imageio_module_format_t fmt;
  memset(&fmt, 0, sizeof(fmt));
  fmt.mime = _mime;
  fmt.levels = _levels;
  fmt.bpp = _bpp;
  fmt.flags = _flags;
  fmt.write_image = _write_image;
  const dt_colorspaces_color_profile_type_t icc = managed ? DT_COLORSPACE_PROPHOTO_RGB : DT_COLORSPACE_SRGB;
  // a small box is not worth the full-size pass the high quality scaling
  // makes; NB: the export returns TRUE on failure
  const gboolean failed = dt_imageio_export_with_flags(
      snap, "unused", &fmt, &data->head, TRUE /*ignore_exif*/, FALSE, MAX(max_w, max_h) >= 800 /*high_quality*/,
      TRUE /*upscale*/, FALSE, 1.0, FALSE, NULL, FALSE, FALSE, icc, NULL, DT_INTENT_PERCEPTUAL, NULL, NULL, 1, 1,
      NULL, -1);
  if(failed || !data->buf || data->head.width <= 0 || data->head.height <= 0)
  {
    g_free(data->buf);
    data->buf = NULL;
    return FALSE;
  }
  return TRUE;
}

gboolean print_sheet(JsonObject *req, print_take_f take, print_release_f release, print_step_f step, gpointer ctx,
                     JsonBuilder *b, char **err)
{
  _job_t job;
  if(!_job_setup(req, &job, err)) return FALSE;
  JsonArray *pages = json_object_has_member(req, "pages") ? json_object_get_array_member(req, "pages") : NULL;
  const guint n_pages = pages ? json_array_get_length(pages) : 0;
  if(!n_pages)
  {
    *err = g_strdup("there is nothing to print");
    return FALSE;
  }
  const double points = json_object_has_member(req, "label_points")
                            ? json_object_get_double_member(req, "label_points") : 7.0;
  const gboolean managed = job.profile && *job.profile;
  const int dpi = job.dpi, pw = _px(job.page_w, dpi), ph = _px(job.page_h, dpi);
  const int bpp = managed ? 16 : 8;
  const size_t bytes = (size_t)3 * (bpp / 8) * pw * ph;
  cmsHPROFILE out_profile = NULL;
  const dt_colorspaces_color_profile_t *in_profile = NULL;
  const dt_colorspaces_color_profile_type_t icc = managed ? DT_COLORSPACE_PROPHOTO_RGB : DT_COLORSPACE_SRGB;
  if(managed)
  {
    out_profile = cmsOpenProfileFromFile(job.profile, "r");
    in_profile = dt_colorspaces_get_profile(icc, "", DT_PROFILE_DIRECTION_OUT);
    if(!out_profile || !in_profile)
    {
      if(out_profile) cmsCloseProfile(out_profile);
      *err = g_strdup_printf("could not read the profile '%s'", job.profile);
      return FALSE;
    }
  }

  // where the pages go: a PDF, written as they are made, which CUPS or a Mac
  // then prints; or, on Windows, a job to the spooler for each
  _pdf_out_t pdf = { 0 };
  gboolean pdf_open = FALSE;
  gchar *file = NULL;
  gboolean ok = TRUE;
  if(job.pdf_path)
  {
    gchar *dir = g_path_get_dirname(job.pdf_path);
    g_mkdir_with_parents(dir, 0755);
    g_free(dir);
    pdf_open = _pdf_open(&pdf, job.pdf_path, job.page_w, job.page_h, dpi, job.profile, TRUE);
    if(!pdf_open)
    {
      *err = g_strdup_printf("could not write '%s'", job.pdf_path);
      ok = FALSE;
    }
  }
#ifndef _WIN32
  else
  {
    char tmp[PATH_MAX] = { 0 };
    dt_loc_get_tmp_dir(tmp, sizeof(tmp));
    file = g_build_filename(tmp, "immage-print-XXXXXX.pdf", NULL);
    const gint fd = g_mkstemp(file);
    if(fd == -1)
    {
      *err = g_strdup("could not make a file to print");
      ok = FALSE;
    }
    else
    {
      close(fd);
#ifdef __APPLE__
      const gboolean embed = managed;
#else
      const gboolean embed = FALSE;
#endif
      pdf_open = _pdf_open(&pdf, file, job.page_w, job.page_h, dpi, job.profile, embed);
      if(!pdf_open)
      {
        *err = g_strdup("could not write the page to print");
        ok = FALSE;
      }
    }
  }
#endif

  dt_imgid_t first = NO_IMGID;
  int photos = 0, total = 0;
  for(guint p = 0; p < n_pages; p++) total += json_array_get_length(json_array_get_array_element(pages, p));
  if(step) step(ctx, 0, total);
  for(guint p = 0; ok && p < n_pages; p++)
  {
    JsonArray *cells = json_array_get_array_element(pages, p);
    guint8 *page = g_try_malloc(bytes);
    if(!page)
    {
      *err = g_strdup("out of memory");
      ok = FALSE;
      break;
    }
    // white in the page's color space: nothing for the printer to lay down
    memset(page, 0xff, bytes);
    for(guint c = 0; ok && cells && c < json_array_get_length(cells); c++)
    {
      JsonObject *cell = json_array_get_object_element(cells, c);
      const dt_imgid_t imgid = json_object_get_int_member_with_default(cell, "imgid", 0);
      JsonObject *box = json_object_has_member(cell, "box") ? json_object_get_object_member(cell, "box") : NULL;
      const int bx = _px(_number(box, "x"), dpi), by = _px(_number(box, "y"), dpi);
      const int bw = _px(_number(box, "width"), dpi), bh = _px(_number(box, "height"), dpi);
      if(bw < 1 || bh < 1) continue;
      const dt_imgid_t snap = take ? take(ctx, imgid) : imgid;
      if(!dt_is_valid_imgid(snap))
      {
        *err = g_strdup("the print was not asked for this photo");
        ok = FALSE;
        break;
      }
      _print_format_t data;
      const gboolean rendered = _render_photo(snap, bw, bh, managed, &data);
      if(release) release(ctx, snap);
      if(!rendered)
      {
        *err = g_strdup_printf("could not render photo %d", (int)imgid);
        ok = FALSE;
        break;
      }
      if(!dt_is_valid_imgid(first)) first = imgid;
      photos++;
      if(step && !step(ctx, photos, total))
      {
        g_free(data.buf);
        *err = g_strdup("stopped");
        ok = FALSE;
        break;
      }
      // centered across its box, and down it unless `valign` says "bottom", where
      // a name sits right under the photo
      const int ix = bx + (bw - data.head.width) / 2;
      const int iy = by + (!g_strcmp0(_string(cell, "valign", "center"), "bottom") ? bh - data.head.height
                                                                                  : (bh - data.head.height) / 2);
      const size_t px_bytes = (size_t)3 * (bpp / 8);
      for(int j = 0; j < data.head.height; j++)
      {
        const int y = iy + j;
        if(y < 0 || y >= ph) continue;
        const int x0 = MAX(0, ix), x1 = MIN(pw, ix + data.head.width);
        if(x1 <= x0) continue;
        memcpy(page + ((size_t)y * pw + x0) * px_bytes, (guint8 *)data.buf + ((size_t)j * data.head.width + (x0 - ix)) * px_bytes,
               (size_t)(x1 - x0) * px_bytes);
      }
      g_free(data.buf);
      JsonObject *label = json_object_has_member(cell, "label") ? json_object_get_object_member(cell, "label") : NULL;
      if(label)
        _draw_label(page, pw, ph, bpp, _px(_number(label, "x"), dpi), _px(_number(label, "y"), dpi),
                    _px(_number(label, "width"), dpi), _px(_number(label, "height"), dpi),
                    _string(label, "text", ""), points, dpi);
    }

    if(ok && managed)
    {
      // converted once for the whole page, as a single photo is
      void *buf = page;
      const int bad = dt_apply_printer_profile(&buf, pw, ph, 16, in_profile->profile, out_profile, job.intent, job.bpc);
      if(bad)
      {
        *err = g_strdup_printf("could not convert the page with the profile '%s'", job.profile);
        ok = FALSE;
      }
      else
        page = buf;  // the buffer is replaced, the old one freed
    }

    if(ok)
    {
      dt_images_box *imgs = calloc(1, sizeof(dt_images_box));
      if(!imgs)
      {
        *err = g_strdup("out of memory");
        ok = FALSE;
      }
      else
      {
        imgs->count = 1;
        dt_image_box *box = &imgs->box[0];
        box->buf = (uint16_t *)page;
        box->img_bpp = bpp;
        box->exp_width = pw;
        box->exp_height = ph;
        box->print = (dt_image_pos){ 0.0f, 0.0f, (float)pw, (float)ph };
#ifdef _WIN32
        if(!job.pdf_path)
        {
          // a spooler job to the page, a job for each
          if(!_win_print_page(&job, imgs))
          {
            *err = g_strdup_printf("printing on '%s' failed", job.printer);
            ok = FALSE;
          }
        }
        else
#endif
        {
          // the PDF wants 16 bits big endian
          if(bpp == 16)
          {
            guint16 *px = (guint16 *)page;
            for(size_t k = 0; k < (size_t)3 * pw * ph; k++) px[k] = GUINT16_TO_BE(px[k]);
          }
          if(!_pdf_page(&pdf, box))
          {
            *err = g_strdup("could not write the page to print");
            ok = FALSE;
          }
        }
        free(imgs);
      }
    }
    g_free(page);
  }

  if(out_profile) cmsCloseProfile(out_profile);
  (void)first;  // only a CUPS job names a photo
  if(pdf_open)
  {
    const gboolean written = _pdf_close(&pdf);
    if(ok && !written)
    {
      *err = g_strdup(job.pdf_path ? "could not write the PDF" : "could not write the page to print");
      ok = FALSE;
    }
  }
#ifndef _WIN32
  if(ok && file)
  {
    // dt_print_file says nothing back; CUPS keeps the last error
    dt_print_file(first, file, job.title, &job.prt);
    if(cupsLastError() > IPP_STATUS_OK_EVENTS_COMPLETE)
    {
      ok = FALSE;
      *err = g_strdup_printf("printing on '%s' failed: %s", job.printer, cupsLastErrorString());
    }
  }
  if(file) g_unlink(file);
#endif
  g_free(file);
  if(ok)
  {
    json_builder_set_member_name(b, "pages");
    json_builder_add_int_value(b, n_pages);
    json_builder_set_member_name(b, "photos");
    json_builder_add_int_value(b, photos);
    json_builder_set_member_name(b, "dpi");
    json_builder_add_int_value(b, dpi);
  }
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

gboolean print_sheet(JsonObject *req, print_take_f take, print_release_f release, print_step_f step, gpointer ctx,
                     JsonBuilder *b, char **err)
{
  *err = g_strdup("this engine was built without printing");
  return FALSE;
}
#endif

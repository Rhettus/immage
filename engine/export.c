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

// export: the frame, fonts, the export pool and queue, positive and upscale output, HDR and panorama merges

#include "engine.h"

// HDR Merge and Panorama Merge on the export thread: each writes its
// progress as it goes, a line with the request's tag and no `ok` (the
// app's engine.rs hands it on as `merge-progress`): the photos read, then
// its own stages. a `merge_cancel` of its job, which the stdin reader
// thread takes (_read_requests), stops it at its next step. the client's
// jobs are numbered, and one export thread runs one merge at a time
static gint64 _merge_canceled = 0;

void export_merge_cancel(const gint64 job)
{
  g_mutex_lock(&engine_cancel_lock);
  _merge_canceled = job;
  g_mutex_unlock(&engine_cancel_lock);
}

typedef struct _merge_progress_t
{
  FILE *out;           // NULL for a merge from the main loop, which reports nothing
  gint64 tag, job;
  const char *after;   // HDR Merge's stage once every photo is read: "merging"
} _merge_progress_t;

// `done` of `total` of `stage` ("photos", or a merge's own); FALSE once the
// merge is stopped. `last` is the stage past stopping, which the app then
// no longer offers
static gboolean _merge_report(const _merge_progress_t *pr, const char *stage, const int done, const int total,
                              const gboolean last)
{
  g_mutex_lock(&engine_cancel_lock);
  const gboolean stopped = pr->job && _merge_canceled == pr->job;
  g_mutex_unlock(&engine_cancel_lock);
  if(stopped || !pr->out) return !stopped;
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, pr->tag);
  json_builder_set_member_name(b, "progress");
  json_builder_add_boolean_value(b, TRUE);
  json_builder_set_member_name(b, "done");
  json_builder_add_int_value(b, done);
  json_builder_set_member_name(b, "total");
  json_builder_add_int_value(b, total);
  json_builder_set_member_name(b, "stage");
  json_builder_add_string_value(b, stage);
  json_builder_set_member_name(b, "last");
  json_builder_add_boolean_value(b, last);
  json_builder_end_object(b);
  engine_reply(pr->out, b);
  g_object_unref(b);
  return TRUE;
}

// hdr_merge_step_t: `done` of `total` photos read
static gboolean _merge_step(const int done, const int total, void *data)
{
  const _merge_progress_t *pr = data;
  if(done < total) engine_background_yield();
  return done < total ? _merge_report(pr, "photos", done, total, FALSE) : _merge_report(pr, pr->after, 0, 1, TRUE);
}

static _merge_progress_t _merge_progress(JsonObject *req, FILE *out, const char *after)
{
  return (_merge_progress_t){ .out = json_object_has_member(req, "tag") ? out : NULL,
                              .tag = json_object_get_int_member_with_default(req, "tag", 0),
                              .job = json_object_get_int_member_with_default(req, "job", 0),
                              .after = after };
}

// export pool jobs queued or running
gint export_jobs = 0;

// ------------------------------------------------------------ export

// the output color spaces offered, as darktable's profile types
static const struct { const char *name; dt_colorspaces_color_profile_type_t type; } _spaces[] = {
  { "srgb", DT_COLORSPACE_SRGB },
  { "adobergb", DT_COLORSPACE_ADOBERGB },
  { "displayp3", DT_COLORSPACE_DISPLAY_P3 },
  { "prophoto", DT_COLORSPACE_PROPHOTO_RGB },
};

// a frame for an export, as LRMogrify draws one: `borders` are darktable's
// framing module, one instance per item from the inside out, and `texts`
// one SVG that its watermark module lays over the framed image. both run
// after every other module (iop order). export applies a named style to its
// own copy of the history only, so the frame becomes a style for the
// duration of the export; the image's own edits are never touched. each
// export's are numbered (export_export)
#define _FRAME_STYLE "immage export frame %d"
#define _FRAME_SVG "immage-export-%d.svg"
#define _FRAME_DTSTYLE "export-frame-%d.dtstyle"

// a background export (export_run) and the main loop's exports read the
// format's quality from darktable's settings
static GMutex _format_conf_lock;

#ifdef HAVE_AI
// darktable's AI provider setting, which loading a model reads
// (backend_common.c): the upscale model and the main loop's AI masks and
// denoise each set it before they load
GMutex export_ai_load_lock;

#endif
// the format an export writes through, for _no_tmpfile_flags
static _Thread_local dt_imageio_module_format_t *_flags_of;

// the format's own flags, and no temporary file signal: export raises it
// synchronously (imageio.c), which off the main thread waits for a GLib
// main loop the engine does not run, whenever another thread is raising a
// signal at that moment (signal.c, dt_control_signal_raise()). nothing in
// the engine listens for it
static int _no_tmpfile_flags(dt_imageio_module_data_t *data)
{
  return _flags_of->flags(data) | FORMAT_FLAGS_NO_TMPFILE;
}

// a char array field of a module's params, such as watermark's filename
static gboolean _write_text(dt_iop_module_t *mod, const char *name, const char *value, char **err)
{
  dt_introspection_field_t *f = NULL;
  char *p = session_field_in(mod, mod->params, name, &f, err);
  if(!p) return FALSE;
  if(f->header.type != DT_INTROSPECTION_TYPE_ARRAY || f->Array.type != DT_INTROSPECTION_TYPE_CHAR)
  {
    *err = g_strdup_printf("'%s.%s' is not text", mod->op, name);
    return FALSE;
  }
  g_strlcpy(p, value, f->Array.count);
  return TRUE;
}

// a length in a frame item, in full-size pixels: a percentage of the
// photo's short or long edge, or pixels of the exported file
static double _frame_len(JsonObject *o, const char *key, const char *unit,
                         const int short_edge, const int long_edge, const double out_scale)
{
  const double v = json_object_get_double_member_with_default(o, key, 0.0);
  if(!g_strcmp0(unit, "px")) return v / out_scale;
  return v / 100.0 * (!g_strcmp0(unit, "long") ? long_edge : short_edge);
}

// "#rrggbb" as 0-1 RGB, white when it is not one
static void _frame_rgb(const char *hex, double rgb[3])
{
  for(int c = 0; c < 3; c++) rgb[c] = 1.0;
  if(!hex || strlen(hex) != 7 || hex[0] != '#') return;
  for(int c = 0; c < 3; c++)
  {
    char two[3] = { hex[1 + 2 * c], hex[2 + 2 * c], 0 };
    rgb[c] = strtol(two, NULL, 16) / 255.0;
  }
}

// one framing instance adding l, t, r, b pixels around a w x h input. the
// module grows one side by `size` and gives the other the frame's aspect
// (modify_roi_out(), borders.c): with the longer side as its basis it grows
// that side unless the aspect asks for the other, which is predicted here
// so `size` adds exactly that side's borders. a near tie is made an exact
// one, which the module resolves to the longer side as well
static void _frame_border_plan(const int w, const int h, const int l, const int t, const int r, const int b,
                               float *aspect, float *size)
{
  const float ia = (float)w / (float)h;
  float a = (float)(w + l + r) / (float)(h + t + b);
  gboolean grow_w;
  if(w > h)
  {
    grow_w = ia >= a * (1.0f - 1e-4f);
    if(grow_w && ia < a) a = ia;
  }
  else
  {
    grow_w = ia > a * (1.0f + 1e-4f);
    if(!grow_w && ia > a) a = ia;
  }
  const int grow = grow_w ? l + r : t + b;
  const int basis = MAX(w, h);
  *aspect = a;
  *size = (float)((double)grow / (double)(basis + grow));
}

// the size a framing instance planned above makes of a w x h input, worked
// out as the module's modify_roi_out() does, its float rounding included,
// so a canvas can be sized to the pixel
static void _frame_border_out(const int w, const int h, const int l, const int t, const int r, const int b,
                              int *ow, int *oh)
{
  *ow = w;
  *oh = h;
  if(!l && !t && !r && !b) return;
  float aspect, size;
  // the orientation written with it (_frame_border) leaves the aspect as is
  _frame_border_plan(w, h, l, t, r, b, &aspect, &size);
  const float image_aspect = (float)w / (float)h;
  gboolean basis_w = w > h;
  const float border_width = (float)(basis_w ? w : h) * (1.0f / (1.0f - fabsf(size)) - 1.0f);
  if(basis_w && image_aspect < aspect) basis_w = FALSE;
  else if(!basis_w && image_aspect > aspect) basis_w = TRUE;
  if(!basis_w) aspect = 1.0f / aspect;
  const int bo = roundf((float)(basis_w ? w : h) + border_width);
  const int oo = roundf((float)bo / aspect);
  const int max_dim = MAX(w, h);
  *ow = CLAMP(basis_w ? bo : oo, 1, 3 * max_dim);
  *oh = CLAMP(basis_w ? oo : bo, 1, 3 * max_dim);
}

static gboolean _frame_border(dt_iop_module_t *mod, const int w, const int h,
                              const int l, const int t, const int r, const int b,
                              const double rgb[3], char **err)
{
  memcpy(mod->params, mod->default_params, mod->params_size);
  float a, size;
  _frame_border_plan(w, h, l, t, r, b, &a, &size);
  gboolean ok = session_write_field(mod, "aspect", a, err)
    && session_write_field(mod, "aspect_orient", a >= 1.0f ? 2 /* landscape */ : 1 /* portrait */, err)
    && session_write_field(mod, "basis", 4 /* longer */, err)
    && session_write_field(mod, "size", size, err)
    && session_write_field(mod, "pos_h", l + r > 0 ? (double)l / (l + r) : 0.5, err)
    && session_write_field(mod, "pos_v", t + b > 0 ? (double)t / (t + b) : 0.5, err)
    && session_write_field(mod, "frame_size", 0.0, err);
  for(guint c = 0; ok && c < 3; c++)
  {
    gchar *f = g_strdup_printf("color[%u]", c);
    ok = session_write_field(mod, f, CLAMP(rgb[c], 0.0, 1.0), err);
    g_free(f);
  }
  return ok;
}

// a font as the app names it: family, CSS weight and italic, at px pixels
static PangoFontDescription *_frame_font(JsonObject *t, const double px)
{
  PangoFontDescription *d = pango_font_description_new();
  pango_font_description_set_family(d, json_object_get_string_member_with_default(t, "font", "Sans"));
  pango_font_description_set_weight(d, json_object_get_int_member_with_default(t, "weight", 400));
  pango_font_description_set_style(d, json_object_get_boolean_member_with_default(t, "italic", FALSE)
                                      ? PANGO_STYLE_ITALIC : PANGO_STYLE_NORMAL);
  pango_font_description_set_absolute_size(d, px * PANGO_SCALE);
  return d;
}

static void _svg_num(GString *s, const char *attr, const double v)
{
  char buf[G_ASCII_DTOSTR_BUF_SIZE];
  g_string_append_printf(s, " %s=\"%s\"", attr, g_ascii_formatd(buf, sizeof(buf), "%.2f", v));
}

// text for the SVG: XML-escaped, and with "$(" broken up, as watermark
// expands darktable's variables over the whole document (watermark.c)
static gchar *_svg_text(const char *text)
{
  gchar *esc = g_markup_escape_text(text, -1);
  gchar **parts = g_strsplit(esc, "$(", -1);
  gchar *out = g_strjoinv("&#36;(", parts);
  g_strfreev(parts);
  g_free(esc);
  return out;
}

// one text item, laid out with pango, the same fonts librsvg draws with:
// `position` 0-8 is a 3x3 grid (0 top left, 8 bottom right) inside the
// whole frame, or inside the photo for items placed before the borders;
// insets push it in from the grid's edge, or down/right from its center
static void _frame_text(GString *svg, PangoContext *ctx, JsonObject *t,
                        const double cx, const double cy, const double cw, const double ch,
                        const int short_edge, const int long_edge, const double out_scale)
{
  const char *text = json_object_get_string_member_with_default(t, "text", "");
  if(!text || !*text) return;
  const double px = MAX(1.0, _frame_len(t, "size", json_object_get_string_member_with_default(t, "sizeUnit", "px"),
                                        short_edge, long_edge, out_scale));
  const char *iu = json_object_get_string_member_with_default(t, "insetUnit", "px");
  const double ix = _frame_len(t, "insetX", iu, short_edge, long_edge, out_scale);
  const double iy = _frame_len(t, "insetY", iu, short_edge, long_edge, out_scale);
  const int pos = CLAMP(json_object_get_int_member_with_default(t, "position", 7), 0, 8);
  const int col = pos % 3, row = pos / 3;
  JsonObject *bg = json_object_has_member(t, "background")
    && JSON_NODE_HOLDS_OBJECT(json_object_get_member(t, "background"))
    ? json_object_get_object_member(t, "background") : NULL;

  PangoFontDescription *desc = _frame_font(t, px);
  PangoLayout *layout = pango_layout_new(ctx);
  pango_layout_set_font_description(layout, desc);
  gchar **lines = g_strsplit(text, "\n", -1);
  const int n = g_strv_length(lines);
  double *lw = g_new0(double, n), *lh = g_new0(double, n), *lb = g_new0(double, n);
  double bw = 0.0, bh = 0.0;
  for(int k = 0; k < n; k++)
  {
    PangoRectangle logical;
    pango_layout_set_text(layout, *lines[k] ? lines[k] : " ", -1);
    pango_layout_get_extents(layout, NULL, &logical);
    lw[k] = *lines[k] ? (double)logical.width / PANGO_SCALE : 0.0;
    lh[k] = (double)logical.height / PANGO_SCALE;
    lb[k] = (double)pango_layout_get_baseline(layout) / PANGO_SCALE;
    bw = MAX(bw, lw[k]);
    bh += lh[k];
  }
  g_object_unref(layout);

  const double pad = bg ? 0.3 * px : 0.0;
  const double boxw = bw + 2 * pad, boxh = bh + 2 * pad;
  const double x0 = col == 0 ? cx + ix : col == 1 ? cx + (cw - boxw) / 2 + ix : cx + cw - ix - boxw;
  const double y0 = row == 0 ? cy + iy : row == 1 ? cy + (ch - boxh) / 2 + iy : cy + ch - iy - boxh;

  if(bg)
  {
    double rgb[3];
    _frame_rgb(json_object_get_string_member_with_default(bg, "color", "#000000"), rgb);
    g_string_append(svg, "<rect");
    _svg_num(svg, "x", x0);
    _svg_num(svg, "y", y0);
    _svg_num(svg, "width", boxw);
    _svg_num(svg, "height", boxh);
    g_string_append_printf(svg, " fill=\"#%02x%02x%02x\"", (int)lround(rgb[0] * 255), (int)lround(rgb[1] * 255),
                           (int)lround(rgb[2] * 255));
    _svg_num(svg, "fill-opacity", CLAMP(json_object_get_double_member_with_default(bg, "opacity", 1.0), 0.0, 1.0));
    g_string_append(svg, "/>\n");
  }

  double rgb[3];
  _frame_rgb(json_object_get_string_member_with_default(t, "color", "#000000"), rgb);
  gchar *family = _svg_text(pango_font_description_get_family(desc));
  double y = y0 + pad;
  for(int k = 0; k < n; k++)
  {
    if(lw[k] > 0.0)
    {
      const double x = col == 0 ? x0 + pad : col == 1 ? x0 + pad + (bw - lw[k]) / 2 : x0 + pad + bw - lw[k];
      gchar *line = _svg_text(lines[k]);
      g_string_append(svg, "<text xml:space=\"preserve\"");
      _svg_num(svg, "x", x);
      _svg_num(svg, "y", y + lb[k]);
      _svg_num(svg, "font-size", px);
      g_string_append_printf(svg, " font-family=\"%s\" font-weight=\"%d\" font-style=\"%s\""
                             " fill=\"#%02x%02x%02x\"", family, (int)pango_font_description_get_weight(desc),
                             pango_font_description_get_style(desc) == PANGO_STYLE_ITALIC ? "italic" : "normal",
                             (int)lround(rgb[0] * 255), (int)lround(rgb[1] * 255), (int)lround(rgb[2] * 255));
      _svg_num(svg, "fill-opacity", CLAMP(json_object_get_double_member_with_default(t, "opacity", 1.0), 0.0, 1.0));
      g_string_append_printf(svg, ">%s</text>\n", line);
      g_free(line);
    }
    y += lh[k];
  }
  g_free(family);
  g_free(lw);
  g_free(lh);
  g_free(lb);
  g_strfreev(lines);
  pango_font_description_free(desc);
}

// one LRMogrify inner border: a line over the photo, `inset` in from its
// edges and `size` wide, each a { top, left, right, bottom } in its unit;
// drawn as the ring between two rectangles, so each side can differ
static void _frame_inner(GString *svg, JsonObject *o, const double x, const double y, const double w,
                         const double h, const int short_edge, const int long_edge, const double out_scale)
{
  const char *keys[4] = { "left", "top", "right", "bottom" };
  JsonObject *inset = json_object_has_member(o, "inset") ? json_object_get_object_member(o, "inset") : NULL;
  JsonObject *size = json_object_has_member(o, "size") ? json_object_get_object_member(o, "size") : NULL;
  if(!size) return;
  const char *iu = json_object_get_string_member_with_default(o, "insetUnit", "px");
  const char *su = json_object_get_string_member_with_default(o, "sizeUnit", "long");
  double in[4], sz[4];
  for(int k = 0; k < 4; k++)
  {
    in[k] = inset ? MAX(0.0, _frame_len(inset, keys[k], iu, short_edge, long_edge, out_scale)) : 0.0;
    sz[k] = MAX(0.0, _frame_len(size, keys[k], su, short_edge, long_edge, out_scale));
  }
  const double ox = x + in[0], oy = y + in[1], ow = w - in[0] - in[2], oh = h - in[1] - in[3];
  const double ix = ox + sz[0], iy = oy + sz[1], iw = ow - sz[0] - sz[2], ih = oh - sz[1] - sz[3];
  if(ow <= 0.0 || oh <= 0.0) return;
  double rgb[3];
  _frame_rgb(json_object_get_string_member_with_default(o, "color", "#000000"), rgb);
  char a[G_ASCII_DTOSTR_BUF_SIZE], b[G_ASCII_DTOSTR_BUF_SIZE], c[G_ASCII_DTOSTR_BUF_SIZE],
       d[G_ASCII_DTOSTR_BUF_SIZE];
  g_string_append_printf(svg, "<path fill-rule=\"evenodd\" d=\"M%s %sh%sv%sh-%sz",
                         g_ascii_formatd(a, sizeof(a), "%.2f", ox), g_ascii_formatd(b, sizeof(b), "%.2f", oy),
                         g_ascii_formatd(c, sizeof(c), "%.2f", ow), g_ascii_formatd(d, sizeof(d), "%.2f", oh),
                         c);
  if(iw > 0.0 && ih > 0.0)
    g_string_append_printf(svg, "M%s %sh%sv%sh-%sz",
                           g_ascii_formatd(a, sizeof(a), "%.2f", ix), g_ascii_formatd(b, sizeof(b), "%.2f", iy),
                           g_ascii_formatd(c, sizeof(c), "%.2f", iw), g_ascii_formatd(d, sizeof(d), "%.2f", ih),
                           c);
  g_string_append_printf(svg, "\" fill=\"#%02x%02x%02x\"", (int)lround(rgb[0] * 255), (int)lround(rgb[1] * 255),
                         (int)lround(rgb[2] * 255));
  _svg_num(svg, "fill-opacity", CLAMP(json_object_get_double_member_with_default(o, "opacity", 1.0), 0.0, 1.0));
  g_string_append(svg, "/>\n");
}

// the image's size at the end of its pipe, as dt_image_get_final_size()
// works it out, without its cache: crop may have changed since
static void _final_size(dt_develop_t *dev, int *w, int *h)
{
  dt_dev_pixelpipe_t pipe;
  *w = dev->image_storage.width;
  *h = dev->image_storage.height;
  if(!dt_dev_pixelpipe_init_dummy(&pipe, *w, *h)) return;
  dt_dev_pixelpipe_set_input(&pipe, dev, NULL, *w, *h, 1.0f);
  dt_dev_pixelpipe_create_nodes(&pipe, dev);
  dt_dev_pixelpipe_synch_all(&pipe, dev);
  dt_dev_pixelpipe_get_dimensions(&pipe, dev, pipe.iwidth, pipe.iheight, &pipe.processed_width,
                                  &pipe.processed_height);
  *w = pipe.processed_width;
  *h = pipe.processed_height;
  dt_dev_pixelpipe_cleanup(&pipe);
}

// one plugin of the frame style
static void _style_plugin(GString *xml, dt_iop_module_t *mod, const int num, const int priority)
{
  int plen = 0, blen = 0;
  char *params = dt_exif_xmp_encode(mod->params, mod->params_size, &plen);
  char *blend = dt_exif_xmp_encode((const unsigned char *)mod->default_blendop_params,
                                   sizeof(dt_develop_blend_params_t), &blen);
  g_string_append_printf(xml,
    "<plugin><num>%d</num><module>%d</module><operation>%s</operation>"
    "<op_params>%s</op_params><enabled>1</enabled><blendop_params>%s</blendop_params>"
    "<blendop_version>%d</blendop_version><multi_priority>%d</multi_priority><multi_name>%s</multi_name>"
    "<multi_name_hand_edited>0</multi_name_hand_edited></plugin>",
    num, mod->version(), mod->op, params, blend, dt_develop_blend_version(), priority,
    priority ? "frame" : "");
  g_free(params);
  g_free(blend);
}

// the frame as a style; `frame` is
// { borders: [{top, left, right, bottom, unit, color}], inner: [...],
// texts: [...], canvas: {width, height, color, flip} }, an
// older { size, color } border one item of equal sides. `*styled` says
// whether there is a style to apply, `*svg_written` whether a text layer
// went to the watermarks folder
static gboolean _frame_style(const dt_imgid_t imgid, JsonObject *frame, JsonObject *old_border,
                             const int long_edge, const int upscale, const int id, gboolean *styled,
                             gboolean *svg_written, char **err)
{
  char style[64], svg_name[64];
  g_snprintf(style, sizeof(style), _FRAME_STYLE, id);
  g_snprintf(svg_name, sizeof(svg_name), _FRAME_SVG, id);
  *styled = FALSE;
  *svg_written = FALSE;
  dt_develop_t dev;
  dt_dev_init(&dev, FALSE);
  dt_dev_load_image(&dev, imgid);
  dt_iop_module_t *borders = dt_iop_get_module_by_op_priority(dev.iop, "borders", 0);
  dt_iop_module_t *watermark = dt_iop_get_module_by_op_priority(dev.iop, "watermark", 0);
  if(!borders || !watermark)
  {
    dt_dev_cleanup(&dev);
    *err = g_strdup("darktable has no framing or watermark module");
    return FALSE;
  }
  int w = 0, h = 0;
  _final_size(&dev, &w, &h);
  const int short_edge = MIN(w, h), long_side = MAX(w, h);

  JsonArray *items = frame && json_object_has_member(frame, "borders")
    ? json_object_get_array_member(frame, "borders") : NULL;
  JsonArray *texts = frame && json_object_has_member(frame, "texts")
    ? json_object_get_array_member(frame, "texts") : NULL;
  const guint nitems = items ? json_array_get_length(items) : 0;
  const guint ntexts = texts ? json_array_get_length(texts) : 0;
  JsonArray *inner = frame && json_object_has_member(frame, "inner")
    ? json_object_get_array_member(frame, "inner") : NULL;
  const guint ninner = inner ? json_array_get_length(inner) : 0;
  // a fixed canvas, in pixels of the exported file, that the framed photo
  // is fitted inside: one more border, outermost, sized per photo. not
  // with AI upscaling, whose size is the photo's times the factor
  JsonObject *canvas = frame && upscale <= 1 && json_object_has_member(frame, "canvas")
    && JSON_NODE_HOLDS_OBJECT(json_object_get_member(frame, "canvas"))
    ? json_object_get_object_member(frame, "canvas") : NULL;
  double cnv_w = canvas ? json_object_get_double_member_with_default(canvas, "width", 0.0) : 0.0;
  double cnv_h = canvas ? json_object_get_double_member_with_default(canvas, "height", 0.0) : 0.0;
  if(cnv_w < 1.0 || cnv_h < 1.0) canvas = NULL;

  // each item's sides in full-size pixels. pixels of the exported file
  // depend on the scale of the export, which depends on the frame: a few
  // rounds settle it
  int *sides = g_new0(int, 4 * (nitems + 1));
  double out_scale = upscale > 1 ? upscale : 1.0;
  int fw = w, fh = h;
  for(int round = 0; round < 4; round++)
  {
    fw = w;
    fh = h;
    for(guint k = 0; k < nitems; k++)
    {
      JsonObject *o = json_array_get_object_element(items, k);
      const char *unit = json_object_get_string_member_with_default(o, "unit", "short");
      const char *keys[4] = { "left", "top", "right", "bottom" };
      for(int s = 0; s < 4; s++)
        sides[4 * k + s] = MAX(0, (int)lround(_frame_len(o, keys[s], unit, short_edge, long_side, out_scale)));
      fw += sides[4 * k] + sides[4 * k + 2];
      fh += sides[4 * k + 1] + sides[4 * k + 3];
    }
    if(canvas)
    {
      // a landscape photo turns the canvas when asked, LR/Mogrify's
      // "adjust for landscape/portrait"
      if(json_object_get_boolean_member_with_default(canvas, "flip", FALSE)
         && (fw > fh) != (cnv_w > cnv_h))
      {
        const double t = cnv_w;
        cnv_w = cnv_h;
        cnv_h = t;
      }
      out_scale = MIN(1.0, MIN(cnv_w / fw, cnv_h / fh));
      continue;
    }
    if(upscale > 1 || long_edge <= 0) break;
    out_scale = MIN(1.0, (double)long_edge / MAX(fw, fh));
  }
  if(canvas)
  {
    // the framed photo as the modules make it, which can differ from
    // fw x fh by their rounding
    int ew = w, eh = h;
    for(guint k = 0; k < nitems; k++)
    {
      const int *s = sides + 4 * k;
      _frame_border_out(ew, eh, s[0], s[1], s[2], s[3], &ew, &eh);
    }
    // the canvas in full-size pixels. a photo smaller than the canvas is
    // not scaled up: it sits in it at its own size
    const int tw = (int)lround(cnv_w), th = (int)lround(cnv_h);
    const int ccw = MAX(ew, (int)lround(cnv_w / out_scale));
    const int cch = MAX(eh, (int)lround(cnv_h / out_scale));
    // the export floors its scaled size (imageio.c,
    // dt_imageio_export_with_flags) after the modules have rounded theirs,
    // so the nearest canvas can come out a pixel short. a few canvases
    // around it are tried as the export would size them, and the first
    // giving exactly tw x th is taken
    const double fit = long_edge > 0 ? long_edge : MAX(tw, th);
    int *s = sides + 4 * nitems;
    for(int n = 0; n < 49; n++)
    {
      // 0, 1, -1, 2, -2, 3, -3 in each direction, the nearest first
      const int dw = (n % 7 + 1) / 2 * ((n % 7) % 2 ? 1 : -1);
      const int dh = (n / 7 + 1) / 2 * ((n / 7) % 2 ? 1 : -1);
      const int cw2 = MAX(ew, ccw + dw), ch2 = MAX(eh, cch + dh);
      s[0] = (cw2 - ew) / 2;
      s[2] = cw2 - ew - s[0];
      s[1] = (ch2 - eh) / 2;
      s[3] = ch2 - eh - s[1];
      int pw, ph;
      _frame_border_out(ew, eh, s[0], s[1], s[2], s[3], &pw, &ph);
      const double sc = fmin(fmin(fit / pw, 1.0), fmin(fit / ph, 1.0));
      if((int)floor(sc * pw) == tw && (int)floor(sc * ph) == th) break;
      if(n == 48)
      {
        // none fits exactly (a preview, or a canvas bigger than the
        // export's long edge): the nearest
        s[0] = (ccw - ew) / 2;
        s[2] = ccw - ew - s[0];
        s[1] = (cch - eh) / 2;
        s[3] = cch - eh - s[1];
      }
    }
  }
  if(old_border)
  {
    // darktable's constant border, `size` of the longer side
    const double size = CLAMP(json_object_get_double_member_with_default(old_border, "size", 0.05), 0.0, 0.5);
    const int side = (int)lround(long_side * size / (1.0 - size) / 2.0);
    for(int s = 0; s < 4; s++) sides[s] = side;
  }
  const guint nborders = old_border ? 1 : nitems + (canvas ? 1 : 0);

  GString *xml = g_string_new(NULL);
  g_string_append_printf(xml, "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n"
                         "<darktable_style version=\"1.0\"><info><name>%s</name><description></description>"
                         "</info><style>", style);
  gboolean ok = TRUE;
  int num = 0, cw = w, chh = h, px0 = 0, py0 = 0;
  for(guint k = 0; ok && k < nborders; k++)
  {
    const int *s = sides + 4 * k;
    if(!s[0] && !s[1] && !s[2] && !s[3]) continue;
    double rgb[3];
    if(old_border)
    {
      JsonArray *c = json_object_has_member(old_border, "color")
        ? json_object_get_array_member(old_border, "color") : NULL;
      for(guint i = 0; i < 3; i++)
        rgb[i] = c && json_array_get_length(c) == 3 ? json_array_get_double_element(c, i) : 1.0;
    }
    else if(k == nitems)
      _frame_rgb(json_object_get_string_member_with_default(canvas, "color", "#ffffff"), rgb);
    else
      _frame_rgb(json_object_get_string_member_with_default(json_array_get_object_element(items, k),
                                                            "color", "#ffffff"), rgb);
    ok = _frame_border(borders, cw, chh, s[0], s[1], s[2], s[3], rgb, err);
    if(ok) _style_plugin(xml, borders, num, num);
    num++;
    px0 += s[0];
    py0 += s[1];
    // the size the module makes, which the next instance is planned on
    _frame_border_out(cw, chh, s[0], s[1], s[2], s[3], &cw, &chh);
  }

  gchar *svg_path = NULL;
  if(ok && (ntexts || ninner))
  {
    GString *svg = g_string_new(NULL);
    g_string_append_printf(svg, "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"%d\" height=\"%d\""
                           " viewBox=\"0 0 %d %d\">\n", cw, chh, cw, chh);
    PangoContext *ctx = pango_font_map_create_context(pango_cairo_font_map_get_default());
    // inner borders first, so text can sit on them
    for(guint k = 0; k < ninner; k++)
      _frame_inner(svg, json_array_get_object_element(inner, k), px0, py0, w, h, short_edge, long_side, out_scale);
    for(guint k = 0; k < ntexts; k++)
    {
      JsonObject *t = json_array_get_object_element(texts, k);
      const gboolean on_photo = !g_strcmp0(json_object_get_string_member_with_default(t, "relativeTo", "frame"),
                                           "photo");
      if(on_photo)
        _frame_text(svg, ctx, t, px0, py0, w, h, short_edge, long_side, out_scale);
      else
        _frame_text(svg, ctx, t, 0, 0, cw, chh, short_edge, long_side, out_scale);
    }
    g_object_unref(ctx);
    g_string_append(svg, "</svg>\n");

    char configdir[PATH_MAX] = { 0 };
    dt_loc_get_user_config_dir(configdir, sizeof(configdir));
    gchar *dir = g_build_filename(configdir, "watermarks", NULL);
    g_mkdir_with_parents(dir, 0755);
    svg_path = g_build_filename(dir, svg_name, NULL);
    g_free(dir);
    ok = g_file_set_contents(svg_path, svg->str, -1, NULL);
    g_string_free(svg, TRUE);
    *svg_written = ok;

    memcpy(watermark->params, watermark->default_params, watermark->params_size);
    ok = ok && _write_text(watermark, "filename", svg_name, err) && _write_text(watermark, "text", "", err)
      && session_write_field(watermark, "opacity", 100.0, err) && session_write_field(watermark, "scale", 100.0, err)
      && session_write_field(watermark, "xoffset", 0.0, err) && session_write_field(watermark, "yoffset", 0.0, err)
      && session_write_field(watermark, "rotate", 0.0, err) && session_write_field(watermark, "alignment", 0, err)
      && session_write_field(watermark, "scale_base", 0 /* image */, err);
    if(ok) _style_plugin(xml, watermark, num++, 0);
  }
  g_free(sides);
  dt_dev_cleanup(&dev);
  g_string_append(xml, "</style></darktable_style>\n");

  if(ok && num)
  {
    char configdir[PATH_MAX] = { 0 };
    dt_loc_get_user_config_dir(configdir, sizeof(configdir));
    char file[64];
    g_snprintf(file, sizeof(file), _FRAME_DTSTYLE, id);
    gchar *path = g_build_filename(configdir, file, NULL);
    ok = g_file_set_contents(path, xml->str, -1, NULL);
    if(ok)
    {
      if(dt_styles_exists(style)) dt_styles_delete_by_name(style);
      dt_styles_import_from_file(path);
      ok = dt_styles_exists(style);
    }
    g_unlink(path);
    g_free(path);
  }
  g_string_free(xml, TRUE);
  g_free(svg_path);
  if(!ok && !*err) *err = g_strdup("could not prepare the export frame");
  *styled = ok && num > 0;
  return ok;
}

// the frame's style and text layer, once the export no longer needs them
static void _frame_done(const int id, const gboolean svg_written)
{
  char name[64];
  g_snprintf(name, sizeof(name), _FRAME_STYLE, id);
  dt_styles_delete_by_name(name);
  if(!svg_written) return;
  g_snprintf(name, sizeof(name), _FRAME_SVG, id);
  char configdir[PATH_MAX] = { 0 };
  dt_loc_get_user_config_dir(configdir, sizeof(configdir));
  gchar *path = g_build_filename(configdir, "watermarks", name, NULL);
  g_unlink(path);
  g_free(path);
}

// the installed fonts, as pango (and so librsvg) finds them: each family
// with its faces' CSS weight and italic
static int _font_family_cmp(const void *a, const void *b)
{
  return g_utf8_collate(pango_font_family_get_name(*(PangoFontFamily *const *)a),
                        pango_font_family_get_name(*(PangoFontFamily *const *)b));
}

void export_fonts(JsonBuilder *b)
{
  PangoFontFamily **families = NULL;
  int n = 0;
  pango_font_map_list_families(pango_cairo_font_map_get_default(), &families, &n);
  qsort(families, n, sizeof(*families), _font_family_cmp);
  json_builder_set_member_name(b, "families");
  json_builder_begin_array(b);
  for(int k = 0; k < n; k++)
  {
    const char *name = pango_font_family_get_name(families[k]);
    if(!name || name[0] == '.') continue; // macOS' hidden system faces
    json_builder_begin_object(b);
    engine_add_string(b, "name", name);
    json_builder_set_member_name(b, "faces");
    json_builder_begin_array(b);
    PangoFontFace **faces = NULL;
    int nf = 0;
    pango_font_family_list_faces(families[k], &faces, &nf);
    for(int f = 0; f < nf; f++)
    {
      if(pango_font_face_is_synthesized(faces[f])) continue;
      PangoFontDescription *d = pango_font_face_describe(faces[f]);
      json_builder_begin_object(b);
      engine_add_string(b, "name", pango_font_face_get_face_name(faces[f]));
      json_builder_set_member_name(b, "weight");
      json_builder_add_int_value(b, pango_font_description_get_weight(d));
      json_builder_set_member_name(b, "italic");
      json_builder_add_boolean_value(b, pango_font_description_get_style(d) != PANGO_STYLE_NORMAL);
      json_builder_end_object(b);
      pango_font_description_free(d);
    }
    g_free(faces);
    json_builder_end_array(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  g_free(families);
}

#ifdef HAVE_AI
// ------------------------------------------------------- AI upscaling
// Lightroom's Super Resolution at export, as darktable's neural restore
// does it (src/libs/neural_restore.c): the pipeline renders in linear
// Rec.2020 floats into a stand-in format, the upscale model runs over that
// in tiles, and the result goes, converted to the export's color space,
// through the real format's own writer with EXIF for the new size
#define _UPSCALE_MODEL "upscale-realplksr"

static struct
{
  dt_restore_env_t *env;
  dt_restore_context_t *ctx;
  int scale;
  char provider[16];
  int device;
  dt_imageio_module_format_t *real;
  dt_colorspaces_color_profile_type_t icc;
  char *err;
} _up;
static GMutex _up_lock;

// the provider an upscale runs on: the one asked for when it is a usable
// GPU one, else the first such, else none
static const char *_upscale_provider(const char *asked)
{
  for(size_t k = 0; k < G_N_ELEMENTS(_gpu_providers); k++)
    if(!g_strcmp0(asked, _gpu_providers[k].id) && device_gpu_usable(_gpu_providers[k].p)) return asked;
  for(size_t k = 0; k < G_N_ELEMENTS(_gpu_providers); k++)
    if(device_gpu_usable(_gpu_providers[k].p)) return _gpu_providers[k].id;
  return NULL;
}

// the model for this scale, provider and device, kept between exports
static dt_restore_context_t *_upscale_ctx(const int scale, const char *asked, const int device, char **err)
{
  if(!ai_models_dir)
  {
    *err = g_strdup("no models folder given (--models)");
    return NULL;
  }
  const char *provider = _upscale_provider(asked);
  if(!provider)
  {
    *err = g_strdup("AI upscaling needs GPU acceleration, which this computer does not offer");
    return NULL;
  }
  if(_up.ctx && _up.scale == scale && !g_strcmp0(_up.provider, provider) && _up.device == device) return _up.ctx;
  if(_up.ctx) dt_restore_unref(_up.ctx);
  _up.ctx = NULL;
  if(!_up.env)
  {
    _up.env = g_new0(dt_restore_env_t, 1);
    _up.env->ai_env = dt_ai_env_init(ai_models_dir);
  }
  g_mutex_lock(&export_ai_load_lock);
  dt_ai_env_refresh(_up.env->ai_env);
  // restore finds its model through darktable's active-model and provider
  // settings rather than taking them as arguments
  dt_conf_set_string("plugins/ai/models/active/upscale", _UPSCALE_MODEL);
  dt_conf_set_string(DT_AI_CONF_PROVIDER, provider);
  const char *device_key = dt_ai_device_conf_key_for_provider(dt_ai_provider_from_string(provider));
  if(device_key && device >= 0) dt_conf_set_int(device_key, device);
  _up.ctx = scale == 4 ? dt_restore_load_upscale_x4(_up.env) : dt_restore_load_upscale_x2(_up.env);
  g_mutex_unlock(&export_ai_load_lock);
  if(!_up.ctx)
  {
    *err = g_strdup_printf("cannot load the '%s' model from %s", _UPSCALE_MODEL, ai_models_dir);
    return NULL;
  }
  const dt_colorspaces_color_profile_t *lin
    = dt_colorspaces_get_profile(DT_COLORSPACE_LIN_REC2020, "", DT_PROFILE_DIRECTION_OUT);
  dt_restore_set_profile(_up.ctx, lin ? lin->profile : NULL);
  dt_restore_set_preserve_wide_gamut(_up.ctx, FALSE);
  _up.scale = scale;
  g_strlcpy(_up.provider, provider, sizeof(_up.provider));
  _up.device = device;
  return _up.ctx;
}

static int _up_bpp(dt_imageio_module_data_t *data) { return 32; }
static int _up_levels(dt_imageio_module_data_t *data) { return IMAGEIO_RGB | IMAGEIO_FLOAT; }

typedef struct _up_rows_t
{
  void *out;            // the real format's buffer: 8-bit or float RGBA
  gboolean u8;
  cmsHTRANSFORM xform;  // linear Rec.2020 to the export's space, NULL if the same
  float *row;           // one converted scanline
} _up_rows_t;

static int _up_row(const float *scanline, const int out_w, const int y, void *user_data)
{
  _up_rows_t *r = user_data;
  const float *src = scanline;
  if(r->xform)
  {
    cmsDoTransform(r->xform, scanline, r->row, out_w);
    src = r->row;
  }
  if(r->u8)
  {
    uint8_t *dst = (uint8_t *)r->out + (size_t)y * out_w * 4;
    for(int x = 0; x < out_w; x++)
    {
      for(int c = 0; c < 3; c++) dst[4 * x + c] = (uint8_t)roundf(CLAMP(src[3 * x + c], 0.0f, 1.0f) * 255.0f);
      dst[4 * x + 3] = 255;
    }
  }
  else
  {
    float *dst = (float *)r->out + (size_t)y * out_w * 4;
    for(int x = 0; x < out_w; x++)
    {
      for(int c = 0; c < 3; c++) dst[4 * x + c] = src[3 * x + c];
      dst[4 * x + 3] = 1.0f;
    }
  }
  return 0;
}

static int _up_write_image(dt_imageio_module_data_t *data, const char *filename, const void *in,
                           dt_colorspaces_color_profile_type_t over_type, const char *over_filename,
                           void *exif, int exif_len, dt_imgid_t imgid, int num, int total,
                           struct dt_dev_pixelpipe_t *pipe, const gboolean export_masks)
{
  const int w = data->width, h = data->height, S = _up.scale;
  const int ow = w * S, oh = h * S;
  _up_rows_t r = { .u8 = _up.real->bpp(data) == 8 };
  r.out = g_try_malloc((size_t)ow * oh * 4 * (r.u8 ? 1 : sizeof(float)));
  r.row = g_try_malloc((size_t)ow * 3 * sizeof(float));
  if(!r.out || !r.row)
  {
    g_free(r.out);
    g_free(r.row);
    _up.err = g_strdup_printf("not enough memory for a %d x %d image", ow, oh);
    return 1;
  }
  const dt_colorspaces_color_profile_t *lin
    = dt_colorspaces_get_profile(DT_COLORSPACE_LIN_REC2020, "", DT_PROFILE_DIRECTION_OUT);
  const dt_colorspaces_color_profile_t *dst = dt_colorspaces_get_profile(_up.icc, "", DT_PROFILE_DIRECTION_OUT);
  if(lin && dst && lin->profile != dst->profile)
    r.xform = cmsCreateTransform(lin->profile, TYPE_RGB_FLT, dst->profile, TYPE_RGB_FLT, INTENT_PERCEPTUAL, 0);

  int res = dt_restore_process_tiled(_up.ctx, in, w, h, S, _up_row, &r, NULL);
  if(r.xform) cmsDeleteTransform(r.xform);
  g_free(r.row);
  if(res)
  {
    g_free(r.out);
    _up.err = g_strdup("the upscale model failed");
    return 1;
  }

  // EXIF that gives the new size, when the export carries EXIF at all
  uint8_t *ex = NULL;
  int ex_len = 0;
  if(exif && exif_len)
  {
    char path[PATH_MAX] = { 0 };
    gboolean from_cache = TRUE;
    dt_image_full_path(imgid, path, sizeof(path), &from_cache);
    ex_len = dt_exif_read_blob(&ex, path, imgid, _up.icc == DT_COLORSPACE_SRGB, ow, oh, FALSE);
  }
  data->width = ow;
  data->height = oh;
  res = _up.real->write_image(data, filename, r.out, _up.icc, NULL, ex ? (void *)ex : exif, ex ? ex_len : exif_len,
                              imgid, num, total, pipe, export_masks);
  free(ex);
  g_free(r.out);
  if(res) _up.err = g_strdup_printf("could not write '%s'", filename);
  return res;
}

#endif
// A linear DNG uses the normal export pipe, retaining every edit, but
// stores its rendered RGB with a matching synthetic camera matrix.
static int _positive_bpp(dt_imageio_module_data_t *data) { return 32; }
static int _positive_levels(dt_imageio_module_data_t *data) { return IMAGEIO_RGB | IMAGEIO_FLOAT; }
static int _positive_write(dt_imageio_module_data_t *data, const char *filename, const void *in,
                           dt_colorspaces_color_profile_type_t over_type, const char *over_filename,
                           void *exif, int exif_len, dt_imgid_t imgid, int num, int total,
                           struct dt_dev_pixelpipe_t *pipe, const gboolean export_masks)
{
  return dng_write_rendered_half(filename, in, data->width, data->height, exif, exif_len);
}

static int _positive_tiff_write(dt_imageio_module_data_t *data, const char *filename, const void *in,
                                dt_colorspaces_color_profile_type_t over_type, const char *over_filename,
                                void *exif, int exif_len, dt_imgid_t imgid, int num, int total,
                                struct dt_dev_pixelpipe_t *pipe, const gboolean export_masks)
{
  dt_imageio_module_format_t *fmt = dt_imageio_get_format_by_name("tiff");
  const int res = fmt->write_image(data, filename, in, over_type, over_filename, NULL, 0,
                                   imgid, num, total, pipe, export_masks);
  if(res) return res;
  return rendered_metadata(filename, exif, exif_len, FALSE) ? 0 : 1;
}

// preview_jpeg.h writes through transient_output.h, whose state main.c owns
#define transient_write engine_transient_write
// write one image through darktable's own export, as its export module
// would: `format` names a format plugin (jpeg, tiff, png, webp...); quality
// and bit depth go through the plugin's conf keys, which its get_params()
// reads; long_edge bounds both sides (0 keeps the full size)
#include "preview_jpeg.h"

#undef transient_write
// whether an export bakes the edit into a positive for the library: a
// converted negative or a film simulation, rendered to linear Rec.2020
// floats and imported with a neutral history (_positive_import()).
// "negative_copy" is the name older clients send
static gboolean _positive_copy(JsonObject *req)
{
  return json_object_get_boolean_member_with_default(req, "positive_copy", FALSE)
    || json_object_get_boolean_member_with_default(req, "negative_copy", FALSE);
}

gboolean export_export(const dt_imgid_t imgid, JsonObject *req, char **err)
{
  const char *out = json_object_get_string_member_with_default(req, "out", NULL);
  const char *format = json_object_get_string_member_with_default(req, "format", "jpeg");
  if(!out || !dt_is_valid_imgid(imgid))
  {
    *err = g_strdup("export needs an image and an output file");
    return FALSE;
  }
  const gboolean transient = json_object_get_boolean_member_with_default(req, "transient", FALSE);
  if(transient && (g_strcmp0(format, "jpeg")
      || g_strcmp0(json_object_get_string_member_with_default(req, "color_space", "srgb"), "srgb")
      || json_object_get_int_member_with_default(req, "quality", 0) != 85
      || json_object_get_int_member_with_default(req, "upscale", 0) > 1
      || _positive_copy(req)))
  {
    *err = g_strdup("transient export requires an sRGB JPEG preview at quality 85");
    return FALSE;
  }
  const gboolean positive = _positive_copy(req);
  const gboolean positive_dng = positive && !g_strcmp0(format, "dng");
  dt_imageio_module_format_t *fmt = dt_imageio_get_format_by_name(positive_dng ? "tiff" : format);
  if(!fmt)
  {
    *err = g_strdup_printf("no export format '%s'", format);
    return FALSE;
  }

  // the format reads them from darktable's settings, which a background
  // export and the main loop's (the dialog's preview) share
  const int quality = json_object_get_int_member_with_default(req, "quality", 0);
  const int bpp = json_object_get_int_member_with_default(req, "bpp", 0);
  g_mutex_lock(&_format_conf_lock);
  const int old_bpp = positive ? dt_conf_get_int("plugins/imageio/format/tiff/bpp") : 0;
  for(int pass = 0; pass < 2; pass++)
  {
    const int value = pass ? bpp : quality;
    if(value <= 0) continue;
    gchar *key = g_strdup_printf("plugins/imageio/format/%s/%s", fmt->plugin_name,
                                 pass ? "bpp" : "quality");
    if(dt_conf_key_exists(key) || dt_confgen_exists(key)) dt_conf_set_int(key, value);
    g_free(key);
  }
  // Converted TIFFs always use lossless compression; leave ordinary export
  // preferences as they were after taking this job's parameters.
  const int old_compress = positive ? dt_conf_get_int("plugins/imageio/format/tiff/compress") : 0;
  if(positive) dt_conf_set_int("plugins/imageio/format/tiff/compress", 2);
  dt_imageio_module_data_t *fdata = fmt->get_params(fmt);
  if(positive)
  {
    dt_conf_set_int("plugins/imageio/format/tiff/compress", old_compress);
    dt_conf_set_int("plugins/imageio/format/tiff/bpp", old_bpp);
  }
  g_mutex_unlock(&_format_conf_lock);
  if(!fdata)
  {
    *err = g_strdup_printf("format '%s' gave no parameters", format);
    return FALSE;
  }
  // upscaling exports the full size, made 2 or 4 times larger
  const int upscale = json_object_get_int_member_with_default(req, "upscale", 0);
  const int long_edge = upscale > 1 ? 0 : json_object_get_int_member_with_default(req, "long_edge", 0);
  fdata->max_width = long_edge;
  fdata->max_height = long_edge;
  fdata->style[0] = '\0';
  fdata->style_append = TRUE;

  JsonObject *frame = json_object_has_member(req, "frame")
    && JSON_NODE_HOLDS_OBJECT(json_object_get_member(req, "frame"))
    ? json_object_get_object_member(req, "frame") : NULL;
  JsonObject *border = json_object_has_member(req, "border")
    && JSON_NODE_HOLDS_OBJECT(json_object_get_member(req, "border"))
    ? json_object_get_object_member(req, "border") : NULL;
  gboolean framed = FALSE, frame_svg = FALSE;
  // the frame's style and text layer are named for this export alone, as a
  // background export and the dialog's preview may be framing at once
  static gint frames = 0;
  const int frame_id = g_atomic_int_add(&frames, 1);
  if(frame || border)
  {
    // the long edge a frame's pixel sizes refer to: a preview smaller than
    // the export it shows passes the export's (0 for full size)
    const int px_edge = json_object_get_int_member_with_default(req, "px_long_edge", long_edge);
    if(!_frame_style(imgid, frame, border, px_edge, upscale, frame_id, &framed, &frame_svg, err))
    {
      _frame_done(frame_id, frame_svg);
      fmt->free_params(fmt, fdata);
      return FALSE;
    }
    if(framed) g_snprintf(fdata->style, sizeof(fdata->style), _FRAME_STYLE, frame_id);
  }

  dt_colorspaces_color_profile_type_t icc = DT_COLORSPACE_SRGB;
  const char *space = json_object_get_string_member_with_default(req, "color_space", "srgb");
  for(size_t k = 0; k < G_N_ELEMENTS(_spaces); k++)
    if(!g_strcmp0(space, _spaces[k].name)) icc = _spaces[k].type;

  dt_imageio_module_format_t proxy = *fmt;
  _flags_of = fmt;
  proxy.flags = _no_tmpfile_flags;
  if(transient) proxy.write_image = preview_jpeg_write;
  dt_colorspaces_color_profile_type_t render_icc = icc;
  if(positive)
  {
    render_icc = DT_COLORSPACE_LIN_REC2020;
    if(positive_dng)
    {
      proxy.bpp = _positive_bpp;
      proxy.levels = _positive_levels;
      proxy.write_image = _positive_write;
    }
    else proxy.write_image = _positive_tiff_write;
  }
  // the stand-in format renders linear Rec.2020 floats for the model and
  // hands the result to the real one. one upscale at a time: the model and
  // the real format are kept in _up
  if(upscale > 1)
  {
#ifndef HAVE_AI
    *err = g_strdup("AI upscaling needs an engine built with AI");
    if(framed) _frame_done(frame_id, frame_svg);
    fmt->free_params(fmt, fdata);
    return FALSE;
#else
    g_mutex_lock(&_up_lock);
    const char *asked = json_object_get_string_member_with_default(req, "ai_provider", "auto");
    const int device = json_object_get_int_member_with_default(req, "ai_device", -1);
    if(!_upscale_ctx(upscale == 4 ? 4 : 2, asked, device, err))
    {
      g_mutex_unlock(&_up_lock);
      if(framed) _frame_done(frame_id, frame_svg);
      fmt->free_params(fmt, fdata);
      return FALSE;
    }
    proxy.bpp = _up_bpp;
    proxy.levels = _up_levels;
    proxy.write_image = _up_write_image;
    render_icc = DT_COLORSPACE_LIN_REC2020;
    _up.real = fmt;
    _up.icc = icc;
    g_clear_pointer(&_up.err, g_free);
#endif
  }

  // EXIF, the text fields, location and tags, as Lightroom exports them;
  // darktable's default would also embed the whole edit history. each can
  // be left out, as the export dialog's Metadata section asks
  dt_export_metadata_t metadata = {
    .flags = DT_META_EXIF | DT_META_METADATA | DT_META_GEOTAG | DT_META_TAG,
    .list = NULL,
  };
  // Lightroom's Remove Location Info: GPS from the EXIF too (exif.cc)
  if(!json_object_get_boolean_member_with_default(req, "location", TRUE)) metadata.flags &= ~DT_META_GEOTAG;
  if(json_object_get_boolean_member_with_default(req, "history", FALSE)) metadata.flags |= DT_META_DT_HISTORY;
  // what darktable's flags do not reach is taken out of the written file
  // (strip.cc): the text fields and keywords flags decide only what
  // darktable writes, not what the source's EXIF brings along
  strip_t strip = 0;
  if(!json_object_get_boolean_member_with_default(req, "serials", TRUE)) strip |= STRIP_SERIALS;
  if(!json_object_get_boolean_member_with_default(req, "camera", TRUE)) strip |= STRIP_CAMERA;
  if(!json_object_get_boolean_member_with_default(req, "description", TRUE))
  {
    metadata.flags &= ~DT_META_METADATA;
    strip |= STRIP_DESCRIPTION;
  }
  if(!json_object_get_boolean_member_with_default(req, "tags", TRUE))
  {
    metadata.flags &= ~DT_META_TAG;
    strip |= STRIP_KEYWORDS;
  }

  if(!transient)
  {
    gchar *dir = g_path_get_dirname(out);
    g_mkdir_with_parents(dir, 0755);
    g_free(dir);
  }

  // the export's own keywords: the file takes its tags from the library
  // (exif.cc), so they are attached for the export and taken off after,
  // leaving any the image already had
  JsonArray *keywords = json_object_has_member(req, "keywords")
    && JSON_NODE_HOLDS_ARRAY(json_object_get_member(req, "keywords"))
    ? json_object_get_array_member(req, "keywords") : NULL;
  GList *added = NULL;
  for(guint k = 0; keywords && k < json_array_get_length(keywords); k++)
  {
    const char *name = json_array_get_string_element(keywords, k);
    guint tagid = 0;
    if(name && *name && dt_tag_new(name, &tagid) && !dt_is_tag_attached(tagid, imgid)
       && dt_tag_attach(tagid, imgid, FALSE, FALSE))
      added = g_list_prepend(added, GUINT_TO_POINTER(tagid));
  }
  // a draft (the dialog's preview) downscales right after demosaic, as the
  // darkroom does; high quality runs the whole pipe at full size and
  // downscales only before the frame (imageio.c), many times the work
  const gboolean high_quality = !json_object_get_boolean_member_with_default(req, "draft", FALSE);
  // NB: returns FALSE on success
  const gboolean failed = dt_imageio_export_with_flags(
      imgid, out, &proxy, fdata,
      transient /*ignore_exif*/, FALSE /*display_byteorder*/, high_quality,
      FALSE /*upscale*/, FALSE /*is_scaling*/, 1.0, FALSE /*thumbnail*/, NULL /*filter*/,
      !transient /*copy_metadata*/, FALSE /*export_masks*/,
      render_icc, NULL, DT_INTENT_PERCEPTUAL, NULL, NULL, 1, 1, &metadata, -1);
  for(GList *t = added; t; t = g_list_next(t))
    dt_tag_detach(GPOINTER_TO_UINT(t->data), imgid, FALSE, FALSE);
  g_list_free(added);
  if(framed) _frame_done(frame_id, frame_svg);
  fmt->free_params(fmt, fdata);
#ifdef HAVE_AI
  if(failed) *err = _up.err && upscale > 1 ? g_strdup(_up.err) : g_strdup_printf("could not write '%s'", out);
  if(upscale > 1) g_mutex_unlock(&_up_lock);
#else
  if(failed) *err = g_strdup_printf("could not write '%s'", out);
#endif
  if(failed) return FALSE;
  // a file that keeps what was asked to be left out is not delivered
  if(!transient && (*err = strip_metadata(out, strip)))
  {
    g_unlink(out);
    return FALSE;
  }
  return TRUE;
}

// a tagged `export` runs here rather than in the main loop, so the photo is
// edited while a batch exports. darktable's export job does the same beside
// its darkroom: export builds a develop and pipe of its own from the
// library (imageio.c). it renders the job's snapshot of the photo
// (session_hold_take), never the open session. one thread, so a batch keeps its
// order and the editor keeps most of the cores. the job's tagged
// `export_release` comes here too, after its exports, and a tagged
// `hdr_merge`
GThreadPool *export_pool = NULL;
static GMutex _export_pool_lock;

// Merge to HDR: the brackets `imgids` into a float DNG beside the first
// (hdrmerge.c), imported. replies { path, image }. it reads each bracket
// through an export pipe of its own, as an export does, so a tagged one
// runs on the export thread
gboolean export_hdr_merge(JsonObject *req, JsonBuilder *b, FILE *out, char **err)
{
  JsonArray *ids = json_object_has_member(req, "imgids") ? json_object_get_array_member(req, "imgids") : NULL;
  GList *imgids = NULL;
  for(guint k = 0; ids && k < json_array_get_length(ids); k++)
  {
    const dt_imgid_t id = json_array_get_int_element(ids, k);
    if(dt_is_valid_imgid(id) && !g_list_find(imgids, GINT_TO_POINTER(id)))
      imgids = g_list_append(imgids, GINT_TO_POINTER(id));
  }
  const gint64 t0 = g_get_monotonic_time();
  _merge_progress_t progress = _merge_progress(req, out, "merging");
  gchar *path = hdr_merge(imgids, json_object_get_boolean_member_with_default(req, "align", TRUE), _merge_step,
                          &progress, err);
  g_list_free(imgids);
  if(!path) return FALSE;
  const dt_imgid_t newid = library_import(path);
  if(!dt_is_valid_imgid(newid))
  {
    *err = g_strdup_printf("cannot import %s", path);
    g_free(path);
    return FALSE;
  }
  engine_add_string(b, "path", path);
  g_free(path);
  json_builder_set_member_name(b, "image");
  library_image_json(b, newid, FALSE);
  json_builder_set_member_name(b, "seconds");
  json_builder_add_double_value(b, engine_ms_since(t0) / 1000.0);
  return TRUE;
}

#ifdef HAVE_PANO
// what a panorama's frame keeps of its edit: the raw's own steps, up to
// demosaic, denoise and the lens's corrections, all of them before colorin
// (iop_order.c), so the frame stays in the camera's own color, as
// Lightroom merges from the raw data. white balance, color, exposure, the
// tone mapper, the look, crops and effects belong to the panorama, which
// opens as its first frame's raw did (dng.c); the stitch evens out the
// frames' exposures itself. only a module's first instance, unmasked
static const char *_pano_keep[] = {
  "rawprepare", "temperature", "highlights", "cacorrect", "hotpixels", "rawdenoise", "demosaic",
  "denoiseprofile", "rotatepixels", "scalepixels", "lens", "cacorrectrgb", "flip",
};

static gboolean _pano_kept(const dt_iop_module_t *m)
{
  if(m->multi_priority != 0 || (m->blend_params && m->blend_params->mask_mode != DEVELOP_MASK_DISABLED))
    return FALSE;
  for(size_t k = 0; k < G_N_ELEMENTS(_pano_keep); k++)
    if(!g_strcmp0(m->op, _pano_keep[k])) return TRUE;
  return FALSE;
}

// one frame at full size (or bounded by max_edge for a preview), in the camera's color with its white balance
// divided out again, through an export pipe as
// dt_imageio_export_with_flags() builds one, with the modules _pano_keep
// leaves out switched off after the history is replayed. lens correction
// is switched on where the history never set it: the stitch needs the
// lens's distortion gone, and one the user turned off (after DxO PureRAW)
// stays off. `first` is the first frame's image, filled in by its call:
// every other must come from the same camera, as the DNG has one color
// matrix. With rendered inputs, colorin and colorout instead convert all
// frames to linear Rec.2020 and white balance stays applied.
static gboolean _pano_frame(pano_t *p, const dt_imgid_t imgid, dt_image_t *first, const gboolean rendered,
                             const int max_edge, char **err)
{
  dt_develop_t dev;
  dt_dev_init(&dev, FALSE);
  dt_dev_load_image(&dev, imgid);
  dt_mipmap_buffer_t buf;
  dt_mipmap_cache_get(&buf, imgid, DT_MIPMAP_FULL, DT_MIPMAP_BLOCKING, 'r');
  const dt_image_t *img = &dev.image_storage;
  gboolean ok = FALSE;
  if(!buf.buf || !buf.width || !buf.height)
  {
    *err = g_strdup_printf("cannot read '%s'", img->filename);
    goto early;
  }
  if(img->flags & DT_IMAGE_4BAYER)
  {
    *err = g_strdup_printf("'%s' uses an unsupported four-color sensor", img->filename);
    goto early;
  }
  if(!dt_is_valid_imgid(first->id))
    *first = *img;
  else if(!rendered && g_strcmp0(first->camera_makermodel, img->camera_makermodel))
  {
    *err = g_strdup_printf("'%s' is from another camera than '%s'", img->filename, first->filename);
    goto early;
  }
  dt_dev_pixelpipe_t pipe;
  if(!dt_dev_pixelpipe_init_export(&pipe, img->width, img->height, IMAGEIO_RGB | IMAGEIO_FLOAT, FALSE))
  {
    *err = g_strdup("not enough memory for the photo");
    goto early;
  }
  if(rendered)
    dt_dev_pixelpipe_set_icc(&pipe, DT_COLORSPACE_LIN_REC2020, "", DT_INTENT_RELATIVE_COLORIMETRIC);
  gboolean lens_set = FALSE;
  for(GList *l = dev.history; l && l != g_list_nth(dev.history, dev.history_end); l = g_list_next(l))
    lens_set |= !g_strcmp0(((dt_dev_history_item_t *)l->data)->op_name, "lens");
  dt_ioppr_resync_modules_order(&dev);
  dt_dev_pixelpipe_set_input(&pipe, &dev, (float *)buf.buf, buf.width, buf.height, buf.iscale);
  dt_dev_pixelpipe_create_nodes(&pipe, &dev);
  dt_dev_pixelpipe_synch_all(&pipe, &dev);
  for(GList *n = pipe.nodes; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *piece = n->data;
    if(!_pano_kept(piece->module)
       && !(rendered && (!g_strcmp0(piece->module->op, "colorin")
                         || !g_strcmp0(piece->module->op, "colorout"))))
      piece->enabled = FALSE;
    else if(!lens_set && !g_strcmp0(piece->module->op, "lens"))
      piece->enabled = TRUE;
  }
  // the white balance temperature applied (its commit_params), divided out
  float unbalance[3];
  for(int c = 0; c < 3; c++)
    unbalance[c] = !rendered && dev.chroma.wb_coeffs[c] > 0.0f ? 1.0f / dev.chroma.wb_coeffs[c] : 1.0f;
  dt_dev_pixelpipe_get_dimensions(&pipe, &dev, pipe.iwidth, pipe.iheight, &pipe.processed_width,
                                  &pipe.processed_height);
  const float scale = max_edge > 0
    ? fminf(1.0f, (float)max_edge / MAX(pipe.processed_width, pipe.processed_height)) : 1.0f;
  const int w = MAX(1, (int)(pipe.processed_width * scale));
  const int h = MAX(1, (int)(pipe.processed_height * scale));
  if(dt_dev_pixelpipe_process_no_gamma(&pipe, &dev, 0, 0, w, h, scale) || !pipe.backbuf)
    *err = g_strdup_printf("cannot render '%s'", img->filename);
  else
  {
    // the lens's focal length in the frame's pixels, from the EXIF focal
    // length over the sensor's diagonal (a full frame's 43.27 mm by the crop
    // factor); 0 without them
    const double diag = img->exif_crop > 0.0f ? 43.2666 / img->exif_crop : 0.0;
    const double focal = img->exif_focal_length > 0.0f && diag > 0.0
      ? img->exif_focal_length / diag * hypot(w, h) : 0.0;
    ok = pano_add(p, (const float *)pipe.backbuf, w, h, unbalance, focal, err);
  }
  dt_dev_pixelpipe_cleanup(&pipe);
early:
  dt_dev_cleanup(&dev);
  dt_mipmap_cache_release(&buf);
  return ok;
}

// pano_step_t: the stitch's stages, as a merge's progress
static gboolean _pano_step(const char *stage, const int done, const int total, void *data)
{
  return _merge_report(data, stage, done, total, FALSE);
}

// the DNG's rows written, past stopping
static void _pano_written(const int done, const int total, void *data)
{
  _merge_report(data, "writing the DNG", done, total, TRUE);
}

static gboolean _positive_import(const char *path, JsonBuilder *b, char **err);

// Photo Merge › Panorama: the photos `imgids` stitched (pano.cc) into a DNG
// beside the first, <name>-pano.dng or -pano_01.dng..., that opens as the
// first did (dng.c), with its EXIF. `projection` is "auto", "spherical",
// "cylindrical" or "perspective"; `crop` cuts the edges the frames leave
// empty. replies { path, original, image, used, frames, seconds }. it runs
// on the export thread, as HDR Merge
gboolean export_pano_merge(JsonObject *req, JsonBuilder *b, FILE *out, char **err)
{
  const gboolean preview = !g_strcmp0(json_object_get_string_member_with_default(req, "cmd", ""),
                                      "pano_preview");
  JsonArray *ids = json_object_has_member(req, "imgids") ? json_object_get_array_member(req, "imgids") : NULL;
  GList *imgids = NULL;
  for(guint k = 0; ids && k < json_array_get_length(ids); k++)
  {
    const dt_imgid_t id = json_array_get_int_element(ids, k);
    if(dt_is_valid_imgid(id) && !g_list_find(imgids, GINT_TO_POINTER(id)))
      imgids = g_list_append(imgids, GINT_TO_POINTER(id));
  }
  if(g_list_length(imgids) < 2)
  {
    g_list_free(imgids);
    *err = g_strdup("a panorama needs two photos or more");
    return FALSE;
  }
  static const struct { const char *name; pano_projection_t type; } projections[] = {
    { "auto", PANO_AUTO }, { "spherical", PANO_SPHERICAL },
    { "cylindrical", PANO_CYLINDRICAL }, { "perspective", PANO_PERSPECTIVE },
  };
  pano_projection_t projection = PANO_AUTO;
  const char *asked = json_object_get_string_member_with_default(req, "projection", "auto");
  for(size_t k = 0; k < G_N_ELEMENTS(projections); k++)
    if(!g_strcmp0(asked, projections[k].name)) projection = projections[k].type;

  // A selection containing rendered photos uses one common linear space,
  // including any RAW frames in that selection.
  gboolean rendered = preview;
  for(GList *l = imgids; l; l = g_list_next(l))
  {
    const dt_image_t *img = dt_image_cache_get(GPOINTER_TO_INT(l->data), 'r');
    if(img)
    {
      rendered |= !dt_image_is_raw(img);
      dt_image_cache_read_release(img);
    }
  }
  const gint64 t0 = g_get_monotonic_time();
  const dt_imgid_t first = GPOINTER_TO_INT(imgids->data);
  dt_image_t first_img = { 0 };
  const int frames = g_list_length(imgids);
  _merge_progress_t progress = _merge_progress(req, out, NULL);
  pano_t *p = pano_new();
  gboolean ok = TRUE;
  int done = 0;
  for(GList *l = imgids; ok && l; l = g_list_next(l), done++)
  {
    engine_background_yield();
    if(!_merge_report(&progress, "photos", done, frames, FALSE))
    {
      *err = g_strdup("stopped");
      ok = FALSE;
    }
    else
      ok = _pano_frame(p, GPOINTER_TO_INT(l->data), &first_img, rendered, preview ? 1280 : 0, err);
  }
  g_list_free(imgids);
  if(preview)
  {
    pano_preview_t result = { 0 };
    ok = ok && pano_preview(p, projection, _pano_step, &progress, &result, err);
    pano_free(p);
    if(!ok) return FALSE;
    gchar *rgba = g_base64_encode(result.rgba, (gsize)result.width * result.height * 4);
    g_free(result.rgba);
    json_builder_set_member_name(b, "rgba");
    json_builder_add_string_value(b, rgba);
    g_free(rgba);
    json_builder_set_member_name(b, "width");
    json_builder_add_int_value(b, result.width);
    json_builder_set_member_name(b, "height");
    json_builder_add_int_value(b, result.height);
    json_builder_set_member_name(b, "used");
    json_builder_add_int_value(b, result.used);
    json_builder_set_member_name(b, "projection");
    for(size_t k = 0; k < G_N_ELEMENTS(projections); k++)
      if(projections[k].type == result.projection) json_builder_add_string_value(b, projections[k].name);
    json_builder_set_member_name(b, "crop");
    json_builder_begin_array(b);
    for(int k = 0; k < 4; k++) json_builder_add_int_value(b, result.crop[k]);
    json_builder_end_array(b);
    return TRUE;
  }
  int w = 0, h = 0, used = 0;
  float *rgb = ok ? pano_stitch(p, projection, json_object_get_boolean_member_with_default(req, "crop", TRUE),
                                _pano_step, &progress, &w, &h, &used, err)
                  : NULL;
  pano_free(p);
  if(!rgb) return FALSE;

  char pathname[PATH_MAX] = { 0 };
  gboolean from_cache = TRUE;
  dt_image_full_path(first, pathname, sizeof(pathname), &from_cache);
  gchar *original = g_strdup(pathname);
  uint8_t *exif = NULL;
  // not in DNG mode: that keeps the raw's orientation, for a mosaic still
  // the sensor's way up (HDR Merge), where these frames were turned already
  const int exif_len = dt_exif_read_blob(&exif, pathname, first, FALSE, w, h, FALSE);
  char *c = pathname + strlen(pathname);
  while(*c != '.' && c > pathname) c--;
  const size_t free_space = sizeof(pathname) - (c - pathname);
  g_strlcpy(c, "-pano.dng", free_space);
  for(int seq = 1; g_file_test(pathname, G_FILE_TEST_EXISTS); seq++)
    snprintf(c, free_space, "-pano_%02d.dng", seq);

  // written under another name and renamed once whole, so a folder read
  // meanwhile never imports half of it. too late to stop by then
  gchar *part = g_strdup_printf("%s.part", pathname);
  ok = !(rendered
    ? dng_write_rendered_rgb_half(part, rgb, w, h, exif, exif_len, _pano_written, &progress)
    : dng_write_linear_half(part, rgb, w, h, &first_img, exif, exif_len, _pano_written, &progress))
    && !g_rename(part, pathname);
  free(exif);
  g_free(rgb);
  if(!ok)
  {
    g_unlink(part);
    g_free(part);
    g_free(original);
    *err = g_strdup_printf("could not write '%s'", pathname);
    return FALSE;
  }
  g_free(part);

  if(rendered)
  {
    ok = _positive_import(pathname, b, err);
    if(ok) engine_add_string(b, "original", original);
    g_free(original);
    if(!ok) return FALSE;
  }
  else
  {
    const dt_imgid_t newid = library_import(pathname);
    if(!dt_is_valid_imgid(newid))
    {
      g_free(original);
      *err = g_strdup_printf("cannot import %s", pathname);
      return FALSE;
    }
    engine_add_string(b, "path", pathname);
    engine_add_string(b, "original", original);
    g_free(original);
    json_builder_set_member_name(b, "image");
    library_image_json(b, newid, FALSE);
  }
  json_builder_set_member_name(b, "used");
  json_builder_add_int_value(b, used);
  json_builder_set_member_name(b, "frames");
  json_builder_add_int_value(b, frames);
  json_builder_set_member_name(b, "seconds");
  json_builder_add_double_value(b, engine_ms_since(t0) / 1000.0);
  return TRUE;
}

#endif
// Give a rendered positive a persistent neutral starting history. This
// prevents import presets, camera exposure and tone mapping from processing
// the baked conversion twice, including after the app restarts.
static gboolean _positive_import(const char *path, JsonBuilder *b, char **err)
{
  const dt_imgid_t imgid = library_import(path);
  if(!dt_is_valid_imgid(imgid))
  {
    *err = g_strdup_printf("wrote '%s', but could not import it", path);
    return FALSE;
  }
  dt_develop_t dev;
  dt_dev_init(&dev, FALSE);
  dt_dev_load_image(&dev, imgid);
  dt_dev_pop_history_items_ext(&dev, dev.history_end);
  for(GList *l = dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    const gboolean essential = !g_strcmp0(m->op, "rawprepare") || !g_strcmp0(m->op, "demosaic")
      || !g_strcmp0(m->op, "temperature") || !g_strcmp0(m->op, "colorin")
      || !g_strcmp0(m->op, "colorout") || !g_strcmp0(m->op, "gamma")
      || !g_strcmp0(m->op, "flip") || !g_strcmp0(m->op, "scalepixels");
    if(m->enabled && !essential)
    {
      m->enabled = FALSE;
      dt_dev_add_history_item_ext(&dev, m, FALSE, TRUE);
    }
  }
  dt_dev_write_history_ext(&dev, imgid);
  dt_dev_cleanup(&dev);
  dt_history_hash_write_from_history(imgid, DT_HISTORY_HASH_AUTO | DT_HISTORY_HASH_CURRENT);
  if(library_write_sidecar(imgid))
  {
    *err = g_strdup_printf("wrote '%s', but could not save its starting history", path);
    return FALSE;
  }
  dt_mipmap_cache_remove(imgid);
  json_builder_set_member_name(b, "path");
  json_builder_add_string_value(b, path);
  json_builder_set_member_name(b, "image");
  library_image_json(b, imgid, FALSE);
  return TRUE;
}

// print_sheet's photos for a background print: the job's held snapshots,
// and the progress its Stop reaches (as a merge's, _merge_report)
typedef struct _sheet_ctx_t
{
  gint64 job;
  _merge_progress_t progress;
} _sheet_ctx_t;

static dt_imgid_t _sheet_take(gpointer ctx, const dt_imgid_t imgid)
{
  engine_background_yield();
  return session_hold_take(((_sheet_ctx_t *)ctx)->job, imgid);
}

static void _sheet_release(gpointer ctx, const dt_imgid_t snap)
{
  library_snapshot_remove(snap);
}

static gboolean _sheet_step(gpointer ctx, const int done, const int total)
{
  return _merge_report(&((_sheet_ctx_t *)ctx)->progress, "photos", done, total, FALSE);
}

void export_run(gpointer data, gpointer user_data)
{
  JsonParser *parser = data;
  FILE *out = user_data;
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  const gint64 job = json_object_get_int_member_with_default(req, "job", 0);
  const char *cmd = json_object_get_string_member_with_default(req, "cmd", "");
  engine_background_priority();
  char *err = NULL;
  gboolean ok = TRUE;
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member(req, "tag"));
  if(!g_strcmp0(cmd, "export_release"))
    session_hold_release(job);
  else if(!g_strcmp0(cmd, "hdr_merge"))
    ok = export_hdr_merge(req, b, out, &err);
  // a sheet of photos (print.c): each is taken as its page comes to it
  else if(!g_strcmp0(cmd, "print") && json_object_has_member(req, "pages"))
  {
    _sheet_ctx_t ctx = { .job = job, .progress = _merge_progress(req, out, NULL) };
    ok = print_sheet(req, _sheet_take, _sheet_release, _sheet_step, &ctx, b, &err);
  }
#ifdef HAVE_PANO
  else if(!g_strcmp0(cmd, "pano_merge") || !g_strcmp0(cmd, "pano_preview"))
    ok = export_pano_merge(req, b, out, &err);
#endif
  else
  {
    // before each photo: a batch export is one request per photo
    engine_background_yield();
    const dt_imgid_t snap = session_hold_take(job, json_object_get_int_member_with_default(req, "imgid", 0));
    if(dt_is_valid_imgid(snap) && !g_strcmp0(cmd, "print"))
      ok = print_image(snap, req, b, &err);
    else if(dt_is_valid_imgid(snap))
    {
      ok = export_export(snap, req, &err);
      if(ok && _positive_copy(req))
        ok = _positive_import(json_object_get_string_member(req, "out"), b, &err);
    }
    else
    {
      ok = FALSE;
      err = g_strdup("the export was not asked for this photo");
    }
    library_snapshot_remove(snap);
  }
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, ok);
  if(!ok)
  {
    // the reply carries it to the app; the log keeps it for a report
    fprintf(stderr, "[engine] %s failed: %s\n", cmd, err ? err : "(no message)");
    json_builder_set_member_name(b, "error");
    json_builder_add_string_value(b, err                              ? err
                                     : !g_strcmp0(cmd, "hdr_merge")  ? "merging to HDR failed"
                                     : !g_strcmp0(cmd, "pano_merge") ? "merging to a panorama failed"
                                     : !g_strcmp0(cmd, "print")      ? "printing failed"
                                                                     : "export failed");
  }
  json_builder_end_object(b);
  engine_reply(out, b);
  g_object_unref(b);
  g_free(err);
  g_object_unref(parser);
  // export_queue counted it; read ahead pauses while any is left
  g_atomic_int_add(&export_jobs, -1);
}

// FALSE once the pool has stopped; the request then gets no reply
gboolean export_queue(JsonParser *parser)
{
  g_mutex_lock(&_export_pool_lock);
  const gboolean queued = export_pool != NULL;
  if(queued)
  {
    g_atomic_int_inc(&export_jobs);
    g_thread_pool_push(export_pool, parser, NULL);
  }
  g_mutex_unlock(&_export_pool_lock);
  return queued;
}

// before darktable's caches go: the export under way finishes, those
// waiting are dropped, and every snapshot left goes with its holds
void export_wait(void)
{
  g_mutex_lock(&_export_pool_lock);
  GThreadPool *pool = export_pool;
  export_pool = NULL;
  g_mutex_unlock(&_export_pool_lock);
  if(pool) g_thread_pool_free(pool, TRUE, TRUE);
  g_mutex_lock(&session_hold_lock);
  g_clear_pointer(&session_holds, g_hash_table_destroy);
  g_mutex_unlock(&session_hold_lock);
}

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

// looks and AGX presets: darktable styles applied as a named instance, and their amount

#include "engine.h"

// ------------------------------------------------------------------ looks
// a darktable style applied as a "look": its modules become extra
// instances named "look: <style>", after the client's own, so a film
// emulation's tone curve or channel mixer never overwrites the instance the
// client edits. a later look reuses those instances, and no look disables
// them. they are ordinary history, so the sidecar keeps the look
#define _LOOK_PREFIX "look: "

gboolean looks_is_look(const dt_iop_module_t *m)
{
  return g_str_has_prefix(m->multi_name, _LOOK_PREFIX);
}

// the style in a .dtstyle file, imported into the library's styles under
// its own name; the name's last "|" segment is how it is shown
GList *looks_style_items(const char *path, gchar **label, char **err)
{
  gchar *text = NULL;
  if(!g_file_get_contents(path, &text, NULL, NULL))
  {
    *err = g_strdup_printf("cannot read '%s'", path);
    return NULL;
  }
  gchar *a = strstr(text, "<name>"), *z = a ? strstr(a, "</name>") : NULL;
  gchar *name = a && z ? g_strndup(a + 6, z - a - 6) : NULL;
  g_free(text);
  if(!name)
  {
    *err = g_strdup_printf("'%s' is not a darktable style", path);
    return NULL;
  }
  // the one entity a film name is likely to carry
  gchar **amp = g_strsplit(name, "&amp;", -1);
  g_free(name);
  name = g_strjoinv("&", amp);
  g_strfreev(amp);

  if(!dt_styles_exists(name)) dt_styles_import_from_file(path);
  GList *items = dt_styles_exists(name) ? dt_styles_get_item_list(name, FALSE, NO_IMGID, FALSE) : NULL;
  if(!items) *err = g_strdup_printf("could not load the style in '%s'", path);
  const gchar *bar = strrchr(name, '|');
  *label = g_strdup(bar ? bar + 1 : name);
  g_free(name);
  return items;
}

// the look instance of `op`, made (switched off) when there is none yet
dt_iop_module_t *looks_look_instance(const char *op, const gboolean create)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(!g_strcmp0(m->op, op) && looks_is_look(m)) return m;
  }
  dt_iop_module_t *base = create ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, 0) : NULL;
  dt_iop_module_t *m = base ? dt_dev_module_duplicate_ext(&_s.dev, base, TRUE) : NULL;
  if(!m) return NULL;
  g_strlcpy(m->multi_name, _LOOK_PREFIX, sizeof(m->multi_name));
  m->multi_name_hand_edited = TRUE;
  m->enabled = FALSE;
  _s.iop_gen++;
  session_changed(DT_DEV_PIPE_REMOVE);
  return m;
}

// a style item's settings in this darktable's versions, as
// dt_styles_apply_style_item() converts them
gboolean looks_item_params(dt_iop_module_t *m, const dt_style_item_t *si,
                           void *params, dt_develop_blend_params_t *blend)
{
  if(si->module_version == m->version() && si->params_size == m->params_size)
    memcpy(params, si->params, m->params_size);
  else
  {
    void *p = params;
    const int r = dt_iop_legacy_params(m, si->params, si->params_size, si->module_version,
                                       &p, m->version());
    if(r == 1) return FALSE;
    if(r == -1) memcpy(params, m->default_params, m->params_size);
  }
#ifdef IMMAGE_STYLE_BLEND_READER
  const dt_develop_blend_params_t locked = *m->blend_params;
  if(!si->blendop_params)
    memcpy(blend, m->default_blendop_params, sizeof(*blend));
  else if(dt_develop_blend_params_read(m, si->blendop_params, si->blendop_params_size,
                                      si->blendop_version, blend, -1,
                                      dt_develop_blend_mask_locked(&locked), NULL))
    return FALSE;
  dt_develop_blend_keep_locked_mask(m, blend, &locked);
#else
  if(si->blendop_params && si->blendop_version == dt_develop_blend_version()
     && si->blendop_params_size == sizeof(dt_develop_blend_params_t))
    memcpy(blend, si->blendop_params, sizeof(dt_develop_blend_params_t));
  else if(!si->blendop_params
          || dt_develop_blend_legacy_params(m, si->blendop_params, si->blendop_version, blend,
                                            dt_develop_blend_version(), si->blendop_params_size))
    memcpy(blend, m->default_blendop_params, sizeof(dt_develop_blend_params_t));
#endif
  return TRUE;
}

// one darktable AgX preset's settings in this darktable's version, as the
// requested fields ({ field: number }) in `b`; FALSE when it cannot convert
static gboolean _agx_preset_fields(dt_iop_module_t *m, const void *blob, const int size,
                                   const int version, JsonArray *fields, JsonBuilder *b)
{
  void *params = g_malloc0(m->params_size);
  gboolean ok = blob && size > 0 && version > 0 && version <= m->version();
  if(!ok || (version == m->version() && size != m->params_size)
     || (version == 7 && size != 36 * 4))
  {
    g_free(params);
    json_builder_add_null_value(b);
    return FALSE;
  }
  if(version == m->version() && size == m->params_size)
    memcpy(params, blob, m->params_size);
  else
  {
    void *p = params;
    const int r = dt_iop_legacy_params(m, blob, size, version, &p, m->version());
    if(r == 1) ok = FALSE;
    else if(r == -1) memcpy(params, m->default_params, m->params_size);
  }
  json_builder_begin_object(b);
  for(guint i = 0; ok && i < json_array_get_length(fields); i++)
  {
    const char *name = json_array_get_string_element(fields, i);
    char *e = NULL;
    dt_introspection_field_t *f = NULL;
    const void *p = session_field_in(m, params, name, &f, &e);
    g_free(e);
    double num = 0.0;
    if(!p) { ok = FALSE; break; }
    switch(f->header.type)
    {
      case DT_INTROSPECTION_TYPE_FLOAT: num = *(const float *)p; break;
      case DT_INTROSPECTION_TYPE_INT:
      case DT_INTROSPECTION_TYPE_ENUM:  num = *(const int *)p; break;
      case DT_INTROSPECTION_TYPE_BOOL:  num = *(const gboolean *)p ? 1.0 : 0.0; break;
      default: ok = FALSE; continue;
    }
    if(!isfinite(num)) { ok = FALSE; break; }
    json_builder_set_member_name(b, name);
    json_builder_add_double_value(b, num);
  }
  json_builder_end_object(b);
  g_free(params);
  return ok;
}

// the AgX presets of a darktable `data.db` (read only), a `.dtpreset` or a
// `.dtstyle`, as { presets: [{ name, params: { field: number } }] }. the
// params are converted to this darktable's AgX version here, so the app
// never sees a blob or a version. one that cannot convert has incomplete
// params, which the app leaves out
gboolean looks_agx_presets(JsonObject *req, JsonBuilder *b, char **err)
{
  dt_iop_module_t *m = session_module("agx", err);
  if(!m) return FALSE;
  JsonArray *fields = json_object_has_member(req, "fields")
    ? json_object_get_array_member(req, "fields") : NULL;
  if(!fields)
  {
    *err = g_strdup("no fields");
    return FALSE;
  }
  const char *file = json_object_get_string_member_with_default(req, "file", NULL);
  const char *db = json_object_get_string_member_with_default(req, "db", NULL);

  json_builder_set_member_name(b, "presets");
  json_builder_begin_array(b);

  if(file && (g_str_has_suffix(file, ".dtstyle") || g_str_has_suffix(file, ".xml")))
  {
    gchar *label = NULL;
    GList *items = looks_style_items(file, &label, err);
    if(!items) { g_free(label); return FALSE; }
    for(GList *l = items; l; l = g_list_next(l))
    {
      const dt_style_item_t *si = l->data;
      if(g_strcmp0(si->operation, "agx")) continue;
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "name");
      json_builder_add_string_value(b, label);
      json_builder_set_member_name(b, "params");
      _agx_preset_fields(m, si->params, si->params_size, si->module_version, fields, b);
      json_builder_end_object(b);
    }
    g_free(label);
    g_list_free_full(items, dt_style_item_free);
  }
  else if(file)
  {
    xmlDocPtr doc = xmlReadFile(file, NULL, XML_PARSE_NONET);
    xmlNodePtr root = doc ? xmlDocGetRootElement(doc) : NULL;
    if(!root || xmlStrcmp(root->name, BAD_CAST "darktable_preset"))
    {
      if(doc) xmlFreeDoc(doc);
      *err = g_strdup_printf("'%s' is not a darktable preset", file);
      return FALSE;
    }
    gchar *name = NULL, *op = NULL, *hex = NULL;
    int version = 0;
    for(xmlNodePtr n = root->children; n; n = n->next)
      for(xmlNodePtr c = n->children; c; c = c->next)
      {
        xmlChar *t = xmlNodeGetContent(c);
        if(!t) continue;
        if(!xmlStrcmp(c->name, BAD_CAST "name")) name = g_strdup((gchar *)t);
        else if(!xmlStrcmp(c->name, BAD_CAST "operation")) op = g_strdup((gchar *)t);
        else if(!xmlStrcmp(c->name, BAD_CAST "op_params")) hex = g_strdup((gchar *)t);
        else if(!xmlStrcmp(c->name, BAD_CAST "op_version")) version = atoi((gchar *)t);
        xmlFree(t);
      }
    xmlFreeDoc(doc);
    int len = 0;
    unsigned char *blob = !g_strcmp0(op, "agx") && hex
      ? dt_exif_xmp_decode(hex, strlen(hex), &len) : NULL;
    if(blob)
    {
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "name");
      json_builder_add_string_value(b, name ? name : "Preset");
      json_builder_set_member_name(b, "params");
      _agx_preset_fields(m, blob, len, version, fields, b);
      json_builder_end_object(b);
      g_free(blob);
    }
    g_free(name);
    g_free(op);
    g_free(hex);
  }
  else
  {
    gchar *path = db ? g_strdup(db) : g_build_filename(g_get_user_config_dir(), "darktable", "data.db", NULL);
    sqlite3 *h = NULL;
    sqlite3_stmt *st = NULL;
    if(sqlite3_open_v2(path, &h, SQLITE_OPEN_READONLY, NULL) != SQLITE_OK
       || sqlite3_prepare_v2(h, "SELECT name, op_version, op_params FROM presets "
                                "WHERE operation = 'agx' AND writeprotect = 0 ORDER BY name",
                             -1, &st, NULL) != SQLITE_OK)
    {
      *err = g_strdup_printf("cannot read the presets in '%s'", path);
      sqlite3_close(h);
      g_free(path);
      return FALSE;
    }
    while(sqlite3_step(st) == SQLITE_ROW)
    {
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "name");
      json_builder_add_string_value(b, (const char *)sqlite3_column_text(st, 0));
      json_builder_set_member_name(b, "params");
      _agx_preset_fields(m, sqlite3_column_blob(st, 2), sqlite3_column_bytes(st, 2),
                         sqlite3_column_int(st, 1), fields, b);
      json_builder_end_object(b);
    }
    sqlite3_finalize(st);
    sqlite3_close(h);
    g_free(path);
  }
  json_builder_end_array(b);
  return TRUE;
}

// the look in use, or NULL
const char *looks_look_name(void)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(looks_is_look(m) && m->enabled) return m->multi_name + strlen(_LOOK_PREFIX);
  }
  return NULL;
}

// how strongly the look applies, 0-100: its instances' blend opacity,
// which darktable applies only with blending on
double looks_look_amount_value(void)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(looks_is_look(m) && m->enabled && m->blend_params)
      return m->blend_params->mask_mode == DEVELOP_MASK_DISABLED ? 100.0 : m->blend_params->opacity;
  }
  return 100.0;
}

void looks_look_amount(const double amount)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(!looks_is_look(m) || !m->enabled || !m->blend_params) continue;
    // a uniform mask, as darktable converts a classic one (migrate_legacy.c,
    // _migrate_to_uniform)
    if(m->blend_params->mask_mode == DEVELOP_MASK_DISABLED)
      m->blend_params->mask_mode = DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI;
    m->blend_params->opacity = CLAMP(amount, 0.0, 100.0);
    dt_dev_add_history_item_ext(&_s.dev, m, TRUE, TRUE);
  }
  session_changed(DT_DEV_PIPE_SYNCH);
}

// apply the style in `path` as the look, or with NULL, switch the look off
gboolean looks_look(const char *path, char **err)
{
  gchar *label = NULL;
  GList *items = path ? looks_style_items(path, &label, err) : NULL;
  if(path && !items) { g_free(label); return FALSE; }

  GList *used = NULL;
  gboolean ok = TRUE;
  for(GList *l = items; l && ok; l = g_list_next(l))
  {
    const dt_style_item_t *si = l->data;
    dt_iop_module_t *m = looks_look_instance(si->operation, TRUE);
    if(!m || !looks_item_params(m, si, m->params, m->blend_params))
    {
      *err = g_strdup_printf("cannot apply the style's '%s'", si->operation);
      ok = FALSE;
      break;
    }
    g_snprintf(m->multi_name, sizeof(m->multi_name), "%s%s", _LOOK_PREFIX, label);
    m->enabled = si->enabled;
    dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    used = g_list_prepend(used, m);
  }
  // instances the new look does not use, or every one for no look
  for(GList *l = _s.dev.iop; l && ok; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(looks_is_look(m) && m->enabled && !g_list_find(used, m))
    {
      m->enabled = FALSE;
      dt_dev_add_history_item_ext(&_s.dev, m, FALSE, TRUE);
    }
  }
  g_list_free(used);
  g_list_free_full(items, dt_style_item_free);
  g_free(label);
  session_changed(DT_DEV_PIPE_SYNCH);
  return ok;
}

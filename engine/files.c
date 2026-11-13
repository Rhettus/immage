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

// the file choosers of two modules' cards: lut3d's file (iop/lut3d.c) and
// watermark's marker (iop/watermark.c). darktable fills them in its GUI only,
// from the LUT folder preference and the watermarks folders, and stores the
// choice as a name in a char array. The session's fields are numbers, so a
// name is edited as its hash, as the lens module's "lens_pick" is, and the
// engine finds the file again from the hash on a write. Keep the lists and
// the stored names identical to darktable's; the engine builds without gmic
// (scripts/build.sh, USE_GMIC=OFF), so the LUT list has no gmz files and the
// compressed LUT's lutname has no widget.

#include "engine.h"
#include "common/file_location.h"
#include "common/grealpath.h"
#include <dirent.h>

#define LUT_DEF_PATH "plugins/darkroom/lut3d/def_path"
#define LUT_MAX_DEPTH 8
#define LUT_MAX_FILES 100000

// FNV-1a over the name, 48 bits so the hash is a whole number in a double
static double _hash(const char *name)
{
  guint64 h = 14695981039346656037ull;
  for(const unsigned char *c = (const unsigned char *)name; *c; c++) h = (h ^ *c) * 1099511628211ull;
  h &= 0xffffffffffffull;
  return h ? (double)h : 1.0;
}

gboolean files_is_field(const dt_iop_module_t *mod, const char *name)
{
  return (!g_strcmp0(name, FILES_LUT) && !g_strcmp0(mod->op, "lut3d"))
         || (!g_strcmp0(name, FILES_MARKER) && !g_strcmp0(mod->op, "watermark"));
}

// the name param behind a field, and its room
static char *_name_param(dt_iop_module_t *mod, void *base, const char *name, size_t *size, char **err)
{
  dt_introspection_field_t *f = NULL;
  char *p = session_field_in(mod, base, !g_strcmp0(name, FILES_LUT) ? "filepath" : "filename", &f, err);
  if(p) *size = f->Array.count;
  return p;
}

// darktable's _check_extension of lut3d.c, without gmz
static gboolean _lut_ext(const char *name)
{
  const char *dot = strrchr(name, '.');
  if(!dot) return FALSE;
  return !g_ascii_strcasecmp(dot, ".png") || !g_ascii_strcasecmp(dot, ".cube") || !g_ascii_strcasecmp(dot, ".3dl");
}

// watermark.c _load_watermarks
static gboolean _marker_ext(const char *name)
{
  const char *dot = strrchr(name, '.');
  return dot && (!g_ascii_strcasecmp(dot, ".svg") || !g_ascii_strcasecmp(dot, ".png"));
}

static void _unix_separators(char *path)
{
  for(char *c = path; *c; c++)
    if(*c == '\\') *c = '/';
}

// lut3d.c _filepath_is_safe: no part of the path may go up a folder
static gboolean _lut_safe(const char *path)
{
  gchar **parts = g_strsplit_set(path, "/\\", -1);
  gboolean safe = TRUE;
  for(int i = 0; parts[i]; i++)
    if(!g_strcmp0(parts[i], "..")) safe = FALSE;
  g_strfreev(parts);
  return safe;
}

static GList *_sorted_names(const char *dir, gboolean (*wanted)(const char *))
{
  GList *names = NULL;
  GDir *d = g_dir_open(dir, 0, NULL);
  if(d)
  {
    const gchar *n;
    while((n = g_dir_read_name(d)))
      if(wanted(n)) names = g_list_prepend(names, g_strdup(n));
    g_dir_close(d);
  }
  return g_list_sort(names, (GCompareFunc)g_strcmp0);
}

// the relative path of the LUT file under `dir` (relative to `root`) whose
// hash is `hash`, found by walking the folder
static gchar *_find_lut(const char *root, const char *rel, const double hash, int depth, int *budget)
{
  gchar *dir = *rel ? g_build_filename(root, rel, NULL) : g_strdup(root);
  GDir *d = g_dir_open(dir, 0, NULL);
  gchar *found = NULL;
  const gchar *n;
  while(d && !found && (n = g_dir_read_name(d)) && (*budget)-- > 0)
  {
    gchar *sub = *rel ? g_build_filename(rel, n, NULL) : g_strdup(n);
    gchar *full = g_build_filename(root, sub, NULL);
    if(g_file_test(full, G_FILE_TEST_IS_DIR))
    {
      if(depth < LUT_MAX_DEPTH) found = _find_lut(root, sub, hash, depth + 1, budget);
    }
    else if(_lut_ext(n))
    {
      _unix_separators(sub);
      if(_hash(sub) == hash) found = g_strdup(sub);
    }
    g_free(full);
    g_free(sub);
  }
  if(d) g_dir_close(d);
  g_free(dir);
  return found;
}

// the watermark folders in darktable's order: the data folder, then the user's
static void _marker_dirs(gchar **data, gchar **config)
{
  gchar datadir[PATH_MAX] = { 0 }, configdir[PATH_MAX] = { 0 };
  dt_loc_get_datadir(datadir, sizeof(datadir));
  dt_loc_get_user_config_dir(configdir, sizeof(configdir));
  *data = g_build_filename(datadir, "watermarks", NULL);
  *config = g_build_filename(configdir, "watermarks", NULL);
}

gboolean files_read(dt_iop_module_t *mod, const char *name, const gboolean from_defaults, double *num,
                    char **err)
{
  size_t size = 0;
  const char *text = _name_param(mod, from_defaults ? mod->default_params : mod->params, name, &size, err);
  if(!text) return FALSE;
  gchar *copy = g_strndup(text, strnlen(text, size));
  *num = *copy ? _hash(copy) : 0.0;
  g_free(copy);
  return TRUE;
}

gboolean files_write(dt_iop_module_t *mod, const char *name, const double num, char **err)
{
  size_t size = 0;
  char *text = _name_param(mod, mod->params, name, &size, err);
  if(!text) return FALSE;
  gchar *chosen = NULL;
  if(num == 0.0)
    chosen = g_strdup("");
  else if(!g_strcmp0(name, FILES_LUT))
  {
    gchar *root = dt_conf_get_string(LUT_DEF_PATH);
    int budget = LUT_MAX_FILES;
    if(*root) chosen = _find_lut(root, "", num, 0, &budget);
    g_free(root);
    if(!chosen) *err = g_strdup("LUT file not found in the LUT folder");
  }
  else
  {
    gchar *dirs[2];
    _marker_dirs(&dirs[0], &dirs[1]);
    for(int k = 0; k < 2 && !chosen; k++)
    {
      GList *names = _sorted_names(dirs[k], _marker_ext);
      for(GList *l = names; l && !chosen; l = g_list_next(l))
        if(_hash(l->data) == num) chosen = g_strdup(l->data);
      g_list_free_full(names, g_free);
    }
    g_free(dirs[0]);
    g_free(dirs[1]);
    if(!chosen) *err = g_strdup("watermark marker not found");
  }
  if(!chosen) return FALSE;
  if(strlen(chosen) >= size)
  {
    *err = g_strdup_printf("'%s' is too long to store", chosen);
    g_free(chosen);
    return FALSE;
  }
  // dt_strlcpy_to_fixed: the rest of the array is zeroed, so params compare
  // and hash the same
  memset(text, 0, size);
  memcpy(text, chosen, strlen(chosen));
  g_free(chosen);
  return TRUE;
}

static void _file_entry(JsonBuilder *b, const char *path, const char *label)
{
  json_builder_begin_object(b);
  engine_add_string(b, "path", path);
  if(label) engine_add_string(b, "label", label);
  engine_add_double(b, "hash", _hash(path));
  json_builder_end_object(b);
}

// lut3d.c: _update_filepath_combobox, _button_clicked and gui_update. With
// `folder` the LUT folder preference is set first (the app's, which lut3d's
// process reads with dt_conf too). The reply is the folder (empty when none
// is set, which only a cleared preference gives: darktable then disables the chooser), the instance's current file
// (or the one `pick`, an absolute path from the file dialog, names) with its
// hash and whether it exists, and the files next to it, as darktable lists
// them: the current file's folder, nothing while no file is chosen
void files_set_lut_folder(const char *folder)
{
  // none given is darktable's default for the preference, the home folder
  gchar *home = folder && *folder ? NULL : dt_loc_get_home_dir(NULL);
  dt_conf_set_string(LUT_DEF_PATH, home ? home : folder);
  g_free(home);
}

gboolean files_lut(JsonObject *req, JsonBuilder *b, char **err)
{
  if(json_object_has_member(req, "folder"))
    files_set_lut_folder(json_object_get_string_member_with_default(req, "folder", ""));
  gchar *root = dt_conf_get_string(LUT_DEF_PATH);
  gchar *current = NULL;
  const char *pick = json_object_get_string_member_with_default(req, "pick", NULL);
  if(pick && *pick)
  {
    // _button_clicked: only a file inside the folder is taken
    if(!*root)
    {
      *err = g_strdup("LUT root folder not defined");
      g_free(root);
      return FALSE;
    }
    // both resolved, so a link or a .. cannot lead out of the folder
    gchar *base = g_realpath(root), *file = g_realpath(pick);
    gchar *prefix = g_strconcat(base ? base : root, G_DIR_SEPARATOR_S, NULL);
    if(!file || !g_str_has_prefix(file, prefix) || !_lut_safe(file + strlen(prefix)))
      *err = g_strdup("select file outside LUT root folder is not allowed");
    else if(!_lut_ext(file) || !g_file_test(file, G_FILE_TEST_IS_REGULAR))
      *err = g_strdup("not a LUT file: use a png (hald CLUT), cube or 3dl file");
    else
    {
      current = g_strdup(file + strlen(prefix));
      _unix_separators(current);
    }
    g_free(base);
    g_free(file);
    g_free(prefix);
    if(!current)
    {
      g_free(root);
      return FALSE;
    }
  }
  else
  {
    dt_iop_module_t *mod = session_module_at("lut3d", (int)json_object_get_int_member_with_default(req, "priority", 0), err);
    if(!mod)
    {
      g_free(root);
      return FALSE;
    }
    size_t size = 0;
    const char *text = _name_param(mod, mod->params, FILES_LUT, &size, err);
    if(!text)
    {
      g_free(root);
      return FALSE;
    }
    current = g_strndup(text, strnlen(text, size));
    // gui_update lists nothing for a path that goes up a folder
    if(!_lut_safe(current)) *current = '\0';
  }

  engine_add_string(b, "folder", root);
  engine_add_string(b, "current", current);
  engine_add_double(b, "current_hash", *current ? _hash(current) : 0.0);
  gchar *full = *root && *current ? g_build_filename(root, current, NULL) : NULL;
  engine_add_bool(b, "exists", full && g_file_test(full, G_FILE_TEST_EXISTS));
  json_builder_set_member_name(b, "files");
  json_builder_begin_array(b);
  if(*root && *current)
  {
    gchar *rel = g_path_get_dirname(current);
    gchar *folder = g_build_filename(root, rel, NULL);
    GList *names = _sorted_names(folder, _lut_ext);
    for(GList *l = names; l; l = g_list_next(l))
    {
      gchar *path = strcmp(rel, ".") ? g_build_filename(rel, l->data, NULL) : g_strdup(l->data);
      _unix_separators(path);
      _file_entry(b, path, NULL);
      g_free(path);
    }
    g_list_free_full(names, g_free);
    g_free(rel);
    g_free(folder);
  }
  json_builder_end_array(b);
  g_free(full);
  g_free(current);
  g_free(root);
  return TRUE;
}

// watermark.c: _refresh_watermarks and _load_watermarks, the markers of the
// data folder then the user's, each sorted by name, shown as "name (ext)";
// `dirs` are the two folders, for the tooltip
gboolean files_watermarks(JsonBuilder *b, char **err)
{
  gchar *dirs[2];
  _marker_dirs(&dirs[0], &dirs[1]);
  json_builder_set_member_name(b, "markers");
  json_builder_begin_array(b);
  for(int k = 0; k < 2; k++)
  {
    GList *names = _sorted_names(dirs[k], _marker_ext);
    for(GList *l = names; l; l = g_list_next(l))
    {
      const char *file = l->data, *dot = strrchr(file, '.');
      gchar *label = g_strdup_printf("%.*s (%s)", (int)(dot - file), file, dot + 1);
      _file_entry(b, file, label);
      g_free(label);
    }
    g_list_free_full(names, g_free);
  }
  json_builder_end_array(b);
  json_builder_set_member_name(b, "dirs");
  json_builder_begin_array(b);
  json_builder_add_string_value(b, dirs[0]);
  json_builder_add_string_value(b, dirs[1]);
  json_builder_end_array(b);
  g_free(dirs[0]);
  g_free(dirs[1]);
  return TRUE;
}

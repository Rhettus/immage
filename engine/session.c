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

// the open photo: opening and closing, holds, history, fields, renders, previews, saving and pasting

#include "engine.h"

// the edit changed: the main pipe follows now, the others before their next
// frame. synch_top takes only the latest history item, so a second change
// in between makes that a whole synch
static void _follow(dt_engine_follower_t *f, const dt_dev_pixelpipe_change_t flags)
{
  f->pending = f->pending ? f->pending | flags | DT_DEV_PIPE_SYNCH : flags;
}

void session_changed(const dt_dev_pixelpipe_change_t flags)
{
  _s.pipe.changed |= flags;
  dt_dev_pixelpipe_change(&_s.pipe, &_s.dev);
  _follow(&_s.drag, flags);
  _follow(&_s.base, flags);
  _follow(&_s.check, flags);
}

void session_follower_cleanup(dt_engine_follower_t *f)
{
  if(f->ok) dt_dev_pixelpipe_cleanup(&f->pipe);
  f->ok = FALSE;
  f->pending = DT_DEV_PIPE_UNCHANGED;
}

void session_close_session(void)
{
  if(!_s.open) return;
#ifdef HAVE_AI
  ai_denoise_forget();
#endif
  if(_s.ppipe_ok) dt_dev_pixelpipe_cleanup(&_s.ppipe);
  _s.ppipe_ok = FALSE;
  session_follower_cleanup(&_s.drag);
  session_follower_cleanup(&_s.base);
  session_follower_cleanup(&_s.check);
  dt_dev_pixelpipe_cleanup(&_s.pipe);
  dt_mipmap_cache_release(&_s.buf);
  dt_dev_cleanup(&_s.dev);
  _s.open = FALSE;
  _s.unsaved = FALSE;
  _s.before = FALSE;
  _s.fresh = FALSE;
  _s.baseline = FALSE;
  g_list_free(_s.deleted);
  _s.deleted = NULL;
}

// the photos each background export is to render, by job: imgid to its
// snapshot, or to NO_IMGID until one is needed. a photo's edit changes only
// while it is open, so the open photo is copied when the export is asked
// for (`export_hold`) and the others as they are opened (_hold_open), or
// when the export reaches them (session_hold_take). either way the export renders
// the edit as it was when it was asked for
GMutex session_hold_lock;
GHashTable *session_holds = NULL;

static void _hold_free(gpointer data)
{
  GHashTableIter it;
  gpointer key, value;
  g_hash_table_iter_init(&it, data);
  while(g_hash_table_iter_next(&it, &key, &value)) library_snapshot_remove(GPOINTER_TO_INT(value));
  g_hash_table_destroy(data);
}

// `open_imgid` is the photo open in the editor, its edit already in the
// library, or NO_IMGID
void session_hold(const gint64 job, JsonArray *imgids, const dt_imgid_t open_imgid)
{
  eng_lock(&session_hold_lock, ENG_LOCK_HOLD);
  if(!session_holds) session_holds = g_hash_table_new_full(g_int64_hash, g_int64_equal, g_free, _hold_free);
  gint64 *key = g_new(gint64, 1);
  *key = job;
  GHashTable *held = g_hash_table_new(NULL, NULL);
  for(guint k = 0; imgids && k < json_array_get_length(imgids); k++)
  {
    const dt_imgid_t imgid = json_array_get_int_element(imgids, k);
    if(!dt_is_valid_imgid(imgid) || g_hash_table_contains(held, GINT_TO_POINTER(imgid))) continue;
    g_hash_table_insert(held, GINT_TO_POINTER(imgid),
                        GINT_TO_POINTER(imgid == open_imgid ? library_snapshot(imgid) : NO_IMGID));
  }
  g_hash_table_replace(session_holds, key, held);
  eng_unlock(&session_hold_lock, ENG_LOCK_HOLD);
}

// a photo about to be opened: every export still to render it gets its
// edit before the editor can change it
static void _hold_open(const dt_imgid_t imgid)
{
  eng_lock(&session_hold_lock, ENG_LOCK_HOLD);
  GHashTableIter it;
  gpointer key, held;
  if(session_holds) g_hash_table_iter_init(&it, session_holds);
  while(session_holds && g_hash_table_iter_next(&it, &key, &held))
  {
    gpointer snap;
    if(g_hash_table_lookup_extended(held, GINT_TO_POINTER(imgid), NULL, &snap)
       && !dt_is_valid_imgid(GPOINTER_TO_INT(snap)))
      g_hash_table_insert(held, GINT_TO_POINTER(imgid), GINT_TO_POINTER(library_snapshot(imgid)));
  }
  eng_unlock(&session_hold_lock, ENG_LOCK_HOLD);
}

// the snapshot job's export of `imgid` renders, now the caller's to remove;
// NO_IMGID when the job does not hold the photo
dt_imgid_t session_hold_take(const gint64 job, const dt_imgid_t imgid)
{
  eng_lock(&session_hold_lock, ENG_LOCK_HOLD);
  GHashTable *held = session_holds ? g_hash_table_lookup(session_holds, &job) : NULL;
  gpointer snap = NULL;
  dt_imgid_t taken = NO_IMGID;
  if(held && g_hash_table_lookup_extended(held, GINT_TO_POINTER(imgid), NULL, &snap))
  {
    // under the lock, so the photo can't be opened while it is copied
    taken = dt_is_valid_imgid(GPOINTER_TO_INT(snap)) ? GPOINTER_TO_INT(snap) : library_snapshot(imgid);
    g_hash_table_remove(held, GINT_TO_POINTER(imgid));
  }
  eng_unlock(&session_hold_lock, ENG_LOCK_HOLD);
  return taken;
}

// the job's photos it will not export after all, with their snapshots
void session_hold_release(const gint64 job)
{
  eng_lock(&session_hold_lock, ENG_LOCK_HOLD);
  if(session_holds) g_hash_table_remove(session_holds, &job);
  eng_unlock(&session_hold_lock, ENG_LOCK_HOLD);
}

// whether the history holds entries a later one of the same module
// supersedes, or masks from more than one point in it. every save used to
// add to it, and a sidecar's masks are stored again for each entry that
// changes them, so an edited photo's sidecar grew to megabytes that
// darktable reads back in quadratic time (exif.cc, _read_masks_v3())
static gboolean _history_bloated(const dt_imgid_t imgid)
{
  sqlite3_stmt *stmt;
  gboolean bloated = FALSE;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT (SELECT COUNT(*) FROM main.history"
                              "         WHERE imgid = ?1 AND operation != 'mask_manager')"
                              "       > (SELECT COUNT(*) FROM (SELECT DISTINCT operation, multi_priority"
                              "                                FROM main.history"
                              "                                WHERE imgid = ?1 AND operation != 'mask_manager'))"
                              "    OR (SELECT COUNT(DISTINCT num) FROM main.masks_history WHERE imgid = ?1) > 1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  if(sqlite3_step(stmt) == SQLITE_ROW) bloated = sqlite3_column_int(stmt, 0);
  sqlite3_finalize(stmt);
  return bloated;
}

// whether instance `multi_name` of `op` is switched off yet holds a mask's
// settings: a hidden mask's instances, or those of a mask sharing them
// (masks_combine()). they are still attached to the mask, which a deleted
// mask's instances no longer are (masks_mask_delete())
static gboolean _holds_mask_settings(const char *op, const char *multi_name)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(m->enabled || g_strcmp0(m->op, op) || g_strcmp0(m->multi_name, multi_name)) continue;
    const dt_masks_form_t *grp = masks_instance_group(m);
    if(grp && masks_mask_name(grp->name)) return TRUE;
  }
  return FALSE;
}

// whether `op` is one the photo's conversion switches off, keeping its
// settings for when the photo is turned back (manifest.ts, NEG_OFF, SF_OFF
// and their _UNMAPPED sets): a converted negative's, while negadoctor is
// on, or a film simulation's tone mappers, while spektrafilm is. their
// entries stay
static gboolean _held_for_mode(const char *op)
{
  static const char *negative[] = { "channelmixerrgb", "exposure", "toneequal", "hazeremoval", "agx", "sigmoid",
                                    "filmicrgb", "basecurve", NULL };
  static const char *film[] = { "agx", "sigmoid", "filmicrgb", "basecurve", NULL };
  static const struct { const char *mode; const char **held; } modes[] = {
    { "negadoctor", negative }, { "spektrafilm", film },
  };
  for(size_t k = 0; k < G_N_ELEMENTS(modes); k++)
  {
    const dt_iop_module_t *m = dt_iop_get_module_by_op_priority(_s.dev.iop, modes[k].mode, 0);
    if(!m || !m->enabled) continue;
    for(int i = 0; modes[k].held[i]; i++)
      if(!g_strcmp0(op, modes[k].held[i])) return TRUE;
  }
  return FALSE;
}

// drops the entries of modules switched off that darktable does not start
// switched on: they do nothing, and a deleted mask leaves its instances so.
// the shapes of masks all deleted go too. a mask's own instances that hold
// its settings stay (_holds_mask_settings()), or a hidden or sharing mask
// would come back without them, as do those a negative or a film simulation
// holds (_held_for_mode()).
// one darktable starts on keeps its entry, or replaying the history would
// switch it back on. needs the image open, for each module's default.
// returns whether anything went
static gboolean _prune_off(const dt_imgid_t imgid)
{
  if(!_s.open || _s.imgid != imgid) return FALSE;
  int pruned = 0;
  GHashTable *done = g_hash_table_new(g_str_hash, g_str_equal);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(m->default_enabled || g_hash_table_contains(done, m->op) || _held_for_mode(m->op)) continue;
    g_hash_table_add(done, (gpointer)m->op);
    GArray *drop = g_array_new(FALSE, FALSE, sizeof(int));
    sqlite3_stmt *stmt;
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "SELECT num, multi_name FROM main.history"
                                " WHERE imgid = ?1 AND operation = ?2 AND enabled = 0",
                                -1, &stmt, NULL);
    DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
    DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 2, m->op, -1, SQLITE_TRANSIENT);
    while(sqlite3_step(stmt) == SQLITE_ROW)
    {
      const int num = sqlite3_column_int(stmt, 0);
      if(!_holds_mask_settings(m->op, (const char *)sqlite3_column_text(stmt, 1))) g_array_append_val(drop, num);
    }
    sqlite3_finalize(stmt);
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "DELETE FROM main.history WHERE imgid = ?1 AND num = ?2", -1, &stmt, NULL);
    for(guint k = 0; k < drop->len; k++)
    {
      DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
      DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, g_array_index(drop, int, k));
      sqlite3_step(stmt);
      pruned += sqlite3_changes(dt_database_get(darktable.db));
      sqlite3_reset(stmt);
    }
    sqlite3_finalize(stmt);
    g_array_free(drop, TRUE);
  }
  g_hash_table_destroy(done);
  // the instances Advanced mode deleted go whole, whatever darktable starts
  // on: an instance past the first is made only by its own entries
  for(GList *l = _s.deleted; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    sqlite3_stmt *stmt;
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "DELETE FROM main.history"
                                " WHERE imgid = ?1 AND operation = ?2 AND multi_priority = ?3",
                                -1, &stmt, NULL);
    DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
    DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 2, m->op, -1, SQLITE_TRANSIENT);
    DT_DEBUG_SQLITE3_BIND_INT(stmt, 3, m->multi_priority);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    pruned += sqlite3_changes(dt_database_get(darktable.db));
  }
  // with the last mask deleted, the entry deleting it carries no shapes,
  // and compress would keep the last one that did
  if(!_s.dev.forms)
  {
    sqlite3_stmt *stmt;
    DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                                "DELETE FROM main.masks_history WHERE imgid = ?1", -1, &stmt, NULL);
    DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
    sqlite3_step(stmt);
    sqlite3_finalize(stmt);
    pruned += sqlite3_changes(dt_database_get(darktable.db));
  }
  return pruned > 0;
}

// the history down to one entry per module instance, as darktable's
// "compress history stack", less the modules switched off; the client
// keeps its own undo. dt_history_compress() writes the sidecar itself
static void _compress_history(const dt_imgid_t imgid)
{
  if(_history_bloated(imgid)) dt_history_compress(imgid);
  // after the compress, so only an instance's last entry decides; the
  // second compress closes the gaps in the numbering
  if(_prune_off(imgid)) dt_history_compress(imgid);
}

// an entry of the `history` reply: the module, its instance label, on or off.
// `mod` is the instance the entry is for, NULL if the develop has none: what
// the History panel may switch off or delete (`module_state`)
void session_history_item(JsonBuilder *b, const char *op, const char *name, const char *multi_name,
                          const gboolean hand_edited, const gboolean enabled,
                          const int priority, const dt_iop_module_t *mod)
{
  const gboolean labeled = multi_name && multi_name[0] && g_strcmp0(multi_name, "0");
  gchar *label = !labeled ? NULL
    : hand_edited ? g_strdup(multi_name)
    : dt_util_localize_segmented_name(multi_name, FALSE);
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "op");
  json_builder_add_string_value(b, op);
  json_builder_set_member_name(b, "name");
  json_builder_add_string_value(b, name ? name : op);
  json_builder_set_member_name(b, "label");
  if(label) json_builder_add_string_value(b, label); else json_builder_add_null_value(b);
  json_builder_set_member_name(b, "enabled");
  json_builder_add_boolean_value(b, enabled);
  json_builder_set_member_name(b, "priority");
  json_builder_add_int_value(b, priority);
  json_builder_set_member_name(b, "default_enabled");
  json_builder_add_boolean_value(b, mod && mod->default_enabled);
  // no switch in darktable either: the pipe needs it, or it has none
  json_builder_set_member_name(b, "fixed");
  json_builder_add_boolean_value(b, !mod || mod->hide_enable_button);
  json_builder_set_member_name(b, "masked");
  json_builder_add_boolean_value(b, mod && mod->blend_params && mod->blend_params->mask_id > 0);
  json_builder_end_object(b);
  g_free(label);
}

// the open image's history in the library, up to its history_end
void session_saved_history(JsonBuilder *b)
{
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT h.operation, h.multi_name, h.multi_name_hand_edited, h.enabled,"
                              "       h.multi_priority"
                              " FROM main.history AS h, main.images AS i"
                              " WHERE h.imgid = ?1 AND i.id = h.imgid AND h.num < i.history_end"
                              " ORDER BY h.num",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, _s.imgid);
  while(sqlite3_step(stmt) == SQLITE_ROW)
  {
    const char *op = (const char *)sqlite3_column_text(stmt, 0);
    if(!op) continue;
    const int priority = sqlite3_column_int(stmt, 4);
    session_history_item(b, op, dt_iop_get_localized_name(op), (const char *)sqlite3_column_text(stmt, 1),
                  sqlite3_column_int(stmt, 2), sqlite3_column_int(stmt, 3), priority,
                  dt_iop_get_module_by_op_priority(_s.dev.iop, op, priority));
  }
  sqlite3_finalize(stmt);
}

static gboolean _has_history(const dt_imgid_t imgid)
{
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT 1 FROM main.history WHERE imgid = ?1 LIMIT 1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  const gboolean found = sqlite3_step(stmt) == SQLITE_ROW;
  sqlite3_finalize(stmt);
  return found;
}

// `version` picks one of the file's versions by imgid, and any other value
// its lowest
gboolean session_open_image(const char *path, const dt_imgid_t version, const char *pipe_kind,
                            char **err)
{
  session_close_session();

  dt_imgid_t imgid = library_import(path);
  if(!dt_is_valid_imgid(imgid))
  {
    *err = g_strdup_printf("could not import '%s'", path);
    return FALSE;
  }
  GList *ids = library_image_versions(imgid);
  if(ids) imgid = GPOINTER_TO_INT(ids->data);
  if(g_list_find(ids, GINT_TO_POINTER(version))) imgid = version;
  g_list_free(ids);
  _hold_open(imgid);

  // a sidecar saved before history was compressed is compressed now, once,
  // so this session starts from the short history and saves stay small
  _compress_history(imgid);

  // before loading, which writes darktable's automatic presets to history
  const gboolean fresh = !_has_history(imgid);

  dt_dev_init(&_s.dev, FALSE);
  dt_dev_load_image(&_s.dev, imgid);
  masks_repair_brushes();
  // load_image reads the history but does not replay it into module params
  dt_dev_pop_history_items_ext(&_s.dev, _s.dev.history_end);

  dt_mipmap_cache_get(&_s.buf, imgid, DT_MIPMAP_FULL, DT_MIPMAP_BLOCKING, 'r');
  if(!_s.buf.buf || !_s.buf.width || !_s.buf.height)
  {
    dt_mipmap_cache_release(&_s.buf);
    dt_dev_cleanup(&_s.dev);
    *err = g_strdup_printf("could not load pixels of '%s'", path);
    return FALSE;
  }

  const int wd = _s.dev.image_storage.width;
  const int ht = _s.dev.image_storage.height;
  const gboolean ok = g_strcmp0(pipe_kind, "export") == 0
    ? dt_dev_pixelpipe_init_export(&_s.pipe, wd, ht, IMAGEIO_RGB | IMAGEIO_INT8, FALSE)
    : g_strcmp0(pipe_kind, "full") == 0
    ? dt_dev_pixelpipe_init(&_s.pipe)
    : dt_dev_pixelpipe_init_preview(&_s.pipe);
  if(!ok)
  {
    dt_mipmap_cache_release(&_s.buf);
    dt_dev_cleanup(&_s.dev);
    *err = g_strdup("could not allocate the pixelpipe");
    return FALSE;
  }

  dt_ioppr_resync_modules_order(&_s.dev);
  dt_dev_pixelpipe_set_icc(&_s.pipe, DT_COLORSPACE_SRGB, NULL, DT_INTENT_LAST);
  dt_dev_pixelpipe_set_input(&_s.pipe, &_s.dev, (float *)_s.buf.buf,
                             _s.buf.width, _s.buf.height, _s.buf.iscale);
  dt_dev_pixelpipe_create_nodes(&_s.pipe, &_s.dev);
  dt_dev_pixelpipe_synch_all(&_s.pipe, &_s.dev);
  // colorin's commit marks an image with an sRGB or Adobe RGB input profile
  // as USER_RGB, in the image cache only (iop_profile.c,
  // dt_ioppr_set_pipe_input_profile_info). darktable's import thumbnails do
  // that before the darkroom loads a photo; the engine's import does not, so
  // a photo's first session would scale its input without gamma correction
  // (pixelpipe_hb.c, clip&zoom) and render unlike every later session
  const dt_image_t *cimg = dt_image_cache_get(imgid, 'r');
  if(cimg)
  {
    _s.dev.image_storage.colorspace = cimg->colorspace;
    dt_image_cache_read_release(cimg);
  }
  dt_dev_pixelpipe_get_dimensions(&_s.pipe, &_s.dev, _s.pipe.iwidth, _s.pipe.iheight,
                                  &_s.pipe.processed_width, &_s.pipe.processed_height);
  _s.imgid = imgid;
  _s.open = TRUE;
  _s.fresh = _s.baseline = fresh;
  return TRUE;
}

dt_iop_module_t *session_module(const char *op, char **err)
{
  dt_iop_module_t *mod = op ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, 0) : NULL;
  if(!mod) *err = g_strdup_printf("module '%s' not in the pipe", op ? op : "(none)");
  return mod;
}

// resolve a path such as "exposure", "tonecurve_nodes[0]" or
// "tonecurve[0][3].x" inside `base` (params or default_params). get_f()
// describes an array element only as its first one, so indices and members
// are walked with the introspection helpers instead (introspection.md)
void *session_field_in(dt_iop_module_t *mod, void *base, const char *path,
                       dt_introspection_field_t **f, char **err)
{
  *f = NULL;
  void *p = NULL;
  gchar **parts = g_strsplit(path, ".", -1);
  for(int i = 0; parts[i]; i++)
  {
    gchar *bracket = strchr(parts[i], '[');
    gchar *name = g_strndup(parts[i], bracket ? bracket - parts[i] : strlen(parts[i]));
    if(i == 0)
    {
      *f = mod->so->have_introspection ? mod->get_f(name) : NULL;
      p = *f ? (uint8_t *)base + (*f)->header.offset : NULL;
    }
    else
      p = dt_introspection_get_child(*f, p, name, f);
    g_free(name);

    for(gchar *b = bracket; p && b && *b == '['; b = strchr(b + 1, '['))
    {
      char *end = NULL;
      const unsigned long k = strtoul(b + 1, &end, 10);
      if(!end || *end != ']') { p = NULL; break; }
      p = dt_introspection_access_array(*f, p, k, f);
    }
    if(!p) break;
  }
  g_strfreev(parts);

  if(!p) *err = g_strdup_printf("'%s' has no field '%s'", mod->op, path);
  return p;
}

gboolean session_write_field_in(dt_iop_module_t *mod, void *base, const char *name,
                               const double num, char **err)
{
  dt_introspection_field_t *f = NULL;
  void *p = session_field_in(mod, base, name, &f, err);
  if(!p) return FALSE;
  switch(f->header.type)
  {
    case DT_INTROSPECTION_TYPE_FLOAT:  *(float *)p = (float)num; break;
    case DT_INTROSPECTION_TYPE_DOUBLE: *(double *)p = num; break;
    case DT_INTROSPECTION_TYPE_INT:
    case DT_INTROSPECTION_TYPE_ENUM:   *(int *)p = (int)num; break;
    case DT_INTROSPECTION_TYPE_UINT:   *(unsigned int *)p = (unsigned int)num; break;
    case DT_INTROSPECTION_TYPE_BOOL:   *(gboolean *)p = num != 0.0; break;
    default:
      *err = g_strdup_printf("'%s.%s' is not a settable scalar", mod->op, name);
      return FALSE;
  }
  return TRUE;
}

// "blend.details", besides the params: darktable's details threshold, which
// keeps the module to the raw's detailed areas (> 0) or its flat ones (< 0).
// it acts only through a mask, so a module without one gets a whole-image
// drawn mask with no shapes (blend.c fills it with 1) while it is non-zero
#define BLEND_DETAILS "blend.details"
#define WHOLE_IMAGE_MASK (DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI)

static gboolean _write_details(dt_iop_module_t *mod, const double num, char **err)
{
  dt_develop_blend_params_t *bp = mod->blend_params;
  if(!bp || !(mod->flags() & IOP_FLAGS_SUPPORTS_BLENDING))
  {
    *err = g_strdup_printf("'%s' does not blend", mod->op);
    return FALSE;
  }
  bp->details = CLAMP(num, -1.0, 1.0);
  const gboolean on = !feqf(bp->details, 0.0f, 1e-6f);
  if(on && bp->mask_mode <= DEVELOP_MASK_ENABLED)
  {
    bp->mask_mode = WHOLE_IMAGE_MASK;
    bp->mask_id = 0;
    bp->mask_combine = 0;
  }
  else if(!on && bp->mask_mode == WHOLE_IMAGE_MASK && bp->mask_id == 0)
    bp->mask_mode = DEVELOP_MASK_DISABLED;
  return TRUE;
}

// "lens_pick" of the lens module, besides its params: 0 for the lens
// darktable matched from the EXIF (the default params'), else lenses_hash()
// of the Lensfun lens chosen in its place. the params keep the lens's name
// and its geometry, as the module's own lens menu sets them, and the method
// is Lensfun's: a raw that carries its own correction defaults to the
// embedded one, which has no use for a lens of the database
#define LENS_PICK "lens_pick"
#define LENS_METHOD_LENSFUN 1

static gboolean _write_lens_pick(dt_iop_module_t *mod, const double num, char **err)
{
  dt_introspection_field_t *f = NULL;
  char *lens = session_field_in(mod, mod->params, "lens", &f, err);
  const char *auto_lens = lens ? session_field_in(mod, mod->default_params, "lens", &f, err) : NULL;
  int *geom = session_field_in(mod, mod->params, "target_geom", &f, err);
  const int *auto_geom = geom ? session_field_in(mod, mod->default_params, "target_geom", &f, err) : NULL;
  int *method = session_field_in(mod, mod->params, "method", &f, err);
  const int *auto_method = method ? session_field_in(mod, mod->default_params, "method", &f, err) : NULL;
  if(!lens || !auto_lens || !geom || !auto_geom || !method || !auto_method) return FALSE;
  if(num <= 0.0)
  {
    g_strlcpy(lens, auto_lens, 128);
    *geom = *auto_geom;
    *method = *auto_method;
    return TRUE;
  }
  char model[128];
  int type = 0;
  if(!lenses_find((unsigned)num, model, sizeof model, &type))
  {
    *err = g_strdup("no such lens in the Lensfun database");
    return FALSE;
  }
  g_strlcpy(lens, model, 128);
  *geom = type ? type : *auto_geom;
  *method = LENS_METHOD_LENSFUN;
  return TRUE;
}

// Scalar choices for colorin's (type, filename) pairs. Zero restores this
// image's defaults; built-ins use type + 1, ICC files a stable filename hash.
// Keep the filename in native params/XMP, never the menu index.
static guint64 _profile_id(const int type, const char *filename)
{
  // Match darktable's basename-based ICC lookup, including sidecars copied
  // between operating systems with different path separators.
  const char *base = filename;
  for(const char *c = filename; *c; c++) if(*c == '/' || *c == '\\') base = c + 1;
  return type == DT_COLORSPACE_FILE ? 256ULL + g_str_hash(base) : (guint64)type + 1;
}

static gboolean _profile_fields(dt_iop_module_t *mod, void *params, const gboolean work,
                                 int **type, char **filename, char **err)
{
  dt_introspection_field_t *f = NULL;
  *type = session_field_in(mod, params, work ? "type_work" : "type", &f, err);
  *filename = *type ? session_field_in(mod, params, work ? "filename_work" : "filename", &f, err) : NULL;
  return *type && *filename;
}

static gboolean _read_profile(dt_iop_module_t *mod, const gboolean defaults, const gboolean work,
                              double *num, char **err)
{
  int *type; char *filename;
  if(!_profile_fields(mod, defaults ? mod->default_params : mod->params, work, &type, &filename, err))
    return FALSE;
  *num = _profile_id(*type, filename);
  return TRUE;
}

static gboolean _write_profile(dt_iop_module_t *mod, const gboolean work, const double num, char **err)
{
  int *type; char *filename;
  if(!_profile_fields(mod, mod->params, work, &type, &filename, err)) return FALSE;
  if(num == 0)
  {
    int *def_type; char *def_filename;
    if(!_profile_fields(mod, mod->default_params, work, &def_type, &def_filename, err)) return FALSE;
    *type = *def_type;
    g_strlcpy(filename, def_filename, DT_IOP_COLOR_ICC_LEN);
    return TRUE;
  }
  // Unavailable profiles kept in a sidecar must survive edits to the other
  // choice. Choosing a different unavailable file is an error.
  if(num == _profile_id(*type, filename)) return TRUE;
  const dt_colorspaces_color_profile_t *chosen = NULL;
  for(const GList *l = darktable.color_profiles->profiles; l; l = l->next)
  {
    const dt_colorspaces_color_profile_t *p = l->data;
    if((work ? p->work_pos : p->in_pos) < 0 || num != _profile_id(p->type, p->filename)) continue;
    if(chosen && (p->type != chosen->type || strcmp(p->filename, chosen->filename)))
    {
      *err = g_strdup("ambiguous color profile identifier");
      return FALSE;
    }
    chosen = p;
  }
  // Camera profiles are image-specific, outside the global profile list.
  if(!chosen && !work && (num == DT_COLORSPACE_STANDARD_MATRIX + 1
                         || num == DT_COLORSPACE_ENHANCED_MATRIX + 1))
  {
    *type = (int)num - 1;
    filename[0] = '\0';
    return TRUE;
  }
  if(!chosen)
  {
    *err = g_strdup("color profile unavailable or unsuitable for this role");
    return FALSE;
  }
  *type = chosen->type;
  g_strlcpy(filename, chosen->filename, DT_IOP_COLOR_ICC_LEN);
  return TRUE;
}

gboolean session_write_field(dt_iop_module_t *mod, const char *name, const double num,
                             char **err)
{
  if(!g_strcmp0(mod->op, "colorin")
     && (!g_strcmp0(name, "input_profile") || !g_strcmp0(name, "working_profile")))
    return _write_profile(mod, !strcmp(name, "working_profile"), num, err);
  if(!g_strcmp0(name, BLEND_DETAILS)) return _write_details(mod, num, err);
  if(!g_strcmp0(name, LENS_PICK) && !g_strcmp0(mod->op, "lens")) return _write_lens_pick(mod, num, err);
  return session_write_field_in(mod, mod->params, name, num, err);
}

// read from the live params, or from the defaults the image was given
gboolean session_read_field(dt_iop_module_t *mod, const char *name,
                            const gboolean from_defaults, double *num, char **err)
{
  if(!g_strcmp0(mod->op, "colorin")
     && (!g_strcmp0(name, "input_profile") || !g_strcmp0(name, "working_profile")))
    return _read_profile(mod, from_defaults, !strcmp(name, "working_profile"), num, err);
  if(!g_strcmp0(name, BLEND_DETAILS))
  {
    const dt_develop_blend_params_t *bp = from_defaults ? mod->default_blendop_params : mod->blend_params;
    *num = bp ? bp->details : 0.0;
    return TRUE;
  }
  if(!g_strcmp0(name, LENS_PICK) && !g_strcmp0(mod->op, "lens"))
  {
    dt_introspection_field_t *lf = NULL;
    const char *lens = from_defaults ? NULL : session_field_in(mod, mod->params, "lens", &lf, err);
    const char *auto_lens = from_defaults ? NULL : session_field_in(mod, mod->default_params, "lens", &lf, err);
    *num = lens && auto_lens && g_strcmp0(lens, auto_lens) ? lenses_hash(lens) : 0.0;
    return TRUE;
  }
  dt_introspection_field_t *f = NULL;
  const void *p = session_field_in(mod, from_defaults ? mod->default_params : mod->params,
                            name, &f, err);
  if(!p) return FALSE;
  switch(f->header.type)
  {
    case DT_INTROSPECTION_TYPE_FLOAT:  *num = *(const float *)p; break;
    case DT_INTROSPECTION_TYPE_DOUBLE: *num = *(const double *)p; break;
    case DT_INTROSPECTION_TYPE_INT:
    case DT_INTROSPECTION_TYPE_ENUM:   *num = *(const int *)p; break;
    case DT_INTROSPECTION_TYPE_UINT:   *num = *(const unsigned int *)p; break;
    case DT_INTROSPECTION_TYPE_BOOL:   *num = *(const gboolean *)p ? 1.0 : 0.0; break;
    default:
      *err = g_strdup_printf("'%s.%s' is not a readable scalar", mod->op, name);
      return FALSE;
  }
  return TRUE;
}

// a mask's refinements in an instance's blend parameters, from `refine`'s
// feather (px, 0-250), blur (px, 0-100), detail and contrast (-1-1); a
// missing one is left
static void _refine_into(dt_develop_blend_params_t *bp, JsonObject *refine)
{
  if(!refine) return;
  if(json_object_has_member(refine, "feather"))
    bp->feathering_radius = CLAMP(json_object_get_double_member(refine, "feather"), 0.0, 250.0);
  if(json_object_has_member(refine, "blur"))
    bp->blur_radius = CLAMP(json_object_get_double_member(refine, "blur"), 0.0, 100.0);
  if(json_object_has_member(refine, "detail"))
    bp->details = CLAMP(json_object_get_double_member(refine, "detail"), -1.0, 1.0);
  if(json_object_has_member(refine, "contrast"))
    bp->contrast = CLAMP(json_object_get_double_member(refine, "contrast"), -1.0, 1.0);
}

// with `instance`, the instance of that name (made when missing) instead
// of the first; with `mask`, the mask group of that name drives it, at
// `opacity` (0-100; negative leaves it) and with `refine` (_refine_into())
// the module a placement names: "op" is its first instance, "op#name" the
// instance so named; one not made yet is no constraint
static dt_iop_module_t *_place_target(const char *name)
{
  const char *hash = strchr(name, '#');
  if(!hash) return dt_iop_get_module_by_op_priority(_s.dev.iop, name, -1);
  gchar *op = g_strndup(name, hash - name);
  dt_iop_module_t *m = session_find_named(op, hash + 1);
  g_free(op);
  return m;
}

// move `mod` behind each of `after` (a comma-separated list, in order) that
// it runs ahead of, then ahead of `before` if it runs behind it, by the
// rules darktable's own module reordering obeys. a list keeps an instance
// behind modules that may each come last, such as the Zone System's
// placement behind both the color equalizer and the B&W conversion
static gboolean _place(dt_iop_module_t *mod, const char *after, const char *before, gboolean *moved,
                       char **err)
{
  gchar **prevs = after ? g_strsplit(after, ",", -1) : NULL;
  for(int k = 0; prevs && prevs[k]; k++)
  {
    dt_iop_module_t *prev = _place_target(prevs[k]);
    if(!prev || prev == mod || mod->iop_order > prev->iop_order) continue;
    if(!dt_ioppr_check_can_move_after_iop(_s.dev.iop, mod, prev)
       || !dt_ioppr_move_iop_after(&_s.dev, mod, prev))
    {
      *err = g_strdup_printf("cannot move '%s' after '%s'", mod->op, prevs[k]);
      g_strfreev(prevs);
      return FALSE;
    }
    *moved = TRUE;
  }
  g_strfreev(prevs);
  dt_iop_module_t *next = before ? _place_target(before) : NULL;
  if(next && next != mod && mod->iop_order > next->iop_order)
  {
    if(!dt_ioppr_check_can_move_before_iop(_s.dev.iop, mod, next)
       || !dt_ioppr_move_iop_before(&_s.dev, mod, next))
    {
      *err = g_strdup_printf("cannot move '%s' before '%s'", mod->op, before);
      return FALSE;
    }
    *moved = TRUE;
  }
  // the preview pipe's nodes follow the new order too
  if(*moved) _s.iop_gen++;
  return TRUE;
}

// the instance of `op` with multi_priority `priority`; 0 is the first
static dt_iop_module_t *_module_at(const char *op, const int priority, char **err)
{
  if(!priority) return session_module(op, err);
  dt_iop_module_t *mod = op && priority > 0 ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, priority) : NULL;
  if(!mod) *err = g_strdup_printf("module '%s' has no instance at priority %d", op ? op : "(none)", priority);
  return mod;
}

gboolean session_set(const char *op, const char *field, JsonNode *value,
                     JsonObject *params, const gboolean has_enabled,
                     const gboolean enabled, const char *after, const char *before,
                     const char *instance, const char *mask, const gboolean invert,
                     const double opacity, JsonObject *refine, const int priority, char **err)
{
  const int gen = _s.iop_gen;
  // `priority`, an instance's multi_priority as `instances` lists it, is the
  // other way to name one that exists; 0 is the first instance, as before
  if(instance && priority)
  {
    *err = g_strdup("give an instance name or a priority, not both");
    return FALSE;
  }
  // an instance placed by `after` or `before` is not also put after the
  // mask anchor, which would leave it behind modules it must precede
  dt_iop_module_t *mod = instance ? masks_named_instance(op, instance, !after && !before, err)
                                  : _module_at(op, priority, err);
  if(!mod) return FALSE;
  // kept to tell a request that changes nothing (masks_named_instance() bumps
  // iop_gen for a new instance, which always gets its history item)
  void *was = gen == _s.iop_gen && !mask ? g_malloc(mod->params_size) : NULL;
  if(was) memcpy(was, mod->params, mod->params_size);
  // and the blend params, which "blend.details" alone changes
  dt_develop_blend_params_t was_blend = { 0 };
  if(mod->blend_params) memcpy(&was_blend, mod->blend_params, sizeof(was_blend));
  const gboolean was_enabled = mod->enabled;

  gboolean moved = FALSE;
  if(!_place(mod, after, before, &moved, err)) return FALSE;

  gboolean any = FALSE;
  if(field)
  {
    const double num = value && JSON_NODE_HOLDS_VALUE(value) ? json_node_get_double(value) : 0.0;
    if(!session_write_field(mod, field, num, err)) return FALSE;
    any = TRUE;
  }
  if(params)
  {
    GList *names = json_object_get_members(params);
    for(GList *n = names; n; n = g_list_next(n))
    {
      if(!session_write_field(mod, n->data, json_object_get_double_member(params, n->data), err))
      {
        g_list_free(names);
        return FALSE;
      }
      any = TRUE;
    }
    g_list_free(names);
  }

  if(has_enabled) mod->enabled = enabled;
  else if(any) mod->enabled = TRUE;
  if(mask && !masks_attach_mask(mod, mask, invert, err)) return FALSE;
  if(mask && opacity >= 0.0) mod->blend_params->opacity = CLAMP(opacity, 0.0, 100.0);
  if(mask) _refine_into(mod->blend_params, refine);
  // a client may send a module it keeps off and at neutral alongside the
  // one doing the work, as the app does for a tool's unchosen module. an
  // item for it would split the other module's items, which darktable
  // merges only when they follow each other, and the preview pipe replays
  // every item on each render (session_ppipe_ready()); the tone equalizer's
  // commit is costly enough that its 160 px previews grew 14 -> 105 ms
  const gboolean same = was && !moved && mod->enabled == was_enabled
                        && !memcmp(was, mod->params, mod->params_size)
                        && (!mod->blend_params
                            || !memcmp(&was_blend, mod->blend_params, sizeof(was_blend)));
  g_free(was);
  if(same) return TRUE;
  // with a mask, the history item carries the shapes too
  if(mask) dt_dev_add_masks_history_item_ext(&_s.dev, mod, mod->enabled, TRUE);
  else dt_dev_add_history_item_ext(&_s.dev, mod, mod->enabled, TRUE);
  // the module a drag moves next, whose input a GPU pipe then copies back
  // to the pipe cache (patched pixelpipe_hb.c, important_input); without
  // it every GPU frame reran from the raw. no_image above leaves it unset
  if(mod->enabled) _s.dev.history_last_module = mod;

  // a new order means new pipe nodes; otherwise only the top item changed
  session_changed(moved ? DT_DEV_PIPE_REMOVE : DT_DEV_PIPE_TOP_CHANGED);
  return TRUE;
}

// an instance's whole state, params and blend params in base64, as
// `module_state` replies it and takes it back for undo
static void _module_state_json(JsonBuilder *b, const dt_iop_module_t *mod)
{
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "enabled");
  json_builder_add_boolean_value(b, mod->enabled);
  gchar *params = g_base64_encode(mod->params, mod->params_size);
  json_builder_set_member_name(b, "params");
  json_builder_add_string_value(b, params);
  g_free(params);
  gchar *blend = mod->blend_params
    ? g_base64_encode((const guchar *)mod->blend_params, sizeof(dt_develop_blend_params_t)) : NULL;
  json_builder_set_member_name(b, "blend");
  if(blend) json_builder_add_string_value(b, blend); else json_builder_add_null_value(b);
  g_free(blend);
  json_builder_end_object(b);
}

// a blob of _module_state_json() back into `dst`, if it is the right size
static gboolean _unbase64_into(const char *text, void *dst, const size_t size)
{
  if(!text) return FALSE;
  gsize len = 0;
  guchar *raw = g_base64_decode(text, &len);
  const gboolean fits = len == size;
  if(fits) memcpy(dst, raw, size);
  g_free(raw);
  return fits;
}

// darktable's module preset menu for one instance (gui/presets.c, _iop_query,
// _iop_bind, _iop_is_disabled, _iop_is_active), as `presets` in `b`: the
// rows for this photo's camera, lens and exposure, built-in ones last unless
// `modules/default_presets_first`, and the built-ins left out when
// `plugins/darkroom/hide_default_presets` is set. a name keeps its "|" levels
gboolean session_presets(const char *op, const int priority, JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = _module_at(op, priority, err);
  if(!mod) return FALSE;
  const dt_image_t *image = &_s.dev.image_storage;
  const gboolean default_first = dt_conf_get_bool("modules/default_presets_first");
  const gboolean hide_default = dt_conf_get_bool("plugins/darkroom/hide_default_presets");
  char *format_filter = dt_presets_get_filter(image);
  // clang-format off
  gchar *query = g_strdup_printf
    ("SELECT name, op_params, writeprotect, description, blendop_params, "
     "  op_version, enabled"
     " FROM data.presets"
     " WHERE operation=?1"
     "   AND (filter=0"
     "          OR"
     "       (((?2 LIKE model AND ?3 LIKE maker) OR (?4 LIKE model AND ?5 LIKE maker))"
     "        AND ?6 LIKE lens"
     "        AND ?7 BETWEEN iso_min AND iso_max"
     "        AND ?8 BETWEEN exposure_min AND exposure_max"
     "        AND ?9 BETWEEN aperture_min AND aperture_max"
     "        AND ?10 BETWEEN focal_length_min AND focal_length_max"
     "        AND (%s)))"
     " ORDER BY writeprotect %s, LOWER(name), rowid",
     format_filter, default_first ? "DESC" : "ASC");
  // clang-format on
  g_free(format_filter);
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db), query, -1, &stmt, NULL);
  g_free(query);
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 1, mod->op, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 2, image->exif_model, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 3, image->exif_maker, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 4, image->camera_alias, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 5, image->camera_maker, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 6, image->exif_lens, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_DOUBLE(stmt, 7, image->exif_iso);
  DT_DEBUG_SQLITE3_BIND_DOUBLE(stmt, 8, image->exif_exposure);
  DT_DEBUG_SQLITE3_BIND_DOUBLE(stmt, 9, image->exif_aperture);
  DT_DEBUG_SQLITE3_BIND_DOUBLE(stmt, 10, image->exif_focal_length);

  json_builder_set_member_name(b, "presets");
  json_builder_begin_array(b);
  while(sqlite3_step(stmt) == SQLITE_ROW)
  {
    const gboolean builtin = sqlite3_column_int(stmt, 2) != 0;
    if(hide_default && builtin) continue;
    const void *op_params = sqlite3_column_blob(stmt, 1);
    const int op_params_size = sqlite3_column_bytes(stmt, 1);
    const void *blend = sqlite3_column_blob(stmt, 4);
    const int blend_size = sqlite3_column_bytes(stmt, 4);
    const int enabled = sqlite3_column_int(stmt, 6);
    // darktable's own match: a preset with no params is the defaults
    const gboolean active = mod->enabled && enabled
      && (op_params_size == 0 ? !memcmp(mod->params, mod->default_params, mod->params_size)
                              : !memcmp(mod->params, op_params, MIN(op_params_size, mod->params_size)))
      && dt_presets_module_blend_match(mod, blend, blend_size);
    const char *name = (const char *)sqlite3_column_text(stmt, 0);
    const char *description = (const char *)sqlite3_column_text(stmt, 3);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, name ? name : "");
    json_builder_set_member_name(b, "description");
    json_builder_add_string_value(b, description ? description : "");
    json_builder_set_member_name(b, "builtin");
    json_builder_add_boolean_value(b, builtin);
    json_builder_set_member_name(b, "applicable");
    json_builder_add_boolean_value(b, sqlite3_column_int(stmt, 5) == mod->version());
    json_builder_set_member_name(b, "active");
    json_builder_add_boolean_value(b, active);
    json_builder_end_object(b);
  }
  sqlite3_finalize(stmt);
  json_builder_end_array(b);
  return TRUE;
}

// dt_gui_presets_apply_preset (gui/presets.c) on the session's instance: the
// preset's params (the defaults when its size does not fit), switch, blend
// params and label. darktable's version also raises GUI signals, stores the
// "last preset" and adds its history item through darktable.develop, which
// is not this engine's develop; the caller records the history item
static gboolean _apply_preset(dt_iop_module_t *mod, const char *name, char **err)
{
  if(masks_instance_owner(mod))
  {
    *err = g_strdup_printf("instance %d of '%s' belongs to %s", mod->multi_priority, mod->op,
                           masks_instance_owner(mod));
    return FALSE;
  }
  // a preset replaces the blend params, which would orphan the drawn mask
  if(mod->blend_params && dt_is_valid_maskid(mod->blend_params->mask_id))
  {
    *err = g_strdup("a preset cannot replace a drawn mask here");
    return FALSE;
  }
  sqlite3_stmt *stmt;
  // clang-format off
  DT_DEBUG_SQLITE3_PREPARE_V2(
    dt_database_get(darktable.db),
    "SELECT op_params, enabled, blendop_params, blendop_version, multi_name, multi_name_hand_edited"
    " FROM data.presets"
    " WHERE operation = ?1 AND op_version = ?2 AND name = ?3",
    -1, &stmt, NULL);
  // clang-format on
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 1, mod->op, -1, SQLITE_TRANSIENT);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, mod->version());
  DT_DEBUG_SQLITE3_BIND_TEXT(stmt, 3, name, -1, SQLITE_TRANSIENT);
  if(sqlite3_step(stmt) != SQLITE_ROW)
  {
    sqlite3_finalize(stmt);
    *err = g_strdup_printf("module '%s' has no preset '%s' for its version", mod->op, name);
    return FALSE;
  }
  const void *op_params = sqlite3_column_blob(stmt, 0);
  const int op_length = sqlite3_column_bytes(stmt, 0);
  const int enabled = sqlite3_column_int(stmt, 1);
  const void *bl_params = sqlite3_column_blob(stmt, 2);
  const int bl_length = sqlite3_column_bytes(stmt, 2);
  const int bl_version = sqlite3_column_int(stmt, 3);
  const char *multi_name = (const char *)sqlite3_column_text(stmt, 4);
  const int multi_hand = sqlite3_column_int(stmt, 5);

  // read with the mask ignored: a drawn mask's forms would be added to
  // module->dev (this engine's), and then refused below, leaving them behind
  dt_develop_blend_params_t bp;
  gboolean use_default_blend = FALSE;
#ifdef IMMAGE_STYLE_BLEND_READER
  const dt_develop_blend_params_t locked = *mod->blend_params;
  use_default_blend = dt_develop_blend_params_read(mod, bl_params, bl_length, bl_version, &bp, -1, TRUE, NULL);
#else
  if(bl_params && bl_version == dt_develop_blend_version() && bl_length == sizeof(dt_develop_blend_params_t))
    memcpy(&bp, bl_params, sizeof(bp));
  else
    use_default_blend = !bl_params
      || dt_develop_blend_legacy_params(mod, bl_params, bl_version, &bp, dt_develop_blend_version(), bl_length);
#endif
  if(!use_default_blend && ((bp.mask_mode & (DEVELOP_MASK_MASK | DEVELOP_MASK_RASTER))
                            || dt_is_valid_maskid(bp.mask_id)))
  {
    sqlite3_finalize(stmt);
    *err = g_strdup_printf("preset '%s' has a mask, which cannot be applied here yet", name);
    return FALSE;
  }

  if(op_params && op_length == mod->params_size) memcpy(mod->params, op_params, op_length);
  else memcpy(mod->params, mod->default_params, mod->params_size);
  mod->enabled = enabled;
  if(use_default_blend) dt_iop_commit_blend_params(mod, mod->default_blendop_params, NULL);
  else
  {
#ifdef IMMAGE_STYLE_BLEND_READER
    dt_develop_blend_keep_locked_mask(mod, &bp, &locked);
#endif
    dt_iop_commit_blend_params(mod, &bp, NULL);
  }
  // darktable's dt_iop_update_multi_name(), without its GUI header and its
  // own history item: a hand-edited name stays, unless auto naming is off
  if(!mod->multi_name_hand_edited && dt_conf_get_bool("darkroom/ui/auto_module_name_update"))
  {
    char *label = g_strstrip(g_strdup(multi_name && *multi_name ? multi_name : name));
    g_strlcpy(mod->multi_name, label, sizeof(mod->multi_name));
    mod->multi_name_hand_edited = multi_hand;
    g_free(label);
  }
  sqlite3_finalize(stmt);
  return TRUE;
}

// the History panel's switch and delete for one instance of the history,
// found by op and multi_priority: `enabled` switches it, `reset` puts it
// back to its defaults, on or off as darktable starts it, and `restore`
// to a state an earlier reply gave (undo). modules without a switch and
// masked modules permit reset/restore, but not an independent switch. `preset`
// applies a darktable preset by name (_apply_preset); it excludes the other three.
// replies the state before and after
gboolean session_module_state(const char *op, const int priority, const gboolean has_enabled,
                              const gboolean enabled, const gboolean reset, JsonObject *restore,
                              const char *preset, JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = op ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, priority) : NULL;
  if(!mod)
  {
    *err = g_strdup_printf("module '%s' %d not in the pipe", op ? op : "(none)", priority);
    return FALSE;
  }
  if(preset && (reset || restore || has_enabled))
  {
    *err = g_strdup("a preset cannot be combined with reset, restore or enabled");
    return FALSE;
  }
  if(!reset && !restore && !preset
     && (mod->hide_enable_button || (mod->blend_params && mod->blend_params->mask_id > 0)))
  {
    *err = g_strdup_printf("module '%s' cannot be switched here", op);
    return FALSE;
  }
  json_builder_set_member_name(b, "was");
  _module_state_json(b, mod);
  void *was = g_malloc(mod->params_size);
  memcpy(was, mod->params, mod->params_size);
  dt_develop_blend_params_t was_blend = { 0 };
  if(mod->blend_params) memcpy(&was_blend, mod->blend_params, sizeof(was_blend));
  const gboolean was_enabled = mod->enabled;
  char was_name[sizeof(mod->multi_name)];
  g_strlcpy(was_name, mod->multi_name, sizeof(was_name));
  const gboolean was_hand = mod->multi_name_hand_edited;
  if(preset)
  {
    if(!_apply_preset(mod, preset, err))
    {
      g_free(was);
      return FALSE;
    }
  }
  else if(restore)
  {
    if(!_unbase64_into(json_object_get_string_member_with_default(restore, "params", NULL),
                       mod->params, mod->params_size))
    {
      g_free(was);
      *err = g_strdup_printf("params do not fit module '%s'", op);
      return FALSE;
    }
    if(mod->blend_params)
      _unbase64_into(json_object_get_string_member_with_default(restore, "blend", NULL),
                     mod->blend_params, sizeof(dt_develop_blend_params_t));
    mod->enabled = json_object_get_boolean_member_with_default(restore, "enabled", mod->enabled);
  }
  else if(reset)
  {
    dt_iop_load_default_params(mod);
    mod->enabled = has_enabled ? enabled : mod->default_enabled;
  }
  else if(has_enabled) mod->enabled = enabled;
  const gboolean same = mod->enabled == was_enabled && !memcmp(was, mod->params, mod->params_size)
    && !strcmp(was_name, mod->multi_name) && was_hand == mod->multi_name_hand_edited
    && (!mod->blend_params || !memcmp(&was_blend, mod->blend_params, sizeof(was_blend)));
  g_free(was);
  if(!same)
  {
    dt_dev_add_history_item_ext(&_s.dev, mod, mod->enabled, TRUE);
    session_changed(DT_DEV_PIPE_TOP_CHANGED);
  }
  json_builder_set_member_name(b, "now");
  _module_state_json(b, mod);
  return TRUE;
}

// a frame's identity for the client: darktable's hash of the pipe, and
// every shape of the edit (drawn masks, spots). darktable takes a piece's
// mask shapes from darktable.develop (imageop.c, dt_iop_commit_params),
// which is not this engine's develop, so its hash alone stays the same
// when a mask is reshaped, and `have` would hand back the frame from before.
// the soft proof is in no params either (print_proof_hash)
dt_hash_t session_frame_hash(const dt_hash_t pipe_hash)
{
  dt_hash_t hash = print_proof_hash(pipe_hash);
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
    hash = dt_masks_group_hash_ext(hash, l->data, _s.dev.forms);
  return hash;
}

static gboolean _preview_output_sink(void *user, const uint8_t *pixels, int w, int h);

// darktable checks a pipe's cache against its limit only when the next run
// starts (pixelpipe_hb.c, dt_dev_pixelpipe_process), so a pipe keeps what its
// last run needed until then: a base pipe holds about 2 GB after a 16
// megapixel frame against a limit of a few hundred MB. called once the frame
// is out of the backbuf and any device is released. the newest line, which
// is the backbuf, is never evicted (pixelpipe_cache.c, _get_oldest_cacheline)
//
// the base and check pipes keep only their two newest important lines (the
// ones a repeat render can reuse): checkmem evicts only lines aged past 1,
// and important ones stay negative, so a 50 megapixel base pipe piled up one
// ~800 MB line per edit. an important line's age is `used` counting up from
// -entries, so the two most negative are the newest; older ones are demoted
// to 2 for checkmem to take
void session_settle(dt_dev_pixelpipe_t *pipe)
{
  if(pipe == &_s.base.pipe || pipe == &_s.check.pipe)
  {
    dt_dev_pixelpipe_cache_t *cache = &pipe->cache;
    int keep[2] = { -1, -1 };
    for(int k = DT_PIPECACHE_MIN; k < cache->entries; k++)
    {
      if(cache->used[k] >= 0) continue;
      if(keep[0] < 0 || cache->used[k] < cache->used[keep[0]])
      {
        if(keep[1] >= 0) cache->used[keep[1]] = 2;
        keep[1] = keep[0];
        keep[0] = k;
      }
      else if(keep[1] < 0 || cache->used[k] < cache->used[keep[1]])
      {
        if(keep[1] >= 0) cache->used[keep[1]] = 2;
        keep[1] = k;
      }
      else cache->used[k] = 2;
    }
  }
  dt_dev_pixelpipe_cache_checkmem(pipe, FALSE);
}

// Process byte pixels into the optional output sink or the pipe's backbuf.
// with scale <= 0, fit the whole image into bw x bh. otherwise render the
// bw x bh window at (x, y) of the image scaled by `scale` (1 is 100%), the
// way the darkroom's zoomed view does; the window is clipped to the image
// `have`: hashes of frames the client holds (hex). when this view's frame
// would be one of them, it is not rendered: *kept is set to that hash
gboolean session_render(dt_dev_pixelpipe_t *pipe, const int devid, const int bw, const int bh,
                        const double req_scale, const int x, const int y, JsonArray *have,
                        int *ow, int *oh, int *ox_out, int *oy_out, dt_hash_t *kept, preview_output_t *output, char **err)
{
  *kept = DT_INVALID_HASH;
  double scale = req_scale;
  int w, h, ox = 0, oy = 0;
  if(scale <= 0.0)
  {
    const double sx = bw > 0 ? (double)bw / pipe->processed_width : 1.0;
    const double sy = bh > 0 ? (double)bh / pipe->processed_height : 1.0;
    scale = fmin(1.0, fmin(sx, sy));
    w = floor(scale * pipe->processed_width);
    h = floor(scale * pipe->processed_height);
  }
  else
  {
    const int sw = floor(scale * pipe->processed_width);
    const int sh = floor(scale * pipe->processed_height);
    w = MIN(bw, sw);
    h = MIN(bh, sh);
    ox = CLAMP(x, 0, sw - w);
    oy = CLAMP(y, 0, sh - h);
  }

  if(have && json_array_get_length(have))
  {
    // the hash dt_dev_pixelpipe_process() gives its backbuf (pixelpipe_hb.c),
    // from the pieces' hashes, which the pipe's sync has brought current.
    // the same hash is darktable's own test for reusing a cacheline. the
    // edit's shapes go in as for the frames it sends (session_frame_hash)
    const dt_iop_roi_t roi = { ox, oy, w, h, (float)scale };
    const dt_hash_t hash = session_frame_hash(dt_dev_pixelpipe_cache_hash(&roi, pipe, g_list_length(pipe->iop)));
    gchar *hex = g_strdup_printf("%016" PRIx64, hash);
    for(guint k = 0; k < json_array_get_length(have); k++)
      if(!g_strcmp0(json_array_get_string_element(have, k), hex)) *kept = hash;
    g_free(hex);
    if(*kept != DT_INVALID_HASH)
    {
      *ow = w;
      *oh = h;
      *ox_out = ox;
      *oy_out = oy;
      return TRUE;
    }
  }
  pipe->output_sink = output ? _preview_output_sink : NULL;
  pipe->output_sink_user = output;
  const gboolean failed = dt_dev_pixelpipe_process(pipe, &_s.dev, ox, oy, w, h, scale, devid);
  pipe->output_sink = NULL;
  pipe->output_sink_user = NULL;
  if(failed || (output ? !output->completed : !pipe->backbuf))
  {
    *err = g_strdup("pixelpipe processing failed or was interrupted");
    return FALSE;
  }
  *ow = pipe->backbuf_width;
  *oh = pipe->backbuf_height;
  *ox_out = ox;
  *oy_out = oy;
  return TRUE;
}

// the backbuf is 8-bit in display byte order (BGRA), as the export path keeps it
gboolean session_write_ppm(const char *path, const uint8_t *in, const int w, const int h)
{
  FILE *f = g_fopen(path, "wb");
  if(!f) return FALSE;
  fprintf(f, "P6\n%d %d\n255\n", w, h);
  uint8_t *row = g_malloc((size_t)3 * w);
  for(int j = 0; j < h; j++)
  {
    for(int i = 0; i < w; i++)
    {
      const uint8_t *px = in + 4 * ((size_t)j * w + i);
      row[3 * i + 0] = px[2];
      row[3 * i + 1] = px[1];
      row[3 * i + 2] = px[0];
    }
    fwrite(row, 1, (size_t)3 * w, f);
  }
  g_free(row);
  fclose(f);
  return TRUE;
}

// rgba_output.h opens macOS shared frames through transient_output.h, whose
// state main.c owns
#define transient_shared_open engine_transient_shared_open
#include "rgba_output.h"
#undef transient_shared_open

// headerless RGBA, ready for a canvas ImageData; the size is in the reply.
// written over the file in place: g_file_set_contents() would write a
// temporary file, sync it and rename it, for every frame of a slider drag.
// the client reads it while the engine is still its own, so no half-written
// frame is ever read
gboolean session_write_rgba(const char *path, const uint8_t *in, const int w, const int h, double *timings)
{
  const gint64 started = g_get_monotonic_time();
  if(w <= 0 || h <= 0 || (size_t)w > SIZE_MAX / 4 / (size_t)h) return FALSE;
  const size_t n = (size_t)w * h;
#ifdef _WIN32
  // The CLI can still request an ordinary RGBA file; app output is mapped.
  const gboolean mapped = g_str_has_prefix(path, "shm:");
  uint8_t *rgba = mapped ? rgba_output_acquire(path, 4 * n) : g_try_malloc(4 * n);
#else
  const gboolean mapped = TRUE;
  uint8_t *rgba = rgba_output_acquire(path, 4 * n);
#endif
  if(!rgba) return FALSE;
  const gint64 allocated = g_get_monotonic_time();
  DT_OMP_FOR()
  for(size_t k = 0; k < n; k++)
  {
    rgba[4 * k + 0] = in[4 * k + 2];
    rgba[4 * k + 1] = in[4 * k + 1];
    rgba[4 * k + 2] = in[4 * k + 0];
    rgba[4 * k + 3] = 255;
  }
  const gint64 converted = g_get_monotonic_time();
  // MAP_SHARED writes are visible before the JSON completion reply. No file
  // write, flush, or intermediate RGBA allocation is needed for mapped output.
  gboolean ok = mapped || engine_transient_write(path, rgba, 4 * n, NULL, 0);
  const gint64 written = g_get_monotonic_time();
  if(!mapped) g_free(rgba);
  const gint64 freed = g_get_monotonic_time();
  if(timings)
  {
    timings[0] = (allocated - started) / 1000.0;
    timings[1] = (converted - allocated) / 1000.0;
    timings[2] = (written - converted) / 1000.0;
    timings[3] = (freed - written) / 1000.0;
  }
  return ok;
}

static gboolean _preview_output_sink(void *user, const uint8_t *pixels, int w, int h)
{
  preview_output_t *output = user;
  const gint64 started = g_get_monotonic_time();
  output->completed = session_write_rgba(output->path, pixels, w, h, output->timings);
  output->elapsed_ms = engine_ms_since(started);
  return output->completed;
}

// { op: [field, ...] } ->
//   { op: { enabled, default_enabled, params: { field: value }, defaults: { ... } } }
// the instance of `op` named `name`, if there is one
dt_iop_module_t *session_find_named(const char *op, const char *name)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(!g_strcmp0(m->op, op) && m->multi_name_hand_edited && !g_strcmp0(m->multi_name, name)) return m;
  }
  return NULL;
}

// a key "op#name" reads the instance so named; one not made yet reads as
// the first instance's defaults, switched off. a key "op@N" reads the
// instance whose multi_priority is N (as `instances` lists it, and as `set`
// takes `priority`), an error when there is none; "op" is the first one
gboolean session_get(JsonObject *ops, JsonBuilder *b, char **err)
{
  json_builder_set_member_name(b, "modules");
  json_builder_begin_object(b);
  GList *names = json_object_get_members(ops);
  for(GList *n = names; n; n = g_list_next(n))
  {
    const char *key = n->data, *mark = strpbrk(key, "#@");
    const gboolean by_name = mark && *mark == '#';
    gchar *op = mark ? g_strndup(key, mark - key) : g_strdup(key);
    dt_iop_module_t *named = by_name ? session_find_named(op, mark + 1) : NULL;
    dt_iop_module_t *mod = named ? named
      : mark && !by_name ? _module_at(op, atoi(mark + 1), err) : session_module(op, err);
    g_free(op);
    if(!mod) { g_list_free(names); return FALSE; }
    const gboolean missing = by_name && !named;
    json_builder_set_member_name(b, n->data);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "enabled");
    json_builder_add_boolean_value(b, missing ? FALSE : mod->enabled);
    json_builder_set_member_name(b, "default_enabled");
    json_builder_add_boolean_value(b, mod->default_enabled);
    JsonArray *fields = json_object_get_array_member(ops, n->data);
    for(int pass = 0; pass < 2; pass++)
    {
      json_builder_set_member_name(b, pass ? "defaults" : "params");
      json_builder_begin_object(b);
      for(guint i = 0; fields && i < json_array_get_length(fields); i++)
      {
        const char *name = json_array_get_string_element(fields, i);
        double num = 0.0;
        if(!session_read_field(mod, name, pass || missing, &num, err)) { g_list_free(names); return FALSE; }
        json_builder_set_member_name(b, name);
        json_builder_add_double_value(b, num);
      }
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
  }
  g_list_free(names);
  json_builder_end_object(b);
  return TRUE;
}

// `instances`: the open photo's modules in pipe order, one entry per
// instance. `priority` is its multi_priority, which `set` and `get` address
// it by; `name` is the user's label for it ("" when it has none); `owner`
// names the Immage tool that manages it (a mask's own, a shared or a look's
// instance, masks_instance_owner()), null for the user's own, so a client
// can leave the others to their tools
void session_instances(JsonBuilder *b)
{
  json_builder_set_member_name(b, "instances");
  json_builder_begin_array(b);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(g_list_find(_s.deleted, m)) continue;
    json_builder_begin_object(b);
    engine_add_string(b, "op", m->op);
    engine_add_int(b, "priority", m->multi_priority);
    engine_add_string(b, "name", m->multi_name_hand_edited ? m->multi_name : "");
    engine_add_bool(b, "hand_edited", m->multi_name_hand_edited);
    // what darktable's module header shows after the module's name: the
    // user's label, else darktable's own (a matching preset's, or a later
    // instance's number), translated as session_history_item() does
    const gboolean labeled = m->multi_name[0] && g_strcmp0(m->multi_name, "0");
    gchar *label = !labeled ? g_strdup("") : m->multi_name_hand_edited ? g_strdup(m->multi_name)
                   : dt_util_localize_segmented_name(m->multi_name, FALSE);
    engine_add_string(b, "label", label);
    g_free(label);
    engine_add_bool(b, "enabled", m->enabled);
    engine_add_bool(b, "default_enabled", m->default_enabled);
    // darktable hides the switch of a module that cannot apply to this
    // photo (raw-only modules on a JPEG, white balance on a monochrome)
    engine_add_bool(b, "switchable", !m->hide_enable_button);
    // the history, up to its end, has an entry for it: Advanced shows a
    // card for a module the user once changed, switched off or not
    gboolean in_history = FALSE;
    int n = 0;
    for(const GList *h = _s.dev.history; h && n < _s.dev.history_end && !in_history; h = g_list_next(h), n++)
      in_history = ((const dt_dev_history_item_t *)h->data)->module == m;
    engine_add_bool(b, "in_history", in_history);
    engine_add_int(b, "iop_order", m->iop_order);
    const char *owner = masks_instance_owner(m);
    json_builder_set_member_name(b, "owner");
    if(owner) json_builder_add_string_value(b, owner); else json_builder_add_null_value(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
}

// a history item for `m` as it stands, and the pipes told: `structure` when
// the instance list or order changed, which every pipe rebuilds its nodes for
static void _instance_changed(dt_iop_module_t *m, const gboolean structure)
{
  dt_dev_add_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  if(structure) _s.iop_gen++;
  session_changed(structure ? DT_DEV_PIPE_REMOVE : DT_DEV_PIPE_TOP_CHANGED);
}

// `instance`: Advanced mode's instance menu, darktable's multi-instance
// actions (imageop.c, _gui_copy_callback and its neighbours) without its GUI.
//   "new": a new instance after instance `priority`, at the defaults, on
//   "duplicate": the same with that instance's settings
//   "rename": `name` as its label; "" goes back to darktable's number
//   "move": next to the instance at priority `other` of the same module,
//     after it when `after`, else before
//   "delete": switched off and gone from `instances`; the next save drops
//     its entries. the first instance is the one Simple's tools drive and
//     darktable renumbers when it goes, so it is switched off instead
//   "restore": a deleted instance back (undo), as it was when deleted
// an Immage tool's own instance (masks_instance_owner()) is left to it.
// the reply has the instance's `priority` and the new `instances` list
gboolean session_instance(const char *action, const char *op, const int priority, const char *name,
                          const int other, const gboolean after, JsonBuilder *b, char **err)
{
  if(!action || !op)
  {
    *err = g_strdup("instance needs an action and an op");
    return FALSE;
  }
  const gboolean restore = !g_strcmp0(action, "restore");
  dt_iop_module_t *mod = _module_at(op, priority, err);
  if(!mod) return FALSE;
  GList *gone = g_list_find(_s.deleted, mod);
  if((gone != NULL) != restore)
  {
    *err = g_strdup_printf("instance %d of '%s' is %s", priority, op, gone ? "deleted" : "not deleted");
    return FALSE;
  }
  if(masks_instance_owner(mod))
  {
    *err = g_strdup_printf("instance %d of '%s' belongs to %s", priority, op, masks_instance_owner(mod));
    return FALSE;
  }
  dt_iop_module_t *result = mod;
  const gboolean copy = !g_strcmp0(action, "duplicate");
  if(copy || !g_strcmp0(action, "new"))
  {
    if(mod->flags() & IOP_FLAGS_ONE_INSTANCE)
    {
      *err = g_strdup_printf("'%s' allows one instance", op);
      return FALSE;
    }
    // darktable shares a drawn mask's shapes with the copy through its GUI's
    // develop (masks.c, dt_masks_iop_use_same_as), which is not the engine's
    if(copy && mod->blend_params && dt_is_valid_maskid(mod->blend_params->mask_id))
    {
      *err = g_strdup("an instance with a drawn mask cannot be duplicated here yet");
      return FALSE;
    }
    dt_iop_module_t *m = dt_dev_module_duplicate_ext(&_s.dev, mod, TRUE);
    if(!m)
    {
      *err = g_strdup_printf("cannot add an instance of '%s'", op);
      return FALSE;
    }
    // as dt_iop_gui_duplicate(): the image's defaults (denoise's noise
    // profile) come from reload_defaults, which duplicating does not run
    dt_iop_reload_defaults(m);
    memcpy(m->params, copy ? mod->params : m->default_params, m->params_size);
    if(m->blend_params)
      memcpy(m->blend_params, copy ? mod->blend_params : m->default_blendop_params,
             sizeof(dt_develop_blend_params_t));
    m->enabled = TRUE;
    _instance_changed(m, TRUE);
    result = m;
  }
  else if(!g_strcmp0(action, "rename"))
  {
    gchar *label = g_strstrip(g_strdup(name ? name : ""));
    char was[sizeof(mod->multi_name)];
    g_strlcpy(was, mod->multi_name, sizeof(was));
    const gboolean was_hand = mod->multi_name_hand_edited;
    // an empty name is darktable's own again (develop.c, the history item's
    // automatic name): the instance's number, none for the first
    if(*label) g_strlcpy(mod->multi_name, label, sizeof(mod->multi_name));
    else if(mod->multi_priority > 0) g_snprintf(mod->multi_name, sizeof(mod->multi_name), "%d", mod->multi_priority);
    else mod->multi_name[0] = '\0';
    mod->multi_name_hand_edited = *label != '\0';
    g_free(label);
    // a name Immage's masks or looks use would hand the instance to them
    if(masks_instance_owner(mod))
    {
      g_strlcpy(mod->multi_name, was, sizeof(mod->multi_name));
      mod->multi_name_hand_edited = was_hand;
      *err = g_strdup("that name is one Immage keeps for masks and looks");
      return FALSE;
    }
    if(g_strcmp0(was, mod->multi_name) || was_hand != mod->multi_name_hand_edited)
      _instance_changed(mod, FALSE);
  }
  else if(!g_strcmp0(action, "move"))
  {
    dt_iop_module_t *to = _module_at(op, other, err);
    if(!to) return FALSE;
    if(to == mod || g_list_find(_s.deleted, to))
    {
      *err = g_strdup_printf("cannot move instance %d of '%s' next to instance %d", priority, op, other);
      return FALSE;
    }
    const gboolean there = after ? mod->iop_order > to->iop_order : mod->iop_order < to->iop_order;
    // already next to it on that side when no other instance of `op` is
    // between: dt_ioppr_move_iop_after() refuses a module it already follows
    gboolean between = FALSE;
    for(GList *l = _s.dev.iop; there && l; l = g_list_next(l))
    {
      const dt_iop_module_t *s = l->data;
      if(s == mod || s == to || g_strcmp0(s->op, op)) continue;
      const int lo = MIN(mod->iop_order, to->iop_order), hi = MAX(mod->iop_order, to->iop_order);
      if(s->iop_order > lo && s->iop_order < hi) between = TRUE;
    }
    if(!there || between)
    {
      const gboolean can = after ? dt_ioppr_check_can_move_after_iop(_s.dev.iop, mod, to)
                                 : dt_ioppr_check_can_move_before_iop(_s.dev.iop, mod, to);
      if(!can || !(after ? dt_ioppr_move_iop_after(&_s.dev, mod, to) : dt_ioppr_move_iop_before(&_s.dev, mod, to)))
      {
        *err = g_strdup_printf("cannot move instance %d of '%s' %s instance %d", priority, op,
                               after ? "after" : "before", other);
        return FALSE;
      }
      _instance_changed(mod, TRUE);
    }
  }
  else if(!g_strcmp0(action, "delete"))
  {
    if(priority == 0)
    {
      *err = g_strdup_printf("the first instance of '%s' can be switched off, not deleted", op);
      return FALSE;
    }
    mod->enabled = FALSE;
    _s.deleted = g_list_prepend(_s.deleted, mod);
    _instance_changed(mod, FALSE);
  }
  else if(restore)
  {
    // its settings are back with the client's own `set`, as undo sends them
    _s.deleted = g_list_delete_link(_s.deleted, gone);
  }
  else
  {
    *err = g_strdup_printf("unknown instance action '%s'", action);
    return FALSE;
  }
  engine_add_int(b, "priority", result->multi_priority);
  session_instances(b);
  return TRUE;
}

static const char *_type_name(const dt_introspection_type_t t)
{
  switch(t)
  {
    case DT_INTROSPECTION_TYPE_FLOAT:        return "float";
    case DT_INTROSPECTION_TYPE_DOUBLE:       return "double";
    case DT_INTROSPECTION_TYPE_FLOATCOMPLEX: return "complex";
    case DT_INTROSPECTION_TYPE_CHAR:         return "char";
    case DT_INTROSPECTION_TYPE_INT8:         return "int8";
    case DT_INTROSPECTION_TYPE_UINT8:        return "uint8";
    case DT_INTROSPECTION_TYPE_SHORT:        return "short";
    case DT_INTROSPECTION_TYPE_USHORT:       return "ushort";
    case DT_INTROSPECTION_TYPE_INT:          return "int";
    case DT_INTROSPECTION_TYPE_UINT:         return "uint";
    case DT_INTROSPECTION_TYPE_LONG:         return "long";
    case DT_INTROSPECTION_TYPE_ULONG:        return "ulong";
    case DT_INTROSPECTION_TYPE_BOOL:         return "bool";
    case DT_INTROSPECTION_TYPE_ARRAY:        return "array";
    case DT_INTROSPECTION_TYPE_ENUM:         return "enum";
    case DT_INTROSPECTION_TYPE_STRUCT:       return "struct";
    case DT_INTROSPECTION_TYPE_UNION:        return "union";
    default:                                 return "opaque";
  }
}

// a bound as a number, null for the type's own limit, which a field without
// a declared range gets
static void _add_bound(JsonBuilder *b, const char *name, const double v)
{
  json_builder_set_member_name(b, name);
  if(fabs(v) >= 2147483647.0) json_builder_add_null_value(b);
  else json_builder_add_double_value(b, v);
}

// min and max of a scalar field
static void _add_range(JsonBuilder *b, const dt_introspection_field_t *f)
{
  double lo = 0.0, hi = 0.0;
  switch(f->header.type)
  {
    case DT_INTROSPECTION_TYPE_FLOAT:  lo = f->Float.Min;  hi = f->Float.Max;  break;
    case DT_INTROSPECTION_TYPE_DOUBLE: lo = f->Double.Min; hi = f->Double.Max; break;
    case DT_INTROSPECTION_TYPE_CHAR:   lo = f->Char.Min;   hi = f->Char.Max;   break;
    case DT_INTROSPECTION_TYPE_INT8:   lo = f->Int8.Min;   hi = f->Int8.Max;   break;
    case DT_INTROSPECTION_TYPE_UINT8:  lo = f->UInt8.Min;  hi = f->UInt8.Max;  break;
    case DT_INTROSPECTION_TYPE_SHORT:  lo = f->Short.Min;  hi = f->Short.Max;  break;
    case DT_INTROSPECTION_TYPE_USHORT: lo = f->UShort.Min; hi = f->UShort.Max; break;
    case DT_INTROSPECTION_TYPE_INT:    lo = f->Int.Min;    hi = f->Int.Max;    break;
    case DT_INTROSPECTION_TYPE_UINT:   lo = f->UInt.Min;   hi = f->UInt.Max;   break;
    case DT_INTROSPECTION_TYPE_LONG:   lo = f->Long.Min;   hi = f->Long.Max;   break;
    case DT_INTROSPECTION_TYPE_ULONG:  lo = f->ULong.Min;  hi = f->ULong.Max;  break;
    default: return;
  }
  _add_bound(b, "min", lo);
  _add_bound(b, "max", hi);
}

static gboolean _is_number(const dt_introspection_type_t t)
{
  return t == DT_INTROSPECTION_TYPE_FLOAT || t == DT_INTROSPECTION_TYPE_DOUBLE
         || t == DT_INTROSPECTION_TYPE_CHAR || t == DT_INTROSPECTION_TYPE_INT8
         || t == DT_INTROSPECTION_TYPE_UINT8 || t == DT_INTROSPECTION_TYPE_SHORT
         || t == DT_INTROSPECTION_TYPE_USHORT || t == DT_INTROSPECTION_TYPE_INT
         || t == DT_INTROSPECTION_TYPE_UINT || t == DT_INTROSPECTION_TYPE_LONG
         || t == DT_INTROSPECTION_TYPE_ULONG || t == DT_INTROSPECTION_TYPE_BOOL
         || t == DT_INTROSPECTION_TYPE_ENUM;
}

// the default of each number member of struct `f` at `path`, as members of
// the open object keyed by the member path relative to the struct; members
// that are arrays or strings are left out, as they are in `defaults` of a
// number array above 64 elements
static void _struct_defaults(JsonBuilder *b, dt_iop_module_t *mod, const dt_introspection_field_t *f,
                             const char *path)
{
  for(size_t i = 0; i < f->Struct.entries; i++)
  {
    const dt_introspection_field_t *c = f->Struct.fields[i];
    gchar *sub = g_strdup_printf("%s.%s", path, c->header.field_name);
    if(c->header.type == DT_INTROSPECTION_TYPE_STRUCT)
      _struct_defaults(b, mod, c, sub);
    else if(_is_number(c->header.type))
    {
      char *err = NULL;
      double num = 0.0;
      // keyed relative to the element, the same paths `members` lists
      json_builder_set_member_name(b, sub + strlen(path) + 1);
      if(session_read_field(mod, sub, TRUE, &num, &err)) json_builder_add_double_value(b, num);
      else json_builder_add_null_value(b);
      g_free(err);
    }
    g_free(sub);
  }
}

// the fields under `f`, as one object per leaf, in the order of the struct.
// `prefix` is the path so far: the leaf "exposure" of exposure's params, or
// "tonecurve_nodes[0]" and so on for a client that walks an array. an array
// is one entry that gives `dims` (nested arrays outermost first) and its
// `element`, never one entry per element; an array of structs also lists
// `members` with paths relative to an element ("x" of "curve[1][3].x"). a
// number array of up to 64 elements has its defaults, read by
// session_read_field() (what `get` returns), and an array of up to 64 structs
// has `member_defaults` as one object per element, in row-major order, keyed by the
// number members' relative paths; a char array is a "string"
static void _schema_fields(JsonBuilder *b, dt_iop_module_t *mod, const dt_introspection_field_t *f,
                           const char *prefix)
{
  if(f->header.type == DT_INTROSPECTION_TYPE_STRUCT)
  {
    for(size_t i = 0; i < f->Struct.entries; i++)
    {
      const dt_introspection_field_t *c = f->Struct.fields[i];
      gchar *path = *prefix ? g_strdup_printf("%s.%s", prefix, c->header.field_name)
                            : g_strdup(c->header.field_name);
      _schema_fields(b, mod, c, path);
      g_free(path);
    }
    return;
  }

  json_builder_begin_object(b);
  engine_add_string(b, "path", prefix);
  const dt_introspection_type_t t = f->header.type;
  if(t == DT_INTROSPECTION_TYPE_ARRAY)
  {
    const dt_introspection_field_t *e = f;
    json_builder_set_member_name(b, "dims");
    json_builder_begin_array(b);
    size_t total = 1;
    while(e->header.type == DT_INTROSPECTION_TYPE_ARRAY)
    {
      json_builder_add_int_value(b, e->Array.count);
      total *= e->Array.count;
      e = e->Array.field;
    }
    json_builder_end_array(b);
    const gboolean text = f->Array.type == DT_INTROSPECTION_TYPE_CHAR;
    engine_add_string(b, "type", text ? "string" : "array");
    engine_add_string(b, "element", _type_name(e->header.type));
    if(f->header.description) engine_add_string(b, "description", f->header.description);
    if(_is_number(e->header.type) && !text)
    {
      _add_range(b, e);
      if(e->header.type == DT_INTROSPECTION_TYPE_ENUM) engine_add_string(b, "enum_type", e->header.type_name);
      if(f->Array.field == e && total <= 64)
      {
        json_builder_set_member_name(b, "defaults");
        json_builder_begin_array(b);
        for(size_t i = 0; i < total; i++)
        {
          gchar *path = g_strdup_printf("%s[%zu]", prefix, i);
          char *err = NULL;
          double num = 0.0;
          if(session_read_field(mod, path, TRUE, &num, &err)) json_builder_add_double_value(b, num);
          else json_builder_add_null_value(b);
          g_free(err);
          g_free(path);
        }
        json_builder_end_array(b);
      }
    }
    if(e->header.type == DT_INTROSPECTION_TYPE_STRUCT)
    {
      if(total <= 64)
      {
        json_builder_set_member_name(b, "member_defaults");
        json_builder_begin_array(b);
        for(size_t i = 0; i < total; i++)
        {
          // row-major index list, so "curve[1][3]" as session_read_field() takes it
          gchar *path = g_strdup(prefix);
          size_t rest = total;
          for(const dt_introspection_field_t *d = f; d->header.type == DT_INTROSPECTION_TYPE_ARRAY;
              d = d->Array.field)
          {
            rest /= d->Array.count;
            gchar *next = g_strdup_printf("%s[%zu]", path, (i / rest) % d->Array.count);
            g_free(path);
            path = next;
          }
          json_builder_begin_object(b);
          _struct_defaults(b, mod, e, path);
          json_builder_end_object(b);
          g_free(path);
        }
        json_builder_end_array(b);
      }
      json_builder_set_member_name(b, "members");
      json_builder_begin_array(b);
      _schema_fields(b, mod, e, "");
      json_builder_end_array(b);
    }
    json_builder_end_object(b);
    return;
  }

  engine_add_string(b, "type", _type_name(t));
  if(f->header.description) engine_add_string(b, "description", f->header.description);
  if(_is_number(t))
  {
    _add_range(b, f);
    char *err = NULL;
    double num = 0.0;
    json_builder_set_member_name(b, "default");
    if(*prefix && session_read_field(mod, prefix, TRUE, &num, &err)) json_builder_add_double_value(b, num);
    else json_builder_add_null_value(b);
    g_free(err);
  }
  if(t == DT_INTROSPECTION_TYPE_ENUM)
  {
    engine_add_string(b, "enum_type", f->header.type_name);
    json_builder_set_member_name(b, "values");
    json_builder_begin_array(b);
    for(size_t i = 0; i < f->Enum.entries; i++)
    {
      const dt_introspection_type_enum_tuple_t *v = &f->Enum.values[i];
      json_builder_begin_object(b);
      engine_add_string(b, "name", v->name);
      engine_add_int(b, "value", v->value);
      if(v->description) engine_add_string(b, "description", v->description);
      json_builder_end_object(b);
    }
    json_builder_end_array(b);
  }
  json_builder_end_object(b);
}

static const struct { int bit; const char *name; } _GROUPS[] =
{
  { IOP_GROUP_BASIC, "basic" }, { IOP_GROUP_TONE, "tone" }, { IOP_GROUP_COLOR, "color" },
  { IOP_GROUP_CORRECT, "correct" }, { IOP_GROUP_EFFECT, "effect" },
  { IOP_GROUP_TECHNICAL, "technical" }, { IOP_GROUP_GRADING, "grading" },
  { IOP_GROUP_EFFECTS, "effects" },
};

// `module_schema {op}`: what darktable's introspection says of a module, so
// a client can draw its parameters without a map of its own. it needs an
// open photo, and the module in its pipe (any instance: the layout is the
// module's, the `default` values are that instance's default_params, which
// for a few modules depend on the photo, as denoise's noise profile does); a
// module with no introspection (liquify) replies `fields: []`. `fields` are
// the params' leaves in struct order, each with the `path` `set` and `get`
// take: `type` (float, int, uint, bool, enum, string, array, ...), `min` and
// `max` (null: unbounded), `default`, `description` (darktable's $DESCRIPTION
// comment) and, for an enum, its `values` ({ name, value, description }).
// see _schema_fields() for arrays. `version` is the params' version,
// `groups` the default module groups (darktable's names), `flags` the
// module's
gboolean session_module_schema(const char *op, JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = op ? dt_iop_get_module_by_op_priority(_s.dev.iop, op, -1) : NULL;
  if(!mod)
  {
    *err = g_strdup_printf("module '%s' not in the pipe", op ? op : "(none)");
    return FALSE;
  }
  const int flags = mod->flags();
  engine_add_string(b, "op", mod->op);
  engine_add_string(b, "name", dt_iop_get_localized_name(mod->op));
  engine_add_int(b, "version", mod->version());
  engine_add_int(b, "params_size", mod->params_size);
  json_builder_set_member_name(b, "groups");
  json_builder_begin_array(b);
  const int groups = mod->default_group();
  for(guint i = 0; i < G_N_ELEMENTS(_GROUPS); i++)
    if(groups & _GROUPS[i].bit) json_builder_add_string_value(b, _GROUPS[i].name);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "flags");
  json_builder_begin_object(b);
  engine_add_bool(b, "one_instance", flags & IOP_FLAGS_ONE_INSTANCE);
  engine_add_bool(b, "deprecated", flags & IOP_FLAGS_DEPRECATED);
  engine_add_bool(b, "hidden", flags & IOP_FLAGS_HIDDEN);
  engine_add_bool(b, "supports_blending", flags & IOP_FLAGS_SUPPORTS_BLENDING);
  engine_add_bool(b, "no_masks", flags & IOP_FLAGS_NO_MASKS);
  engine_add_bool(b, "no_history", flags & IOP_FLAGS_NO_HISTORY_STACK);
  engine_add_bool(b, "no_switch", mod->hide_enable_button);
  json_builder_end_object(b);
  json_builder_set_member_name(b, "fields");
  json_builder_begin_array(b);
  const dt_introspection_t *intro = mod->so->have_introspection ? mod->get_introspection() : NULL;
  if(intro && intro->field) _schema_fields(b, mod, intro->field, "");
  json_builder_end_array(b);
  return TRUE;
}

typedef struct { JsonBuilder *b; GHashTable *seen; } _lens_menu_t;

static void _lens_menu_add(const char *maker, const char *model, void *user)
{
  _lens_menu_t *m = user;
  if(!model || !*model || g_hash_table_contains(m->seen, model)) return;
  g_hash_table_add(m->seen, g_strdup(model));
  json_builder_begin_object(m->b);
  engine_add_string(m->b, "name", model);
  engine_add_string(m->b, "maker", maker);
  json_builder_set_member_name(m->b, "hash");
  json_builder_add_int_value(m->b, lenses_hash(model));
  json_builder_end_object(m->b);
}

gboolean session_lens_menu(JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = session_module("lens", err);
  if(!mod) return FALSE;
  dt_introspection_field_t *f = NULL;
  const char *lens = session_field_in(mod, mod->params, "lens", &f, err);
  const char *auto_lens = lens ? session_field_in(mod, mod->default_params, "lens", &f, err) : NULL;
  if(!lens || !auto_lens) return FALSE;
  // the database's name for the lens the file names, as the module matches it
  const dt_image_t *img = &_s.dev.image_storage;
  char matched[128];
  g_strlcpy(matched, auto_lens, sizeof matched);
  lenses_match(img->exif_maker, img->exif_model, auto_lens, matched, sizeof matched);
  engine_add_string(b, "auto", matched);
  double pick = 0.0;
  if(!session_read_field(mod, LENS_PICK, FALSE, &pick, err)) return FALSE;
  json_builder_set_member_name(b, "pick");
  json_builder_add_int_value(b, (gint64)pick);
  json_builder_set_member_name(b, "lenses");
  json_builder_begin_array(b);
  _lens_menu_t m = { b, g_hash_table_new_full(g_str_hash, g_str_equal, g_free, NULL) };
  lenses_list(img->exif_maker, img->exif_model, _lens_menu_add, &m);
  // a lens kept from another camera's edit, or the matched one, is listed
  if(*lens && g_strcmp0(lens, auto_lens)) _lens_menu_add("", lens, &m);
  if(*matched) _lens_menu_add("", matched, &m);
  g_hash_table_destroy(m.seen);
  json_builder_end_array(b);
  return TRUE;
}

static void _profile_option(JsonBuilder *b, const char *label, const guint64 id)
{
  json_builder_begin_array(b);
  json_builder_add_string_value(b, label);
  json_builder_add_int_value(b, id);
  json_builder_end_array(b);
}

gboolean session_color_profiles(JsonBuilder *b, char **err)
{
  dt_iop_module_t *mod = session_module("colorin", err);
  if(!mod) return FALSE;
  for(int work = 0; work < 2; work++)
  {
    json_builder_set_member_name(b, work ? "working" : "input");
    json_builder_begin_array(b);
    _profile_option(b, "Default for Photo", 0);
    if(!work)
    {
      _profile_option(b, "Camera Standard Matrix", DT_COLORSPACE_STANDARD_MATRIX + 1);
      _profile_option(b, "Camera Enhanced Matrix", DT_COLORSPACE_ENHANCED_MATRIX + 1);
    }
    int *type; char *filename;
    if(!_profile_fields(mod, mod->params, work, &type, &filename, err)) return FALSE;
    const guint64 current = _profile_id(*type, filename);
    gboolean found = !work && (*type == DT_COLORSPACE_STANDARD_MATRIX || *type == DT_COLORSPACE_ENHANCED_MATRIX);
    for(const GList *l = darktable.color_profiles->profiles; l; l = l->next)
    {
      const dt_colorspaces_color_profile_t *p = l->data;
      if((work ? p->work_pos : p->in_pos) < 0) continue;
      const guint64 id = _profile_id(p->type, p->filename);
      _profile_option(b, p->name, id);
      found |= id == current;
    }
    if(!found)
    {
      gchar *label = g_strdup_printf("%s (current)",
        *type == DT_COLORSPACE_FILE ? filename : dt_colorspaces_get_name(*type, filename));
      _profile_option(b, label, current);
      g_free(label);
    }
    json_builder_end_array(b);
  }
  return TRUE;
}

// ---------------------------------------------------------------- previews

dt_dev_pixelpipe_iop_t *session_piece(dt_dev_pixelpipe_t *pipe, const dt_iop_module_t *m)
{
  for(GList *n = pipe->nodes; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *piece = n->data;
    if(piece->module == m) return piece;
  }
  return NULL;
}

// the pipe cache the base and check pipes may keep, as a fraction of
// darktable's memory (pixelpipe_cache.c, dt_dev_pixelpipe_cache_checkmem):
// the darkroom's preview pipe's 1/32 rather than a full pipe's 1/8. both
// render the whole image, a 1 GB line at 60 megapixels, so even 1/8 kept
// few lines: a base reran as many modules either way (benchmark, heavy
// edit, 11 GB of memory), while its lines stayed until the next (session_settle
// now cuts them back after each frame). the drag and preview pipes keep
// the full pipe's share: their small lines are what a drag draws from, and
// with less a rotate drag reran 13 modules, not 9
#define _WHOLE_PIPE_FRACTION 32

// the preview pipe, made on first use, with nodes for every instance and
// the edit as it stands
gboolean session_ppipe_ready(char **err)
{
  if(!_s.ppipe_ok)
  {
    if(!dt_dev_pixelpipe_init(&_s.ppipe))
    {
      *err = g_strdup("could not allocate the preview pipe");
      return FALSE;
    }
    dt_dev_pixelpipe_set_icc(&_s.ppipe, DT_COLORSPACE_SRGB, NULL, DT_INTENT_LAST);
    dt_dev_pixelpipe_set_input(&_s.ppipe, &_s.dev, (float *)_s.buf.buf,
                               _s.buf.width, _s.buf.height, _s.buf.iscale);
    dt_dev_pixelpipe_create_nodes(&_s.ppipe, &_s.dev);
    _s.ppipe_gen = _s.iop_gen;
    _s.ppipe_ok = TRUE;
  }
  else if(_s.ppipe_gen != _s.iop_gen)
  {
    dt_dev_pixelpipe_cleanup_nodes(&_s.ppipe);
    dt_dev_pixelpipe_create_nodes(&_s.ppipe, &_s.dev);
    _s.ppipe_gen = _s.iop_gen;
  }
  dt_dev_pixelpipe_synch_all(&_s.ppipe, &_s.dev);
  return TRUE;
}

// a follower pipe brought to the edit as it stands: unchanged pieces keep
// their hashes, so its cache holds
gboolean session_follower_ready(dt_engine_follower_t *f, char **err)
{
  if(f->ok)
  {
    if(f->gen != _s.iop_gen) f->pending |= DT_DEV_PIPE_REMOVE;
    f->gen = _s.iop_gen;
    f->pipe.changed = f->pending;
    dt_dev_pixelpipe_change(&f->pipe, &_s.dev);
    f->pending = DT_DEV_PIPE_UNCHANGED;
    return TRUE;
  }
  if(!dt_dev_pixelpipe_init(&f->pipe))
  {
    *err = g_strdup("could not allocate a pixelpipe");
    return FALSE;
  }
  if(f != &_s.drag) f->pipe.cache.mem_fraction = _WHOLE_PIPE_FRACTION;
  dt_dev_pixelpipe_set_icc(&f->pipe, DT_COLORSPACE_SRGB, NULL, DT_INTENT_LAST);
  dt_dev_pixelpipe_set_input(&f->pipe, &_s.dev, (float *)_s.buf.buf,
                             _s.buf.width, _s.buf.height, _s.buf.iscale);
  dt_dev_pixelpipe_create_nodes(&f->pipe, &_s.dev);
  dt_dev_pixelpipe_synch_all(&f->pipe, &_s.dev);
  dt_dev_pixelpipe_get_dimensions(&f->pipe, &_s.dev, f->pipe.iwidth, f->pipe.iheight,
                                  &f->pipe.processed_width, &f->pipe.processed_height);
  f->gen = _s.iop_gen;
  f->pending = DT_DEV_PIPE_UNCHANGED;
  f->ok = TRUE;
  return TRUE;
}

// give a preview piece these settings, for this render only
void session_preview_commit(dt_iop_module_t *m, void *params, dt_develop_blend_params_t *blend,
                            const gboolean enabled)
{
  dt_dev_pixelpipe_iop_t *piece = session_piece(&_s.ppipe, m);
  if(!piece) return;
  piece->enabled = enabled;
  // older pins hash module->params; keep the upstream mask-tree and bypass
  // hashes while giving that path the preview's temporary parameters too
  void *saved_params = m->params;
  dt_develop_blend_params_t *saved_blend = m->blend_params;
  dt_develop_blend_params_t preview_blend = *blend;
  m->params = params;
  // The upstream commit copies into module->blend_params as well as the
  // piece. Give it request-local storage so a tile cannot overwrite the
  // applied look's mask id, opacity or other blend settings.
  m->blend_params = &preview_blend;
  dt_iop_commit_params(m, params, blend, &_s.ppipe, piece);
  m->blend_params = saved_blend;
  m->params = saved_params;
  // darktable.develop is not the engine's develop, so hash its own forms
  // explicitly, as session_frame_hash does for retained main frames
  if(enabled)
  {
    dt_masks_form_t *form = dt_masks_get_from_id_ext(_s.dev.forms, blend->mask_id);
    if(form) piece->hash = dt_masks_group_hash_ext(piece->hash, form, _s.dev.forms);
    form = dt_masks_get_from_id_ext(_s.dev.forms, blend->blend_mask_id);
    if(form) piece->hash = dt_masks_group_hash_ext(piece->hash, form, _s.dev.forms);
  }
}

// the edit as it stands, plus `edits` ([{ op, params: { field: value },
// enabled, instance, after, before }], a named instance placed as "set"
// places it) and, when the request has "look", that style (a path) or no
// look (null), fitted into size x size on the preview pipe
static gboolean _preview_render(JsonObject *req, int *ow, int *oh, char **err)
{
  const int size = json_object_get_int_member_with_default(req, "size", 160);
  const gboolean has_look = json_object_has_member(req, "look");
  const char *look = has_look ? json_object_get_string_member_with_default(req, "look", NULL) : NULL;

  // the look's instances must exist before the preview pipe's nodes do
  gchar *label = NULL;
  GList *items = look ? looks_style_items(look, &label, err) : NULL;
  g_free(label);
  if(look && !items) return FALSE;
  for(GList *l = items; l; l = g_list_next(l))
    if(!looks_look_instance(((dt_style_item_t *)l->data)->operation, TRUE))
    {
      g_list_free_full(items, dt_style_item_free);
      *err = g_strdup("cannot add the look's modules");
      return FALSE;
    }

  // so must a named instance's that the preview switches on. one it leaves
  // off and that is not made yet has nothing to show
  JsonArray *edits = json_object_has_member(req, "edits")
    ? json_object_get_array_member(req, "edits") : NULL;
  for(guint k = 0; edits && k < json_array_get_length(edits); k++)
  {
    JsonObject *e = json_array_get_object_element(edits, k);
    const char *op = json_object_get_string_member_with_default(e, "op", NULL);
    const char *instance = json_object_get_string_member_with_default(e, "instance", NULL);
    if(!op || !instance || session_find_named(op, instance)
       || !json_object_get_boolean_member_with_default(e, "enabled", FALSE))
      continue;
    const char *after = json_object_get_string_member_with_default(e, "after", NULL);
    const char *before = json_object_get_string_member_with_default(e, "before", NULL);
    gboolean moved = FALSE;
    dt_iop_module_t *m = masks_named_instance(op, instance, !after && !before, err);
    if(!m || !_place(m, after, before, &moved, err))
    {
      g_list_free_full(items, dt_style_item_free);
      return FALSE;
    }
  }

  if(!session_ppipe_ready(err))
  {
    g_list_free_full(items, dt_style_item_free);
    return FALSE;
  }

  gboolean ok = TRUE;
  for(guint k = 0; ok && edits && k < json_array_get_length(edits); k++)
  {
    JsonObject *e = json_array_get_object_element(edits, k);
    const char *op = json_object_get_string_member_with_default(e, "op", NULL);
    const char *instance = json_object_get_string_member_with_default(e, "instance", NULL);
    if(instance && op && !session_find_named(op, instance)) continue;
    dt_iop_module_t *m = instance ? session_find_named(op, instance) : session_module(op, err);
    if(!m) { ok = FALSE; break; }
    void *params = g_malloc(m->params_size);
    memcpy(params, m->params, m->params_size);
    JsonObject *fields = json_object_has_member(e, "params") ? json_object_get_object_member(e, "params") : NULL;
    GList *names = fields ? json_object_get_members(fields) : NULL;
    for(GList *n = names; ok && n; n = g_list_next(n))
      ok = session_write_field_in(m, params, n->data, json_object_get_double_member(fields, n->data), err);
    g_list_free(names);
    if(ok)
      session_preview_commit(m, params, m->blend_params,
                      json_object_get_boolean_member_with_default(e, "enabled", m->enabled));
    g_free(params);
  }

  if(ok && has_look)
  {
    GList *used = NULL;
    for(GList *l = items; ok && l; l = g_list_next(l))
    {
      const dt_style_item_t *si = l->data;
      dt_iop_module_t *m = looks_look_instance(si->operation, FALSE);
      void *params = g_malloc(m->params_size);
      dt_develop_blend_params_t *blend = g_malloc(sizeof(dt_develop_blend_params_t));
      ok = looks_item_params(m, si, params, blend);
      if(ok) session_preview_commit(m, params, blend, si->enabled);
      else *err = g_strdup_printf("cannot apply the style's '%s'", si->operation);
      g_free(params);
      g_free(blend);
      used = g_list_prepend(used, m);
    }
    for(GList *l = _s.dev.iop; l; l = g_list_next(l))
    {
      dt_iop_module_t *m = l->data;
      dt_dev_pixelpipe_iop_t *piece = looks_is_look(m) && !g_list_find(used, m) ? session_piece(&_s.ppipe, m) : NULL;
      if(piece) piece->enabled = FALSE;
    }
    g_list_free(used);
  }
  g_list_free_full(items, dt_style_item_free);
  if(!ok) return FALSE;

  _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  if(pw <= 0 || ph <= 0)
  {
    *err = g_strdup("the preview has no size");
    return FALSE;
  }
  const double scale = fmin(1.0, fmin((double)size / pw, (double)size / ph));
  const int w = MAX(1, floor(scale * pw)), h = MAX(1, floor(scale * ph));
  if(dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, 0, 0, w, h, scale, DT_DEVICE_NONE)
     || !_s.ppipe.backbuf)
  {
    *err = g_strdup("the preview failed");
    return FALSE;
  }
  *ow = _s.ppipe.backbuf_width;
  *oh = _s.ppipe.backbuf_height;
  return TRUE;
}

gboolean session_preview(JsonObject *req, int *ow, int *oh, char **err)
{
  // Creating a missing preview instance changes module order. Keep those
  // instances request-local too: saving after a preview must not change the
  // edit's hash and invalidate a paste's Undo/Redo snapshot.
  GList *saved_iop = g_list_copy(_s.dev.iop);
  GList *saved_order = dt_ioppr_iop_order_copy_deep(_s.dev.iop_order_list);
  const int gen = _s.iop_gen;
  const char *look = json_object_get_string_member_with_default(req, "look", NULL);
  GList *saved_forms = _s.dev.forms;
  if(look) _s.dev.forms = dt_masks_dup_forms_deep(saved_forms, NULL);
  const gboolean ok = _preview_render(req, ow, oh, err);
  if(look)
  {
    g_list_free_full(_s.dev.forms, (GDestroyNotify)dt_masks_free_form);
    _s.dev.forms = saved_forms;
  }
  if(gen != _s.iop_gen)
  {
    // Drop nodes before freeing modules they reference. cleanup_nodes keeps
    // the preview backbuffer, which the caller still needs to write out.
    dt_dev_pixelpipe_cleanup_nodes(&_s.pipe);
    if(_s.ppipe_ok) dt_dev_pixelpipe_cleanup_nodes(&_s.ppipe);
    session_follower_cleanup(&_s.drag);
    session_follower_cleanup(&_s.base);
    session_follower_cleanup(&_s.check);
    for(GList *l = _s.dev.iop; l; l = g_list_next(l))
      if(!g_list_find(saved_iop, l->data))
      {
        dt_iop_cleanup_module(l->data);
        free(l->data);
      }
    g_list_free(_s.dev.iop);
    _s.dev.iop = saved_iop;
    g_list_free_full(_s.dev.iop_order_list, free);
    _s.dev.iop_order_list = saved_order;
    dt_ioppr_resync_modules_order(&_s.dev);
    _s.iop_gen++;
    session_changed(DT_DEV_PIPE_REMOVE);
  }
  else
  {
    g_list_free(saved_iop);
    g_list_free_full(saved_order, free);
  }
  return ok;
}

// the edit into the library and the XMP sidecar
gboolean session_save(char **err)
{
  dt_dev_write_history_ext(&_s.dev, _s.imgid);
  // the database only: this session's own history stays in memory, as
  // reloading it calls into the GUI (dt_dev_reload_history_items())
  _compress_history(_s.imgid);
  // whether the photo is altered is darktable's history hash, which the
  // sidecar carries (exif.cc), so darktable's lighttable agrees with the
  // client. hashed after the compress, which renumbers the history
  dt_history_hash_write_from_history(_s.imgid, _s.baseline
                                     ? DT_HISTORY_HASH_AUTO | DT_HISTORY_HASH_CURRENT
                                     : DT_HISTORY_HASH_CURRENT);
  // and darktable's tag for an edited photo, which it attaches in
  // dt_dev_add_history_item(), a GUI path the engine never takes
  if(dt_image_altered(_s.imgid))
  {
    guint tagid = 0;
    dt_tag_new("darktable|changed", &tagid);
    dt_tag_attach(tagid, _s.imgid, FALSE, FALSE);
  }
  else
    dt_tag_detach_by_string("darktable|changed", _s.imgid, FALSE, FALSE);
  // direct rather than dt_image_synch_xmp(), whose queue is drained by a
  // background job this process may outlive. TRUE means it failed
  if(library_write_sidecar(_s.imgid))
  {
    *err = g_strdup(library_sidecar_error ? library_sidecar_error : "could not write the XMP sidecar");
    return FALSE;
  }
  dt_mipmap_cache_remove(_s.imgid);
  _s.unsaved = FALSE;
  return TRUE;
}

// Complete native histories for one frontend batch. These private image versions
// never appear in listings and are released with their undo entries or on exit.
typedef struct paste_image_t
{
  dt_imgid_t imgid, before, after;
  dt_history_hash_values_t before_hash, after_hash;
} paste_image_t;
typedef struct paste_batch_t
{
  GArray *images;
  gboolean committed;
} paste_batch_t;
GHashTable *session_paste_batches = NULL;
static guint _paste_serial = 0;

static void _paste_free(gpointer data)
{
  paste_batch_t *batch = data;
  for(guint k = 0; k < batch->images->len; k++)
  {
    paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
    library_snapshot_remove(i->before);
    library_snapshot_remove(i->after);
    dt_history_hash_free(&i->before_hash);
    dt_history_hash_free(&i->after_hash);
  }
  g_array_free(batch->images, TRUE);
  g_free(batch);
}

static dt_imgid_t _paste_snapshot(const dt_imgid_t imgid)
{
  const dt_imgid_t snap = library_snapshot(imgid);
  // The history API logs raster-copy failures without propagating them.
  // Verify the data transfer before relying on a snapshot for undo.
  if(dt_is_valid_imgid(snap) && !dt_dtdata_merge(imgid, snap))
  { library_snapshot_remove(snap); return NO_IMGID; }
  return snap;
}

static gboolean _paste_same_hash(const dt_history_hash_values_t *a,
                                 const dt_history_hash_values_t *b)
{
  return a->current_len == b->current_len
    && (!a->current_len || !memcmp(a->current, b->current, a->current_len));
}

gboolean session_paste_batch(JsonObject *req, JsonBuilder *b, char **err)
{
  const char *action = json_object_get_string_member_with_default(req, "action", "");
  const guint token = json_object_get_int_member_with_default(req, "token", 0);
  if(!session_paste_batches) session_paste_batches = g_hash_table_new_full(g_direct_hash, g_direct_equal, NULL, _paste_free);
  paste_batch_t *batch = g_hash_table_lookup(session_paste_batches, GUINT_TO_POINTER(token));
  if(!g_strcmp0(action, "begin"))
  {
    JsonArray *ids = json_object_get_array_member(req, "imgids");
    if(!ids || !json_array_get_length(ids)) { *err = g_strdup("no paste targets"); return FALSE; }
    // Validate the whole list before allocating snapshots or writing anything.
    for(guint k = 0; k < json_array_get_length(ids); k++)
    {
      const dt_imgid_t id = json_array_get_int_element(ids, k);
      char path[PATH_MAX] = { 0 };
      gboolean cache = FALSE;
      if(dt_is_valid_imgid(id) && !library_is_snapshot(id)) dt_image_full_path(id, path, sizeof(path), &cache);
      if(!path[0] || !g_file_test(path, G_FILE_TEST_IS_REGULAR))
      { *err = g_strdup_printf("paste target %d is missing", id); return FALSE; }
      for(guint j = 0; j < k; j++) if(json_array_get_int_element(ids, j) == id)
      { *err = g_strdup("duplicate paste target"); return FALSE; }
    }
    if(_s.open && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
    batch = g_new0(paste_batch_t, 1);
    batch->images = g_array_new(FALSE, TRUE, sizeof(paste_image_t));
    for(guint k = 0; k < json_array_get_length(ids); k++)
    {
      paste_image_t i = { .imgid = json_array_get_int_element(ids, k) };
      dt_history_hash_read(i.imgid, &i.before_hash);
      i.before = _paste_snapshot(i.imgid);
      g_array_append_val(batch->images, i);
      if(!dt_is_valid_imgid(i.before))
      { _paste_free(batch); *err = g_strdup("could not snapshot paste targets"); return FALSE; }
    }
    const guint made = ++_paste_serial;
    g_hash_table_insert(session_paste_batches, GUINT_TO_POINTER(made), batch);
    json_builder_set_member_name(b, "token");
    json_builder_add_int_value(b, made);
    return TRUE;
  }
  if(!batch) { *err = g_strdup("paste undo is no longer available"); return FALSE; }
  if(!g_strcmp0(action, "release"))
  { g_hash_table_remove(session_paste_batches, GUINT_TO_POINTER(token)); return TRUE; }
  if(!g_strcmp0(action, "commit"))
  {
    if(batch->committed) { *err = g_strdup("paste already committed"); return FALSE; }
    if(_s.open && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
    for(guint k = 0; k < batch->images->len; k++)
    {
      paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
      i->after = _paste_snapshot(i->imgid);
      dt_history_hash_read(i->imgid, &i->after_hash);
      if(!dt_is_valid_imgid(i->after)) { *err = g_strdup("could not snapshot pasted settings"); return FALSE; }
    }
    batch->committed = TRUE;
    return TRUE;
  }
  const gboolean back = !g_strcmp0(action, "undo") || !g_strcmp0(action, "abort");
  const gboolean aborting = !g_strcmp0(action, "abort");
  if(!back && g_strcmp0(action, "redo")) { *err = g_strdup("unknown paste action"); return FALSE; }
  if(!aborting && !batch->committed) { *err = g_strdup("paste is not committed"); return FALSE; }
  // Refuse stale undo/redo before changing any photo. Retrying a failed sidecar
  // write is allowed when the database already holds the requested state.
  if(!aborting && _s.open && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
  for(guint k = 0; !aborting && k < batch->images->len; k++)
  {
    paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
    dt_history_hash_values_t now = { 0 };
    dt_history_hash_read(i->imgid, &now);
    const gboolean same = _paste_same_hash(&now, &i->before_hash) || _paste_same_hash(&now, &i->after_hash);
    dt_history_hash_free(&now);
    if(!same) { *err = g_strdup_printf("photo %d changed since the paste; undo stopped", i->imgid); return FALSE; }
  }
  if(_s.open)
    for(guint k = 0; k < batch->images->len; k++)
      if(g_array_index(batch->images, paste_image_t, k).imgid == _s.imgid) { session_close_session(); break; }
  json_builder_set_member_name(b, "updates");
  json_builder_begin_array(b);
  for(guint k = 0; k < batch->images->len; k++)
  {
    paste_image_t *i = &g_array_index(batch->images, paste_image_t, k);
    const dt_imgid_t snap = back ? i->before : i->after;
    const dt_history_hash_values_t *hash = back ? &i->before_hash : &i->after_hash;
    _hold_open(i->imgid);
    const gboolean copied = dt_history_copy_and_paste_on_image(snap, i->imgid, FALSE, NULL, TRUE, TRUE, FALSE)
      && dt_dtdata_merge(snap, i->imgid);
    if(copied)
    {
      // dt_history_hash_write consumes its buffers despite its const argument.
      dt_history_hash_values_t owned = *hash;
      owned.basic = hash->basic_len ? g_malloc(hash->basic_len) : NULL;
      owned.auto_apply = hash->auto_apply_len ? g_malloc(hash->auto_apply_len) : NULL;
      owned.current = hash->current_len ? g_malloc(hash->current_len) : NULL;
      if(hash->basic_len) memcpy(owned.basic, hash->basic, hash->basic_len);
      if(hash->auto_apply_len) memcpy(owned.auto_apply, hash->auto_apply, hash->auto_apply_len);
      if(hash->current_len) memcpy(owned.current, hash->current, hash->current_len);
      dt_history_hash_write(i->imgid, &owned);
    }
    const gboolean edited = dt_image_altered(i->imgid);
    if(copied)
    {
      if(edited)
      {
        guint tag = 0;
        dt_tag_new("darktable|changed", &tag);
        dt_tag_attach(tag, i->imgid, FALSE, FALSE);
      }
      else dt_tag_detach_by_string("darktable|changed", i->imgid, FALSE, FALSE);
    }
    const gboolean failed = !copied || library_write_sidecar(i->imgid);
    dt_mipmap_cache_remove(i->imgid);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "imgid"); json_builder_add_int_value(b, i->imgid);
    json_builder_set_member_name(b, "edited"); json_builder_add_boolean_value(b, edited);
    json_builder_set_member_name(b, "error");
    if(failed) json_builder_add_string_value(b, copied ? "could not write the XMP sidecar" : "could not restore history");
    else json_builder_add_null_value(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

// on the way out, the edits the client's own save has not reached yet
void session_save_pending(void)
{
  if(!_s.open || !_s.unsaved || _s.before) return;
  char *err = NULL;
  if(!session_save(&err)) fprintf(stderr, "[engine] save on quit: %s\n", err);
  g_free(err);
}

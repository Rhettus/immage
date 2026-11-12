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

// masks and local adjustments: shapes, combined masks, spots, ranges, zones and sampling

#include "engine.h"

static void _apply_ranges(dt_iop_module_t *m, dt_masks_form_t *root, const gboolean invert);
static void _ranges_json(JsonBuilder *b, const dt_develop_blend_params_t *bp);

// ------------------------------------------------------------------ masks
// a client's mask (Lightroom's local adjustments) is a darktable mask group
// named "immage: <name>" holding its shapes, shared by the module
// instances named "<name>" that carry the mask's adjustments. all of it is
// ordinary darktable history, so stock darktable shows the same masks
#define _MASK_PREFIX "immage: "

// a client mask's name from its group's, or NULL for a group that is not one
const char *masks_mask_name(const char *full)
{
  if(g_str_has_prefix(full, _MASK_PREFIX)) return full + strlen(_MASK_PREFIX);
  return NULL;
}
// the mask anchor: masks' instances run right after it, all on one input,
// so a range sampled at its output holds for every one of them
// (app/docs/dev/masks.md, "Where the instances run")
#define _MASK_ANCHOR "colorbalancergb"
// the instances masks share are named so (app/src/localMerge.ts SHARED_PREFIX)
#define _SHARED_PREFIX "immage local: "

static dt_masks_form_t *_mask_group(const char *name)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if(!(f->type & DT_MASKS_GROUP)) continue;
    const char *n = masks_mask_name(f->name);
    if(n && !g_strcmp0(n, name)) return f;
  }
  return NULL;
}

// a combined mask: masks' groups summed, each at an opacity of its own, so
// one instance can carry the same adjustment for several masks at their
// own strengths, as Lightroom's local adjustments add up, instead of one
// instance per mask each running the whole module. not a client mask, so
// masks_masks() passes over it
#define _COMBINED_PREFIX "immage combined: "

static dt_masks_form_t *_combined_group(const char *name)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if((f->type & DT_MASKS_GROUP) && g_str_has_prefix(f->name, _COMBINED_PREFIX)
       && !g_strcmp0(f->name + strlen(_COMBINED_PREFIX), name))
      return f;
  }
  return NULL;
}

// masks are darktable's flexi masks (dev-doc/masks_data_model.md). a
// mask's group, "immage: <name>", holds its drawn shapes. its range
// components are parametric elements multiplied into them, as darktable
// converts a classic drawn and parametric mask (masks/migrate_legacy.c,
// _migrate_drawn_and_parametric), in a group of their own named after the
// mask's: the instances blending in scene-referred RGB, where the ranges
// were measured, take that one, and the rest the shapes alone
#define _RANGES_PREFIX "immage ranges: "

static dt_masks_form_t *_group_named(const char *full)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if((f->type & DT_MASKS_GROUP) && !g_strcmp0(f->name, full)) return f;
  }
  return NULL;
}

// a mask's group or a combined mask's
static gboolean _is_root(const dt_masks_form_t *f)
{
  return f && (f->type & DT_MASKS_GROUP)
         && (g_str_has_prefix(f->name, _MASK_PREFIX) || g_str_has_prefix(f->name, _COMBINED_PREFIX));
}

// the group with the ranges of `root`, or NULL when it has none
static dt_masks_form_t *_ranges_group(const dt_masks_form_t *root)
{
  char full[sizeof(root->name)];
  g_snprintf(full, sizeof(full), "%s%s", _RANGES_PREFIX, root->name);
  return _group_named(full);
}

static const char *_mask_instance_tag(const dt_iop_module_t *m, const char *name);

// the mask (its group, or a combined mask's) instance `m` carries, or NULL.
// an edit made before flexi masks was converted when it was loaded, which
// gives every instance with ranges a group of its own, unnamed
// (migrate_legacy.c): its instances are known by their names then
dt_masks_form_t *masks_instance_group(const dt_iop_module_t *m)
{
  const dt_develop_blend_params_t *bp = m->blend_params;
  if(!bp || !(bp->mask_mode & DEVELOP_MASK_ENABLED)) return NULL;
  dt_masks_form_t *g = dt_is_valid_maskid(bp->mask_id) ? dt_masks_get_from_id(&_s.dev, bp->mask_id) : NULL;
  if(g && (g->type & DT_MASKS_GROUP))
  {
    if(_is_root(g)) return g;
    if(g_str_has_prefix(g->name, _RANGES_PREFIX))
    {
      dt_masks_form_t *root = _group_named(g->name + strlen(_RANGES_PREFIX));
      if(root) return root;
    }
  }
  if(!m->multi_name_hand_edited) return NULL;
  if(g_str_has_prefix(m->multi_name, _SHARED_PREFIX))
    return _combined_group(m->multi_name + strlen(_SHARED_PREFIX));
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    const char *name = (f->type & DT_MASKS_GROUP) ? masks_mask_name(f->name) : NULL;
    if(name && _mask_instance_tag(m, name)) return f;
  }
  return NULL;
}

// whether mask `root` holds anything to fold: an empty one is its marker
static gboolean _has_members(const dt_masks_form_t *root)
{
  for(const GList *l = root ? root->points : NULL; l; l = g_list_next(l))
    if(!dt_masks_point_is_marker(l->data)) return TRUE;
  return FALSE;
}

// `f` and every form under it into `set`
static void _reach(const dt_masks_form_t *f, GHashTable *set, const int depth)
{
  if(!f || depth > DT_MASKS_NESTING_MAX || g_hash_table_contains(set, f)) return;
  g_hash_table_add(set, (gpointer)f);
  if(!(f->type & DT_MASKS_GROUP)) return;
  for(const GList *l = f->points; l; l = g_list_next(l))
  {
    const dt_masks_point_group_t *pt = l->data;
    if(!dt_masks_point_is_marker(pt)) _reach(dt_masks_get_from_id(&_s.dev, pt->formid), set, depth + 1);
  }
}

// the forms mask `root` (a mask's group or a combined mask's) renders with:
// its tree, its ranges' and those of its instances, which for an older
// edit are trees of their own. darktable's conversion copies a group held
// twice, under the same name, so those go with it as well
static GHashTable *_mask_forms(const dt_masks_form_t *root)
{
  GHashTable *set = g_hash_table_new(NULL, NULL);
  _reach(root, set, 0);
  _reach(_ranges_group(root), set, 0);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(masks_instance_group(m) == root) _reach(dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id), set, 0);
  }
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    const dt_masks_form_t *f = l->data;
    if(f != root && (f->type & DT_MASKS_GROUP) && !g_strcmp0(f->name, root->name)) _reach(f, set, 0);
  }
  return set;
}

// the forms in `old` that nothing uses any more leave the image, and `old`
// is freed: before a history item is added, which keeps all of the
// develop's forms. used is what a module renders, a mask's group, a
// combined mask's and their ranges' (the first of a name), and whatever
// another group holds
static void _free_unreached(GHashTable *old)
{
  GHashTable *live = g_hash_table_new(NULL, NULL);
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(!m->blend_params) continue;
    _reach(dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id), live, 0);
    _reach(dt_masks_get_from_id(&_s.dev, m->blend_params->blend_mask_id), live, 0);
  }
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    const dt_masks_form_t *f = l->data;
    if(!(f->type & DT_MASKS_GROUP)) continue;
    const gboolean named = (_is_root(f) || g_str_has_prefix(f->name, _RANGES_PREFIX))
                           && _group_named(f->name) == f;
    if(named || !g_hash_table_contains(old, f)) _reach(f, live, 0);
  }
  for(GList *l = _s.dev.forms; l;)
  {
    GList *next = g_list_next(l);
    dt_masks_form_t *f = l->data;
    if(g_hash_table_contains(old, f) && !g_hash_table_contains(live, f))
    {
      _s.dev.forms = g_list_delete_link(_s.dev.forms, l);
      dt_masks_free_form(f);
    }
    l = next;
  }
  g_hash_table_destroy(live);
  g_hash_table_destroy(old);
}

// a member of `grp` referring to form `formid`
static dt_masks_point_group_t *_member(dt_masks_form_t *grp, const dt_mask_id_t formid, const int state,
                                       const float opacity)
{
  dt_masks_point_group_t *pt = calloc(1, sizeof(dt_masks_point_group_t));
  pt->formid = formid;
  pt->parentid = grp->formid;
  pt->state = state;
  pt->opacity = opacity;
  pt->group_opacity = 1.0f;
  grp->points = g_list_append(grp->points, pt);
  return pt;
}

// whether member `pt` of a combined mask is mask `root`: by reference, or,
// in an older edit, as the shape darktable put there in its place
static gboolean _holds_mask(const dt_masks_point_group_t *pt, const dt_masks_form_t *root)
{
  if(dt_masks_point_is_marker(pt)) return FALSE;
  if(pt->formid == root->formid) return TRUE;
  const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, pt->formid);
  const size_t n = strlen(root->name);
  return f && !strncmp(f->name, root->name, n) && !strncmp(f->name + n, " #", 2);
}

// the combined masks holding mask `root` in an older edit's way, as one of
// its shapes, hold its group instead, whatever becomes of its shapes
static void _combined_adopt(const dt_masks_form_t *root)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *grp = l->data;
    if(!(grp->type & DT_MASKS_GROUP) || !g_str_has_prefix(grp->name, _COMBINED_PREFIX)) continue;
    gboolean held = FALSE;
    for(GList *p = grp->points; p;)
    {
      GList *next = g_list_next(p);
      dt_masks_point_group_t *pt = p->data;
      if(_holds_mask(pt, root))
      {
        if(held)
        {
          grp->points = g_list_delete_link(grp->points, p);
          free(pt);
        }
        else
          pt->formid = root->formid;
        held = TRUE;
      }
      p = next;
    }
  }
}

// the instance of `op` named `name`, made (switched off) when missing.
// `anchored`, a new one runs after the mask anchor
dt_iop_module_t *masks_named_instance(const char *op, const char *name, const gboolean anchored,
                                      char **err)
{
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(!g_strcmp0(m->op, op) && m->multi_name_hand_edited && !g_strcmp0(m->multi_name, name)) return m;
  }
  dt_iop_module_t *base = dt_iop_get_module_by_op_priority(_s.dev.iop, op, 0);
  dt_iop_module_t *m = base ? dt_dev_module_duplicate_ext(&_s.dev, base, TRUE) : NULL;
  if(!m)
  {
    *err = g_strdup_printf("cannot add an instance of '%s'", op);
    return NULL;
  }
  g_strlcpy(m->multi_name, name, sizeof(m->multi_name));
  m->multi_name_hand_edited = TRUE;
  m->enabled = FALSE;
  // a new instance starts from the defaults for this image, not the base
  // instance's edit; the image's defaults (denoise's noise profile) come
  // from reload_defaults, which duplicating does not run
  dt_iop_reload_defaults(m);
  memcpy(m->params, m->default_params, m->params_size);
  // mask instances run together after the anchor, in the working space,
  // where a range mask's sampled values hold for all of them
  // except denoise (profiled), whose noise profile holds only for the
  // camera's data where it normally runs, and haze removal, whose ambient
  // light estimate goes negative on the exposed values after the anchor,
  // which leaves a positive strength nothing to remove (hazeremoval.c,
  // t_min)
  dt_iop_module_t *anchor = dt_iop_get_module_by_op_priority(_s.dev.iop, _MASK_ANCHOR, 0);
  if(anchored && anchor && m->iop_order < anchor->iop_order && g_strcmp0(op, "denoiseprofile")
     && g_strcmp0(op, "hazeremoval")
     && dt_ioppr_check_can_move_after_iop(_s.dev.iop, m, anchor))
    dt_ioppr_move_iop_after(&_s.dev, m, anchor);
  // a mask's own instance runs after the instances masks share
  // (app/src/localMerge.ts), so editing it alone, as a mask lifted out of
  // them for a drag is, leaves their output to the pipe cache
  if(anchored && !g_str_has_prefix(name, _SHARED_PREFIX))
  {
    dt_iop_module_t *last = NULL;
    for(GList *l = _s.dev.iop; l; l = g_list_next(l))
    {
      dt_iop_module_t *s = l->data;
      if(s != m && !g_strcmp0(s->op, op) && g_str_has_prefix(s->multi_name, _SHARED_PREFIX)
         && (!last || s->iop_order > last->iop_order))
        last = s;
    }
    if(last && m->iop_order < last->iop_order && dt_ioppr_check_can_move_after_iop(_s.dev.iop, m, last))
      dt_ioppr_move_iop_after(&_s.dev, m, last);
  }
  _s.iop_gen++;
  session_changed(DT_DEV_PIPE_REMOVE);
  return m;
}

// darktable's brush renders a stroke of one point over the whole image: its
// own brush tool never stores one, but adds a second point beside a single
// click (masks/brush.c, guipoints_count == 1), 0.01 preview pixels away. a
// one-point brush `f` gets that second point, about as far in input units
static void _brush_second_point(dt_masks_form_t *f)
{
  if(!f || !(f->type & DT_MASKS_BRUSH) || g_list_length(f->points) != 1) return;
  dt_masks_point_brush_t *b = malloc(sizeof(dt_masks_point_brush_t));
  memcpy(b, f->points->data, sizeof(dt_masks_point_brush_t));
  const float d[2] = { 1e-5f, -1e-5f };
  for(int k = 0; k < 2; k++)
  {
    b->corner[k] += d[k];
    b->ctrl1[k] += d[k];
    b->ctrl2[k] += d[k];
  }
  f->points = g_list_append(f->points, b);
}

void masks_repair_brushes(void)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l)) _brush_second_point(l->data);
  for(GList *h = _s.dev.history; h; h = g_list_next(h))
  {
    const dt_dev_history_item_t *item = h->data;
    for(GList *l = item->forms; l; l = g_list_next(l)) _brush_second_point(l->data);
  }
}

// a point of the shown image (0-1 across its width and height) as darktable
// stores shape points: in the input image, before any distortion, 0-1
static void _to_input(const float x, const float y, float *ix, float *iy)
{
  float p[2] = { x * _s.pipe.processed_width, y * _s.pipe.processed_height };
  dt_dev_distort_backtransform_plus(&_s.dev, &_s.pipe, 0, DT_DEV_TRANSFORM_DIR_ALL, p, 1);
  *ix = p[0] / _s.pipe.iwidth;
  *iy = p[1] / _s.pipe.iheight;
}

// distances and angles survive the distortion only approximately; they are
// measured between transformed points, in input pixels
static void _to_input_vec(const float x, const float y, const float dx, const float dy,
                          float *len, float *angle)
{
  float ax, ay, bx, by;
  _to_input(x, y, &ax, &ay);
  _to_input(x + dx, y + dy, &bx, &by);
  const float vx = (bx - ax) * _s.pipe.iwidth, vy = (by - ay) * _s.pipe.iheight;
  *len = hypotf(vx, vy);
  *angle = atan2f(vy, vx);
}

// one shape of a mask, from the client's description in shown-image units:
//   ellipse: x, y (center), rx, ry (radii, both as fractions of the shown
//            width, so rx = ry is a circle), angle (degrees, clockwise),
//            feather (0-1, inward)
//   gradient: x, y (where it is half on), angle (degrees, the direction it
//             fades toward), width (the fade, as a fraction of the shown
//             image's diagonal)
//   brush:   points [[x, y], ...], size (fraction of the shown width),
//            hardness (0-1), density (0-1)
static dt_masks_form_t *_shape(JsonObject *o, char **err)
{
  const char *type = json_object_get_string_member_with_default(o, "type", "");
  const float x = json_object_get_double_member_with_default(o, "x", 0.5);
  const float y = json_object_get_double_member_with_default(o, "y", 0.5);
  const float pw = _s.pipe.processed_width, ph = _s.pipe.processed_height;
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);

  if(!g_strcmp0(type, "ellipse"))
  {
    const float rx = json_object_get_double_member_with_default(o, "rx", 0.2);
    const float ry = json_object_get_double_member_with_default(o, "ry", 0.2);
    const float a = json_object_get_double_member_with_default(o, "angle", 0.0) * M_PI / 180.0;
    const float feather = CLAMP(json_object_get_double_member_with_default(o, "feather", 0.5), 0.0, 0.95);
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_ELLIPSE);
    dt_masks_point_ellipse_t *e = calloc(1, sizeof(dt_masks_point_ellipse_t));
    _to_input(x, y, &e->center[0], &e->center[1]);
    float la, lb, aa, ab;
    // the two semi-axes as offsets in shown-image units, y scaled to width
    _to_input_vec(x, y, rx * cosf(a), rx * sinf(a) * pw / ph, &la, &aa);
    _to_input_vec(x, y, -ry * sinf(a), ry * cosf(a) * pw / ph, &lb, &ab);
    // feather inward, as Lightroom's: the full effect stops short of the
    // edge by the feather, and darktable's border carries it to the edge
    e->radius[0] = MAX(0.002f, la * (1.0f - feather) / imin);
    e->radius[1] = MAX(0.002f, lb * (1.0f - feather) / imin);
    e->rotation = aa * 180.0f / M_PI;
    e->flags = DT_MASKS_ELLIPSE_PROPORTIONAL;
    e->border = MAX(0.001f, feather / (1.0f - feather));
    f->points = g_list_append(f->points, e);
    return f;
  }
  if(!g_strcmp0(type, "gradient"))
  {
    const float a = json_object_get_double_member_with_default(o, "angle", 90.0) * M_PI / 180.0;
    const float width = CLAMP(json_object_get_double_member_with_default(o, "width", 0.3), 0.001, 2.0);
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_GRADIENT);
    dt_masks_point_gradient_t *g = calloc(1, sizeof(dt_masks_point_gradient_t));
    _to_input(x, y, &g->anchor[0], &g->anchor[1]);
    float len, ang;
    _to_input_vec(x, y, cosf(a) * 0.01f, sinf(a) * 0.01f * pw / ph, &len, &ang);
    g->rotation = -ang * 180.0f / M_PI + 90.0f;
    // darktable fades over twice the compression, in input diagonals
    g->compression = width / 2.0f * hypotf(pw, ph) / hypotf(_s.pipe.iwidth, _s.pipe.iheight);
    g->steepness = 0.0f;
    g->curvature = 0.0f;
    g->state = DT_MASKS_GRADIENT_STATE_LINEAR;
    f->points = g_list_append(f->points, g);
    return f;
  }
  if(!g_strcmp0(type, "brush"))
  {
    JsonArray *pts = json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
    const guint n = pts ? json_array_get_length(pts) : 0;
    if(n == 0)
    {
      *err = g_strdup("a brush stroke needs points");
      return NULL;
    }
    const float size = json_object_get_double_member_with_default(o, "size", 0.05);
    const float hardness = CLAMP(json_object_get_double_member_with_default(o, "hardness", 0.5), 0.0, 1.0);
    const float density = CLAMP(json_object_get_double_member_with_default(o, "density", 1.0), 0.0, 1.0);
    // the stroke's radius in input units, as darktable's brush keeps it
    float len, ang;
    _to_input_vec(x, y, size / 2.0f, 0.0f, &len, &ang);
    const float border = MAX(0.0005f, len / imin);
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_BRUSH);
    for(guint k = 0; k < n; k++)
    {
      JsonArray *p = json_array_get_array_element(pts, k);
      dt_masks_point_brush_t *b = calloc(1, sizeof(dt_masks_point_brush_t));
      _to_input(json_array_get_double_element(p, 0), json_array_get_double_element(p, 1),
                &b->corner[0], &b->corner[1]);
      b->ctrl1[0] = b->ctrl2[0] = b->corner[0];
      b->ctrl1[1] = b->ctrl2[1] = b->corner[1];
      b->border[0] = b->border[1] = border;
      b->hardness = hardness;
      b->density = density;
      b->state = DT_MASKS_POINT_STATE_NORMAL;
      f->points = g_list_append(f->points, b);
    }
    _brush_second_point(f);
    return f;
  }
  *err = g_strdup_printf("unknown shape '%s'", type);
  return NULL;
}

// `paths` of component k as darktable path shapes, appended to `grp`
// and named "#k.i", `mark` before a hole's "-". `*bottom` while nothing
// is under them in the group: the first then takes no operator. `off`,
// kept but disabled, which darktable's group passes over (masks/group.c)
static gboolean _object_paths(dt_masks_form_t *grp, JsonArray *paths, const char *name, const guint k,
                              const char *tag, const char *mark, const float feather,
                              const gboolean subtract, const gboolean off, gboolean *bottom)
{
  gboolean any = FALSE;
  for(guint i = 0; paths && i < json_array_get_length(paths); i++)
  {
    JsonObject *po = json_array_get_object_element(paths, i);
    JsonArray *pts = json_object_get_array_member(po, "points");
    const guint n = pts ? json_array_get_length(pts) : 0;
    if(n < 3) continue;
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_PATH);
    for(guint j = 0; j < n; j++)
    {
      JsonArray *c = json_array_get_array_element(pts, j);
      dt_masks_point_path_t *pt = calloc(1, sizeof(dt_masks_point_path_t));
      _to_input(json_array_get_double_element(c, 0), json_array_get_double_element(c, 1), &pt->corner[0], &pt->corner[1]);
      _to_input(json_array_get_double_element(c, 2), json_array_get_double_element(c, 3), &pt->ctrl1[0], &pt->ctrl1[1]);
      _to_input(json_array_get_double_element(c, 4), json_array_get_double_element(c, 5), &pt->ctrl2[0], &pt->ctrl2[1]);
      pt->border[0] = pt->border[1] = feather;
      pt->state = DT_MASKS_POINT_STATE_USER;
      f->points = g_list_append(f->points, pt);
    }
    // the name keeps which component a path belongs to, and whether it is a
    // hole, for reading the component back
    const gboolean hole = json_object_get_boolean_member_with_default(po, "hole", FALSE);
    g_snprintf(f->name, sizeof(f->name), "%s%s #%u.%u%s%s%s", _MASK_PREFIX, name, k + 1, i + 1, tag, mark,
               hole ? "-" : "");
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
    gp->formid = f->formid;
    gp->parentid = grp->formid;
    gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    // a hole takes away from the object; a subtracted object's outline
    // takes away from the mask
    if(!*bottom)
      gp->state |= (hole != subtract) ? DT_MASKS_STATE_DIFFERENCE : DT_MASKS_STATE_UNION;
    if(off) gp->state |= DT_MASKS_STATE_DISABLE;
    gp->opacity = 1.0f;
    grp->points = g_list_append(grp->points, gp);
    if(!off) *bottom = FALSE;
    any = TRUE;
  }
  return any;
}

static void _set_channel(dt_develop_blend_params_t *bp, const int ch, const float lim[4], const gboolean invert);

// component k's backdrop: a parametric shape taking hz window `range` out,
// named "#k~", or "#k~off" turned off, intersecting what is in `grp` so
// far, or `disabled`. darktable evaluates a parametric shape with the
// module's blend parameters (masks/parametric.c), which never invert it
// (_apply_ranges), so its own channel takes the color out
static void _backdrop_shape(dt_masks_form_t *grp, JsonArray *range, const char *name, const guint k,
                            const gboolean turned_off, const gboolean disabled)
{
  dt_develop_blend_params_t bp = { 0 };
  float lim[4];
  for(int i = 0; i < 4; i++) lim[i] = CLAMP(json_array_get_double_element(range, i), 0.0, 1.0);
  _set_channel(&bp, DEVELOP_BLENDIF_hz_in, lim, TRUE);
  dt_masks_form_t *f = dt_masks_create(DT_MASKS_PARAMETRIC);
  dt_masks_point_parametric_t *pp = calloc(1, sizeof(dt_masks_point_parametric_t));
  pp->blendif = bp.blendif;
  memcpy(pp->blendif_parameters, bp.blendif_parameters, sizeof(pp->blendif_parameters));
  memcpy(pp->blendif_boost_factors, bp.blendif_boost_factors, sizeof(pp->blendif_boost_factors));
  pp->colorspace = DEVELOP_BLEND_CS_RGB_SCENE;
  // the channel darktable's mask panel shows it as
  const dt_iop_gui_blendif_channel_t *chans = dt_develop_blendif_channels_for_csp(DEVELOP_BLEND_CS_RGB_SCENE);
  for(int c = 0; chans && chans[c].label; c++)
    if(chans[c].param_channels[0] == DEVELOP_BLENDIF_hz_in) pp->channel = c;
  f->points = g_list_append(f->points, pp);
  g_snprintf(f->name, sizeof(f->name), "%s%s #%u~%s", _MASK_PREFIX, name, k + 1, turned_off ? "off" : "");
  _s.dev.forms = g_list_append(_s.dev.forms, f);
  dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
  gp->formid = f->formid;
  gp->parentid = grp->formid;
  gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_INTERSECTION;
  if(disabled) gp->state |= DT_MASKS_STATE_DISABLE;
  gp->opacity = 1.0f;
  grp->points = g_list_append(grp->points, gp);
}

// a component's backdrop shape, "#k~" or "#k~off"
static gboolean _is_backdrop_shape(const dt_masks_form_t *f)
{
  const char *hash = strrchr(f->name, '#');
  return (f->type & DT_MASKS_PARAMETRIC) && hash && strchr(hash, '~');
}

// an "object" component's paths as darktable path shapes, appended to `grp`.
// with a `backdrop` {range, paths, plain} (_backdrop), as the mask's first
// shape: its edge outline, less the backdrop's color, or its outline inset
// a whole feather, whose feather ends at the edge. the edge's feather ends
// at the color, and the subject keeps the inset outline's mask.
// darktable's group folds in list order, union by max and intersection by
// min (masks/group.c), so the edge outline goes first, then the backdrop
// shape, then the inset outline. anywhere else the backdrop shape would
// take the color out of the shapes before it, so there, or turned `off`,
// the plain outline "#k.i^" serves, as a selection without a backdrop
// would be traced. the parts not used are kept disabled, so turning it
// back on, or moving the shape first, finds them
static gboolean _object_shapes(dt_masks_form_t *grp, JsonObject *o, const char *name, const guint k,
                               const gboolean first, char **err)
{
  JsonArray *paths = json_object_has_member(o, "paths") ? json_object_get_array_member(o, "paths") : NULL;
  const gboolean subtract = !g_strcmp0(json_object_get_string_member_with_default(o, "mode", "add"), "subtract");
  const float feather = CLAMP(json_object_get_double_member_with_default(o, "feather", _OBJECT_FEATHER), 0.0, 0.1);
  // a Depth Range's band rides along in the names, as nothing else in
  // darktable's shapes can carry it
  JsonArray *depth = json_object_has_member(o, "depth") ? json_object_get_array_member(o, "depth") : NULL;
  gchar tag[3 * G_ASCII_DTOSTR_BUF_SIZE + 4] = "";
  if(depth && json_array_get_length(depth) == 2)
  {
    gchar lo[G_ASCII_DTOSTR_BUF_SIZE], hi[G_ASCII_DTOSTR_BUF_SIZE], fe[G_ASCII_DTOSTR_BUF_SIZE];
    g_ascii_formatd(lo, sizeof(lo), "%.3f", json_array_get_double_element(depth, 0));
    g_ascii_formatd(hi, sizeof(hi), "%.3f", json_array_get_double_element(depth, 1));
    g_ascii_formatd(fe, sizeof(fe), "%.4f", feather);
    g_snprintf(tag, sizeof(tag), "@%s,%s,%s", lo, hi, fe);
  }
  JsonObject *bd = json_object_has_member(o, "backdrop") ? json_object_get_object_member(o, "backdrop") : NULL;
  JsonArray *range = bd && json_object_has_member(bd, "range") ? json_object_get_array_member(bd, "range") : NULL;
  JsonArray *edge = bd && json_object_has_member(bd, "paths") ? json_object_get_array_member(bd, "paths") : NULL;
  JsonArray *plain = bd && json_object_has_member(bd, "plain") ? json_object_get_array_member(bd, "plain") : NULL;
  const gboolean off = bd && json_object_get_boolean_member_with_default(bd, "off", FALSE);
  gboolean bottom = first;
  gboolean any;
  if(range && json_array_get_length(range) == 4 && edge && json_array_get_length(edge))
  {
    // a backdrop made before the plain outline was kept has none: its
    // inset outline stands in
    const gboolean use = first && !subtract && !depth && !off;
    const gboolean have_plain = plain && json_array_get_length(plain);
    _object_paths(grp, edge, name, k, tag, "~", feather, subtract, !use, &bottom);
    _backdrop_shape(grp, range, name, k, off, !use);
    any = _object_paths(grp, paths, name, k, tag, "", feather, subtract, !use && have_plain, &bottom);
    if(have_plain) any |= _object_paths(grp, plain, name, k, tag, "^", feather, subtract, use, &bottom);
  }
  else
    any = _object_paths(grp, paths, name, k, tag, "", feather, subtract, FALSE, &bottom);
  if(!any) *err = g_strdup("an object component needs paths");
  return any;
}

// a path just beyond the input image's edges, first in `grp`, named "#0"
// so reading the mask back passes over it
static void _base_shape(dt_masks_form_t *grp, const char *name)
{
  static const float corners[4][2] = { { -0.1f, -0.1f }, { 1.1f, -0.1f }, { 1.1f, 1.1f }, { -0.1f, 1.1f } };
  dt_masks_form_t *f = dt_masks_create(DT_MASKS_PATH);
  for(int j = 0; j < 4; j++)
  {
    dt_masks_point_path_t *pt = calloc(1, sizeof(dt_masks_point_path_t));
    pt->corner[0] = pt->ctrl1[0] = pt->ctrl2[0] = corners[j][0];
    pt->corner[1] = pt->ctrl1[1] = pt->ctrl2[1] = corners[j][1];
    pt->state = DT_MASKS_POINT_STATE_USER;
    f->points = g_list_append(f->points, pt);
  }
  g_snprintf(f->name, sizeof(f->name), "%s%s #0", _MASK_PREFIX, name);
  _s.dev.forms = g_list_append(_s.dev.forms, f);
  dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
  gp->formid = f->formid;
  gp->parentid = grp->formid;
  gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
  gp->opacity = 1.0f;
  grp->points = g_list_append(grp->points, gp);
}

// a mask's whole-frame base, from _base_shape()
static gboolean _is_base_shape(const dt_masks_form_t *f)
{
  return g_str_has_suffix(f->name, " #0");
}

// the shapes that narrow a mask as darktable's parametric masks, rather
// than drawing it: they go into the instances' blend parameters
static gboolean _is_range(const char *type)
{
  return !g_strcmp0(type, "luminance") || !g_strcmp0(type, "color") || !g_strcmp0(type, "parametric");
}

static void _combined_member_changed(const dt_masks_form_t *root, const gboolean removed);
static void _ranges_into(dt_develop_blend_params_t *bp, JsonArray *list);

// the ranges `list` of mask `root` as its ranges group (_RANGES_PREFIX):
// one parametric element per channel, as darktable converts a classic
// mask's channels (migrate_legacy.c, _build_channel_forms), multiplied
// together and into `root`'s shapes when it has any. without ranges the
// group is left unnamed and empty, for _free_unreached()
static void _set_ranges_group(dt_masks_form_t *root, JsonArray *list)
{
  dt_develop_blend_params_t bp = { 0 };
  _ranges_into(&bp, list);
  dt_masks_form_t *grp = _ranges_group(root);
  if(!bp.blendif)
  {
    if(grp)
    {
      g_list_free_full(grp->points, free);
      grp->points = NULL;
      grp->name[0] = '\0';
    }
    return;
  }
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_snprintf(grp->name, sizeof(grp->name), "%s%s", _RANGES_PREFIX, root->name);
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  g_list_free_full(grp->points, free);
  // cleared first: the marker's new id is checked against every group's
  // points in the forms, this one's included (masks.c, _id_taken)
  grp->points = NULL;
  grp->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, grp, DT_MASKS_STATE_FLEXI_PRODUCT));
  if(_has_members(root))
    _member(grp, root->formid, DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_UNION, 1.0f);
  const dt_iop_gui_blendif_channel_t *chans = dt_develop_blendif_channels_for_csp(DEVELOP_BLEND_CS_RGB_SCENE);
  for(int c = 0; chans && chans[c].label; c++)
  {
    const uint32_t bits = (1u << chans[c].param_channels[0]) | (1u << chans[c].param_channels[1]);
    if(!(bp.blendif & bits)) continue;
    dt_masks_form_t *f = dt_masks_create(DT_MASKS_PARAMETRIC);
    dt_masks_point_parametric_t *p = calloc(1, sizeof(dt_masks_point_parametric_t));
    p->blendif = bp.blendif & (bits | (bits << 16));
    memcpy(p->blendif_parameters, bp.blendif_parameters, 4 * DEVELOP_BLENDIF_SIZE * sizeof(float));
    memcpy(p->blendif_boost_factors, bp.blendif_boost_factors, DEVELOP_BLENDIF_SIZE * sizeof(float));
    p->colorspace = DEVELOP_BLEND_CS_RGB_SCENE;
    p->channel = c;
    f->points = g_list_append(NULL, p);
    dt_masks_assign_unique_name(&_s.dev, f);
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    _member(grp, f->formid, DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_UNION, 1.0f);
  }
}

// whether instance `m` inverts its mask: as Immage sets it, as classic
// darktable inverted a drawn and parametric mask, or as darktable's
// conversion of an older edit leaves a group one module renders, on the
// group (migrate_legacy.c, _move_history_polarity)
static gboolean _instance_inverted(const dt_iop_module_t *m)
{
  const dt_develop_blend_params_t *bp = m->blend_params;
  if(bp->mask_combine & (DEVELOP_COMBINE_INV | DEVELOP_COMBINE_MASKS_POS)) return TRUE;
  const dt_masks_form_t *g = dt_masks_get_from_id(&_s.dev, bp->mask_id);
  const dt_masks_point_group_t *mk = g && (g->type & DT_MASKS_GROUP) ? dt_masks_group_marker(g) : NULL;
  return mk && (mk->state & DT_MASKS_STATE_OP_INVERT);
}

// the dt_dev_pixelpipe_cache_invalidate_later of every pipe the engine runs
void masks_invalidate_from(const int order, const char *why)
{
  dt_dev_pixelpipe_cache_invalidate_later(&_s.pipe, order, why);
  if(_s.ppipe_ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, order, why);
  if(_s.drag.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.drag.pipe, order, why);
  if(_s.base.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.base.pipe, order, why);
}

// Disabled, marker-only groups carry recipe chunks in ordinary mask history/XMP.
// They render nothing, and avoid a separate metadata store drifting from history.
#define _AI_RECIPE "immage-ai-v1:"
static void _recipe_coordinates(JsonObject *o, void (*transform)(float, float, float *, float *))
{
  JsonArray *points = json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
  if(points)
  {
    JsonArray *to = json_array_new();
    for(guint i = 0; i < json_array_get_length(points); i++)
    {
      JsonArray *point = json_array_get_array_element(points, i);
      if(!point || json_array_get_length(point) != 3) continue;
      float x, y;
      transform(json_array_get_double_element(point, 0), json_array_get_double_element(point, 1), &x, &y);
      JsonArray *v = json_array_new();
      json_array_add_double_element(v, x); json_array_add_double_element(v, y);
      json_array_add_double_element(v, json_array_get_double_element(point, 2));
      json_array_add_array_element(to, v);
    }
    json_object_set_array_member(o, "points", to);
  }
  JsonArray *box = json_object_has_member(o, "box") ? json_object_get_array_member(o, "box") : NULL;
  if(box && json_array_get_length(box) == 4)
  {
    float x0, y0, x1, y1;
    transform(json_array_get_double_element(box, 0), json_array_get_double_element(box, 1), &x0, &y0);
    transform(json_array_get_double_element(box, 2), json_array_get_double_element(box, 3), &x1, &y1);
    JsonArray *to = json_array_new();
    json_array_add_double_element(to, MIN(x0,x1)); json_array_add_double_element(to, MIN(y0,y1));
    json_array_add_double_element(to, MAX(x0,x1)); json_array_add_double_element(to, MAX(y0,y1));
    json_object_set_array_member(o, "box", to);
  }
}

static void _store_recipes(dt_masks_form_t *grp, JsonArray *shapes)
{
  for(guint k = 0; shapes && k < json_array_get_length(shapes); k++)
  {
    JsonObject *shape = json_array_get_object_element(shapes, k);
    if(!json_object_has_member(shape, "ai")) continue;
    // Copy deeply: coordinate conversion must not mutate the incoming request.
    gchar *original = json_to_string(json_object_get_member(shape, "ai"), FALSE);
    JsonNode *copy = json_from_string(original, NULL);
    g_free(original);
    if(!copy || !JSON_NODE_HOLDS_OBJECT(copy)) { if(copy) json_node_free(copy); continue; }
    _recipe_coordinates(json_node_get_object(copy), _to_input);
    gchar *json = json_to_string(copy, FALSE);
    gchar *encoded = g_base64_encode((const guchar *)json, strlen(json));
    for(guint offset = 0, chunk = 0; offset < strlen(encoded); offset += 80, chunk++)
    {
      dt_masks_form_t *f = dt_masks_create(DT_MASKS_GROUP);
      g_snprintf(f->name, sizeof(f->name), _AI_RECIPE "%u:%u:%.80s", k + 1, chunk, encoded + offset);
      _s.dev.forms = g_list_append(_s.dev.forms, f);
      f->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, f, 0));
      _member(grp, f->formid, DT_MASKS_STATE_USE | DT_MASKS_STATE_DISABLE | DT_MASKS_STATE_UNION, 1.0f);
    }
    g_free(encoded); g_free(json); json_node_free(copy);
  }
}

// replace the shapes of mask `name` (made when missing); each shape adds
// to the mask, or with "subtract" takes away from it
gboolean masks_mask(const char *name, JsonArray *shapes, char **err)
{
  dt_masks_form_t *grp = _mask_group(name);
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_snprintf(grp->name, sizeof(grp->name), "%s%s", _MASK_PREFIX, name);
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  // the old shapes go, whatever darktable made of an older edit; a mask is
  // small, and redrawing it whole keeps the client the only owner of its
  // geometry
  GHashTable *old = _mask_forms(grp);
  g_hash_table_remove(old, grp);
  // its instances, and whether each inverts it, as they had it
  GPtrArray *users = g_ptr_array_new();
  GArray *inverts = g_array_new(FALSE, FALSE, sizeof(gboolean));
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(masks_instance_group(m) != grp) continue;
    const gboolean inv = _instance_inverted(m);
    g_ptr_array_add(users, m);
    g_array_append_val(inverts, inv);
  }
  _combined_adopt(grp);
  g_list_free_full(grp->points, free);
  grp->points = NULL;

  // range components are not shapes: they multiply into them
  JsonArray *ranges = json_array_new();
  gboolean ok = TRUE;
  guint drawn = 0;
  // a shape taking away before any adds takes from the whole image, as it
  // does when only ranges come first; darktable's group starts from its
  // first shape, so the whole frame goes in as that
  for(guint k = 0; shapes && k < json_array_get_length(shapes); k++)
  {
    JsonObject *o = json_array_get_object_element(shapes, k);
    const char *type = json_object_get_string_member_with_default(o, "type", "");
    if(_is_range(type)) continue;
    if(!g_strcmp0(json_object_get_string_member_with_default(o, "mode", "add"), "subtract"))
    {
      _base_shape(grp, name);
      drawn++;
    }
    break;
  }
  for(guint k = 0; ok && shapes && k < json_array_get_length(shapes); k++)
  {
    JsonObject *o = json_array_get_object_element(shapes, k);
    const char *type = json_object_get_string_member_with_default(o, "type", "");
    if(_is_range(type))
    {
      json_array_add_object_element(ranges, json_object_ref(o));
      continue;
    }
    if(!g_strcmp0(type, "object"))
    {
      ok = _object_shapes(grp, o, name, k, drawn == 0, err);
      drawn++;
      continue;
    }
    dt_masks_form_t *f = _shape(o, err);
    if(!f)
    {
      ok = FALSE;
      break;
    }
    g_snprintf(f->name, sizeof(f->name), "%s%s #%u", _MASK_PREFIX, name, k + 1);
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    dt_masks_point_group_t *pt = calloc(1, sizeof(dt_masks_point_group_t));
    pt->formid = f->formid;
    pt->parentid = grp->formid;
    pt->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    if(drawn++ > 0)
      pt->state |= !g_strcmp0(json_object_get_string_member_with_default(o, "mode", "add"), "subtract")
        ? DT_MASKS_STATE_DIFFERENCE : DT_MASKS_STATE_UNION;
    pt->opacity = json_object_get_double_member_with_default(o, "opacity", 1.0);
    pt->group_opacity = 1.0f;
    grp->points = g_list_append(grp->points, pt);
  }

  // the shapes as a classic group lists them, folded as darktable converts
  // one: where the operator changes, what comes before becomes a group of
  // its own (dt_masks_group_mark_classic_runs)
  dt_masks_group_mark_classic_runs(&_s.dev.forms, grp, NULL);
  if(!dt_masks_group_marker(grp)) grp->points = g_list_prepend(grp->points, dt_masks_marker_new(_s.dev.forms, grp, 0));
  _store_recipes(grp, shapes);
  _set_ranges_group(grp, ranges);
  json_array_unref(ranges);

  // the instances using it take the new shapes and ranges into their history
  for(guint i = 0; i < users->len; i++)
    _apply_ranges(g_ptr_array_index(users, i), grp, g_array_index(inverts, gboolean, i));
  _free_unreached(old);
  for(guint i = 0; i < users->len; i++)
  {
    dt_iop_module_t *m = g_ptr_array_index(users, i);
    dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    // a piece's cache hash takes its mask's shapes from darktable.develop
    // (imageop.c, dt_iop_commit_params), which is not this engine's
    // develop, so a reshaped mask would be served the old render
    masks_invalidate_from(m->iop_order, "mask ");
  }
  g_ptr_array_free(users, TRUE);
  g_array_free(inverts, TRUE);
  _combined_member_changed(grp, FALSE);
  session_changed(DT_DEV_PIPE_SYNCH);
  return ok;
}

// a combined mask's members holding an empty mask are disabled: classic's
// group folded an empty one as nothing, where a flexi group would take it
// as the whole image (masks/group.c). TRUE when that changed
static gboolean _combined_sync(dt_masks_form_t *grp)
{
  gboolean changed = FALSE;
  for(GList *p = grp->points; p; p = g_list_next(p))
  {
    dt_masks_point_group_t *pt = p->data;
    const dt_masks_form_t *f = dt_masks_point_is_marker(pt) ? NULL : dt_masks_get_from_id(&_s.dev, pt->formid);
    if(!_is_root(f)) continue;
    const int state = _has_members(f) ? pt->state & ~DT_MASKS_STATE_DISABLE : pt->state | DT_MASKS_STATE_DISABLE;
    changed |= state != pt->state;
    pt->state = state;
  }
  return changed;
}

// whether a combined mask has a member to fold
static gboolean _combined_live(const dt_masks_form_t *grp)
{
  for(const GList *p = grp->points; p; p = g_list_next(p))
  {
    const dt_masks_point_group_t *pt = p->data;
    if(!dt_masks_point_is_marker(pt) && !(pt->state & DT_MASKS_STATE_DISABLE)) return TRUE;
  }
  return FALSE;
}

// the instances combined mask `grp` drives, after its members changed:
// with `record`, into history (the group's new members with them), after
// the forms in `old` nothing uses any more go (_free_unreached). with no
// members left they are switched off, since a group without any lets them
// work on the whole image. their cachelines go: all those after
// the first instance of each one's module, not just from the instance on,
// because a new mask's instance, put after the anchor or (denoise) after
// that first instance, moves them later, and a line left at an old
// iop_order has the same hash (neither the members nor the position are in
// it). the first instance's own line stays; for color balance rgb that is
// the anchor
static void _combined_refresh(dt_masks_form_t *grp, const gboolean record, GHashTable *old)
{
  const gboolean live = _combined_live(grp);
  int order = INT_MAX;
  GPtrArray *users = g_ptr_array_new();
  GArray *write = g_array_new(FALSE, FALSE, sizeof(gboolean));
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(masks_instance_group(m) != grp) continue;
    const dt_iop_module_t *first = dt_iop_get_module_by_op_priority(_s.dev.iop, m->op, 0);
    order = MIN(order, first && first != m ? first->iop_order + 1 : m->iop_order);
    const gboolean off = !live && m->enabled;
    if(off) m->enabled = FALSE;
    if(record) _apply_ranges(m, grp, FALSE);
    const gboolean w = off || record;
    g_ptr_array_add(users, m);
    g_array_append_val(write, w);
  }
  if(old) _free_unreached(old);
  for(guint i = 0; i < users->len; i++)
  {
    dt_iop_module_t *m = g_ptr_array_index(users, i);
    if(g_array_index(write, gboolean, i)) dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  }
  g_ptr_array_free(users, TRUE);
  g_array_free(write, TRUE);
  if(order != INT_MAX) masks_invalidate_from(order, "combine ");
}

// mask `root` reshaped, or with `removed` deleted: the combined masks
// holding it let go of it, and their instances render again. a reshape
// needs no history of their own, the mask's own instances carry the
// shapes, unless it left a member empty or filled one (_combined_sync)
static void _combined_member_changed(const dt_masks_form_t *root, const gboolean removed)
{
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *grp = l->data;
    if(!(grp->type & DT_MASKS_GROUP) || !g_str_has_prefix(grp->name, _COMBINED_PREFIX)) continue;
    gboolean held = FALSE;
    for(GList *p = grp->points; p;)
    {
      GList *next = g_list_next(p);
      dt_masks_point_group_t *pt = p->data;
      if(_holds_mask(pt, root))
      {
        held = TRUE;
        if(removed)
        {
          grp->points = g_list_delete_link(grp->points, p);
          free(pt);
        }
      }
      p = next;
    }
    if(!held) continue;
    const gboolean changed = _combined_sync(grp);
    _combined_refresh(grp, removed || changed, NULL);
  }
}

// replace combined mask `name`'s members (made when missing): each
// {mask, opacity 0-1, invert}. the members are the masks' own groups, which
// stay theirs; only the references go. `ranges`, the range components the
// members all have, multiply into the sum (_set_ranges_group)
gboolean masks_combine(const char *name, JsonArray *members, JsonArray *ranges, char **err)
{
  for(guint k = 0; members && k < json_array_get_length(members); k++)
  {
    JsonObject *o = json_array_get_object_element(members, k);
    const char *mask = json_object_get_string_member_with_default(o, "mask", NULL);
    if(!mask || !_mask_group(mask))
    {
      *err = g_strdup_printf("no mask '%s'", mask ? mask : "(none)");
      return FALSE;
    }
  }
  dt_masks_form_t *grp = _combined_group(name);
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_snprintf(grp->name, sizeof(grp->name), "%s%s", _COMBINED_PREFIX, name);
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  GHashTable *old = _mask_forms(grp);
  g_hash_table_remove(old, grp);
  g_list_free_full(grp->points, free);
  grp->points = NULL; // as in _set_ranges_group(), before the marker's id is chosen
  // the first member goes onto the fold's empty start, and the rest add to
  // it, up to 1 (masks/group.c)
  grp->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, grp, DT_MASKS_STATE_FLEXI_SUM));
  for(guint k = 0; members && k < json_array_get_length(members); k++)
  {
    JsonObject *o = json_array_get_object_element(members, k);
    const dt_masks_form_t *mg = _mask_group(json_object_get_string_member(o, "mask"));
    int state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    if(json_object_get_boolean_member_with_default(o, "invert", FALSE)) state |= DT_MASKS_STATE_INVERSE;
    _member(grp, mg->formid, state, CLAMP(json_object_get_double_member_with_default(o, "opacity", 1.0), 0.0, 1.0));
  }
  _combined_sync(grp);
  _set_ranges_group(grp, ranges);
  _combined_refresh(grp, TRUE, old);
  session_changed(DT_DEV_PIPE_SYNCH);
  return TRUE;
}

// the reverse of _to_input(): an input point as a point of the shown image
static void _to_shown(const float ix, const float iy, float *x, float *y)
{
  float p[2] = { ix * _s.pipe.iwidth, iy * _s.pipe.iheight };
  dt_dev_distort_transform_plus(&_s.dev, &_s.pipe, 0, DT_DEV_TRANSFORM_DIR_ALL, p, 1);
  *x = p[0] / _s.pipe.processed_width;
  *y = p[1] / _s.pipe.processed_height;
}

// an input vector at an input point, as length (in shown pixels) and angle
// (degrees, clockwise) in the shown image
static void _to_shown_vec(const float ix, const float iy, const float dx, const float dy,
                          float *len, float *angle)
{
  float ax, ay, bx, by;
  _to_shown(ix, iy, &ax, &ay);
  _to_shown(ix + dx / _s.pipe.iwidth, iy + dy / _s.pipe.iheight, &bx, &by);
  const float vx = (bx - ax) * _s.pipe.processed_width, vy = (by - ay) * _s.pipe.processed_height;
  *len = hypotf(vx, vy);
  *angle = atan2f(vy, vx) * 180.0f / M_PI;
}

void masks_add_num(JsonBuilder *b, const char *name, const double v)
{
  json_builder_set_member_name(b, name);
  json_builder_add_double_value(b, v);
}

// one shape as _shape() takes it
static void _shape_json(JsonBuilder *b, const dt_masks_form_t *f, const gboolean subtract)
{
  const float pw = _s.pipe.processed_width;
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "mode");
  json_builder_add_string_value(b, subtract ? "subtract" : "add");
  float x, y, len, ang;
  if((f->type & DT_MASKS_ELLIPSE) && f->points)
  {
    const dt_masks_point_ellipse_t *e = f->points->data;
    const float k = e->flags & DT_MASKS_ELLIPSE_PROPORTIONAL ? 1.0f + e->border
      : 1.0f + e->border / fmaxf(1e-6f, fminf(e->radius[0], e->radius[1]));
    const float r = e->rotation * M_PI / 180.0f;
    _to_shown(e->center[0], e->center[1], &x, &y);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "ellipse");
    masks_add_num(b, "x", x);
    masks_add_num(b, "y", y);
    _to_shown_vec(e->center[0], e->center[1], e->radius[0] * imin * cosf(r), e->radius[0] * imin * sinf(r), &len, &ang);
    masks_add_num(b, "rx", len * k / pw);
    masks_add_num(b, "angle", ang);
    _to_shown_vec(e->center[0], e->center[1], -e->radius[1] * imin * sinf(r), e->radius[1] * imin * cosf(r), &len, &ang);
    masks_add_num(b, "ry", len * k / pw);
    masks_add_num(b, "feather", 1.0f - 1.0f / k);
  }
  else if((f->type & DT_MASKS_GRADIENT) && f->points)
  {
    const dt_masks_point_gradient_t *g = f->points->data;
    const float a = (90.0f - g->rotation) * M_PI / 180.0f;
    _to_shown(g->anchor[0], g->anchor[1], &x, &y);
    _to_shown_vec(g->anchor[0], g->anchor[1], cosf(a) * 10.0f, sinf(a) * 10.0f, &len, &ang);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "gradient");
    masks_add_num(b, "x", x);
    masks_add_num(b, "y", y);
    masks_add_num(b, "angle", ang);
    masks_add_num(b, "width", g->compression * 2.0f * hypotf(_s.pipe.iwidth, _s.pipe.iheight)
                         / hypotf(pw, _s.pipe.processed_height));
  }
  else if((f->type & DT_MASKS_BRUSH) && f->points)
  {
    const dt_masks_point_brush_t *p0 = f->points->data;
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "brush");
    _to_shown_vec(p0->corner[0], p0->corner[1], p0->border[0] * imin, 0.0f, &len, &ang);
    masks_add_num(b, "size", 2.0f * len / pw);
    masks_add_num(b, "hardness", p0->hardness);
    masks_add_num(b, "density", p0->density);
    json_builder_set_member_name(b, "points");
    json_builder_begin_array(b);
    for(const GList *l = f->points; l; l = g_list_next(l))
    {
      const dt_masks_point_brush_t *pt = l->data;
      _to_shown(pt->corner[0], pt->corner[1], &x, &y);
      json_builder_begin_array(b);
      json_builder_add_double_value(b, x);
      json_builder_add_double_value(b, y);
      json_builder_end_array(b);
    }
    json_builder_end_array(b);
  }
  json_builder_end_object(b);
}

// ------------------------------------------------------------ heal and clone
// Lightroom's Heal and Clone spots, as darktable's retouch module keeps
// them: shapes in the module's mask group, each with its source (where it
// copies from) in the shape, and its algorithm in the module's rt_forms.
// the client edits heal and clone on the whole image; what else an edit
// made in darktable holds (blur, fill, wavelet scales) is left as it was
#define _SPOTS_GROUP "immage spots"

// the retouch module's mask group, or one of ours not yet attached
static dt_masks_form_t *_spots_group(const dt_iop_module_t *m)
{
  dt_masks_form_t *grp = m->blend_params ? dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id) : NULL;
  if(grp && (grp->type & DT_MASKS_GROUP)) return grp;
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    dt_masks_form_t *f = l->data;
    if((f->type & DT_MASKS_GROUP) && !g_strcmp0(f->name, _SPOTS_GROUP))
      return f;
  }
  return NULL;
}

// rt_forms in the module's params: where it starts, its elements' size and
// their number, from introspection, as the struct is private to retouch.c
static uint8_t *_rt_forms(dt_iop_module_t *m, size_t *size, size_t *count)
{
  dt_introspection_field_t *f = m->so->have_introspection ? m->get_f("rt_forms") : NULL;
  if(!f || f->header.type != DT_INTROSPECTION_TYPE_ARRAY) return NULL;
  *count = f->Array.count;
  *size = f->Array.field->header.size;
  return (uint8_t *)m->params + f->header.offset;
}

// the rt_forms index of a shape, -1 when it has none; with `ours`, whether
// it is a spot the client edits: heal or clone, on the whole image
static int _rt_index(dt_iop_module_t *m, const size_t count, const dt_mask_id_t formid, gboolean *ours,
                     char **err)
{
  gchar field[64];
  for(size_t k = 0; k < count; k++)
  {
    double id = 0, algo = 0, scale = 0;
    g_snprintf(field, sizeof(field), "rt_forms[%zu].formid", k);
    if(!session_read_field(m, field, FALSE, &id, err)) return -1;
    if((int)id != formid) continue;
    g_snprintf(field, sizeof(field), "rt_forms[%zu].algorithm", k);
    if(!session_read_field(m, field, FALSE, &algo, err)) return -1;
    g_snprintf(field, sizeof(field), "rt_forms[%zu].scale", k);
    if(!session_read_field(m, field, FALSE, &scale, err)) return -1;
    // retouch's algorithm enum: clone 1, heal 2
    *ours = (algo == 1 || algo == 2) && scale == 0;
    return k;
  }
  return -1;
}

// one spot from the client, in shown-image units:
//   circle: x, y, r (radius, a fraction of the shown width)
//   brush:  points [[x, y], ...], size (diameter, a fraction of the width)
// both: sx, sy (where the center, or the first point, copies from),
// feather (0-1)
static dt_masks_form_t *_spot_shape(JsonObject *o, char **err)
{
  const char *type = json_object_get_string_member_with_default(o, "type", "circle");
  const float feather = CLAMP(json_object_get_double_member_with_default(o, "feather", 0.5), 0.0, 0.95);
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);
  const float sx = json_object_get_double_member_with_default(o, "sx", 0.5);
  const float sy = json_object_get_double_member_with_default(o, "sy", 0.5);
  dt_masks_form_t *f = NULL;
  if(!g_strcmp0(type, "brush"))
  {
    JsonArray *pts = json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
    const guint n = pts ? json_array_get_length(pts) : 0;
    if(n < 2)
    {
      *err = g_strdup("a brush spot needs two points or more");
      return NULL;
    }
    JsonArray *p0 = json_array_get_array_element(pts, 0);
    float len, ang;
    _to_input_vec(json_array_get_double_element(p0, 0), json_array_get_double_element(p0, 1),
                  json_object_get_double_member_with_default(o, "size", 0.05) / 2.0f, 0.0f, &len, &ang);
    const float border = MAX(0.0005f, len / imin);
    f = dt_masks_create(DT_MASKS_BRUSH | DT_MASKS_CLONE);
    for(guint k = 0; k < n; k++)
    {
      JsonArray *p = json_array_get_array_element(pts, k);
      dt_masks_point_brush_t *b = calloc(1, sizeof(dt_masks_point_brush_t));
      _to_input(json_array_get_double_element(p, 0), json_array_get_double_element(p, 1),
                &b->corner[0], &b->corner[1]);
      b->ctrl1[0] = b->ctrl2[0] = b->corner[0];
      b->ctrl1[1] = b->ctrl2[1] = b->corner[1];
      b->border[0] = b->border[1] = border;
      b->hardness = 1.0f - feather;
      b->density = 1.0f;
      b->state = DT_MASKS_POINT_STATE_NORMAL;
      f->points = g_list_append(f->points, b);
    }
  }
  else
  {
    const float x = json_object_get_double_member_with_default(o, "x", 0.5);
    const float y = json_object_get_double_member_with_default(o, "y", 0.5);
    float len, ang;
    _to_input_vec(x, y, json_object_get_double_member_with_default(o, "r", 0.02), 0.0f, &len, &ang);
    f = dt_masks_create(DT_MASKS_CIRCLE | DT_MASKS_CLONE);
    dt_masks_point_circle_t *c = calloc(1, sizeof(dt_masks_point_circle_t));
    _to_input(x, y, &c->center[0], &c->center[1]);
    // feathered inward, as Lightroom's: darktable's border lies outside
    c->radius = MAX(0.001f, len * (1.0f - feather) / imin);
    c->border = MAX(0.001f, len * feather / imin);
    f->points = g_list_append(f->points, c);
  }
  _to_input(sx, sy, &f->source[0], &f->source[1]);
  return f;
}

gboolean masks_spots_set(JsonArray *spots, char **err)
{
  dt_iop_module_t *m = session_module("retouch", err);
  if(!m) return FALSE;
  size_t esize = 0, count = 0;
  uint8_t *rt = _rt_forms(m, &esize, &count);
  if(!rt)
  {
    *err = g_strdup("retouch has no rt_forms");
    return FALSE;
  }
  dt_masks_form_t *grp = _spots_group(m);
  if(!grp)
  {
    grp = dt_masks_create(DT_MASKS_GROUP);
    g_strlcpy(grp->name, _SPOTS_GROUP, sizeof(grp->name));
    _s.dev.forms = g_list_append(_s.dev.forms, grp);
  }
  // the spots the client edits go, to be made again; the others stay, in
  // their order, their rt_forms entries kept whole
  uint8_t *kept = g_malloc0(esize * count);
  size_t nk = 0;
  GList *keep = NULL;
  for(GList *l = grp->points; l; l = g_list_next(l))
  {
    dt_masks_point_group_t *gp = l->data;
    dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, gp->formid);
    gboolean ours = TRUE;
    const int k = f ? _rt_index(m, count, gp->formid, &ours, err) : -1;
    // darktable's ellipse and path spots are not the client's to edit
    ours = ours && f && (f->type & (DT_MASKS_CIRCLE | DT_MASKS_BRUSH));
    if(*err)
    {
      g_free(kept);
      g_list_free(keep);
      return FALSE;
    }
    if(k >= 0 && !ours && nk < count)
    {
      memcpy(kept + nk++ * esize, rt + k * esize, esize);
      keep = g_list_append(keep, gp);
      continue;
    }
    if(f)
    {
      _s.dev.forms = g_list_remove(_s.dev.forms, f);
      dt_masks_free_form(f);
    }
    free(gp);
  }
  g_list_free(grp->points);
  grp->points = keep;
  memset(rt, 0, esize * count);
  memcpy(rt, kept, esize * nk);
  g_free(kept);

  const guint n = MIN(json_array_get_length(spots), count - nk);
  for(guint k = 0; k < n; k++)
  {
    JsonObject *o = json_array_get_object_element(spots, k);
    dt_masks_form_t *f = _spot_shape(o, err);
    if(!f) return FALSE;
    g_snprintf(f->name, sizeof(f->name), "immage spot #%u", k + 1);
    _s.dev.forms = g_list_append(_s.dev.forms, f);
    dt_masks_point_group_t *gp = calloc(1, sizeof(dt_masks_point_group_t));
    gp->formid = f->formid;
    gp->parentid = grp->formid;
    gp->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE;
    if(grp->points) gp->state |= DT_MASKS_STATE_UNION;
    gp->opacity = CLAMP(json_object_get_double_member_with_default(o, "opacity", 1.0), 0.0, 1.0);
    grp->points = g_list_append(grp->points, gp);
    const gboolean clone = !g_strcmp0(json_object_get_string_member_with_default(o, "mode", "heal"), "clone");
    gchar field[64];
    // the values of retouch's algorithm enum (clone 1, heal 2)
    const struct { const char *name; double v; } fields[] = {
      { "formid", f->formid }, { "scale", 0 }, { "algorithm", clone ? 1 : 2 }, { "distort_mode", 2 },
    };
    for(int i = 0; i < 4; i++)
    {
      g_snprintf(field, sizeof(field), "rt_forms[%zu].%s", nk + k, fields[i].name);
      if(!session_write_field(m, field, fields[i].v, err)) return FALSE;
    }
  }
  m->blend_params->mask_id = grp->formid;
  m->enabled = grp->points != NULL;
  dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  // the piece's cache hash misses the shapes, as a mask's does (see masks_mask())
  dt_dev_pixelpipe_cache_invalidate_later(&_s.pipe, m->iop_order, "spots ");
  if(_s.ppipe_ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, m->iop_order, "spots ");
  if(_s.drag.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.drag.pipe, m->iop_order, "spots ");
  if(_s.base.ok) dt_dev_pixelpipe_cache_invalidate_later(&_s.base.pipe, m->iop_order, "spots ");
  session_changed(DT_DEV_PIPE_SYNCH);
  return TRUE;
}

// the spots as _spot_shape() takes them, and whether the module is on
gboolean masks_spots_json(JsonBuilder *b, char **err)
{
  dt_iop_module_t *m = session_module("retouch", err);
  if(!m) return FALSE;
  size_t esize = 0, count = 0;
  if(!_rt_forms(m, &esize, &count))
  {
    *err = g_strdup("retouch has no rt_forms");
    return FALSE;
  }
  const dt_masks_form_t *grp = m->blend_params ? dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id) : NULL;
  const float pw = _s.pipe.processed_width;
  const float imin = MIN(_s.pipe.iwidth, _s.pipe.iheight);
  json_builder_set_member_name(b, "enabled");
  json_builder_add_boolean_value(b, m->enabled);
  json_builder_set_member_name(b, "spots");
  json_builder_begin_array(b);
  for(const GList *l = grp && (grp->type & DT_MASKS_GROUP) ? grp->points : NULL; l; l = g_list_next(l))
  {
    const dt_masks_point_group_t *gp = l->data;
    const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, gp->formid);
    if(!f || !f->points || !(f->type & (DT_MASKS_CIRCLE | DT_MASKS_BRUSH))) continue;
    // darktable's own spots too, those masks_spots_set() would remake
    gboolean ours = FALSE;
    const int k = _rt_index(m, count, f->formid, &ours, err);
    if(*err) return FALSE;
    if(k < 0 || !ours) continue;
    double algo = 0;
    gchar field[64];
    g_snprintf(field, sizeof(field), "rt_forms[%d].algorithm", k);
    if(!session_read_field(m, field, FALSE, &algo, err)) return FALSE;
    float x, y, len, ang;
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "mode");
    json_builder_add_string_value(b, algo == 1 ? "clone" : "heal");
    masks_add_num(b, "opacity", gp->opacity);
    _to_shown(f->source[0], f->source[1], &x, &y);
    masks_add_num(b, "sx", x);
    masks_add_num(b, "sy", y);
    if(f->type & DT_MASKS_CIRCLE)
    {
      const dt_masks_point_circle_t *c = f->points->data;
      const float r = c->radius + c->border;
      _to_shown(c->center[0], c->center[1], &x, &y);
      json_builder_set_member_name(b, "type");
      json_builder_add_string_value(b, "circle");
      masks_add_num(b, "x", x);
      masks_add_num(b, "y", y);
      _to_shown_vec(c->center[0], c->center[1], r * imin, 0.0f, &len, &ang);
      masks_add_num(b, "r", len / pw);
      masks_add_num(b, "feather", c->border / fmaxf(r, 1e-6f));
    }
    else if(f->type & DT_MASKS_BRUSH)
    {
      const dt_masks_point_brush_t *p0 = f->points->data;
      json_builder_set_member_name(b, "type");
      json_builder_add_string_value(b, "brush");
      _to_shown_vec(p0->corner[0], p0->corner[1], p0->border[0] * imin, 0.0f, &len, &ang);
      masks_add_num(b, "size", 2.0f * len / pw);
      masks_add_num(b, "feather", 1.0f - p0->hardness);
      json_builder_set_member_name(b, "points");
      json_builder_begin_array(b);
      for(const GList *q = f->points; q; q = g_list_next(q))
      {
        const dt_masks_point_brush_t *pt = q->data;
        _to_shown(pt->corner[0], pt->corner[1], &x, &y);
        json_builder_begin_array(b);
        json_builder_add_double_value(b, x);
        json_builder_add_double_value(b, y);
        json_builder_end_array(b);
      }
      json_builder_end_array(b);
    }
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

// the retouch module off and on again, shapes kept (the Before view)
gboolean masks_spots_enable(const gboolean on, char **err)
{
  dt_iop_module_t *m = session_module("retouch", err);
  if(!m) return FALSE;
  const dt_masks_form_t *grp = _spots_group(m);
  const gboolean want = on && grp && grp->points;
  if(m->enabled == want) return TRUE;
  m->enabled = want;
  dt_dev_add_history_item_ext(&_s.dev, m, m->enabled, TRUE);
  session_changed(DT_DEV_PIPE_TOP_CHANGED);
  return TRUE;
}

// where a new spot should copy from, as Lightroom picks it: the nearby
// place whose surroundings look most like the spot's own, which are
// untouched. measured on a small render, gray, over a ring just outside
// the spot, the spot itself kept clear of its source
gboolean masks_spot_source(JsonObject *o, JsonBuilder *b, char **err)
{
  int W = 0, H = 0;
  uint8_t *rgb = ai_shown_rgb(768, FALSE, &W, &H, err);
  if(!rgb) return FALSE;
  const size_t n = (size_t)W * H;
  float *gray = g_malloc(n * sizeof(float));
  for(size_t k = 0; k < n; k++)
    gray[k] = 0.299f * rgb[3 * k] + 0.587f * rgb[3 * k + 1] + 0.114f * rgb[3 * k + 2];
  g_free(rgb);

  // the spot as a polyline (one point for a circle) and a radius, in pixels
  const char *type = json_object_get_string_member_with_default(o, "type", "circle");
  const gboolean brush = !g_strcmp0(type, "brush");
  JsonArray *pts = brush && json_object_has_member(o, "points") ? json_object_get_array_member(o, "points") : NULL;
  const guint np = pts ? MAX(1, json_array_get_length(pts)) : 1;
  float *line = g_malloc(2 * np * sizeof(float));
  for(guint k = 0; k < np; k++)
  {
    JsonArray *p = pts ? json_array_get_array_element(pts, k) : NULL;
    line[2 * k] = (p ? json_array_get_double_element(p, 0) : json_object_get_double_member_with_default(o, "x", 0.5)) * W;
    line[2 * k + 1] = (p ? json_array_get_double_element(p, 1) : json_object_get_double_member_with_default(o, "y", 0.5)) * H;
  }
  const float r = MAX(2.0f, (brush ? json_object_get_double_member_with_default(o, "size", 0.05) / 2.0f
                                   : json_object_get_double_member_with_default(o, "r", 0.02)) * W);
  float x0 = W, y0 = H, x1 = 0, y1 = 0;
  for(guint k = 0; k < np; k++)
  {
    x0 = fminf(x0, line[2 * k]); x1 = fmaxf(x1, line[2 * k]);
    y0 = fminf(y0, line[2 * k + 1]); y1 = fmaxf(y1, line[2 * k + 1]);
  }
  // the ring's pixels: between r and 1.6 r from the spot, at most a few
  // thousand of them, evenly picked
  const float ring = 1.6f * r;
  GArray *ringpx = g_array_new(FALSE, FALSE, sizeof(int) * 2);
  for(int y = MAX(0, (int)(y0 - ring)); y <= MIN(H - 1, (int)(y1 + ring)); y++)
    for(int x = MAX(0, (int)(x0 - ring)); x <= MIN(W - 1, (int)(x1 + ring)); x++)
    {
      float best = INFINITY;
      for(guint k = 0; k < np; k++)
      {
        const float ax = line[2 * k], ay = line[2 * k + 1];
        const float bx = line[2 * MIN(k + 1, np - 1)], by = line[2 * MIN(k + 1, np - 1) + 1];
        const float lx = bx - ax, ly = by - ay, l2 = lx * lx + ly * ly;
        const float t = l2 > 0.0f ? CLAMP(((x - ax) * lx + (y - ay) * ly) / l2, 0.0f, 1.0f) : 0.0f;
        best = fminf(best, hypotf(x - (ax + t * lx), y - (ay + t * ly)));
      }
      if(best > r && best <= ring)
      {
        const int xy[2] = { x, y };
        g_array_append_val(ringpx, xy);
      }
    }
  const float fx = line[0], fy = line[1];
  g_free(line);
  const guint nr = ringpx->len, step = MAX(1, nr / 3000);

  // candidates on a grid around the spot, far enough that the source
  // keeps clear of it, near enough to share its light
  const float extent = fmaxf(x1 - x0, y1 - y0) + 2.0f * r;
  const float reach = fmaxf(3.0f * extent, 0.12f * MAX(W, H));
  const float grid = fmaxf(1.0f, r / 2.0f);
  float best = INFINITY, bdx = extent, bdy = 0.0f;
  for(float dy = -reach; dy <= reach; dy += grid)
    for(float dx = -reach; dx <= reach; dx += grid)
    {
      if(fabsf(dx) < extent && fabsf(dy) < extent) continue;
      const float d = hypotf(dx, dy);
      if(d > reach || x0 - r + dx < 0 || y0 - r + dy < 0 || x1 + r + dx >= W || y1 + r + dy >= H) continue;
      double ssd = 0.0;
      int cnt = 0;
      for(guint k = 0; k < nr; k += step)
      {
        const int *xy = &g_array_index(ringpx, int, 2 * k);
        const int sx = xy[0] + (int)dx, sy = xy[1] + (int)dy;
        if(sx < 0 || sy < 0 || sx >= W || sy >= H) continue;
        const float e = gray[(size_t)xy[1] * W + xy[0]] - gray[(size_t)sy * W + sx];
        ssd += e * e;
        cnt++;
      }
      if(!cnt) continue;
      // a little for distance, so of two alike the nearer wins
      const float score = ssd / cnt * (1.0f + 0.5f * d / reach);
      if(score < best)
      {
        best = score;
        bdx = dx;
        bdy = dy;
      }
    }
  g_array_free(ringpx, TRUE);
  g_free(gray);
  masks_add_num(b, "sx", (fx + bdx) / W);
  masks_add_num(b, "sy", (fy + bdy) / H);
  return TRUE;
}

// a mask's instances are named after it, or after it and "#tag" for a
// second instance of one module (diffuse serves Texture and Sharpening).
// the tag, "" for none, when `m` is one of them, else NULL
static const char *_mask_instance_tag(const dt_iop_module_t *m, const char *name)
{
  const size_t n = strlen(name);
  if(!m->multi_name_hand_edited || strncmp(m->multi_name, name, n)) return NULL;
  if(!m->multi_name[n]) return "";
  return m->multi_name[n] == '#' ? m->multi_name + n + 1 : NULL;
}

// a path of an object component as _object_paths() takes it
static void _object_path_json(JsonBuilder *b, const dt_masks_form_t *f, const gboolean hole)
{
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "hole");
  json_builder_add_boolean_value(b, hole);
  json_builder_set_member_name(b, "points");
  json_builder_begin_array(b);
  for(const GList *q = f->points; q; q = g_list_next(q))
  {
    const dt_masks_point_path_t *pp = q->data;
    float c[6];
    _to_shown(pp->corner[0], pp->corner[1], &c[0], &c[1]);
    _to_shown(pp->ctrl1[0], pp->ctrl1[1], &c[2], &c[3]);
    _to_shown(pp->ctrl2[0], pp->ctrl2[1], &c[4], &c[5]);
    json_builder_begin_array(b);
    for(int j = 0; j < 6; j++) json_builder_add_double_value(b, c[j]);
    json_builder_end_array(b);
  }
  json_builder_end_array(b);
  json_builder_end_object(b);
}

// a run of an object component's paths read back, into `*run`
static void _object_run_close(JsonBuilder *b, const char *member, JsonBuilder **run)
{
  if(!*run) return;
  json_builder_end_array(*run);
  json_builder_set_member_name(b, member);
  json_builder_add_value(b, json_builder_get_root(*run));
  g_object_unref(*run);
  *run = NULL;
}

// the end of an object component read back: its paths, then its backdrop
// from the edge paths in `*edge`, the plain ones in `*plain` and the
// backdrop shape `bd`, if it had them
static void _object_close(JsonBuilder *b, JsonBuilder **edge, JsonBuilder **plain, const dt_masks_form_t *bd)
{
  json_builder_end_array(b);
  if(*edge && bd && bd->points)
  {
    const dt_masks_point_parametric_t *pp = bd->points->data;
    const int ch = DEVELOP_BLENDIF_hz_in;
    json_builder_set_member_name(b, "backdrop");
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "range");
    json_builder_begin_array(b);
    for(int i = 0; i < 4; i++)
      json_builder_add_double_value(b, (double)pp->blendif_parameters[4 * ch + i] * exp2(pp->blendif_boost_factors[ch]));
    json_builder_end_array(b);
    _object_run_close(b, "paths", edge);
    _object_run_close(b, "plain", plain);
    json_builder_set_member_name(b, "off");
    json_builder_add_boolean_value(b, g_str_has_suffix(bd->name, "~off"));
    json_builder_end_object(b);
  }
  json_builder_end_object(b);
  if(*edge) g_object_unref(*edge);
  if(*plain) g_object_unref(*plain);
  *edge = *plain = NULL;
}

// a mask's shape read back: its form, whether it takes away, and whether
// it is kept switched off (_object_shapes)
typedef struct _flat_t
{
  const dt_masks_form_t *f;
  gboolean subtract, off;
} _flat_t;

// the shapes of mask tree `grp` in the order a classic group lists them,
// each adding or taking away (`sub` for the first), the reverse of
// dt_masks_group_mark_classic_runs, which nests what comes before an
// operator's run as its first member. its parametric channels, which
// multiply into the shapes, go to `chans`. an older edit's tree, as
// darktable converted it, reads the same way
static void _flatten(const dt_masks_form_t *grp, const gboolean sub, GArray *shapes, GPtrArray *chans,
                     const int depth)
{
  if(depth > DT_MASKS_NESTING_MAX) return;
  const dt_masks_point_group_t *mk = dt_masks_group_marker(grp);
  const gboolean difference = mk && (mk->state & DT_MASKS_STATE_FLEXI_DIFFERENCE);
  gboolean first = TRUE;
  for(const GList *l = grp->points; l; l = g_list_next(l))
  {
    const dt_masks_point_group_t *pt = l->data;
    if(dt_masks_point_is_marker(pt)) continue;
    const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, pt->formid);
    if(!f) continue;
    const gboolean off = (pt->state & (DT_MASKS_STATE_DISABLE | DT_MASKS_STATE_HIDDEN)) != 0;
    if((f->type & DT_MASKS_PARAMETRIC) && !_is_backdrop_shape(f))
    {
      if(!off) g_ptr_array_add(chans, (gpointer)f);
      continue;
    }
    // a classic group, which a conversion leaves nested in another, keeps
    // the operator on each member
    const gboolean s = first ? sub
                     : mk ? difference : (pt->state & DT_MASKS_STATE_DIFFERENCE) != 0;
    if(f->type & DT_MASKS_GROUP)
      _flatten(f, s, shapes, chans, depth + 1);
    else
    {
      const _flat_t e = { f, s, off };
      g_array_append_val(shapes, e);
    }
    if(!off) first = FALSE;
  }
}

static void _read_recipe(JsonBuilder *b, const dt_masks_form_t *grp, const guint component)
{
  GHashTable *forms = _mask_forms(grp);
  GString *encoded = g_string_new(NULL);
  for(guint chunk = 0; chunk < 4096; chunk++)
  {
    gchar prefix[64];
    g_snprintf(prefix, sizeof(prefix), _AI_RECIPE "%u:%u:", component, chunk);
    GHashTableIter it; gpointer key; const char *part = NULL;
    g_hash_table_iter_init(&it, forms);
    while(g_hash_table_iter_next(&it, &key, NULL))
    {
      const dt_masks_form_t *f = key;
      if(g_str_has_prefix(f->name, prefix)) { part = f->name + strlen(prefix); break; }
    }
    if(!part) break;
    g_string_append(encoded, part);
  }
  if(encoded->len)
  {
    gsize size; guchar *json = g_base64_decode(encoded->str, &size);
    gchar *terminated = g_strndup((const gchar *)json, size);
    JsonNode *node = json_from_string(terminated, NULL);
    if(node && JSON_NODE_HOLDS_OBJECT(node))
    {
      _recipe_coordinates(json_node_get_object(node), _to_shown);
      json_builder_set_member_name(b, "ai"); json_builder_add_value(b, node);
    }
    else if(node) json_node_free(node);
    g_free(terminated); g_free(json);
  }
  g_string_free(encoded, TRUE); g_hash_table_destroy(forms);
}

// the tree mask `grp` is read from: its ranges group, or in an older edit
// an instance's tree of its own, one blending in scene-referred RGB first
// (the others have no ranges), else its group
static const dt_masks_form_t *_mask_tree(const dt_masks_form_t *grp)
{
  const dt_masks_form_t *ranged = _ranges_group(grp);
  if(ranged) return ranged;
  const dt_masks_form_t *best = grp;
  int rank = 0;
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    const dt_iop_module_t *m = l->data;
    if(masks_instance_group(m) != grp) continue;
    const dt_masks_form_t *f = dt_masks_get_from_id(&_s.dev, m->blend_params->mask_id);
    if(!f || !(f->type & DT_MASKS_GROUP) || f == grp) continue;
    const int r = 1 + 2 * (m->blend_params->blend_cst == DEVELOP_BLEND_CS_RGB_SCENE) + m->enabled;
    if(r > rank)
    {
      rank = r;
      best = f;
    }
  }
  return best;
}

// parametric channels `chans` as the range components they make
static void _channels_json(JsonBuilder *b, const GPtrArray *chans)
{
  dt_develop_blend_params_t bp = { 0 };
  bp.blend_cst = DEVELOP_BLEND_CS_RGB_SCENE;
  for(guint i = 0; i < chans->len; i++)
  {
    const dt_masks_form_t *f = g_ptr_array_index(chans, i);
    const dt_masks_point_parametric_t *p = f->points ? f->points->data : NULL;
    if(!p || p->colorspace != DEVELOP_BLEND_CS_RGB_SCENE) continue;
    const dt_iop_gui_blendif_channel_t *table = dt_develop_blendif_channels_for_csp(DEVELOP_BLEND_CS_RGB_SCENE);
    for(int slot = 0; slot < DEVELOP_BLENDIF_SIZE; slot++)
    {
      if(!(p->blendif & (1u << slot))) continue;
      if(table && (((p->disabled & 1) && table[p->channel].param_channels[0] == slot)
                   || ((p->disabled & 2) && table[p->channel].param_channels[1] == slot)))
        continue;
      bp.blendif |= (1u << slot) | (p->blendif & (1u << (slot + 16)));
      memcpy(bp.blendif_parameters + 4 * slot, p->blendif_parameters + 4 * slot, 4 * sizeof(float));
      bp.blendif_boost_factors[slot] = p->blendif_boost_factors[slot];
    }
  }
  if(bp.blendif) _ranges_json(b, &bp);
}

// every client mask: its shapes, whether it is inverted, and for each
// instance it drives, whether it is on and the asked-for fields
// ({ op: [field, ...] } in `fields`; a tagged instance is "op#tag")
gboolean masks_masks(JsonObject *fields, JsonBuilder *b, char **err)
{
  json_builder_set_member_name(b, "masks");
  json_builder_begin_array(b);
  for(GList *l = _s.dev.forms; l; l = g_list_next(l))
  {
    const dt_masks_form_t *grp = l->data;
    const char *name = (grp->type & DT_MASKS_GROUP) ? masks_mask_name(grp->name) : NULL;
    // a second group of the name is a conversion's copy (_mask_forms)
    if(!name || _mask_group(name) != grp) continue;
    GArray *flat = g_array_new(FALSE, FALSE, sizeof(_flat_t));
    GPtrArray *chans = g_ptr_array_new();
    _flatten(_mask_tree(grp), FALSE, flat, chans, 0);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "name");
    json_builder_add_string_value(b, name);
    json_builder_set_member_name(b, "shapes");
    json_builder_begin_array(b);
    // an object component is several paths in a row, named "#k.i"; with
    // a backdrop, its edge paths "#k.i~" and backdrop shape "#k~" first,
    // and its plain paths "#k.i^" last
    int open_obj = -1;
    JsonBuilder *edge = NULL, *plain = NULL;
    const dt_masks_form_t *bd = NULL;
    for(guint i = 0; i < flat->len; i++)
    {
      const _flat_t *e = &g_array_index(flat, _flat_t, i);
      const dt_masks_form_t *f = e->f;
      if(_is_base_shape(f)) continue;
      const char *hash = strrchr(f->name, '#');
      unsigned comp = 0, part = 0;
      const gboolean is_bd = _is_backdrop_shape(f) && hash && sscanf(hash + 1, "%u", &comp) == 1;
      const gboolean is_obj = is_bd
        || ((f->type & DT_MASKS_PATH) && hash && sscanf(hash + 1, "%u.%u", &comp, &part) == 2);
      if(open_obj >= 0 && (!is_obj || (int)comp != open_obj))
      {
        _object_close(b, &edge, &plain, bd);
        bd = NULL;
        open_obj = -1;
      }
      if(!is_obj)
      {
        _shape_json(b, f, e->subtract);
        continue;
      }
      if(is_bd)
      {
        bd = f;
        continue;
      }
      const gboolean hole = f->name[strlen(f->name) - 1] == '-';
      const gboolean is_edge = strchr(hash, '~') != NULL, is_plain = strchr(hash, '^') != NULL;
      if(open_obj < 0)
      {
        json_builder_begin_object(b);
        json_builder_set_member_name(b, "type");
        json_builder_add_string_value(b, "object");
        _read_recipe(b, grp, comp);
        // the mode from its first path that is not off: darktable's
        // conversion moves one that is off into the run before it
        gboolean mode_sub = e->subtract != hole;
        for(guint j = i; j < flat->len; j++)
        {
          const _flat_t *q = &g_array_index(flat, _flat_t, j);
          const char *qh = strrchr(q->f->name, '#');
          unsigned qc = 0, qp = 0;
          if(!(q->f->type & DT_MASKS_PATH) || !qh || sscanf(qh + 1, "%u.%u", &qc, &qp) != 2 || qc != comp) continue;
          if(q->off) continue;
          mode_sub = q->subtract != (q->f->name[strlen(q->f->name) - 1] == '-');
          break;
        }
        json_builder_set_member_name(b, "mode");
        json_builder_add_string_value(b, mode_sub ? "subtract" : "add");
        const char *at = strchr(hash, '@');
        if(at)
        {
          // "@near,far,feather", as _object_shapes() wrote it
          gchar **v = g_strsplit(at + 1, ",", 3);
          if(g_strv_length(v) == 3)
          {
            json_builder_set_member_name(b, "depth");
            json_builder_begin_array(b);
            json_builder_add_double_value(b, g_ascii_strtod(v[0], NULL));
            json_builder_add_double_value(b, g_ascii_strtod(v[1], NULL));
            json_builder_end_array(b);
            masks_add_num(b, "feather", g_ascii_strtod(v[2], NULL));
          }
          g_strfreev(v);
        }
        else if(f->points)
        {
          // an AI object's soft edge is its outline's border, as
          // _object_shapes() set it on every point
          masks_add_num(b, "feather", ((const dt_masks_point_path_t *)f->points->data)->border[0]);
        }
        json_builder_set_member_name(b, "paths");
        json_builder_begin_array(b);
        open_obj = comp;
      }
      JsonBuilder **run = is_edge ? &edge : is_plain ? &plain : NULL;
      if(run && !*run)
      {
        *run = json_builder_new();
        json_builder_begin_array(*run);
      }
      _object_path_json(run ? *run : b, f, hole);
    }
    if(open_obj >= 0) _object_close(b, &edge, &plain, bd);
    // the ranges, from its parametric channels
    _channels_json(b, chans);
    g_array_free(flat, TRUE);
    g_ptr_array_free(chans, TRUE);
    json_builder_end_array(b);
    gboolean invert = FALSE;
    double opacity = 100.0;
    const dt_develop_blend_params_t *refined = NULL;
    json_builder_set_member_name(b, "instances");
    json_builder_begin_object(b);
    for(GList *m = _s.dev.iop; m; m = g_list_next(m))
    {
      dt_iop_module_t *mod = m->data;
      const char *tag = _mask_instance_tag(mod, name);
      if(!tag) continue;
      // an instance that is on, else one that is off: a hidden mask has
      // all of them off, and keeps its settings
      if(masks_instance_group(mod) == grp && (mod->enabled || !refined))
      {
        invert = _instance_inverted(mod);
        opacity = mod->blend_params->opacity;
        refined = mod->blend_params;
      }
      gchar *key = tag[0] ? g_strdup_printf("%s#%s", mod->op, tag) : g_strdup(mod->op);
      JsonArray *want = fields && json_object_has_member(fields, key)
        ? json_object_get_array_member(fields, key) : NULL;
      json_builder_set_member_name(b, key);
      g_free(key);
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "enabled");
      json_builder_add_boolean_value(b, mod->enabled);
      json_builder_set_member_name(b, "params");
      json_builder_begin_object(b);
      for(guint i = 0; want && i < json_array_get_length(want); i++)
      {
        const char *field = json_array_get_string_element(want, i);
        double num = 0.0;
        if(!session_read_field(mod, field, FALSE, &num, err)) return FALSE;
        masks_add_num(b, field, num);
      }
      json_builder_end_object(b);
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
    json_builder_set_member_name(b, "invert");
    json_builder_add_boolean_value(b, invert);
    masks_add_num(b, "opacity", opacity);
    json_builder_set_member_name(b, "refine");
    json_builder_begin_object(b);
    masks_add_num(b, "feather", refined ? refined->feathering_radius : 0.0);
    masks_add_num(b, "blur", refined ? refined->blur_radius : 0.0);
    masks_add_num(b, "detail", refined ? refined->details : 0.0);
    masks_add_num(b, "contrast", refined ? refined->contrast : 0.0);
    json_builder_end_object(b);
    // the combined masks it is in: its adjustments there are carried by
    // shared instances, and its own instances are off without it being hidden
    json_builder_set_member_name(b, "merged_in");
    json_builder_begin_array(b);
    for(GList *c = _s.dev.forms; c; c = g_list_next(c))
    {
      const dt_masks_form_t *cg = c->data;
      if(!(cg->type & DT_MASKS_GROUP) || !g_str_has_prefix(cg->name, _COMBINED_PREFIX)
         || _combined_group(cg->name + strlen(_COMBINED_PREFIX)) != cg)
        continue;
      for(const GList *p = cg->points; p; p = g_list_next(p))
        if(_holds_mask(p->data, grp))
        {
          json_builder_add_string_value(b, cg->name + strlen(_COMBINED_PREFIX));
          break;
        }
    }
    json_builder_end_array(b);
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

// take a mask away: its instances are switched off and let go of it, and
// its shapes leave the image
gboolean masks_mask_delete(const char *name, char **err)
{
  dt_masks_form_t *grp = _mask_group(name);
  if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name);
    return FALSE;
  }
  _combined_adopt(grp);
  _combined_member_changed(grp, TRUE);
  GHashTable *old = _mask_forms(grp);
  GPtrArray *users = g_ptr_array_new();
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    if(masks_instance_group(m) != grp) continue;
    m->enabled = FALSE;
    m->blend_params->mask_mode = DEVELOP_MASK_DISABLED;
    m->blend_params->mask_id = 0;
    g_ptr_array_add(users, m);
  }
  // unnamed, nothing keeps the group or its ranges' (_free_unreached)
  dt_masks_form_t *ranged = _ranges_group(grp);
  if(ranged) ranged->name[0] = '\0';
  grp->name[0] = '\0';
  _free_unreached(old);
  for(guint i = 0; i < users->len; i++)
    dt_dev_add_masks_history_item_ext(&_s.dev, g_ptr_array_index(users, i), FALSE, TRUE);
  g_ptr_array_free(users, TRUE);
  session_changed(DT_DEV_PIPE_SYNCH);
  return TRUE;
}

// a mask renamed: its group, its shapes (named after it, with their
// component after the last '#'), its ranges' group and the instances
// carrying its adjustments, all ordinary history, so darktable shows the
// new name too
gboolean masks_mask_rename(const char *name, const char *to, char **err)
{
  dt_masks_form_t *grp = _mask_group(name);
  if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name);
    return FALSE;
  }
  if(!to || !to[0] || _mask_group(to))
  {
    *err = g_strdup_printf("there is already a mask named '%s'", to ? to : "");
    return FALSE;
  }
  dt_masks_form_t *ranged = _ranges_group(grp);
  GHashTable *forms = _mask_forms(grp);
  gchar *full = g_strdup(grp->name);
  const size_t n = strlen(full);
  GHashTableIter it;
  gpointer key;
  g_hash_table_iter_init(&it, forms);
  while(g_hash_table_iter_next(&it, &key, NULL))
  {
    dt_masks_form_t *f = key;
    if(!strcmp(f->name, full))
      g_snprintf(f->name, sizeof(f->name), "%s%s", _MASK_PREFIX, to);
    else if(!strncmp(f->name, full, n) && !strncmp(f->name + n, " #", 2))
    {
      gchar *rest = g_strdup(f->name + n);
      g_snprintf(f->name, sizeof(f->name), "%s%s%s", _MASK_PREFIX, to, rest);
      g_free(rest);
    }
  }
  g_hash_table_destroy(forms);
  g_free(full);
  if(ranged) g_snprintf(ranged->name, sizeof(ranged->name), "%s%s", _RANGES_PREFIX, grp->name);
  gboolean recorded = FALSE;
  for(GList *l = _s.dev.iop; l; l = g_list_next(l))
  {
    dt_iop_module_t *m = l->data;
    const char *tag = _mask_instance_tag(m, name);
    if(!tag) continue;
    gchar *renamed = tag[0] ? g_strdup_printf("%s#%s", to, tag) : g_strdup(to);
    g_strlcpy(m->multi_name, renamed, sizeof(m->multi_name));
    g_free(renamed);
    // the first carries the renamed shapes into the history with it
    if(!recorded) dt_dev_add_masks_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    else dt_dev_add_history_item_ext(&_s.dev, m, m->enabled, TRUE);
    recorded = TRUE;
  }
  return TRUE;
}

// the app's instance of the tone equalizer that places the zones
// (manifest.ts, "toneequal#zone placement")
#define _ZONE_PLACEMENT_OP "toneequal"
#define _ZONE_PLACEMENT_NAME "zone placement"

// the pipe caches what modules that ran put out; the mask instances' input
// is that of the last one to run up to the anchor, which may be switched off
// itself. reader, if asked for, gets the first module on that runs after it
static dt_dev_pixelpipe_iop_t *_stage_piece(const _stage_t stage, const dt_iop_module_t *anchor,
                                            const dt_iop_module_t *placement, const dt_iop_module_t *ashift,
                                            const dt_iop_module_t *negadoctor, dt_iop_module_t **reader)
{
  dt_dev_pixelpipe_iop_t *piece = NULL;
  GList *n = _s.ppipe.nodes;
  for(; n; n = g_list_next(n))
  {
    dt_dev_pixelpipe_iop_t *pc = n->data;
    if(stage == _STAGE_TONEMAPPER)
    {
      if(pc->enabled && (!g_strcmp0(pc->module->op, "sigmoid") || !g_strcmp0(pc->module->op, "agx")
                         || !g_strcmp0(pc->module->op, "filmicrgb")
                         || !g_strcmp0(pc->module->op, "colorout")))
        break;
    }
    else if(placement && placement->enabled)
    {
      if(pc->module == placement) break;
    }
    else if(stage == _STAGE_ASHIFT)
    {
      if(pc->module->iop_order >= ashift->iop_order) break;
    }
    else if(stage == _STAGE_NEGADOCTOR)
    {
      if(pc->module->iop_order >= negadoctor->iop_order) break;
    }
    else if(pc->module->iop_order > anchor->iop_order)
      break;
    if(pc->enabled) piece = pc;
  }
  if(reader)
  {
    *reader = NULL;
    for(; n && !*reader; n = g_list_next(n))
    {
      dt_dev_pixelpipe_iop_t *pc = n->data;
      if(pc->enabled) *reader = pc->module;
    }
  }
  return piece;
}

static gboolean _working_at(_working_t *w, const _stage_t stage, char **err)
{
  dt_iop_module_t *anchor = dt_iop_get_module_by_op_priority(_s.dev.iop, _MASK_ANCHOR, 0);
  // without a placement, what is unplaced is the anchor's output
  dt_iop_module_t *placement = stage == _STAGE_UNPLACED ? session_find_named(_ZONE_PLACEMENT_OP, _ZONE_PLACEMENT_NAME) : NULL;
  dt_iop_module_t *ashift = stage == _STAGE_ASHIFT ? dt_iop_get_module_by_op_priority(_s.dev.iop, "ashift", 0) : NULL;
  dt_iop_module_t *negadoctor = stage == _STAGE_NEGADOCTOR
    ? dt_iop_get_module_by_op_priority(_s.dev.iop, "negadoctor", 0) : NULL;
  if(stage == _STAGE_ASHIFT) anchor = ashift;
  if(stage == _STAGE_NEGADOCTOR) anchor = negadoctor;
  if(!anchor || !session_ppipe_ready(err))
  {
    if(!*err) *err = g_strdup("no anchor module to sample at");
    return FALSE;
  }
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  // line detection finds too few lines at the masks' size
  const double scale = fmin(1.0, (stage == _STAGE_ASHIFT ? 1600.0 : 768.0) / MAX(pw, ph));
  dt_dev_pixelpipe_iop_t *piece = NULL;
  float *data = NULL;
  dt_iop_buffer_dsc_t *dsc = NULL;
  dt_iop_roi_t roi = { 0 };
  // on the GPU, darktable keeps a module's output in the pipe cache only
  // as the input of the last edited module (patches/darktable-engine.patch,
  // important_input), so the module that reads the sampled image stands in
  // for it during the render
  dt_iop_module_t *reader = NULL;
  _stage_piece(stage, anchor, placement, ashift, negadoctor, &reader);
  dt_iop_module_t *last = _s.dev.history_last_module;
  // a render served from the cache leaves pieces made since (a new
  // instance remakes them all) with no region and their output uncached,
  // and the others with the region of the last render that ran them, such
  // as a zoomed mask_map's: the second pass makes them run
  for(int pass = 0; pass < 2 && !data; pass++)
  {
    // upright reads before geometry: crop, orientation and perspective can
    // request an offset input region. force its producer to run so that a
    // previous render's region cannot be mistaken for this sample's
    if(pass || stage == _STAGE_ASHIFT)
    {
      if(!piece) piece = _stage_piece(stage, anchor, placement, ashift, negadoctor, NULL);
      if(piece) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, piece->module->iop_order, "working ");
    }
    _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
    if(reader) _s.dev.history_last_module = reader;
    const int failed = dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, 0, 0, MAX(1, floor(scale * pw)),
                                                MAX(1, floor(scale * ph)), scale, DT_DEVICE_NONE);
    _s.dev.history_last_module = last;
    if(failed)
    {
      *err = g_strdup("the sample render failed");
      return FALSE;
    }
    piece = _stage_piece(stage, anchor, placement, ashift, negadoctor, NULL);
    if(!piece)
    {
      *err = g_strdup("nothing runs before the anchor");
      return FALSE;
    }
    roi = piece->processed_roi_out;
    // only the whole image at this render's scale: another region's output
    // can still be in the cache, and points outside it are clamped to its
    // edges (the range map's stripes)
    // upright_detect uses the region's origin when locating its lines;
    // mask sampling still needs an image starting at the origin
    const gboolean whole = (stage == _STAGE_ASHIFT || (roi.x == 0 && roi.y == 0))
                           && fabs(roi.scale - scale) < 1e-6 * scale;
    const size_t size = (size_t)roi.width * roi.height * 4 * sizeof(float);
    const dt_hash_t hash = dt_dev_pixelpipe_cache_hash(&roi, &_s.ppipe, piece->module->position);
    data = NULL;
    dsc = NULL;
    if(whole && size && dt_dev_pixelpipe_cache_available(&_s.ppipe, hash, size))
      dt_dev_pixelpipe_cache_get(&_s.ppipe, hash, size, (void **)&data, &dsc, NULL, FALSE);
  }
  if(!data || !dsc || dsc->channels != 4 || dsc->datatype != TYPE_FLOAT)
  {
    *err = g_strdup("the working-space image is not at hand");
    return FALSE;
  }
  // with nothing in RGB after it, colorin hands on Lab: a JPEG or TIFF has
  // no RGB module on ahead of the anchor. the mask instances get it as the
  // work profile's RGB, which darktable converts their input to, so it is
  // read that way. the conversion is kept until the next one
  static float *converted = NULL;
  static dt_iop_buffer_dsc_t converted_dsc;
  if(stage != _STAGE_ASHIFT && dsc->cst == IOP_CS_LAB)
  {
    if(converted) dt_free_align(converted);
    converted = dt_alloc_align_float((size_t)4 * roi.width * roi.height);
    if(!converted)
    {
      *err = g_strdup("out of memory for the working-space image");
      return FALSE;
    }
    dt_iop_colorspace_type_t cst = IOP_CS_LAB;
    dt_ioppr_transform_image_colorspace(piece->module, data, converted, roi.width, roi.height, IOP_CS_LAB,
                                        IOP_CS_RGB, &cst, dt_ioppr_get_pipe_work_profile_info(&_s.ppipe));
    converted_dsc = *dsc;
    converted_dsc.cst = IOP_CS_RGB;
    data = converted;
    dsc = &converted_dsc;
  }
  if(stage != _STAGE_ASHIFT && dsc->cst != IOP_CS_RGB)
  {
    *err = g_strdup("the image is not in RGB at the mask stage");
    return FALSE;
  }
  // ahead of colorin there is no working profile, nor need of one: line
  // detection reads the camera's RGB as it is
  if(stage != _STAGE_ASHIFT
     && !dt_develop_blendif_init_masking_profile(piece, &w->profile, DEVELOP_BLEND_CS_RGB_SCENE))
  {
    *err = g_strdup("no masking profile");
    return FALSE;
  }
  w->data = data;
  w->roi = roi;
  w->pw = pw;
  w->ph = ph;
  w->piece = piece;
  w->dsc = dsc;
  return TRUE;
}

gboolean masks_working(_working_t *w, char **err)
{
  return _working_at(w, _STAGE_ANCHOR, err);
}

// points of the shown image (pairs, 0-1) as pixels of the working buffer
void masks_to_working(const _working_t *w, float *pts, const size_t n)
{
  for(size_t k = 0; k < n; k++)
  {
    pts[2 * k] *= w->pw;
    pts[2 * k + 1] *= w->ph;
  }
  dt_dev_distort_backtransform_plus(&_s.dev, &_s.ppipe, w->piece->module->iop_order,
                                    DT_DEV_TRANSFORM_DIR_FORW_EXCL, pts, n);
  for(size_t k = 0; k < n; k++)
  {
    pts[2 * k] = pts[2 * k] * w->roi.scale - w->roi.x;
    pts[2 * k + 1] = pts[2 * k + 1] * w->roi.scale - w->roi.y;
  }
}

// a working-space pixel's luminance and JzCzhz, as the blend code sees them
void masks_blend_values(const _working_t *w, const float *rgb_in, float *Y, dt_aligned_pixel_t JzCzhz)
{
  dt_aligned_pixel_t rgb = { rgb_in[0], rgb_in[1], rgb_in[2], 0.0f };
  const dt_iop_order_iccprofile_info_t *pr = &w->profile;
  *Y = dt_ioppr_get_rgb_matrix_luminance(rgb, pr->matrix_in, pr->lut_in, pr->unbounded_coeffs_in,
                                         pr->lutsize, pr->nonlinearlut);
  dt_aligned_pixel_t XYZ, JzAzBz;
  dt_ioppr_rgb_matrix_to_xyz(rgb, XYZ, pr->matrix_out_transposed, pr->lut_in, pr->unbounded_coeffs_in,
                             pr->lutsize, pr->nonlinearlut);
  dt_XYZ_2_JzAzBz(XYZ, JzAzBz);
  dt_JzAzBz_2_JzCzhz(JzAzBz, JzCzhz);
}

// darktable's scene-referred input channels, by the names its parametric
// mask tabs give them; a parametric component holds any of them
#define _N_CHANS 7
#define _HZ_CHAN 6
static const struct { const char *name; int ch; } _chans[_N_CHANS] = {
  { "g", DEVELOP_BLENDIF_GRAY_in }, { "R", DEVELOP_BLENDIF_RED_in }, { "G", DEVELOP_BLENDIF_GREEN_in },
  { "B", DEVELOP_BLENDIF_BLUE_in }, { "Jz", DEVELOP_BLENDIF_Jz_in }, { "Cz", DEVELOP_BLENDIF_Cz_in },
  { "hz", DEVELOP_BLENDIF_hz_in },
};

// a working-space pixel's value in each of _chans
static void _chan_values(const _working_t *w, const float *rgb, float v[_N_CHANS])
{
  float Y;
  dt_aligned_pixel_t JzCzhz;
  masks_blend_values(w, rgb, &Y, JzCzhz);
  v[0] = Y;
  for(int c = 0; c < 3; c++) v[1 + c] = rgb[c];
  for(int c = 0; c < 3; c++) v[4 + c] = JzCzhz[c];
}

// a hue's opposite, half way round
static inline float _hue_flip(const float h)
{
  return h < 0.5f ? h + 0.5f : h - 0.5f;
}

// the values at a point of the shown image (a few pixels across, as a
// picker's box), or over a box of it {x0, y0, x1, y1}; with each channel
// of _chans's least, mean and most, for the parametric mask's pickers;
// read at the mask instances' input, or at another stage
gboolean masks_sample(const float x, const float y, JsonArray *box, const _stage_t stage, JsonBuilder *b,
                      char **err)
{
  _working_t w;
  if(!_working_at(&w, stage, err)) return FALSE;
  const dt_iop_roi_t roi = w.roi;
  const float *data = w.data;
  int i0, j0, i1, j1;
  if(box && json_array_get_length(box) == 4)
  {
    // the box's corners may land skewed in the working buffer (rotated,
    // distorted); what they span
    float p[8];
    for(int k = 0; k < 4; k++)
    {
      p[2 * k] = json_array_get_double_element(box, k & 1 ? 2 : 0);
      p[2 * k + 1] = json_array_get_double_element(box, k & 2 ? 3 : 1);
    }
    masks_to_working(&w, p, 4);
    float lo[2] = { FLT_MAX, FLT_MAX }, hi[2] = { -FLT_MAX, -FLT_MAX };
    for(int k = 0; k < 4; k++)
      for(int c = 0; c < 2; c++)
      {
        lo[c] = fminf(lo[c], p[2 * k + c]);
        hi[c] = fmaxf(hi[c], p[2 * k + c]);
      }
    i0 = (int)lo[0];
    j0 = (int)lo[1];
    i1 = (int)hi[0];
    j1 = (int)hi[1];
  }
  else
  {
    float p[2] = { x, y };
    masks_to_working(&w, p, 1);
    i0 = (int)p[0] - 2;
    j0 = (int)p[1] - 2;
    i1 = (int)p[0] + 2;
    j1 = (int)p[1] + 2;
  }
  i0 = MAX(i0, 0);
  j0 = MAX(j0, 0);
  i1 = MIN(i1, roi.width - 1);
  j1 = MIN(j1, roi.height - 1);

  dt_aligned_pixel_t rgb = { 0.0f };
  float lo[_N_CHANS], hi[_N_CHANS], sum[_N_CHANS] = { 0.0f };
  // hue seen from its opposite too, for a spread across 0/1; and its
  // circular mean
  float flo = FLT_MAX, fhi = -FLT_MAX, hs = 0.0f, hc = 0.0f;
  for(int c = 0; c < _N_CHANS; c++)
  {
    lo[c] = FLT_MAX;
    hi[c] = -FLT_MAX;
  }
  int n = 0;
  for(int j = j0; j <= j1; j++)
    for(int i = i0; i <= i1; i++)
    {
      const float *px = data + 4 * ((size_t)j * roi.width + i);
      float v[_N_CHANS];
      _chan_values(&w, px, v);
      for(int c = 0; c < 3; c++) rgb[c] += px[c];
      for(int c = 0; c < _N_CHANS; c++)
      {
        lo[c] = fminf(lo[c], v[c]);
        hi[c] = fmaxf(hi[c], v[c]);
        sum[c] += v[c];
      }
      const float f = _hue_flip(v[_HZ_CHAN]);
      flo = fminf(flo, f);
      fhi = fmaxf(fhi, f);
      hs += sinf(2.0f * M_PI * v[_HZ_CHAN]);
      hc += cosf(2.0f * M_PI * v[_HZ_CHAN]);
      n++;
    }
  if(!n)
  {
    *err = g_strdup("the point is outside the image");
    return FALSE;
  }
  for(int c = 0; c < 3; c++) rgb[c] /= n;
  float Y;
  dt_aligned_pixel_t JzCzhz;
  masks_blend_values(&w, rgb, &Y, JzCzhz);
  masks_add_num(b, "luminance", Y);
  masks_add_num(b, "ev", log2f(fmaxf(Y, 1e-6f)));
  masks_add_num(b, "jz", JzCzhz[0]);
  masks_add_num(b, "chroma", JzCzhz[1]);
  masks_add_num(b, "hue", JzCzhz[2]);

  json_builder_set_member_name(b, "channels");
  json_builder_begin_object(b);
  for(int c = 0; c < _N_CHANS; c++)
  {
    float mn = lo[c], mx = hi[c], mean = sum[c] / n;
    if(c == _HZ_CHAN)
    {
      const float m = atan2f(hs, hc) / (2.0f * M_PI);
      mean = m < 0.0f ? m + 1.0f : m;
      // hues either side of 0/1 span less seen from the opposite side, as
      // blend_gui.c's picker takes them: then the least is above the most
      if(fhi - flo < mx - mn && flo < 0.5f && fhi > 0.5f)
      {
        mn = _hue_flip(flo);
        mx = _hue_flip(fhi);
      }
    }
    json_builder_set_member_name(b, _chans[c].name);
    json_builder_begin_object(b);
    masks_add_num(b, "min", mn);
    masks_add_num(b, "mean", mean);
    masks_add_num(b, "max", mx);
    json_builder_end_object(b);
  }
  json_builder_end_object(b);
  // negadoctor's pickers read the box as darktable's do, denoised: a raw
  // pixel's noise can read below zero, which its densities take for an
  // infinite one
  if(stage == _STAGE_NEGADOCTOR)
  {
    const int pbox[4] = { i0, j0, i1 + 1, j1 + 1 };
    lib_colorpicker_stats pick;
    dt_color_picker_helper(w.dsc, w.data, &w.roi, pbox, TRUE, pick, w.dsc->cst, IOP_CS_NONE, NULL);
    json_builder_set_member_name(b, "picker");
    json_builder_begin_object(b);
    const char *stat[] = { "min", "mean", "max" };
    const int at[] = { DT_PICK_MIN, DT_PICK_MEAN, DT_PICK_MAX };
    for(int k = 0; k < 3; k++)
    {
      json_builder_set_member_name(b, stat[k]);
      json_builder_begin_array(b);
      for(int c = 0; c < 3; c++) json_builder_add_double_value(b, pick[at[k]][c]);
      json_builder_end_array(b);
    }
    json_builder_end_object(b);
  }
  return TRUE;
}

// AgX's "auto tune levels" (agx.c, _apply_auto_tune_exposure): its input
// over darktable's default picker box, 2% in from each edge (lib.c,
// dt_lib_colorpicker_reset_box_area), denoised as its picker asks, and
// the darkest and brightest channel as black and white relative exposure
gboolean masks_agx_auto(JsonBuilder *b, char **err)
{
  dt_iop_module_t *agx = session_module("agx", err);
  if(!agx) return FALSE;
  if(!agx->enabled)
  {
    *err = g_strdup("auto tune needs the AgX tone mapper");
    return FALSE;
  }
  double scaling = 0.0;
  if(!session_read_field(agx, "dynamic_range_scaling", FALSE, &scaling, err)) return FALSE;
  _working_t w;
  if(!_working_at(&w, _STAGE_TONEMAPPER, err)) return FALSE;
  const int box[4] = { (int)(0.02f * w.roi.width), (int)(0.02f * w.roi.height),
                       (int)(0.98f * w.roi.width), (int)(0.98f * w.roi.height) };
  lib_colorpicker_stats pick;
  dt_color_picker_helper(w.dsc, w.data, &w.roi, box, TRUE, pick, w.dsc->cst, IOP_CS_NONE, NULL);
  const float black = fminf(pick[DT_PICK_MIN][0], fminf(pick[DT_PICK_MIN][1], pick[DT_PICK_MIN][2]));
  const float white = fmaxf(pick[DT_PICK_MAX][0], fmaxf(pick[DT_PICK_MAX][1], pick[DT_PICK_MAX][2]));
  // agx.c's _epsilon
  const float eps = 1e-6f;
  masks_add_num(b, "black_ev", CLAMPF(log2f(fmaxf(eps, black) / 0.18f) * (1.f + scaling), -20.f, -0.1f));
  masks_add_num(b, "white_ev", CLAMPF(log2f(fmaxf(eps, white) / 0.18f) * (1.f + scaling), 0.1f, 20.f));
  return TRUE;
}

// Lightroom's Upright: rotate and perspective's rotation and lens shifts
// that make the photo's lines level and plumb (upright.c). mode is
// "level", "vertical", "full", "auto" or "guided"; guided fits `guides`,
// the lines drawn (x1, y1, x2, y2 in the input image, 0-1), in place of
// the lines found. the fit starts from neutral, as it only reads the
// image ahead of rotate and perspective; `aspect` is held fixed
gboolean masks_upright(const char *mode, JsonArray *guides, const double aspect, JsonBuilder *b,
                       char **err)
{
  dt_iop_module_t *ashift = session_module("ashift", err);
  if(!ashift) return FALSE;
  _working_t w;
  if(!_working_at(&w, _STAGE_ASHIFT, err)) return FALSE;
  dt_dev_pixelpipe_iop_t *piece = session_piece(&_s.ppipe, ashift);
  if(!piece)
  {
    *err = g_strdup("rotate and perspective is not in the pipe");
    return FALSE;
  }
  const int width = piece->buf_in.width, height = piece->buf_in.height;

  // whether the frame turns by 90 degrees after rotate and perspective,
  // which swaps its fit's axes; worked out as ashift.c's process() does
  float corners[4] = { 0.0f, 0.0f, width, height };
  const float ivec[2] = { corners[2] - corners[0], corners[3] - corners[1] };
  dt_dev_distort_backtransform_plus(&_s.dev, &_s.ppipe, ashift->iop_order,
                                    DT_DEV_TRANSFORM_DIR_FORW_EXCL, corners, 2);
  const float ovec[2] = { corners[2] - corners[0], corners[3] - corners[1] };
  const float alpha = acosf(CLAMP((ivec[0] * ovec[0] + ivec[1] * ovec[1])
                                  / (hypotf(ivec[0], ivec[1]) * hypotf(ovec[0], ovec[1])), -1.0f, 1.0f));
  const gboolean flipped = fabsf(fmodf(alpha + M_PI_F, M_PI_F) - M_PI_2f) < M_PI_4f;

  const gboolean guided = !g_strcmp0(mode, "guided");
  upright_lines_t *lines = NULL;
  if(guided)
  {
    const guint n = guides ? json_array_get_length(guides) / 4 : 0;
    if(n)
    {
      float *pts = g_new(float, 4 * n);
      for(guint k = 0; k < 2 * n; k++)
      {
        pts[2 * k] = json_array_get_double_element(guides, 2 * k) * _s.ppipe.iwidth;
        pts[2 * k + 1] = json_array_get_double_element(guides, 2 * k + 1) * _s.ppipe.iheight;
      }
      // into rotate and perspective's input, through the modules ahead of it
      dt_dev_distort_transform_plus(&_s.dev, &_s.ppipe, ashift->iop_order,
                                    DT_DEV_TRANSFORM_DIR_BACK_EXCL, pts, 2 * n);
      lines = upright_drawn(pts, n);
      g_free(pts);
    }
  }
  else
  {
    // line detection works on the image in place
    const size_t size = (size_t)4 * w.roi.width * w.roi.height;
    float *buf = dt_alloc_align_float(size);
    if(buf)
    {
      memcpy(buf, w.data, size * sizeof(float));
      lines = upright_detect(buf, w.roi.width, w.roi.height, w.roi.x, w.roi.y, w.roi.scale,
                             dt_image_is_raw(&_s.dev.image_storage));
      dt_free_align(buf);
    }
  }
  int vertical = 0, horizontal = 0;
  float vweight = 0.0f, hweight = 0.0f;
  upright_lines_counts(lines, &vertical, &horizontal, &vweight, &hweight);

  // the fits to try, in turn. Auto corrects both axes only when the
  // horizontal lines carry weight against the vertical ones, else it
  // keeps to Vertical, and to Level when even that fails. Guided corrects
  // the axes it has two lines for
  upright_fit_t tries[3];
  int count = 0;
  if(!g_strcmp0(mode, "level")) tries[count++] = UPRIGHT_LEVEL;
  else if(!g_strcmp0(mode, "vertical")) tries[count++] = UPRIGHT_VERTICAL;
  else if(!g_strcmp0(mode, "full")) tries[count++] = UPRIGHT_FULL;
  else if(guided)
    tries[count++] = vertical >= 2 && horizontal >= 2 ? UPRIGHT_FULL
                   : vertical >= 2 ? UPRIGHT_VERTICAL
                   : horizontal >= 2 ? UPRIGHT_HORIZONTAL : UPRIGHT_LEVEL;
  else
  {
    if(hweight >= 0.25f * vweight) tries[count++] = UPRIGHT_FULL;
    tries[count++] = UPRIGHT_VERTICAL;
    tries[count++] = UPRIGHT_LEVEL;
  }

  float rotation = 0.0f, shift_v = 0.0f, shift_h = 0.0f;
  upright_result_t res = UPRIGHT_NOT_ENOUGH_LINES;
  upright_fit_t used = tries[0];
  for(int k = 0; k < count && res != UPRIGHT_OK; k++)
  {
    used = tries[k];
    res = upright_fit(lines, used, width, height, flipped, aspect, &rotation, &shift_v, &shift_h);
  }
  upright_lines_free(lines);
  if(res != UPRIGHT_OK)
  {
    *err = g_strdup(res == UPRIGHT_NOT_ENOUGH_LINES
                    ? (guided ? "draw at least two guides" : "not enough straight lines found in the photo")
                    : "the correction failed: try another mode, or correct by hand");
    return FALSE;
  }
  masks_add_num(b, "rotation", rotation);
  masks_add_num(b, "lensshift_v", shift_v);
  masks_add_num(b, "lensshift_h", shift_h);
  json_builder_set_member_name(b, "fit");
  json_builder_add_string_value(b, used == UPRIGHT_LEVEL ? "level"
                                   : used == UPRIGHT_VERTICAL ? "vertical"
                                   : used == UPRIGHT_HORIZONTAL ? "horizontal" : "full");
  return TRUE;
}

// points (x, y pairs, 0-1) of the shown image as points of the input
// image, before any distortion, or the reverse: where Guided's lines,
// kept in the input, show
void masks_points(JsonArray *pts, const gboolean to_shown, JsonBuilder *b)
{
  json_builder_set_member_name(b, "points");
  json_builder_begin_array(b);
  const guint n = pts ? json_array_get_length(pts) / 2 : 0;
  for(guint k = 0; k < n; k++)
  {
    const float x = json_array_get_double_element(pts, 2 * k);
    const float y = json_array_get_double_element(pts, 2 * k + 1);
    float ox, oy;
    if(to_shown) _to_shown(x, y, &ox, &oy);
    else _to_input(x, y, &ox, &oy);
    json_builder_add_double_value(b, ox);
    json_builder_add_double_value(b, oy);
  }
  json_builder_end_array(b);
}

// the photo's key: the mean log2 luminance at the tone mapper's input, over
// the same box, as auto exposure takes it; middle gray reads -2.47
gboolean masks_tone_key(JsonBuilder *b, char **err)
{
  _working_t w;
  if(!_working_at(&w, _STAGE_TONEMAPPER, err)) return FALSE;
  const dt_iop_order_iccprofile_info_t *pr = &w.profile;
  const int i0 = 0.02f * w.roi.width, j0 = 0.02f * w.roi.height;
  const int i1 = 0.98f * w.roi.width, j1 = 0.98f * w.roi.height;
  double sum = 0.0;
  size_t n = 0;
  for(int j = j0; j < j1; j++)
    for(int i = i0; i < i1; i++)
    {
      const float *px = w.data + 4 * ((size_t)j * w.roi.width + i);
      const dt_aligned_pixel_t rgb = { px[0], px[1], px[2], 0.0f };
      const float Y = dt_ioppr_get_rgb_matrix_luminance(rgb, pr->matrix_in, pr->lut_in, pr->unbounded_coeffs_in,
                                                        pr->lutsize, pr->nonlinearlut);
      sum += log2f(fmaxf(Y, 1e-6f));
      n++;
    }
  if(!n)
  {
    *err = g_strdup("the image is empty");
    return FALSE;
  }
  masks_add_num(b, "ev", sum / n);
  return TRUE;
}

// the top of an open-ended luminance range: a power of two, so the scaled
// limits land on exactly 1
#define _OPEN_TOP_EV 20.0f

// one channel's four limits, scaled into the parameters by the channel's
// boost so values above 1 fit
static void _set_channel(dt_develop_blend_params_t *bp, const int ch, const float lim[4], const gboolean invert)
{
  const float top = fmaxf(fmaxf(lim[2], lim[3]), 1e-6f);
  const float boost = top > 1.0f ? ceilf(log2f(top)) : 0.0f;
  bp->blendif_boost_factors[ch] = boost;
  for(int k = 0; k < 4; k++) bp->blendif_parameters[4 * ch + k] = lim[k] / exp2f(boost);
  bp->blendif |= 1u << ch;
  if(invert) bp->blendif |= 1u << (ch + 16);
  else bp->blendif &= ~(1u << (ch + 16));
}

// range components `list` as darktable's parametric channels in
// scene-referred RGB, set in `bp`; the channels multiply
static void _ranges_into(dt_develop_blend_params_t *bp, JsonArray *list)
{
  const guint n = list ? json_array_get_length(list) : 0;
  bp->blendif = 0;
  bp->blend_cst = DEVELOP_BLEND_CS_RGB_SCENE;
  for(guint k = 0; k < n; k++)
  {
    JsonObject *r = json_array_get_object_element(list, k);
    const char *type = json_object_get_string_member_with_default(r, "type", "");
    if(!g_strcmp0(type, "luminance"))
    {
      // a null end is open, which darktable takes from limits at 0 and at
      // the top of the boosted scale
      const gboolean open_lo = json_object_has_member(r, "lo") && json_object_get_null_member(r, "lo");
      const gboolean open_hi = json_object_has_member(r, "hi") && json_object_get_null_member(r, "hi");
      const float lo = open_lo ? 0.0f : json_object_get_double_member_with_default(r, "lo", -2.0);
      const float hi = open_hi ? 0.0f : json_object_get_double_member_with_default(r, "hi", 2.0);
      const float f = fmaxf(0.05f, json_object_get_double_member_with_default(r, "feather", 1.0));
      // the limits in EV, as luminance
      float lim[4] = { exp2f(lo - f), exp2f(lo), exp2f(hi), exp2f(hi + f) };
      if(open_lo) lim[0] = lim[1] = 0.0f;
      if(open_hi) lim[2] = lim[3] = exp2f(_OPEN_TOP_EV);
      _set_channel(bp, DEVELOP_BLENDIF_GRAY_in, lim, FALSE);
    }
    else if(!g_strcmp0(type, "color"))
    {
      const float h = json_object_get_double_member_with_default(r, "hue", 0.0);
      const float w = CLAMP(json_object_get_double_member_with_default(r, "width", 0.05), 0.005, 0.45);
      const float f = fminf(0.5f - w, CLAMP(json_object_get_double_member_with_default(r, "feather", 0.05), 0.002, 0.25));
      float lim[4] = { h - w - f, h - w, h + w, h + w + f };
      // a band across 0/1 cannot be one window; its complement can, inverted
      if(lim[0] < 0.0f || lim[3] > 1.0f)
      {
        const float c = h < 0.5f ? h + 0.5f : h - 0.5f;
        const float cw = 0.5f - w - f;
        const float inv[4] = { c - cw - f, c - cw, c + cw, c + cw + f };
        _set_channel(bp, DEVELOP_BLENDIF_hz_in, inv, TRUE);
      }
      else
        _set_channel(bp, DEVELOP_BLENDIF_hz_in, lim, FALSE);
      // near-neutral pixels have no hue to speak of; they stay out
      const float cmin = fmaxf(0.0f, json_object_get_double_member_with_default(r, "chroma", 0.002));
      const float chroma[4] = { cmin * 0.5f, cmin, 1e3f, 1e3f };
      _set_channel(bp, DEVELOP_BLENDIF_Cz_in, chroma, FALSE);
    }
    else if(!g_strcmp0(type, "parametric"))
    {
      // darktable's own numbers, per channel: the four markers in the
      // boosted 0-1 scale, polarity and boost
      JsonObject *chans = json_object_has_member(r, "channels") ? json_object_get_object_member(r, "channels") : NULL;
      for(int c = 0; chans && c < _N_CHANS; c++)
      {
        if(!json_object_has_member(chans, _chans[c].name)) continue;
        JsonObject *o = json_object_get_object_member(chans, _chans[c].name);
        JsonArray *pa = o && json_object_has_member(o, "p") ? json_object_get_array_member(o, "p") : NULL;
        if(!pa || json_array_get_length(pa) != 4) continue;
        const int ch = _chans[c].ch;
        float p[4];
        for(int i = 0; i < 4; i++)
        {
          p[i] = CLAMP(json_array_get_double_element(pa, i), 0.0, 1.0);
          if(i) p[i] = fmaxf(p[i], p[i - 1]);
          bp->blendif_parameters[4 * ch + i] = p[i];
        }
        bp->blendif_boost_factors[ch] = json_object_get_double_member_with_default(
          o, "boost", ch == DEVELOP_BLENDIF_Jz_in || ch == DEVELOP_BLENDIF_Cz_in ? -6.64385619 : 0.0);
        // a channel spanning everything selects all, whatever its polarity,
        // as darktable's own sliders leave it (blend_gui.c:873)
        if(p[1] <= 0.0f && p[2] >= 1.0f) continue;
        bp->blendif |= 1u << ch;
        if(json_object_get_boolean_member_with_default(o, "invert", FALSE)) bp->blendif |= 1u << (ch + 16);
      }
    }
  }
}

// instance `m` takes mask `root` (a mask's group or a combined mask's):
// its ranges group (_set_ranges_group) when it blends in scene-referred
// RGB, where ranges are measured, else its shapes alone. a module blending
// in another space (denoise in camera RGB, defringe in Lab) keeps it:
// forcing it into RGB blacked its output out. `invert` flips the whole
// mask, as darktable's conversion leaves a group more than one module
// renders (migrate_legacy.c, _polarity_movable)
static void _apply_ranges(dt_iop_module_t *m, dt_masks_form_t *root, const gboolean invert)
{
  dt_develop_blend_params_t *bp = m->blend_params;
  const dt_develop_blend_colorspace_t cst = dt_develop_blend_default_module_blend_colorspace(m);
  const dt_masks_form_t *ranges = cst == DEVELOP_BLEND_CS_RGB_SCENE ? _ranges_group(root) : NULL;
  bp->blend_cst = cst;
  // the module's own parametric mask would multiply into the group's again
  // (blend.c), as darktable's conversion clears it (_clear_toplevel_blendif)
  bp->blendif = 0;
  memset(bp->blendif_parameters, 0, sizeof(bp->blendif_parameters));
  memset(bp->blendif_boost_factors, 0, sizeof(bp->blendif_boost_factors));
  bp->mask_mode = DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI;
  bp->mask_id = (ranges ? ranges : root)->formid;
  bp->mask_combine &= ~(DEVELOP_COMBINE_INV | DEVELOP_COMBINE_MASKS_POS | DEVELOP_COMBINE_INCL);
  if(invert) bp->mask_combine |= DEVELOP_COMBINE_MASKS_POS;
}

// darktable's per-channel factor (blendif_rgb_jzczhz.c), for range_map
static float _range_factor(const float v, const gboolean invert, const float *p)
{
  float f = 0.0f;
  if(v <= p[0]) f = 0.0f;
  else if(v < p[1]) f = (v - p[0]) * p[4];
  else if(v <= p[2]) f = 1.0f;
  else if(v < p[3]) f = 1.0f - (v - p[2]) * p[5];
  return invert ? 1.0f - f : f;
}

// how much `ranges` select at each point of a width x height grid over
// the shown image, 0-255, written to `out`
gboolean masks_range_map(JsonArray *ranges, const int width, const int height, const char *out,
                         char **err)
{
  _working_t w;
  if(!masks_working(&w, err)) return FALSE;
  dt_develop_blend_params_t bp = { 0 };
  _ranges_into(&bp, ranges);
  float params[DEVELOP_BLENDIF_PARAMETER_ITEMS * DEVELOP_BLENDIF_SIZE];
  dt_develop_blendif_process_parameters(params, &bp);
  const size_t n = (size_t)width * height;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < height; j++)
    for(int i = 0; i < width; i++)
    {
      pts[2 * ((size_t)j * width + i)] = (i + 0.5f) / width;
      pts[2 * ((size_t)j * width + i) + 1] = (j + 0.5f) / height;
    }
  masks_to_working(&w, pts, n);
  uint8_t *map = g_malloc(n);
  for(size_t k = 0; k < n; k++)
  {
    const int x = CLAMP((int)pts[2 * k], 0, w.roi.width - 1), y = CLAMP((int)pts[2 * k + 1], 0, w.roi.height - 1);
    float vals[_N_CHANS];
    _chan_values(&w, w.data + 4 * ((size_t)y * w.roi.width + x), vals);
    float f = 1.0f;
    for(int c = 0; c < _N_CHANS; c++)
      if(bp.blendif & (1u << _chans[c].ch))
        f *= _range_factor(vals[c], (bp.blendif >> 16) & (1u << _chans[c].ch),
                           params + DEVELOP_BLENDIF_PARAMETER_ITEMS * _chans[c].ch);
    map[k] = (uint8_t)CLAMP(f * 255.0f + 0.5f, 0.0f, 255.0f);
  }
  const gboolean ok = engine_transient_write(out, map, n, NULL, 0);
  g_free(map);
  g_free(pts);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

// ------------------------------------------------------------ zone system
// Ansel Adams' zones on the scene-referred B&W image the mask instances
// get: zone V is middle gray, one stop per zone, 0 and X open-ended. zone
// k's soft membership is the luminance range the app sends for it, ramps
// linear in Y as blendif's are, so neighbors' weights add up to 1 and
// what the histogram counts is what a zone mask selects

#define _ZONE_GRAY 0.1845f
#define _ZONE_COUNT 11
#define _ZONE_FINE 10

// zone k's weight for luminance Y, with ramps `w` EV across
static float _zone_weight(const float Y, const int k, const float w)
{
  const float c = log2f(_ZONE_GRAY) + (k - 5);
  float f = 1.0f;
  if(k > 0)
  {
    const float a = exp2f(c - 0.5f - w / 2.0f), b = exp2f(c - 0.5f + w / 2.0f);
    f = Y <= a ? 0.0f : Y < b ? (Y - a) / (b - a) : 1.0f;
  }
  if(k < _ZONE_COUNT - 1)
  {
    const float a = exp2f(c + 0.5f - w / 2.0f), b = exp2f(c + 0.5f + w / 2.0f);
    f *= Y <= a ? 1.0f : Y < b ? (b - Y) / (b - a) : 0.0f;
  }
  return f;
}

static int _zone_cmp(const void *a, const void *b)
{
  const float x = *(const float *)a, y = *(const float *)b;
  return (x > y) - (x < y);
}

// the zone of each point of a width x height grid over the shown image,
// written to `out` as (z + 1) * 20 in a byte, and the zones' statistics
gboolean masks_zones(const int width, const int height, const float w, const _stage_t stage,
                     const char *out, JsonBuilder *b, char **err)
{
  _working_t wk;
  if(!_working_at(&wk, stage, err)) return FALSE;
  const size_t n = (size_t)width * height;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < height; j++)
    for(int i = 0; i < width; i++)
    {
      pts[2 * ((size_t)j * width + i)] = (i + 0.5f) / width;
      pts[2 * ((size_t)j * width + i) + 1] = (j + 0.5f) / height;
    }
  masks_to_working(&wk, pts, n);
  uint8_t *map = g_malloc(n);
  float *zs = g_malloc(n * sizeof(float));
  double pop[_ZONE_COUNT] = { 0.0 };
  double fine[_ZONE_COUNT * _ZONE_FINE] = { 0.0 };
  double below = 0.0, above = 0.0, sum = 0.0;
  for(size_t k = 0; k < n; k++)
  {
    const int x = CLAMP((int)pts[2 * k], 0, wk.roi.width - 1), y = CLAMP((int)pts[2 * k + 1], 0, wk.roi.height - 1);
    float Y;
    dt_aligned_pixel_t JzCzhz;
    masks_blend_values(&wk, wk.data + 4 * ((size_t)y * wk.roi.width + x), &Y, JzCzhz);
    // pure black has no zone in stops; it is darker than anything shown
    const float z = CLAMP(5.0f + log2f(fmaxf(Y, 1e-9f) / _ZONE_GRAY), -1.0f, 11.75f);
    zs[k] = z;
    sum += z;
    map[k] = (uint8_t)CLAMP((z + 1.0f) * 20.0f + 0.5f, 0.0f, 255.0f);
    for(int zk = MAX(0, (int)floorf(z) - 1); zk <= MIN(_ZONE_COUNT - 1, (int)ceilf(z) + 1); zk++)
      pop[zk] += _zone_weight(Y, zk, w);
    if(z < -0.5f) below += 1.0;
    else if(z >= _ZONE_COUNT - 0.5f) above += 1.0;
    else fine[CLAMP((int)((z + 0.5f) * _ZONE_FINE), 0, _ZONE_COUNT * _ZONE_FINE - 1)] += 1.0;
  }
  const gboolean ok = engine_transient_write(out, map, n, NULL, 0);
  qsort(zs, n, sizeof(float), _zone_cmp);

  json_builder_set_member_name(b, "zones");
  json_builder_begin_array(b);
  for(int k = 0; k < _ZONE_COUNT; k++) json_builder_add_double_value(b, pop[k] / n);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "fine");
  json_builder_begin_array(b);
  for(int k = 0; k < _ZONE_COUNT * _ZONE_FINE; k++) json_builder_add_double_value(b, fine[k] / n);
  json_builder_end_array(b);
  masks_add_num(b, "below", below / n);
  masks_add_num(b, "above", above / n);
  masks_add_num(b, "mean", sum / n);
  masks_add_num(b, "p5", zs[(size_t)(0.05 * (n - 1))]);
  masks_add_num(b, "p50", zs[(size_t)(0.50 * (n - 1))]);
  masks_add_num(b, "p95", zs[(size_t)(0.95 * (n - 1))]);
  masks_add_num(b, "gray", _ZONE_GRAY);

  g_free(zs);
  g_free(map);
  g_free(pts);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

// mask `name` as darktable makes it, refinements and all, 0-255 over a
// width x height grid of the shown image, written to `out`: the mask of the
// first instance of it that is on, kept by the preview pipe (it stores every
// piece's mask), without the instance's opacity. with `op` instead of a
// name ("diffuse#sharpen"), that module's own mask, such as the whole-image
// one its details threshold refines (_write_details()).
// with `scale` > 0, the map is of a window instead, as session_render() places
// one: *width x *height at (x, y) of the image scaled by `scale`, one point
// per pixel, made at that scale. refinements depend on the scale (the
// feather's window grows with its square root, the detail mask is found
// at the pipe's size), so this is the mask a render of that view used.
// the window is clipped to the image, and *width, *height say what is left
gboolean masks_mask_map(const char *name, const char *op, int *width, int *height,
                        const double vscale, const int vx, const int vy, const char *out, char **err)
{
  dt_masks_form_t *grp = name ? _mask_group(name) : NULL;
  dt_iop_module_t *mod = NULL;
  if(op)
  {
    const char *hash = strchr(op, '#');
    gchar *base = hash ? g_strndup(op, hash - op) : g_strdup(op);
    mod = hash ? session_find_named(base, hash + 1) : session_module(base, err);
    g_free(base);
    if(!mod)
    {
      if(!*err) *err = g_strdup_printf("no module '%s'", op);
      return FALSE;
    }
    // without a mask the pipe may still hold an earlier one
    if(!mod->blend_params || mod->blend_params->mask_mode <= DEVELOP_MASK_ENABLED)
    {
      *err = g_strdup_printf("'%s' has no mask", op);
      return FALSE;
    }
    name = op;
  }
  else if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name ? name : "(none)");
    return FALSE;
  }
  if(!session_ppipe_ready(err)) return FALSE;
  _s.ppipe.store_all_raster_masks = TRUE;
  // a mask with no adjustment yet has only an instance that is off, holding
  // its refinements (session.ts, REFINE_CARRIER), and an instance that is off
  // makes no mask: it is turned on in the preview pipe alone, whose output
  // is not shown, until synch_all turns it off again on the pipe's next use
  if(!mod)
  {
    dt_dev_pixelpipe_iop_t *on = NULL, *off = NULL;
    for(GList *n = _s.ppipe.nodes; n && !on; n = g_list_next(n))
    {
      dt_dev_pixelpipe_iop_t *pc = n->data;
      const dt_develop_blend_params_t *bp = pc->module->blend_params;
      if(!bp || masks_instance_group(pc->module) != grp || !_mask_instance_tag(pc->module, name)) continue;
      if(pc->enabled) on = pc;
      else if(!off) off = pc;
    }
    if(!on && off) session_preview_commit(off->module, off->module->params, off->module->blend_params, TRUE);
  }
  int pw = 0, ph = 0;
  dt_dev_pixelpipe_get_dimensions(&_s.ppipe, &_s.dev, _s.ppipe.iwidth, _s.ppipe.iheight, &pw, &ph);
  const double scale = vscale > 0.0 ? vscale : fmin(1.0, 768.0 / MAX(pw, ph));
  int ox = 0, oy = 0, rw = MAX(1, floor(scale * pw)), rh = MAX(1, floor(scale * ph));
  if(vscale > 0.0)
  {
    *width = MAX(1, MIN(*width, rw));
    *height = MAX(1, MIN(*height, rh));
    ox = CLAMP(vx, 0, rw - *width);
    oy = CLAMP(vy, 0, rh - *height);
    rw = *width;
    rh = *height;
  }
  dt_dev_pixelpipe_iop_t *piece = NULL;
  float *mask = NULL;
  // a piece served from the cache keeps no mask: the second pass makes it
  // run again
  for(int pass = 0; pass < 2 && !mask; pass++)
  {
    if(pass) dt_dev_pixelpipe_cache_invalidate_later(&_s.ppipe, piece->module->iop_order, "mask map ");
    _s.ppipe.changed = DT_DEV_PIPE_UNCHANGED;
    if(dt_dev_pixelpipe_process(&_s.ppipe, &_s.dev, ox, oy, rw, rh, scale, DT_DEVICE_NONE))
    {
      *err = g_strdup("the mask render failed");
      return FALSE;
    }
    piece = NULL;
    for(GList *n = _s.ppipe.nodes; n && !piece; n = g_list_next(n))
    {
      dt_dev_pixelpipe_iop_t *pc = n->data;
      const dt_develop_blend_params_t *bp = pc->module->blend_params;
      if(mod ? pc->enabled && pc->module == mod
             : pc->enabled && bp && masks_instance_group(pc->module) == grp && _mask_instance_tag(pc->module, name))
        piece = pc;
    }
    if(!piece)
    {
      *err = g_strdup_printf("mask '%s' drives nothing that is on", name);
      return FALSE;
    }
    mask = piece->raster_masks ? g_hash_table_lookup(piece->raster_masks, GINT_TO_POINTER(BLEND_RASTER_ID)) : NULL;
  }
  if(!mask)
  {
    *err = g_strdup_printf("no mask kept for '%s'", name);
    return FALSE;
  }
  const _working_t w = { .roi = piece->processed_roi_out, .pw = pw, .ph = ph, .piece = piece };
  const float opacity = fmaxf(1e-3f, piece->module->blend_params->opacity / 100.0f);
  const int gw = *width, gh = *height;
  const size_t n = (size_t)gw * gh;
  // the grid's points as fractions of the whole shown image
  const double ux = vscale > 0.0 ? 1.0 / (scale * pw) : 1.0 / gw;
  const double uy = vscale > 0.0 ? 1.0 / (scale * ph) : 1.0 / gh;
  float *pts = g_malloc(2 * n * sizeof(float));
  for(int j = 0; j < gh; j++)
    for(int i = 0; i < gw; i++)
    {
      pts[2 * ((size_t)j * gw + i)] = (ox + i + 0.5) * ux;
      pts[2 * ((size_t)j * gw + i) + 1] = (oy + j + 0.5) * uy;
    }
  masks_to_working(&w, pts, n);
  uint8_t *map = g_malloc(n);
  // bilinear: the grid is finer than the pipe's mask at times, and nearest
  // points would show its pixels as steps
  const int mw = w.roi.width, mh = w.roi.height;
  for(size_t k = 0; k < n; k++)
  {
    const float fx = CLAMP(pts[2 * k] - 0.5f, 0.0f, mw - 1.0f), fy = CLAMP(pts[2 * k + 1] - 0.5f, 0.0f, mh - 1.0f);
    const int x0 = (int)fx, y0 = (int)fy, x1 = MIN(x0 + 1, mw - 1), y1 = MIN(y0 + 1, mh - 1);
    const float ax = fx - x0, ay = fy - y0;
    const float top = mask[(size_t)y0 * mw + x0] * (1.0f - ax) + mask[(size_t)y0 * mw + x1] * ax;
    const float bot = mask[(size_t)y1 * mw + x0] * (1.0f - ax) + mask[(size_t)y1 * mw + x1] * ax;
    const float v = (top * (1.0f - ay) + bot * ay) / opacity;
    map[k] = (uint8_t)CLAMP(v * 255.0f + 0.5f, 0.0f, 255.0f);
  }
  const gboolean ok = engine_transient_write(out, map, n, NULL, 0);
  g_free(map);
  g_free(pts);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

// the ranges in an instance's blend parameters, as _apply_ranges() takes them
// whether blend parameters are exactly what _ranges_into makes of a
// luminance and a color range; anything else (darktable's own parametric
// masks, the app's parametric component) reads back as a parametric one
static gboolean _simple_ranges(const dt_develop_blend_params_t *bp)
{
  const float *p = bp->blendif_parameters;
  const uint32_t on = bp->blendif & 0xffffu, inv = bp->blendif >> 16;
  const uint32_t gray = 1u << DEVELOP_BLENDIF_GRAY_in, cz = 1u << DEVELOP_BLENDIF_Cz_in,
                 hz = 1u << DEVELOP_BLENDIF_hz_in;
  if(on & ~(gray | cz | hz)) return FALSE;
  if(!(on & cz) != !(on & hz)) return FALSE;
  if(on & gray)
  {
    const float *g = p + 4 * DEVELOP_BLENDIF_GRAY_in;
    if(inv & gray) return FALSE;
    const gboolean open_lo = g[0] <= 0.0f && g[1] <= 0.0f, open_hi = g[2] >= 1.0f && g[3] >= 1.0f;
    // one feather, in EV, for both ends
    const float flo = open_lo ? NAN : log2f(fmaxf(g[1], 1e-9f) / fmaxf(g[0], 1e-9f));
    const float fhi = open_hi ? NAN : log2f(fmaxf(g[3], 1e-9f) / fmaxf(g[2], 1e-9f));
    if((!open_lo && flo < 0.049f) || (!open_hi && fhi < 0.049f)) return FALSE;
    if(!open_lo && !open_hi && fabsf(flo - fhi) > 1e-3f) return FALSE;
  }
  if(on & hz)
  {
    const float *h = p + 4 * DEVELOP_BLENDIF_hz_in, *c = p + 4 * DEVELOP_BLENDIF_Cz_in;
    if(inv & cz) return FALSE;
    if(fabsf((h[1] - h[0]) - (h[3] - h[2])) > 1e-4f) return FALSE;
    // the chroma floor: half way up from 0, open at the top
    if(fabsf(c[0] * 2.0f - c[1]) > 1e-5f || c[2] != c[3]) return FALSE;
  }
  return TRUE;
}

static void _ranges_json(JsonBuilder *b, const dt_develop_blend_params_t *bp)
{
  const float *p = bp->blendif_parameters;
  const float *boost = bp->blendif_boost_factors;
  // _chans are scene-referred RGB's; another space's channels mean other things
  if(bp->blend_cst != DEVELOP_BLEND_CS_RGB_SCENE) return;
  if(!_simple_ranges(bp))
  {
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "parametric");
    json_builder_set_member_name(b, "channels");
    json_builder_begin_object(b);
    for(int c = 0; c < _N_CHANS; c++)
    {
      const int ch = _chans[c].ch;
      if(!(bp->blendif & (1u << ch))) continue;
      json_builder_set_member_name(b, _chans[c].name);
      json_builder_begin_object(b);
      json_builder_set_member_name(b, "p");
      json_builder_begin_array(b);
      for(int k = 0; k < 4; k++) json_builder_add_double_value(b, p[4 * ch + k]);
      json_builder_end_array(b);
      json_builder_set_member_name(b, "invert");
      json_builder_add_boolean_value(b, (bp->blendif >> 16) & (1u << ch));
      masks_add_num(b, "boost", boost[ch]);
      json_builder_end_object(b);
    }
    json_builder_end_object(b);
    json_builder_end_object(b);
    return;
  }
  if(bp->blendif & (1u << DEVELOP_BLENDIF_GRAY_in))
  {
    const int c = DEVELOP_BLENDIF_GRAY_in;
    const float k = exp2f(boost[c]);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "luminance");
    const gboolean open_lo = p[4 * c] <= 0.0f && p[4 * c + 1] <= 0.0f;
    const gboolean open_hi = p[4 * c + 2] >= 1.0f && p[4 * c + 3] >= 1.0f;
    if(open_lo)
    {
      json_builder_set_member_name(b, "lo");
      json_builder_add_null_value(b);
    }
    else
      masks_add_num(b, "lo", log2f(fmaxf(p[4 * c + 1] * k, 1e-9f)));
    if(open_hi)
    {
      json_builder_set_member_name(b, "hi");
      json_builder_add_null_value(b);
    }
    else
      masks_add_num(b, "hi", log2f(fmaxf(p[4 * c + 2] * k, 1e-9f)));
    // with the low end open, the feather is the high end's
    masks_add_num(b, "feather", open_lo
             ? log2f(fmaxf(p[4 * c + 3], 1e-9f) / fmaxf(p[4 * c + 2], 1e-9f))
             : log2f(fmaxf(p[4 * c + 1], 1e-9f) / fmaxf(p[4 * c + 0], 1e-9f)));
    json_builder_end_object(b);
  }
  if(bp->blendif & (1u << DEVELOP_BLENDIF_hz_in))
  {
    const int c = DEVELOP_BLENDIF_hz_in;
    const gboolean inv = (bp->blendif >> 16) & (1u << c);
    const float k = exp2f(boost[c]);
    const float l0 = p[4 * c] * k, l1 = p[4 * c + 1] * k, l2 = p[4 * c + 2] * k, l3 = p[4 * c + 3] * k;
    const float f = l1 - l0, mid = (l1 + l2) / 2.0f;
    const float h = inv ? (mid < 0.5f ? mid + 0.5f : mid - 0.5f) : mid;
    const float w = inv ? 0.5f - (l2 - l1) / 2.0f - f : (l2 - l1) / 2.0f;
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "type");
    json_builder_add_string_value(b, "color");
    masks_add_num(b, "hue", h);
    masks_add_num(b, "width", w);
    masks_add_num(b, "feather", f);
    (void)l3;
    if(bp->blendif & (1u << DEVELOP_BLENDIF_Cz_in))
      masks_add_num(b, "chroma", p[4 * DEVELOP_BLENDIF_Cz_in + 1] * exp2f(boost[DEVELOP_BLENDIF_Cz_in]));
    json_builder_end_object(b);
  }
}

// attach mask `name` to an instance; `invert` flips where it applies
gboolean masks_attach_mask(dt_iop_module_t *m, const char *name, const gboolean invert, char **err)
{
  // a shared instance's mask is the combined one, whatever a client mask
  // is called
  const gboolean shared = g_str_has_prefix(m->multi_name, _SHARED_PREFIX);
  dt_masks_form_t *grp = shared ? _combined_group(name) : _mask_group(name);
  if(!grp)
  {
    *err = g_strdup_printf("no mask '%s'", name);
    return FALSE;
  }
  if(!(m->flags() & IOP_FLAGS_SUPPORTS_BLENDING))
  {
    *err = g_strdup_printf("'%s' cannot take a mask", m->op);
    return FALSE;
  }
  _apply_ranges(m, grp, invert);
  return TRUE;
}

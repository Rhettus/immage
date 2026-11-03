// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// Exercise the actual look/thumbnail code with libdarktable, without a GUI.
#define main immage_engine_main
#include "../engine/main.c"
#undef main

#define CHECK(test) do { if(!(test)) { \
  fprintf(stderr, "look compatibility failed at line %d: %s (%s)\n", \
          __LINE__, #test, err ? err : "no engine error"); exit(1); } } while(0)

static char *err = NULL;

static dt_masks_form_t *circle_mask(dt_iop_module_t *module)
{
  dt_masks_form_t *circle = dt_masks_create(DT_MASKS_CIRCLE);
  dt_masks_point_circle_t *point = calloc(1, sizeof(*point));
  point->center[0] = 0.3f;
  point->center[1] = 0.5f;
  point->radius = 0.2f;
  point->border = 0.02f;
  circle->points = g_list_append(NULL, point);
  _s.dev.forms = g_list_append(_s.dev.forms, circle);
  dt_masks_form_t *group = dt_masks_create(DT_MASKS_GROUP);
  dt_masks_point_group_t *member = calloc(1, sizeof(*member));
  member->formid = circle->formid;
  member->parentid = group->formid;
  member->state = DT_MASKS_STATE_SHOW | DT_MASKS_STATE_USE | DT_MASKS_STATE_UNION;
  member->opacity = member->group_opacity = 1.0f;
  group->points = g_list_append(NULL, dt_masks_marker_new(_s.dev.forms, group, 0));
  group->points = g_list_append(group->points, member);
  _s.dev.forms = g_list_append(_s.dev.forms, group);
  module->blend_params->mask_mode = DEVELOP_MASK_ENABLED | DEVELOP_MASK_FLEXI;
  module->blend_params->mask_id = group->formid;
  module->blend_params->mask_combine = 0;
  module->blend_params->opacity = 65.0f;
  return group;
}

static GBytes *preview(const char *style)
{
  JsonObject *req = json_object_new();
  json_object_set_int_member(req, "size", 96);
  if(style) json_object_set_string_member(req, "look", style);
  int w = 0, h = 0;
  CHECK(_preview(req, &w, &h, &err));
  CHECK(w > 0 && h > 0);
  GBytes *pixels = g_bytes_new(_s.ppipe.backbuf, (size_t)w * h * 4);
  json_object_unref(req);
  return pixels;
}

static void check_rebuilt_pixels(GBytes *expected, GBytes *actual)
{
  gsize length = 0, actual_length = 0;
  const uint8_t *before = g_bytes_get_data(expected, &length);
  const uint8_t *after = g_bytes_get_data(actual, &actual_length);
  CHECK(length == actual_length);
  size_t changed = 0;
  int maxdiff = 0;
  for(size_t i = 0; i < length; i++)
  {
    const int difference = abs(before[i] - after[i]);
    CHECK(difference <= 1);
    maxdiff = MAX(maxdiff, difference);
    changed += difference != 0;
  }
  CHECK(changed * 1000 <= length);
  printf("rebuilt frame: %zu/%zu bytes differ, maximum %d code value\n", changed, length, maxdiff);
}

int main(int argc, char **argv)
{
  if(argc < 5)
  {
    fprintf(stderr, "usage: immage-look-check SOURCE.png TARGET.png STYLE_DIR <core options>\n");
    return 2;
  }
  CHECK(dt_init(argc - 3, argv + 3, FALSE, TRUE, NULL) == 0);
  dt_conf_set_string("write_sidecar_files", "never");
  dt_conf_set_bool("cache_disk_backend", FALSE);
  dt_conf_set_bool("cache_disk_backend_full", FALSE);
  if(!strcmp(argv[1], "--reload"))
  {
    // This process has a fresh in-memory library: only the XMP carries edits.
    CHECK(_open_image(argv[2], NO_IMGID, NULL, &err));
    dt_iop_module_t *look = _look_instance("exposure", FALSE);
    CHECK(look && look->enabled);
    dt_masks_form_t *group = dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id);
    CHECK(group);
    gchar *path = g_build_filename(argv[3], "expected.hashes", NULL);
    gchar *bytes = NULL;
    gsize length = 0;
    CHECK(g_file_get_contents(path, &bytes, &length, NULL));
    dt_hash_t hashes[2];
    CHECK(length == sizeof(hashes));
    memcpy(hashes, bytes, sizeof(hashes));
    CHECK(dt_hash(DT_INITHASH, look->params, look->params_size) == hashes[0]);
    CHECK(dt_masks_group_hash_ext(DT_INITHASH, group, _s.dev.forms) == hashes[1]);
    g_free(bytes);
    g_free(path);
    path = g_build_filename(argv[3], "expected.bgrx", NULL);
    CHECK(g_file_get_contents(path, &bytes, &length, NULL));
    GBytes *expected = g_bytes_new_take(bytes, length);
    GBytes *actual = preview(NULL);
    check_rebuilt_pixels(expected, actual);
    g_bytes_unref(expected);
    g_bytes_unref(actual);
    g_free(path);
    _close_session();
    dt_cleanup();
    puts("look masks: fresh-process sidecar import, exact params/geometry and rebuilt pixels passed");
    return 0;
  }
  CHECK(_open_image(argv[1], NO_IMGID, NULL, &err));
  dt_iop_module_t *source = _module("exposure", &err);
  CHECK(source && _write_field(source, "exposure", 1.5, &err));
  source->enabled = TRUE;
  circle_mask(source);
  const dt_mask_id_t source_id = source->blend_params->mask_id;
  dt_dev_add_masks_history_item_ext(&_s.dev, source, TRUE, TRUE);
  dt_dev_write_history_ext(&_s.dev, _s.imgid);
  GList *rows = g_list_append(NULL, GINT_TO_POINTER(_s.dev.history_end - 1));
  CHECK(dt_styles_create_from_image("compat", "", _s.imgid, rows, FALSE));
  g_list_free(rows);
  dt_styles_save_to_file("compat", argv[3], TRUE);
  gchar *style = g_build_filename(argv[3], "compat.dtstyle", NULL);
  CHECK(g_file_test(style, G_FILE_TEST_EXISTS));
  // Force the file import path instead of using only the already stored style.
  dt_styles_delete_by_name("compat");

  // Export a distinct look with different exposure, geometry and opacity.
  dt_masks_form_t *other_group = dt_masks_get_from_id(&_s.dev, source_id);
  dt_masks_point_group_t *other_member = g_list_last(other_group->points)->data;
  dt_masks_form_t *other_circle = dt_masks_get_from_id(&_s.dev, other_member->formid);
  dt_masks_point_circle_t *other_point = other_circle->points->data;
  other_point->center[0] = 0.75f;
  source->blend_params->opacity = 85.0f;
  CHECK(_write_field(source, "exposure", -1.0, &err));
  dt_dev_add_masks_history_item_ext(&_s.dev, source, TRUE, TRUE);
  dt_dev_write_history_ext(&_s.dev, _s.imgid);
  rows = g_list_append(NULL, GINT_TO_POINTER(_s.dev.history_end - 1));
  CHECK(dt_styles_create_from_image("compat-other", "", _s.imgid, rows, FALSE));
  g_list_free(rows);
  dt_styles_save_to_file("compat-other", argv[3], TRUE);
  gchar *other_style = g_build_filename(argv[3], "compat-other.dtstyle", NULL);
  CHECK(g_file_test(other_style, G_FILE_TEST_EXISTS));
  dt_styles_delete_by_name("compat-other");
  CHECK(_open_image(argv[2], NO_IMGID, NULL, &err));
  GBytes *baseline = preview(NULL);
  gchar *label = NULL;
  GList *items = _style_items(style, &label, &err);
  CHECK(items && !items->next);
  const dt_style_item_t *item = items->data;
  CHECK(item->blendop_version == dt_develop_blend_version());
  CHECK(item->blendop_params_size > sizeof(dt_develop_blend_params_t));
  dt_iop_module_t *look = _look_instance("exposure", TRUE);
  CHECK(look);

  // A real mask already using the source id must survive import/remapping.
  dt_iop_module_t *base = _module("exposure", &err);
  dt_masks_form_t *existing = circle_mask(base);
  existing->formid = source_id;
  for(GList *p = existing->points; p; p = g_list_next(p))
    ((dt_masks_point_group_t *)p->data)->parentid = source_id;
  base->blend_params->mask_id = source_id;
  dt_dev_add_masks_history_item_ext(&_s.dev, base, base->enabled, TRUE);
  const int count = g_list_length(_s.dev.forms);
  const int history_end = _s.dev.history_end;
  GList *forms = _s.dev.forms;
  const dt_hash_t original = _frame_hash(DT_INITHASH);
  GBytes *tile = preview(style);
  GBytes *repeat = preview(style);
  CHECK(g_bytes_equal(tile, repeat));
  CHECK(!g_bytes_equal(tile, baseline));
  CHECK(_s.dev.forms == forms && g_list_length(forms) == count);
  CHECK(_frame_hash(DT_INITHASH) == original);
  CHECK(_s.dev.history_end == history_end);
  CHECK(dt_masks_get_from_id(&_s.dev, source_id) == existing);

  // Invalid tails fail conversion and cannot leave imported forms behind.
  dt_style_item_t bad = *item;
  bad.blendop_params_size--;
  void *params = g_malloc(look->params_size);
  dt_develop_blend_params_t blend;
  CHECK(!_item_params(look, &bad, params, &blend));
  CHECK(g_list_length(_s.dev.forms) == count);

  // A valid first item imports forms before a malformed second item fails.
  // The thumbnail must restore the live image even after that partial work.
  sqlite3 *db = dt_database_get(darktable.db);
  CHECK(sqlite3_exec(db,
    "INSERT INTO data.style_items"
    " SELECT styleid, num-1, module, operation, op_params, enabled,"
    "        substr(blendop_params,1,length(blendop_params)-1), blendop_version,"
    "        multi_priority, multi_name, multi_name_hand_edited"
    " FROM data.style_items WHERE styleid=(SELECT id FROM data.styles WHERE name='compat')",
    NULL, NULL, NULL) == SQLITE_OK);
  CHECK(sqlite3_changes(db) == 1);
  JsonObject *broken = json_object_new();
  json_object_set_string_member(broken, "look", style);
  int broken_w = 0, broken_h = 0;
  CHECK(!_preview(broken, &broken_w, &broken_h, &err));
  CHECK(err);
  g_clear_pointer(&err, g_free);
  json_object_unref(broken);
  CHECK(_s.dev.forms == forms && g_list_length(forms) == count);
  CHECK(_frame_hash(DT_INITHASH) == original && _s.dev.history_end == history_end);
  CHECK(sqlite3_exec(db,
    "DELETE FROM data.style_items WHERE styleid=(SELECT id FROM data.styles WHERE name='compat')"
    " AND num=(SELECT MIN(num) FROM data.style_items"
    "          WHERE styleid=(SELECT id FROM data.styles WHERE name='compat'))",
    NULL, NULL, NULL) == SQLITE_OK);
  CHECK(sqlite3_changes(db) == 1);
  GBytes *recovered = preview(style);
  CHECK(g_bytes_equal(tile, recovered));
  g_bytes_unref(recovered);

  // A locked look retains its own geometry but takes the incoming opacity.
  *look->blend_params = *base->blend_params;
  look->blend_params->mask_lock = 1;
  CHECK(_item_params(look, item, params, &blend));
  CHECK(blend.mask_lock && blend.mask_id == source_id && blend.opacity == 65.0f);
  CHECK(g_list_length(_s.dev.forms) == count);
  memcpy(look->blend_params, look->default_blendop_params, sizeof(blend));

  CHECK(_look(style, &err));
  CHECK(look->blend_params->mask_id != source_id);
  CHECK(g_list_length(_s.dev.forms) == count + 2);
  dt_dev_history_item_t *last = g_list_last(_s.dev.history)->data;
  CHECK(last->forms && g_list_length(last->forms) == count + 2);
  GBytes *applied = preview(NULL);
  CHECK(g_bytes_equal(tile, applied));

  // A geometry edit with unchanged blend bytes must change preview cache identity.
  CHECK(_ppipe_ready(&err));
  _preview_commit(look, look->params, look->blend_params, TRUE);
  dt_dev_pixelpipe_iop_t *piece = _piece(&_s.ppipe, look);
  const dt_hash_t hash = piece->hash;
  dt_masks_form_t *group = dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id);
  dt_masks_point_group_t *member = g_list_last(group->points)->data;
  dt_masks_form_t *circle = dt_masks_get_from_id(&_s.dev, member->formid);
  dt_masks_point_circle_t *point = circle->points->data;
  const float center = point->center[0];
  point->center[0] = 0.75f;
  _preview_commit(look, look->params, look->blend_params, TRUE);
  CHECK(piece->hash != hash);
  point->center[0] = center;

  // Reapplication gets independent forms; disabling and save/reopen retain history.
  const dt_mask_id_t first = look->blend_params->mask_id;
  CHECK(_look(style, &err));
  CHECK(look->blend_params->mask_id != first);
  CHECK(dt_masks_get_from_id(&_s.dev, first));
  GBytes *again = preview(NULL);
  CHECK(g_bytes_equal(applied, again));

  // Preview B while A is applied, apply B, then preview/apply A again. Check
  // actual pixels and all live mask trees so cache reuse cannot hide leakage.
  const dt_hash_t mask_a = dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id), _s.dev.forms);
  const dt_develop_blend_params_t blend_a = *look->blend_params;
  const dt_hash_t frame_a = _frame_hash(DT_INITHASH);
  GList *forms_a = _s.dev.forms;
  const int count_a = g_list_length(forms_a), history_a = _s.dev.history_end;
  GBytes *tile_b = preview(other_style);
  CHECK(!g_bytes_equal(tile_b, applied));
  CHECK(_s.dev.forms == forms_a && g_list_length(forms_a) == count_a);
  CHECK(_s.dev.history_end == history_a && _frame_hash(DT_INITHASH) == frame_a);
  CHECK(!memcmp(&blend_a, look->blend_params, sizeof(blend_a)));
  CHECK(dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id), _s.dev.forms) == mask_a);
  GBytes *still_a = preview(NULL);
  CHECK(g_bytes_equal(still_a, applied));
  CHECK(_look(other_style, &err));
  const dt_mask_id_t id_b = look->blend_params->mask_id;
  const dt_hash_t mask_b = dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, id_b), _s.dev.forms);
  CHECK(mask_b != mask_a && look->blend_params->opacity == 85.0f);
  GBytes *applied_b = preview(NULL);
  CHECK(g_bytes_equal(tile_b, applied_b));
  GList *forms_b = _s.dev.forms;
  const int count_b = g_list_length(forms_b), history_b = _s.dev.history_end;
  const dt_develop_blend_params_t blend_b = *look->blend_params;
  const dt_hash_t frame_b = _frame_hash(DT_INITHASH);
  GBytes *tile_a = preview(style);
  CHECK(g_bytes_equal(tile_a, applied));
  CHECK(_s.dev.forms == forms_b && g_list_length(forms_b) == count_b);
  CHECK(_s.dev.history_end == history_b && _frame_hash(DT_INITHASH) == frame_b);
  CHECK(look->blend_params->mask_id == id_b);
  CHECK(!memcmp(&blend_b, look->blend_params, sizeof(blend_b)));
  CHECK(dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, id_b), _s.dev.forms) == mask_b);
  GBytes *still_b = preview(NULL);
  CHECK(g_bytes_equal(still_b, applied_b));
  CHECK(_look(style, &err));
  CHECK(look->blend_params->mask_id != id_b);
  CHECK(dt_masks_get_from_id(&_s.dev, id_b));
  CHECK(look->blend_params->opacity == 65.0f);
  GBytes *switched_a = preview(NULL);
  CHECK(g_bytes_equal(switched_a, applied));
  g_bytes_unref(tile_b);
  g_bytes_unref(still_a);
  g_bytes_unref(applied_b);
  g_bytes_unref(tile_a);
  g_bytes_unref(still_b);
  g_bytes_unref(switched_a);
  CHECK(_look(NULL, &err));
  GBytes *disabled = preview(NULL);
  CHECK(g_bytes_equal(baseline, disabled));
  CHECK(_look(style, &err));
  const dt_hash_t saved_params = dt_hash(DT_INITHASH, look->params, look->params_size);
  const dt_hash_t saved_mask = dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id), _s.dev.forms);
  const dt_hash_t saved_hashes[] = { saved_params, saved_mask };
  gchar *expected_path = g_build_filename(argv[3], "expected.hashes", NULL);
  CHECK(g_file_set_contents(expected_path, (const char *)saved_hashes, sizeof(saved_hashes), NULL));
  g_free(expected_path);
  expected_path = g_build_filename(argv[3], "expected.bgrx", NULL);
  gsize expected_length = 0;
  const char *expected_pixels = g_bytes_get_data(applied, &expected_length);
  CHECK(g_file_set_contents(expected_path, expected_pixels, expected_length, NULL));
  g_free(expected_path);
  CHECK(_save(&err));
  CHECK(_open_image(argv[2], NO_IMGID, NULL, &err));
  look = _look_instance("exposure", FALSE);
  CHECK(look && look->enabled);
  CHECK(dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id));
  GBytes *reopened = preview(NULL);
  CHECK(dt_hash(DT_INITHASH, look->params, look->params_size) == saved_params);
  CHECK(dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, look->blend_params->mask_id), _s.dev.forms) == saved_mask);
  // Reopening rebuilds the float pipeline: allow a one-code-value rounding
  // difference in at most 0.1% of bytes, while params and geometry stay exact.
  check_rebuilt_pixels(applied, reopened);

  // Both the current-version classic fast path and the older-version path migrate.
  look = _look_instance("exposure", FALSE);
  dt_style_item_t classic = *item;
  dt_develop_blend_params_t old = *(dt_develop_blend_params_t *)item->blendop_params;
  old.mask_mode = DEVELOP_MASK_ENABLED | DEVELOP_MASK_CONDITIONAL;
  old.mask_id = NO_MASKID;
  old.blendif = 1u << DEVELOP_BLENDIF_GRAY_in;
  classic.blendop_params = &old;
  classic.blendop_params_size = sizeof(old);
  for(int version = 14; version <= dt_develop_blend_version(); version++)
  {
    classic.blendop_version = version;
    CHECK(_item_params(look, &classic, params, &blend));
    CHECK(blend.mask_mode & DEVELOP_MASK_FLEXI);
    CHECK(dt_masks_get_from_id(&_s.dev, blend.mask_id));
  }
  g_free(params);
  g_free(other_style);
  g_free(style);
  g_free(label);
  g_list_free_full(items, dt_style_item_free);
  g_bytes_unref(baseline);
  g_bytes_unref(tile);
  g_bytes_unref(repeat);
  g_bytes_unref(applied);
  g_bytes_unref(again);
  g_bytes_unref(reopened);
  g_bytes_unref(disabled);
  _close_session();
  dt_cleanup();
  puts("look masks: file import, collision remapping, tile/apply pixels, preview isolation, malformed tail, locked mask, cache identity, repeat, distinct masked-look switching, disable, save/reopen and classic migration passed");
  return 0;
}

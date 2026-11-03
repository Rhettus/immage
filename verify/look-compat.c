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
  const size_t length = (size_t)w * h * 4;
  uint8_t *copy = g_malloc(length);
  memcpy(copy, _s.ppipe.backbuf, length);
  // gamma writes only BGR; the unused fourth byte is uninitialized padding.
  // Match the engine RGBA output contract rather than comparing allocator data.
  for(size_t i = 3; i < length; i += 4) copy[i] = 255;
  GBytes *pixels = g_bytes_new_take(copy, length);
  json_object_unref(req);
  return pixels;
}

static void check_rebuilt_pixels(GBytes *expected, GBytes *actual, const char *context)
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
    if(difference > 1)
      fprintf(stderr, "%s: byte %zu changed from %u to %u\n", context, i, before[i], after[i]);
    CHECK(difference <= 1);
    maxdiff = MAX(maxdiff, difference);
    changed += difference != 0;
  }
  CHECK(changed * 1000 <= length);
  printf("%s: %zu/%zu bytes differ, maximum %d code value\n", context, changed, length, maxdiff);
}

// Include every blend byte as well as parameter bytes and referenced geometry.
static void multi_hashes(dt_hash_t hashes[6])
{
  const char *ops[] = { "exposure", "colorbalancergb" };
  dt_mask_id_t ids[2];
  for(int i = 0; i < 2; i++)
  {
    dt_iop_module_t *module = _look_instance(ops[i], FALSE);
    CHECK(module && module->enabled);
    ids[i] = module->blend_params->mask_id;
    dt_masks_form_t *group = dt_masks_get_from_id(&_s.dev, ids[i]);
    CHECK(group);
    hashes[3*i] = dt_hash(DT_INITHASH, module->params, module->params_size);
    hashes[3*i+1] = dt_hash(DT_INITHASH, module->blend_params, sizeof(*module->blend_params));
    hashes[3*i+2] = dt_masks_group_hash_ext(DT_INITHASH, group, _s.dev.forms);
  }
  CHECK(ids[0] != ids[1]);
}

// Serialize historical bytes to disk, then use the actual style importer and
// Immage's style-item conversion rather than passing a fabricated item directly.
static void check_legacy_style(const char *dir, dt_iop_module_t *m, int version,
                               const void *old, size_t bytes, const void *expected)
{
  char *encoded = dt_exif_xmp_encode(old, bytes, NULL);
  CHECK(encoded);
  char *encoded_blend = dt_exif_xmp_encode((const unsigned char *)m->default_blendop_params,
                                          sizeof(*m->default_blendop_params), NULL);
  CHECK(encoded_blend);
  char *name = g_strdup_printf("legacy-%s-%d", m->op, version);
  char *path = g_strdup_printf("%s/%s.dtstyle", dir, name);
  char *xml = g_strdup_printf(
    "<?xml version=\"1.0\"?><darktable_style version=\"1.0\">"
    "<info><name>%s</name><description>synthetic historical parameters</description></info>"
    "<style><plugin><num>0</num><module>%d</module><operation>%s</operation>"
    "<op_params>%s</op_params><enabled>1</enabled><blendop_params>%s</blendop_params>"
    "<blendop_version>%d</blendop_version><multi_priority>0</multi_priority>"
    "<multi_name></multi_name><multi_name_hand_edited>0</multi_name_hand_edited>"
    "</plugin></style></darktable_style>",
    name, version, m->op, encoded, encoded_blend, dt_develop_blend_version());
  CHECK(g_file_set_contents(path, xml, -1, NULL));
  char *label = NULL;
  GList *items = _style_items(path, &label, &err);
  CHECK(items && !items->next);
  dt_style_item_t *item = items->data;
  CHECK(item->module_version == version && item->params_size == bytes);
  CHECK(!memcmp(item->params, old, bytes));
  void *actual = g_malloc0(m->params_size);
  dt_develop_blend_params_t blend;
  CHECK(_item_params(m, item, actual, &blend));
  CHECK(!memcmp(actual, expected, m->params_size));
  CHECK(!memcmp(&blend, m->default_blendop_params, sizeof(blend)));
  GBytes *baseline = preview(NULL);
  GBytes *tile = preview(path);
  CHECK(_look(path, &err));
  dt_iop_module_t *applied = _look_instance(m->op, FALSE);
  CHECK(applied && applied->enabled);
  CHECK(!memcmp(applied->params, expected, applied->params_size));
  CHECK(!memcmp(applied->blend_params, &blend, sizeof(blend)));
  GBytes *pixels = preview(NULL);
  CHECK(g_bytes_equal(tile, pixels));
  CHECK(!g_bytes_equal(baseline, pixels));
  CHECK(_look(NULL, &err));
  GBytes *restored = preview(NULL);
  CHECK(g_bytes_equal(baseline, restored));
  g_bytes_unref(restored);
  g_bytes_unref(pixels);
  g_bytes_unref(tile);
  g_bytes_unref(baseline);
  g_free(actual);
  g_list_free_full(items, dt_style_item_free);
  dt_styles_delete_by_name(name);
  g_free(label);
  g_free(xml);
  g_free(path);
  g_free(name);
  g_free(encoded);
  g_free(encoded_blend);
  printf("%s v%d: legacy style import, converted bytes, tile/applied pixels and disable passed\n", m->op, version);
}

// Test the loaded candidate modules, without mirroring their C parameter structs.
static void check_hdr_migration(const char *dir)
{
  const char *ops[] = { "agx", "sigmoid" };
  const char *flags[] = { "target_white_from_output", "white_target_from_output" };
  const int versions[] = { 7, 3 };
  for(int i = 0; i < 2; i++)
  {
    dt_iop_module_t *m = _module(ops[i], &err);
    CHECK(m && m->so->version() == versions[i] + 1);
    double value = 0;
    CHECK(_read_field(m, flags[i], TRUE, &value, &err) && value == 1);
    dt_introspection_field_t *field = NULL;
    char *flag = _field_in(m, m->default_params, flags[i], &field, &err);
    CHECK(flag);
    const size_t prefix = flag - (char *)m->default_params;
    void *old = g_malloc(prefix);
    memcpy(old, m->default_params, prefix);
    // Distinct valid edits exercise preservation beyond the default blob.
    CHECK(_write_field_in(m, old, i ? "middle_grey_contrast" : "curve_contrast_around_pivot", 1.25, &err));
    void *converted = NULL;
    int32_t size = 0;
    int version = 0;
    CHECK(m->legacy_params(m, old, versions[i], &converted, &size, &version) == 0);
    CHECK(version == versions[i] + 1 && size == m->params_size);
    CHECK(!memcmp(old, converted, prefix));
    flag = _field_in(m, converted, flags[i], &field, &err);
    CHECK(flag && *(gboolean *)flag == FALSE);
    if(i == 0)
    {
      float *purity = _field_in(m, converted, "hdr_purity", &field, &err);
      CHECK(purity && *purity == 0.5f);
      CHECK(_read_field(m, "hdr_purity", TRUE, &value, &err) && value == 0.5);
    }
    void *chained = g_malloc0(m->params_size);
    CHECK(dt_iop_legacy_params(m, old, prefix, versions[i], &chained, version) == 0);
    CHECK(!memcmp(converted, chained, size));
    check_legacy_style(dir, m, versions[i], old, prefix, converted);
    if(i == 1)
    {
      // v1 ends before primaries adjustments; v2 ends before base_primaries.
      // Derive historical prefix sizes from the loaded module's introspection.
      const char *ends[] = { "red_inset", "base_primaries" };
      for(int legacy = 1; legacy <= 2; legacy++)
      {
        char *end = _field_in(m, old, ends[legacy - 1], &field, &err);
        CHECK(end);
        const size_t bytes = end - (char *)old;
        void *intermediate = NULL;
        int32_t intermediate_size = 0;
        int intermediate_version = 0;
        CHECK(m->legacy_params(m, old, legacy, &intermediate,
                               &intermediate_size, &intermediate_version) == 0);
        CHECK(intermediate_version == 3 && intermediate_size == prefix);
        CHECK(!memcmp(old, intermediate, bytes));
        for(size_t j = bytes; j < prefix; j++)
          CHECK(((unsigned char *)intermediate)[j] == 0);
        void *expected = NULL;
        CHECK(m->legacy_params(m, intermediate, 3, &expected, &size, &version) == 0);
        CHECK(version == 4 && size == m->params_size);
        void *actual = g_malloc0(m->params_size);
        CHECK(dt_iop_legacy_params(m, old, bytes, legacy, &actual, 4) == 0);
        CHECK(!memcmp(actual, expected, size));
        CHECK(!memcmp(actual, old, bytes));
        check_legacy_style(dir, m, legacy, old, bytes, expected);
        flag = _field_in(m, actual, flags[i], &field, &err);
        CHECK(flag && *(gboolean *)flag == FALSE);
        g_free(actual);
        free(expected);
        free(intermediate);
        printf("sigmoid v%d: preserved prefix, zero-filled additions and chained v4 conversion passed\n", legacy);
      }
    }
    g_free(chained);
    free(converted);
    g_free(old);
    printf("%s: new output-follow default, legacy prefix preservation and conversion passed\n", ops[i]);
  }
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
  if(!strcmp(argv[1], "--reload-multi"))
  {
    CHECK(_open_image(argv[2], NO_IMGID, NULL, &err));
    dt_hash_t actual_hashes[6];
    multi_hashes(actual_hashes);
    gchar *path = g_build_filename(argv[3], "multi.hashes", NULL);
    gchar *bytes = NULL;
    gsize length = 0;
    CHECK(g_file_get_contents(path, &bytes, &length, NULL));
    CHECK(length == sizeof(actual_hashes));
    CHECK(!memcmp(bytes, actual_hashes, length));
    g_free(bytes);
    g_free(path);
    path = g_build_filename(argv[3], "multi.bgrx", NULL);
    CHECK(g_file_get_contents(path, &bytes, &length, NULL));
    GBytes *expected = g_bytes_new_take(bytes, length);
    GBytes *actual = preview(NULL);
    check_rebuilt_pixels(expected, actual, "multi-module fresh-process reload");
    g_bytes_unref(expected);
    g_bytes_unref(actual);
    g_free(path);
    _close_session();
    dt_cleanup();
    puts("multi-module sidecar: fresh-process params, blend bytes, geometry and pixels passed");
    return 0;
  }
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
    check_rebuilt_pixels(expected, actual, "single-module fresh-process reload");
    g_bytes_unref(expected);
    g_bytes_unref(actual);
    g_free(path);
    _close_session();
    dt_cleanup();
    puts("look masks: fresh-process sidecar import, exact params/geometry and rebuilt pixels passed");
    return 0;
  }
  CHECK(_open_image(argv[1], NO_IMGID, NULL, &err));
  check_hdr_migration(argv[3]);
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
  const int exposure_row = _s.dev.history_end - 1;
  // The second look also contains an independently masked color-balance item.
  // Use a rotated ellipse so import exercises another geometry serialization.
  dt_iop_module_t *color = _module("colorbalancergb", &err);
  CHECK(color && _write_field(color, "chroma_global", 0.4, &err));
  color->enabled = TRUE;
  dt_masks_form_t *color_group = circle_mask(color);
  dt_masks_point_group_t *color_member = g_list_last(color_group->points)->data;
  dt_masks_form_t *unused_circle = dt_masks_get_from_id(&_s.dev, color_member->formid);
  _s.dev.forms = g_list_remove(_s.dev.forms, unused_circle);
  dt_masks_free_form(unused_circle);
  dt_masks_form_t *ellipse = dt_masks_create(DT_MASKS_ELLIPSE);
  _s.dev.forms = g_list_append(_s.dev.forms, ellipse);
  color_member->formid = ellipse->formid;
  dt_masks_point_ellipse_t *ellipse_point = calloc(1, sizeof(*ellipse_point));
  ellipse_point->center[0] = 0.55f;
  ellipse_point->center[1] = 0.4f;
  ellipse_point->radius[0] = 0.3f;
  ellipse_point->radius[1] = 0.12f;
  ellipse_point->rotation = 35.0f;
  ellipse_point->border = 0.03f;
  ellipse->points = g_list_append(NULL, ellipse_point);
  dt_dev_add_masks_history_item_ext(&_s.dev, color, TRUE, TRUE);
  dt_dev_write_history_ext(&_s.dev, _s.imgid);
  rows = g_list_append(NULL, GINT_TO_POINTER(exposure_row));
  rows = g_list_append(rows, GINT_TO_POINTER(_s.dev.history_end - 1));
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
  dt_iop_module_t *color_look = _look_instance("colorbalancergb", FALSE);
  CHECK(color_look && color_look->enabled);
  dt_masks_form_t *imported_color = dt_masks_get_from_id(&_s.dev, color_look->blend_params->mask_id);
  CHECK(imported_color && imported_color->formid != look->blend_params->mask_id);
  dt_masks_point_group_t *imported_member = g_list_last(imported_color->points)->data;
  CHECK(dt_masks_get_from_id(&_s.dev, imported_member->formid)->type & DT_MASKS_ELLIPSE);
  const dt_hash_t color_mask = dt_masks_group_hash_ext(DT_INITHASH, imported_color, _s.dev.forms);
  const dt_develop_blend_params_t color_blend = *color_look->blend_params;
  const dt_mask_id_t id_b = look->blend_params->mask_id;
  const dt_hash_t mask_b = dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, id_b), _s.dev.forms);
  CHECK(mask_b != mask_a && look->blend_params->opacity == 85.0f);
  GBytes *applied_b = preview(NULL);
  CHECK(g_bytes_equal(tile_b, applied_b));
  color_look->enabled = FALSE;
  dt_dev_add_history_item_ext(&_s.dev, color_look, FALSE, TRUE);
  _changed(DT_DEV_PIPE_SYNCH);
  GBytes *without_color = preview(NULL);
  CHECK(!g_bytes_equal(without_color, applied_b));
  g_bytes_unref(without_color);
  color_look->enabled = TRUE;
  dt_dev_add_history_item_ext(&_s.dev, color_look, TRUE, TRUE);
  _changed(DT_DEV_PIPE_SYNCH);
  GBytes *restored_color = preview(NULL);
  CHECK(g_bytes_equal(restored_color, applied_b));
  g_bytes_unref(restored_color);
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
  CHECK(!memcmp(&color_blend, color_look->blend_params, sizeof(color_blend)));
  CHECK(color_look->enabled);
  CHECK(dt_masks_group_hash_ext(DT_INITHASH, imported_color, _s.dev.forms) == color_mask);
  CHECK(dt_masks_group_hash_ext(DT_INITHASH,
    dt_masks_get_from_id(&_s.dev, id_b), _s.dev.forms) == mask_b);
  GBytes *still_b = preview(NULL);
  CHECK(g_bytes_equal(still_b, applied_b));
  CHECK(_look(style, &err));
  CHECK(!color_look->enabled);
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
  check_rebuilt_pixels(applied, reopened, "single-module same-process reopen");

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
  // Keep A's sidecar intact; use a separate photo for the two-module roundtrip.
  gchar *multi_path = g_build_filename(argv[3], "multi.png", NULL);
  CHECK(_open_image(multi_path, NO_IMGID, NULL, &err));
  CHECK(_look(other_style, &err));
  GBytes *multi_pixels = preview(NULL);
  dt_hash_t before_multi[6], after_multi[6];
  multi_hashes(before_multi);
  gchar *multi_expected = g_build_filename(argv[3], "multi.hashes", NULL);
  CHECK(g_file_set_contents(multi_expected, (const char *)before_multi, sizeof(before_multi), NULL));
  g_free(multi_expected);
  multi_expected = g_build_filename(argv[3], "multi.bgrx", NULL);
  gsize multi_length = 0;
  const char *multi_data = g_bytes_get_data(multi_pixels, &multi_length);
  CHECK(g_file_set_contents(multi_expected, multi_data, multi_length, NULL));
  g_free(multi_expected);
  CHECK(_save(&err));
  CHECK(_open_image(multi_path, NO_IMGID, NULL, &err));
  multi_hashes(after_multi);
  CHECK(!memcmp(before_multi, after_multi, sizeof(before_multi)));
  GBytes *multi_reopened = preview(NULL);
  check_rebuilt_pixels(multi_pixels, multi_reopened, "multi-module same-process reopen");
  g_bytes_unref(multi_pixels);
  g_bytes_unref(multi_reopened);
  g_free(multi_path);
  puts("multi-module sidecar: same-process params, blend bytes, geometry and pixels passed");
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

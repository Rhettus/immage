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

// the library: folders, import, thumbnails, prefetch, metadata, keywords, capture times, copies and sidecars

#include "engine.h"

// photos likely opened next, their raws decoded ahead on threads of their
// own, a few at once: a raw's decode mostly keeps to one core. darktable's
// job threads would do it (DT_MIPMAP_PREFETCH), but without its GUI
// darktable starts none (control.c, dt_control_init). a new list replaces
// the photos still waiting, not those being decoded. `open` of one of them
// then finds the decoded raw in the mipmap cache, or waits on the decode
// under way. the cache keeps 2 * dt_worker_threads() full raws, at least 8
// (mipmap_cache.c, dt_mipmap_cache_init), so a list longer than 7 pushes
// out the open photo's neighbors it decoded first
//
// a decode starts only while memory is not short and no export, merge or
// print runs: the task is dropped otherwise, with the list, since the page
// sends a new one on its next step. dropping never blocks a shutdown, as
// waiting on an export would in library_prefetch_wait
#define _PREFETCH_THREADS 3
static GThreadPool *_prefetch_pool = NULL;

static GMutex _prefetch_lock;
static GArray *_prefetch_queue = NULL;

// one task per photo queued: each decodes the next one still waiting, so a
// task left over from a list since replaced finds the new one, or nothing
static void _prefetch_run(gpointer data, gpointer user_data)
{
  engine_background_priority();
  engine_background_yield();
  eng_lock(&_prefetch_lock, ENG_LOCK_POOL);
  // engine_memory_pressure is safe here: it keeps no state of its own on Linux
  // (a local FILE), and reads an atomic on macOS and a kernel handle on
  // Windows
  if(g_atomic_int_get(&export_jobs) > 0 || engine_memory_pressure()) g_array_set_size(_prefetch_queue, 0);
  if(!_prefetch_queue->len)
  {
    eng_unlock(&_prefetch_lock, ENG_LOCK_POOL);
    return;
  }
  const dt_imgid_t imgid = g_array_index(_prefetch_queue, dt_imgid_t, 0);
  g_array_remove_index(_prefetch_queue, 0);
  eng_unlock(&_prefetch_lock, ENG_LOCK_POOL);
  dt_mipmap_buffer_t buf;
  dt_mipmap_cache_get(&buf, imgid, DT_MIPMAP_FULL, DT_MIPMAP_BLOCKING, 'r');
  dt_mipmap_cache_release(&buf);
}

void library_prefetch(const dt_imgid_t *imgids, const guint n)
{
  if(!_prefetch_pool)
  {
    _prefetch_queue = g_array_new(FALSE, FALSE, sizeof(dt_imgid_t));
    _prefetch_pool = g_thread_pool_new(_prefetch_run, NULL, _PREFETCH_THREADS, TRUE, NULL);
  }
  eng_lock(&_prefetch_lock, ENG_LOCK_POOL);
  g_array_set_size(_prefetch_queue, 0);
  for(guint k = 0; k < n; k++)
    if(dt_is_valid_imgid(imgids[k]) && imgids[k] != _s.imgid) g_array_append_val(_prefetch_queue, imgids[k]);
  const guint queued = _prefetch_queue->len;
  eng_unlock(&_prefetch_lock, ENG_LOCK_POOL);
  // the pool takes no NULL task
  for(guint k = 0; k < queued; k++) g_thread_pool_push(_prefetch_pool, GINT_TO_POINTER(1), NULL);
}

// before darktable's caches go: the photos waiting are dropped, and the
// decodes under way finished
void library_prefetch_wait(void)
{
  if(!_prefetch_pool) return;
  eng_lock(&_prefetch_lock, ENG_LOCK_POOL);
  g_array_set_size(_prefetch_queue, 0);
  eng_unlock(&_prefetch_lock, ENG_LOCK_POOL);
  g_thread_pool_free(_prefetch_pool, TRUE, TRUE);
  _prefetch_pool = NULL;
}

// why the last sidecar write failed, for session_save's reply
gchar *library_sidecar_error = NULL;

static gboolean _sidecar_failed(const char *filename, const char *what, const int code)
{
  gchar *name = g_path_get_basename(filename);
  g_free(library_sidecar_error);
  library_sidecar_error = code ? g_strdup_printf("could not save the edit to %s: %s (%s)", name, what, g_strerror(code))
                        : g_strdup_printf("could not save the edit to %s: %s", name, what);
  g_free(name);
  dt_print(DT_DEBUG_ALWAYS, "[engine] %s", library_sidecar_error);
  return TRUE;
}

// darktable's writer (exif.cc, dt_exif_xmp_write) empties the sidecar, then
// writes the new one without checking the writes: a full disk, or the engine
// killed in between, leaves an empty or cut XMP, the edit lost, and a full
// disk is even reported as saved. so the new sidecar is made in a copy beside
// it, checked whole, flushed, and renamed over the old one, as dtdata.c
// replaces its file: until then the old sidecar is untouched. TRUE on failure
static gboolean _write_xmp_whole(const dt_imgid_t imgid, const char *filename, const gboolean location_changed)
{
  // one fixed name, so a copy left by a killed engine is reused, not piled up
  // in the sidecar's folder, for the rename, but not named after it: a photo
  // whose name is near NAME_MAX has no room for a longer suffix. a hash of
  // the sidecar's name keeps it fixed and short
  gchar *dir = g_path_get_dirname(filename);
  gchar *tmpname = g_strdup_printf(".immage-%08x.tmp", g_str_hash(filename));
  gchar *tmp = g_build_filename(dir, tmpname, NULL);
  g_free(tmpname);
  g_free(dir);
  gchar *old = NULL, *now = NULL;
  gsize old_len = 0, now_len = 0;
  GError *error = NULL;
  gboolean failed = TRUE;
  GStatBuf st;
  const gboolean existed = g_stat(filename, &st) == 0;
  // the old sidecar is the copy's start: darktable keeps the keys it does not
  // know (_remove_known_keys) and skips a write that changes nothing
  if(existed && !g_file_get_contents(filename, &old, &old_len, &error))
  {
    _sidecar_failed(filename, error->message, 0);
    goto done;
  }
  g_unlink(tmp);
  if(existed)
  {
    FILE *f = g_fopen(tmp, "wb");
    if(!f)
    {
      _sidecar_failed(filename, "could not make a copy beside it", errno);
      goto done;
    }
    const gboolean wrote = fwrite(old, 1, old_len, f) == old_len;
    const int code = errno;
    if(fclose(f) != 0 || !wrote)
    {
      _sidecar_failed(filename, "could not make a copy beside it", wrote ? errno : code);
      goto done;
    }
  }
  if(dt_exif_xmp_write(imgid, tmp, FALSE))
  {
    _sidecar_failed(filename, "darktable could not write it", errno);
    goto done;
  }
  if(location_changed && !location_sidecar_mark(tmp))
  {
    _sidecar_failed(filename, "could not mark its location", 0);
    goto done;
  }
  // a write cut short loses the packet's end
  if(!g_file_get_contents(tmp, &now, &now_len, NULL) || !g_strstr_len(now, now_len, "</x:xmpmeta>"))
  {
    _sidecar_failed(filename, "the new sidecar came out incomplete (is the disk full?)", 0);
    goto done;
  }
  if(existed && now_len == old_len && !memcmp(now, old, now_len))
  {
    // unchanged: the old file stays as it is, its time too, as darktable leaves it
    failed = FALSE;
    goto done;
  }
  {
    // on to the disk before it takes the old one's place, or a power cut
    // after the rename can leave an empty file under the sidecar's name
    const int fd = g_open(tmp, O_RDWR, 0);
    // fsync/_commit, not g_fsync: darktable caps GLib at 2.56
    // (src/CMakeLists.txt) and g_fsync needs 2.64, an error on Windows
#ifdef _WIN32
    const gboolean synced = fd >= 0 && _commit(fd) == 0;
#else
    const gboolean synced = fd >= 0 && fsync(fd) == 0;
#endif
    const int code = errno;
    if(fd >= 0) close(fd);
    if(!synced)
    {
      _sidecar_failed(filename, "could not write it to the disk", code);
      goto done;
    }
  }
  if(existed) g_chmod(tmp, st.st_mode & 07777);
  if(g_rename(tmp, filename) != 0)
  {
    _sidecar_failed(filename, "could not replace the old sidecar", errno);
    goto done;
  }
  failed = FALSE;
done:
  if(failed || g_file_test(tmp, G_FILE_TEST_EXISTS)) g_unlink(tmp);
  g_clear_error(&error);
  g_free(old);
  g_free(now);
  g_free(tmp);
  return failed;
}

// darktable writes sidecars as a side effect of importing, loading a
// develop and exporting, which would leave an .xmp beside every image
// merely looked at, so its setting stays "never" (main()). the engine
// writes one only where it means to, with this: darktable's
// dt_image_write_sidecar_file() without its check of that setting, which
// would skip the write and still report success. a global switch flipped
// around each job can't be used, as the thumbnail threads run beside the
// main loop. TRUE means it failed, as darktable's
static gboolean _write_sidecar_location(const dt_imgid_t imgid, const gboolean location_changed)
{
  if(!dt_is_valid_imgid(imgid)) return TRUE;
  char filename[PATH_MAX] = { 0 };
  gboolean from_cache = FALSE;
  dt_image_full_path(imgid, filename, sizeof(filename), &from_cache);
  if(!g_file_test(filename, G_FILE_TEST_EXISTS))
  {
    from_cache = TRUE;
    dt_image_full_path(imgid, filename, sizeof(filename), &from_cache);
    if(!from_cache) return TRUE;
  }
  dt_image_path_append_version(imgid, filename, sizeof(filename));
  g_strlcat(filename, ".xmp", sizeof(filename));
  if(_write_xmp_whole(imgid, filename, location_changed)) return TRUE;
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "UPDATE main.images SET write_timestamp = STRFTIME('%s', 'now') WHERE id = ?1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  return FALSE;
}

gboolean library_write_sidecar(const dt_imgid_t imgid)
{
  return _write_sidecar_location(imgid, FALSE);
}

// an export's copy of a photo's edit as it was when the export was asked
// for (_hold_snapshot): a darktable duplicate, at a version from this one
// up, which the listings leave out (library_image_versions)
#define _SNAPSHOT_VERSION 1000000

static dt_imgid_t _real_version(const dt_imgid_t imgid);

// the main loop, the import thread (library_import_run) and the denoise thread
// (ai_denoise_run) all import. a film roll and an image are each looked up,
// then inserted when missing, so two imports into one folder at once could
// make two of either
static GMutex _import_lock;

// file the image under an in-memory film roll, the way darktable-mcp does;
// importing reads an existing sidecar, so earlier edits come back
dt_imgid_t library_import(const char *path)
{
  gchar *dir = g_path_get_dirname(path);
  eng_lock(&_import_lock, ENG_LOCK_IMPORT);
  dt_film_t film;
  dt_film_init(&film); // holds a mutex; dt_film_new() does not set it up
  const dt_filmid_t filmid = dt_film_new(&film, dir);
  dt_film_cleanup(&film);
  g_free(dir);
  // darktable finds a file's image by its name alone (image.c,
  // dt_image_get_id()), which can be a snapshot once the version before it
  // has been removed
  const dt_imgid_t imgid = dt_is_valid_filmid(filmid) ? dt_image_import(filmid, path, TRUE, FALSE) : NO_IMGID;
  if(dt_is_valid_imgid(imgid))
  {
    GList *versions = library_image_versions(imgid);
    for(GList *l = versions; l; l = l->next)
    {
      const dt_imgid_t id = GPOINTER_TO_INT(l->data);
      char sidecar[PATH_MAX] = { 0 };
      gboolean from_cache = FALSE;
      dt_image_full_path(id, sidecar, sizeof(sidecar), &from_cache);
      dt_image_path_append_version(id, sidecar, sizeof(sidecar));
      g_strlcat(sidecar, ".xmp", sizeof(sidecar));
      if(!g_file_test(sidecar, G_FILE_TEST_EXISTS)) continue;
      const int missing = location_sidecar_missing(sidecar);
      if(missing)
      {
        dt_image_geoloc_t geo;
        dt_image_get_location(id, &geo);
        if(missing & 1) geo.latitude = geo.longitude = NAN;
        if(missing & 2) geo.elevation = NAN;
        dt_image_set_location(id, &geo, FALSE, FALSE);
      }
    }
    g_list_free(versions);
  }
  eng_unlock(&_import_lock, ENG_LOCK_IMPORT);
  return _real_version(imgid);
}

gboolean library_is_snapshot(const dt_imgid_t imgid)
{
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT 1 FROM main.images WHERE id = ?1 AND version >= ?2",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, _SNAPSHOT_VERSION);
  const gboolean found = sqlite3_step(stmt) == SQLITE_ROW;
  sqlite3_finalize(stmt);
  return found;
}

// the lowest version of the file `imgid` that is not a snapshot, or `imgid`
// when it is not one
static dt_imgid_t _real_version(const dt_imgid_t imgid)
{
  if(!dt_is_valid_imgid(imgid) || !library_is_snapshot(imgid)) return imgid;
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT b.id FROM main.images AS a, main.images AS b"
                              " WHERE a.id = ?1 AND b.film_id = a.film_id AND b.filename = a.filename"
                              "   AND b.version < ?2"
                              " ORDER BY b.version LIMIT 1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, _SNAPSHOT_VERSION);
  const dt_imgid_t real = sqlite3_step(stmt) == SQLITE_ROW ? sqlite3_column_int(stmt, 0) : imgid;
  sqlite3_finalize(stmt);
  return real;
}

// a copy of `imgid`'s edit as the library holds it, for an export to
// render however the photo is edited meanwhile
dt_imgid_t library_snapshot(const dt_imgid_t imgid)
{
  static gint made = 0;
  const dt_imgid_t snap = dt_image_duplicate_with_version(imgid, _SNAPSHOT_VERSION + g_atomic_int_add(&made, 1));
  if(!dt_is_valid_imgid(snap)) return NO_IMGID;
  dt_history_copy_and_paste_on_image(imgid, snap, FALSE, NULL, TRUE, TRUE, FALSE);
  // duplicating raised the file's max_version to the snapshot's, which the
  // next virtual copy would be numbered after (image.c, dt_image_duplicate())
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "UPDATE main.images"
                              " SET max_version = (SELECT MAX(b.version) FROM main.images AS b"
                              "                    WHERE b.film_id = main.images.film_id"
                              "                      AND b.filename = main.images.filename AND b.version < ?2)"
                              " WHERE id IN (SELECT b.id FROM main.images AS a, main.images AS b"
                              "              WHERE a.id = ?1 AND b.film_id = a.film_id AND b.filename = a.filename)",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, _SNAPSHOT_VERSION);
  sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  return snap;
}

void library_snapshot_remove(const dt_imgid_t snap)
{
  if(!dt_is_valid_imgid(snap)) return;
  // the raster mask data the history copy took along, beside the photo
  // under the snapshot's version (dtdata.c, dt_dtdata_merge())
  char data[PATH_MAX] = { 0 };
  dt_dtdata_path(snap, data, sizeof(data));
  if(data[0]) g_unlink(data);
  dt_image_remove(snap);
}

// ------------------------------------------------------------ library

// the text fields a client may edit, as darktable's metadata keys
const char *library_meta_keys[6][2] = {
  { "title", "Xmp.dc.title" },
  { "description", "Xmp.dc.description" },
  { "creator", "Xmp.dc.creator" },
  { "publisher", "Xmp.dc.publisher" },
  { "rights", "Xmp.dc.rights" },
  { "notes", "Xmp.darktable.notes" },
};

// one image as JSON: identity, rating, labels and the EXIF summary; with
// `full`, its editable metadata too
// Lightroom's keywords are darktable's tags, "|" between the levels of a
// hierarchy; the "darktable|..." ones are darktable's own bookkeeping
static void _keywords_json(JsonBuilder *b, const dt_imgid_t imgid)
{
  GList *tags = NULL;
  dt_tag_get_attached(imgid, &tags, TRUE);
  json_builder_set_member_name(b, "keywords");
  json_builder_begin_array(b);
  for(const GList *t = tags; t; t = g_list_next(t))
    json_builder_add_string_value(b, ((dt_tag_t *)t->data)->tag);
  json_builder_end_array(b);
  dt_tag_free_result(&tags);
}

// a consistent copy of data.db for Backup, made while the engine has it open.
// copying the file would miss what is still in its write-ahead log; VACUUM INTO
// writes one whole file and refuses to overwrite one that exists
gboolean library_data_backup(JsonObject *req, char **err)
{
  const char *path = json_object_get_string_member_with_default(req, "path", "");
  if(!*path)
  {
    *err = g_strdup("no path supplied");
    return FALSE;
  }
  sqlite3_stmt *stmt;
  if(sqlite3_prepare_v2(dt_database_get(darktable.db), "VACUUM data INTO ?1", -1, &stmt, NULL) != SQLITE_OK)
  {
    *err = g_strdup_printf("could not copy the darktable data: %s", sqlite3_errmsg(dt_database_get(darktable.db)));
    return FALSE;
  }
  sqlite3_bind_text(stmt, 1, path, -1, SQLITE_TRANSIENT);
  const int rc = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
  if(rc != SQLITE_DONE)
  {
    *err = g_strdup_printf("could not copy the darktable data: %s", sqlite3_errmsg(dt_database_get(darktable.db)));
    return FALSE;
  }
  return TRUE;
}

// every keyword ever used, which darktable keeps in its data.db beside the
// library, so it outlives this process's in-memory one
void library_all_keywords(JsonBuilder *b)
{
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT name FROM data.tags"
                              " WHERE name NOT LIKE 'darktable|%'"
                              " ORDER BY name COLLATE NOCASE",
                              -1, &stmt, NULL);
  json_builder_set_member_name(b, "keywords");
  json_builder_begin_array(b);
  while(sqlite3_step(stmt) == SQLITE_ROW)
    json_builder_add_string_value(b, (const char *)sqlite3_column_text(stmt, 0));
  json_builder_end_array(b);
  sqlite3_finalize(stmt);
}

// keywords added to and removed from an image, which is then written to
// its sidecar (dc:subject and lr:hierarchicalSubject, exif.cc)
gboolean library_keywords_set(const dt_imgid_t imgid, JsonObject *req, JsonBuilder *b, char **err)
{
  if(!dt_is_valid_imgid(imgid))
  {
    *err = g_strdup("no such image");
    return FALSE;
  }
  JsonArray *add = json_object_has_member(req, "add") ? json_object_get_array_member(req, "add") : NULL;
  JsonArray *remove = json_object_has_member(req, "remove") ? json_object_get_array_member(req, "remove") : NULL;
  for(guint k = 0; add && k < json_array_get_length(add); k++)
  {
    guint tagid = 0;
    if(dt_tag_new(json_array_get_string_element(add, k), &tagid))
      dt_tag_attach(tagid, imgid, FALSE, FALSE);
  }
  for(guint k = 0; remove && k < json_array_get_length(remove); k++)
  {
    guint tagid = 0;
    if(dt_tag_exists(json_array_get_string_element(remove, k), &tagid))
      dt_tag_detach(tagid, imgid, FALSE, FALSE);
  }
  // TRUE means it failed
  if(library_write_sidecar(imgid))
  {
    *err = g_strdup("could not write the XMP sidecar");
    return FALSE;
  }
  _keywords_json(b, imgid);
  return TRUE;
}

void library_image_json(JsonBuilder *b, const dt_imgid_t imgid, const gboolean full)
{
  const dt_image_t *img = dt_image_cache_get(imgid, 'r');
  if(!img) return;
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "imgid");
  json_builder_add_int_value(b, imgid);
  char path[PATH_MAX] = { 0 };
  gboolean from_cache = FALSE;
  dt_image_full_path(imgid, path, sizeof(path), &from_cache);
  engine_add_string(b, "path", path);
  engine_add_string(b, "filename", img->filename);
  // the reject flag sits beside the stars in the same field (image.h)
  json_builder_set_member_name(b, "rating");
  json_builder_add_int_value(b, img->flags & DT_IMAGE_REJECTED ? 0 : (img->flags & 0x7));
  json_builder_set_member_name(b, "rejected");
  json_builder_add_boolean_value(b, (img->flags & DT_IMAGE_REJECTED) != 0);
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, img->final_width > 0 ? img->final_width : img->width);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, img->final_height > 0 ? img->final_height : img->height);
  json_builder_set_member_name(b, "location");
  if(isfinite(img->geoloc.latitude) && isfinite(img->geoloc.longitude))
  {
    json_builder_begin_object(b);
    engine_add_double(b, "latitude", img->geoloc.latitude);
    engine_add_double(b, "longitude", img->geoloc.longitude);
    json_builder_end_object(b);
  }
  else json_builder_add_null_value(b);
  json_builder_set_member_name(b, "exif");
  json_builder_begin_object(b);
  engine_add_string(b, "maker", img->camera_maker);
  engine_add_string(b, "model", img->camera_model);
  engine_add_string(b, "lens", img->exif_lens);
  gchar *body_serial = camera_body_serial(path);
  engine_add_string(b, "body_serial", body_serial);
  g_free(body_serial);
  engine_add_double(b, "exposure", img->exif_exposure);
  engine_add_double(b, "aperture", img->exif_aperture);
  engine_add_double(b, "iso", img->exif_iso);
  engine_add_double(b, "focal_length", img->exif_focal_length);
  engine_add_double(b, "exposure_bias", img->exif_exposure_bias);
  engine_add_double(b, "focus_distance", img->exif_focus_distance);
  // 0 when the camera did not record it
  engine_add_double(b, "crop_factor", img->exif_crop);
  engine_add_string(b, "white_balance", img->exif_whitebalance);
  engine_add_string(b, "flash", img->exif_flash);
  engine_add_string(b, "exposure_program", img->exif_exposure_program);
  engine_add_string(b, "metering_mode", img->exif_metering_mode);
  // the file's own pixel size, before any crop
  json_builder_set_member_name(b, "file_width");
  json_builder_add_int_value(b, img->width);
  json_builder_set_member_name(b, "file_height");
  json_builder_add_int_value(b, img->height);
  char datetime[DT_DATETIME_LENGTH] = { 0 };
  dt_datetime_img_to_exif(datetime, sizeof(datetime), img);
  engine_add_string(b, "datetime", datetime);
  // a photo with no capture time (a camera whose clock was never set
  // writes zeros) is placed by its file's modified time instead
  GStatBuf st;
  if(!*datetime && !g_stat(path, &st))
  {
    GDateTime *mtime = g_date_time_new_from_unix_local(st.st_mtime);
    gchar *file_datetime = mtime ? g_date_time_format(mtime, "%Y:%m:%d %H:%M:%S") : NULL;
    engine_add_string(b, "file_datetime", file_datetime ? file_datetime : "");
    g_free(file_datetime);
    if(mtime) g_date_time_unref(mtime);
  }
  json_builder_set_member_name(b, "sensor_width");
  json_builder_add_int_value(b, img->p_width);
  json_builder_set_member_name(b, "sensor_height");
  json_builder_add_int_value(b, img->p_height);
  json_builder_end_object(b);
  dt_image_cache_read_release(img);

  json_builder_set_member_name(b, "labels");
  json_builder_add_int_value(b, dt_colorlabels_get_labels(imgid));
  json_builder_set_member_name(b, "edited");
  json_builder_add_boolean_value(b, dt_image_altered(imgid));
  // a virtual copy is any version of a file but its lowest
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT a.version, EXISTS(SELECT 1 FROM main.images AS b"
                              "  WHERE b.film_id = a.film_id AND b.filename = a.filename"
                              "    AND b.version < a.version)"
                              " FROM main.images AS a WHERE a.id = ?1",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  const gboolean row = sqlite3_step(stmt) == SQLITE_ROW;
  json_builder_set_member_name(b, "version");
  json_builder_add_int_value(b, row ? sqlite3_column_int(stmt, 0) : 0);
  json_builder_set_member_name(b, "copy");
  json_builder_add_boolean_value(b, row && sqlite3_column_int(stmt, 1));
  sqlite3_finalize(stmt);

  if(full)
  {
    json_builder_set_member_name(b, "metadata");
    json_builder_begin_object(b);
    for(size_t k = 0; k < G_N_ELEMENTS(library_meta_keys); k++)
    {
      GList *res = dt_metadata_get(imgid, library_meta_keys[k][1], NULL);
      engine_add_string(b, library_meta_keys[k][0], res ? (const char *)res->data : "");
      g_list_free_full(res, g_free);
    }
    json_builder_end_object(b);
  }
  // always, as the filmstrip's filter narrows the folder by them
  _keywords_json(b, imgid);
  json_builder_end_object(b);
}

// every version of the file `imgid` belongs to, lowest first: darktable's
// duplicates, which the client calls virtual copies, but not an export's
// snapshots. import reads each "<name>_NN.<ext>.xmp" into its own row
// (image.c, _image_read_duplicates())
GList *library_image_versions(const dt_imgid_t imgid)
{
  GList *ids = NULL;
  sqlite3_stmt *stmt;
  DT_DEBUG_SQLITE3_PREPARE_V2(dt_database_get(darktable.db),
                              "SELECT b.id FROM main.images AS a, main.images AS b"
                              " WHERE a.id = ?1 AND b.film_id = a.film_id AND b.filename = a.filename"
                              "   AND b.version < ?2"
                              " ORDER BY b.version",
                              -1, &stmt, NULL);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 1, imgid);
  DT_DEBUG_SQLITE3_BIND_INT(stmt, 2, _SNAPSHOT_VERSION);
  while(sqlite3_step(stmt) == SQLITE_ROW)
    ids = g_list_prepend(ids, GINT_TO_POINTER(sqlite3_column_int(stmt, 0)));
  sqlite3_finalize(stmt);
  return g_list_reverse(ids);
}

static void _image_versions_json(JsonBuilder *b, const dt_imgid_t imgid)
{
  GList *ids = library_image_versions(imgid);
  for(GList *l = ids; l; l = g_list_next(l)) library_image_json(b, GPOINTER_TO_INT(l->data), FALSE);
  g_list_free(ids);
}

// a version's own sidecars, with the duplicate suffix: its xmp, and its
// raster mask data when there is any
static void _version_sidecars(const dt_imgid_t imgid, JsonBuilder *b)
{
  char path[PATH_MAX] = { 0 };
  gboolean from_cache = FALSE;
  dt_image_full_path(imgid, path, sizeof(path), &from_cache);
  dt_image_path_append_version(imgid, path, sizeof(path));
  char data[PATH_MAX] = { 0 };
  dt_dtdata_path_for_image(path, data, sizeof(data));
  g_strlcat(path, ".xmp", sizeof(path));
  if(g_file_test(path, G_FILE_TEST_EXISTS)) json_builder_add_string_value(b, path);
  if(g_file_test(data, G_FILE_TEST_EXISTS)) json_builder_add_string_value(b, data);
}

// a new version of `src` carrying its edit, labels, metadata and keywords,
// with its own sidecar. darktable's lighttable does the same
// (libs/duplicate.c), but pastes through dt_image_synch_xmp(), a queued job
gboolean library_copy(const dt_imgid_t src, JsonBuilder *b, char **err)
{
  if(!dt_is_valid_imgid(src) || !dt_image_exists(src))
  {
    *err = g_strdup("no such image");
    return FALSE;
  }
  // the copy starts from the edit as the client sees it
  if(_s.open && _s.imgid == src && _s.unsaved && !_s.before && !session_save(err)) return FALSE;
  // an unedited original has no sidecar yet. without one, the next import
  // takes the copy's "_01" sidecar for the original's own and makes it
  // version 1 (image.c, _image_read_duplicates()). TRUE means it failed
  if(library_write_sidecar(src))
  {
    *err = g_strdup("could not write the XMP sidecar");
    return FALSE;
  }
  const dt_imgid_t newid = dt_image_duplicate(src);
  if(!dt_is_valid_imgid(newid))
  {
    *err = g_strdup("could not create the copy");
    return FALSE;
  }
  dt_history_copy_and_paste_on_image(src, newid, FALSE, NULL, TRUE, TRUE, FALSE);
  if(library_write_sidecar(newid))
  {
    *err = g_strdup("could not write the copy's XMP sidecar");
    return FALSE;
  }
  json_builder_set_member_name(b, "image");
  library_image_json(b, newid, FALSE);
  return TRUE;
}

// takes a version out of the library and names its sidecars, for the
// client to move to the trash. the file itself stays for the other
// versions, so the last one is refused
gboolean library_remove_copy(const dt_imgid_t imgid, JsonBuilder *b, char **err)
{
  GList *ids = dt_is_valid_imgid(imgid) ? library_image_versions(imgid) : NULL;
  const guint n = g_list_length(ids);
  g_list_free(ids);
  if(n < 2)
  {
    *err = g_strdup(n ? "the only version of a photo cannot be removed" : "no such image");
    return FALSE;
  }
  if(_s.open && _s.imgid == imgid) session_close_session();
  json_builder_set_member_name(b, "files");
  json_builder_begin_array(b);
  _version_sidecars(imgid, b);
  json_builder_end_array(b);
  // the paths first: they need the row, which this removes
  dt_image_remove(imgid);
  return TRUE;
}

// the library's rows for a file deleted from disk, every version. a new file
// at the same path would otherwise import as the old row, rejected and with
// its edit, since dt_image_import() returns the row the film and name find
// (image.c, _image_import_internal()) and there is no sidecar left to read
gboolean library_forget(const dt_imgid_t imgid, char **err)
{
  GList *ids = dt_is_valid_imgid(imgid) ? library_image_versions(imgid) : NULL;
  if(!ids)
  {
    *err = g_strdup("no such image");
    return FALSE;
  }
  for(GList *l = ids; l; l = g_list_next(l))
  {
    const dt_imgid_t id = GPOINTER_TO_INT(l->data);
    if(_s.open && _s.imgid == id) session_close_session();
    dt_image_remove(id);
  }
  g_list_free(ids);
  return TRUE;
}

// every sidecar of the file `imgid` belongs to, all versions' and any left
// over, as darktable deletes with the file (control_jobs.c, _delete_job_run())
// the photo's xmp sidecars: file.ext.xmp and file_NN.ext.xmp. darktable's
// dt_image_find_duplicates() builds a glob() pattern from the file name, so
// a name with [ * ? or a backslash matches wrongly or not at all; the folder
// is listed and the names compared as they are
static GList *_find_xmp_sidecars(const char *image_path)
{
  GList *list = NULL;
  gchar *dir = g_path_get_dirname(image_path);
  gchar *base = g_path_get_basename(image_path);
  const char *dot = strrchr(base, '.');
  const size_t stem_len = dot ? (size_t)(dot - base) : strlen(base);
  gchar *tail = g_strconcat(dot ? dot : "", ".xmp", NULL);
  const size_t tail_len = strlen(tail);
  GDir *d = g_dir_open(dir, 0, NULL);
  const char *name;
  while(d && (name = g_dir_read_name(d)))
  {
    const size_t len = strlen(name);
    if(len < stem_len + tail_len || strncmp(name, base, stem_len) || strcmp(name + len - tail_len, tail))
      continue;
    const char *v = name + stem_len;
    const char *vend = name + len - tail_len;
    if(v != vend)
    {
      // a version: "_" and at least two digits
      if(*v != '_' || vend - v < 3) continue;
      gboolean digits = TRUE;
      for(const char *c = v + 1; c < vend; c++)
        if(!g_ascii_isdigit(*c)) digits = FALSE;
      if(!digits) continue;
    }
    gchar *file = g_build_filename(dir, name, NULL);
    if(dt_util_test_image_file(file)) list = g_list_prepend(list, file);
    else g_free(file);
  }
  if(d) g_dir_close(d);
  g_free(tail);
  g_free(base);
  g_free(dir);
  return g_list_sort(list, (GCompareFunc)g_strcmp0);
}

gboolean library_sidecars(const dt_imgid_t imgid, JsonBuilder *b, char **err)
{
  char path[PATH_MAX] = { 0 };
  gboolean from_cache = FALSE;
  if(!dt_is_valid_imgid(imgid) || !dt_image_exists(imgid))
  {
    *err = g_strdup("no such image");
    return FALSE;
  }
  dt_image_full_path(imgid, path, sizeof(path), &from_cache);
  json_builder_set_member_name(b, "files");
  json_builder_begin_array(b);
  GList *files = g_list_concat(_find_xmp_sidecars(path), dt_dtdata_find_all(path));
  for(GList *l = files; l; l = g_list_next(l)) json_builder_add_string_value(b, l->data);
  g_list_free_full(files, g_free);
  json_builder_end_array(b);
  return TRUE;
}

static int _unpack_data(struct archive *in, struct archive *out)
{
  const void *buf;
  size_t size;
  la_int64_t offset;
  int r;
  while((r = archive_read_data_block(in, &buf, &size, &offset)) == ARCHIVE_OK)
    if(archive_write_data_block(out, buf, size, offset) < ARCHIVE_WARN) return ARCHIVE_FATAL;
  return r == ARCHIVE_EOF ? ARCHIVE_OK : r;
}

// a darktable model archive (.dtmodel, a zip) unpacked into `dir` with
// darktable's libarchive, as its own install does (src/common/ai_models.c,
// _extract_zip), so the app needs no unzip of the system's: an Arch install
// has none. the app checks the archive's sha256 first
gboolean library_unpack(const char *archive, const char *dir, char **err)
{
  if(!archive || !dir)
  {
    *err = g_strdup("unpack needs an archive and a folder");
    return FALSE;
  }
  if(g_mkdir_with_parents(dir, 0755))
  {
    *err = g_strdup_printf("cannot create %s", dir);
    return FALSE;
  }
  // ARCHIVE_EXTRACT_SECURE_SYMLINKS refuses a symlink anywhere in the path,
  // `dir`'s own included (macOS' /var, a home folder moved elsewhere), so
  // it is resolved first, as darktable's _canonical_path_utf8 does
#ifdef _WIN32
  wchar_t *wdir = g_utf8_to_utf16(dir, -1, NULL, NULL, NULL);
  wchar_t wreal[_MAX_PATH];
  gchar *real = wdir && _wfullpath(wreal, wdir, _MAX_PATH)
    ? g_utf16_to_utf8((gunichar2 *)wreal, -1, NULL, NULL, NULL) : NULL;
  g_free(wdir);
  if(!real) real = g_strdup(dir);
#else
  char *resolved = realpath(dir, NULL);
  gchar *real = g_strdup(resolved ? resolved : dir);
  free(resolved);
#endif
  struct archive *in = archive_read_new();
  archive_read_support_format_zip(in);
  struct archive *out = archive_write_disk_new();
  // no ARCHIVE_EXTRACT_SECURE_NOABSOLUTEPATHS: every path is absolute once
  // `dir` is put ahead of it, so an absolute entry is refused before that
  archive_write_disk_set_options(out, ARCHIVE_EXTRACT_TIME | ARCHIVE_EXTRACT_PERM
                                      | ARCHIVE_EXTRACT_SECURE_SYMLINKS
                                      | ARCHIVE_EXTRACT_SECURE_NODOTDOT);
  // libarchive's narrow paths are in the ANSI code page on Windows, and the
  // models folder is under the user's profile, whose name can be any
#ifdef _WIN32
  wchar_t *wpath = g_utf8_to_utf16(archive, -1, NULL, NULL, NULL);
  int r = wpath ? archive_read_open_filename_w(in, wpath, 10240) : ARCHIVE_FATAL;
  g_free(wpath);
#else
  int r = archive_read_open_filename(in, archive, 10240);
#endif
  const char *bad = NULL;
  struct archive_entry *entry;
  while(r == ARCHIVE_OK && (r = archive_read_next_header(in, &entry)) == ARCHIVE_OK)
  {
    const char *name = archive_entry_pathname_utf8(entry);
    if(!name || !name[0] || g_path_is_absolute(name))
    {
      bad = name ? name : "";
      break;
    }
    gchar *dest = g_build_filename(real, name, NULL);
#ifdef _WIN32
    wchar_t *wdest = g_utf8_to_utf16(dest, -1, NULL, NULL, NULL);
    archive_entry_copy_pathname_w(entry, wdest);
    g_free(wdest);
#else
    archive_entry_set_pathname(entry, dest);
#endif
    g_free(dest);
    r = archive_write_header(out, entry) < ARCHIVE_WARN ? ARCHIVE_FATAL : ARCHIVE_OK;
    if(r == ARCHIVE_OK && archive_entry_size(entry) > 0) r = _unpack_data(in, out);
    if(r == ARCHIVE_OK && archive_write_finish_entry(out) < ARCHIVE_WARN) r = ARCHIVE_FATAL;
  }
  if(bad)
    *err = g_strdup_printf("%s: refused the entry '%s'", archive, bad);
  else if(r != ARCHIVE_EOF)
    *err = g_strdup_printf("%s: %s", archive,
                           archive_error_string(out) ? archive_error_string(out)
                           : archive_error_string(in) ? archive_error_string(in) : "cannot unpack");
  archive_read_free(in);
  archive_write_free(out);
  g_free(real);
  return !*err;
}

static gboolean _is_sidecar(const char *name)
{
  const char *dot = strrchr(name, '.');
  return dot && !g_ascii_strcasecmp(dot, ".xmp");
}

// import every image of a folder (not its subfolders), sidecars muted
// the files of `dir`, as paths relative to `root`, and with `recursive`
// those of its subfolders too, each folder's after its own files. dot
// files and folders are left out, and so are sidecars
static GList *_folder_files(const char *root, const char *rel, const gboolean recursive, GList *out)
{
  gchar *dir = rel ? g_build_filename(root, rel, NULL) : g_strdup(root);
  GDir *d = g_dir_open(dir, 0, NULL);
  if(!d)
  {
    g_free(dir);
    return out;
  }
  GList *files = NULL, *subdirs = NULL;
  const char *name;
  while((name = g_dir_read_name(d)))
  {
    if(name[0] == '.' || _is_sidecar(name)) continue;
    gchar *path = g_build_filename(dir, name, NULL);
    gchar *child = rel ? g_build_filename(rel, name, NULL) : g_strdup(name);
    if(g_file_test(path, G_FILE_TEST_IS_DIR))
    {
      if(recursive) subdirs = g_list_prepend(subdirs, child); else g_free(child);
    }
    else
      files = g_list_prepend(files, child);
    g_free(path);
  }
  g_dir_close(d);
  g_free(dir);
  out = g_list_concat(out, g_list_sort(files, (GCompareFunc)g_ascii_strcasecmp));
  subdirs = g_list_sort(subdirs, (GCompareFunc)g_ascii_strcasecmp);
  for(GList *s = subdirs; s; s = g_list_next(s)) out = _folder_files(root, s->data, TRUE, out);
  g_list_free_full(subdirs, g_free);
  return out;
}

gboolean library_folder(const char *dir, const gboolean recursive, JsonBuilder *b, char **err)
{
  if(!g_file_test(dir, G_FILE_TEST_IS_DIR))
  {
    *err = g_strdup_printf("cannot read folder '%s'", dir);
    return FALSE;
  }
  GList *names = _folder_files(dir, NULL, recursive, NULL);

  json_builder_set_member_name(b, "images");
  json_builder_begin_array(b);
  for(GList *n = names; n; n = g_list_next(n))
  {
    gchar *path = g_build_filename(dir, n->data, NULL);
    // dt_image_import() refuses what darktable cannot read
    const dt_imgid_t imgid = g_file_test(path, G_FILE_TEST_IS_REGULAR) ? library_import(path) : NO_IMGID;
    if(dt_is_valid_imgid(imgid)) _image_versions_json(b, imgid);
    g_free(path);
  }
  json_builder_end_array(b);
  g_list_free_full(names, g_free);
  return TRUE;
}

// the folder read whose batch was queued last (its `job`), set by the
// request reader (_read_requests). a batch of another read stops before its
// next file: the import thread takes batches in turn, and an open photo
// waits on _import_lock, so a network share's batches left behind by a
// change of folder held up the next folder and photo for minutes. the
// newest rather than the highest, as the client's numbering restarts
gint64 library_import_latest = 0;

// a read of a network share can block for minutes (a half-dead SMB mount
// took 129 s on one file) and cannot be interrupted, and library_import() holds
// _import_lock while it reads, which held up every open photo and the next
// folder with it. so a file is first read for its first bytes, and its
// sidecar's, on a throwaway thread that is waited on for a while only; the
// import then finds both in the client's cache. a file that does not answer
// is skipped, and so is its folder for a while, as every file there waits
// the same way. the abandoned thread ends when the mount answers or fails
#define _PROBE_TIMEOUT_US (5 * G_USEC_PER_SEC)
#define _PROBE_QUARANTINE_US (30 * G_USEC_PER_SEC)

typedef struct _probe_t
{
  GMutex lock;
  GCond done;
  gboolean finished;
  gint refs;
  char *path;
} _probe_t;

static void _probe_unref(_probe_t *p)
{
  if(!g_atomic_int_dec_and_test(&p->refs)) return;
  g_mutex_clear(&p->lock);
  g_cond_clear(&p->done);
  g_free(p->path);
  g_free(p);
}

static void _probe_read(const char *path)
{
  FILE *f = g_fopen(path, "rb");
  if(!f) return;
  char buf[4096];
  if(fread(buf, 1, sizeof(buf), f)) {} // the bytes themselves are not used
  fclose(f);
}

static gpointer _probe_run(gpointer data)
{
  _probe_t *p = data;
  _probe_read(p->path);
  gchar *xmp = g_strconcat(p->path, ".xmp", NULL);
  _probe_read(xmp);
  g_free(xmp);
  eng_lock(&p->lock, ENG_LOCK_PROBE);
  p->finished = TRUE;
  g_cond_signal(&p->done);
  eng_unlock(&p->lock, ENG_LOCK_PROBE);
  _probe_unref(p);
  return NULL;
}

static GMutex _quarantine_lock;
static GHashTable *_quarantine = NULL; // folder -> monotonic time it is skipped until

// FALSE when the file did not answer within `timeout_us`, or its folder
// did not a moment ago
static gboolean _file_answers(const char *path, const gint64 timeout_us)
{
  gchar *dir = g_path_get_dirname(path);
  const gint64 now = g_get_monotonic_time();
  eng_lock(&_quarantine_lock, ENG_LOCK_PROBE);
  if(!_quarantine) _quarantine = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  const gint64 *until = g_hash_table_lookup(_quarantine, dir);
  const gboolean held = until && *until > now;
  eng_unlock(&_quarantine_lock, ENG_LOCK_PROBE);
  if(held)
  {
    g_free(dir);
    return FALSE;
  }

  _probe_t *p = g_new0(_probe_t, 1);
  g_mutex_init(&p->lock);
  g_cond_init(&p->done);
  p->refs = 2; // this call and the thread
  p->path = g_strdup(path);
  GThread *t = g_thread_new("import-probe", _probe_run, p);
  g_thread_unref(t);

  const gint64 deadline = now + timeout_us;
  eng_lock(&p->lock, ENG_LOCK_PROBE);
  while(!p->finished && g_cond_wait_until(&p->done, &p->lock, deadline)) {}
  const gboolean answered = p->finished;
  eng_unlock(&p->lock, ENG_LOCK_PROBE);
  _probe_unref(p);

  if(!answered)
  {
    gint64 *when = g_new(gint64, 1);
    *when = g_get_monotonic_time() + _PROBE_QUARANTINE_US;
    eng_lock(&_quarantine_lock, ENG_LOCK_PROBE);
    g_hash_table_replace(_quarantine, dir, when); // takes `dir`
    eng_unlock(&_quarantine_lock, ENG_LOCK_PROBE);
    fprintf(stderr, "[engine] %s did not answer in %.1f s; skipped, as is its folder for %d s\n", path,
            timeout_us / 1e6, (int)(_PROBE_QUARANTINE_US / G_USEC_PER_SEC));
  }
  else
    g_free(dir);
  return answered;
}

// import these files, as library_folder() does a folder's: the client lists the
// folder itself and sends it in batches, so it can show its progress. with
// a `job`, a batch stops once a newer read's is queued; with a `budget` (ms),
// once that has passed, after a file at least. `done` is how many of the
// files it went through, so the client sends the rest again
void library_import_files(JsonObject *req, JsonBuilder *b, const gboolean background)
{
  JsonArray *files = json_object_has_member(req, "files") ? json_object_get_array_member(req, "files") : NULL;
  const gint64 job = json_object_get_int_member_with_default(req, "job", 0);
  const gint64 budget = json_object_get_int_member_with_default(req, "budget", 0) * 1000;
  const gint64 probe = json_object_get_int_member_with_default(req, "probe_ms", _PROBE_TIMEOUT_US / 1000) * 1000;
  const gint64 start = g_get_monotonic_time();
  const guint n = files ? json_array_get_length(files) : 0;
  guint k = 0;
  GPtrArray *silent = g_ptr_array_new(); // paths that did not answer, owned by `files`
  json_builder_set_member_name(b, "images");
  json_builder_begin_array(b);
  for(; k < n; k++)
  {
    if(job)
    {
      eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
      const gboolean superseded = library_import_latest != job;
      eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
      if(superseded) break;
    }
    if(budget && k && g_get_monotonic_time() - start >= budget) break;
    if(background) engine_background_yield(); // the main loop's own import is the foreground work
    const char *path = json_array_get_string_element(files, k);
    if(!path || _is_sidecar(path)) continue;
    if(!g_file_test(path, G_FILE_TEST_IS_REGULAR)) continue;
    if(!_file_answers(path, probe))
    {
      g_ptr_array_add(silent, (gpointer)path);
      continue;
    }
    const dt_imgid_t imgid = library_import(path);
    if(dt_is_valid_imgid(imgid)) _image_versions_json(b, imgid);
  }
  json_builder_end_array(b);
  json_builder_set_member_name(b, "unanswered");
  json_builder_begin_array(b);
  for(guint i = 0; i < silent->len; i++) json_builder_add_string_value(b, g_ptr_array_index(silent, i));
  json_builder_end_array(b);
  g_ptr_array_free(silent, TRUE);
  json_builder_set_member_name(b, "done");
  json_builder_add_int_value(b, k);
  // the queued line is logged as it comes in (_read_requests); this one
  // shows how far behind the import thread runs
  fprintf(stderr, "[engine] imported %u of %u in %.0f ms%s\n", k, n,
          (g_get_monotonic_time() - start) / 1000.0, k < n ? " (stopped)" : "");
}

// a tagged `import` runs here rather than in the main loop, so a folder
// is read while the photo is edited and rendered, as darktable's own
// import runs as a job beside its views (control/jobs/control_jobs.c).
// one thread: _import_lock already keeps imports apart, and a batch's
// reply is its progress
GThreadPool *library_import_pool = NULL;
static GMutex _import_pool_lock;

void library_import_run(gpointer data, gpointer user_data)
{
  JsonParser *parser = data;
  FILE *out = user_data;
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member(req, "tag"));
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, TRUE);
  library_import_files(req, b, TRUE);
  json_builder_end_object(b);
  engine_reply(out, b);
  g_object_unref(b);
  g_object_unref(parser);
}

// FALSE once the pool has stopped; the request then gets no reply
gboolean library_import_queue(JsonParser *parser)
{
  eng_lock(&_import_pool_lock, ENG_LOCK_POOL);
  const gboolean queued = library_import_pool != NULL;
  if(queued) g_thread_pool_push(library_import_pool, parser, NULL);
  eng_unlock(&_import_pool_lock, ENG_LOCK_POOL);
  return queued;
}

// before darktable's caches go: the batch under way finishes, those
// waiting are dropped
void library_import_wait(void)
{
  eng_lock(&_import_pool_lock, ENG_LOCK_POOL);
  GThreadPool *pool = library_import_pool;
  library_import_pool = NULL;
  eng_unlock(&_import_pool_lock, ENG_LOCK_POOL);
  if(pool) g_thread_pool_free(pool, TRUE, TRUE);
}

// the lighttable's thumbnail for an image: the embedded preview of an
// unedited raw, a processed render of an edited one. the buffer is 8-bit
// RGBA (views/view.c swaps it to BGRA for cairo); its color space is
// reported, as it is not always sRGB
gboolean library_thumb(const dt_imgid_t imgid, const int size, const gboolean proof, const char *out,
                       JsonBuilder *b, char **err)
{
  const dt_mipmap_size_t mip = dt_mipmap_cache_get_matching_size(size, size);
  dt_mipmap_buffer_t buf;
  dt_mipmap_cache_get(&buf, imgid, mip, DT_MIPMAP_BLOCKING, 'r');
  if(!buf.buf || buf.width <= 0 || buf.height <= 0)
  {
    dt_mipmap_cache_release(&buf);
    *err = g_strdup_printf("no thumbnail for image %d", imgid);
    return FALSE;
  }
  // the print sheet's cells, shown as the soft proof does: a copy, as the
  // cache's buffer is shared; sRGB once proofed
  const size_t bytes = (size_t)4 * buf.width * buf.height;
  uint8_t *copy = proof ? g_try_malloc(bytes) : NULL;
  if(copy) memcpy(copy, buf.buf, bytes);
  const gboolean proofed = copy && print_proof_pixels(copy, buf.width, buf.height, buf.color_space);
  const gboolean ok = engine_transient_write(out, proofed ? copy : buf.buf, bytes, NULL, 0);
  g_free(copy);
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, buf.width);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, buf.height);
  json_builder_set_member_name(b, "color_space");
  json_builder_add_int_value(b, proofed ? DT_COLORSPACE_SRGB : buf.color_space);
  dt_mipmap_cache_release(&buf);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

GThreadPool *library_thumb_pool = NULL;
static GMutex _thumb_lock;

void library_thumb_run(gpointer data, gpointer user_data)
{
  JsonParser *parser = data;
  FILE *out = user_data;
  engine_background_yield();
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  const char *dest = json_object_get_string_member_with_default(req, "out", NULL);
  char *err = NULL;
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member(req, "tag"));
  const gboolean ok = dest && library_thumb(json_object_get_int_member_with_default(req, "imgid", 0),
                                     json_object_get_int_member_with_default(req, "size", 256),
                                     json_object_get_boolean_member_with_default(req, "proof", FALSE), dest, b, &err);
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, ok);
  if(!ok)
  {
    json_builder_set_member_name(b, "error");
    json_builder_add_string_value(b, err ? err : "no output file");
  }
  json_builder_end_object(b);
  engine_reply(out, b);
  g_object_unref(b);
  g_free(err);
  g_object_unref(parser);
}

// FALSE once the pool has stopped; the request then gets no reply
gboolean library_thumb_queue(JsonParser *parser)
{
  eng_lock(&_thumb_lock, ENG_LOCK_POOL);
  const gboolean queued = library_thumb_pool != NULL;
  if(queued) g_thread_pool_push(library_thumb_pool, parser, NULL);
  eng_unlock(&_thumb_lock, ENG_LOCK_POOL);
  return queued;
}

// before darktable's caches go: the thumbnails under way finish, those
// waiting are dropped
void library_thumb_wait(void)
{
  eng_lock(&_thumb_lock, ENG_LOCK_POOL);
  GThreadPool *pool = library_thumb_pool;
  library_thumb_pool = NULL;
  eng_unlock(&_thumb_lock, ENG_LOCK_POOL);
  if(pool) g_thread_pool_free(pool, TRUE, TRUE);
}

void library_thumb_threads(gint n)
{
  eng_lock(&_thumb_lock, ENG_LOCK_POOL);
  if(library_thumb_pool) g_thread_pool_set_max_threads(library_thumb_pool, n, NULL);
  eng_unlock(&_thumb_lock, ENG_LOCK_POOL);
}

// rating (0-5), rejected, labels (bit mask: red 1, yellow 2, green 4, blue
// 8, purple 16) and the text fields; whatever the request names is set, and
// the sidecar written
gboolean library_meta_set(const dt_imgid_t imgid, JsonObject *req, char **err)
{
  if(!dt_is_valid_imgid(imgid))
  {
    *err = g_strdup("no such image");
    return FALSE;
  }
  if(json_object_has_member(req, "location"))
  {
    dt_image_geoloc_t geo = { NAN, NAN, NAN };
    if(!JSON_NODE_HOLDS_NULL(json_object_get_member(req, "location")))
    {
      JsonNode *node = json_object_get_member(req, "location");
      JsonObject *location = JSON_NODE_HOLDS_OBJECT(node) ? json_node_get_object(node) : NULL;
      JsonNode *lat = location ? json_object_get_member(location, "latitude") : NULL;
      JsonNode *lon = location ? json_object_get_member(location, "longitude") : NULL;
      if(!lat || !lon || !JSON_NODE_HOLDS_VALUE(lat) || !JSON_NODE_HOLDS_VALUE(lon)
         || (json_node_get_value_type(lat) != G_TYPE_DOUBLE && json_node_get_value_type(lat) != G_TYPE_INT64)
         || (json_node_get_value_type(lon) != G_TYPE_DOUBLE && json_node_get_value_type(lon) != G_TYPE_INT64))
      {
        *err = g_strdup("location needs numeric latitude and longitude");
        return FALSE;
      }
      geo.latitude = json_node_get_double(lat);
      geo.longitude = json_node_get_double(lon);
      if(!isfinite(geo.latitude) || !isfinite(geo.longitude)
         || fabs(geo.latitude) > 90 || fabs(geo.longitude) > 180)
      {
        *err = g_strdup("latitude must be between -90 and 90, longitude between -180 and 180");
        return FALSE;
      }
      dt_image_geoloc_t previous;
      dt_image_get_location(imgid, &previous);
      // moving a pin invalidates an elevation measured at the previous position
      if(previous.latitude == geo.latitude && previous.longitude == geo.longitude)
        geo.elevation = previous.elevation;
    }
    dt_image_set_location(imgid, &geo, FALSE, FALSE);
  }
  if(json_object_has_member(req, "rejected") && json_object_get_boolean_member(req, "rejected"))
    dt_ratings_apply_on_image(imgid, DT_VIEW_REJECT, FALSE, FALSE, FALSE);
  else if(json_object_has_member(req, "rating") || json_object_has_member(req, "rejected"))
  {
    const int r = json_object_has_member(req, "rating")
      ? CLAMP(json_object_get_int_member(req, "rating"), 0, 5) : dt_ratings_get(imgid);
    dt_ratings_apply_on_image(imgid, r == DT_VIEW_REJECT ? 0 : r, FALSE, FALSE, FALSE);
  }
  if(json_object_has_member(req, "labels"))
  {
    const int mask = json_object_get_int_member(req, "labels");
    dt_colorlabels_remove_all_labels(imgid);
    for(int c = 0; c < 5; c++)
      if(mask & (1 << c)) dt_colorlabels_set_label(imgid, c);
  }
  for(size_t k = 0; k < G_N_ELEMENTS(library_meta_keys); k++)
    if(json_object_has_member(req, library_meta_keys[k][0]))
      dt_metadata_set(imgid, library_meta_keys[k][1],
                      json_object_get_string_member(req, library_meta_keys[k][0]), FALSE);
  // TRUE means it failed
  if(_write_sidecar_location(imgid, json_object_has_member(req, "location")))
  {
    *err = g_strdup("could not write the XMP sidecar");
    return FALSE;
  }
  return TRUE;
}

// validate the whole batch before changing anything; stale times also protect undo
gboolean library_capture_times(JsonObject *req, JsonBuilder *b, char **err)
{
  JsonArray *entries = json_object_get_array_member(req, "entries");
  if(!entries || !json_array_get_length(entries))
  {
    *err = g_strdup("no capture times supplied");
    return FALSE;
  }
  GHashTable *seen = g_hash_table_new(g_direct_hash, g_direct_equal);
  for(guint k = 0; k < json_array_get_length(entries); k++)
  {
    JsonObject *entry = json_array_get_object_element(entries, k);
    const dt_imgid_t imgid = json_object_get_int_member_with_default(entry, "imgid", 0);
    const char *before = json_object_get_string_member_with_default(entry, "before", "");
    const char *after = json_object_get_string_member_with_default(entry, "after", "");
    char current[DT_DATETIME_LENGTH] = { 0 }, canonical[DT_DATETIME_LENGTH] = { 0 };
    if(dt_is_valid_imgid(imgid)) dt_image_get_datetime(imgid, current);
    GTimeZone *tz = g_time_zone_new_utc();
    GDateTime *date = dt_datetime_exif_to_gdatetime(after, tz);
    g_time_zone_unref(tz);
    if(date) dt_datetime_gdatetime_to_exif(canonical, sizeof(canonical), date);
    if(date) g_date_time_unref(date);
    if(!*current || strcmp(current, before) || strcmp(canonical, after))
    {
      g_hash_table_unref(seen);
      *err = g_strdup_printf("image %d has an invalid or changed capture time; reopen the dialog", imgid);
      return FALSE;
    }
    if(!g_hash_table_add(seen, GINT_TO_POINTER(imgid)))
    {
      g_hash_table_unref(seen);
      *err = g_strdup("duplicate image in capture time batch");
      return FALSE;
    }
  }
  g_hash_table_unref(seen);
  json_builder_set_member_name(b, "updates");
  json_builder_begin_array(b);
  for(guint k = 0; k < json_array_get_length(entries); k++)
  {
    JsonObject *entry = json_array_get_object_element(entries, k);
    const dt_imgid_t imgid = json_object_get_int_member(entry, "imgid");
    const char *before = json_object_get_string_member(entry, "before");
    const char *after = json_object_get_string_member(entry, "after");
    GList *imgs = g_list_append(NULL, GINT_TO_POINTER(imgid));
    dt_image_set_datetime(imgs, after, FALSE);
    const gboolean failed = library_write_sidecar(imgid);
    if(failed) dt_image_set_datetime(imgs, before, FALSE);
    g_list_free(imgs);
    if(_s.open && _s.imgid == imgid)
      dt_datetime_exif_to_img(&_s.dev.image_storage, failed ? before : after);
    json_builder_begin_object(b);
    json_builder_set_member_name(b, "imgid");
    json_builder_add_int_value(b, imgid);
    engine_add_string(b, "before", before);
    engine_add_string(b, "after", failed ? before : after);
    if(failed) engine_add_string(b, "error", "could not write the XMP sidecar");
    json_builder_end_object(b);
  }
  json_builder_end_array(b);
  return TRUE;
}

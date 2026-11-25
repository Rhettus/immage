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
#include "common/exif.h"
#include "develop/imageop_math.h"
#include "imageio/imageio_jpeg.h"

// photos likely opened next, their raws decoded ahead on threads of their
// own, a few at once: a raw's decode mostly keeps to one core. darktable's
// job threads would do it (DT_MIPMAP_PREFETCH), but without its GUI
// darktable starts none (control.c, dt_control_init). a new list replaces
// the photos still waiting, not those being decoded. `open` of one of them
// then finds the decoded raw in the mipmap cache, or waits on the decode
// under way. the cache keeps dt_worker_threads() + 1 full raws, 5 or 8
// (mipmap_cache.c, dt_mipmap_cache_init), so a longer list would push out
// the open photo's neighbors it decoded first: main.c cuts it to fit
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
  // a drive already known to be stuck is not read: the import would wait on
  // _import_lock behind its stuck read, and then join it (drives.c)
  drives_t *drive = drives_of(path);
  if(drives_held(drive))
  {
    fprintf(stderr, "[engine] %s not imported: drive %s is not answering\n", path, drives_mount(drive));
    return NO_IMGID;
  }
  gchar *dir = g_path_get_dirname(path);
  eng_lock(&_import_lock, ENG_LOCK_IMPORT);
  // from here, not before the lock: waiting on it is not the drive's time
  const int slot = drives_import_begin(drive);
  drives_test_stall(path);
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
  drives_import_end(slot);
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
  gchar *capture = NULL, *offset = NULL;
  gchar *body_serial = camera_source_metadata(path, &capture, &offset);
  engine_add_string(b, "body_serial", body_serial);
  g_free(body_serial);
  engine_add_string(b, "capture_time_raw", capture);
  engine_add_string(b, "capture_offset", offset);
  g_free(capture); g_free(offset);
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

// Drop imported IDs under a moved folder. No filesystem calls are needed.
gboolean library_forget_folder(const char *path, char **err)
{
  if(!path || !*path)
  {
    *err = g_strdup("missing folder path");
    return FALSE;
  }
  sqlite3 *db = dt_database_get(darktable.db);
  sqlite3_stmt *stmt = NULL;
#ifdef G_OS_WIN32
#define FOLDER_MATCH "replace(folder, char(92), '/') = replace(?1, char(92), '/') OR " \
                     "substr(replace(folder, char(92), '/'), 1, length(?1) + 1) = replace(?1, char(92), '/') || '/'"
#else
#define FOLDER_MATCH "folder = ?1 OR substr(folder, 1, length(?1) + 1) = ?1 || '/'"
#endif
  if(sqlite3_prepare_v2(db, "SELECT id FROM main.images WHERE film_id IN "
                       "(SELECT id FROM main.film_rolls WHERE " FOLDER_MATCH ")", -1, &stmt, NULL) != SQLITE_OK)
  {
    *err = g_strdup(sqlite3_errmsg(db));
    return FALSE;
  }
  sqlite3_bind_text(stmt, 1, path, -1, SQLITE_TRANSIENT);
  GArray *ids = g_array_new(FALSE, FALSE, sizeof(dt_imgid_t));
  int step;
  while((step = sqlite3_step(stmt)) == SQLITE_ROW)
  {
    dt_imgid_t id = sqlite3_column_int(stmt, 0);
    g_array_append_val(ids, id);
  }
  sqlite3_finalize(stmt);
  if(step != SQLITE_DONE)
  {
    *err = g_strdup(sqlite3_errmsg(db));
    g_array_free(ids, TRUE);
    return FALSE;
  }
  for(guint i = 0; i < ids->len; i++)
  {
    const dt_imgid_t id = g_array_index(ids, dt_imgid_t, i);
    if(_s.open && _s.imgid == id) session_close_session();
    dt_image_remove(id);
  }
  g_array_free(ids, TRUE);
  if(sqlite3_prepare_v2(db, "DELETE FROM main.film_rolls WHERE (" FOLDER_MATCH ") AND "
                      "NOT EXISTS (SELECT 1 FROM main.images WHERE film_id = main.film_rolls.id)",
                      -1, &stmt, NULL) != SQLITE_OK)
  {
    *err = g_strdup(sqlite3_errmsg(db));
    return FALSE;
  }
  sqlite3_bind_text(stmt, 1, path, -1, SQLITE_TRANSIENT);
  step = sqlite3_step(stmt);
  sqlite3_finalize(stmt);
#undef FOLDER_MATCH
  if(step == SQLITE_DONE) return TRUE;
  *err = g_strdup(sqlite3_errmsg(db));
  return FALSE;
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
  gint64 finished_at;
  drives_t *drive;     // the path's drive, kept from the start (drives.c)
  gboolean abandoned;  // the waiter gave up on it; under `lock`
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
  drives_test_stall(path);
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
  p->finished_at = g_get_monotonic_time();
  p->finished = TRUE;
  const gboolean abandoned = p->abandoned;
  g_cond_signal(&p->done);
  eng_unlock(&p->lock, ENG_LOCK_PROBE);
  // the stuck read has returned: its drive may answer again
  if(abandoned) drives_unstuck(p->drive);
  _probe_unref(p);
  return NULL;
}

static GMutex _quarantine_lock;
static GHashTable *_quarantine = NULL; // folder -> monotonic time it is skipped until

static gboolean _folder_quarantined(const char *path)
{
  gchar *dir = g_path_get_dirname(path);
  const gint64 now = g_get_monotonic_time();
  eng_lock(&_quarantine_lock, ENG_LOCK_PROBE);
  if(!_quarantine) _quarantine = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  const gint64 *until = g_hash_table_lookup(_quarantine, dir);
  const gboolean held = until && *until > now;
  eng_unlock(&_quarantine_lock, ENG_LOCK_PROBE);
  g_free(dir);
  return held;
}

static void _quarantine_folder(const char *path, const gint64 now)
{
  gchar *dir = g_path_get_dirname(path);
  gint64 *when = g_new(gint64, 1);
  *when = now + _PROBE_QUARANTINE_US;
  eng_lock(&_quarantine_lock, ENG_LOCK_PROBE);
  if(!_quarantine) _quarantine = g_hash_table_new_full(g_str_hash, g_str_equal, g_free, g_free);
  g_hash_table_replace(_quarantine, dir, when);
  eng_unlock(&_quarantine_lock, ENG_LOCK_PROBE);
}

// FALSE when the file did not answer within `timeout_us`, or its folder
// did not a moment ago
static gboolean _file_answers(const char *path, const gint64 timeout_us)
{
  drives_t *drive = drives_of(path);
  if(drives_held(drive)) return FALSE;
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
  p->drive = drive;
  GThread *t = g_thread_new("import-probe", _probe_run, p);
  g_thread_unref(t);

  const gint64 deadline = now + timeout_us;
  eng_lock(&p->lock, ENG_LOCK_PROBE);
  while(!p->finished && g_cond_wait_until(&p->done, &p->lock, deadline)) {}
  const gboolean answered = p->finished;
  // abandoned before stuck is counted, so a read that returns in between
  // still counts itself off (the count dips below zero for a moment)
  if(!answered) p->abandoned = TRUE;
  eng_unlock(&p->lock, ENG_LOCK_PROBE);
  if(!answered) drives_stuck(drive);
  _probe_unref(p);

  // a drive that can be held is, until the read returns (drives.c); only the
  // system disk's folders are skipped for a while instead
  if(!answered && !drive)
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
  {
    if(!answered)
      fprintf(stderr, "[engine] %s did not answer in %.1f s; skipped\n", path, timeout_us / 1e6);
    g_free(dir);
  }
  return answered;
}

// ORF metadata can be parsed before the serialized catalog import. A task's
// process-wide slot lasts until both the worker and the importing batch have
// released it, so completed results and abandoned reads remain bounded too.
#define _METADATA_TIMEOUT_US (30 * G_USEC_PER_SEC)
typedef struct _metadata_task_t
{
  GMutex lock;
  GCond done;
  gboolean finished;
  gint refs;
  gint64 launched;
  gint64 finished_at;
  dt_exif_prefetch_t *prefetch;
  char *path;
  drives_t *drive;     // as _probe_t's
  gboolean abandoned;  // under `lock`
} _metadata_task_t;

static GMutex _metadata_lock;
static guint _metadata_live = 0;
static guint _metadata_limit = _THUMB_THREADS;

void library_metadata_threads(gint n)
{
  eng_lock(&_metadata_lock, ENG_LOCK_PROBE);
  _metadata_limit = (guint)CLAMP(n, 1, _THUMB_THREADS_MAX);
  eng_unlock(&_metadata_lock, ENG_LOCK_PROBE);
}

static void _metadata_unref(_metadata_task_t *task)
{
  if(!g_atomic_int_dec_and_test(&task->refs)) return;
  dt_exif_prefetch_free(task->prefetch);
  g_free(task->path);
  g_cond_clear(&task->done);
  g_mutex_clear(&task->lock);
  eng_lock(&_metadata_lock, ENG_LOCK_PROBE);
  _metadata_live--;
  eng_unlock(&_metadata_lock, ENG_LOCK_PROBE);
  g_free(task);
}

static gpointer _metadata_run(gpointer data)
{
  _metadata_task_t *task = data;
  _probe_read(task->path);
  gchar *xmp = g_strconcat(task->path, ".xmp", NULL);
  _probe_read(xmp);
  g_free(xmp);
  task->prefetch = dt_exif_prefetch_prepare(task->path);
  eng_lock(&task->lock, ENG_LOCK_PROBE);
  task->finished_at = g_get_monotonic_time();
  task->finished = TRUE;
  const gboolean abandoned = task->abandoned;
  g_cond_broadcast(&task->done);
  eng_unlock(&task->lock, ENG_LOCK_PROBE);
  if(abandoned) drives_unstuck(task->drive);
  _metadata_unref(task);
  return NULL;
}

// NULL means the strict process-wide bound is already occupied.
static _metadata_task_t *_metadata_start(const char *path, const guint batch_workers)
{
  drives_t *drive = drives_of(path);
  eng_lock(&_metadata_lock, ENG_LOCK_PROBE);
  // A preference change applies to the next batch. In-flight batches retain
  // their snapshot, while this hard process cap includes abandoned workers.
  if(_metadata_live >= _THUMB_THREADS_MAX || _metadata_live >= batch_workers)
  {
    eng_unlock(&_metadata_lock, ENG_LOCK_PROBE);
    return NULL;
  }
  _metadata_live++;
  eng_unlock(&_metadata_lock, ENG_LOCK_PROBE);
  _metadata_task_t *task = g_new0(_metadata_task_t, 1);
  g_mutex_init(&task->lock);
  g_cond_init(&task->done);
  task->refs = 2; // importing batch and worker
  task->launched = g_get_monotonic_time();
  task->path = g_strdup(path);
  task->drive = drive;
  GThread *thread = g_thread_new("import-metadata", _metadata_run, task);
  g_thread_unref(thread);
  return task;
}

typedef enum _metadata_wait_result_t
{
  METADATA_READY,
  METADATA_TIMEOUT,
  METADATA_CANCELLED
} _metadata_wait_result_t;

static _metadata_wait_result_t _metadata_wait(_metadata_task_t *task, const gint64 job)
{
  const gint64 deadline = task->launched + _METADATA_TIMEOUT_US;
  for(;;)
  {
    eng_lock(&task->lock, ENG_LOCK_PROBE);
    if(task->finished)
    {
      const gboolean ready = task->finished_at <= deadline;
      eng_unlock(&task->lock, ENG_LOCK_PROBE);
      return ready ? METADATA_READY : METADATA_TIMEOUT;
    }
    const gint64 now = g_get_monotonic_time();
    if(now >= deadline)
    {
      // as in _file_answers: abandoned first, then counted stuck
      task->abandoned = TRUE;
      eng_unlock(&task->lock, ENG_LOCK_PROBE);
      drives_stuck(task->drive);
      return METADATA_TIMEOUT;
    }
    g_cond_wait_until(&task->done, &task->lock, MIN(deadline, now + 50 * 1000));
    eng_unlock(&task->lock, ENG_LOCK_PROBE);
    if(job)
    {
      eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
      const gboolean cancelled = library_import_latest != job;
      eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
      if(cancelled) return METADATA_CANCELLED;
    }
  }
}

// import these files, as library_folder() does a folder's: the client lists the
// folder itself and sends it in batches, so it can show its progress. with
// a `job`, a batch stops once a newer read's is queued; with a `budget` (ms),
// once that has passed, after a file at least. `done` is how many of the
// files it went through, so the client sends the rest again
void library_import_files(JsonObject *req, JsonBuilder *b, const gboolean background)
{
  eng_lock(&_metadata_lock, ENG_LOCK_PROBE);
  const guint workers = _metadata_limit;
  eng_unlock(&_metadata_lock, ENG_LOCK_PROBE);
  JsonArray *files = json_object_has_member(req, "files") ? json_object_get_array_member(req, "files") : NULL;
  const gint64 job = json_object_get_int_member_with_default(req, "job", 0);
  const gint64 budget = json_object_get_int_member_with_default(req, "budget", 0) * 1000;
  const gint64 probe = json_object_get_int_member_with_default(req, "probe_ms", _PROBE_TIMEOUT_US / 1000) * 1000;
  const gint64 start = g_get_monotonic_time();
  const guint n = files ? json_array_get_length(files) : 0;
  guint k = 0;
  GPtrArray *silent = g_ptr_array_new();
  GPtrArray *held = g_ptr_array_new(); // drives_t *, each once
  _metadata_task_t **tasks = g_new0(_metadata_task_t *, n);
  gboolean *staged = g_new0(gboolean, n);
    gboolean stop_metadata = FALSE;
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
    if(background) engine_background_yield();

    // Keep a fixed horizon of prepared ORFs. The task cap includes completed
    // results until their serial import consumes and releases them.
    if(!stop_metadata)
    {
      const guint end = MIN(n, k + workers);
      for(guint j = k; j < end; j++)
      {
        if(staged[j]) continue;
        staged[j] = TRUE;
        const char *next = json_array_get_string_element(files, j);
        if(!next || _is_sidecar(next) || !dt_exif_prefetch_supported(next)
           || drives_path_held(next) || !g_file_test(next, G_FILE_TEST_IS_REGULAR)
           || _folder_quarantined(next)) continue;
        tasks[j] = _metadata_start(next, workers);
      }
    }

    const char *path = json_array_get_string_element(files, k);
    if(!path || _is_sidecar(path)) continue;
    // before the stat below, which a stuck drive would hold
    drives_t *stuck = drives_path_held(path);
    if(stuck)
    {
      g_ptr_array_add(silent, (gpointer)path);
      if(!g_ptr_array_find(held, stuck, NULL)) g_ptr_array_add(held, stuck);
      continue;
    }
    if(!g_file_test(path, G_FILE_TEST_IS_REGULAR)) continue;
    dt_imgid_t imgid = NO_IMGID;
    if(dt_exif_prefetch_supported(path))
    {
      _metadata_task_t *task = tasks[k];
      if(!task && !stop_metadata && !_folder_quarantined(path))
      {
        // A global slot may have opened after this file was staged.
        task = _metadata_start(path, workers);
        tasks[k] = task;
      }
      if(!task)
      {
        // If the global cap is busy with a still-running abandoned task, do
        // not turn the bounded pipeline into a synchronous metadata read.
        g_ptr_array_add(silent, (gpointer)path);
      }
      else
      {
        const _metadata_wait_result_t wait_result = _metadata_wait(task, job);
        if(wait_result == METADATA_CANCELLED)
        {
          g_ptr_array_add(silent, (gpointer)path);
          _metadata_unref(task);
          tasks[k] = NULL;
          break;
        }
        if(wait_result == METADATA_TIMEOUT)
        {
          stop_metadata = TRUE;
          // a task given up on holds its drive (drives.c); one that came back
          // late, or one on the system disk, has its folder skipped instead.
          // `abandoned` is only set by this thread, in _metadata_wait
          const gboolean holds = task->drive && task->abandoned;
          if(!holds) _quarantine_folder(path, g_get_monotonic_time());
          if(holds)
            fprintf(stderr, "[engine] metadata for %s did not answer in %.1f s; skipped, as is its drive\n",
                    path, _METADATA_TIMEOUT_US / 1e6);
          else
            fprintf(stderr, "[engine] metadata for %s did not answer in %.1f s; skipped, as is its folder for %d s\n",
                    path, _METADATA_TIMEOUT_US / 1e6, (int)(_PROBE_QUARANTINE_US / G_USEC_PER_SEC));
          g_ptr_array_add(silent, (gpointer)path);
          for(guint j = k + 1; j < n; j++)
          {
            if(tasks[j]) _metadata_unref(tasks[j]);
            tasks[j] = NULL;
          }
        }
        else
        {
          if(job)
          {
            eng_lock(&engine_cancel_lock, ENG_LOCK_CANCEL);
            const gboolean cancelled = library_import_latest != job;
            eng_unlock(&engine_cancel_lock, ENG_LOCK_CANCEL);
            if(cancelled)
            {
              g_ptr_array_add(silent, (gpointer)path);
              _metadata_unref(task);
              tasks[k] = NULL;
              break;
            }
          }
          if(!task->prefetch || _folder_quarantined(path))
            g_ptr_array_add(silent, (gpointer)path);
          else
          {
            dt_exif_prefetch_set(task->prefetch);
            imgid = library_import(path);
            dt_exif_prefetch_set(NULL);
          }
        }
        _metadata_unref(task); // the importing batch; a timed-out worker still owns its reference
        tasks[k] = NULL;
      }
    }
    else
    {
      const gboolean answered = _file_answers(path, probe);
      if(!answered) g_ptr_array_add(silent, (gpointer)path);
      else
      {
        imgid = library_import(path);
      }
    }
    if(dt_is_valid_imgid(imgid)) _image_versions_json(b, imgid);
    else if((stuck = drives_path_held(path)))
    {
      // its drive was held while this file waited (library_import refused it)
      if(!g_ptr_array_find(silent, path, NULL)) g_ptr_array_add(silent, (gpointer)path);
      if(!g_ptr_array_find(held, stuck, NULL)) g_ptr_array_add(held, stuck);
    }
  }
  for(guint j = 0; j < n; j++) if(tasks[j]) _metadata_unref(tasks[j]);
  g_free(tasks);
  g_free(staged);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "unanswered");
  json_builder_begin_array(b);
  for(guint i = 0; i < silent->len; i++) json_builder_add_string_value(b, g_ptr_array_index(silent, i));
  json_builder_end_array(b);
  g_ptr_array_free(silent, TRUE);
  // the drives skipped as not answering (drives.c), so the client can stop
  // asking for their photos for a while
  json_builder_set_member_name(b, "held");
  json_builder_begin_array(b);
  for(guint i = 0; i < held->len; i++)
    json_builder_add_string_value(b, drives_mount(g_ptr_array_index(held, i)));
  json_builder_end_array(b);
  g_ptr_array_free(held, TRUE);
  json_builder_set_member_name(b, "done");
  json_builder_add_int_value(b, k);
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

// an import the user waits on (a folder read, a photo opened or browsed)
// before queued `background` ones (Smart search, previews rendered ahead,
// thumbnails off screen), which a slow share's would otherwise keep from
// the one import thread; equal ranks keep their arrival order
static gint _import_rank(JsonParser *parser)
{
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  return json_object_get_boolean_member_with_default(req, "background", FALSE) ? 1 : 0;
}

gint library_import_order(gconstpointer a, gconstpointer b, gpointer user_data)
{
  return _import_rank((JsonParser *)a) - _import_rank((JsonParser *)b);
}

void library_import_run(gpointer data, gpointer user_data)
{
  JsonParser *parser = data;
  FILE *out = user_data;
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  // the import's own time, not its wait in the queue: the client tells a
  // slow drive by it (engine.rs, Slow)
  const gint64 started = g_get_monotonic_time();
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member(req, "tag"));
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, TRUE);
  library_import_files(req, b, TRUE);
  json_builder_set_member_name(b, "ms");
  json_builder_add_int_value(b, (g_get_monotonic_time() - started) / 1000);
  json_builder_end_object(b);
  engine_reply(out, b);
  g_object_unref(b);
  g_object_unref(parser);
}

// the request reader's answer to an import whose every file is on a held
// drive (drives.c), so it is not queued behind the import thread, which may
// itself be stuck on that drive. FALSE, with `b` untouched, otherwise
gboolean library_import_held_reply(JsonObject *req, JsonBuilder *b)
{
  JsonArray *files = json_object_has_member(req, "files") ? json_object_get_array_member(req, "files") : NULL;
  const guint n = files ? json_array_get_length(files) : 0;
  if(!n) return FALSE;
  GPtrArray *held = g_ptr_array_new();
  for(guint i = 0; i < n; i++)
  {
    drives_t *d = drives_path_held(json_array_get_string_element(files, i));
    if(!d)
    {
      g_ptr_array_free(held, TRUE);
      return FALSE;
    }
    if(!g_ptr_array_find(held, d, NULL)) g_ptr_array_add(held, d);
  }
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member_with_default(req, "tag", 0));
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, TRUE);
  json_builder_set_member_name(b, "images");
  json_builder_begin_array(b);
  json_builder_end_array(b);
  json_builder_set_member_name(b, "unanswered");
  json_builder_begin_array(b);
  for(guint i = 0; i < n; i++)
  {
    const char *path = json_array_get_string_element(files, i);
    if(path && !_is_sidecar(path)) json_builder_add_string_value(b, path);
  }
  json_builder_end_array(b);
  json_builder_set_member_name(b, "held");
  json_builder_begin_array(b);
  for(guint i = 0; i < held->len; i++) json_builder_add_string_value(b, drives_mount(g_ptr_array_index(held, i)));
  json_builder_end_array(b);
  json_builder_set_member_name(b, "done");
  json_builder_add_int_value(b, n);
  g_ptr_array_free(held, TRUE);
  return TRUE;
}

// the request reader's answer to a thumb or analysis_preview whose `path`
// (sent by the client for this) is on a held drive. FALSE otherwise
gboolean library_thumb_held_reply(JsonObject *req, JsonBuilder *b)
{
  const char *path = json_object_get_string_member_with_default(req, "path", NULL);
  drives_t *d = path ? drives_path_held(path) : NULL;
  if(!d) return FALSE;
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member_with_default(req, "tag", 0));
  json_builder_set_member_name(b, "ok");
  json_builder_add_boolean_value(b, FALSE);
  json_builder_set_member_name(b, "error");
  gchar *msg = g_strdup_printf("%s is not answering: its drive or network share may be disconnected", drives_mount(d));
  json_builder_add_string_value(b, msg);
  g_free(msg);
  json_builder_set_member_name(b, "held");
  json_builder_begin_array(b);
  json_builder_add_string_value(b, drives_mount(d));
  json_builder_end_array(b);
  return TRUE;
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

gboolean library_import_metadata_pending(void)
{
  eng_lock(&_metadata_lock, ENG_LOCK_PROBE);
  const gboolean pending = _metadata_live > 0;
  eng_unlock(&_metadata_lock, ENG_LOCK_PROBE);
  return pending;
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

// Analysis renders in an independent develop, always sRGB. Original means
// upstream history_end=0, not export metadata's history=false option.
gboolean library_analysis_preview(const dt_imgid_t imgid, const char *subject, const char *out, char **err)
{
  if(g_strcmp0(subject, "original") && g_strcmp0(subject, "edited"))
  { *err = g_strdup("invalid analysis subject"); return FALSE; }
  JsonObject *req = json_object_new();
  json_object_set_string_member(req, "out", out);
  json_object_set_string_member(req, "format", "jpeg");
  json_object_set_string_member(req, "color_space", "srgb");
  json_object_set_int_member(req, "quality", 85);
  json_object_set_int_member(req, "long_edge", 1024);
  json_object_set_boolean_member(req, "draft", TRUE);
  json_object_set_boolean_member(req, "transient", TRUE);
  json_object_set_boolean_member(req, "analysis_original", !g_strcmp0(subject, "original"));
  const gboolean ok = export_export(imgid, req, err);
  json_object_unref(req);
  // a file darktable could read but not decode gets its own error, so Smart
  // search can stop retrying it (search_analysis.rs) while a failed read, a
  // missing file, memory or a failed write are tried again later. the load
  // status is the one the full mipmap load just recorded (mipmap_cache.c)
  if(!ok)
  {
    const dt_image_t *img = dt_image_cache_get(imgid, 'r');
    const dt_imageio_retval_t status = img ? img->load_status : DT_IMAGEIO_OK;
    if(img) dt_image_cache_read_release(img);
    if(status == DT_IMAGEIO_LOAD_FAILED || status == DT_IMAGEIO_UNSUPPORTED_FORMAT
       || status == DT_IMAGEIO_UNSUPPORTED_CAMERA || status == DT_IMAGEIO_UNSUPPORTED_FEATURE
       || status == DT_IMAGEIO_FILE_CORRUPTED || status == DT_IMAGEIO_UNRECOGNIZED)
    {
      g_free(*err);
      *err = g_strdup_printf("cannot decode image %d (status %d)", imgid, (int)status);
    }
  }
  return ok;
}

// Decode the primary image. Images with an ICC profile or a non-sRGB EXIF
// color space use the existing color-managed render path.
static uint8_t *_decode_fit_jpeg(const char *path, const int size, int32_t *width, int32_t *height)
{
  dt_imageio_jpeg_t jpg;
  if(dt_imageio_jpeg_read_header(path, &jpg)) return NULL;

  const dt_colorspaces_color_profile_type_t space = dt_imageio_jpeg_read_color_space(&jpg);
  gboolean supported = (space == DT_COLORSPACE_SRGB || space == DT_COLORSPACE_DISPLAY)
                       && (jpg.dinfo.jpeg_color_space == JCS_RGB || jpg.dinfo.jpeg_color_space == JCS_YCbCr);
  for(jpeg_saved_marker_ptr marker = jpg.dinfo.marker_list; supported && marker; marker = marker->next)
    if(marker->marker == JPEG_APP0 + 2 && marker->data_length >= sizeof("ICC_PROFILE")
       && !memcmp(marker->data, "ICC_PROFILE", sizeof("ICC_PROFILE")))
      supported = FALSE;

  if(supported)
  {
    for(unsigned int denom = 8; denom >= 2; denom /= 2)
      if((MAX(jpg.width, jpg.height) + denom - 1) / denom >= (unsigned int)size)
      {
        jpg.dinfo.scale_num = 1;
        jpg.dinfo.scale_denom = denom;
        break;
      }
    jpg.width = (jpg.width + jpg.dinfo.scale_denom - 1) / jpg.dinfo.scale_denom;
    jpg.height = (jpg.height + jpg.dinfo.scale_denom - 1) / jpg.dinfo.scale_denom;
    uint8_t *pixels = dt_alloc_align_uint8((size_t)4 * jpg.width * jpg.height);
    if(pixels)
    {
      if(dt_imageio_jpeg_read(&jpg, pixels))
      {
        dt_free_align(pixels);
        return NULL;
      }
      *width = jpg.width;
      *height = jpg.height;
      return pixels;
    }
  }
  jpeg_destroy_decompress(&jpg.dinfo);
  fclose(jpg.f);
  return NULL;
}

// Keep native detail when the source is already smaller than Fit.
static gboolean _source_preview(const dt_imgid_t imgid, const int size, const gboolean camera_preview,
                                const char *out,
                                JsonBuilder *b, char **err)
{
  const dt_image_t *image = dt_image_cache_get(imgid, 'r');
  const gboolean raw = image && dt_image_is_raw(image);
  if(image) dt_image_cache_read_release(image);
  if(!raw && (size == 0 || camera_preview)) return FALSE;
  if(!camera_preview && dt_image_altered(imgid)) return FALSE;

  char path[PATH_MAX] = { 0 };
  gboolean from_cache = TRUE;
  dt_image_full_path(imgid, path, sizeof(path), &from_cache);
  if(!*path) return FALSE;

  uint8_t *pixels = NULL;
  int32_t width = 0, height = 0;
  if(raw)
  {
    dt_colorspaces_color_profile_type_t space;
    if(dt_imageio_large_thumbnail(path, &pixels, &width, &height, &space) || space != DT_COLORSPACE_SRGB)
    {
      dt_free_align(pixels);
      return FALSE;
    }
  }
  else
  {
    const char *ext = strrchr(path, '.');
    if(!ext || (g_ascii_strcasecmp(ext, ".jpg") && g_ascii_strcasecmp(ext, ".jpeg")
                && g_ascii_strcasecmp(ext, ".jpe")))
      return FALSE;
    pixels = _decode_fit_jpeg(path, size, &width, &height);
  }
  if(!pixels || width <= 0 || height <= 0)
  {
    dt_free_align(pixels);
    return FALSE;
  }

  const dt_image_orientation_t orientation = dt_image_get_orientation(imgid);
  int32_t max_width = orientation & ORIENTATION_SWAP_XY ? height : width;
  int32_t max_height = orientation & ORIENTATION_SWAP_XY ? width : height;
  if(size > 0)
  {
    max_width = MIN(max_width, size);
    max_height = MIN(max_height, size);
  }
  uint8_t *oriented = dt_alloc_align_uint8((size_t)4 * max_width * max_height);
  if(!oriented)
  {
    dt_free_align(pixels);
    *err = g_strdup("preview allocation failed");
    return FALSE;
  }
  uint32_t w, h;
  dt_iop_flip_and_zoom_8(pixels, width, height, oriented, max_width, max_height, orientation, &w, &h);
  dt_free_align(pixels);
  if(!w || !h)
  {
    dt_free_align(oriented);
    return FALSE;
  }
  const gboolean ok = engine_transient_write(out, oriented, (size_t)4 * w * h, NULL, 0);
  dt_free_align(oriented);
  if(!ok)
  {
    *err = g_strdup("could not write preview");
    return FALSE;
  }
  json_builder_set_member_name(b, "width"); json_builder_add_int_value(b, w);
  json_builder_set_member_name(b, "height"); json_builder_add_int_value(b, h);
  json_builder_set_member_name(b, "source"); json_builder_add_string_value(b, raw ? "embedded" : "jpeg");
  return TRUE;
}

// The thumbnail buffer is 8-bit RGBA; report its color space.
gboolean library_thumb(const dt_imgid_t imgid, const int size, const gboolean proof,
                       const gboolean prefer_source, const gboolean camera_preview, const char *out,
                       JsonBuilder *b, char **err)
{
  if(size == 0 || (size > 0 && (prefer_source || camera_preview) && !proof))
  {
    if(!dt_is_valid_imgid(imgid) || !dt_image_exists(imgid))
    { *err = g_strdup("no such image"); return FALSE; }
    if(_source_preview(imgid, size, size > 0 && camera_preview, out, b, err)) return TRUE;
    if(*err) return FALSE;
  }

  // Size zero requests native-resolution inspection independently of the editor.
  if(size == 0)
  {
    JsonObject *req = json_object_new();
    json_object_set_string_member(req, "out", out);
    json_object_set_string_member(req, "format", "jpeg");
    json_object_set_string_member(req, "color_space", "srgb");
    json_object_set_int_member(req, "quality", 85);
    json_object_set_boolean_member(req, "transient", TRUE);
    json_object_set_int_member(req, "long_edge", 0);
    const gboolean ok = export_export(imgid, req, err);
    json_object_unref(req);
    json_builder_set_member_name(b, "encoding"); json_builder_add_string_value(b, "jpeg");
    json_builder_set_member_name(b, "source"); json_builder_add_string_value(b, "rendered");
    return ok;
  }
  const dt_mipmap_size_t mip = dt_mipmap_cache_get_matching_size(size, size);
  dt_mipmap_buffer_t buf;
  dt_mipmap_cache_get(&buf, imgid, mip, DT_MIPMAP_BLOCKING, 'r');
  const gboolean cached = buf.buf && buf.width > 0 && buf.height > 0;
  uint8_t *preview = NULL;
  int32_t width = buf.width, height = buf.height;
  dt_colorspaces_color_profile_type_t color_space = buf.color_space;
  if(!cached)
  {
    dt_mipmap_cache_release(&buf);
    // Some DNGs have unsupported RAW/compression data and a readable small
    // preview. Use that if the normal mipmap/render path failed. An edited
    // photo must never silently show a preview without its edits.
    char path[PATH_MAX] = { 0 };
    gboolean from_cache = TRUE;
    dt_image_full_path(imgid, path, sizeof(path), &from_cache);
    const int target = CLAMP(size, 1, 256);
    if(dt_image_altered(imgid) || !*path
       || (dt_imageio_thumbnail(path, &preview, &width, &height, &color_space, target)
           && (target == 1 || dt_imageio_thumbnail(path, &preview, &width, &height, &color_space, 1))))
    {
      *err = g_strdup_printf("no thumbnail for image %d", imgid);
      return FALSE;
    }
    const dt_image_orientation_t orientation = dt_image_get_orientation(imgid);
    const int32_t max_width = orientation & ORIENTATION_SWAP_XY ? height : width;
    const int32_t max_height = orientation & ORIENTATION_SWAP_XY ? width : height;
    uint8_t *oriented = dt_alloc_align_uint8((size_t)4 * width * height);
    if(!oriented)
    {
      dt_free_align(preview);
      *err = g_strdup("could not allocate thumbnail preview");
      return FALSE;
    }
    uint32_t oriented_width, oriented_height;
    dt_iop_flip_and_zoom_8(preview, width, height, oriented, max_width, max_height,
                           orientation, &oriented_width, &oriented_height);
    width = oriented_width;
    height = oriented_height;
    dt_free_align(preview);
    preview = oriented;
  }
  const uint8_t *pixels = cached ? buf.buf : preview;
  // the print sheet's cells, shown as the soft proof does: a copy, as the
  // cache's buffer is shared; sRGB once proofed
  const size_t bytes = (size_t)4 * width * height;
  uint8_t *copy = proof ? g_try_malloc(bytes) : NULL;
  if(copy) memcpy(copy, pixels, bytes);
  const gboolean proofed = copy && print_proof_pixels(copy, width, height, color_space);
  const gboolean ok = engine_transient_write(out, proofed ? copy : pixels, bytes, NULL, 0);
  g_free(copy);
  json_builder_set_member_name(b, "width");
  json_builder_add_int_value(b, width);
  json_builder_set_member_name(b, "height");
  json_builder_add_int_value(b, height);
  json_builder_set_member_name(b, "color_space");
  json_builder_add_int_value(b, proofed ? DT_COLORSPACE_SRGB : color_space);
  if(cached) dt_mipmap_cache_release(&buf);
  dt_free_align(preview);
  if(!ok) *err = g_strdup_printf("could not write '%s'", out);
  return ok;
}

GThreadPool *library_thumb_pool = NULL;
static GMutex _thumb_lock;

// a thumbnail already in darktable's memory cache needs no read of the file
static gboolean _thumb_in_memory(const dt_imgid_t imgid, const int size)
{
  if(size <= 0) return FALSE;
  dt_mipmap_buffer_t buf = { 0 };
  buf.size = DT_MIPMAP_NONE; // a miss leaves it unset, and release reads it
  dt_mipmap_cache_get(&buf, imgid, dt_mipmap_cache_get_matching_size(size, size), DT_MIPMAP_TESTLOCK, 'r');
  const gboolean there = buf.buf && buf.width > 0 && buf.height > 0;
  dt_mipmap_cache_release(&buf);
  return there;
}

// NULL when the photo may be read for a thumbnail or analysis preview, or
// why not: its drive is held (drives.c), or its file did not answer the
// probe, which may hold the drive. a stuck decode cannot be abandoned, so
// a stuck drive's photos are not started at all. the system disk is never
// probed here, so it works as before
static char *_thumb_unanswered(const dt_imgid_t imgid, const int size, const gboolean plain, JsonBuilder *b)
{
  if(!dt_is_valid_imgid(imgid)) return NULL;
  char path[PATH_MAX] = { 0 };
  gboolean from_cache = FALSE;
  dt_image_full_path(imgid, path, sizeof(path), &from_cache);
  drives_t *drive = *path ? drives_of(path) : NULL;
  if(!drive) return NULL;
  if(!drives_held(drive))
  {
    if(plain && _thumb_in_memory(imgid, size)) return NULL;
    if(_file_answers(path, _PROBE_TIMEOUT_US)) return NULL;
  }
  if(drives_held(drive))
  {
    json_builder_set_member_name(b, "held");
    json_builder_begin_array(b);
    json_builder_add_string_value(b, drives_mount(drive));
    json_builder_end_array(b);
    return g_strdup_printf("%s is not answering: its drive or network share may be disconnected", drives_mount(drive));
  }
  return g_strdup_printf("%s is not answering", path);
}

// foreground (the lightbox's photo) before grid thumbnails and metadata,
// those before analysis previews; equal ranks keep their arrival order
static gint _thumb_rank(JsonParser *parser)
{
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  if(!g_strcmp0(json_object_get_string_member_with_default(req, "cmd", ""), "analysis_preview")) return 2;
  return json_object_get_boolean_member_with_default(req, "foreground", FALSE) ? 0 : 1;
}

gint library_thumb_order(gconstpointer a, gconstpointer b, gpointer user_data)
{
  return _thumb_rank((JsonParser *)a) - _thumb_rank((JsonParser *)b);
}

void library_thumb_run(gpointer data, gpointer user_data)
{
  JsonParser *parser = data;
  FILE *out = user_data;
  JsonObject *req = json_node_get_object(json_parser_get_root(parser));
  // a foreground request is waited on, so it does not give way to the main loop
  if(!json_object_get_boolean_member_with_default(req, "foreground", FALSE)) engine_background_yield();
  const char *dest = json_object_get_string_member_with_default(req, "out", NULL);
  char *err = NULL;
  JsonBuilder *b = json_builder_new();
  json_builder_begin_object(b);
  json_builder_set_member_name(b, "tag");
  json_builder_add_int_value(b, json_object_get_int_member(req, "tag"));
  const char *cmd = json_object_get_string_member_with_default(req, "cmd", "");
  const gboolean analysis = !g_strcmp0(cmd, "analysis_preview");
  const gboolean metadata = !g_strcmp0(cmd, "meta");
  const dt_imgid_t imgid = json_object_get_int_member_with_default(req, "imgid", 0);
  gboolean ok = FALSE;
  if(metadata)
  {
    if(dt_is_valid_imgid(imgid) && dt_image_exists(imgid))
    {
      json_builder_set_member_name(b, "image");
      library_image_json(b, imgid, TRUE);
      ok = TRUE;
    }
    else err = g_strdup("no such image");
  }
  else if(dest && (err = _thumb_unanswered(imgid, analysis ? 0 : json_object_get_int_member_with_default(req, "size", 256),
                                           !analysis && !json_object_get_boolean_member_with_default(req, "proof", FALSE)
                                           && !json_object_get_boolean_member_with_default(req, "prefer_source", FALSE)
                                           && !json_object_get_boolean_member_with_default(req, "camera_preview", FALSE), b)))
    ok = FALSE;
  else if(dest && analysis)
    ok = library_analysis_preview(imgid, json_object_get_string_member_with_default(req, "subject", ""), dest, &err);
  else if(dest)
    ok = library_thumb(imgid, json_object_get_int_member_with_default(req, "size", 256),
                       json_object_get_boolean_member_with_default(req, "proof", FALSE),
                       json_object_get_boolean_member_with_default(req, "prefer_source", FALSE),
                       json_object_get_boolean_member_with_default(req, "camera_preview", FALSE), dest, b, &err);
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

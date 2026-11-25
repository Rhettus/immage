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

// drives that have stopped answering. a failing disk or a half-dead share
// can hold a read in the kernel for minutes, where it cannot be interrupted.
// once one read on a drive is known to be stuck, no new read is started on
// it: imports and thumbnails of its photos are answered at once as not
// answering, and the drive answers again by itself when the stuck read
// returns (an eject fails it). only that drive is held; the system disk never
// is, so one slow cloud placeholder file does not hold every photo on it
// (library.c keeps its folder quarantine for those)

#include "engine.h"

#ifdef __APPLE__
#include <sys/param.h>
#include <sys/ucred.h>
#include <sys/mount.h>
#endif

struct drives_t
{
  char *mount;
  gint stuck; // reads given up on that have not returned; atomic, may dip below 0 for a moment
};

// a library_import() running on a drive: past _IMPORT_STALL_US it holds the
// drive. healthy single imports took up to 16 s cold; real stalls 95-421 s.
// _import_lock lets one run at a time; the spare slots cost nothing
#define _IMPORT_STALL_US (30 * G_USEC_PER_SEC)
#define _IMPORT_SLOTS 8
#define _TABLE_FRESH_US (10 * G_USEC_PER_SEC)

typedef struct _mount_t
{
  char *path;         // the mount point, or the key for a gvfs share
  gboolean holdable;  // FALSE for the system disk
} _mount_t;

// LOCK ORDER: rank probe (8), as library.c's quarantine and probe locks, and
// never held together with one of them: every function here takes it and
// gives it back before returning, with no I/O inside
static GMutex _lock;
static GHashTable *_drives = NULL;   // mount -> drives_t *, never freed
#ifndef _WIN32
static GArray *_table = NULL;        // _mount_t, replaced whole
static gint64 _table_read = 0;
#endif
static struct { drives_t *drive; gint64 started; gboolean logged; } _slots[_IMPORT_SLOTS];
static char *_test_stall = NULL;     // IMMAGE_TEST_STALL_DIR

static gboolean _is_sep(const char c)
{
#ifdef _WIN32
  return c == '/' || c == '\\';
#else
  return c == '/';
#endif
}

// whether `path` is `mount` or below it, by whole components
static gboolean _under(const char *path, const char *mount)
{
  const size_t n = strlen(mount);
#ifdef _WIN32
  if(g_ascii_strncasecmp(path, mount, n)) return FALSE;
#else
  if(strncmp(path, mount, n)) return FALSE;
#endif
  return n == 0 || _is_sep(mount[n - 1]) || path[n] == '\0' || _is_sep(path[n]);
}

// the mount table: Windows keys a drive by its name alone (_windows_key)
#ifndef _WIN32
static void _table_free(GArray *t)
{
  if(!t) return;
  for(guint i = 0; i < t->len; i++) g_free(g_array_index(t, _mount_t, i).path);
  g_array_free(t, TRUE);
}

static void _add(GArray *t, const char *path, const gboolean holdable)
{
  _mount_t m = { g_strdup(path), holdable };
  g_array_append_val(t, m);
}

#if defined(__linux__)
// mountinfo escapes space, tab, newline and backslash as \ooo
static char *_unescape(const char *s)
{
  GString *out = g_string_new(NULL);
  for(const char *p = s; *p; p++)
  {
    if(p[0] == '\\' && p[1] >= '0' && p[1] <= '7' && p[2] >= '0' && p[2] <= '7' && p[3] >= '0' && p[3] <= '7')
    {
      g_string_append_c(out, (char)((p[1] - '0') * 64 + (p[2] - '0') * 8 + (p[3] - '0')));
      p += 3;
    }
    else
      g_string_append_c(out, *p);
  }
  return g_string_free(out, FALSE);
}
#endif

// the mount table, read without asking any file system: procfs on Linux,
// getfsstat(MNT_NOWAIT) on macOS. Windows needs none (_windows_key)
static GArray *_read_table(void)
{
  GArray *t = g_array_new(FALSE, FALSE, sizeof(_mount_t));
#if defined(__linux__)
  gchar *text = NULL;
  if(g_file_get_contents("/proc/self/mountinfo", &text, NULL, NULL))
  {
    gchar **lines = g_strsplit(text, "\n", -1);
    char *root_dev = NULL;
    GPtrArray *points = g_ptr_array_new_with_free_func(g_free), *devs = g_ptr_array_new_with_free_func(g_free);
    GArray *memory = g_array_new(FALSE, FALSE, sizeof(gboolean));
    for(gchar **l = lines; *l; l++)
    {
      // id parent major:minor root mountpoint ...
      gchar **f = g_strsplit(*l, " ", 6);
      if(g_strv_length(f) >= 5)
      {
        char *point = _unescape(f[4]);
        if(!strcmp(point, "/")) { g_free(root_dev); root_dev = g_strdup(f[2]); }
        g_ptr_array_add(points, point);
        g_ptr_array_add(devs, g_strdup(f[2]));
        // the file system type follows " - ": a tmpfs or ramfs is memory,
        // which does not stall as a drive does
        const char *dash = strstr(*l, " - ");
        const gboolean mem = dash && (g_str_has_prefix(dash + 3, "tmpfs ") || g_str_has_prefix(dash + 3, "ramfs "));
        g_array_append_val(memory, mem);
      }
      g_strfreev(f);
    }
    // $HOME's own partition (a separate /home, a btrfs @home) is the system disk too
    const char *home = g_get_home_dir();
    const char *home_mount = NULL;
    for(guint i = 0; i < points->len; i++)
    {
      const char *p = g_ptr_array_index(points, i);
      if(home && _under(home, p) && (!home_mount || strlen(p) > strlen(home_mount))) home_mount = p;
    }
    for(guint i = 0; i < points->len; i++)
    {
      const char *p = g_ptr_array_index(points, i);
      const gboolean system = !strcmp(p, "/") || (root_dev && !strcmp(g_ptr_array_index(devs, i), root_dev))
                              || (home_mount && !strcmp(p, home_mount)) || g_array_index(memory, gboolean, i);
      _add(t, p, !system);
    }
    g_ptr_array_free(points, TRUE);
    g_ptr_array_free(devs, TRUE);
    g_array_free(memory, TRUE);
    g_free(root_dev);
    g_strfreev(lines);
    g_free(text);
  }
#elif defined(__APPLE__)
  const int n = getfsstat(NULL, 0, MNT_NOWAIT);
  if(n > 0)
  {
    struct statfs *s = g_new0(struct statfs, n + 4);
    const int got = getfsstat(s, (int)((n + 4) * sizeof(struct statfs)), MNT_NOWAIT);
    for(int i = 0; i < got; i++)
    {
      const char *p = s[i].f_mntonname;
      // the home folder sits on the data volume, reached through firmlinks
      // from paths under / as well as under its own mount
      const gboolean system = !strcmp(p, "/") || (s[i].f_flags & MNT_ROOTFS)
                              || _under(p, "/System/Volumes");
      _add(t, p, !system);
    }
    g_free(s);
  }
#endif
  if(_test_stall) _add(t, _test_stall, TRUE);
  return t;
}
#endif

#ifdef _WIN32
// a drive by its name alone: X:\ or \\server\share\, upper-cased; NULL for
// the system drive or a path of neither form
static char *_windows_key(const char *path)
{
  gchar *unc = !strncmp(path, "\\\\?\\UNC\\", 8) ? g_strconcat("\\\\", path + 8, NULL) : NULL;
  const char *p = unc ? unc : !strncmp(path, "\\\\?\\", 4) ? path + 4 : path;
  char *key = NULL;
  if(g_ascii_isalpha(p[0]) && p[1] == ':')
    key = g_strdup_printf("%c:\\", g_ascii_toupper(p[0]));
  else if(_is_sep(p[0]) && _is_sep(p[1]))
  {
    const char *server = p + 2, *slash = server;
    while(*slash && !_is_sep(*slash)) slash++;
    const char *share = *slash ? slash + 1 : slash, *end = share;
    while(*end && !_is_sep(*end)) end++;
    if(slash > server && end > share)
    {
      gchar *s = g_strndup(server, slash - server), *h = g_strndup(share, end - share);
      key = g_strdup_printf("\\\\%s\\%s\\", s, h);
      gchar *up = g_ascii_strup(key, -1);
      g_free(key);
      key = up;
      g_free(s);
      g_free(h);
    }
  }
  const char *sys = g_getenv("SystemDrive");
  if(key && sys && g_ascii_isalpha(sys[0]) && key[1] == ':' && g_ascii_toupper(sys[0]) == key[0])
  {
    g_free(key);
    key = NULL;
  }
  g_free(unc);
  return key;
}
#endif

static drives_t *_drive_locked(const char *key)
{
  if(!_drives) _drives = g_hash_table_new(g_str_hash, g_str_equal);
  drives_t *d = g_hash_table_lookup(_drives, key);
  if(!d)
  {
    d = g_new0(drives_t, 1);
    d->mount = g_strdup(key);
    g_hash_table_insert(_drives, d->mount, d);
  }
  return d;
}

#ifndef _WIN32
// the key a path's drive goes by, from the table, or NULL for the system
// disk; *root is TRUE when the best match was not holdable, which may be a
// drive the table does not have yet
static char *_lookup_locked(const char *path, gboolean *root)
{
  *root = TRUE;
  if(_test_stall && _under(path, _test_stall)) { *root = FALSE; return g_strdup(_test_stall); }
  if(!_table) return NULL;
  const _mount_t *best = NULL;
  for(guint i = 0; i < _table->len; i++)
  {
    const _mount_t *m = &g_array_index(_table, _mount_t, i);
    if(_under(path, m->path) && (!best || strlen(m->path) > strlen(best->path))) best = m;
  }
  if(!best || !best->holdable) return NULL;
  *root = FALSE;
#if defined(__linux__)
  // one FUSE mount carries every gvfs share: each share is a drive of its own
  if(g_str_has_suffix(best->path, "/gvfs") && g_str_has_prefix(best->path, "/run/user/"))
  {
    const char *rest = path + strlen(best->path);
    while(*rest == '/') rest++;
    const char *end = rest;
    while(*end && *end != '/') end++;
    if(end > rest) return g_strdup_printf("%s/%.*s", best->path, (int)(end - rest), rest);
  }
#endif
  return g_strdup(best->path);
}
#endif

drives_t *drives_of(const char *path)
{
  if(!path || !*path) return NULL;
#ifdef _WIN32
  char *key = _windows_key(path);
  if(_test_stall && _under(path, _test_stall)) { g_free(key); key = g_strdup(_test_stall); }
  if(!key) return NULL;
  eng_lock(&_lock, ENG_LOCK_PROBE);
  drives_t *d = _drive_locked(key);
  eng_unlock(&_lock, ENG_LOCK_PROBE);
  g_free(key);
  return d;
#else
  gboolean root = TRUE;
  eng_lock(&_lock, ENG_LOCK_PROBE);
  char *key = _lookup_locked(path, &root);
  const gboolean stale = !_table || (root && g_get_monotonic_time() - _table_read > _TABLE_FRESH_US);
  eng_unlock(&_lock, ENG_LOCK_PROBE);
  if(stale)
  {
    // a drive plugged in since the table was read lands on / until it is read again
    GArray *t = _read_table();
    eng_lock(&_lock, ENG_LOCK_PROBE);
    GArray *old = _table;
    _table = t;
    _table_read = g_get_monotonic_time();
    g_free(key);
    key = _lookup_locked(path, &root);
    eng_unlock(&_lock, ENG_LOCK_PROBE);
    _table_free(old);
  }
  if(!key) return NULL;
  eng_lock(&_lock, ENG_LOCK_PROBE);
  drives_t *d = _drive_locked(key);
  eng_unlock(&_lock, ENG_LOCK_PROBE);
  g_free(key);
  return d;
#endif
}

const char *drives_mount(const drives_t *d)
{
  return d ? d->mount : NULL;
}

gboolean drives_held(drives_t *d)
{
  if(!d) return FALSE;
  if(g_atomic_int_get(&d->stuck) > 0) return TRUE;
  gboolean held = FALSE;
  gint64 log_for = 0; // how long the import has run, when it is newly held
  const gint64 now = g_get_monotonic_time();
  eng_lock(&_lock, ENG_LOCK_PROBE);
  for(int i = 0; i < _IMPORT_SLOTS; i++)
    if(_slots[i].drive == d && now - _slots[i].started > _IMPORT_STALL_US)
    {
      held = TRUE;
      if(!_slots[i].logged)
      {
        _slots[i].logged = TRUE;
        log_for = now - _slots[i].started;
      }
    }
  eng_unlock(&_lock, ENG_LOCK_PROBE);
  if(log_for)
    fprintf(stderr, "[engine] drive %s not answering: an import has run %.0f s; held\n", d->mount, log_for / 1e6);
  return held;
}

drives_t *drives_path_held(const char *path)
{
  drives_t *d = drives_of(path);
  return drives_held(d) ? d : NULL;
}

void drives_stuck(drives_t *d)
{
  if(!d) return;
  if(g_atomic_int_add(&d->stuck, 1) == 0)
    fprintf(stderr, "[engine] drive %s not answering: held until its read returns\n", d->mount);
}

void drives_unstuck(drives_t *d)
{
  if(!d) return;
  if(g_atomic_int_add(&d->stuck, -1) == 1)
    fprintf(stderr, "[engine] drive %s answering again\n", d->mount);
}

int drives_import_begin(drives_t *d)
{
  if(!d) return -1;
  int slot = -1;
  eng_lock(&_lock, ENG_LOCK_PROBE);
  for(int i = 0; i < _IMPORT_SLOTS && slot < 0; i++)
    if(!_slots[i].drive)
    {
      _slots[i].drive = d;
      _slots[i].started = g_get_monotonic_time();
      _slots[i].logged = FALSE;
      slot = i;
    }
  eng_unlock(&_lock, ENG_LOCK_PROBE);
  return slot;
}

void drives_import_end(const int slot)
{
  if(slot < 0 || slot >= _IMPORT_SLOTS) return;
  eng_lock(&_lock, ENG_LOCK_PROBE);
  const drives_t *was = _slots[slot].logged ? _slots[slot].drive : NULL;
  _slots[slot].drive = NULL;
  eng_unlock(&_lock, ENG_LOCK_PROBE);
  if(was) fprintf(stderr, "[engine] drive %s answering again: its import returned\n", was->mount);
}

void drives_init(void)
{
  const char *dir = g_getenv("IMMAGE_TEST_STALL_DIR");
  if(dir && *dir) _test_stall = g_strdup(dir);
}

// test only (IMMAGE_TEST_STALL_DIR): a read under that folder blocks until
// <dir>/.release exists, as a stuck drive's would
void drives_test_stall(const char *path)
{
  if(!_test_stall || !path || !_under(path, _test_stall)) return;
  gchar *release = g_build_filename(_test_stall, ".release", NULL);
  while(!g_file_test(release, G_FILE_TEST_EXISTS)) g_usleep(50 * 1000);
  g_free(release);
}

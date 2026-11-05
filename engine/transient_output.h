// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// Private engine-to-app buffers. The JSON reply publishes completion; the app
// holds its request lock through consumption. Thumbnail names are per request.
#pragma once
#include <stdint.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
typedef struct transient_pending_t {
  HANDLE mapping, done;
  struct transient_pending_t *next;
} transient_pending_t;
static transient_pending_t *_transient_pending;
static GMutex _transient_lock;
#elif defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#endif

#if defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
// Darwin permits only one ftruncate per POSIX shm object. The app owns these
// private names and serializes each writer through consumption. Retain capacity
// for smaller payloads; replace the named object only when it must grow. Readers
// open the name after the completion reply, and the app still unlinks it on exit.
static int transient_shared_open(const char *name, size_t length)
{
  int fd = shm_open(name, O_RDWR, 0);
  if(fd < 0) return -1;
  struct stat st;
  if(fstat(fd, &st)) { close(fd); return -1; }
  if(st.st_size >= 0 && (uint64_t)st.st_size >= length) return fd;
  if(st.st_size != 0)
  {
    close(fd);
    if(shm_unlink(name)) return -1;
    fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
    if(fd < 0) return -1;
  }
  if(ftruncate(fd, (off_t)length)) { close(fd); return -1; }
  return fd;
}
#endif

static gboolean transient_write(const char *path, const void *first, size_t a,
                                 const void *second, size_t b)
{
  if(a > SIZE_MAX - 8 || b > SIZE_MAX - 8 - a) return FALSE;
  const size_t n = a + b, length = n + 8;
  if(!g_str_has_prefix(path, "shm:"))
  {
    // Transient output needs neither rename nor fsync: readers wait for reply.
    FILE *f = g_fopen(path, "wb");
    gboolean ok = f && fwrite(first, 1, a, f) == a
      && (!b || fwrite(second, 1, b, f) == b);
    if(f && fclose(f)) ok = FALSE;
    return ok;
  }
  const char *name = path + 4;
  void *view = NULL;
#ifdef _WIN32
  g_mutex_lock(&_transient_lock);
  transient_pending_t **p = &_transient_pending;
  while(*p)
  {
    transient_pending_t *item = *p;
    if(WaitForSingleObject(item->done, 0) == WAIT_OBJECT_0)
    {
      *p = item->next;
      CloseHandle(item->mapping);
      CloseHandle(item->done);
      g_free(item);
    }
    else p = &item->next;
  }
  wchar_t *wide = (wchar_t *)g_utf8_to_utf16(name, -1, NULL, NULL, NULL);
  gchar *done_name = g_strconcat(name, "-done", NULL);
  wchar_t *wide_done = (wchar_t *)g_utf8_to_utf16(done_name, -1, NULL, NULL, NULL);
  g_free(done_name);
  HANDLE mapping = wide ? CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
                              (DWORD)((uint64_t)length >> 32), (DWORD)length, wide) : NULL;
  // A still-live name means the previous consumer has not finished. Never
  // overwrite it, even if a caller accidentally violates serialization.
  if(mapping && GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(mapping); mapping = NULL; }
  HANDLE done = mapping && wide_done ? CreateEventW(NULL, TRUE, FALSE, wide_done) : NULL;
  if(done && GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(done); done = NULL; }
  g_free(wide);
  g_free(wide_done);
  if(mapping && done) view = MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, length);
  if(!view)
  {
    if(mapping) CloseHandle(mapping);
    if(done) CloseHandle(done);
    g_mutex_unlock(&_transient_lock);
    return FALSE;
  }
#elif defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
  // The app creates and owns this mode-0600 object. Do not create arbitrary
  // objects here; failed/abandoned output remains owned by the app's lifetime.
  int fd = transient_shared_open(name, length);
  if(fd < 0) return FALSE;
  view = mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
  close(fd);
  if(view == MAP_FAILED) return FALSE;
#else
  (void)name;
  (void)length;
  return FALSE;
#endif
  uint64_t count = GUINT64_TO_LE(n);
  memcpy(view, &count, 8);
  memcpy((uint8_t *)view + 8, first, a);
  if(b) memcpy((uint8_t *)view + 8 + a, second, b);
#ifdef _WIN32
  UnmapViewOfFile(view);
  transient_pending_t *item = g_new(transient_pending_t, 1);
  *item = (transient_pending_t){ mapping, done, _transient_pending };
  _transient_pending = item;
  g_mutex_unlock(&_transient_lock);
#elif defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
  munmap(view, length);
#endif
  return TRUE;
}

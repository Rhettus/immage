// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// cc verify/transient-output.c -o /tmp/immage-transient-test $(pkg-config --cflags --libs glib-2.0)
#include <glib.h>
#include <glib/gstdio.h>
#include <stdio.h>
#include <unistd.h>
#include <sys/stat.h>
#include <errno.h>
// Emulate Darwin: an allocated shm object cannot be truncated again.
static gboolean emulate_darwin_shm = TRUE;
static int darwin_ftruncate(int fd, off_t length)
{
  struct stat st;
  if(fstat(fd, &st)) return -1;
  if(emulate_darwin_shm && st.st_size) { errno = EINVAL; return -1; }
  return ftruncate(fd, length);
}
#define ftruncate darwin_ftruncate
#define IMMAGE_TEST_POSIX_OUTPUT
#include "../engine/transient_output.h"
#include "../engine/rgba_output.h"
#undef ftruncate
#include <assert.h>
int main(void)
{
  char *name = g_strdup_printf("/immage-test-%d", getpid());
  char *path = g_strconcat("shm:", name, NULL);
  shm_unlink(name);
  assert(!transient_write(path, "missing", 7, NULL, 0));
  int fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
  assert(fd >= 0);
  const size_t sizes[] = { 0, 3, 3, 100000, 17, 17 };
  for(size_t i = 0; i < G_N_ELEMENTS(sizes); i++)
  {
    size_t n = sizes[i];
    unsigned char *bytes = g_malloc(MAX(n, 1));
    for(size_t k = 0; k < n; k++) bytes[k] = k % 251;
    assert(transient_write(path, bytes, n / 2, bytes + n / 2, n - n / 2));
    close(fd);
    fd = shm_open(name, O_RDONLY, 0);
    assert(fd >= 0);
    struct stat st;
    assert(!fstat(fd, &st) && st.st_size >= (off_t)n + 8);
    assert((st.st_mode & 0777) == 0600);
    void *view = mmap(NULL, n + 8, PROT_READ, MAP_SHARED, fd, 0);
    assert(view != MAP_FAILED);
    uint64_t count;
    memcpy(&count, view, 8);
    assert(GUINT64_FROM_LE(count) == n);
    assert(!memcmp((char *)view + 8, bytes, n));
    munmap(view, n + 8);
    g_free(bytes);
  }
  assert(!transient_write(path, "", SIZE_MAX, "", 1));
  // Direct mapped output reuses capacity, including shrink/regrow, while the
  // header publishes exact payload length. Growth replaces the named object.
  void *large_view = NULL;
  for(size_t i = 0; i < G_N_ELEMENTS(sizes); i++)
  {
    size_t n = sizes[i] + 1;
    uint8_t *mapped = rgba_output_acquire(path, n);
    assert(mapped);
    memset(mapped, 19 + i, n);
    if(n == 100001) large_view = _rgba_outputs[0].view;
    if(n == 18) assert(_rgba_outputs[0].view == large_view);
    close(fd);
    fd = shm_open(name, O_RDONLY, 0);
    assert(fd >= 0);
    struct stat st;
    assert(!fstat(fd, &st) && st.st_size >= (off_t)n + 8);
    assert((st.st_mode & 0777) == 0600);
    void *view = mmap(NULL, n + 8, PROT_READ, MAP_SHARED, fd, 0);
    assert(view != MAP_FAILED);
    uint64_t count;
    memcpy(&count, view, 8);
    assert(GUINT64_FROM_LE(count) == n);
    for(size_t k = 0; k < n; k++) assert(((uint8_t *)view)[8+k] == 19 + i);
    munmap(view, n + 8);
  }
  assert(rgba_output_acquire(path, 1000)); // regrow within retained capacity
  assert(_rgba_outputs[0].view == large_view);
  assert(!rgba_output_acquire(path, 0));
  assert(!rgba_output_acquire(path, SIZE_MAX));
  rgba_output_close(&_rgba_outputs[0]);
  close(fd);
  assert(!shm_unlink(name));
  assert(!transient_write(path, "gone", 4, NULL, 0));
  // Regular-file fallback is headerless and truncates old output.
  emulate_darwin_shm = FALSE;
  char *file = NULL;
  fd = g_file_open_tmp("immage-transient-XXXXXX", &file, NULL);
  assert(fd >= 0);
  close(fd);
  assert(transient_write(file, "before", 6, "after", 5));
  assert(transient_write(file, "new", 3, NULL, 0));
  char *got = NULL;
  gsize length = 0;
  assert(g_file_get_contents(file, &got, &length, NULL));
  assert(length == 3 && !memcmp(got, "new", 3));
  uint8_t *direct = rgba_output_acquire(file, 10000);
  assert(direct); memset(direct, 117, 10000);
  uint8_t *second = rgba_output_acquire("/dev/null/not-a-file", 32);
  assert(!second);
  char *second_file = NULL;
  fd = g_file_open_tmp("immage-transient-second-XXXXXX", &second_file, NULL);
  assert(fd >= 0); close(fd);
  second = rgba_output_acquire(second_file, 32);
  assert(second); memset(second, 42, 32);
  assert(direct[0] == 117 && direct[9999] == 117);
  assert(rgba_output_acquire(file, 16) == direct);
  g_free(got); got = NULL;
  assert(g_file_get_contents(file, &got, &length, NULL));
  assert(length == 16);
  for(size_t k = 0; k < length; k++) assert((uint8_t)got[k] == 117);
  rgba_output_close(&_rgba_outputs[0]);
  rgba_output_close(&_rgba_outputs[1]);
  g_unlink(second_file); g_free(second_file);
  g_unlink(file);
  g_free(got); g_free(file); g_free(path); g_free(name);
  return 0;
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
// cc verify/transient-output.c -o /tmp/immage-transient-test $(pkg-config --cflags --libs glib-2.0)
#include <glib.h>
#include <glib/gstdio.h>
#include <stdio.h>
#include <unistd.h>
#define IMMAGE_TEST_POSIX_OUTPUT
#include "../engine/transient_output.h"
#include <assert.h>
int main(void)
{
  char *name = g_strdup_printf("/immage-test-%d", getpid());
  char *path = g_strconcat("shm:", name, NULL);
  shm_unlink(name);
  assert(!transient_write(path, "missing", 7, NULL, 0));
  int fd = shm_open(name, O_RDWR | O_CREAT | O_EXCL, 0600);
  assert(fd >= 0);
  const size_t sizes[] = { 0, 3, 100000, 17 };
  for(size_t i = 0; i < G_N_ELEMENTS(sizes); i++)
  {
    size_t n = sizes[i];
    unsigned char *bytes = g_malloc(MAX(n, 1));
    for(size_t k = 0; k < n; k++) bytes[k] = k % 251;
    assert(transient_write(path, bytes, n / 2, bytes + n / 2, n - n / 2));
    struct stat st;
    assert(!fstat(fd, &st) && st.st_size == (off_t)n + 8);
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
  close(fd);
  assert(!shm_unlink(name));
  assert(!transient_write(path, "gone", 4, NULL, 0));
  // Regular-file fallback is headerless and truncates old output.
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
  g_unlink(file);
  g_free(got); g_free(file); g_free(path); g_free(name);
  return 0;
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// loaded into the engine (LD_PRELOAD, Linux) by verify/exiv2-lock.py: fread()
// from a file whose path contains "slowread" sleeps as a 100 MB/s drive
// would, so a large photo's metadata read takes seconds. exiv2's FileIo reads
// with fread, which reaches this through the PLT
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

size_t fread(void *ptr, size_t size, size_t n, FILE *f)
{
  static size_t (*real)(void *, size_t, size_t, FILE *);
  if(!real) real = (size_t (*)(void *, size_t, size_t, FILE *))dlsym(RTLD_NEXT, "fread");
  char link[64], path[4096];
  snprintf(link, sizeof(link), "/proc/self/fd/%d", fileno(f));
  const ssize_t len = readlink(link, path, sizeof(path) - 1);
  if(len > 0)
  {
    path[len] = '\0';
    if(strstr(path, "slowread")) usleep((useconds_t)(size * n / 100));
  }
  return real(ptr, size, n, f);
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// loaded into the engine (DYLD_INSERT_LIBRARIES, macOS) by the "a dropped
// share's photo" check in harness.mjs: a file under $TRAPMAP_DIR that is
// memory-mapped is truncated at once, so a read of the mapping raises
// SIGBUS, as a mapped file on a network share does when the share drops.
// read() of such a file only fails. it marks itself loaded with
// $TRAPMAP_DIR/.loaded, so the check can tell a binary that ignores it
#include <fcntl.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void *_mmap(void *addr, size_t len, int prot, int flags, int fd, off_t offset)
{
  void *p = mmap(addr, len, prot, flags, fd, offset);
  const char *dir = getenv("TRAPMAP_DIR");
  char path[PATH_MAX];
  if(p != MAP_FAILED && fd >= 0 && dir && fcntl(fd, F_GETPATH, path) != -1
     && strncmp(path, dir, strlen(dir)) == 0)
    truncate(path, 0);
  return p;
}

__attribute__((used, section("__DATA,__interpose")))
static const struct { const void *with, *what; } _interpose[] = { { (const void *)_mmap, (const void *)mmap } };

__attribute__((constructor)) static void _loaded(void)
{
  const char *dir = getenv("TRAPMAP_DIR");
  char path[PATH_MAX];
  if(!dir) return;
  strlcpy(path, dir, sizeof(path));
  strlcat(path, "/.loaded", sizeof(path));
  close(open(path, O_CREAT | O_WRONLY, 0644));
}

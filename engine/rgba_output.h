// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
#pragma once
#ifndef _WIN32
#include <sys/mman.h>
#include <sys/stat.h>
#include <fcntl.h>
#endif

// Only the serialized main-loop render/preview writers use these two slots.
// Capacity follows each output's high-water mark, bounded to two frame buffers.
// Consumers finish before the next write to that output. There is no pixel cache.
typedef struct rgba_output_t {
  char *path;
  void *view;
  size_t capacity, length;
#ifdef _WIN32
  HANDLE mapping, done;
#else
  int fd;
#endif
} rgba_output_t;
static rgba_output_t _rgba_outputs[2];

static void rgba_output_close(rgba_output_t *slot)
{
  if(!slot->path) return;
#ifdef _WIN32
  if(slot->view) UnmapViewOfFile(slot->view);
  if(slot->mapping) CloseHandle(slot->mapping);
  if(slot->done) CloseHandle(slot->done);
#else
  if(slot->view) munmap(slot->view, slot->capacity);
  if(slot->fd >= 0) close(slot->fd);
#endif
  g_free(slot->path);
  memset(slot, 0, sizeof(*slot));
}

static uint8_t *rgba_output_acquire(const char *path, size_t bytes)
{
  const gboolean shared = g_str_has_prefix(path, "shm:");
  const size_t header = shared ? 8 : 0;
  if(!bytes || bytes > SIZE_MAX - header) return NULL;
  const size_t length = bytes + header;
  rgba_output_t *slot = NULL;
  for(size_t k = 0; k < G_N_ELEMENTS(_rgba_outputs); k++)
    if(!g_strcmp0(path, _rgba_outputs[k].path)) slot = &_rgba_outputs[k];
  if(!slot)
  {
    for(size_t k = 0; k < G_N_ELEMENTS(_rgba_outputs); k++)
      if(!_rgba_outputs[k].path) { slot = &_rgba_outputs[k]; break; }
    if(!slot) slot = &_rgba_outputs[0];
  }
#ifdef _WIN32
  if(!shared) return NULL; // Regular-file CLI output keeps transient_write.
  if(slot->path && WaitForSingleObject(slot->done, 0) != WAIT_OBJECT_0) return NULL;
#endif
  if(slot->path && (strcmp(slot->path, path) || slot->capacity < length)) rgba_output_close(slot);
  if(!slot->path)
  {
#ifdef _WIN32
    wchar_t *name = (wchar_t *)g_utf8_to_utf16(path + 4, -1, NULL, NULL, NULL);
    char *event = g_strconcat(path + 4, "-done", NULL);
    wchar_t *done_name = (wchar_t *)g_utf8_to_utf16(event, -1, NULL, NULL, NULL);
    g_free(event);
    HANDLE mapping = name ? CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
                          (DWORD)((uint64_t)length >> 32), (DWORD)length, name) : NULL;
    if(mapping && GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(mapping); mapping = NULL; }
    HANDLE done = mapping && done_name ? CreateEventW(NULL, TRUE, FALSE, done_name) : NULL;
    if(done && GetLastError() == ERROR_ALREADY_EXISTS) { CloseHandle(done); done = NULL; }
    g_free(name); g_free(done_name);
    void *view = mapping && done ? MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, length) : NULL;
    if(!view)
    {
      if(mapping) CloseHandle(mapping);
      if(done) CloseHandle(done);
      return NULL;
    }
    slot->mapping = mapping; slot->done = done; slot->view = view;
#else
    int fd;
#if defined(__APPLE__) || defined(IMMAGE_TEST_POSIX_OUTPUT)
    if(shared) fd = transient_shared_open(path + 4, length);
    else
#endif
      fd = shared ? -1 : g_open(path, O_RDWR | O_CREAT | O_CLOEXEC, 0600);
    if(fd < 0) return NULL;
    if(!shared && ftruncate(fd, (off_t)length)) { close(fd); return NULL; }
    void *view = mmap(NULL, length, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if(view == MAP_FAILED) { close(fd); return NULL; }
    slot->fd = fd; slot->view = view;
#endif
    slot->path = g_strdup(path); slot->capacity = length; slot->length = length;
  }
#ifdef _WIN32
  if(!ResetEvent(slot->done)) return NULL;
#else
  // Files expose exact length; shared objects publish payload size in header.
  if(!shared && slot->length != length && ftruncate(slot->fd, (off_t)length)) return NULL;
#endif
  slot->length = length;
  if(shared)
  {
    uint64_t count = GUINT64_TO_LE(bytes);
    memcpy(slot->view, &count, 8);
  }
  return (uint8_t *)slot->view + header;
}

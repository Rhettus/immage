// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// The list behind the Lens Corrections lens menu. The lens module keeps its
// lfDatabase to itself (lens.cc, global data), so this loads one the way its
// init_global() does for Lensfun before 0.3.95, the only ones darktable
// builds with: the system database, then the copy bundled beside darktable's
// data directory.
#include "lenses.h"

#include <lensfun.h>

#include <mutex>
#include <string.h>

#include "common/darktable.h"
#include "common/file_location.h"

#define LENSES_STR_HELPER(x) #x
#define LENSES_STR(x) LENSES_STR_HELPER(x)

static lfDatabase *_db()
{
  static lfDatabase *db = nullptr;
  static std::once_flag once;
  std::call_once(once, []() {
    db = new lfDatabase;
    if(db->Load() == LF_NO_ERROR) return;
    char datadir[PATH_MAX] = { 0 };
    dt_loc_get_datadir(datadir, sizeof(datadir));
    GFile *file = g_file_parse_name(datadir);
    GFile *parent = g_file_get_parent(file);
    gchar *path = g_file_get_path(parent);
    g_object_unref(parent);
    g_object_unref(file);
#ifdef LF_MAX_DATABASE_VERSION
    gchar *versioned = g_build_filename(path, "lensfun", "version_" LENSES_STR(LF_MAX_DATABASE_VERSION), NULL);
    g_free(db->HomeDataDir);
    db->HomeDataDir = g_strdup(versioned);
    g_free(versioned);
    if(db->Load() == LF_NO_ERROR)
    {
      g_free(path);
      return;
    }
#endif
    g_free(db->HomeDataDir);
    db->HomeDataDir = g_build_filename(path, "lensfun", NULL);
    db->Load();
    g_free(path);
  });
  return db;
}

// darktable's lens types are numbered as Lensfun's
static int _geometry(const lfLens *lens)
{
  switch(lens->Type)
  {
    case LF_RECTILINEAR:
    case LF_FISHEYE:
    case LF_PANORAMIC:
    case LF_EQUIRECTANGULAR:
    case LF_FISHEYE_ORTHOGRAPHIC:
    case LF_FISHEYE_STEREOGRAPHIC:
    case LF_FISHEYE_EQUISOLID:
    case LF_FISHEYE_THOBY:
      return (int)lens->Type;
    default:
      return 0;
  }
}

unsigned lenses_hash(const char *model)
{
  unsigned h = 2166136261u;
  for(const unsigned char *c = (const unsigned char *)model; *c; c++) h = (h ^ *c) * 16777619u;
  h &= 0xffffffu;
  return h ? h : 1;
}

void lenses_list(const char *cam_maker, const char *cam_model, lenses_cb cb, void *user)
{
  lfDatabase *db = _db();
  dt_pthread_mutex_lock(&darktable.plugin_threadsafe);
  const lfLens **found = nullptr;
  if(cam_model && *cam_model)
  {
    const lfCamera **cams = db->FindCamerasExt(cam_maker && *cam_maker ? cam_maker : nullptr, cam_model, 0);
    if(cams)
    {
      found = db->FindLenses(cams[0], nullptr, nullptr, 0);
      lf_free(cams);
    }
  }
  if(found)
  {
    for(int i = 0; found[i]; i++) cb(lf_mlstr_get(found[i]->Maker), found[i]->Model, user);
    lf_free(found);
  }
  else
  {
    const lfLens *const *all = db->GetLenses();
    for(int i = 0; all && all[i]; i++) cb(lf_mlstr_get(all[i]->Maker), all[i]->Model, user);
  }
  dt_pthread_mutex_unlock(&darktable.plugin_threadsafe);
}

void lenses_match(const char *cam_maker, const char *cam_model, const char *name, char *model, size_t size)
{
  if(!name || !*name) return;
  lfDatabase *db = _db();
  dt_pthread_mutex_lock(&darktable.plugin_threadsafe);
  const lfCamera **cams = cam_model && *cam_model
    ? db->FindCamerasExt(cam_maker && *cam_maker ? cam_maker : nullptr, cam_model, 0) : nullptr;
  const lfLens **found = db->FindLenses(cams ? cams[0] : nullptr, nullptr, name, 0);
  if(found)
  {
    g_strlcpy(model, found[0]->Model, size);
    lf_free(found);
  }
  if(cams) lf_free(cams);
  dt_pthread_mutex_unlock(&darktable.plugin_threadsafe);
}

gboolean lenses_find(unsigned hash, char *model, size_t size, int *geom)
{
  lfDatabase *db = _db();
  gboolean ok = FALSE;
  dt_pthread_mutex_lock(&darktable.plugin_threadsafe);
  const lfLens *const *all = db->GetLenses();
  for(int i = 0; all && all[i] && !ok; i++)
    if(lenses_hash(all[i]->Model) == hash)
    {
      g_strlcpy(model, all[i]->Model, size);
      *geom = _geometry(all[i]);
      ok = TRUE;
    }
  dt_pthread_mutex_unlock(&darktable.plugin_threadsafe);
  return ok;
}

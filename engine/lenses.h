// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the Lensfun lenses Lens Corrections can be pointed at, read from the same
// database the lens module loads (lenses.cc)
#pragma once

#include <glib.h>

#ifdef __cplusplus
extern "C" {
#endif

// a lens's name as a number the front end keeps in an edit: 24 bits, never 0
unsigned lenses_hash(const char *model);

// called once per lens: its maker, model and darktable's target geometry
typedef void (*lenses_cb)(const char *maker, const char *model, void *user);

// the lenses that fit the camera (its maker and model as the EXIF names
// them), or every lens when the camera is not in the database or none fit
void lenses_list(const char *cam_maker, const char *cam_model, lenses_cb cb, void *user);

// the database's name for a lens as the EXIF names it, found as the lens
// module finds it for the camera; `model` is left alone when none matches
void lenses_match(const char *cam_maker, const char *cam_model, const char *name, char *model, size_t size);

// the lens whose lenses_hash() is `hash`, among all of them; its model is
// copied to `model` and darktable's target geometry to `geom`
gboolean lenses_find(unsigned hash, char *model, size_t size, int *geom);

#ifdef __cplusplus
}
#endif

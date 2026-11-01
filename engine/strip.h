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

#pragma once

#include <glib.h>

G_BEGIN_DECLS

// what strip_metadata() takes out of an exported file
typedef enum strip_t
{
  STRIP_SERIALS = 1 << 0,     // the camera's, lens's and accessories' serial numbers, the owner's name
  STRIP_CAMERA = 1 << 1,      // the camera, lens and exposure settings, makernotes included
  STRIP_DESCRIPTION = 1 << 2, // the source's own title, description, artist and copyright
  STRIP_KEYWORDS = 1 << 3,    // the source's own keywords
} strip_t;

// takes out of an exported file what darktable's export flags cannot
// (src/common/metadata_export.h). the date taken and the orientation
// stay. NULL when done, else a message to g_free()
char *strip_metadata(const char *path, strip_t what);

// Merge export EXIF while preserving the rendered file's layout and color tags.
gboolean rendered_metadata(const char *path, const void *blob, int size, gboolean dng);

// marks a sidecar's GPS as authoritative, including removed source fields
// missing returns bit 1 for coordinates and bit 2 for altitude, or 0 if unmanaged
gboolean location_sidecar_mark(const char *path);
int location_sidecar_missing(const char *path);

G_END_DECLS

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
  STRIP_HISTORY = 1 << 4,     // darktable's edit history in XMP; strip_jxl() only
  STRIP_LOCATION = 1 << 5,    // GPS in EXIF and XMP; strip_jxl() only
} strip_t;

// takes out of an exported file what darktable's export flags cannot
// (src/common/metadata_export.h). the date taken and the orientation
// stay. NULL when done, else a message to g_free()
char *strip_metadata(const char *path, strip_t what);

// the same for a JPEG XL, whose metadata boxes exiv2 cannot rewrite; also
// takes out the history and location the bits above name. Fails if a box is
// compressed. NULL when done, else a message to g_free()
char *strip_jxl(const char *path, strip_t what);

// puts an ICC profile into an exported JPEG, TIFF or WebP that has none:
// darktable's format writers embed it, then its EXIF writer reopens the file
// without reading its metadata and rewrites it without the profile
// (exif.cc, dt_exif_write_blob). NULL when done, else a message to g_free()
char *embed_profile(const char *path, const void *icc, size_t size);

// Merge export EXIF while preserving the rendered file's layout and color tags.
gboolean rendered_metadata(const char *path, const void *blob, int size, gboolean dng);

// Stamp the source orientation and raw denoise marker without replacing the
// generated DNG's existing metadata. orientation is darktable's flip bits.
gboolean denoised_metadata(const char *path, int orientation);

// Stamp a source orientation on a generated DNG while preserving its metadata.
gboolean dng_orientation_metadata(const char *path, int orientation);

// marks a sidecar's GPS as authoritative, including removed source fields
// missing returns bit 1 for coordinates and bit 2 for altitude, or 0 if unmanaged
gboolean location_sidecar_mark(const char *path);
int location_sidecar_missing(const char *path);

// Camera body serial from standard EXIF/DNG or recognized maker notes; caller frees.
char *camera_body_serial(const char *path);

G_END_DECLS

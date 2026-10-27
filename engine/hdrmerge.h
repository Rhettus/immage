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

// Lightroom's Merge to HDR on darktable's HDR merge, which darktable runs
// only as a lighttable job (see hdrmerge.c)

// whether this build can align brackets (darktable built with OpenCV)
gboolean hdr_merge_can_align(void);

// the raw brackets `imgids` merged into a float DNG beside the first:
// <name>-hdr.dng, or -hdr_01.dng, -hdr_02.dng... when taken. `align`
// registers each onto the reference first, when the build can. returns the
// DNG's path, or NULL with *err
gchar *hdr_merge(GList *imgids, gboolean align, char **err);

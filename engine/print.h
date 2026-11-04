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

#include "common/image.h"

#include <glib.h>
#include <json-glib/json-glib.h>

// Lightroom's Print module and soft proofing on darktable's: colorout's
// proofing transform (darktable.color_profiles->mode), and the print
// view's export, printer profile, PDF and CUPS or Windows spooler, which
// darktable runs only from its GUI (libs/print_settings.c)

// the printer profiles that can be chosen, as [{ name, file }]: darktable's
// own output profiles from files, and the system's printer profiles, which
// are added to darktable's list on the way
void print_profiles(JsonBuilder *b);

// copy the profile at `path` among darktable's output profiles and add it
// to the list; replies { name, file }
gboolean print_profile_add(const char *path, JsonBuilder *b, char **err);

// soft proofing: `mode` "off", "proof" or "gamut" (out of gamut colors
// cyan), against the printer profile `file` with rendering `intent`
// (darktable's dt_iop_color_intent_t). TRUE when the mode changed, and
// colorout must be committed again on every full pipe
gboolean print_softproof(const char *mode, const char *file, const int intent, gboolean *changed, char **err);

// `hash` with the soft proof in it: the mode is in no module's params, so
// darktable's hash of the pipe is the same proofed or not
dt_hash_t print_proof_hash(const dt_hash_t hash);

// whether this engine was built with darktable's print support
gboolean print_available(void);

// the printers the system offers, as [{ name, description, default }]
void print_printers(JsonBuilder *b);

// a printer's resolution, hardware margins, papers and media types
gboolean print_printer(const char *name, JsonBuilder *b, char **err);

// render `imgid` for the page `req` describes and print it, or with `pdf`
// write it to that file instead
gboolean print_image(const dt_imgid_t imgid, JsonObject *req, JsonBuilder *b, char **err);


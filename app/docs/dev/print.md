# Print and soft proofing

The Print panel ([PrintPanel.tsx](../../src/PrintPanel.tsx)) is a print
module built on darktable's: colorout's soft proof, and the print view's
export, printer profile conversion, PDF writer and CUPS or Windows spooler.
darktable runs the print job only from its GTK library module
(`src/libs/print_settings.c`), so [engine/print.c](../../../engine/print.c)
does what that module's job does, without its screen layout, and with no
change to darktable's source.

## Pieces

| Where | What |
|---|---|
| [print.ts](../../src/print.ts) | `PrintSettings` (stored in the settings store as `immage.print`), PDF papers (PWG names), `layout()` (page orientation, margins, Fill or a long edge, nine places, borderless against the hardware margins, which turn with the page as `dt_get_print_layout` turns them), `printRequest()`, `applyProof()`. |
| [PrintPanel.tsx](../../src/PrintPanel.tsx) | The panel: Soft Proofing, Printer, Layout (print size and pixels per inch, margins, size), Color Management, Print / Save PDF. |
| App.tsx | `RightMode` `"print"`, the rail button after Export, ⌘P, S (`toggleProofRef`), the `proof` state, `changeProof()` and the `Soft Proof:` badge over the photo; the effects that read printers and profiles when the panel opens and the chosen printer's papers; the page in the viewer (`printPage`, `sheet`, `printViewRef`); `printNow()`. |
| [print.ts](../../src/print.ts), Cells | `cellsLayout()` (grid, pages), `sheetPages()` and `sheetRequest()`: a page is a list of cells, each a photo box and an optional label rectangle in millimeters; the engine knows nothing of columns, so another generator (user-drawn cells) can follow. |
| `Session.redraw()` | After the engine's view changes with no edit: drops the frames kept by view and the zoom copy (`changed()`), and renders. |
| main.rs | `print_profiles`, `print_profile_add`, `softproof`, `printers`, `printer_info`, and `print_sheet` and `print_photo` (`export_hold`, a tagged `print` on the export thread, `export_release`, as `export_images` does). |
| [engine/print.c](../../../engine/print.c) | Profiles, the soft proof, printers and the print job. |
| main.c | The commands (`print`, `print_profiles`, `print_profile_add`, `printers`, `printer`, `softproof`); a tagged `print` goes to the export pool (`_export_run`) and renders the job's snapshot (`_hold_take`). |

## The page in the viewer

While the panel is open (`printOpen`), App.tsx lays out the page the
panel's settings describe (`printPage`, from `layout()` with the chosen
printer's papers and hardware margins) and fits it into the viewer
(`sheet`, CSS pixels, measured by a `ResizeObserver` on the viewer). The
`.print-sheet` and its dashed `.print-area` sit under the edit's pane, and
the nine `.print-align` dots over it.

The photo is not a picture of the photo: the edit's pane (`after-pane`
`on-page`) is moved to the photo's rectangle on the page, grown by the fit
margin (`MARGIN`) on each side. The pane's `ResizeObserver` refits and
re-renders, so the ordinary fitted render fills the rectangle at screen
resolution, soft proof included.
A photo smaller than its rectangle on screen renders at 100% and so falls
short of it, as fit never enlarges. Margins the photo doesn't fit in hide
the pane.

The page replaces the split views and compare: entering the panel turns
them off, and `printPage` is null while either is on. `printViewRef` holds
the zoom at fit (`animateTo` refuses any other zoom, which covers the
wheel, clicks, Z and the navigator), and the zoom bar is disabled.

## The Cells layout

`settings.layout` is `"single"` or `"cells"`. In Cells, `printPage` is null
(the live edit's pane stays hidden, `visibility: hidden`) and App.tsx shows
`cellsSheet` instead: `cellsLayout()` for the selected photos, drawn as
`.print-cell`s holding `CellCanvas` and `.print-label`s, with
`.print-pager` for the page shown (`sheetPageNo`, clamped). `sheetPhotos` is
the selection filtered with `!isRemote` in `shown` order, else the open photo.
`CellCanvas` fetches its own engine thumbnail (`fetchThumb`) at the cell's
device pixels, in steps of 128 up to 1440, not the filmstrip's 240. With the
proof on, `thumb` carries `proof: true` and `_thumb` in main.c copies the
mipmap pixels through `print_proof_pixels` (print.c), colorout's proofing
transform and flags from the thumbnail's color space to sRGB; Rust does not
keep a proofed thumbnail in the thumbnail cache. The cell refetches on
`proofApplied`, set once `softproof` has replied, so it never races the
engine's old state. The `Soft Proof:` badge is hidden while `printOpen`.

`cellsLayout(paper, settings, photos, hw)` returns one page's `slots` in
reading order, `columns`, `rows`, `perPage` and `pages`. It works in the
area inside the margins (`settings.margins`, the Cells border). Auto size
tries every column count for the cells wanted (`cellCount`, else the photos
up to `CONTACT_CAPACITY` = 38) and keeps the one with the largest smaller
side of its photo box; `gap` is the space between, equal both ways.
Each slot reserves `LABEL_HEIGHT` (4 mm) under its box when `names` is on.
Custom `cellSize` keeps the box, clamped to the area, and shares what is
left equally between cells and edges (space-evenly). An Auto page fills its
grid, so the last row's empty cells are slots too (`perPage` =
columns x rows); a counted page holds `cellCount`. Tests: `print cells
layout` in `verify/print.test.mjs` (38 on Letter is 6 x 7, equal gaps,
no overlap, no escape from the margins, the 2 cells in a 50 mm border,
paging).

## Printer profiles

darktable lists output profiles once, at startup, from
`<configdir>/color/out` (`dt_colorspaces_init`). The engine adds to that list
at run time (`_register`): RGB profiles lcms can make an output transform
with, found in the system's printer profile folders (`_scan_system`, output
class only, read from the ICC header before the profile is parsed) and in
`<configdir>/color/out`, where `print_profile_add` copies a profile the user
picks. Entries are prepended under `xprofile_lock`: a thread already walking
the list (an export reading its profile) holds the old head, and nothing is
unlinked. colorout finds the soft proof's profile there, by file name.

## Soft proof

colorout proofs when `darktable.color_profiles->mode` is
`DT_PROFILE_SOFTPROOF` or `DT_PROFILE_GAMUTCHECK`, on full pipes only
(`colorout.c`, `commit_params`). All four of the engine's pipes are full
pipes, so the frames, drags, the idle base and the preview pipe all show it.
Export and thumbnail pipes never do.

- **Intent.** The proofing transform's intent into the proof profile is the
  display intent (`out_intent`), not `softproof_intent`. `print_softproof`
  sets `display_intent` to the print's intent while proofing and puts the
  display's back after. The proof profile to the screen is always relative
  colorimetric with black point compensation (darktable's TODO in colorout).
- **Recommit.** The mode is in no params and no hash. The `softproof`
  command invalidates every pipe's cache from colorout's order
  (`_invalidate_from`) and synchs them (`_changed(DT_DEV_PIPE_SYNCH)`), as
  darktable's soft proof button reprocesses from colorout (`darkroom.c`).
- **Frame identity.** For the same reason the pipe's hash is the same
  proofed or not, so `_frame_hash` mixes the proof in (`print_proof_hash`);
  without that, a render's `have` hands the client the frame from before.
  `Session.redraw()` drops the client's own kept frames.
- **Gamut warning.** lcms paints out-of-gamut colors with its alarm codes,
  50% gray unless set. darktable never sets them, though colorout's
  `_transform_lcms` looks for cyan, so `print_softproof` sets cyan with
  `cmsSetAlarmCodes` for gamut check mode. Only gamut-check transforms read
  them.
- The proof is engine state, not part of the edit: it survives opening
  another photo, and the badge follows App's `proof` state. The engine has
  no restart path that would lose it behind App's back.

## Printing

`print_image` follows `print_settings.c` (`_export_image`, `_create_pdf`,
`_print_job_run`):

1. The request carries the page as laid out (landscape turned) and the
   photo's rectangle in millimeters. `dt_printing_setup_page` sizes the
   export (`max_width`, `max_height`) at the resolution: the printer's
   (`dt_get_printer_info`, CUPS `DefaultResolution` halved to 360 or less)
   or the PDF's.
2. `dt_imageio_export_with_flags` renders through an in-memory format
   (`_print_format_t`), upscaled to fill, high quality: 16-bit ProPhoto RGB
   with a printer profile, 8-bit sRGB for the driver to manage.
3. `dt_apply_printer_profile` converts with the profile, intent and BPC.
4. `dt_printing_setup_image` places it, `print.y` from the bottom as the
   PDF has it.
5. Linux and macOS: a temporary PDF (`dt_pdf_*`), then `dt_print_file`. It
   passes `cm-calibration` (and on macOS `AP_ColorMatchingMode`) when the
   profile is Immage's, and darktable embeds the ICC in the PDF only on
   macOS: on Linux Poppler would convert tagged pixels back to sRGB.
   `dt_print_file` reports nothing, so the result is `cupsLastError()`.
   Windows: `dt_win_print_file` with a print ticket made from the printer's
   DEVMODE with the paper and orientation (`_win_ticket`, as
   `_win_build_print_ticket`), and the ICC data. The engine has no window,
   so it never shows the driver's settings dialog.
6. Save PDF writes the same page to the chosen file, tagged with the
   printer profile or sRGB.

`print_sheet` prints the Cells layout. darktable's page holds 20 image
boxes (`MAX_IMAGE_PER_PAGE`), too few for 38 photos and their names, so the
engine puts each page together in one buffer and sends it as the one image
of its page through the same PDF, CUPS and spooler code (`_job_setup`,
`_pdf_*`, `_win_print_page`, shared with `print_image`). For each page it
fills the buffer white in the page's space (16-bit ProPhoto with a profile,
8-bit sRGB without), renders each cell's photo with the same export call as
`print_image` (`_render_photo`, upscaled to fill its box, the full-size pass
only for boxes of 800 pixels or more), centers it across its box (at the bottom when the cell has `valign: "bottom"`, which
`sheetRequest()` sends for cells with a name), and draws the
filename with Pango as a black alpha mask over the page (`_draw_label`,
7 pt at the job's dpi, middle-ellipsized). The printer profile is applied
once to the whole page. Names are raster, not PDF text, because Windows'
spooler takes image boxes only and never sees PDF content; they are as sharp
as the resolution. `dt_pdf_add_image` writes a page's pixels to the file as
it is called, so one page's buffer is in memory at a time (about 50 MB for
Letter at 300 dpi in 16 bits, and four times that at 600 dpi).
Windows' `dt_win_print_file` writes one fixed page, so each page is a job.

The request holds `pages: [[{ imgid, box, label? }]]`, `label_points` and
the job's fields. `print_sheet` in main.rs holds all the imgids
(`export_hold`), sends one tagged `print` to the export thread, which gives
`print_sheet` take and release callbacks (`_sheet_take` is `_hold_take`, and
`_sheet_release` removes the snapshot) so each photo is copied as its page
reaches it; an untagged `print` with `pages` renders the photos as they are.
The frontend job id is the hold id. A third callback, `print_step_f`
(`_sheet_step`, which is `_merge_report`), is called before the first photo
and after each is placed; its `merge-progress` lines (the `merge` helper in
main.rs, `runMerge` in background.ts) drive the activity line, and a
`merge_cancel` makes the next step return FALSE, which ends the print with
"stopped". App.tsx leaves the grid when Cells is chosen (`cellsChosen`).

The paper is looked up again in the printer's own list (`dt_get_papers`),
for what the client does not carry, such as Windows' `dm_paper_id`.

Printing needs darktable built with `BUILD_PRINT` (`HAVE_PRINT`): CUPS on
Linux (`libcups2-dev`) and macOS (in the SDK), Windows' own APIs there.
Without it, the profiles and soft proof still work and `printers` replies
`available: false`, which the panel shows.

## Verification

- `python3 -I verify/print.py`: the engine alone. Adding a profile once,
  refusing CMYK, the proof pulling saturated bands in and leaving gray, gamut
  cyan, the same frame and hash back after off, a render's `have` never
  returning a proofed frame for an unproofed one, PDFs with the right page,
  size at the resolution, bit depth and embedded profile, and bad requests
  refused. `--keep <dir>` keeps the PDFs to look at.
- Cells: `python3 -I verify/print.py` also writes sheets: a PDF page the
  size of the paper, the decoded page image white in the gutters and below
  the labels, a 3:2 photo filling the width of its 4:3 box and centered, dark
  pixels in each label strip and none beyond its cell, 16 bits tagged when a
  profile is chosen, one PDF page per sheet page, and bad requests refused.
- `node --test verify/print.test.mjs`: `layout()`, `cellsLayout()`, and the app's `Session`
  redrawing after `applyProof` and back to the same frame, and a PDF through
  `print_photo` as the panel requests it.
- GUI case `print` (`verify/gui/specs/workflows.mjs`): soft proof and
  gamut warning on the photo, the badge, S, the proof kept in Adjustments,
  and the layout controls, with a made-up profile `run.mjs` puts in the run
  profile (`verify/gui/support/icc.mjs`). It checks the page in the viewer:
  orientation, the photo inside the printable area, at the top left once
  placed there, and the page gone in Adjustments. It then selects several
  photos and checks the Cells sheet: a filename under each photo, names off
  and on, a custom cell count, and back to Single Photo. The case never clicks
  Save PDF or Print, since the save dialog is native and outside the app-only
  boundary (a known gap; the PDF is checked by `verify/print.py`). The `rail`
  case opens Print.
- Not automated: printing on a real printer (CUPS, the Windows spooler,
  TurboPrint), the native save dialog, and that the driver leaves the
  colors alone. Check those by hand with a printer and its profile.

# Print and soft proofing

The Print panel ([PrintPanel.tsx](../../src/PrintPanel.tsx)) is Lightroom's
Print module on darktable's: colorout's soft proof, and the print view's
export, printer profile conversion, PDF writer and CUPS or Windows spooler.
darktable runs the print job only from its GTK library module
(`src/libs/print_settings.c`), so [engine/print.c](../../../engine/print.c)
does what that module's job does, without its screen layout, and with no
change to darktable's source.

## Pieces

| Where | What |
|---|---|
| [print.ts](../../src/print.ts) | `PrintSettings` (stored in `localStorage` as `immage.print`), PDF papers (PWG names), `layout()` (page orientation, margins, Fill or a long edge, nine places, borderless against the hardware margins, which turn with the page as `dt_get_print_layout` turns them), `printRequest()`, `applyProof()`. |
| [PrintPanel.tsx](../../src/PrintPanel.tsx) | The panel: Soft Proofing, Printer, Layout (a to-scale SVG page with the navigator thumbnail, its nine place dots), Color Management, Print / Save PDF. |
| App.tsx | `RightMode` `"print"`, the rail button after Export, ⌘P, S (`toggleProofRef`), the `proof` state, `changeProof()` and the `Soft Proof:` badge over the photo; the effects that read printers and profiles when the panel opens and the chosen printer's papers; `printNow()`. |
| `Session.redraw()` | After the engine's view changes with no edit: drops the frames kept by view and the zoom copy (`changed()`), and renders. |
| main.rs | `print_profiles`, `print_profile_add`, `softproof`, `printers`, `printer_info`, and `print_photo` (`export_hold`, a tagged `print` on the export thread, `export_release`, as `export_images` does). |
| [engine/print.c](../../../engine/print.c) | Profiles, the soft proof, printers and the print job. |
| main.c | The commands (`print`, `print_profiles`, `print_profile_add`, `printers`, `printer`, `softproof`); a tagged `print` goes to the export pool (`_export_run`) and renders the job's snapshot (`_hold_take`). |

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
- `node --test verify/print.test.mjs`: `layout()`, and the app's `Session`
  redrawing after `applyProof` and back to the same frame, and a PDF through
  `print_photo` as the panel requests it.
- GUI case `print` (`verify/gui/specs/workflows.mjs`): soft proof and
  gamut warning on the photo, the badge, S, the proof kept in Adjustments,
  and the layout controls, with a made-up profile `run.mjs` puts in the run
  profile (`verify/gui/support/icc.mjs`). The `rail` case opens Print.
- Not automated: printing on a real printer (CUPS, the Windows spooler,
  TurboPrint), the native save dialog, and that the driver leaves the
  colors alone. Check those by hand with a printer and its profile.

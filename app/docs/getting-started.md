# Getting started

Immage is a photo editor that works the way mainstream raw editors do:
the familiar panels and slider names, in the usual order. Under it
runs darktable's raw processing, so every edit is one of darktable's own
modules, and your edits are saved beside each photo where darktable can
read them too.

This page takes you from first launch to an exported photo in about five
minutes.

## If you've used another editor

| Elsewhere | In Immage |
| --- | --- |
| Catalog | No catalog: you open folders directly, and edits live in an XMP sidecar beside each photo. Immich can be your library. |
| Import dialog | **Import** (⇧⌘I), the same idea: copy off a card, skip duplicates, verify every copy. See [Import](import.md). |
| Library module | The **Library** panel on the left, the filmstrip and **Grid** view (G). See [Library](library.md). |
| Develop module | **Adjustments** on the right: Basic, Tone Curve, HSL / Color, Color Grading, Detail, Lens Corrections, Transform and Effects. See [Adjustments](adjustments.md). |
| Masking | **Masks**, including AI Subject, Sky, Background, People and Select Object. See [Masks](masks.md). |
| Spot Removal | **Heal** (Q). See [Heal and clone](heal.md). |
| Presets and Profiles | **Presets**, with live previews, plus 53 film looks. See [Presets and looks](presets-and-looks.md). |
| Export | **Export** (⇧⌘E), to a folder or straight into an Immich album. See [Export](export.md). |
| Edit In | Right-click › **Edit In**, for DxO PureRAW. See [Edit In](edit-in.md). |

Most keyboard shortcuts are the familiar ones: G for grid, R for crop, W for the
white balance picker, \ for before, Y for before / after, X to reject,
0-5 to rate. The full list is in [Keyboard shortcuts](shortcuts.md).

## First launch

A small splash shows while the editing engine starts. The first time,
Immage also:

- adds a **Sample Photos** folder with one photo in it, and opens that
  photo, so there is something to try the tools on
- starts the **quick start guide**, a ten-step tour of the window. Press
  → to step through it, or Esc to skip. Tick **Don't show on startup** to
  keep it from coming back; the **?** button at the bottom of the rail
  starts it again.

![The Immage window on first launch, with the sample photo open](images/first-launch.png)
<!-- screenshot: first launch, sample photo open, tour closed, both side panels showing -->

## The five-minute tour

1. **Add a folder.** In the **Library** panel on the left, open the
   **Folders** card and click **+ Add folder…**. Choose a folder of
   photos. It opens in **Grid** view.
2. **Pick a photo.** Double-click one in the grid. It opens in the viewer,
   with the rest of the folder in the filmstrip below. The arrow keys step
   through them; 1-5 rate the open photo and X rejects it.
3. **Edit.** The **Adjustments** panel is on the right. Start with
   **Basic**: try **Auto**, then move **Exposure**, **Highlights** and
   **Shadows**. Double-click a slider to reset it. Click the photo to look
   at 100%, and click again to fit.
4. **Compare.** Press \ to see the photo before your edits, and \ again to
   come back. Y steps through side by side and split views.
5. **Export.** Press ⇧⌘E. Choose **Full Size JPEG** or **Web 2048** on the
   left, pick a folder under **Destination**, and click **Export**.

You never save. Every change is written to the photo's sidecar a moment
after you make it, and ⌘Z undoes it.

## Where your edits go

Each photo you edit gets a small file beside it, named like the photo with
`.xmp` added, for example `P9302114.ORF.xmp`. It holds the whole edit,
plus your rating, labels, title, caption and keywords. darktable opens the
same file and renders the photo the same way, so you can always finish an
edit there.

Immage never changes the photo file itself.

## What new photos start with

The first time a photo opens, before you touch it, Immage gives it a
starting point, most of it set in **Preferences › New Photos**:

- the **AgX** tone mapper
- the **AgX Default** profile
- the **Default** preset: lens corrections

Photos that already have an edit, from Immage or darktable, keep their own.
See [Preferences](preferences.md).

## Next

- [The workspace](workspace.md): the parts of the window, zooming, before
  and after
- [Library](library.md): folders, rating, filtering
- [Adjustments](adjustments.md): every panel and slider
- [Immich](immich.md): connect your server

# Library

Immage has no catalog. You add folders, browse them in the filmstrip or the
grid, and rate, label and keyword photos there. Everything you set is
written to the photo's XMP sidecar, so it travels with the photo and
darktable sees it too.

**If you've used another editor:** think of it as a folders panel without
the import step. Adding a folder never copies or moves anything. Collections
and smart collections don't exist; [Immich](immich.md) can do that job.

The grid and filmstrip list photo formats only, including while a folder is
loading. Non-photo files such as `.ACR` and XMP sidecars, documents and videos
do not get placeholder cells. The scan checks whether each photo can be read.

## Folders

Open the **Folders** card in the **Library** panel.

- **+ Add folder…** adds a folder to the list and opens it in Grid view.
  Dragging a folder from Finder or Explorer onto Immage's window does the
  same.
- Click a folder in the tree to open it. The arrow beside it shows its
  subfolders.
- Right-click a folder for **New Folder…**, **Show in Finder** (Explorer
  on Windows, the file manager on Linux) and **Remove from List**.
  **New Folder…** opens the folder and adds a row at the top of its
  subfolders with the name selected: type a name and press Enter, or press
  Esc to cancel. The folder is made on disk, and an existing name is
  refused. You can then drag photos onto it.
- Hover a folder and click **×** to take it off the list, whether it is
  one you added or a subfolder inside one. A subfolder taken off the list
  is left out of **Include subfolders** too. Its files stay where they
  are; adding or dragging the folder in again brings it back.
- **Include subfolders** shows the photos in a folder's subfolders too.
  It is off unless you
  turn it on.
- The refresh button reads the folders, and the open folder's photos,
  again: use it after adding files from outside Immage.
- The **×** beside a top-level folder takes it off the list. Nothing is
  deleted.
- When the open photo is in a folder you aren't browsing, that folder is
  marked with a dot.
- When your folders are on more than one drive, each drive is a heading
  over its folders, so two folders with the same name (a 2026 on your
  computer and a 2026 on a NAS) are told apart. A network share shows a
  network icon and its server's name, or its address when the share was
  connected by address; double-click the name or address to give it a
  name of your own, and clear it to go back. Click a heading to fold it. A
  folder on a share that isn't connected stays under its share, dimmed.
- A folder on a slow share fills in gradually. Opening another folder, or a
  photo from your own drive, doesn't wait for it: the share's reading stops
  after the file it is on.
- A share that stops answering mid-folder doesn't freeze Immage. A file that
  doesn't answer within 5 seconds is skipped, with the rest of that folder for
  30 seconds, so photos on your own drive still open. Open the folder again
  once the share is back to read the skipped files.
- Editing comes first. While you zoom or adjust an open photo, the folder's
  reading and thumbnails slow down and catch up when you pause.

Folders you import into join the list by themselves. The list, the open
folder and the last photo are remembered when you quit.
On startup, the grid appears while the folder is read. If you left a photo
open, Immage switches to it when its first preview is ready. If the photo is
missing or cannot load, the grid stays available so you can choose another.
If the last folder is unavailable, Immage tries your other recent folders.

![The Folders card with one folder added and Include subfolders off](images/library-folders.png)
<!-- screenshot: Library panel, Folders card open, Include subfolders off, one folder added -->

### Cached folder metadata

Immage keeps a disposable local metadata cache, separate from darktable’s
in-memory editing library. Reopening an unchanged folder reuses its ratings,
labels, keywords and camera metadata. Each original and virtual copy keeps
its own editing state. Changed files, sidecars, raster-mask data or copy lists
are read again. An unavailable drive is not treated as an empty folder.

Cached photos enter the editing library when an action needs them: opening,
rendering a missing thumbnail, changing metadata, exporting or managing files.
Existing disk thumbnails can appear without that import. The editing engine
still starts normally; edits and sidecars are read before the action runs.
Verified moves keep cached identities and reusable analysis when source and
sidecar fingerprints still match. Copies receive separate identities, including
when Keep Both changes the filename. Metadata and saved-edit changes invalidate
stale cached results; deleting an original removes its copies from the cache.
At startup, a bounded background scan discovers files and checks existing
records without importing photos into the editor. Metadata for newly discovered
files is filled when they are read. Offline drives, disconnected nested mounts,
excluded folders and incomplete scans keep their cached records. When a drive’s
identity is unknown, browse the folder before missing records can be removed.

A cache failure falls back to reading the folder normally. The cache contains
no originals or authoritative edits and can be rebuilt from your photos.
Metadata caching does not download search models or upload photos; any optional
local analysis model requires an explicit download choice. Downloaded analysis
packages are checked before use, and local analysis runs on the CPU.
**Preferences > Performance > Local photo cache** shows cache and drive status,
pauses background checks, clears or rebuilds cached records, and offers the
optional model download and CPU model check. Clearing preserves model files;
rebuilds wait while background work is paused.

Local search uses only cached metadata and current model-versioned analysis.
Selected filters exclude unknown values; capture-date filters do not substitute
file modification dates. Similarity queries exclude the source photo and its
virtual copies. A changed cache requires restarting paginated local results.

### Thumbnail previews

The grid and filmstrip support embedded JPEG and TIFF previews, including
TIFF previews inside DNG photos. If an unedited photo cannot be decoded,
Immage tries a smaller embedded preview before leaving its thumbnail blank.
This fallback can look softer and does not enable editing an unsupported RAW
encoding. Edited photos require a thumbnail that includes their edits.

### ORF metadata reads and library workers

Olympus and OM System ORF photos use partial metadata reads while **Reading
photos** runs. Immage tries the first 64 KB, then larger prefixes up to 16 MB
if needed. If it cannot establish complete metadata, it reads the whole file.
Embedded previews can be read separately from their original locations.
Opening a photo for editing still needs its image data. Panasonic RW2 is not
included.

**Preferences > Performance > Memory > Library workers** controls how many
library thumbnails are built at once, how many ORF metadata tasks are
prepared at once and how many photos are moved or copied at once. These
limits are separate, so the setting is not a shared total. It defaults to 2.
A change applies to subsequent import batches and new move or copy jobs.
Metadata results are applied in file order, with
metadata, sidecars and database updates kept serial. The metadata task queue
is bounded by this setting; the Exiv2 parser lock remains in place. Other
formats continue through the existing serial import path.

For headless comparisons, `IMMAGE_METADATA_PREFIX=0` disables prefix reads;
otherwise they are enabled. `IMMAGE_METADATA_IO_DIAGNOSTICS=1` records
per-file read counts and bytes in `engine.log`. These count bytes returned by
the metadata reader's source reads, including repeated reads; they are not
measurements of network traffic or storage cache misses. These environment
variables are diagnostic/benchmark overrides and do not change Preferences or
write to the original photo.

The headless [ORF comparison runner](../../benchmarking/README.md#orf-partial-metadata-reads)
uses those settings automatically, checks that imported photo entries match,
and saves labeled A/B measurements. Use `--recursive` for a year folder with
month subfolders. Run a warm-up pair first, then an even number of measured
pairs on the same folder. Cache state affects elapsed time; source byte counts
show how much the metadata reader requests in either case.

### Experimental prefix and probe concurrency comparison

The combined branch keeps ORF prefix reads enabled and compares
`IMMAGE_IMPORT_READ_AHEAD=1`, `2`, `3`, and `4`. This limits concurrent small
file-access probes (the first 4 KB of each photo and its XMP sidecar), not
concurrent metadata imports. Metadata reads and database updates remain
serialized. With the variable unset, the limit remains 1; there is no new
Preferences setting. The engine accepts experimental limits up to 8.

The cap includes reads still blocked after a timeout or cancellation. If all
slots remain blocked, subsequent files can be reported unanswered until slots
recover. Cancellation stops scheduling additional probes. This remains an
experiment for a responsive NAS, rather than a release default.

The [combined benchmark](../../benchmarking/README.md) runs isolated headless
engines, verifies the requested limits and matching imported entries, and
reports elapsed time, photos per second and metadata source bytes. Use the same
month for each limit, warm it first, then measure four rounds to balance order.
`IMMAGE_IMPORT_DIAGNOSTICS=1` records the cap, observed active probes, timeouts,
probe waiting and serialized import time in the engine log.

### Headless worker benchmark controls

`IMMAGE_IMPORT_METADATA_WORKERS` overrides **Library workers** for headless
benchmarks and diagnostics when set to 1–8. Set it to `0` to disable the
metadata preparation pipeline; an unset or invalid value uses the Preferences
setting. The outstanding task/result count is bounded by the worker setting,
including abandoned reads after a timeout or cancellation. A prepared result
can retain a full file when prefix fallback is needed, so memory use depends
on the source files. Cancellation
stops scheduling work; blocked filesystem reads are not forcibly interrupted.
Tasks have a 30-second deadline, including their photo and XMP access probes;
timed-out files are reported unanswered. `IMMAGE_IMPORT_METADATA_TIMEOUT_MS`
accepts 10–300000 milliseconds for headless diagnostics.

The [metadata pipeline benchmark](../../benchmarking/README.md) enables prefix
reads, fixes small-probe concurrency at 1, and defaults to testing 1–4
metadata workers.
Use `--workers 4 6 8 --runs 6` to compare higher counts in balanced order.
It checks that prepared results were used and that imported entries match.
Run it after the probe-only comparison to measure these two approaches
separately. It reads original photos and sidecars without modifying them.

## Moving and copying photos

Drag a thumbnail from the grid or the filmstrip onto a folder in the
**Folders** card to move the photo there, for example from your computer to
a NAS. When the photo is part of a selection, the whole selection goes,
and a RAW+JPEG pair goes together. The folder under the pointer is
outlined. Rest on a closed folder for a moment and it opens, so you can
drop into one of its subfolders; this works on the photos' own folder too.
Press Esc to stop dragging. The photos' own folder, and a folder on a share
that isn't connected, don't take a drop.

Hold ⌥ (Alt) as you drop to copy instead, keeping the originals where they
are. You can also choose this in the confirmation.

Nothing happens until you confirm. The confirmation shows the following:

- **The photos.** How many photos go, how much they add up to, and the
  folder they go to.
- **Virtual copies.** A photo with virtual copies takes every version with
  it, since they share its file.
- **Photos already there.** A photo already in the folder with identical
  content (checked by checksum) isn't copied again. A move just removes
  the original.
- **Same name, other content.** These photos are listed, each with
  **Skip** or **Keep both**. Keep both gives the incoming photo and its
  sidecars a number (IMG_1000.CR3 arrives as IMG_1000_1.CR3). **Skip all**
  and **Keep both for all** set the whole list.
- **Free space.** A warning appears, and the button is off, when the drive
  doesn't have room.

Each photo goes with its XMP sidecars, every version's, and its mask
sidecars, so its edits, ratings, labels and keywords arrive with it.

Several photos can transfer at once, up to **Preferences > Performance >
Memory > Library workers** (2 by default). Each photo's files stay together;
its sidecars are not separate transfer jobs. The limit is chosen when the job
starts, and also applies when copying originals from Immich. More workers
can help with a NAS or fast disk, but fewer may be quicker on a busy drive.

- **To another drive.** Each file is copied and flushed to the drive. It
  is then read back and checked against the original's checksum before it
  takes its name. A move removes the original only once every file of
  that photo has been verified. A photo whose copy fails or doesn't match
  stays where it was, with nothing left behind in the destination.
- **On the same drive.** A move renames the files, which is instant.

The work runs in the background, under the photo, with a progress bar and
**Stop**. Stopping asks active transfers to stop and leaves queued photos
untouched. Photos already completed stay in the destination. A file operation
already accepted by a drive may finish before it stops. Photos that
are moved disappear from the folder at once.
If any stay behind, the folder is read again to show them. When it's done,
**Show** opens the destination folder.

A transfer that stops answering for 30 seconds ends the job and stops new
transfers. Activity on another photo does not hide a stalled transfer.
Blocked transfers continue to count against the worker cap until they return.

## The filmstrip and the grid

The filmstrip under the photo shows the open folder, in the order the
photos were taken. Photos taken at the same moment, such as a raw and its
virtual copies, follow by file name. A photo whose camera recorded no
capture time, as one with a flat clock battery, is placed by the date its
file was last changed; photos with neither come last. Each thumbnail shows
the file name and type (**ARW**, **JPG**, ...), and a small sliders mark
beside the type once the photo is edited. Hover over it to see its rating,
labels and reject button. Once a photo is rated or rejected, those show all
the time.

Thumbnails load in the background and prioritize the photos currently visible
in the grid or filmstrip. Scrolling changes that priority; renders already
running finish before the newly visible photos use their slots.

A photo counts as edited once you change something yourself. What Immage
gives a photo the first time it opens (the **New Photos** settings in
[Preferences](preferences.md)) doesn't count, and undoing every change
makes it unedited again. darktable uses the same rule, and the sidecar
carries it, so its lighttable shows the same photos as altered. Photos
opened in Immage before version 0.23.2 count their New Photos settings as
an edit until you reset them.

Press G, or **Grid** in the toolbar under the filmstrip, for **Grid** view:
the whole folder at once.
Double-click a photo to open it and go back to the filmstrip. G or Esc also
goes back. The **Grid** button is highlighted while the grid shows.

The grid hides the right-hand panel, as its tools work on the open photo,
which the grid covers. Choosing a tool in the rail on the right, such as
Adjustments or Masks, leaves the grid for the open photo. Print stays beside
the grid, so you can pick the photos for a sheet.

In the grid, the zoom slider at the bottom sets the thumbnails' size, from
smallest at the left to largest at the right; its label is the size against
the default, and a double-click goes back to the default. Pinch on a trackpad,
or scroll with ⌘ held, over the grid to resize them smoothly; the photo under
the pointer stays where it is. ⌘= and ⌘- make them larger or smaller in an
eased step while the grid shows (in the editor they zoom the photo). The size
is remembered.

Drag the top edge of the filmstrip to make it taller or shorter.

![Grid view with ratings and labels showing](images/library-grid.png)
<!-- screenshot: Grid view of a folder, some photos rated, one rejected, one with a label -->

## Selecting photos

- Click a photo to open it.
- ⌘-click adds a photo to the selection, or takes it out, without opening
  it.
- ⇧-click selects the run from the photo you clicked last (else the open one) to the one you click.
- ⌘A selects every photo the filters leave showing.
- ← and → step through the photos.

Ratings, labels, rejecting, exporting, virtual copies and Edit In all act
on the whole selection.

## Rating, rejecting and labels

| Key | Action |
| --- | --- |
| 1-5 | rate; 0 clears the rating |
| X | reject, or un-reject |
| 6, 7, 8, 9 | red, yellow, green or blue label (purple has no key) |

You can also click the stars and the **✕** on a thumbnail, or use the
**Metadata** card. Rating a photo un-rejects it.

You can rate, reject and label photos as soon as their controls appear, while
the folder and thumbnails continue loading. Your changes stay in place as
more photos arrive and loading finishes.

## Filtering

The toolbar under the filmstrip filters the folder:

- **Stars**: show photos with that rating and up. Click it again to turn it
  off.
- **Reject**: click once to hide rejected photos, again to show only them,
  and again to show everything.
- **Edited** (the sliders button): click once to show only edited photos,
  again to show only unedited ones, and again to show everything.
- **Color labels**: show photos with any of the chosen labels; the gray
  swatch shows photos without a label.
- **Filters**: opens a list of what else the folder can be narrowed by,
  with a panel beside it showing the options of the one chosen. Choose
  as many as you like, then click **Search** to filter the folder and show
  it in the grid; **Clear** in the panel takes that one off, at the next
  **Search**.
  - **Rejected**: **All photos**, **Hide rejected** or **Only rejected**.
    This counts as an active filter and resets with **Clear all**.
  - **File type**, **Camera** and **Lens**: tick any to show photos of
    those, for example **RAW** and **JPEG**. Each lists what the folder
    holds, with how many photos of each.
  - **Camera body**: distinguish physical bodies of the same model by their
    full serial numbers, even when you swap lenses. Entries show the camera
    model, serial and photo count. Tick multiple bodies to include any of them;
    combine with Camera, Lens or other filters to narrow the results. Long
    lists can be searched by model or serial. **Serial not recorded** selects
    photos without a usable body serial; those cannot be assigned reliably to
    a particular body. Serials come from the original file's supported metadata,
    including recognized camera maker notes; lens serials are never used.
    Changes apply with **Search**, and reset with **Clear** or **Clear all**.
    This filter is available for folders, not Immich server searches.
  - **Keywords**: tick one or more to show photos with all of them. A
    keyword includes those under it, so **Places** shows photos tagged
    **Places › Norway** too.
  - **Captured**: photos taken between two dates. Type them, or pick a
    recent span (**Last 30 days**, **This month**, **Last year** and
    others), a year, or a month of the year picked. A photo with no
    capture time goes by its file's date here too.
  - **Exposure**: ISO, aperture, focal length and shutter speed. Choose
    one to list the values the folder holds, and tick any, for example
    ISO 100 and 200.

  Each list counts only the photos your other choices leave: tick a
  camera, and **Lens** lists just the lenses used on it. The list shows
  what each is set to, and the button how many are on. **Clear all**, at
  the bottom of the panel, takes them all off when you click **Search**.
- **Clear**: show every photo again.

Opening another folder clears the filters.

## RAW+JPEG pairs

Turn on **Stack RAW+JPEG pairs as one photo** in **Preferences › General**
to show a raw and the JPEG, HEIF or OM System .ORI of the same name as a
single photo. Its thumbnail reads, for example, **ARW+JPG**. A rating,
reject or delete takes them all.

## Virtual copies

A virtual copy is a second edit of the same photo. Press
⌘', or right-click and choose **Create Virtual Copy**. The copy starts from
the photo's edit as it is, is listed after the original with a folded
corner, and opens. Each copy has its own sidecar.

To remove one, right-click it and choose **Remove Virtual Copy**. Its
sidecar goes to the Trash; the photo file stays.

## Generated photos

Generated photos open for editing automatically, including HDR and panorama
merges. Turn off **Open generated photos** in Preferences › General › Workspace
to stay on your current photo and use the completion notification's **Open**.
Successful notifications close after 30 seconds, or when Open or OK is selected.

## HDR Merge

HDR Merge combines bracketed raws, the same scene at different
exposures, into one photo with the range of them all, using darktable's
HDR merge. Select the brackets in the filmstrip or grid, then press ⌃H
or right-click and choose **HDR Merge…**. Turn on **Auto Align** for
brackets shot handheld, so that they line up before they merge; brackets
from a tripod don't need it. Click **Merge**.

Immage writes a new DNG beside the first bracket, named
`<name>-hdr.dng` (then `<name>-hdr_01.dng` and so on). It is merged in
the background while you go on editing, and **Open** at the bottom left
of the photo opens it. The DNG holds the raw data, not a finished
picture: it opens with the new-photo defaults and is edited like any
raw, with Exposure, Highlights and Shadows bringing the range in. The
brackets themselves aren't changed.

HDR DNGs preserve their format identification, color calibration and sensor
pattern when copying the brackets' EXIF, and retain the camera's orientation
so portrait and rotated brackets open upright in darktable and other photo
applications.
Regenerate an older merge if it shows a **?** thumbnail and cannot open.

The brackets must be raws from the same camera, of the same size and
orientation. Anything that moves between them, such as people or
leaves, shows as a ghost: Auto Align lines up the camera's movement,
not the subject's.

## Panorama Merge

Panorama Merge and its projection preview are supported on Windows, macOS and
Linux. Official Windows builds include the OpenCV stitching support needed for
both preview and merge. If the dialog says this build cannot stitch panoramas, its engine lacks
stitching support; install a build that includes it.

Panorama Merge stitches overlapping RAW or non-RAW photos, including mixed
selections, into one wide photo. Select the
photos in the filmstrip or grid, then press ⌃M or right-click and choose
**Panorama Merge…**. A preview of your selected photos appears above the
projection choices. Choose a projection to compare its effect:

- **Auto** picks one from how wide the panorama is
- **Spherical** suits very wide panoramas, and those of several rows
- **Cylindrical** suits wide panoramas, and keeps vertical lines straight
- **Perspective** keeps straight lines straight, for architecture, up to
  about 100° across

With **Auto**, the label below the preview shows the projection chosen.
**Auto Crop** cuts away the empty edges the photos leave; toggle it to compare
the crop immediately. With it off, empty edges appear as a checkerboard.

The preview takes a moment to build and updates when you change projection.
Previously viewed projections are kept while the panel is open. It shows
geometry at reduced resolution; final detail, alignment and color may differ.
If some photos do not overlap, the panel shows how many the preview uses.
If the preview fails, try **Retry** or another projection. You can still click
**Merge** to attempt the full-resolution stitch. Closing the panel cancels
preview work. Previewing does not create a file or change your source photos.

Click **Merge** when you are happy with the projection and crop.

Immage writes a new DNG beside the first photo, named `<name>-pano.dng`
(then `<name>-pano_01.dng` and so on), and lists it after that photo. It
is stitched in the background while you go on editing, and **Open** at
the bottom left of the photo opens it. The DNG holds
linear image data with lens corrections already made. An all-RAW selection
opens with the new-photo defaults, white balance as shot and Lens Corrections
off. A selection containing non-RAW photos uses a common linear color space
and a neutral starting edit. The DNG is edited as one photo. The other edits
of the photos you merged aren't used, and the photos themselves aren't
changed.

Panorama DNGs can also be opened in darktable. RAW merges preserve the DNG's
format identification, camera color matrix and white balance when copying
the source photo's EXIF. If an older RAW merge shows a **?** thumbnail and
cannot open, merge the original photos again with the updated version.

The photos should overlap by a third or so. A photo that overlaps none of
the others is left out, and the activity line says so. Stitching runs on OpenCV rather than darktable,
which has no panorama tool. It takes from half a minute to a few
minutes, and a lot of memory for many photos.

## Deleting rejected photos

Immage only deletes photos you have rejected. Reject them with X, select
them (or show only rejected photos and press ⌘A), then right-click and
choose **Delete Rejected Photo…** (with several, **Delete 3 Rejected
Photos…**). They move to the Trash with their sidecars, after you
confirm. Thumbnails disappear immediately while the files move in the
background. If deletion fails, an error appears and the folder refreshes to
show any files still present.

## The right-click menu

Right-click a photo, or a selection, for:

- **Edit In ›**: send it to another application. See [Edit In](edit-in.md).
- **Create Virtual Copy** / **Remove Virtual Copy**
- **HDR Merge…**, for two raws or more
- **Panorama Merge…**, for two photos or more
- **Adjust Capture Time…** / **Undo Capture Time Adjustment…**
- **Show in Finder**
- **Import Parent Folder**, for an Immich result when Immich is configured in
  Preferences: add its locally mapped parent to Folders and browse its photos.
  Disabled when no local file is available. See [Immich](immich.md).
- **Show in Immich**, for a photo from an Immich search
- **Delete Rejected Photo…**

## Metadata

The **Metadata** card shows the open photo's:

- **File Name** and **Folder**
- **Title**, **Caption**, **Copyright** and **Creator**, which you can edit:
  type, then press Enter or click away. Esc puts back what was there.
- the rating and color label
- what the camera recorded: capture date, dimensions, focal length,
  aperture, shutter speed, ISO, exposure bias, flash, lens, camera and more

### Adjust capture time

Select photos, then choose **Adjust Capture Time…** in the context menu or
Metadata panel. Enter the correct time for the reference photo. The dialog
previews the offset and number of photos; confirm to shift them all by the
same amount, preserving relative timing. Photos without a valid recorded
time are skipped. Changes go to XMP sidecars; original files stay unchanged.
The context menu can undo the last batch after confirmation.

### Location

The Metadata panel's Location section accepts latitude and longitude in decimal
degrees (latitude first). **Show map** opens a compact map beside the location
controls. Choose **Expand** to cover the photo area; use the mouse wheel to
zoom, drag the map to pan, or place and drag the pin. Choose **Collapse** to
return to the compact map. Choose **Apply** in either view to save the pin's
coordinates to the photo's XMP sidecar. Moving a location clears the old altitude.
**Remove location** clears GPS coordinates
and altitude in Immage without changing the original photo. An Immage XMP marker
keeps removed camera GPS from returning on reopen; other photo software may
still show GPS embedded in the original.

Preferences and other dialogs open above the expanded map. Close a dialog
before using Escape to collapse the map.

Place-name search is optional and requires a Geoapify API key saved in
[Preferences › General › Map search](preferences.md#general). Search results
move the map to the matching place; they do not set the photo coordinates. Set
the pin and choose **Apply** to save a location. Map tiles and manual pin
placement need an internet connection but no search key. Coordinate editing
works offline.

## Keywords

The **Keywording** card lists the open photo's keywords; click **×** on one
to remove it. To add some, type them separated by commas and press Enter.
Type a hierarchy as `Places > Paris`. Suggestions come from the keywords you
have used before, and **Recent keywords** holds the last few: click one to
add it or take it off.

## Opening a photo or folder from another program

Another application, or a terminal, can hand Immage a photo or a folder:

```sh
open -a Immage /path/to/photo.arw     # macOS
/path/to/Immage.AppImage /path/to/photo.arw     # Linux
/path/to/Immage.AppImage /path/to/folder
```

For a photo, Immage adds its folder to the library, shows the folder and
opens the photo. For a folder, Immage adds it to the library and shows it
as a grid; the photos stay where they are, nothing is copied. Dragging a
photo or folder from Finder or Explorer onto Immage's window does the same,
and so should dropping it on Immage's Dock icon. Only the first path is
used. A program that sends photos with **Open With**, such as digiKam,
works the same way: choose **Other Application** and give it the path to
Immage.
<!-- check: dropping a file on the Dock icon, and whether Immage appears in Finder's Open With menu -->


### Grid culling shortcuts

Press **K** in the grid to keyword selected photos, or the photo under the
pointer when nothing is selected. Shared keywords can be removed from every
target; new keywords are added to every target. Close the dialog before moving
to another selection.

Press **F** over a photo to show a floating preview over the dimmed library,
in a fixed frame covering 80% of the window width and height, without opening it in the
editor. The frame and toolbar stay in place as you browse, zoom, and wait for
more preview detail. Click the dimmed area to close it. Otherwise the first
selected visible photo is used. Subtle triangle buttons outside the preview and the left and right
arrow keys browse the filtered grid; F or Escape returns. Number keys 0–5 set a
rating, X toggles rejection, 6–9 toggle color labels, and K keywords the displayed photo.
The grid selection is preserved. The lightbox bottom bar has the same star icons
and color swatches as the main grid bar. Click a star to rate (click the same
star again to clear), or click a swatch to toggle that color label. Rating
clears rejection, as it does elsewhere in the app. Purple is available by click.

Unedited RAW previews use the embedded camera preview; edited photos use the
processed thumbnail pipeline. An uncached edited preview can take time to
render. Single-click the photo to toggle Fit and **100%** detail, with the same zoom
animation as the editor. Zoom centers on the clicked point. Hold **Space** and
drag to pan at 100%; releasing a Space-drag does not toggle zoom. The **100% /
Fit** button also switches views. Embedded detail is limited to the camera preview's
native resolution. Double-click opens the displayed photo in the editor.
The existing grid thumbnail appears immediately at Fit size while a larger preview loads,
so sharper pixels do not make the photo grow. Nearby screen previews stay in memory
while the lightbox is open and appear immediately when revisited.
After navigation settles briefly, screen-sized previews are prepared one at a time
in the background using
Preferences’ **Read ahead** count, in the last arrow-navigation direction.
Enable **Read ahead both ways** to prepare the same count in the opposite direction.
Setting Read ahead to zero disables both directions;
native detail loads only when requested. Cached previews are reused until the
photo or its sidecars change. This prepares previews, not decoded RAWs for the editor.
More read-ahead can increase disk and rendering work; an already running native
preview must finish before another uncached preview can load. Fit scales the image
to the available viewport; 100% uses image pixels at screen scale and can be panned
inside the same frame. Keywording is also available from the grid photo's
context menu. With a multi-selection, right-clicking a selected photo keeps the
selection as the keyword target; right-clicking an unselected photo targets only
that photo and leaves the selection intact.

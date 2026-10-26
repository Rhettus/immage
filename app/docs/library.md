# Library

Immage has no catalog. You add folders, browse them in the filmstrip or the
grid, and rate, label and keyword photos there. Everything you set is
written to the photo's XMP sidecar, so it travels with the photo and
darktable sees it too.

**If you've used another editor:** think of it as a folders panel without
the import step. Adding a folder never copies or moves anything. Collections
and smart collections don't exist; [Immich](immich.md) can do that job.

## Folders

Open the **Folders** card in the **Library** panel.

- **+ Add folder…** adds a folder to the list and opens it in Grid view.
  Dragging a folder from Finder or Explorer onto Immage's window does the
  same.
- Click a folder in the tree to open it. The arrow beside it shows its
  subfolders.
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
  network icon and its server's name. Click a heading to fold it. A
  folder on a share that isn't connected stays under its share, dimmed.

Folders you import into join the list by themselves. The list, the open
folder and the last photo are remembered when you quit.

![The Folders card with a few folders, one expanded](images/library-folders.png)
<!-- screenshot: Library panel, Folders card open, Include subfolders off, one folder expanded -->

## The filmstrip and the grid

The filmstrip under the photo shows the open folder, in the order the
photos were taken. Photos taken at the same moment, such as a raw and its
virtual copies, follow by file name, and photos without a capture time
come last. Each thumbnail shows
the file name and type (**ARW**, **JPG**, ...), and a small sliders mark
beside the type once the photo is edited. Hover over it to see its rating,
labels and reject button. Once a photo is rated or rejected, those show all
the time.

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
goes back.

Drag the top edge of the filmstrip to make it taller or shorter.

![Grid view with ratings and labels showing](images/library-grid.png)
<!-- screenshot: Grid view of a folder, some photos rated, one rejected, one with a label -->

## Selecting photos

- Click a photo to open it.
- ⌘-click adds a photo to the selection, or takes it out, without opening
  it.
- ⇧-click selects the run from the open photo to the one you click.
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
  - **File type**, **Camera** and **Lens**: tick any to show photos of
    those, for example **RAW** and **JPEG**. Each lists what the folder
    holds, with how many photos of each.
  - **Keywords**: tick one or more to show photos with all of them. A
    keyword includes those under it, so **Places** shows photos tagged
    **Places › Norway** too.
  - **Captured**: photos taken between two dates. Type them, or pick a
    recent span (**Last 30 days**, **This month**, **Last year** and
    others), a year, or a month of the year picked.
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

## Deleting rejected photos

Immage only deletes photos you have rejected. Reject them with X, select
them (or show only rejected photos and press ⌘A), then right-click and
choose **Delete Rejected Photo…** (with several, **Delete 3 Rejected
Photos…**). They move to the Trash with their sidecars, after you
confirm.

## The right-click menu

Right-click a photo, or a selection, for:

- **Edit In ›**: send it to another application. See [Edit In](edit-in.md).
- **Create Virtual Copy** / **Remove Virtual Copy**
- **Show in Finder**
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

## Keywords

The **Keywording** card lists the open photo's keywords; click **×** on one
to remove it. To add some, type them separated by commas and press Enter.
Type a hierarchy as `Places > Paris`. Suggestions come from the keywords you
have used before, and **Recent keywords** holds the last few: click one to
add it or take it off.

## Opening a photo from another program

Another application, or Terminal, can hand Immage a photo:

```sh
open -a Immage /path/to/photo.arw
```

Immage shows the photo's folder and opens the photo. Dragging a photo from
Finder or Explorer onto Immage's window does the same, and so should
dropping it on Immage's Dock icon.
<!-- check: dropping a file on the Dock icon, and whether Immage appears in Finder's Open With menu -->

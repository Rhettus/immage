# Import

The importer copies photos off a card or a folder into your library,
verifies every copy, and marks the photos you already have, on disk or in
Immich. When it is done, the new photos open in Immage.

**If you've used another editor:** it is an import dialog that copies.
The card is never written to, nothing is ever overwritten, and every copy
is checked byte for byte before it counts.

Open it with **Import** at the top of the rail, or ⇧⌘I. It fills the
window; **Close** goes back to editing.

![The importer with a card selected and duplicates grayed out](images/import-grid.png)
<!-- screenshot: Import with an SD card source, some tiles "In library", destination template visible -->

## 1. Choose a source

- Click a card to import its DCIM folder, or use **▸** to pick one folder
  on it.
- **Choose folder…** imports from any folder.
- **Include subfolders**, **Skip _Rejected folders** and **Include videos**
  narrow what is shown. If you cull in FastRawViewer first, pick its
  `_Selected` folder.

The grid fills in seconds, using the previews the camera stored. A raw and
its JPEG show as one tile.

## 2. Choose what to import

New photos are selected for you. Photos already in your library are grayed
out and marked **In library**; with Immich set up, ones already on the
server are marked **In Immich**.

- Click or ⇧-click to select; ⌘A selects all and ⌘D none.
- Filter to **All**, **New** or **Duplicates**, or hide duplicates.
- Sort by capture time, file name or folder.

## 3. Choose where they go

- **Destination**: your library's top folder.
- The folder template sorts photos into dated folders. The default makes
  `2026/October`. Tokens include `{YYYY}`, `{MMMM}`, `{MM}`, `{DD}`,
  `{camera}` and `{original}`; a `/` makes a subfolder.
- A file name template can rename the files; a raw and its JPEG get the
  same name.
- **Paranoid verification** (on by default) reads the card a second time
  to check it.

Dates come from when the photo was taken. If two files would get the same
name, the second gets `_1`, and so on.

## 4. Import

Each file is copied, flushed to disk, read back and checked against the
card. A copy that fails is tried again. At the end, a summary shows how
many were **Imported**, **Already there**, **Skipped** and **Failed**.

Click **Show in Immage** to close the importer and open the first new
photo, in its folder. The destination joins your **Folders** list.

## Duplicates

A photo counts as already imported only when its contents match exactly.
The name and size are checked first, then the capture time, then a full
hash of the file.

With Immich set up (see [Immich](immich.md)), the importer also looks each
photo up on the server, by file name, size and capture time. An Immich
problem never stops an import.

## Notes

- The importer keeps its own record of what it has imported, apart from
  the standalone Immporter app if you have that too.
- Its Immich settings are the same ones as in **Preferences › Immich**.

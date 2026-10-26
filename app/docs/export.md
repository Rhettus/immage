# Export

Export writes finished photos to a folder, or uploads them into an Immich
album, with your choice of size, format, file names, borders and captions.

**If you've used another editor:** it is the usual export dialog with
presets on the left, plus a watermark and borders built in. Publishing to
a photo service is done by **Immich album**.

Open it with **Export** on the rail, or ⇧⌘E.

![The Export dialog: presets, sections and preview](images/export-dialog.png)
<!-- screenshot: Export dialog, Frame with EXIF preset chosen, Frame & Captions open, preview showing the white border and captions -->

The dialog has three columns: presets on the left, settings in the middle,
and a preview of the first photo on the right, which updates as you change
things. Each section folds to a one-line summary.

## Presets

- **Built-in**:
  - **Full Size JPEG**: quality 90, the original size
  - **Web 2048**: quality 85, 2048 px on the long edge, location removed
  - **Frame with EXIF**: 2048 px with a white border, wider at the bottom,
    and captions for the title, the date and the camera settings
  - **Fixed Ratio 4:5**: every photo, landscape or portrait, on a white
    1638 x 2048 canvas, as Instagram shows them, with a thin white edge
    around the photo; location removed
- **My Presets**: your own.
  - **+** saves the settings as they are now as a new preset.
  - **Save** keeps changes to the chosen preset; " (edited)" shows when it
    has some.
  - Double-click a preset to rename it; click its icon to choose another.
  - **Share** saves a preset as a file; **Import** reads one. Shared
    presets leave out your folder and album.

## Destination

**Save to**: **Folder** or **Immich album**.

For a folder:

- **Choose a folder…**
- **Inside a new folder**: puts the files in a subfolder, **Export** by
  default.
- **If a file exists**: **Ask me**, **Add a number**, **Replace it** or
  **Skip it**. **Ask me** offers **Use Unique Name**, **Overwrite**, **Skip**
  or **Cancel**, and can apply your answer to every clash.
- **Show in Finder when done**.

For Immich, choose an album, or **New album…**. A photo Immich already has
goes into the album without a second copy. See [Immich](immich.md).

## File Name

- **Same as original**
- **Custom name + number**: for example `Paris-001`, `Paris-002`
- **Built from photo info**: a pattern such as `{caption}-{datecaptured}`.
  **Insert photo info…** adds a field; **Date style** sets how dates look.

| Field | Gives |
| --- | --- |
| `{filename}` | the original name |
| `{title}`, `{caption}`, `{creator}`, `{copyright}` | from the Metadata card |
| `{datecaptured}`, `{timecaptured}` | when it was taken |
| `{year}`, `{month}`, `{day}` | parts of the date |
| `{camera}`, `{lens}`, `{iso}` | from the camera |
| `{rating}` | the star rating |
| `{seq}` | the photo's number in this export: 001, 002, … |

A date can take its own format: `{datecaptured:YYYY.MM}`. Characters a file
name can't hold become `_`. The example line shows what the first file will
be called.

## Format & Size

- **Format**: **JPEG**, **TIFF**, **PNG** or **WebP**.
- **Quality**: 10-100 (JPEG and WebP).
- **Bit depth**: 8 or 16 bit (TIFF and PNG).
- **Size**: **Original size**, **Fit long edge to…** a number of pixels,
  **Fixed canvas…**, or **AI upscale 2×** / **4×**.
- **Color space**: **sRGB**, **Adobe RGB (1998)**, **Display P3** or
  **ProPhoto RGB**.

**Fixed canvas** makes every file exactly the width and height you give,
filled with the canvas color. Each photo, with any frame from Frame &
Captions, is fitted inside and centered. **Turn for landscape photos**
swaps the width and height for landscape photos. A photo smaller than
the canvas is not enlarged; it sits in the middle at its own size.

AI upscale is offered only on a computer with a supported GPU. It makes a
20 MP photo 80 MP (2×) or 320 MP (4×), takes a few minutes for each photo,
and editing waits while it runs. Its model (55 MB) downloads the first
time.

## Frame & Captions

Three kinds of item, each added with its own **+** button. They fold to a
summary and can be moved up or down.

- **Frame**: space added around the photo; nothing is cropped. The same
  width all round, or each side on its own (a wider bottom, for a
  gallery look). Widths are in pixels or a percentage of the short or long
  side.
- **Keyline**: a thin line on the photo's edge, or inset from it.
- **Captions**: text from each photo's info, in the border or on the
  photo, at one of nine positions. Choose the font, size and color; **More**
  adds an offset, opacity and a backdrop box.

Captions use the same fields as file names, and more: shooting info
(mm · f · s · ISO), camera make, focal length, aperture, shutter speed,
exposure compensation and subject distance. If a photo lacks a piece of
info, text after a comma stands in: `{lens, unknown lens}`.

![A photo exported with Frame with EXIF](images/export-frame.png)
<!-- screenshot: an exported image (not the dialog) with the white frame and the three captions -->

## Keywords

Keywords typed here are added to every exported file, along with the
photo's own keywords, so a preset such as one for your website can mark
what it exports with `website`. Type them as in the **Keywording** card,
separated by commas, `Places > Paris` for a hierarchy; click **×** to take
one off. Presets keep them.

The originals are left alone unless you tick **Also add to the original
photos**: each photo exported then gets the keywords too, in Immage and
in its XMP sidecar.

## Metadata

What each exported file says about the photo. Each box adds its part to
the file; presets keep the boxes as they are.

- **Camera and lens**: the make, model, lens and exposure settings, and
  the camera's own notes.
- **Serial numbers and owner name**: the camera's, lens's and accessories'
  serial numbers, and an owner name set in the camera. Off by default, as
  they identify your gear (Flickr, for one, shows them to everyone).
- **Location (GPS)**: where the photo was taken.
- **Title, caption, creator, copyright**: the photo's text fields,
  including any another program wrote into the original.
- **Keywords**: the photo's keywords and those added above.
- **darktable edit history**: the edit itself, as darktable stores it.
  Off by default.

The date taken is always included.

## Which photos

At the bottom: **Current image**, **Selected (N)** when several are
selected, or **All shown (N)**, every photo the filters leave showing. With
several selected, the dialog opens on Selected.

Click **Export**. When it is done, a line reports what happened, and the
dialog closes by itself if nothing went wrong.

# Immich

[Immich](https://immich.app) is a self-hosted photo library. Immage uses it
in three ways:

- **Importing** checks new photos against your Immich library and marks
  the ones it already has.
- **Searching**, from the **Immich** card in the Library panel, finds
  photos by what is in them, by people, places, tags or albums. You then
  edit them as if they were local.
- **Exporting** can upload straight into an Immich album.

**If you've used another editor:** Immich takes the place of an editor's
catalog and collections, and of publishing to a photo service. Immage itself keeps
no catalog.

Immage works with Immich 3.2 or newer.

## Setting it up

### 1. Make an API key in Immich

In Immich's web page, open **Account Settings › API Keys** and create a
key. Give it the permissions for what you want to do:

| Permission | Needed for |
| --- | --- |
| `asset.read` | checking imports against the library, and searching it |
| `asset.view` | thumbnails of search results |
| `asset.download` | downloading a result's original to edit it |
| `asset.upload` | exporting to Immich |
| `album.read` | listing albums to export to, and the Albums search filter |
| `album.create` | creating an album from the Export dialog |
| `albumAsset.create` | adding exported photos to an album |
| `person.read`, `tag.read` | the People and Tags search filters (optional) |
| `library.read` | listing external libraries one by one (optional; admin keys only) |

Only `asset.read` is needed to check imports. Copy the key: Immich shows
it only once.
<!-- check: the menu path in Immich's web page for API keys -->

### 2. Enter it in Immage

Open **Preferences** (⌘,) and the **Immich** tab.

- **Use Immich**: turn on looking photos up during an import.
- **Server URL**: your server's address, for example
  `https://photos.example.com`. A plain `http` address works, but sends the
  key unencrypted.
- **API key**: paste the key. It is kept in the macOS Keychain (the
  Windows Credential Manager, or your system keyring on Linux), never in a
  file. Once stored, the field shows **stored**, with **Replace** and
  **Forget**.
- **Self-signed certificate**: turn on if your server uses a certificate
  no authority signed.

Click **Test** beside **Connection**. A good result reads like
`Immich 3.2.1, key "Immage"`. If the key lacks something, the result says
what exporting or searching needs. Add those permissions to the key in
Immich and test again.

Settings save as you type.

![Preferences, Immich tab, after a successful test](images/immich-prefs.png)
<!-- screenshot: Preferences > Immich, Server card filled in, Test result showing the version and key -->

### 3. Duplicates during import (optional)

- **Match the folder path**: a photo only counts as being in Immich if it
  is at the path the import would give it. Leave it off to match anywhere.
- **Path prefix**: where your library sits inside Immich, for example
  `/mnt/photos`. After a test, a **Use …** button can fill it in from a
  photo on the server.

### 4. Opening photos (for external libraries)

If Immich reads your photos from a folder this computer also has (an
external library), Immage can open those files directly instead of
downloading them:

- **Path in Immich**: where that folder is on the server, for example
  `/mnt/photos`.
- **On this computer**: the same folder here. Click **Choose…**.

Left blank, these follow the importer's **Path prefix** and destination.
Photos outside that folder are downloaded before they open.

## Searching

Once a server and key are set, the **Immich** card appears in the Library
panel, under **Folders**.

![The Immich card with a search and Advanced filters open](images/immich-search.png)
<!-- screenshot: Library panel, Immich card, Smart search "beach at sunset", Advanced open with a person chip -->

- The library menu chooses what to search: **External libraries** (the
  default), **All photos**, or one library.
- Type in the search box and press Enter. **Smart** searches by what is in
  the photo, using Immich's machine learning, for example
  `dog on a beach`. **Filename** searches file names and descriptions.
- **Advanced** adds filters: the date taken, rating, favorites, **RAW
  only**, camera and lens, country and city, people, tags and albums.
  Changing a filter searches again by itself. **Clear** removes them.

Results fill the grid with Immich's thumbnails, 250 at a time, with more
as you scroll.

## Opening a result

Double-click a result to open it. If the file is in the folder set under
**Opening photos**, Immage opens it in place and saves the edit beside it,
like any other photo. Otherwise it downloads the original first ("downloading
the original from Immich…") and edits the downloaded copy.

Until a result is opened, its stars show Immich's rating and can't be
changed. After that, ratings and labels go into the photo's sidecar.

To find the photos you have edited in Immage with Immich's Tags filter, set
**Keywords for edited photos** in Preferences › New Photos. Immich sees a
keyword once it reads the sidecar again, at its next library scan or
metadata refresh.

Right-click a result for **Show in Immich**, or **Show Results in Immich**
to see the same search in Immich's web page.

## Exporting to an album

In the Export dialog, set **Save to** to **Immich album**, then choose an
album, or **New album…** to make one. A photo Immich already has goes into
the album without a second copy. See [Export](export.md).

## When something goes wrong

| Message | What to do |
| --- | --- |
| **could not connect: …** | Check the server address and that the server is up. For a self-signed certificate, turn on **Self-signed certificate**. |
| **the key lacks asset.read** | Edit the key in Immich and add the permission. |
| **the API key lacks …: thumbnails need asset.view, downloading originals needs asset.download** | Add those permissions to the key. |
| **the API key lacks …: give it those in Immich, or exporting may fail** | Add the export permissions (`asset.upload`, `album.read`, `album.create`, `albumAsset.create`). |
| **no photos in Immich match the search** | Loosen the search, or set the library menu to **All photos**. |

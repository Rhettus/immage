# morfPhoto (Experimental)

Immage 0.47.0 can use a morfPhoto server to browse and filter photos on a
mounted network share. morfPhoto supplies the folder contents and indexed EXIF
and XMP, including ratings, color labels, keywords, and virtual copies. Immage
opens the originals through the mounted share, so keep that share connected
when viewing, editing, or exporting photos.

## Connect the server

1. On the NAS, run a morfPhoto build with the Library API and Bearer-key
   authentication, such as the `fork/nas` build. Enable `xmp.enabled` and set
   `MORFPHOTO_API_KEY` or `api_key` on the server. Index the folders you want to
   browse.
2. In **Preferences → morfPhoto (Experimental)**, enter the server's base URL
   and API key. Use HTTPS so the key travels encrypted. Immage stores the key
   in the OS keychain when you save.
3. Enter the mapped folder's absolute path as morfPhoto sees it, for example
   `/photos`. Next to **Folder on this computer**, choose the mounted network
   folder with the same contents, for example `/Volumes/photos`. A file at
   `/photos/2026/example.raw` then opens from
   `/Volumes/photos/2026/example.raw`. The mapping is saved separately from
   your Immich settings.
4. Select **Test**, enable **Use morfPhoto**, and select **Save**. Add the
   mounted folder to your [Library](library.md) if it is not already there.

Use **Replace** to enter a new key. **Forget** removes the stored key and
disables the integration. To keep the key while using file-based browsing,
turn off **Use morfPhoto** and save. Refresh the Library folders to apply the
change to the current view.

## Browse and search

The folder tree shows folders that contain indexed photos or lead to them.
Empty and unindexed folders stay out of the tree. Library filters and Find
prefer the metadata from the current server index for mapped network shares.
Photos, edits, and file moves can take until the next morfPhoto index update
to appear.

If Immage cannot read the API for a mapped folder, it shows a notice and uses
its usual file-based workflow for that scope. Refresh to try morfPhoto again.
Local similarity search still depends on Immage's local image analysis.

For visible thumbnails of unedited originals, Immage checks its own cache
first and then can use an embedded camera preview from a morfPhoto server
with its optional thumbnail cache enabled. If the preview is unavailable, Immage renders the
thumbnail from the mounted file. Edited photos and virtual copies use
Immage's rendered thumbnails.

## Smart Search on the NAS

Enable the CLIP Compose override on the morfPhoto server and install its pinned
model on NAS storage. In Immage, open a mapped folder and choose **Smart** and
the current folder scope in Find. Enter a description such as “a dog on a beach”.
morfPhoto ranks indexed, unedited originals, including photos Immage has never
opened. The desktop CLIP model is optional for these searches.

While the NAS builds its index, Immage shows how many matching originals are
indexed. On the NAS, inspect the `clip` section of the authenticated index
status to see progress and preview failures. The worker can reuse thumbnails
already cached by morfPhoto.

Library-wide searches, image queries, and searches that require edits or copies
use the existing desktop index. If the server cannot handle the search or an
active filter, Immage falls back to desktop search, which uses its own CLIP
model and can only rank photos it has analyzed.

# Immage Accelerator (Experimental)

Immage Accelerator uses morfPhoto, a service you run on the NAS, to browse
and search a photo library on a mounted network share. morfPhoto serves the
folder listing and indexed EXIF and XMP, including ratings, color labels,
keywords, and virtual copies. With optional caches, it can also serve
thumbnails and rank originals by a text description. Immage opens originals
through the mounted share for viewing, editing, and exporting.

morfPhoto was created by Frédéric Biron (morfredus) and is licensed GPL-3.0-only.
The Docker image and Compose files below come from the Rhettus morfPhoto fork.

## Install on the NAS

You need Docker with Compose, a directory of photos the container can read,
and a network share that exposes those same photos to the Immage computer.
Use NAS storage for the optional caches. The image supports AMD64 and ARM64.

1. Create a deployment directory such as `/storage/morfphoto`, then download
   the Compose files and example settings from that directory.

   ```bash
   base='https://raw.githubusercontent.com/Rhettus/morfPhoto/fork/nas'
   for file in docker-compose.yml docker-compose.thumbnails.yml docker-compose.clip.yml .env.example; do
     curl -fLO "$base/$file" || break
   done
   cp -n .env.example .env
   ```

2. Set `PHOTOS_DIR` in `.env` to the absolute path of the photo folder on the
   NAS. Set `PUID` and `PGID` to a NAS account that can read it. The container
   mounts this folder read-only as `/photos`. Generate a bearer key with
   `openssl rand -hex 32` and put it in `MORFPHOTO_API_KEY`. The default port is
   8793. Keep the key for the Immage connection setup.
3. For metadata-only browsing, run `docker compose pull` followed by
   `docker compose up -d`. The first start registers `/photos` and starts the
   catalog scan. Use `sudo` if your NAS requires it for Docker. For thumbnail
   warming or Smart Search, add the corresponding overrides below.

### Optional thumbnail cache

Set `MORFPHOTO_THUMBNAIL_DIR` in `.env` to a directory on NAS storage, such as
`/storage/morfphoto/thumbnail-cache`. Create it and give the configured
`PUID` and `PGID` write access. Apply it with
`docker compose -f docker-compose.yml -f docker-compose.thumbnails.yml up -d`.
Use the same Compose files on future upgrades to keep the cache attached.

### Optional CLIP Smart Search

Set `MORFPHOTO_CLIP_DIR` to a writable directory on NAS storage, such as
`/storage/morfphoto/clip`. It holds the model and persistent embedding database.
With the default `MORFPHOTO_CLIP_THREADS=1`, inference uses one CPU thread.

Create the `model/onnx` subdirectory, then download these files into your CLIP
directory. The worker checks their hashes when it starts.

```bash
clip_dir=/storage/morfphoto/clip
mkdir -p "$clip_dir/model/onnx"
model_url='https://huggingface.co/Xenova/clip-vit-base-patch32/resolve/6b7c523703ae26e39be4b03774966f8571c7f523'
for asset in tokenizer.json onnx/text_model.onnx onnx/vision_model.onnx; do
  curl -fL --retry 3 "$model_url/$asset" -o "$clip_dir/model/$asset" || break
done
```

The download is about 608 MB. After all three files are present, include
`-f docker-compose.clip.yml` along with the base and any thumbnail override.
For example, to enable both:

```bash
docker compose -f docker-compose.yml -f docker-compose.thumbnails.yml -f docker-compose.clip.yml pull
docker compose -f docker-compose.yml -f docker-compose.thumbnails.yml -f docker-compose.clip.yml up -d
```

The worker starts from the saved catalog and reuses thumbnails when available.

## Connect the server

1. In **Preferences → Immage Accelerator (Experimental)**, enter the server
   URL and API key. For example, use `http://nas-hostname:8793` on your local
   network, or your HTTPS URL if you have set up a reverse proxy. Immage
   stores the key in the OS keychain when you save.
2. Set **Server folder** to the path as morfPhoto sees it, usually `/photos`.
   Set **Folder on this computer** to the mounted share with the same
   contents, for example `/Volumes/photos`. A file listed as
   `/photos/2026/example.raw` then opens from
   `/Volumes/photos/2026/example.raw`.
3. Select **Test**, turn on **Enable Immage Accelerator**, and select **Save**.
   Add the mounted folder to your [Library](library.md).

Use **Replace** to enter a new key. **Forget** removes the stored key and
disables the integration. To keep the key while using file-based browsing,
turn off **Enable Immage Accelerator** and save. Refresh the Library folders to apply the
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

## Monitor NAS activity

Open **Preferences → Immage Accelerator (Experimental)** and expand
**NAS activity** to see scan progress, thumbnail counts, and CLIP coverage
and failures. The panel refreshes about every 10 seconds while expanded. Each metric has its own row. The on-disk thumbnail count
is measured about every 30 seconds while thumbnail warming is available and
includes files written before the last restart. The generated and checked counts
reset on restart. Older servers may omit some counters.

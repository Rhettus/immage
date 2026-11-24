# Immage Accelerator (Experimental)

Immage Accelerator is for browsing large photo libraries and getting to the
photo you want to edit faster when the originals live on a network share or
slower disks. It can make a substantial difference on a low-powered NAS such
as a Raspberry Pi, where repeatedly opening originals over the network to read
metadata or generate grid thumbnails adds up. Reusing that work can make
browsing and editing over Wi‑Fi comfortably usable. Opening an original still
depends on the speed of your connection. Expect a smaller gain when your
photos already live on fast local NVMe storage.

Run morfPhoto once on the NAS and connect as many Immage clients as you need to
the same library. The server indexes metadata once and, with thumbnail caching
enabled, builds a shared cache that every client can reuse. If you clear
Immage’s local caches, the server still has its metadata index and cached
previews. Immage can use them again as you browse, without regenerating those
thumbnails from the originals.

The shared cache covers embedded camera previews for unedited originals.
Immage still opens originals through the mounted share for editing and
exporting, and renders thumbnails for edits and virtual copies locally.
Optional server-side CLIP lets clients share an analysis index for Smart
Search, too.

## Where your photo data lives

Your original photos stay on the photo share, and their XMP sidecars remain
the system of record for edits and other sidecar metadata. Accelerator stores
only data it can rebuild from the photos and sidecars: the metadata index,
cached thumbnails, and optional CLIP embeddings. If Accelerator is unavailable
or its stored data is lost, Immage reads metadata from the photos and XMP
sidecars and generates thumbnails from the mounted share using its usual
file-based workflow.

morfPhoto was created by Frédéric Biron (morfredus) and is licensed GPL-3.0-only.
The Docker image and Compose files below come from the Rhettus morfPhoto fork.

## How much NAS storage to reserve

The figures below are planning estimates in GiB. They cover Accelerator data
only. Your original photos and XMP sidecars stay on the photo share.

| Photos | Metadata catalog (`/data`) | Optional thumbnail cache | Optional CLIP model and index |
| ---: | ---: | ---: | ---: |
| 10,000 | 0.08–0.31 GiB | 0.2–0.6 GiB | About 0.6 GiB |
| 100,000 | 0.8–3.1 GiB | 1.9–5.7 GiB | About 1 GiB |
| 500,000 | 3.8–15.3 GiB | Up to about 8 GiB | About 2.5 GiB |

- **Metadata catalog:** The estimate assumes 8–32 KiB per photo for SQLite
  records and indexes. Large EXIF records, lots of keywords, and virtual
  copies can increase that. The supplied Compose file puts the catalog in the
  Docker volume `morfphoto-data`, so check free space on the disk that holds
  Docker's volumes. Leave room for SQLite's temporary growth during indexing.
- **Thumbnails:** The examples assume cached JPEGs average 20–60 KiB. Camera
  previews vary in size, and some photos have no eligible embedded preview.
  The cache has an approximately 8 GiB JPEG budget across its shards. A
  500,000-photo library at the example sizes would need about 10–29 GiB for
  every preview, so expect partial coverage at that scale. Filesystem
  overhead adds to actual disk usage. The cache skips new writes when its
  filesystem has less than 512 MiB free.
- **CLIP:** The model is a one-time download of about 608 MB per server.
  Each photo adds a 2 KiB embedding before SQLite overhead. The table
  allows for storage on roughly one 4 KiB database page per indexed photo.
  Keep extra space for database writes and model updates.

For a starting budget with both options enabled, reserve roughly **5 GB**
for 10,000 photos, **20 GB** for 100,000, or **50 GB** for 500,000, spread
across the catalog and cache volumes. Measure your actual usage after
indexing a representative folder before sizing a larger deployment.

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

With a morfPhoto server that supports grid-sized thumbnails, each JPEG fits
within 400 × 400 pixels. The server uses a larger embedded camera preview when
the thumbnail is too small, preserves the aspect ratio, and keeps smaller
previews at their original size. After a server upgrade, background warming
revisits indexed photos and replaces older cached thumbnails within the existing
cache budget.
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
   `/Volumes/photos/2026/example.raw`. Folders inside that folder are always
   treated as network shares: when the share isn't mounted, Library shows them
   as offline (a red dot on the drive heading) and they can't be opened until
   it is mounted again.
3. Select **Test**, turn on **Enable Immage Accelerator**, and select **Save**.
   Add the mounted folder to your [Library](library.md).

Use **Replace** to enter a new key. **Forget** removes the stored key and
disables the integration. To keep the key while using file-based browsing,
turn off **Enable Immage Accelerator** and save. Refresh the Library folders to apply the
change to the current view.

## Browse and search

Immage requests subfolders from morfPhoto as you expand the folder tree.
The tree shows folders that contain indexed photos or lead to them.
Empty and unindexed folders stay out of the tree. Library filters and Find
prefer the metadata from the current server index for mapped network shares.
Photos, edits, and file moves can take until the next morfPhoto index update
to appear.

With morfPhoto v0.15.9+, Immage optimizes catalog and thumbnail loading while
staying compatible with older morfPhoto servers:

- **Progressive loading:** Immage shows the first page of photos immediately
  while remaining pages load in the background.
- **Compressed persistent connections:** API requests use gzip compression and
  persistent Keep-Alive connections for smaller, faster syncs.
- **Local catalog and subfolder caching:** Immage caches folder catalogs on
  disk (up to 32 folders / 64 MiB) and subfolder listings in memory, validating
  both with `ETag` / `304 Not Modified` checks so unchanged folders open with
  zero catalog re-download. The catalog cache clears automatically when you
  change the server URL or folder mapping, or when you select **Forget**. The
  [local catalog](#local-catalog) opens folders first when it has them.
- **Local thumbnail caching:** For visible thumbnails of unedited originals,
  Immage checks its own cache first, then checks its local morfPhoto thumbnail
  cache (up to 256 MiB) and revalidates cached server previews via `ETag` /
  `304 Not Modified` before downloading a new preview from morfPhoto. If no
  server preview is available, Immage renders the thumbnail from the mounted
  file. Edited photos and virtual copies always use Immage's rendered
  thumbnails. Clearing **Library thumbnails** in **Preferences → Performance**
  or selecting **Forget** in **Preferences → Immage Accelerator (Experimental)**
  also clears the local morfPhoto thumbnail cache.

If Immage cannot read the API for a mapped folder, it shows a notice and uses
its usual file-based workflow for that scope. Refresh to try morfPhoto again.
Local similarity search still depends on Immage's local image analysis.

## Smart Search on the NAS

Enable the CLIP Compose override on the morfPhoto server and install its pinned
model on NAS storage. In Immage, open a mapped folder and choose **Smart** with
**This folder** or **All folders** in Find. Enter a description such as “a dog
on a beach”. morfPhoto ranks indexed, unedited originals, including photos
Immage has never opened. The desktop CLIP model is optional for these searches.

CLIP provider precedence per folder is **morfPhoto**, then **Immich**, then
**local CLIP**. While morfPhoto answers with active CLIP indexing, Immage skips
local CLIP analysis for all photos (originals, edited photos, and virtual
copies) inside the mapped folder, and excludes them from Find's local analysis
backlog. In **All folders** searches, Immage combines morfPhoto results for the
mapped share with Immich or local CLIP results for other folders.

While the NAS builds its index, Immage shows how many matching originals are
indexed. On the NAS, inspect the `clip` section of the authenticated index
status to see progress and preview failures. The worker can reuse thumbnails
already cached by morfPhoto.

Immage waits up to 22 seconds for NAS Smart Search responses so cold NAS disks
have time to spin up and respond without falling back prematurely. Image queries
and searches filtered to edited photos use the desktop index. If the server does
not answer, has CLIP disabled, or cannot handle an active filter, Immage falls
through immediately to the next available provider (Immich if mapped for that
folder, otherwise local CLIP) and shows a notice.

## Local catalog

With Immage Accelerator on, Immage keeps a copy of the server's catalog on
this computer: each photo and version under the mapped server folder, with the
fields Find's filters use (file type, camera, lens, exposure, rating, labels,
keywords and dates). It updates in the background, a few seconds after launch,
after you save the settings and about every minute while Immage is open. With
a morfPhoto server that offers the change feed, only what changed is
downloaded. Older servers are read in full at most every ten minutes. The sync
pauses while you open, edit or browse photos, so it never slows your work.

Open **Preferences → Immage Accelerator (Experimental)** and look at **Local
catalog**:

- **Last synced** is when the copy last matched the server.
- **Photos in the local copy** is how many photos it holds.
- **Syncing** shows progress while a sync runs.
- **Last error** appears when a sync fails, for example when the disk is full.
  Immage keeps what it has and tries again, waiting longer after each failure.
- **Resync now** discards the local copy and downloads the catalog again.

Selecting **Forget**, or saving a different server URL or server folder, also
empties the local copy. The copy is disposable: deleting it loses nothing.
If the file cannot be opened, Immage works without it. Folders and Find then
read the server as described above.

### Folders open from the local copy

A folder under the mapped folder shows its photos from the local copy at once,
before the server is asked anything. Immage then asks the server whether its
catalog has changed since the last sync. If it has not, the copy is the final
list and no catalog is downloaded. If it has, the folder is read from the
server as before while the sync catches up, and the folder refreshes by itself
when the sync has changed photos in it.

When the server does not answer within about a second and a half, the copy
stands and the status bar says **Showing the local catalog, synced** with the
time of the last sync. Rating, label and keyword changes made on the server
since then are missing until it answers again. A folder the copy knows nothing
about is read from the server, and then from the files, as before.

The folder tree reads the server's subfolders first, then the local copy when
the server does not answer, then the files.

While the mapped share is not mounted or is not answering, its photos still
show from the local copy, each with a small red dot (the red of the drive's
offline dot) and the tooltip **Photo's drive is offline**. Their thumbnails
come from Immage's or morfPhoto's caches, or stay empty. Clicking such a photo
selects it but does not open it, and the status bar says the photo is on an
offline drive. Open it once the share is connected again.

### Find reads the local copy

With **All folders** and a metadata search (filters, or a file name search),
Find reads the local copy by database queries and loads only the photos that
match, so a narrow filter over a library of 150,000 photos answers in a few
hundredths of a second and the filter lists count the whole library. This
needs the copy to be complete; until the first sync finishes Find lists the
server's folders as before, and the filter lists hold the photos Immage has
already read. Smart (photo content) searches are unchanged.

Camera and lens names from the server are shown as Immage shows the ones it
reads itself, using darktable's camera names (**Nikon Z 6**, **Canon EOS R5**,
**Sony ILCE-7M3**). A lens keeps the server's name except for Canon RF and RF-S,
and Nikkor, Tamron and Viltrox names, which are spelled as darktable spells them.

## Monitor NAS activity

Open **Preferences → Immage Accelerator (Experimental)** and expand
**NAS activity** to see scan progress, thumbnail counts, and CLIP coverage
and failures. The panel refreshes about every 10 seconds while expanded. Each
metric has its own row, with counts and statuses aligned at the end of the value
column. The on-disk thumbnail count
is measured about every 30 seconds while thumbnail warming is available and
includes files written before the last restart. The generated and checked counts
reset on restart. Older servers may omit some counters.

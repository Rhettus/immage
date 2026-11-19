// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use super::*;
use std::fs::{self, Metadata};
use std::io::{self, ErrorKind};

#[derive(Deserialize, Type)]
pub(crate) struct FolderMoveRequest {
    source: String,
    dest: String,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderMovePlan {
    target: String,
    files: u32,
    photos: u32,
    subfolders: u32,
    links: u32,
    identical: u32,
    merge: bool,
    instant: bool,
    network: bool,
    bytes: u64,
    free: Option<u64>,
    conflicts: Vec<FolderConflict>,
}

#[derive(Serialize, Deserialize, Type)]
pub(crate) struct FolderConflict {
    path: String,
    checksum: String,
    bytes: u64,
}

#[derive(Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FolderMoveSummary {
    target: String,
    source_removed: bool,
    skipped: u32,
}

struct Tree {
    source: PathBuf,
    target: PathBuf,
    display_source: PathBuf,
    display_target: PathBuf,
    dirs: Vec<PathBuf>,
    files: Vec<PathBuf>,
    system_files: Vec<(PathBuf, Metadata)>,
    links: u32,
    merge: bool,
    _reservation: Option<DestinationReservation>,
}

fn io_at<T>(path: &Path, result: io::Result<T>) -> Result<T, String> {
    result.map_err(|e| format!("{}: {e}", path.display()))
}

fn metadata(path: &Path) -> Result<Option<Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(m) => Ok(Some(m)),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
        Err(e) => io_at(path, Err(e)),
    }
}

fn tick(ctx: &Ctx) -> Result<(), String> {
    if ctx.cancelled() {
        return Err(CANCELLED.into());
    }
    ctx.activity.fetch_add(1, Ordering::SeqCst);
    Ok(())
}

fn reserve_trees(source: &Path, target: &Path) -> Result<DestinationReservation, String> {
    let paths = [reservation_key(source), reservation_key(target)];
    let mut active = DESTINATIONS.get_or_init(Default::default).lock().unwrap();
    let overlaps = active.iter().any(|key| {
        let existing = key.strip_prefix('\0');
        let other = Path::new(existing.unwrap_or(key));
        paths.iter().any(|p| {
            let root = Path::new(p);
            other.starts_with(root) || (existing.is_some() && root.starts_with(other))
        })
    });
    if overlaps {
        return Err("A transfer already uses one of these folders".into());
    }
    let keys: Vec<_> = paths.iter().map(|p| format!("\0{p}")).collect();
    active.extend(keys.iter().cloned());
    Ok(DestinationReservation(keys))
}

fn walk(req: FolderMoveRequest, reserve: bool, ctx: &Ctx) -> Result<Tree, String> {
    let original = Path::new(&req.source);
    let dest = Path::new(&req.dest);
    check_dest(original)?;
    check_dest(dest)?;
    let name = original.file_name().ok_or("Cannot transfer a drive root")?;
    if !metadata(original)?.is_some_and(|m| m.is_dir()) {
        return Err("The source must be a folder, rather than a link".into());
    }
    let source = io_at(original, fs::canonicalize(original))?;
    let display_target = dest.join(name);
    let dest = io_at(dest, fs::canonicalize(dest))?;
    let target = dest.join(name);
    if dest.starts_with(&source)
        || source.starts_with(&target)
        || source.parent() == Some(dest.as_path())
    {
        return Err("Choose another destination folder".into());
    }
    let reservation = if reserve {
        Some(reserve_trees(&source, &target)?)
    } else {
        None
    };
    let mounts = volumes::mount_points();
    let mount = volumes::mount_identity(&source);
    if mounts.contains(&source)
        || source
            .parent()
            .is_none_or(|p| volumes::mount_identity(p) != mount)
    {
        return Err("Cannot transfer a mount point".into());
    }
    let dest_mount = volumes::mount_identity(&dest);
    let merge = directory_at(&target, &dest_mount)?;
    if merge {
        let resolved = io_at(&target, fs::canonicalize(&target))?;
        if resolved.starts_with(&source) || source.starts_with(&resolved) {
            return Err("Choose another destination folder".into());
        }
    }

    let mut tree = Tree {
        source,
        target,
        display_source: original.to_path_buf(),
        display_target,
        dirs: vec![PathBuf::new()],
        files: Vec::new(),
        system_files: Vec::new(),
        links: 0,
        merge,
        _reservation: reservation,
    };
    let mut next = 0;
    let mut seen = 0;
    while next < tree.dirs.len() {
        tick(ctx)?;
        let relative = tree.dirs[next].clone();
        next += 1;
        let dir = tree.source.join(&relative);
        if !directory_at(&dir, &mount)? {
            return Err(format!("{} disappeared", dir.display()));
        }
        let entries = io_at(&dir, fs::read_dir(&dir))?;
        for entry in entries {
            tick(ctx)?;
            seen += 1;
            if seen > 500_000 {
                return Err("The folder contains more than 500,000 entries".into());
            }
            let entry = io_at(&dir, entry)?;
            let path = entry.path();
            if mounts.contains(&path) {
                return Err(format!("{} is on another mount", path.display()));
            }
            let kind = io_at(&path, entry.file_type())?;
            let rel = relative.join(entry.file_name());
            if kind.is_dir() {
                directory_at(&tree.target.join(&rel), &dest_mount)?;
                tree.dirs.push(rel);
            } else if kind.is_file() {
                if is_system_file(&rel) {
                    if let Some(m) = regular(&path)? {
                        tree.system_files.push((rel, m));
                    }
                    continue;
                }
                if rel.to_str().is_none() {
                    return Err(format!(
                        "{} cannot be displayed in the confirmation",
                        path.display()
                    ));
                }
                tree.files.push(rel);
            } else if kind.is_symlink() {
                tree.links += 1;
            } else {
                return Err(format!(
                    "{} is neither a regular file, folder, nor link",
                    path.display()
                ));
            }
        }
    }
    tree.files.sort_unstable();
    Ok(tree)
}

fn is_system_file(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name == ".DS_Store" || name.eq_ignore_ascii_case("Thumbs.db"))
}

fn directory_at(path: &Path, mount: &Option<String>) -> Result<bool, String> {
    match metadata(path)? {
        None => Ok(false),
        Some(m) if m.is_dir() && &volumes::mount_identity(path) == mount => Ok(true),
        Some(_) => Err(format!(
            "{} is not a regular folder on the destination drive",
            path.display()
        )),
    }
}

// A second spelling or mount of the same storage may defeat canonicalization.
// Probe the whole destination lineage before creating anything there.
fn check_aliases(source: &Path, dest: &Path, target: &Path, ctx: &Ctx) -> Result<(), String> {
    let name = format!(
        ".immage-alias-{}-{}",
        std::process::id(),
        MARKER.fetch_add(1, Ordering::SeqCst)
    );
    let marker = source.join(&name);
    io_at(
        &marker,
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&marker),
    )?;
    let result = (|| {
        for parent in std::iter::once(target).chain(dest.ancestors()) {
            tick(ctx)?;
            if metadata(&parent.join(&name))?.is_some() {
                return Err("The destination aliases the source folder".into());
            }
        }
        Ok(())
    })();
    io_at(&marker, fs::remove_file(&marker))?;
    result
}

fn regular(path: &Path) -> Result<Option<Metadata>, String> {
    match metadata(path)? {
        Some(m) if !m.is_file() => Err(format!("{} is not a regular file", path.display())),
        m => Ok(m),
    }
}

fn plan(tree: Tree, ctx: &Ctx) -> Result<FolderMovePlan, String> {
    let parent = tree.target.parent().unwrap();
    let mut plan = FolderMovePlan {
        target: text(&tree.display_target),
        files: tree.files.len() as u32,
        photos: 0,
        subfolders: tree.dirs.len() as u32 - 1,
        links: tree.links,
        identical: 0,
        merge: tree.merge,
        instant: !tree.merge && tree.links == 0 && same_drive(&tree.source, parent),
        network: volumes::on_network(parent),
        bytes: 0,
        free: free_space(parent),
        conflicts: Vec::new(),
    };
    for rel in tree.files {
        tick(ctx)?;
        let source = tree.source.join(&rel);
        let target = tree.target.join(&rel);
        let m = regular(&source)?.ok_or_else(|| format!("{} disappeared", source.display()))?;
        if crate::library_cmds::photo_candidate(&source) {
            plan.photos += 1;
        }
        if regular(&target)?.is_some() {
            let checksum = sums(&target, Some(ctx))?.sha256;
            if sums(&source, Some(ctx))?.sha256 == checksum {
                plan.identical += 1;
            } else {
                plan.conflicts.push(FolderConflict {
                    path: text(&rel),
                    checksum,
                    bytes: m.len(),
                });
            }
        } else {
            plan.bytes += m.len();
        }
    }
    Ok(plan)
}

// A skipped photo or sidecar keeps the whole original file set together.
// Each destination conflict still has its own Skip/Overwrite choice.
fn related_photos(path: &Path) -> Vec<PathBuf> {
    if crate::library_cmds::photo_candidate(path) {
        return vec![path.to_path_buf()];
    }
    let Some(file) = path.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    let Some((base, suffix)) = file.rsplit_once('.') else {
        return Vec::new();
    };
    if !matches!(suffix, "xmp" | "dtdata") {
        return Vec::new();
    }
    let mut photos = vec![path.with_file_name(base)];
    if let Some((stem, ext)) = base.rsplit_once('.') {
        if let Some((original, version)) = stem.rsplit_once('_') {
            if !version.is_empty()
                && version.bytes().all(|byte| byte.is_ascii_digit())
                && (suffix == "dtdata" || version.len() >= 2)
            {
                photos.push(path.with_file_name(format!("{original}.{ext}")));
            }
        }
    }
    photos
}

fn thumbnail_file(path: &Path) -> bool {
    crate::library_cmds::photo_candidate(path) || path.extension().is_some_and(|ext| ext == "xmp")
}

fn thumbnail_listing<'a>(
    root: &Path,
    files: impl Iterator<Item = (&'a PathBuf, &'a Metadata)>,
) -> crate::cache::Listed {
    let mut folders: HashMap<_, Vec<_>> = HashMap::new();
    for (rel, m) in files.filter(|(rel, _)| thumbnail_file(rel)) {
        folders
            .entry(rel.parent().unwrap())
            .or_default()
            .push((root.join(rel), Some(crate::cache::stamp(m))));
    }
    let mut listed = crate::cache::Listed::default();
    for (dir, files) in folders {
        listed.add(&root.join(dir), files);
    }
    listed
}

fn rename_thumbnail_listing(tree: &Tree, ctx: &Ctx) -> Result<crate::cache::Listed, String> {
    let mut files = Vec::new();
    for rel in tree.files.iter().filter(|rel| thumbnail_file(rel)) {
        tick(ctx)?;
        if let Some(m) = regular(&tree.source.join(rel))? {
            files.push((rel, m));
        }
    }
    Ok(thumbnail_listing(
        &tree.display_source,
        files.iter().map(|(rel, m)| (*rel, m)),
    ))
}

fn thumbnails(
    tree: &Tree,
    original: &crate::cache::Listed,
    copied: Option<&crate::cache::Listed>,
    thumbs: &crate::cache::DiskCache,
    ctx: &Ctx,
) {
    for rel in &tree.files {
        if tick(ctx).is_err() {
            return;
        }
        if crate::library_cmds::photo_candidate(rel) {
            crate::cache::transfer_thumbs(
                thumbs,
                &tree.display_source.join(rel),
                &tree.display_target.join(rel),
                &tree.target.join(rel),
                original,
                copied,
            );
        }
    }
}

fn fallback_rename(e: &io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(
            e.raw_os_error(),
            Some(libc::EXDEV | libc::EINVAL | libc::ENOSYS | libc::ENOTSUP)
        ) || e.raw_os_error() == Some(libc::EOPNOTSUPP)
    }
    #[cfg(windows)]
    {
        e.raw_os_error() == Some(17)
    }
}

#[derive(Default)]
struct CreatedDirectories(Vec<PathBuf>);

impl Drop for CreatedDirectories {
    fn drop(&mut self) {
        for path in self.0.iter().rev() {
            // A merge can include pre-existing folders and verified copies.
            // Remove only directories we created, and only while empty.
            if validate_parent(path).is_ok() {
                let _ = fs::remove_dir(path);
            }
        }
    }
}

#[allow(clippy::too_many_arguments)] // The transfer receives separate progress and bookkeeping callbacks.
fn transfer(
    tree: Tree,
    copy: bool,
    overwrite: Vec<FolderConflict>,
    workers: usize,
    thumbs: &crate::cache::DiskCache,
    ctx: &Ctx,
    mut progress: impl FnMut(usize, usize, u64, u64, &str),
    mut bookkeeping: impl FnMut(&Path, &Path, bool),
) -> Result<FolderMoveSummary, String> {
    let mut result = FolderMoveSummary {
        target: text(&tree.display_target),
        source_removed: false,
        skipped: tree.links,
    };
    let parent = tree.target.parent().unwrap();
    if !copy && !tree.merge && tree.links == 0 {
        let listed = rename_thumbnail_listing(&tree, ctx)?;
        tick(ctx)?;
        match rename_no_replace(&tree.source, &tree.target) {
            Ok(()) => {
                result.source_removed = true;
                thumbnails(&tree, &listed, None, thumbs, ctx);
                bookkeeping(&tree.display_source, &tree.display_target, true);
                return Ok(result);
            }
            Err(e) if fallback_rename(&e) || e.kind() == ErrorKind::AlreadyExists => {}
            Err(e) => return io_at(&tree.target, Err(e)),
        }
    }
    if !copy {
        check_aliases(&tree.source, parent, &tree.target, ctx)?;
    }
    let mount = volumes::mount_identity(parent);
    let tree = Arc::new(tree);
    let mut created = CreatedDirectories::default();
    for rel in &tree.dirs {
        tick(ctx)?;
        let path = tree.target.join(rel);
        if !directory_at(&path, &mount)? {
            io_at(&path, fs::create_dir(&path))?;
            created.0.push(path);
        }
    }
    let approved: HashMap<_, _> = overwrite
        .into_iter()
        .map(|f| (f.path, f.checksum))
        .collect();
    let mut units = Vec::new();
    for rel in &tree.files {
        tick(ctx)?;
        let source = tree.source.join(rel);
        let m = regular(&source)?.ok_or_else(|| format!("{} disappeared", source.display()))?;
        units.push(Unit {
            key: text(rel),
            name: text(rel),
            imgids: Vec::new(),
            versions: 0,
            files: vec![UnitFile {
                from: Some(source),
                rel: rel.clone(),
                size: m.len(),
            }],
            download: None,
            keep_source: true,
            here: false,
        });
    }
    let worker_tree = tree.clone();
    // Worker results hold only the two stat snapshots, keyed by relative
    // path. The mutex never covers a stat, copy, emit, or index operation.
    let placed = Arc::new(Mutex::new(HashMap::new()));
    let worker_placed = placed.clone();
    let batch = Batch {
        units,
        dest: tree.target.clone(),
        workers,
        cancel: ctx.cancel.clone(),
        stall: STALL,
    };
    let summary = transfer_batch(
        batch,
        move |unit, ctx| {
            let file = &unit.files[0];
            let source = file.from.as_ref().unwrap();
            let target = worker_tree.target.join(&file.rel);
            let m = regular(source)?.ok_or_else(|| format!("{} disappeared", source.display()))?;
            validate_parent(&target)?;
            validate_parent(source)?;
            let old = regular(&target)?
                .map(|_| sums(&target, Some(ctx)))
                .transpose()?
                .map(|s| s.sha256);
            if let Some(old) = &old {
                let expected = sums(source, Some(ctx))?;
                if expected.sha256 == *old {
                    ctx.bytes.fetch_add(m.len(), Ordering::SeqCst);
                } else if approved.get(&unit.key) == Some(old) {
                    let mut file = io_at(source, File::open(source))?;
                    copy_verified_into(
                        &mut file,
                        &target,
                        Some(&expected.sha1),
                        m.modified().ok(),
                        ctx,
                        Some(old),
                    )?;
                } else {
                    ctx.bytes.fetch_add(m.len(), Ordering::SeqCst);
                    return Ok(None);
                }
            } else {
                let mut file = io_at(source, File::open(source))?;
                copy_verified_into(&mut file, &target, None, m.modified().ok(), ctx, None)?;
            }
            if !copy || thumbnail_file(&file.rel) {
                let verified =
                    regular(&target)?.ok_or_else(|| format!("{} disappeared", target.display()))?;
                if verified.len() != m.len() || (!copy && same_file(source, &target)) {
                    return Err(format!(
                        "{} changed or aliases the destination",
                        source.display()
                    ));
                }
                validate_file(source, &m)?;
                worker_placed
                    .lock()
                    .unwrap()
                    .insert(unit.key.clone(), (m, verified));
            }
            Ok(Some((false, None)))
        },
        |p| {
            ctx.activity.fetch_add(1, Ordering::SeqCst);
            progress(p.done, p.total, p.bytes, p.bytes_total, "copying");
        },
        |_| {},
    );
    result.skipped += summary.skipped.len() as u32;
    if let Some(error) = summary.failed.first() {
        return Err(format!("{}: {}", error.name, error.error));
    }
    tick(ctx)?;
    let files: HashSet<_> = tree.files.iter().map(PathBuf::as_path).collect();
    let keep_photos: HashSet<_> = summary
        .skipped
        .iter()
        .flat_map(|path| related_photos(Path::new(path)))
        .filter(|photo| files.contains(photo.as_path()))
        .collect();
    let mut placed = std::mem::take(&mut *placed.lock().unwrap());
    let placed: Vec<_> = tree
        .files
        .iter()
        .filter_map(|rel| {
            if !keep_photos.is_empty()
                && related_photos(rel)
                    .iter()
                    .any(|photo| keep_photos.contains(photo))
            {
                return None;
            }
            let (original, verified) = placed.remove(&text(rel))?;
            Some((rel, original, verified))
        })
        .collect();

    if !copy {
        // Validate every file before deleting any. A skipped clash or link
        // deliberately keeps its original, and rmdir only removes empty folders.
        for (rel, original, verified) in &placed {
            tick(ctx)?;
            validate_file(&tree.source.join(rel), original)?;
            validate_file(&tree.target.join(rel), verified)?;
        }
        // Once source removal starts, destination directories may be the
        // only remaining copy of the original directory structure.
        created.0.clear();
        for (i, (rel, original, verified)) in placed.iter().enumerate() {
            tick(ctx)?;
            let source = tree.source.join(rel);
            validate_file(&source, original)?;
            validate_file(&tree.target.join(rel), verified)?;
            io_at(&source, fs::remove_file(&source))?;
            progress(i + 1, placed.len(), 0, 0, "removing");
        }
        for (rel, original) in &tree.system_files {
            tick(ctx)?;
            let path = tree.source.join(rel);
            if metadata(&path)?.is_some() {
                validate_file(&path, original)?;
                io_at(&path, fs::remove_file(&path))?;
            }
        }
        for rel in tree.dirs.iter().rev() {
            tick(ctx)?;
            let path = tree.source.join(rel);
            match fs::remove_dir(&path) {
                Ok(()) => {}
                Err(e) if e.kind() == ErrorKind::DirectoryNotEmpty => {}
                Err(e) => return io_at(&path, Err(e)),
            }
        }
        result.source_removed = metadata(&tree.source)?.is_none();
    }
    created.0.clear();
    // For a merge, an untransferred sidecar can share a stamp with a
    // different edit. Wait for a retry to complete before re-keying those.
    if summary.skipped.is_empty() {
        let original = thumbnail_listing(
            &tree.display_source,
            placed.iter().map(|(rel, original, _)| (*rel, original)),
        );
        let copied = thumbnail_listing(
            &tree.display_target,
            placed.iter().map(|(rel, _, copied)| (*rel, copied)),
        );
        thumbnails(&tree, &original, Some(&copied), thumbs, ctx);
    }
    if result.source_removed {
        bookkeeping(&tree.display_source, &tree.display_target, false);
    }
    Ok(result)
}

fn validate_parent(source: &Path) -> Result<(), String> {
    let parent = source.parent().unwrap();
    if io_at(parent, fs::canonicalize(parent))? != parent {
        return Err(format!("{} changed during transfer", parent.display()));
    }
    Ok(())
}

fn validate_file(source: &Path, original: &Metadata) -> Result<(), String> {
    validate_parent(source)?;
    let current = regular(source)?.ok_or_else(|| format!("{} disappeared", source.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (current.dev(), current.ino()) != (original.dev(), original.ino()) {
            return Err(format!("{} changed during transfer", source.display()));
        }
    }
    if current.len() != original.len() || current.modified().ok() != original.modified().ok() {
        return Err(format!("{} changed during transfer", source.display()));
    }
    Ok(())
}

// The transfer worker owns the permit and reservations until it actually
// exits. A blocked filesystem call can outlive the command's deadline.
async fn bounded<T: Send + 'static>(
    cancel: Arc<AtomicBool>,
    reserve_worker: bool,
    work: impl FnOnce(&Ctx) -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let permit = if reserve_worker {
            Some(WorkerPermit::try_acquire().ok_or("Transfers are busy")?)
        } else {
            None
        };
        let ctx = Arc::new(Ctx::new(cancel.clone()));
        let worker = ctx.clone();
        let (send, recv) = mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _permit = permit;
            let _ = send.send(work(&worker));
        });
        let mut activity = 0;
        let mut last = Instant::now();
        loop {
            match recv.recv_timeout(Duration::from_millis(200)) {
                Ok(result) => return result,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err("The folder transfer worker exited".into())
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
            }
            let current = ctx.activity.load(Ordering::SeqCst);
            if current != activity {
                last = Instant::now();
                activity = current;
            } else if last.elapsed() >= STALL {
                cancel.store(true, Ordering::SeqCst);
                return Err(
                    "The drive stopped answering. Check both folders when it is available again."
                        .into(),
                );
            }
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn folder_move_plan(
    state: State<'_, AppState>,
    job: u64,
    req: FolderMoveRequest,
) -> Result<FolderMovePlan, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .move_cancels
        .lock()
        .unwrap()
        .insert(job, cancel.clone());
    let _registered = CancelEntry {
        map: &state.move_cancels,
        job,
    };
    bounded(cancel, true, move |ctx| plan(walk(req, false, ctx)?, ctx)).await
}

// Keep the existing Tauri command payload.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
#[specta::specta]
pub(crate) async fn folder_move(
    app: AppHandle,
    state: State<'_, AppState>,
    settings: State<'_, crate::settings::Settings>,
    caches: State<'_, crate::cache::Caches>,
    job: u64,
    req: FolderMoveRequest,
    copy: bool,
    overwrite: Vec<FolderConflict>,
) -> Result<FolderMoveSummary, String> {
    let cancel = Arc::new(AtomicBool::new(false));
    state
        .move_cancels
        .lock()
        .unwrap()
        .insert(job, cancel.clone());
    let _registered = CancelEntry {
        map: &state.move_cancels,
        job,
    };
    let workers = transfer_workers(settings.get(crate::settings::THUMB_THREADS));
    let thumbs = caches.thumbs.clone();
    let index = state.search_cache.clone();
    let forget_app = app.clone();
    bounded(cancel, false, move |ctx| {
        let permit = WorkerPermit::try_acquire().ok_or("Transfers are busy")?;
        let tree = walk(req, true, ctx)?;
        drop(permit);
        transfer(
            tree,
            copy,
            overwrite,
            workers,
            &thumbs,
            ctx,
            |done, total, bytes, bytes_total, phase| {
                let _ = app.emit(
                    "move-progress",
                    json!({ "job": job, "done": done, "total": total,
                "bytes": bytes, "bytesTotal": bytes_total, "phase": phase }),
                );
            },
            |source, target, _renamed| {
                let _ = forget_app
                    .state::<AppState>()
                    .engine("folder_move")
                    .request(json!({
                        "cmd": "forget_folder", "path": source
                    }));
                let (source, target) = (source.to_path_buf(), target.to_path_buf());
                if let Some(index) = index.clone() {
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = rebase_index(&index, &source, &target) {
                            eprintln!("search cache folder transfer: {error}");
                        }
                    });
                }
            },
        )
    })
    .await
}

fn rebase_index(
    index: &crate::search_cache::SearchCache,
    source: &Path,
    target: &Path,
) -> Result<(), String> {
    for asset in index.folder_assets(source)? {
        let relative = Path::new(&asset.path)
            .strip_prefix(source)
            .map_err(|e| e.to_string())?;
        let path = target.join(relative);
        if !volumes::answering(&path) {
            break;
        }
        let variants = index.path_variants(&asset.path)?;
        if !variants.is_empty() {
            transfer_search_snapshot(index, (asset, variants), &path, true)?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(
        tree: Tree,
        overwrite: Vec<FolderConflict>,
        ctx: &Ctx,
        thumbs: &crate::cache::DiskCache,
    ) -> Result<FolderMoveSummary, String> {
        transfer(
            tree,
            false,
            overwrite,
            3,
            thumbs,
            ctx,
            |_, _, _, _, _| {},
            |_, _, _| {},
        )
    }

    fn fixture() -> (tempfile::TempDir, FolderMoveRequest, crate::cache::Caches) {
        let dir = tempfile::tempdir_in("target").unwrap();
        let path = dir.path().canonicalize().unwrap();
        let source = path.join("2026-05");
        let dest = path.join("backup");
        fs::create_dir_all(source.join("empty")).unwrap();
        fs::create_dir(&dest).unwrap();
        fs::write(source.join(".hidden"), b"metadata").unwrap();
        let caches = crate::cache::Caches::new(&path.join("cache"));
        (
            dir,
            FolderMoveRequest {
                source: text(&source),
                dest: text(&dest),
            },
            caches,
        )
    }

    fn context() -> Ctx {
        Ctx::new(Arc::new(AtomicBool::new(false)))
    }

    #[test]
    fn whole_directory_rename_keeps_hidden_files_and_empty_folders() {
        let (_dir, req, caches) = fixture();
        let ctx = context();
        let tree = walk(req, true, &ctx).unwrap();
        let (target, source) = (tree.target.clone(), tree.source.clone());
        let result = run(tree, vec![], &ctx, &caches.thumbs).unwrap();
        assert!(result.source_removed);
        assert_eq!(fs::read(target.join(".hidden")).unwrap(), b"metadata");
        assert!(target.join("empty").is_dir());
        assert!(!source.exists());
    }

    #[test]
    fn merge_skips_then_resumes_with_verified_overwrite() {
        let (_dir, req, caches) = fixture();
        let ctx = context();
        let source = PathBuf::from(&req.source);
        let target = PathBuf::from(&req.dest).join("2026-05");
        fs::create_dir(&target).unwrap();
        fs::write(target.join(".hidden"), b"old").unwrap();
        fs::write(source.join("notes.txt"), b"notes").unwrap();
        let args = || FolderMoveRequest {
            source: req.source.clone(),
            dest: req.dest.clone(),
        };
        let planned = plan(walk(args(), false, &ctx).unwrap(), &ctx).unwrap();
        assert_eq!(planned.conflicts.len(), 1);
        let first = run(
            walk(args(), true, &ctx).unwrap(),
            vec![],
            &ctx,
            &caches.thumbs,
        )
        .unwrap();
        assert_eq!(first.skipped, 1);
        assert_eq!(fs::read(target.join(".hidden")).unwrap(), b"old");
        assert_eq!(fs::read(source.join(".hidden")).unwrap(), b"metadata");
        assert_eq!(fs::read(target.join("notes.txt")).unwrap(), b"notes");
        let next = run(
            walk(args(), true, &ctx).unwrap(),
            planned.conflicts,
            &ctx,
            &caches.thumbs,
        )
        .unwrap();
        assert!(next.source_removed);
        assert_eq!(fs::read(target.join(".hidden")).unwrap(), b"metadata");
    }

    #[test]
    fn skipped_edit_keeps_the_original_photo_and_other_sidecars() {
        let (_dir, req, caches) = fixture();
        let ctx = context();
        let source = PathBuf::from(&req.source);
        let target = PathBuf::from(&req.dest).join("2026-05");
        fs::create_dir(&target).unwrap();
        for (name, bytes) in [
            ("photo.jpg", "photo"),
            ("photo_02.jpg.xmp", "edit"),
            ("photo_02.jpg.dtdata", "mask"),
        ] {
            fs::write(source.join(name), bytes).unwrap();
        }
        fs::write(target.join("photo_02.jpg.xmp"), b"different edit").unwrap();
        let result = run(walk(req, true, &ctx).unwrap(), vec![], &ctx, &caches.thumbs).unwrap();
        assert_eq!(result.skipped, 1);
        for name in ["photo.jpg", "photo_02.jpg.xmp", "photo_02.jpg.dtdata"] {
            assert!(source.join(name).exists());
            assert!(target.join(name).exists());
        }
    }

    #[test]
    fn a_failed_copy_keeps_all_originals() {
        let (_dir, req, caches) = fixture();
        let ctx = context();
        let source = PathBuf::from(&req.source);
        let target = PathBuf::from(&req.dest).join("2026-05");
        fs::create_dir(&target).unwrap();
        fs::create_dir(target.join("existing")).unwrap();
        fs::create_dir(target.join(".hidden")).unwrap();
        fs::write(source.join("notes.txt"), b"notes").unwrap();
        assert!(run(walk(req, true, &ctx).unwrap(), vec![], &ctx, &caches.thumbs).is_err());
        assert_eq!(fs::read(source.join(".hidden")).unwrap(), b"metadata");
        assert_eq!(fs::read(source.join("notes.txt")).unwrap(), b"notes");
        assert!(target.join("existing").is_dir());
        assert_eq!(fs::read(target.join("notes.txt")).unwrap(), b"notes");
        assert!(!target.join("empty").exists());
    }

    #[test]
    fn failure_during_setup_removes_the_new_destination_tree() {
        let (_dir, req, caches) = fixture();
        let ctx = context();
        let tree = walk(req, true, &ctx).unwrap();
        let target = tree.target.clone();
        fs::remove_file(tree.source.join(".hidden")).unwrap();
        assert!(transfer(
            tree,
            true,
            vec![],
            1,
            &caches.thumbs,
            &ctx,
            |_, _, _, _, _| {},
            |_, _, _| {}
        )
        .is_err());
        assert!(!target.exists());
    }

    #[test]
    fn copy_and_merge_move_skip_system_files() {
        let (_dir, req, caches) = fixture();
        let ctx = context();
        let source = PathBuf::from(&req.source);
        let target = PathBuf::from(&req.dest).join("2026-05");
        for rel in [
            ".DS_Store",
            "empty/.DS_Store",
            "Thumbs.db",
            "empty/THUMBS.DB",
        ] {
            fs::write(source.join(rel), b"finder").unwrap();
        }
        let tree = walk(
            FolderMoveRequest {
                source: req.source.clone(),
                dest: req.dest.clone(),
            },
            true,
            &ctx,
        )
        .unwrap();
        assert_eq!(tree.files, [PathBuf::from(".hidden")]);
        transfer(
            tree,
            true,
            vec![],
            1,
            &caches.thumbs,
            &ctx,
            |_, _, _, _, _| {},
            |_, _, _| {},
        )
        .unwrap();
        for rel in [
            ".DS_Store",
            "empty/.DS_Store",
            "Thumbs.db",
            "empty/THUMBS.DB",
        ] {
            assert!(!target.join(rel).exists());
            assert!(source.join(rel).exists());
        }
        fs::write(target.join(".DS_Store"), b"destination finder").unwrap();
        let result = run(walk(req, true, &ctx).unwrap(), vec![], &ctx, &caches.thumbs).unwrap();
        assert!(result.source_removed);
        assert_eq!(
            fs::read(target.join(".DS_Store")).unwrap(),
            b"destination finder"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn verified_move_between_filesystems() {
        let (_dir, mut req, caches) = fixture();
        let other = tempfile::tempdir_in("/tmp").unwrap();
        if same_drive(Path::new(&req.source), other.path()) {
            return;
        }
        req.dest = text(other.path());
        let source = PathBuf::from(&req.source);
        fs::write(source.join(".DS_Store"), b"finder").unwrap();
        let ctx = context();
        let result = run(walk(req, true, &ctx).unwrap(), vec![], &ctx, &caches.thumbs).unwrap();
        assert!(result.source_removed);
        assert_eq!(
            fs::read(other.path().join("2026-05/.hidden")).unwrap(),
            b"metadata"
        );
        assert!(!source.exists());
        assert!(!other.path().join("2026-05/.DS_Store").exists());
    }
}

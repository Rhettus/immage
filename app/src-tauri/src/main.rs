// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a windowed program on Windows: without it Windows starts the app with a
// console window of its own. debug builds keep theirs, for the log
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
mod stall_watch;
mod search_cache;
mod search_analysis;
mod library_ids;
mod analysis_queue;
mod search_reconcile;
mod clip_models;
mod clip_providers;
mod clip_text;
mod clip_image;
mod clip_infer;
mod search_cmds;
mod camera_names;
mod search_filters;
mod local_search;
mod local_search_cmds;
mod find_facets;
mod mirror_notes;
mod mirror_overrides;
mod mirror_query;
mod map_tiles;
mod map_search;
mod engine;
mod immich_search;
mod immich_upload;
mod listing;
mod plugins;
mod perf_trace;
mod frame_output;
mod resources;
mod memory_budget;
mod settings;
#[cfg(target_os = "linux")]
mod scale;
#[cfg(target_os = "linux")]
mod renderer;
#[cfg(target_os = "linux")]
mod pinch;
mod pinch_math;
mod volumes;
mod scrub;
mod support_bundle;
mod backup;
mod bindings;
mod typed_app;
mod typed_edit;
mod typed_export;
mod typed_library;
mod typed_session;
mod session_cmds;
mod library_cmds;
mod export_cmds;
mod move_cmds;
mod immich_cmds;
mod morf_mirror;
mod morf_photo;
mod morf_photo_cmds;
mod print_cmds;
mod edit_cmds;
mod ai_cmds;
mod app_cmds;

use cache::Caches;
use engine::{BaseCancel, Engine, Tagged, Timing};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use serde_json::Value;
use tauri::{Emitter, Manager};
#[cfg(target_os = "linux")]
use crate::session_cmds::shm_frame;
use crate::library_cmds::launch_path;
use crate::library_cmds::Launch;
use crate::app_cmds::supervise;

struct AppState {
    // disposable local search metadata; darktable's catalog remains in-memory
    search_cache: Option<Arc<search_cache::SearchCache>>,
    // the local copy of the morfPhoto catalog; its sync thread owns the file
    mirror: Arc<morf_mirror::Mirror>,
    analysis_queue: Arc<analysis_queue::AnalysisQueue>,
    search_analysis: search_analysis::Control,
    search_clear_lock: Mutex<()>,
    local_search_requests: Arc<local_search_cmds::Requests>,
    clip_models: Arc<clip_models::Models>,
    clip_providers: Arc<clip_providers::ProbeCache>,
    // engine(), not this directly
    engine: perf_trace::TracedMutex<Engine>,
    // reaches the engine while a request holds it
    base_cancel: BaseCancel,
    frame_path: PathBuf,
    // thumbnails, folder imports and background exports, which go to the
    // engine without engine()
    tagged: Tagged,
    // export_images' running jobs, which export_cancel stops
    export_cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    // move_files' running jobs, which move_cancel stops
    move_cancels: Mutex<HashMap<u64, Arc<AtomicBool>>>,
    presets_path: PathBuf,
    preview_path: PathBuf,
    range_path: PathBuf,
    denoise_path: PathBuf,
    looks_dir: PathBuf,
    // looks the user imported, beside the shipped ones (look_import)
    user_looks_dir: PathBuf,
    models_dir: PathBuf,
    // the folder being read; an older open_folder stops when it changes
    folder_token: AtomicU64,
    // Preferences' performance overlay: renders collect darktable's per-module
    // timings while it is on, and its reports are written to perf_dir
    perf_on: AtomicBool,
    perf_last: Mutex<Vec<Timing>>,
    perf_by_request: Mutex<HashMap<u64, Vec<Timing>>>,
    perf_modules_dropped: AtomicU64,
    perf_dir: PathBuf,
    runtime: PathBuf,
    // darktable's resource level the engine started with (a respawn reads it again)
    resource_level: Mutex<String>,
    // whether the engine started with its edits on the GPU
    gpu_edits: AtomicBool,
    // the engine's connection, for restart and its state events
    engine_link: Arc<engine::Link>,
    // Drop after Engine so it cannot still be writing into this directory.
    _frame_output: Arc<frame_output::FrameOutput>,
}

impl AppState {
    // the engine for requests its main loop serves, one at a time. request()
    // is the one to use for a single request; this is for a few in a row on
    // the open photo, which import nothing. LOCK ORDER: the Engine mutex is
    // never taken with a photo's import gate held, nor the gate under it
    // (Tagged::resolve)
    fn engine(&self, operation: &'static str) -> perf_trace::Guard<'_, Engine> {
        let mut guard = blocking(|| self.engine.lock(operation, None));
        guard.set_operation(operation);
        guard
    }

    // one request its main loop serves. its cached photos are imported first,
    // without the engine lock (Tagged::resolve), so nothing waits for the
    // lock behind a slow share's import. waiting for the lock, and the
    // request, give up their async worker (blocking), so a queue of them
    // cannot stall every other command. the ids' bookkeeping follows the
    // engine's order, under the lock; the search cache's SQLite update runs
    // once it is let go. a respawn between the import and the lock imports
    // again, twice at most; nothing has been sent by then
    fn request(&self, operation: &'static str, req: Value) -> Result<Value, String> {
        self.request_then(operation, req, Ok)
    }

    // request(), with `then` run on the reply while the lock is still held:
    // for a reply whose output file the next request would overwrite. an
    // import that met a respawn waits for it (the respawn holds the lock)
    // and imports again
    fn request_then<T>(&self, operation: &'static str, req: Value,
                       then: impl FnOnce(Value) -> Result<T, String>) -> Result<T, String> {
        blocking(|| {
            let mut then = Some(then);
            for attempt in 0..3 {
                match self.tagged.resolve(&req) {
                    Err(e) if attempt < 2 && self.tagged.restarted(&e) => {
                        drop(self.engine.lock(operation, None));
                        continue;
                    }
                    other => other?,
                }
                let asked = Instant::now();
                let mut engine = self.engine.lock(operation, None);
                engine.set_operation(operation);
                let waited = asked.elapsed();
                let result = engine.request_unsettled(req.clone());
                let link = engine.link();
                let result = result.and_then(|(sent, reply)| {
                    let affected = link.note_ids(&sent, &reply);
                    Ok((affected, then.take().expect("run once")(reply)?))
                });
                let log = engine.log_sink();
                drop(engine);
                let held = asked.elapsed() - waited;
                if waited > SLOW_LOCK || held > SLOW_LOCK {
                    log.note(&format!("[immage] {operation}: waited {} ms for the engine, then {} ms",
                                      waited.as_millis(), held.as_millis()));
                }
                match result {
                    Ok((affected, out)) => {
                        link.update_search_cache(affected);
                        return Ok(out);
                    }
                    Err(e) if e == engine::NEEDS_IMPORT => continue,
                    Err(e) => return Err(e),
                }
            }
            Err("the photo is no longer available to the engine; open its folder again".into())
        })
    }
}

// an engine lock wait or request this long is noted in engine.log
const SLOW_LOCK: Duration = Duration::from_secs(1);

// runs `f`, which blocks, without holding up the async runtime: on one of
// its workers, tokio first hands the worker's other tasks to another
// thread (block_in_place). elsewhere `f` just runs
pub(crate) fn blocking<T>(f: impl FnOnce() -> T) -> T {
    match tokio::runtime::Handle::try_current() {
        Ok(h) if h.runtime_flavor() == tokio::runtime::RuntimeFlavor::MultiThread => tokio::task::block_in_place(f),
        _ => f(),
    }
}

// the checkout this app is built from: the dev build runs the engine from
// its build/ tree, and keeps runtime state there too
fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..")
}

// Linux: the folder holding the web extension for shared-memory frames
// (webext/frames.c), built by build_appimage.sh: in the bundle's
// resources, or in a dev build the checkout's. none, and frames come
// through Tauri's reply
#[cfg(target_os = "linux")]
fn webext_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let dir = if cfg!(debug_assertions) {
        repo_root().join("app/src-tauri/resources/webext")
    } else {
        app.path().resource_dir().ok()?.join("webext")
    };
    dir.join("libimmage-frames.so").is_file().then_some(dir)
}

// workers for Tauri's async runtime. most commands are async and wait for
// the engine on the std mutex inside AppState::engine, which parks the
// worker running them: with only one worker per core, as Tauri's default
// runtime has, a slow request (a save, a large open) with a few commands
// queued behind it would park every worker, and commands that never touch
// the engine (folder listings, thumbnails from the cache, Immich) would wait
// too. the margin covers the engine commands the page has in flight at once.
// the runtime lives until the process exits, as Tauri's own default does
// (a static it never drops), so shutdown is unchanged
const ENGINE_WAITERS: usize = 8;

fn async_workers(cores: usize) -> usize {
    cores.max(1) + ENGINE_WAITERS
}

fn defer_window_creation(context: &mut tauri::Context<tauri::Wry>) {
    for window in &mut context.config_mut().app.windows {
        window.create = false;
    }
}

fn main() {
    let mut context = tauri::generate_context!();
    // before GTK and WebKit start, and before any other thread
    #[cfg(target_os = "linux")]
    renderer::init(&context.config().identifier).expect("cannot select the webview renderer");
    // Tauri otherwise creates configured windows before setup. Wait until the
    // app state and settings store are registered before their pages can call
    // commands. Linux also needs its frame extension installed before build.
    defer_window_creation(&mut context);
    // after renderer::init, which needs to run before any other thread
    let runtime = Box::leak(Box::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(async_workers(std::thread::available_parallelism().map_or(4, |n| n.get())))
            .enable_all()
            .build()
            .expect("cannot start the async runtime"),
    ));
    tauri::async_runtime::set(runtime.handle().clone());
    // the first argument naming a file or folder; macOS adds -psn_... to apps it starts
    let arg = std::env::args_os().skip(1)
        .filter(|a| !a.to_string_lossy().starts_with('-'))
        .find_map(|a| launch_path(Path::new(&a)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin({
            let updater = tauri_plugin_updater::Builder::new();
            // NSIS /D must be last and unquoted, including paths with spaces.
            // Pin updates to the running installation when both scopes exist.
            #[cfg(target_os = "windows")]
            let updater = match std::env::current_exe() {
                Ok(exe) => match exe.parent() {
                    Some(dir) => updater.installer_arg(format!("/D={}", dir.display())),
                    None => updater,
                },
                Err(_) => updater,
            };
            updater.build()
        })
        .plugin(tauri_plugin_process::init())
        // the main window opens as it was last closed. not its visibility, which
        // the splash sets (Splash.tsx), nor full screen, which only Full Screen
        // Preview enters
        .plugin(tauri_plugin_window_state::Builder::new()
            .with_state_flags(tauri_plugin_window_state::StateFlags::SIZE
                | tauri_plugin_window_state::StateFlags::POSITION
                | tauri_plugin_window_state::StateFlags::MAXIMIZED)
            .with_denylist(&["splash"])
            .build())
        // its own catalog, thumbnails and Immich key, apart from the standalone importer's
        .plugin(tauri_plugin_immporter::init(tauri_plugin_immporter::Config {
            data_subdir: Some("immporter".into()),
            keychain_from: None,
        }))
        .manage(Launch(Mutex::new(arg)))
        // custom items reach the page by id; predefined ones act natively
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().as_ref());
        })
        .setup(|app| {
            memory_budget::watch(app.handle().clone());
            // a dev build runs the engine from the checkout's build/ tree; a
            // bundled app carries its own (scripts/bundle_engine.py) and keeps
            // the engine's config and cache in its data folder
            let engine_exe = format!("darktable-engine{}", std::env::consts::EXE_SUFFIX);
            // GUI benchmark reports go with the checkout's benchmarks in a dev build
            let (default_bin, runtime, looks_dir, models_dir, perf_dir) = if cfg!(debug_assertions) {
                let root = repo_root();
                (root.join("build/bin").join(&engine_exe), root.join("build/app-runtime"),
                 root.join("app/looks"), root.join("build/ai-models"), root.join("benchmarking/results/gui"))
            } else {
                let res = app.path().resource_dir()?;
                let data = app.path().app_data_dir()?;
                (res.join("darktable/bin").join(&engine_exe), data.clone(), res.join("looks"), data.join("models"),
                 data.join("benchmarks"))
            };
            let bin = std::env::var_os("DT_ENGINE_BIN").map(PathBuf::from).unwrap_or(default_bin);
            // one-time move of the old loose files; the engine flags below
            // then read settings.json
            let settings = settings::Settings::load(&runtime);
            if let Err(e) = settings.migrate() {
                eprintln!("settings: cannot move the old preference files: {e}");
            }
            app.manage(settings);
            let search_cache = match search_cache::SearchCache::open(&runtime.join("search-cache.sqlite")) {
                Ok(cache) => Some(Arc::new(cache)),
                Err(e) => { eprintln!("local search disabled for this session: {e}"); None }
            };
            let resource_level = engine::resource_level(&runtime);
            let gpu_edits = engine::gpu_edits(&runtime);
            let engine = Engine::spawn(&bin, &runtime, &models_dir)
                .map_err(|e| format!("cannot start {}: {e}", bin.display()))?;
            // after the spawn, which may start engine.log afresh
            stall_watch::start(app.handle().clone(), runtime.join("engine.log"));
            engine.set_search_cache(search_cache.clone());
            let analysis_queue = Arc::new(analysis_queue::AnalysisQueue::new(engine::thumb_threads(&runtime) as usize, 256));
            analysis_queue.pause(settings::read_key(&runtime,search_cmds::PAUSED).as_deref()==Some("1"));
            search_reconcile::startup(search_cache.clone(), &runtime, &analysis_queue, app.handle());
            let frame_output = Arc::new(frame_output::FrameOutput::new(&runtime));
            let engine_link = engine.link();
            let events = app.handle().clone();
            engine_link.set_events(move |event| { let _ = events.emit("engine-state", event); });
            let clip_models = Arc::new(clip_models::Models::new(runtime.join("clip-models")));
            let clip_providers = Arc::new(clip_providers::ProbeCache::new());
            // yields to the user's photo work (Tagged::quiet_for); the thread opens the file
            let mirror = {
                let tagged = engine.tagged();
                morf_mirror::Mirror::start(&runtime, move || tagged.quiet_for())
            };
            {
                // the sync thread calls this with no lock held
                let events = app.handle().clone();
                mirror.set_events(move |dirs, all| {
                    let _ = events.emit("mirror-changed", serde_json::json!({ "dirs": dirs, "all": all }));
                });
            }
            let search_analysis = search_analysis::start(
                app.handle().clone(),
                search_cache.clone(),
                clip_models.clone(),
                clip_providers.clone(),
                analysis_queue.clone(),
                engine.tagged(),
                frame_output.clone(),
                runtime.clone(),
            );
            app.manage(AppState {
                mirror,
                search_analysis,
                search_cache,
                analysis_queue,
                search_clear_lock: Mutex::new(()),
                local_search_requests: Arc::new(local_search_cmds::Requests::default()),
                clip_models,
                clip_providers,
                base_cancel: engine.base_cancel(),
                tagged: engine.tagged(),
                export_cancels: Mutex::new(HashMap::new()),
                move_cancels: Mutex::new(HashMap::new()),
                engine: perf_trace::TracedMutex::new(engine),
                frame_path: frame_output.path("frame.rgba"),
                denoise_path: frame_output.path("denoise-preview.f32"),
                presets_path: runtime.join("presets.json"),
                preview_path: frame_output.path("preview.rgba"),
                range_path: frame_output.path("range.bin"),
                looks_dir,
                user_looks_dir: runtime.join("looks"),
                models_dir,
                folder_token: AtomicU64::new(0),
                perf_on: AtomicBool::new(false),
                perf_last: Mutex::new(Vec::new()),
                perf_by_request: Mutex::new(HashMap::new()),
                perf_modules_dropped: AtomicU64::new(0),
                perf_dir,
                runtime: runtime.clone(),
                resource_level: Mutex::new(resource_level),
                gpu_edits: AtomicBool::new(gpu_edits),
                engine_link,
                _frame_output: frame_output,
            });
            let handle = app.handle().clone();
            std::thread::spawn(move || supervise(handle));
            app.manage(plugins::Plugins::new(runtime.join("plugin-returns.json")));
            // the share roots, for telling an unmounted share from an empty
            // folder; reads the importer's SQLite, so off the event loop
            let (handle, root_runtime) = (app.handle().clone(), runtime.clone());
            std::thread::spawn(move || clip_providers::refresh_share_roots(&handle, &root_runtime));
            // stacks saved in Macro Studio while Immage was closed
            let handle = app.handle().clone();
            std::thread::spawn(move || handle.state::<plugins::Plugins>().drain_jobs());
            app.manage(support_bundle::BundleState::default());
            app.manage(Caches::new(&app.path().app_cache_dir()?));
            // Build the configured pages only after every command dependency
            // is managed, including on platforms where Tauri normally creates
            // windows before setup.
            #[cfg(target_os = "linux")]
            let dir = webext_dir(app.handle());
            for config in app.config().app.windows.clone() {
                let window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
                #[cfg(target_os = "linux")]
                let window = if let Some(dir) = &dir {
                    window.extensions_path(dir)
                } else {
                    window
                };
                #[cfg(target_os = "linux")]
                let window = window.build()?;
                #[cfg(target_os = "linux")]
                pinch::install(&window);
                #[cfg(not(target_os = "linux"))]
                let _window = window.build()?;
            }
            #[cfg(target_os = "linux")]
            shm_frame::sweep();
            Ok(())
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("error while running Immage");
    app.run(|_app, _event| {
        if matches!(_event, tauri::RunEvent::Exit) {
            _app.state::<AppState>().search_analysis.stop();
            _app.state::<AppState>().mirror.stop();
            _app.state::<AppState>().local_search_requests.cancel_all();
            _app.state::<AppState>().analysis_queue.pause(true);
            _app.state::<AppState>().analysis_queue.cancel();
            _app.state::<AppState>().clip_models.cancel();
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &_event {
            if let Some(p) = urls.iter().filter_map(|u| u.to_file_path().ok()).find_map(|p| launch_path(&p)) {
                *_app.state::<Launch>().0.lock().unwrap() = Some(p);
                let _ = _app.emit("launch-file", ());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn async_workers_leave_room_beside_engine_waiters() {
        assert_eq!(async_workers(0), 1 + ENGINE_WAITERS);
        assert_eq!(async_workers(4), 4 + ENGINE_WAITERS);
    }

    #[test]
    fn configured_windows_are_deferred_on_every_platform() {
        let mut context = tauri::generate_context!();
        defer_window_creation(&mut context);
        assert!(context.config().app.windows.iter().all(|window| !window.create));
        assert_eq!(context.config().app.windows.len(), 2);

        let setup = include_str!("main.rs");
        let settings = setup.find("app.manage(settings)").unwrap();
        let state = setup.find("app.manage(AppState {").unwrap();
        let windows = setup.find("for config in app.config().app.windows.clone()").unwrap();
        assert!(settings < windows, "windows must wait for the settings store");
        assert!(state < windows, "windows must wait for application state");
    }

    // a command waiting for the engine lock gives up its worker: with one
    // worker and the lock held, another command still runs
    #[test]
    fn a_wait_for_the_engine_leaves_the_runtime_free() {
        use std::sync::{mpsc, Arc, Mutex};
        let runtime = tokio::runtime::Builder::new_multi_thread().worker_threads(1).build().unwrap();
        let lock = Arc::new(Mutex::new(()));
        let held = lock.lock().unwrap();
        let (waiting, waited) = mpsc::channel();
        let waiter = lock.clone();
        runtime.spawn(async move {
            super::blocking(|| drop(waiter.lock().unwrap()));
            waiting.send(()).unwrap();
        });
        std::thread::sleep(std::time::Duration::from_millis(50));
        let (ran, done) = mpsc::channel();
        runtime.spawn(async move { ran.send(()).unwrap(); });
        assert!(done.recv_timeout(std::time::Duration::from_secs(5)).is_ok(), "the runtime stalled");
        drop(held);
        assert!(waited.recv_timeout(std::time::Duration::from_secs(5)).is_ok());
    }
}

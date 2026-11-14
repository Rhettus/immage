// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// a windowed program on Windows: without it Windows starts the app with a
// console window of its own. debug builds keep theirs, for the log
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod cache;
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
use tauri::{Emitter, Manager};
#[cfg(target_os = "linux")]
use crate::session_cmds::shm_frame;
use crate::library_cmds::launch_path;
use crate::library_cmds::Launch;
use crate::app_cmds::supervise;

struct AppState {
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
    // the engine for a request its main loop serves, one at a time
    fn engine(&self, operation: &'static str) -> perf_trace::Guard<'_, Engine> {
        let mut guard = self.engine.lock(operation, None);
        guard.set_operation(operation);
        guard
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

fn main() {
    #[allow(unused_mut)]
    let mut context = tauri::generate_context!();
    // before GTK and WebKit start, and before any other thread
    #[cfg(target_os = "linux")]
    renderer::init(&context.config().identifier).expect("cannot select the webview renderer");
    // Linux: setup builds the windows, with the web extension that hands
    // frames over (webext_dir); it has to be in place before their web
    // process starts
    #[cfg(target_os = "linux")]
    for w in &mut context.config_mut().app.windows {
        w.create = false;
    }
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
            #[cfg(target_os = "linux")]
            {
                let dir = webext_dir(app.handle());
                for config in app.config().app.windows.clone() {
                    let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
                    if let Some(dir) = &dir {
                        window = window.extensions_path(dir);
                    }
                    pinch::install(&window.build()?);
                }
                shm_frame::sweep();
            }
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
            let resource_level = engine::resource_level(&runtime);
            let gpu_edits = engine::gpu_edits(&runtime);
            let engine = Engine::spawn(&bin, &runtime, &models_dir)
                .map_err(|e| format!("cannot start {}: {e}", bin.display()))?;
            let frame_output = Arc::new(frame_output::FrameOutput::new(&runtime));
            let engine_link = engine.link();
            let events = app.handle().clone();
            engine_link.set_events(move |event| { let _ = events.emit("engine-state", event); });
            app.manage(AppState {
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
            // stacks saved in Macro Studio while Immage was closed
            let handle = app.handle().clone();
            std::thread::spawn(move || handle.state::<plugins::Plugins>().drain_jobs());
            app.manage(support_bundle::BundleState::default());
            app.manage(Caches::new(&app.path().app_cache_dir()?));
            Ok(())
        })
        .invoke_handler(bindings::handler())
        .build(context)
        .expect("error while running Immage");
    app.run(|_app, _event| {
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
}

// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use crate::engine::Timing;
use serde::Deserialize;
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use crate::typed_app::{Level, Licenses, ParityReply, Toggle};
use tauri::{AppHandle, Manager, State};
use crate::AppState;
use crate::ai_cmds::no_console;
#[cfg(target_os = "linux")]
use crate::renderer;
use crate::settings;
#[cfg(target_os = "linux")]
use crate::scale;
use crate::engine;
use crate::bindings;
use crate::repo_root;

// the performance overlay: on, renders collect darktable's per-module timings
#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_set(state: State<'_, AppState>, on: bool) -> Result<(), String> {
    state.perf_on.store(on, Ordering::Relaxed);
    Ok(())
}

// a content security policy violation the page saw (tauri.conf.json, csp),
// one line in webview.log in the runtime folder. the page dedupes and caps
// what it sends; the file is also capped here, so a page cannot fill the disk
#[tauri::command]
#[specta::specta]
pub(crate) fn csp_violation(state: State<'_, AppState>, directive: String, blocked: String, source: String, line: u32, sample: String) {
    use std::io::Write;
    let path = state.runtime.join("webview.log");
    if std::fs::metadata(&path).map(|m| m.len() > 1_000_000).unwrap_or(false) {
        return;
    }
    let clip = |t: &str| t.chars().take(300).map(|c| if c.is_control() { ' ' } else { c }).collect::<String>();
    let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    if let Ok(mut log) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
        let _ = writeln!(log, "[{since}] csp violation: {} blocked={} source={}:{} sample={}", clip(&directive), clip(&blocked), clip(&source), line, clip(&sample));
    }
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_trace_start(state: State<'_, AppState>) -> Result<(), String> {
    state.perf_by_request.lock().unwrap().clear();
    state.perf_modules_dropped.store(0, Ordering::Relaxed);
    state.engine("perf_trace_start").cache_trace(true)?;
    state.engine.start();
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_trace_stop(state: State<'_, AppState>) -> Result<(), String> {
    state.engine.stop();
    state.engine("perf_trace_stop").cache_trace(false)?;
    Ok(())
}

// the last render's per-module timings, while the overlay is on
#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_modules(state: State<'_, AppState>, request: Option<u64>) -> Result<Vec<Timing>, String> {
    if let Some(id) = request {
        return state.perf_by_request.lock().unwrap().remove(&id).ok_or_else(|| "module timings for request unavailable".to_string());
    }
    Ok(state.perf_last.lock().unwrap().clone())
}

// the GPU check's comparison of one CPU and one GPU render of the edit
// (main.c, _parity), with each pass's module timings. a case that differs
// writes its amplified difference as <diff>.png in the reports folder
#[tauri::command]
#[specta::specta]
pub(crate) async fn gpu_check_parity(state: State<'_, AppState>, size: Option<u32>, diff: Option<String>,
                          self_check: Option<bool>) -> Result<ParityReply, String> {
    let mut req = json!({ "cmd": "parity", "size": size.unwrap_or(1024), "self": self_check.unwrap_or(false) });
    if let Some(name) = diff {
        if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
            return Err("bad diff name".into());
        }
        std::fs::create_dir_all(&state.perf_dir).map_err(|e| e.to_string())?;
        req["diff"] = json!(state.perf_dir.join(format!("{name}.png")).to_string_lossy());
    }
    let mut engine = state.engine("gpu_check_parity");
    // the marks around it keep earlier requests' timings out of its own
    engine.perf_mark();
    let reply = engine.request(req)?;
    let timings = engine.perf_mark();
    let mut passes: std::collections::BTreeMap<String, Vec<Timing>> = Default::default();
    let mut pass = String::new();
    for t in timings {
        if t.kind == "pass" {
            pass = t.label.clone();
            passes.insert(pass.clone(), Vec::new());
        } else if let Some(list) = passes.get_mut(&pass) {
            // the check pipe is a full pipe; a thumbnail or preview drawn
            // meanwhile on another thread is not part of its pass
            if t.pipe.is_empty() || t.pipe == "full" { list.push(t); }
        }
    }
    let mut parity: ParityReply = serde_json::from_value(reply).map_err(|e| format!("unexpected parity reply: {e}"))?;
    parity.modules = passes;
    Ok(parity)
}

// does nothing: the GUI benchmark times a call's round trip on its own,
// the cost every engine call pays on top of its work
#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_ping() -> Result<(), String> {
    Ok(())
}

// a GUI benchmark's report, as <name>.json in the reports folder; its path back
#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_report_write(state: State<'_, AppState>, name: String, mut report: Value) -> Result<String, String> {
    if name.is_empty() || name.contains(['/', '\\']) || name.starts_with('.') {
        return Err("bad report name".into());
    }
    std::fs::create_dir_all(&state.perf_dir).map_err(|e| e.to_string())?;
    let path = state.perf_dir.join(format!("{name}.json"));
    let (spans, dropped, unfinished) = state.engine.snapshot();
    report["build"] = json!({ "commit": BUILD_COMMIT, "dirty": build_dirty() });
    if report["diagnostics"]["enabled"].as_bool() == Some(true) {
        report["diagnostics"]["cache"] = state.engine("perf_cache_report").cache_report();
        report["diagnostics"]["native"] = json!({ "clock": "native monotonic milliseconds; independent of frontend clock",
            "droppedSpans": dropped, "droppedModuleTimings":state.perf_modules_dropped.load(Ordering::Relaxed),
            "unfinished": unfinished.iter().map(|s| json!({ "id":s.id, "requestId":s.request, "operation":s.operation, "waitAt":s.wait, "acquiredAt":s.acquired })).collect::<Vec<_>>(),
            "scope": "AppState engine mutex; tagged/background engine traffic is outside this mutex",
            "releaseMarker": "before guard destruction; excludes instrumentation and unlock overhead",
            "spans": spans.iter().map(|s| json!({ "id": s.id, "requestId": s.request, "operation": s.operation,
                "waitAt": s.wait, "acquiredAt": s.acquired, "releasedAt": s.released, "outputMs": s.output_ms.map(|t| json!({
                    "allocate":t[0], "convert":t[1], "file":t[2], "free":t[3] })) })).collect::<Vec<_>>() });
    }
    let text = serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

// the system's own id for this machine, hashed: reports get passed around
// to compare machines, and the raw hardware UUID need not go with them.
// benchmarking/bench.py (machine_id) hashes it the same way, so engine runs
// and GUI reports from one machine match
fn machine_id() -> Option<String> {
    use sha2::{Digest, Sha256};
    let run = |prog: &str, args: &[&str]| {
        let mut cmd = std::process::Command::new(prog);
        cmd.args(args);
        no_console(&mut cmd);
        cmd.output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
    };
    let raw = if cfg!(target_os = "macos") {
        // "IOPlatformUUID" = "XXXXXXXX-..."
        run("ioreg", &["-rd1", "-c", "IOPlatformExpertDevice"])?.lines()
            .find(|l| l.contains("\"IOPlatformUUID\""))
            .and_then(|l| l.rsplit('"').nth(1).map(str::to_string))
    } else if cfg!(windows) {
        // "    MachineGuid    REG_SZ    xxxxxxxx-..."
        run("reg", &["query", r"HKLM\SOFTWARE\Microsoft\Cryptography", "/v", "MachineGuid"])?.lines()
            .find(|l| l.contains("MachineGuid"))
            .and_then(|l| l.split_whitespace().last().map(str::to_string))
    } else {
        ["/etc/machine-id", "/var/lib/dbus/machine-id"].iter().find_map(|p| std::fs::read_to_string(p).ok())
    }?;
    let raw = raw.trim();
    if raw.is_empty() {
        return None;
    }
    let hash = Sha256::digest(format!("immage-bench:{raw}"));
    Some(hash.iter().take(6).map(|b| format!("{b:02x}")).collect())
}

// the id reports carry: the hashed system id, or, where the system gives none,
// a random one made once per install and kept in `dir`. Never the host name.
fn report_machine_id(dir: Option<&Path>) -> Option<String> {
    if let Some(id) = machine_id() {
        return Some(id);
    }
    let file = dir?.join("machine-id");
    if let Ok(text) = std::fs::read_to_string(&file) {
        let t = text.trim();
        if t.len() == 12 && t.chars().all(|c| c.is_ascii_hexdigit()) {
            return Some(t.to_string());
        }
    }
    use sha2::{Digest, Sha256};
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let local = 0u8;
    let hash = Sha256::digest(format!("immage-install:{now}:{}:{:p}", std::process::id(), &local));
    let id: String = hash.iter().take(6).map(|b| format!("{b:02x}")).collect();
    std::fs::create_dir_all(dir?).ok()?;
    std::fs::write(&file, &id).ok()?;
    Some(id)
}

// the web view's EGL override is kept out of the image engine
#[cfg(target_os = "linux")]
pub(crate) static WEBVIEW_EGL_OVERRIDE: AtomicBool = AtomicBool::new(false);

#[tauri::command]
#[specta::specta]
pub(crate) fn webview_renderer() -> Option<renderer::Status> {
    #[cfg(target_os = "linux")]
    return renderer::status();
    #[cfg(not(target_os = "linux"))]
    None
}

#[tauri::command]
#[specta::specta]
pub(crate) fn webview_renderer_set(settings: State<'_, settings::Settings>, mode: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    return renderer::set(&settings, &mode);
    #[cfg(not(target_os = "linux"))]
    { let _ = (settings, mode); Err("webview renderer selection is available on Linux".into()) }
}

// what decides how a frame reaches the screen on Linux: the session
// (Wayland or X11) and desktop, and the GDK and WebKit settings, as this
// process has them; an AppImage's start-up hooks can set some itself
fn display_env() -> Value {
    let var = |k: &str| std::env::var(k).ok();
    let mut vars: Map<String, Value> = std::env::vars()
        .filter(|(k, _)| k.starts_with("WEBKIT_") || k.starts_with("__GL_") || k.starts_with("__NV_")
                || k.starts_with("__EGL_"))
        .map(|(k, v)| (k, Value::String(v)))
        .collect();
    for k in ["GDK_BACKEND", "LIBGL_ALWAYS_SOFTWARE"] {
        if let Some(v) = var(k) {
            vars.insert(k.to_string(), Value::String(v));
        }
    }
    json!({
        "sessionType": var("XDG_SESSION_TYPE"),
        "desktop": var("XDG_CURRENT_DESKTOP"),
        "wayland": var("WAYLAND_DISPLAY").is_some(),
        "x11": var("DISPLAY").is_some(),
        "vars": vars,
        "renderer": webview_renderer(),
    })
}

// the machine block of a GUI benchmark report and the support bundle
pub(crate) fn machine_block(dir: Option<&Path>, opencl: Option<Value>) -> Value {
    use sysinfo::{CpuRefreshKind, MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_cpu(CpuRefreshKind::nothing())
                                             .with_memory(MemoryRefreshKind::nothing().with_ram()));
    json!({
        "id": report_machine_id(dir),
        "os": System::long_os_version(),
        "arch": System::cpu_arch(),
        "cpu": sys.cpus().first().map(|c| c.brand().trim().to_string()),
        "cores": sys.cpus().len(),
        "memoryGb": (sys.total_memory() as f64 / (1u64 << 30) as f64).round(),
        "opencl": opencl,
        "display": display_env(),
        // the user agent's version is frozen; this is WebKitGTK's,
        // WebView2's or WKWebView's own
        "webview": tauri::webview_version().ok(),
    })
}

// the machine a GUI benchmark ran on: a stable id to group reports by, and
// what it is
#[tauri::command]
#[specta::specta]
pub(crate) async fn perf_machine(app: AppHandle, state: State<'_, AppState>) -> Result<Value, String> {
    let opencl = state.engine("perf_machine").request(json!({ "cmd": "opencl" })).ok()
        .map(|mut r| { if let Some(o) = r.as_object_mut() { o.remove("ok"); } r });
    let dir = app.path().app_data_dir().ok();
    tauri::async_runtime::spawn_blocking(move || machine_block(dir.as_deref(), opencl))
    .await
    .map_err(|e| e.to_string())
}

// the screen's real scale where it is less than the whole one GTK draws
// the window at (Wayland at 125%: 1.25 against 2), so the viewer sizes
// frames for the screen; none elsewhere. an error until the window is on a
// screen, as at start: the page asks again. not async: GTK's monitor is
// read on the main thread
#[tauri::command]
#[specta::specta]
pub(crate) fn display_scale(window: tauri::WebviewWindow) -> Result<Option<serde_json::Number>, String> {
    #[cfg(target_os = "linux")]
    {
        let monitor = window.current_monitor().ok().flatten().ok_or("not on a screen yet")?;
        let whole = monitor.scale_factor();
        let p = monitor.position();
        let at = ((p.x as f64 / whole).round() as i32, (p.y as f64 / whole).round() as i32);
        Ok(scale::output_scale(at).filter(|s| *s < whole - 0.01).and_then(serde_json::Number::from_f64))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = window;
        Ok(None)
    }
}

// Preferences' darktable memory: the level the engine runs at, and the one
// its next start takes
#[tauri::command]
#[specta::specta]
pub(crate) fn darktable_resources(state: State<'_, AppState>) -> Level {
    Level { running: state.resource_level.lock().unwrap().clone(), next: engine::resource_level(&state.runtime) }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn darktable_resources_set(settings: State<'_, settings::Settings>, level: String) -> Result<(), String> {
    engine::set_resource_level(&settings, &level)
}

// Preferences' GPU edits: whether the engine runs with them, and whether
// its next start will
#[tauri::command]
#[specta::specta]
pub(crate) fn gpu_edits(state: State<'_, AppState>) -> Toggle {
    Toggle { running: state.gpu_edits.load(Ordering::Relaxed), next: engine::gpu_edits(&state.runtime) }
}

#[tauri::command]
#[specta::specta]
pub(crate) fn gpu_edits_set(settings: State<'_, settings::Settings>, on: bool) -> Result<(), String> {
    engine::set_gpu_edits(&settings, on)
}

// the commit this app was built from and whether the tree had uncommitted
// changes (build.rs); both are absent when it was built outside Git
const BUILD_COMMIT: Option<&str> = option_env!("IMMAGE_BUILD_COMMIT");

fn build_dirty() -> Option<bool> {
    option_env!("IMMAGE_BUILD_DIRTY").map(|s| s == "true")
}

// the commit as shown to people: ten digits, as darktable's version gives
// its own, and "-dirty" for a tree with changes
pub(crate) fn build_label() -> Option<String> {
    BUILD_COMMIT.map(|c| format!("{}{}", &c[..c.len().min(10)], if build_dirty() == Some(true) { "-dirty" } else { "" }))
}

// Immage's version and commit, for the splash: answered at once, without
// waiting for the engine as `about` does
#[tauri::command]
#[specta::specta]
pub(crate) fn build(app: AppHandle) -> bindings::BuildInfo {
    bindings::BuildInfo { app: app.package_info().version.to_string(), commit: build_label() }
}

// Immage's version and commit and the darktable its engine was built
// from, for Preferences and the GPU check's report
#[tauri::command]
#[specta::specta]
pub(crate) async fn about(app: AppHandle, state: State<'_, AppState>) -> Result<bindings::AboutInfo, String> {
    let reply = state.engine("about").request(json!({ "cmd": "version" }))?;
    Ok(bindings::AboutInfo {
        app: app.package_info().version.to_string(),
        commit: build_label(),
        darktable: reply["version"].as_str().unwrap_or_default().to_string(),
    })
}

// the license texts the GPL requires to travel with the app, for
// Preferences' About: the GPL itself, the index of the bundled
// libraries' licenses with the folder holding their texts
// (scripts/bundle_engine.py), and the notices of the crates and packages
// compiled into the app (scripts/notices.mjs). each is null when missing,
// as in a development build that has not bundled the engine
#[tauri::command]
#[specta::specta]
pub(crate) fn licenses(app: AppHandle) -> Result<Licenses, String> {
    let (gpl, libs, notices) = if cfg!(debug_assertions) {
        let res = repo_root().join("app/src-tauri/resources");
        (repo_root().join("LICENSE"), res.join("darktable/share/licenses"), res.join("notices.txt"))
    } else {
        let res = app.path().resource_dir().map_err(|e| e.to_string())?;
        (res.join("LICENSE"), res.join("darktable/share/licenses"), res.join("notices.txt"))
    };
    let index = libs.join("INDEX.txt");
    Ok(Licenses {
        gpl: std::fs::read_to_string(&gpl).ok(),
        libraries: std::fs::read_to_string(&index).ok(),
        libraries_path: index.exists().then(|| index.to_string_lossy().into_owned()),
        notices: std::fs::read_to_string(&notices).ok(),
    })
}

// before an update is installed: the installer replaces the engine's files,
// which Windows will not do while they are in use
#[tauri::command]
#[specta::specta]
pub(crate) async fn engine_quit(state: State<'_, AppState>) -> Result<(), String> {
    state.engine("engine_quit").quit();
    Ok(())
}

// the user's restart of an engine that is not answering: kills it without
// the engine lock, which its request holds. the request fails with the exit
// error and the supervisor starts another (engine-state down, then ready)
#[tauri::command]
#[specta::specta]
pub(crate) fn engine_restart(state: State<'_, AppState>) {
    state.engine_link.restart();
}

// keeps the engine running: when it exits, tells the page, starts another
// and tells the page again. three restarts within a minute are a crash
// loop, and it gives up (state "failed"); a restart asked for does not count
pub(crate) fn supervise(app: AppHandle) {
    let state = app.state::<AppState>();
    let link = state.engine_link.clone();
    let mut budget = engine::RestartBudget::new(3, Duration::from_secs(60));
    while let Some(epoch) = link.wait_dead() {
        let manual = link.take_manual();
        link.emit(json!({ "state": "down", "epoch": epoch }));
        // exports in flight have lost their engine
        state.export_cancels.lock().unwrap().clear();
        if !manual && !budget.allow(Instant::now()) {
            link.emit(json!({ "state": "failed" }));
            return;
        }
        // the failed request has released the lock by now
        let mut engine = state.engine("engine_respawn");
        if link.quitting() {
            return;
        }
        match engine.respawn() {
            Ok(()) => {
                *state.resource_level.lock().unwrap() = engine::resource_level(&state.runtime);
                state.gpu_edits.store(engine::gpu_edits(&state.runtime), Ordering::Relaxed);
                link.emit(json!({ "state": "ready", "epoch": engine.epoch() }));
            }
            Err(e) => {
                eprintln!("engine respawn failed: {e}");
                link.emit(json!({ "state": "failed" }));
                return;
            }
        }
    }
}

// the menu spec lives in app/src/menu.ts so the drawn Windows/Linux menu and
// this native one list the same items; Windows and Linux draw it in the title
// bar strip, as a native row there would take extra height
#[derive(Deserialize, specta::Type)]
pub(crate) struct NativeMenu {
    label: String,
    items: Vec<NativeItem>,
}

#[derive(Deserialize, specta::Type)]
#[serde(tag = "type", rename_all = "lowercase")]
pub(crate) enum NativeItem {
    Item { id: String, label: String, #[serde(default)] accel: Option<String> },
    Separator,
    Submenu { label: String, items: Vec<NativeItem> },
    Predefined { role: NativeRole },
}

#[derive(Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub(crate) enum NativeRole {
    About, Services, Hide, HideOthers, ShowAll, Quit, CloseWindow,
    Cut, Copy, Paste, Minimize, Zoom, Fullscreen,
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn native_items(app: &AppHandle, items: &[NativeItem]) -> tauri::Result<Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>>> {
    use tauri::menu::{MenuItemBuilder, PredefinedMenuItem as P, Submenu};
    let mut out: Vec<Box<dyn tauri::menu::IsMenuItem<tauri::Wry>>> = Vec::new();
    for it in items {
        out.push(match it {
            NativeItem::Item { id, label, accel } => {
                let mut b = MenuItemBuilder::with_id(id.as_str(), label);
                if let Some(a) = accel { b = b.accelerator(a); }
                Box::new(b.build(app)?)
            }
            NativeItem::Separator => Box::new(P::separator(app)?),
            NativeItem::Submenu { label, items } => {
                let kids = native_items(app, items)?;
                let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = kids.iter().map(|k| k.as_ref()).collect();
                Box::new(Submenu::with_items(app, label, true, &refs)?)
            }
            NativeItem::Predefined { role } => match role {
                NativeRole::About => Box::new(P::about(app, None, None)?),
                NativeRole::Services => Box::new(P::services(app, None)?),
                NativeRole::Hide => Box::new(P::hide(app, None)?),
                NativeRole::HideOthers => Box::new(P::hide_others(app, None)?),
                NativeRole::ShowAll => Box::new(P::show_all(app, None)?),
                NativeRole::Quit => Box::new(P::quit(app, None)?),
                NativeRole::CloseWindow => Box::new(P::close_window(app, None)?),
                NativeRole::Cut => Box::new(P::cut(app, None)?),
                NativeRole::Copy => Box::new(P::copy(app, None)?),
                NativeRole::Paste => Box::new(P::paste(app, None)?),
                NativeRole::Minimize => Box::new(P::minimize(app, None)?),
                NativeRole::Zoom => Box::new(P::maximize(app, None)?),
                NativeRole::Fullscreen => Box::new(P::fullscreen(app, None)?),
            },
        });
    }
    Ok(out)
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn build_menu(app: &AppHandle, menus: &[NativeMenu]) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, Submenu};
    let mut tops = Vec::new();
    for m in menus {
        let kids = native_items(app, &m.items)?;
        let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = kids.iter().map(|k| k.as_ref()).collect();
        tops.push(Submenu::with_items(app, &m.label, true, &refs)?);
    }
    let refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = tops.iter().map(|t| t as _).collect();
    Menu::with_items(app, &refs)
}

// async so it runs off the main thread: the menu API hops to it and waits
#[tauri::command]
#[specta::specta]
pub(crate) async fn menu_set(app: AppHandle, menus: Vec<NativeMenu>) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let menu = build_menu(&app, &menus).map_err(|e| e.to_string())?;
        app.set_menu(menu).map_err(|e| e.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, menus);
    Ok(())
}

// Full Screen Preview's window: macOS's simple full screen, which stays in
// the window's own Space. tao hands the keyboard to its own view at each
// change of the window's style (util::toggle_style_mask()), and that view
// beeps at every key it then passes on to the page; leaving makes the last
// change asynchronously, on the main queue (util::set_style_mask_async()).
// so the switch is made on the main thread, where it runs at once, and the
// web view takes the keyboard back in a block queued after tao's
#[tauri::command]
#[specta::specta]
pub(crate) fn preview_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let Some(webview) = handle.get_webview_window("main") else { return };
        let _ = webview.set_simple_fullscreen(on);
        let refocus = move || {
            let _ = webview.set_focus();
            let _ = AsRef::<tauri::Webview>::as_ref(&webview).set_focus();
        };
        #[cfg(target_os = "macos")]
        dispatch2::DispatchQueue::main().exec_async(refocus);
        #[cfg(not(target_os = "macos"))]
        refocus();
    }).map_err(|e| e.to_string())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_menu_spec_parses() {
        let spec = json!([{"label": "Immage", "items": [
            {"type": "predefined", "role": "hideOthers"},
            {"type": "separator"},
            {"type": "item", "id": "export", "label": "Export", "accel": "CmdOrCtrl+E"},
            {"type": "item", "id": "undo", "label": "Undo"},
            {"type": "submenu", "label": "More", "items": [{"type": "predefined", "role": "zoom"}]}
        ]}]);
        let m: Vec<NativeMenu> = serde_json::from_value(spec).unwrap();
        assert_eq!(m[0].items.len(), 5);
        assert!(matches!(&m[0].items[2], NativeItem::Item { id, accel: Some(_), .. } if id == "export"));
        assert!(matches!(&m[0].items[3], NativeItem::Item { accel: None, .. }));
        assert!(matches!(&m[0].items[0], NativeItem::Predefined { role: NativeRole::HideOthers }));
    }

    #[test]
    fn machine_id_is_stable() {
        let id = machine_id().expect("no machine id");
        assert_eq!(id.len(), 12);
        assert!(id.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(machine_id().as_deref(), Some(id.as_str()));
        println!("machine id {id}");
    }

    #[test]
    fn report_machine_id_without_a_system_id_is_kept() {
        if machine_id().is_some() {
            return;
        }
        let dir = std::env::temp_dir().join(format!("immage-mid-{}", std::process::id()));
        let first = report_machine_id(Some(&dir)).expect("no id");
        assert_eq!(first.len(), 12);
        assert_eq!(report_machine_id(Some(&dir)), Some(first));
        let _ = std::fs::remove_dir_all(&dir);
    }
}

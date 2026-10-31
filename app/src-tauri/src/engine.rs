// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the darktable-engine child process: one JSON request per line on its stdin,
// one JSON reply per line on its stdout
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Engine {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    // replies to request(), in order; read_stdout passes them on
    replies: Receiver<Value>,
    perf: Arc<Perf>,
    base: BaseCancel,
    tagged: Tagged,
}

// requests the engine serves on threads of its own beside its main loop:
// thumbnails (main.c, _thumb_run), folder imports (_import_run),
// background exports (_export_run), AI denoise (_denoise_run) and the AI
// selections' models (_ai_run).
// they are sent and answered while a request holds the engine. each is
// tagged, and read_stdout hands its reply to the caller waiting on that tag
#[derive(Clone)]
pub struct Tagged {
    stdin: Arc<Mutex<ChildStdin>>,
    waiting: Waiting,
    progress: Progress,
    last: Arc<AtomicU64>,
}

// the tagged requests sent and not yet answered, by tag; None once the
// engine has gone
type Waiting = Arc<Mutex<Option<HashMap<u64, Sender<Value>>>>>;

// what follows a tagged request's progress, by tag: the lines a merge
// writes before its reply (main.c, _merge_step), which have no `ok`
type Progress = Arc<Mutex<HashMap<u64, Box<dyn Fn(&Value) + Send>>>>;

impl Tagged {
    // a tag for the next request, unique for the engine's run
    pub fn tag(&self) -> u64 {
        self.last.fetch_add(1, Ordering::SeqCst) + 1
    }

    // blocks until the engine replies
    pub fn request(&self, tag: u64, mut req: Value) -> Result<Value, String> {
        req["tag"] = json!(tag);
        let answer = self.expect(tag)?;
        let sent = {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{req}").and_then(|_| stdin.flush())
        };
        if let Err(e) = sent {
            self.forget(tag);
            return Err(format!("engine write: {e}"));
        }
        answer.wait()
    }

    // the answer to `tag`, waited for once it is asked: before, so that it
    // is never read with no one waiting. a request the main loop answers
    // first, and a thread of the engine's later (ai_denoise), asks it
    // through Engine::request()
    pub fn expect(&self, tag: u64) -> Result<Answer, String> {
        let (tx, rx) = channel();
        self.waiting.lock().unwrap().as_mut().ok_or(ENGINE_EXITED)?.insert(tag, tx);
        Ok(Answer(rx))
    }

    // `tag` no longer waited for, as its request failed
    pub fn forget(&self, tag: u64) {
        self.waiting.lock().unwrap().as_mut().map(|w| w.remove(&tag));
    }

    // request() with each progress line of its handed to `progress`, on the
    // thread reading the engine's replies
    pub fn request_with_progress(&self, tag: u64, req: Value, progress: impl Fn(&Value) + Send + 'static)
                                 -> Result<Value, String> {
        self.progress.lock().unwrap().insert(tag, Box::new(progress));
        let reply = self.request(tag, req);
        self.progress.lock().unwrap().remove(&tag);
        reply
    }

    // a line that gets no reply, written while others wait on theirs, as
    // `merge_cancel` (main.c, _read_requests)
    pub fn send(&self, req: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{req}").and_then(|_| stdin.flush()).map_err(|e| format!("engine write: {e}"))
    }
}

pub struct Answer(Receiver<Value>);

impl Answer {
    // blocks until the engine replies
    pub fn wait(self) -> Result<Value, String> {
        // the sender is dropped unanswered when the engine exits
        let reply = self.0.recv().map_err(|_| ENGINE_EXITED.to_string())?;
        outcome(reply)
    }
}

const ENGINE_EXITED: &str = "the engine exited; see build/app-runtime/engine.log";

fn outcome(reply: Value) -> Result<Value, String> {
    if reply["ok"].as_bool() == Some(true) {
        Ok(reply)
    } else {
        Err(reply["error"].as_str().unwrap_or("engine request failed").to_string())
    }
}

// the engine's replies: a tagged one to the caller waiting on it, a tagged
// request's progress to what follows it, the rest to request() in order.
// at the end both sides' waits fail
fn read_stdout(stdout: ChildStdout, replies: Sender<Value>, waiting: Waiting, progress: Progress) {
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    loop {
        line.clear();
        match reader.read_line(&mut line) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let reply: Value = serde_json::from_str(&line)
            .unwrap_or_else(|e| json!({ "ok": false, "error": format!("engine reply: {e}") }));
        match reply["tag"].as_u64() {
            Some(tag) if reply["progress"].as_bool() == Some(true) => {
                if let Some(f) = progress.lock().unwrap().get(&tag) {
                    f(&reply);
                }
            }
            Some(tag) => {
                if let Some(tx) = waiting.lock().unwrap().as_mut().and_then(|w| w.remove(&tag)) {
                    let _ = tx.send(reply);
                }
            }
            None => {
                if replies.send(reply).is_err() {
                    break;
                }
            }
        }
    }
    *waiting.lock().unwrap() = None;
}

// stops the engine's idle base render while a request holds the engine: an
// edit need not wait out a base it makes stale. the line gets no reply, so
// it may go in between another request and its reply (main.c,
// _read_requests). bases are numbered, and a cancel stops every one so far
#[derive(Clone)]
pub struct BaseCancel {
    stdin: Arc<Mutex<ChildStdin>>,
    last: Arc<AtomicU64>,
}

// darktable's resource level, from Preferences: how much memory its caches
// and pipes may take (darktable.c, dt_get_available_mem). darktable reads
// it once, as it starts (dt_init sizes the mipmap cache from it), so a new
// level waits for the engine's next start
pub const RESOURCE_LEVELS: [&str; 3] = ["small", "default", "large"];
const RESOURCE_FILE: &str = "darktable-resources";

pub fn resource_level(runtime: &Path) -> String {
    std::fs::read_to_string(runtime.join(RESOURCE_FILE))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| RESOURCE_LEVELS.contains(&s.as_str()))
        .unwrap_or_else(|| "default".into())
}

pub fn set_resource_level(runtime: &Path, level: &str) -> Result<(), String> {
    if !RESOURCE_LEVELS.contains(&level) {
        return Err(format!("no resource level '{level}'"));
    }
    std::fs::write(runtime.join(RESOURCE_FILE), level).map_err(|e| e.to_string())
}

// edits on the GPU, from Preferences: the engine's edit pipes get OpenCL as
// well as the idle base, read as the engine starts like the resource level.
// on by default: slider frames came 1.5-3x sooner on the GPU on an M4, and
// on an RTX 4070 Ti SUPER under Windows and Linux (GUI benchmark). without
// a usable GPU darktable runs them on the CPU anyway; a weak one is what
// the switch is for
const GPU_EDITS_FILE: &str = "gpu-edits";

pub fn gpu_edits(runtime: &Path) -> bool {
    match std::fs::read_to_string(runtime.join(GPU_EDITS_FILE)).ok().as_deref().map(str::trim) {
        Some("on") => true,
        Some("off") => false,
        _ => true,
    }
}

pub fn set_gpu_edits(runtime: &Path, on: bool) -> Result<(), String> {
    std::fs::write(runtime.join(GPU_EDITS_FILE), if on { "on" } else { "off" }).map_err(|e| e.to_string())
}

impl BaseCancel {
    // the id of a base about to be sent
    pub fn next_id(&self) -> u64 {
        self.last.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel(&self) -> Result<(), String> {
        let id = self.last.load(Ordering::SeqCst);
        if id == 0 {
            return Ok(());
        }
        let mut stdin = self.stdin.lock().unwrap();
        writeln!(stdin, "{}", json!({ "cmd": "cancel_base", "id": id })).map_err(|e| format!("engine write: {e}"))?;
        stdin.flush().map_err(|e| format!("engine write: {e}"))
    }
}

// one line of darktable's -d perf timings: a module processed, a colorspace
// conversion ahead of one, or other work (the raw loaded, a buffer set up)
#[derive(Clone, Serialize)]
pub struct Timing {
    pub label: String,
    pub kind: &'static str, // "module", "colorspace" or "other"
    pub ms: f64,
    pub cpu_ms: f64,
    pub pipe: String,
    pub gpu: bool,
    pub tiled: bool,
}

// the timings of the request under way, and of the last one marked
#[derive(Default)]
struct PerfLog {
    current: Vec<Timing>,
    last: Vec<Timing>,
    marks: u64,
}

#[derive(Default)]
struct Perf {
    log: Mutex<PerfLog>,
    marked: Condvar,
}

// "     1.6279 [dev_pixelpipe] took 0.004 secs (0.018 CPU) [full] processed `exposure' on CPU"
fn parse_timing(line: &str) -> Option<Timing> {
    let (_, rest) = line.split_once(" took ")?;
    let (secs, rest) = rest.split_once(" secs (")?;
    let (cpu, tail) = rest.split_once(" CPU)")?;
    let ms = secs.trim().parse::<f64>().ok()? * 1000.0;
    let cpu_ms = cpu.trim().parse::<f64>().ok()? * 1000.0;
    let tail = tail.trim();
    let bracket = |s: &str| s.split_once('[').and_then(|(_, r)| r.split_once(']')).map(|(b, _)| b.to_string());
    let (label, kind, pipe) = if let Some((_, r)) = tail.split_once("processed `") {
        (r.split_once('\'').map(|(op, _)| op).unwrap_or(r).to_string(), "module", bracket(tail).unwrap_or_default())
    } else if line.contains("transform_image_colorspace") {
        // the module the conversion is for closes the line
        let op = tail.rsplit_once('[').map(|(_, r)| r.trim_end_matches(']')).unwrap_or("");
        (format!("colorspace for {op}"), "colorspace", String::new())
    } else {
        (tail.to_string(), "other", String::new())
    };
    Some(Timing { label, kind, ms, cpu_ms, pipe, gpu: tail.contains(" on GPU"), tiled: tail.contains("with tiling") })
}

// the engine's stderr, to its log: darktable's timings are kept apart, each
// request's from its start ("[engine] > ...") to the mark after it
fn read_stderr(stderr: ChildStderr, mut log: File, perf: Arc<Perf>) {
    let mut reader = BufReader::new(stderr);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches(['\r', '\n']);
        if let Some(req) = line.strip_prefix("[engine] > ") {
            let mut p = perf.log.lock().unwrap();
            if req.contains("\"perf_mark\"") {
                p.last = std::mem::take(&mut p.current);
                p.marks += 1;
                perf.marked.notify_all();
                continue;
            }
            p.current.clear();
        } else if let Some(t) = parse_timing(line) {
            perf.log.lock().unwrap().current.push(t);
            continue;
        }
        let _ = writeln!(log, "{line}");
    }
}

// darktable 5.6 turned ROCm's OpenCL off by default in favor of Mesa's
// RustiCL (darktable 5d782a3b06), so a system with only ROCm installed got
// no GPU at all: the platform found, 0 devices. ROCm is let in when no
// RustiCL is installed to take the GPU twice. the ICD files name the
// driver library they load; `root` is "/" but in the tests
#[cfg(any(target_os = "linux", test))]
fn rocm_only(root: &Path) -> bool {
    let Ok(dir) = std::fs::read_dir(root.join("etc/OpenCL/vendors")) else { return false };
    let libs: Vec<String> = dir.flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "icd"))
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .map(|s| s.to_lowercase())
        .collect();
    libs.iter().any(|l| l.contains("amdocl")) && !libs.iter().any(|l| l.contains("rusticl"))
}

impl Engine {
    // config, cache and the engine's log live under `runtime`, never in the
    // user's own darktable directories; AI models are looked for in `models`
    // an engine left over from a moment ago (the app restarted) can still
    // hold darktable's database lock, and a new one then gives up at once;
    // it is started again until the old one has gone, for a few seconds
    pub fn spawn(bin: &Path, runtime: &Path, models: &Path) -> std::io::Result<Self> {
        for attempt in 0..10 {
            let mut engine = Self::spawn_once(bin, runtime, models)?;
            std::thread::sleep(std::time::Duration::from_millis(400));
            match engine.child.try_wait()? {
                None => return Ok(engine),
                Some(_) if attempt < 9 => std::thread::sleep(std::time::Duration::from_millis(600)),
                Some(status) => {
                    return Err(std::io::Error::other(format!("the engine exited at start ({status})")))
                }
            }
        }
        unreachable!()
    }

    fn spawn_once(bin: &Path, runtime: &Path, models: &Path) -> std::io::Result<Self> {
        std::fs::create_dir_all(runtime)?;
        std::fs::create_dir_all(models)?;
        // kept across restarts, so a crash's backtrace survives the engine
        // started after it; begun afresh once it passes 5 MB
        let path = runtime.join("engine.log");
        let fresh = std::fs::metadata(&path).map(|m| m.len() > 5_000_000).unwrap_or(true);
        let mut log = std::fs::OpenOptions::new().create(true).append(!fresh).write(true).truncate(fresh).open(&path)?;
        let since = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        writeln!(log, "\n===== engine start ({since} s since 1970) =====")?;
        let mut cmd = Command::new(bin);
        cmd
            .arg("--models")
            .arg(models)
            .arg("--core")
            .arg("--configdir")
            .arg(runtime.join("config"))
            .arg("--cachedir")
            .arg(runtime.join("cache"))
            // OpenCL for whole-image work, export and the idle base (which
            // the engine renders with export's priority), 2-3x faster on
            // the GPU. edits and drags (the engine's full pipes) join them
            // with gpu_edits: headless, darktable kept no GPU results in a
            // pipe's cache and every frame reran from the raw, until
            // patches/darktable-engine.patch kept the edited module's input.
            // thumbnails stay on the CPU. the priority is full/preview/
            // export/thumbnail/preview2, empty for none; darktable falls
            // back to the CPU when no device is free or a module fails
            .args(["--conf", "opencl=true"])
            .args(["--conf", if gpu_edits(runtime) { "opencl_device_priority=*//*//" } else { "opencl_device_priority=//*//" }])
            // the other profiles replace the priority (opencl.c,
            // _opencl_apply_scheduling_profile)
            .args(["--conf", "opencl_scheduling_profile=default"])
            .args(["--conf", &format!("resourcelevel={}", resource_level(runtime))])
            // per-module timings, for Preferences' performance overlay; they
            // only print, and stay out of the log
            .args(["-d", "perf"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        // on Windows a console program gets a console window of its own
        // unless told not to (CREATE_NO_WINDOW)
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            cmd.creation_flags(0x0800_0000);
        }
        // ROCm's platform too, when it is the only AMD driver. with ROCm
        // 7.1 darktable's kernels failed to build on read_imagef and
        // write_imagef, and built as OpenCL C 2.0 (darktable #20084; RX 9070
        // XT, Ubuntu 26.04). _APPEND keeps darktable's own build options
        #[cfg(target_os = "linux")]
        if rocm_only(Path::new("/")) {
            cmd.args(["--conf", "clplatform_amdacceleratedparallelprocessing=true"]);
            if std::env::var_os("AMD_OCL_BUILD_OPTIONS_APPEND").is_none() {
                cmd.env("AMD_OCL_BUILD_OPTIONS_APPEND", "-cl-std=CL2.0");
            }
        }
        // libgomp's threads spin while they wait, and when anything else
        // wants the cores (a web view drawn by llvmpipe, say) each module
        // ran 3-25x slower and some frames stalled 200 ms; passive gave
        // Windows' module times on the same PC (GUI benchmark, Mint 22.3)
        #[cfg(target_os = "linux")]
        if std::env::var_os("OMP_WAIT_POLICY").is_none() {
            cmd.env("OMP_WAIT_POLICY", "passive");
        }
        // the web view's EGL selection is not the engine's
        #[cfg(target_os = "linux")]
        if crate::WEBVIEW_EGL_OVERRIDE.load(Ordering::Relaxed) {
            cmd.env_remove(crate::renderer::EGL_VENDOR);
            cmd.env_remove("IMMAGE_WEBVIEW_EGL_VENDOR");
        }
        let mut child = cmd.spawn()?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let perf = Arc::new(Perf::default());
        let shared = perf.clone();
        std::thread::spawn(move || read_stderr(stderr, log, shared));
        let (tx, replies) = channel();
        let waiting = Arc::new(Mutex::new(Some(HashMap::new())));
        let shared = waiting.clone();
        let progress: Progress = Arc::new(Mutex::new(HashMap::new()));
        let following = progress.clone();
        std::thread::spawn(move || read_stdout(stdout, tx, shared, following));
        let base = BaseCancel { stdin: stdin.clone(), last: Arc::new(AtomicU64::new(0)) };
        let tagged = Tagged { stdin: stdin.clone(), waiting, progress, last: Arc::new(AtomicU64::new(0)) };
        Ok(Self { child, stdin, replies, perf, base, tagged })
    }

    // darktable's timings of the request just made: a cheap request after it
    // marks where they end, once its start has come through stderr
    pub fn perf_mark(&mut self) -> Vec<Timing> {
        let seen = self.perf.log.lock().unwrap().marks;
        if self.request(json!({ "cmd": "version", "perf_mark": seen + 1 })).is_err() {
            return Vec::new();
        }
        let deadline = Instant::now() + Duration::from_millis(200);
        let mut p = self.perf.log.lock().unwrap();
        while p.marks <= seen {
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Vec::new();
            }
            p = self.perf.marked.wait_timeout(p, left).unwrap().0;
        }
        p.last.clone()
    }

    pub fn base_cancel(&self) -> BaseCancel {
        self.base.clone()
    }

    pub fn tagged(&self) -> Tagged {
        self.tagged.clone()
    }

    pub fn request(&mut self, req: Value) -> Result<Value, String> {
        {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{req}").map_err(|e| format!("engine write: {e}"))?;
            stdin.flush().map_err(|e| format!("engine write: {e}"))?;
        }
        let reply = self.replies.recv().map_err(|_| ENGINE_EXITED.to_string())?;
        outcome(reply)
    }

    // the engine saves the open photo and exits; requests after it fail
    // the engine has saved by the time it replies to quit; what follows is
    // dt_cleanup(), which can hang on some drivers (NVIDIA's OpenCL on Linux
    // held an update on "installing" for good), so it gets a few seconds
    pub fn quit(&mut self) {
        let _ = self.request(json!({ "cmd": "quit" }));
        reap(&mut self.child, QUIT_WAIT);
    }
}

const QUIT_WAIT: Duration = Duration::from_secs(5);

// waits for the child to exit, and kills it after `wait`
fn reap(child: &mut Child, wait: Duration) {
    let until = Instant::now() + wait;
    while Instant::now() < until {
        match child.try_wait() {
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            _ => return,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.quit();
    }
}

#[cfg(test)]
mod tests {
    use super::{gpu_edits, parse_timing, reap, rocm_only, set_gpu_edits};
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    #[test]
    fn reap_kills_a_child_that_stays() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let t = Instant::now();
        reap(&mut child, Duration::from_millis(300));
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(child.try_wait().unwrap().is_some());
    }

    #[test]
    fn rocm_only_without_rusticl() {
        let root = std::env::temp_dir().join(format!("immage-icd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let vendors = root.join("etc/OpenCL/vendors");
        assert!(!rocm_only(&root));
        std::fs::create_dir_all(&vendors).unwrap();
        std::fs::write(vendors.join("nvidia.icd"), "libnvidia-opencl.so.1\n").unwrap();
        assert!(!rocm_only(&root));
        // AMD's own packages name the file by version
        std::fs::write(vendors.join("amdocl64_70100.icd"), "libamdocl64.so\n").unwrap();
        assert!(rocm_only(&root));
        std::fs::write(vendors.join("rusticl.icd"), "libRusticlOpenCL.so.1\n").unwrap();
        assert!(!rocm_only(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn gpu_edits_on_by_default() {
        let root = std::env::temp_dir().join(format!("immage-gpu-edits-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        assert!(gpu_edits(&root));
        set_gpu_edits(&root, false).unwrap();
        assert!(!gpu_edits(&root));
        set_gpu_edits(&root, true).unwrap();
        assert!(gpu_edits(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn timings() {
        let m = parse_timing("     1.6279 [dev_pixelpipe] took 0.004 secs (0.018 CPU) [full] processed `rawprepare' on CPU").unwrap();
        assert_eq!((m.label.as_str(), m.kind, m.pipe.as_str(), m.gpu), ("rawprepare", "module", "full", false));
        assert!((m.ms - 4.0).abs() < 1e-9 && (m.cpu_ms - 18.0).abs() < 1e-9);
        let c = parse_timing("     1.7357 [dt_ioppr_transform_image_colorspace] IOP_CS_LAB-->IOP_CS_RGB took 0.005 secs (0.008 CPU) [channelmixerrgb]").unwrap();
        assert_eq!((c.label.as_str(), c.kind), ("colorspace for channelmixerrgb", "colorspace"));
        let g = parse_timing("     2.0 [dev_pixelpipe] took 0.010 secs (0.001 CPU) [full] processed `diffuse' on GPU with tiling, blended on GPU").unwrap();
        assert!(g.gpu && g.tiled);
        assert!(parse_timing("[engine] > {\"cmd\": \"render\"}").is_none());
    }
}

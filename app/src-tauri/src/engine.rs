// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the darktable-engine child process: one JSON request per line on its stdin,
// one JSON reply per line on its stdout
use serde::Serialize;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Engine {
    child: Child,
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: BufReader<ChildStdout>,
    perf: Arc<Perf>,
    base: BaseCancel,
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
            // the GPU. edits, drags, previews and thumbnails keep to the
            // CPU: headless, darktable keeps no GPU results in a pipe's
            // cache, and every frame reran from the raw
            // (measured with benchmarking/bench.py). the priority is full/preview/
            // export/thumbnail/preview2, empty for none
            .args(["--conf", "opencl=true"])
            .args(["--conf", "opencl_device_priority=//*//"])
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
        // the web view's Mesa EGL (main.rs, mesa_egl) is not the engine's
        #[cfg(target_os = "linux")]
        if crate::WEBVIEW_MESA.load(Ordering::Relaxed) {
            cmd.env_remove("__EGL_VENDOR_LIBRARY_FILENAMES");
        }
        let mut child = cmd.spawn()?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
        let stderr = child.stderr.take().expect("piped stderr");
        let perf = Arc::new(Perf::default());
        let shared = perf.clone();
        std::thread::spawn(move || read_stderr(stderr, log, shared));
        let base = BaseCancel { stdin: stdin.clone(), last: Arc::new(AtomicU64::new(0)) };
        Ok(Self { child, stdin, stdout, perf, base })
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

    pub fn request(&mut self, req: Value) -> Result<Value, String> {
        {
            let mut stdin = self.stdin.lock().unwrap();
            writeln!(stdin, "{req}").map_err(|e| format!("engine write: {e}"))?;
            stdin.flush().map_err(|e| format!("engine write: {e}"))?;
        }
        let mut line = String::new();
        let n = self.stdout.read_line(&mut line).map_err(|e| format!("engine read: {e}"))?;
        if n == 0 {
            return Err("the engine exited; see build/app-runtime/engine.log".into());
        }
        let reply: Value = serde_json::from_str(&line).map_err(|e| format!("engine reply: {e}"))?;
        if reply["ok"].as_bool() == Some(true) {
            Ok(reply)
        } else {
            Err(reply["error"].as_str().unwrap_or("engine request failed").to_string())
        }
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
    use super::{parse_timing, reap, rocm_only};
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

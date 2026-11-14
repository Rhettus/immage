// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// the darktable-engine child process: one JSON request per line on its stdin,
// one JSON reply per line on its stdout
use crate::settings::Settings;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

pub struct Engine {
    conn: Arc<Conn>,
    link: Arc<Link>,
    // replies to request(), in order; read_stdout passes them on
    replies: Receiver<Value>,
    perf: Arc<Perf>,
    cache_trace: bool,
    // last request rid sent (not "id", which render uses for base cancel); ids are never reused
    last_id: u64,
    // set once the engine has echoed a rid; old engines never do
    echoes_ids: bool,
    // the arguments to start the engine again with
    bin: PathBuf,
    runtime: PathBuf,
    models: PathBuf,
    // what the request under way is (AppState::engine), for its soft deadline
    operation: &'static str,
    #[cfg(test)]
    deadline_override: Option<Duration>,
    // set once respawn() has replaced this one, so dropping it is not a quit
    retired: bool,
}

// one engine child and its pipes. a respawn makes a new one with the next epoch
pub struct Conn {
    epoch: u64,
    stdin: Arc<Mutex<ChildStdin>>,
    waiting: Waiting,
    progress: Progress,
    // shared so that a restart can kill the child without the engine lock
    child: Arc<Mutex<Child>>,
    dead: AtomicBool,
}

// what outlives a respawn: the current Conn, the counters (never reset, so a
// number from an old epoch cannot meet a new one), whether the app means to
// stop the engine, and where the page hears of the engine's state
pub struct Link {
    current: Mutex<Arc<Conn>>,
    changed: Condvar,
    tags: AtomicU64,
    bases: AtomicU64,
    quitting: AtomicBool,
    // a restart the user asked for: not a crash, and not counted against the limit
    manual: AtomicBool,
    exited: String,
    events: Mutex<Arc<dyn Fn(Value) + Send + Sync>>,
}

impl Link {
    fn new(conn: Arc<Conn>, runtime: &Path) -> Arc<Self> {
        Arc::new(Link {
            current: Mutex::new(conn),
            changed: Condvar::new(),
            tags: AtomicU64::new(0),
            bases: AtomicU64::new(0),
            quitting: AtomicBool::new(false),
            manual: AtomicBool::new(false),
            exited: format!("the engine exited; see {}", runtime.join("engine.log").display()),
            events: Mutex::new(Arc::new(|_| {})),
        })
    }

    fn current(&self) -> Arc<Conn> {
        self.current.lock().unwrap().clone()
    }

    fn install(&self, conn: Arc<Conn>) {
        *self.current.lock().unwrap() = conn;
        self.changed.notify_all();
    }

    pub fn set_events(&self, f: impl Fn(Value) + Send + Sync + 'static) {
        *self.events.lock().unwrap() = Arc::new(f);
    }

    pub fn emit(&self, event: Value) {
        let f = self.events.lock().unwrap().clone();
        f(event);
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    // the app is stopping the engine for good: no respawn after this
    fn begin_quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        // the lock orders this after a waiter's check, so no wake-up is missed
        drop(self.current.lock().unwrap());
        self.changed.notify_all();
    }

    // blocks until the current engine has gone, and returns its epoch; None
    // once the app is quitting
    pub fn wait_dead(&self) -> Option<u64> {
        let mut cur = self.current.lock().unwrap();
        loop {
            if self.quitting() {
                return None;
            }
            if cur.dead.load(Ordering::SeqCst) {
                return Some(cur.epoch);
            }
            cur = self.changed.wait(cur).unwrap();
        }
    }

    // a restart on request: kills the engine, whatever it is doing, and the
    // supervisor starts another. needs no engine lock
    pub fn restart(&self) {
        self.manual.store(true, Ordering::SeqCst);
        let conn = self.current();
        let _ = conn.child.lock().unwrap().kill();
    }

    // whether the last death was asked for with restart()
    pub fn take_manual(&self) -> bool {
        self.manual.swap(false, Ordering::SeqCst)
    }
}

// at most `max` respawns in `window`: past that the engine is crashing in a
// loop, and the app stops trying
pub struct RestartBudget {
    times: Vec<Instant>,
    max: usize,
    window: Duration,
}

impl RestartBudget {
    pub fn new(max: usize, window: Duration) -> Self {
        Self { times: Vec::new(), max, window }
    }

    // whether a respawn at `now` is allowed; counts it if so
    pub fn allow(&mut self, now: Instant) -> bool {
        let window = self.window;
        self.times.retain(|t| now.duration_since(*t) < window);
        if self.times.len() >= self.max {
            return false;
        }
        self.times.push(now);
        true
    }
}

// how long a request may wait for its reply before the page is told the
// engine is slow, by the operation AppState::engine was given. None: slow
// by nature (a merge, an export, AI, a base render), no deadline
pub fn soft_deadline(op: &str, req: &Value) -> Option<Duration> {
    let secs = if req["base"].as_bool() == Some(true)
        || matches!(op, "base" | "hdr_merge" | "pano_merge" | "engine_respawn" | "engine_quit" | "unpack"
                        | "on_engine_thread" | "positive_export")
        || ["gpu_check", "ai_", "export", "print"].iter().any(|p| op.starts_with(p)) {
        return None;
    } else if matches!(op, "render" | "module_state")
        || ["set", "mask", "before", "look"].iter().any(|p| op.starts_with(p)) {
        10
    } else if matches!(op, "open_image" | "save" | "paste_batch") || op.starts_with("close") {
        30
    } else {
        20
    };
    Some(Duration::from_secs(secs))
}

// the requests the engine serves on threads of its own beside its main loop:
// thumbnails (main.c, _thumb_run), folder imports (_import_run),
// background exports (_export_run), AI denoise (_denoise_run) and the AI
// selections' models (_ai_run).
// they are sent and answered while a request holds the engine. each is
// tagged, and read_stdout hands its reply to the caller waiting on that tag.
// they follow the current engine, so a respawn needs no new handle
#[derive(Clone)]
pub struct Tagged {
    link: Arc<Link>,
}

// the tagged requests sent and not yet answered, by tag; None once the
// engine has gone
type Waiting = Arc<Mutex<Option<HashMap<u64, Sender<Value>>>>>;

// what follows a tagged request's progress, by tag: the lines a merge
// writes before its reply (main.c, _merge_step), which have no `ok`
type Progress = Arc<Mutex<HashMap<u64, Box<dyn Fn(&Value) + Send>>>>;

impl Tagged {
    // a tag for the next request, unique for the app's run
    pub fn tag(&self) -> u64 {
        self.link.tags.fetch_add(1, Ordering::SeqCst) + 1
    }

    // blocks until the engine replies
    pub fn request(&self, tag: u64, mut req: Value) -> Result<Value, String> {
        req["tag"] = json!(tag);
        let conn = self.link.current();
        let answer = self.expect_on(&conn, tag)?;
        let sent = {
            let mut stdin = conn.stdin.lock().unwrap();
            writeln!(stdin, "{req}").and_then(|_| stdin.flush())
        };
        if let Err(e) = sent {
            Self::forget_on(&conn, tag);
            return Err(format!("engine write: {e}"));
        }
        answer.wait()
    }

    // Folder reads must release their caller even if an import worker stalls.
    // Late replies retain their tag and are discarded after forget().
    pub fn request_until(&self, tag: u64, mut req: Value, timeout: Duration,
                         cancelled: impl Fn() -> bool) -> Result<Value, String> {
        req["tag"] = json!(tag);
        let conn = self.link.current();
        let answer = self.expect_on(&conn, tag)?;
        let result = (|| {
            {
                let mut stdin = conn.stdin.lock().unwrap();
                writeln!(stdin, "{req}").and_then(|_| stdin.flush())
                    .map_err(|e| format!("engine write: {e}"))?;
            }
            answer.wait_until(timeout, cancelled)
        })();
        Self::forget_on(&conn, tag);
        result
    }

    // the answer to `tag`, waited for once it is asked: before, so that it
    // is never read with no one waiting. a request the main loop answers
    // first, and a thread of the engine's later (ai_denoise), asks it
    // through Engine::request()
    pub fn expect(&self, tag: u64) -> Result<Answer, String> {
        self.expect_on(&self.link.current(), tag)
    }

    fn expect_on(&self, conn: &Conn, tag: u64) -> Result<Answer, String> {
        let (tx, rx) = channel();
        let mut waiting = conn.waiting.lock().unwrap();
        waiting.as_mut().ok_or_else(|| self.link.exited.clone())?.insert(tag, tx);
        Ok(Answer(rx, self.link.exited.clone()))
    }

    // `tag` no longer waited for, as its request failed
    pub fn forget(&self, tag: u64) {
        Self::forget_on(&self.link.current(), tag);
    }

    fn forget_on(conn: &Conn, tag: u64) {
        conn.waiting.lock().unwrap().as_mut().map(|w| w.remove(&tag));
    }

    // request() with each progress line of its handed to `progress`, on the
    // thread reading the engine's replies
    pub fn request_with_progress(&self, tag: u64, req: Value, progress: impl Fn(&Value) + Send + 'static)
                                 -> Result<Value, String> {
        let conn = self.link.current();
        conn.progress.lock().unwrap().insert(tag, Box::new(progress));
        let reply = self.request(tag, req);
        conn.progress.lock().unwrap().remove(&tag);
        reply
    }

    // a line that gets no reply, written while others wait on theirs, as
    // `merge_cancel` (main.c, _read_requests)
    pub fn send(&self, req: Value) -> Result<(), String> {
        let conn = self.link.current();
        let mut stdin = conn.stdin.lock().unwrap();
        writeln!(stdin, "{req}").and_then(|_| stdin.flush()).map_err(|e| format!("engine write: {e}"))
    }
}

// the answer, and what to say if the engine goes first
pub struct Answer(Receiver<Value>, String);

impl Answer {
    fn wait_until(self, timeout: Duration, cancelled: impl Fn() -> bool) -> Result<Value, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if cancelled() { return Err("superseded".into()); }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err("Reading photos timed out waiting for the engine. A file or drive may be unresponsive. Try another folder; if it also stalls, restart Immage.".into());
            }
            match self.0.recv_timeout(left.min(Duration::from_millis(100))) {
                Ok(reply) => return outcome(reply),
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {},
                Err(_) => return Err(self.1),
            }
        }
    }

    // blocks until the engine replies
    pub fn wait(self) -> Result<Value, String> {
        // the sender is dropped unanswered when the engine exits
        let reply = self.0.recv().map_err(|_| self.1.clone())?;
        outcome(reply)
    }
}

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
fn read_stdout(stdout: ChildStdout, replies: Sender<Value>, conn: Arc<Conn>, link: Arc<Link>) {
    let (waiting, progress) = (&conn.waiting, &conn.progress);
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
    // the supervisor learns the engine has gone; the lock orders this after
    // its check, so the wake-up is not missed
    conn.dead.store(true, Ordering::SeqCst);
    drop(link.current.lock().unwrap());
    link.changed.notify_all();
}

// stops the engine's idle base render while a request holds the engine: an
// edit need not wait out a base it makes stale. the line gets no reply, so
// it may go in between another request and its reply (main.c,
// _read_requests). bases are numbered, and a cancel stops every one so far
#[derive(Clone)]
pub struct BaseCancel {
    link: Arc<Link>,
}

// darktable's resource level, from Preferences: how much memory its caches
// and pipes may take (darktable.c, dt_get_available_mem). darktable reads
// it once, as it starts (dt_init sizes the mipmap cache from it), so a new
// level waits for the engine's next start
pub const RESOURCE_LEVELS: [&str; 3] = ["small", "default", "large"];

pub fn resource_level(runtime: &Path) -> String {
    crate::settings::read_key(runtime, crate::settings::RESOURCES)
        .map(|s| s.trim().to_string())
        .filter(|s| RESOURCE_LEVELS.contains(&s.as_str()))
        .unwrap_or_else(|| "default".into())
}

// Preferences' 3D LUT folder; none when not set, which leaves darktable's
// default, the home folder
pub fn lut_folder(runtime: &Path) -> Option<String> {
    crate::settings::read_key(runtime, crate::settings::LUT_FOLDER).map(|s| s.trim().to_string())
}

// Preferences' thumbnail threads, 1 to THUMB_THREADS_MAX (main.c's
// _THUMB_THREADS_MAX); two unless set. a network drive may want fewer
pub const THUMB_THREADS_MAX: u32 = 8;
pub fn thumb_threads(runtime: &Path) -> u32 {
    crate::settings::read_key(runtime, crate::settings::THUMB_THREADS)
        .and_then(|s| s.trim().parse::<u32>().ok())
        .filter(|n| (1..=THUMB_THREADS_MAX).contains(n))
        .unwrap_or(2)
}

pub fn set_resource_level(settings: &Settings, level: &str) -> Result<(), String> {
    if !RESOURCE_LEVELS.contains(&level) {
        return Err(format!("no resource level '{level}'"));
    }
    settings.set(crate::settings::RESOURCES, level)
}

// edits on the GPU, from Preferences: the engine's edit pipes get OpenCL as
// well as the idle base, read as the engine starts like the resource level.
// on by default: slider frames came 1.5-3x sooner on the GPU on an M4, and
// on an RTX 4070 Ti SUPER under Windows and Linux (GUI benchmark). without
// a usable GPU darktable runs them on the CPU anyway; a weak one is what
// the switch is for
pub fn gpu_edits(runtime: &Path) -> bool {
    match crate::settings::read_key(runtime, crate::settings::GPU_EDITS).as_deref().map(str::trim) {
        Some("on") => true,
        Some("off") => false,
        _ => true,
    }
}

pub fn set_gpu_edits(settings: &Settings, on: bool) -> Result<(), String> {
    settings.set(crate::settings::GPU_EDITS, if on { "on" } else { "off" })
}

impl BaseCancel {
    // the id of a base about to be sent
    pub fn next_id(&self) -> u64 {
        self.link.bases.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn cancel(&self) -> Result<(), String> {
        let id = self.link.bases.load(Ordering::SeqCst);
        if id == 0 {
            return Ok(());
        }
        let conn = self.link.current();
        let mut stdin = conn.stdin.lock().unwrap();
        writeln!(stdin, "{}", json!({ "cmd": "cancel_base", "id": id })).map_err(|e| format!("engine write: {e}"))?;
        stdin.flush().map_err(|e| format!("engine write: {e}"))
    }
}

// one line of darktable's -d perf timings: a module processed, a colorspace
// conversion ahead of one, or other work (the raw loaded, a buffer set up)
#[derive(Clone, Serialize, Deserialize, specta::Type)]
pub struct Timing {
    pub label: String,
    pub kind: String, // "module", "colorspace", "other" or "pass"
    // an f64 would export as `number | null`; these are always finite
    #[specta(type = serde_json::Number)]
    pub ms: f64,
    #[specta(type = serde_json::Number)]
    pub cpu_ms: f64,
    pub pipe: String,
    pub gpu: bool,
    pub tiled: bool,
}

const CACHE_RECORD_LIMIT: usize = 10000;

#[derive(Default)]
struct CacheLog {
    records: Vec<Value>,
    dropped: usize,
    sequence: u64,
    context: Option<(u64, String)>,
}

impl CacheLog {
    fn consume(&mut self, line: &str) -> bool {
        if let Some(begin) = line.strip_prefix("[engine-cache] begin ") {
            if let Some((id, command)) = begin.split_once(' ') {
                self.sequence += 1;
                self.context = id.parse().ok().map(|id| (id, command.to_string()));
            }
            return true;
        }
        if line == "[engine-cache] end" {
            self.context = None;
            return true;
        }
        let Some((request, command)) = &self.context else { return false };
        let mut words = line.split_whitespace();
        let Some(seconds) = words.next().and_then(|s| s.parse::<f64>().ok()) else { return false };
        let (Some(first), Some(second)) = (words.next(), words.next()) else { return false };
        let event = format!("{first} {second}");
        if !matches!(event.as_str(), "checkpoint lookup" | "cache replace" | "cache invalidate" | "cache clear" | "cache evict") {
            return false;
        }
        if self.records.len() >= CACHE_RECORD_LIMIT {
            self.dropped += 1;
            return true;
        }
        // hashes remain strings: JavaScript numbers cannot represent all u64 values
        let fields: serde_json::Map<String, Value> = line.split_whitespace()
            .filter_map(|word| word.split_once('='))
            .map(|(key, value)| (key.to_string(), json!(value.trim_end_matches(';'))))
            .collect();
        self.records.push(json!({ "event":event, "engineAt":seconds * 1000.0,
            "sequence":self.sequence, "requestId":if *request == 0 { None } else { Some(*request) },
            "command":command, "fields":fields, "line":line }));
        true
    }

    fn report(&self) -> Value {
        json!({ "records":self.records, "droppedRecords":self.dropped, "limit":CACHE_RECORD_LIMIT,
            "tracedRequests":self.sequence,
            "clock":"engine monotonic milliseconds; independent of frontend and native clocks",
            "scope":"request thread only; tagged/background workers excluded; cache contents before recording are unknown" })
    }
}

// the timings of the request under way, and of the last one marked
#[derive(Default)]
struct PerfLog {
    current: Vec<Timing>,
    last: Vec<Timing>,
    marks: u64,
    cache: CacheLog,
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
    Some(Timing { label, kind: kind.into(), ms, cpu_ms, pipe, gpu: tail.contains(" on GPU"), tiled: tail.contains("with tiling") })
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
        if perf.log.lock().unwrap().cache.consume(line) {
            continue;
        }
        if let Some(req) = line.strip_prefix("[engine] > ") {
            let mut p = perf.log.lock().unwrap();
            if req.contains("\"perf_mark\"") {
                p.last = std::mem::take(&mut p.current);
                p.marks += 1;
                perf.marked.notify_all();
                continue;
            }
            p.current.clear();
        } else if let Some(pass) = line.strip_prefix("[engine] | ") {
            // the GPU check's passes (main.c, _parity_pass): the module
            // timings after each marker are that pass's
            perf.log.lock().unwrap().current.push(Timing {
                label: pass.to_string(), kind: "pass".into(), ms: 0.0, cpu_ms: 0.0,
                pipe: String::new(), gpu: false, tiled: false,
            });
            continue;
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
        Self::spawn_with(bin, runtime, models, 1, None, 0)
    }

    // `last_id` carries request ids on across a respawn
    fn spawn_with(bin: &Path, runtime: &Path, models: &Path, epoch: u64, link: Option<&Arc<Link>>,
                  last_id: u64) -> std::io::Result<Self> {
        let mut link = link.cloned();
        let mut last_id = last_id;
        for attempt in 0..10 {
            let mut engine = Self::spawn_once(bin, runtime, models, epoch, link.as_ref())?;
            // later attempts replace this one's Conn in the same Link
            link = Some(engine.link.clone());
            engine.last_id = last_id;
            if engine.started(Duration::from_millis(400)) { return Ok(engine) }
            last_id = engine.last_id;
            let Some(status) = engine.conn.child.lock().unwrap().try_wait()? else { return Ok(engine) };
            // a start that failed is not a quit
            engine.retired = true;
            if attempt == 9 {
                return Err(std::io::Error::other(format!("the engine exited at start ({status})")));
            }
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
        unreachable!()
    }

    // whether the engine got through dt_init, which is where a lock held by
    // an engine still exiting makes it give up: true once it answers a
    // `version` (main.c answers only after dt_init), false when it has not
    // by `limit` or has gone. a late answer carries a stale rid, which
    // request() drops
    fn started(&mut self, limit: Duration) -> bool {
        let deadline = Instant::now() + limit;
        self.last_id += 1;
        let req = json!({ "cmd": "version", "rid": self.last_id });
        let sent = {
            let mut stdin = self.conn.stdin.lock().unwrap();
            writeln!(stdin, "{req}").and_then(|_| stdin.flush()).is_ok()
        };
        if sent && self.replies.recv_timeout(limit).is_ok() { return true }
        // a closed pipe comes before the exit is reaped; wait out the limit
        // for the status, as a failed start is told by it
        while Instant::now() < deadline {
            if !matches!(self.conn.child.lock().unwrap().try_wait(), Ok(None)) { break }
            std::thread::sleep(Duration::from_millis(10));
        }
        false
    }

    fn spawn_once(bin: &Path, runtime: &Path, models: &Path, epoch: u64, link: Option<&Arc<Link>>) -> std::io::Result<Self> {
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
            .arg("--thumb-threads")
            .arg(thumb_threads(runtime).to_string())
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
            // lut3d's process reads the LUT folder from darktable's config, so
            // a photo that uses a LUT renders after a restart too; lut_files
            // sets it again as Preferences changes it
            .args(lut_folder(runtime).filter(|f| !f.is_empty()).map(|f| ["--conf".to_string(), format!("plugins/darkroom/lut3d/def_path={f}")]).into_iter().flatten())
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
        if crate::app_cmds::WEBVIEW_EGL_OVERRIDE.load(Ordering::Relaxed) {
            cmd.env_remove(crate::renderer::EGL_VENDOR);
            cmd.env_remove("IMMAGE_WEBVIEW_EGL_VENDOR");
        }
        kill_with_parent(&mut cmd);
        let mut child = cmd.spawn()?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().expect("piped stdin")));
        let stdout = child.stdout.take().expect("piped stdout");
        let stderr = child.stderr.take().expect("piped stderr");
        let perf = Arc::new(Perf::default());
        let shared = perf.clone();
        std::thread::spawn(move || read_stderr(stderr, log, shared));
        let (tx, replies) = channel();
        let conn = Arc::new(Conn {
            epoch,
            stdin,
            waiting: Arc::new(Mutex::new(Some(HashMap::new()))),
            progress: Arc::new(Mutex::new(HashMap::new())),
            child: Arc::new(Mutex::new(child)),
            dead: AtomicBool::new(false),
        });
        let link = match link {
            Some(link) => {
                link.install(conn.clone());
                link.clone()
            }
            None => Link::new(conn.clone(), runtime),
        };
        let (reading, shared) = (conn.clone(), link.clone());
        std::thread::spawn(move || read_stdout(stdout, tx, reading, shared));
        Ok(Self {
            conn, link, replies, perf, cache_trace: false, last_id: 0, echoes_ids: false,
            bin: bin.to_path_buf(), runtime: runtime.to_path_buf(), models: models.to_path_buf(),
            operation: "",
            #[cfg(test)]
            deadline_override: None,
            retired: false,
        })
    }

    // starts the engine again after it has gone, with the arguments it
    // started with. the Link, and so every Tagged and BaseCancel handed out,
    // follows to the new one. request ids keep counting
    pub fn respawn(&mut self) -> std::io::Result<()> {
        // a dead child is reaped; one that is not (a closed pipe, a hang) is killed
        {
            let mut child = self.conn.child.lock().unwrap();
            let _ = child.kill();
            let _ = child.wait();
        }
        let mut new = Self::spawn_with(&self.bin, &self.runtime, &self.models, self.conn.epoch + 1, Some(&self.link),
                                       self.last_id)?;
        new.operation = self.operation;
        std::mem::swap(self, &mut new);
        // the old one has nothing left to stop, and its drop is no quit
        new.retired = true;
        Ok(())
    }

    pub fn epoch(&self) -> u64 {
        self.conn.epoch
    }

    pub fn link(&self) -> Arc<Link> {
        self.link.clone()
    }

    // the request being served, for its deadline
    pub fn set_operation(&mut self, op: &'static str) {
        self.operation = op;
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
        BaseCancel { link: self.link.clone() }
    }

    pub fn tagged(&self) -> Tagged {
        Tagged { link: self.link.clone() }
    }

    pub fn cache_trace(&mut self, on: bool) -> Result<(), String> {
        self.cache_trace = false;
        let seen = self.perf.log.lock().unwrap().marks;
        self.perf_mark(); // drain stderr from the previous recording before reset
        if self.perf.log.lock().unwrap().marks <= seen {
            return Err("cache diagnostics: engine stderr did not drain".into());
        }
        if on { self.perf.log.lock().unwrap().cache = CacheLog::default(); }
        self.cache_trace = on;
        Ok(())
    }

    pub fn cache_report(&mut self) -> Value {
        let seen = self.perf.log.lock().unwrap().marks;
        self.perf_mark();
        let log = self.perf.log.lock().unwrap();
        let mut report = log.cache.report();
        report["stderrDrained"] = json!(log.marks > seen);
        report
    }

    pub fn request(&mut self, mut req: Value) -> Result<Value, String> {
        if self.cache_trace { req["cache_trace"] = json!(true); }
        self.last_id += 1;
        let id = self.last_id;
        req["rid"] = json!(id);
        #[cfg(test)]
        let deadline = self.deadline_override.or_else(|| soft_deadline(self.operation, &req));
        #[cfg(not(test))]
        let deadline = soft_deadline(self.operation, &req);
        {
            let mut stdin = self.conn.stdin.lock().unwrap();
            writeln!(stdin, "{req}").map_err(|e| format!("engine write: {e}"))?;
            stdin.flush().map_err(|e| format!("engine write: {e}"))?;
        }
        let started = Instant::now();
        let mut slow = false;
        // a late reply to an abandoned request must not answer this one
        loop {
            let waited = match deadline {
                Some(d) if !slow => self.replies.recv_timeout(d.saturating_sub(started.elapsed())),
                _ => self.replies.recv().map_err(|_| std::sync::mpsc::RecvTimeoutError::Disconnected),
            };
            let reply = match waited {
                Ok(reply) => reply,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                    // one message; the request keeps waiting, since it cannot be cancelled
                    slow = true;
                    self.link.emit(json!({ "state": "slow", "op": self.operation,
                                           "seconds": deadline.map_or(0, |d| d.as_secs()) }));
                    continue;
                }
                Err(_) => return Err(self.link.exited.clone()),
            };
            let result = match reply.get("rid").and_then(Value::as_u64) {
                Some(got) if got == id => {
                    self.echoes_ids = true;
                    outcome(reply)
                }
                Some(got) => {
                    self.echoes_ids = true;
                    eprintln!("engine: dropped reply with stale rid {got} (waiting for {id})");
                    continue;
                }
                // an engine that has echoed ids and now does not is out of step
                None if self.echoes_ids => Err("engine reply without rid".into()),
                None => outcome(reply),
            };
            if slow {
                self.link.emit(json!({ "state": "ready", "epoch": self.conn.epoch }));
            }
            return result;
        }
    }

    // the engine saves the open photo and exits; requests after it fail
    // the engine has saved by the time it replies to quit; what follows is
    // dt_cleanup(), which can hang on some drivers (NVIDIA's OpenCL on Linux
    // held an update on "installing" for good), so it gets a few seconds
    pub fn quit(&mut self) {
        // first, so the supervisor never respawns what is being stopped
        self.link.begin_quit();
        if !matches!(self.conn.child.lock().unwrap().try_wait(), Ok(None)) { return; }
        // Writing can also block behind another writer or a full pipe. Let
        // the child exit normally, but enforce the deadline independently
        // of both the write and the reply (which a stalled engine never sends).
        let stdin = self.conn.stdin.clone();
        std::thread::spawn(move || {
            if let Ok(mut stdin) = stdin.lock() {
                let _ = writeln!(stdin, "{}", json!({ "cmd": "quit" }))
                    .and_then(|_| stdin.flush());
            }
        });
        reap(&self.conn.child, QUIT_WAIT);
    }
}

impl Engine {
    // stops the engine so a file it holds open can be replaced, and leaves the
    // supervisor to start another once the caller lets go of the engine lock
    // (it waits for that lock before it respawns). unlike quit() this is a
    // restart: the link keeps running, and it is not counted as a crash
    pub fn stop_for_restart(&mut self) {
        if !matches!(self.conn.child.lock().unwrap().try_wait(), Ok(None)) { return; }
        self.link.manual.store(true, Ordering::SeqCst);
        let stdin = self.conn.stdin.clone();
        std::thread::spawn(move || {
            if let Ok(mut stdin) = stdin.lock() {
                let _ = writeln!(stdin, "{}", json!({ "cmd": "quit" })).and_then(|_| stdin.flush());
            }
        });
        reap(&self.conn.child, QUIT_WAIT);
    }
}

const QUIT_WAIT: Duration = Duration::from_secs(5);

// EOF alone cannot stop an engine stuck in an import or driver call. Linux
// must kill it even when Immage aborts and no Rust destructors run.
fn kill_with_parent(cmd: &mut Command) {
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        let parent = std::process::id() as libc::pid_t;
        // Only async-signal-safe calls in the child before exec.
        unsafe {
            cmd.pre_exec(move || {
                if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                // The parent could have died before prctl was installed.
                if libc::getppid() != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
    }
    #[cfg(not(target_os = "linux"))]
    let _ = cmd;
}

// waits for the child to exit, and kills it after `wait`. the lock is held
// only for a check, so a restart can still kill the child meanwhile
fn reap(child: &Mutex<Child>, wait: Duration) {
    let until = Instant::now() + wait;
    while Instant::now() < until {
        match child.lock().unwrap().try_wait() {
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            _ => return,
        }
    }
    let mut child = child.lock().unwrap();
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for Engine {
    fn drop(&mut self) {
        if !self.retired {
            self.quit();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{gpu_edits, parse_timing, resource_level, set_resource_level, reap, rocm_only, set_gpu_edits, CacheLog, CACHE_RECORD_LIMIT};
    use crate::settings::Settings;
    use std::time::{Duration, Instant};

    #[cfg(unix)]
    #[test]
    fn quit_stops_engine_that_never_reads_or_replies() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("immage-stuck-engine-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("engine");
        std::fs::write(&bin, "#!/bin/sh\nexec sleep 60\n").unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let mut engine = super::Engine::spawn_once(&bin, &root, &root, 1, None).unwrap();
        let started = Instant::now();
        engine.quit();
        assert!(started.elapsed() < Duration::from_secs(8));
        assert!(engine.conn.child.lock().unwrap().try_wait().unwrap().is_some());
        // Explicit quit followed by Drop must not wait again.
        drop(engine);
        assert!(started.elapsed() < Duration::from_secs(8));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    fn fake_engine(name: &str, script: &str) -> (std::path::PathBuf, super::Engine) {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("immage-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("engine");
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        let engine = super::Engine::spawn_once(&bin, &root, &root, 1, None).unwrap();
        (root, engine)
    }

    #[cfg(unix)]
    #[test]
    fn request_skips_reply_with_stale_id() {
        let (root, mut engine) = fake_engine("stale-id", "read line\necho '{\"ok\":true,\"rid\":999,\"which\":\"stale\"}'\necho '{\"ok\":true,\"rid\":1,\"which\":\"right\"}'\nexec sleep 60");
        let reply = engine.request(serde_json::json!({ "cmd": "x" })).unwrap();
        assert_eq!(reply["which"], "right");
        let _ = engine.conn.child.lock().unwrap().kill();
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn request_keeps_caller_id() {
        // the fake engine saves the request line it receives
        let (root, mut engine) = fake_engine("keep-id", "read line\necho \"$line\" > \"$(dirname \"$0\")/seen\"\necho '{\"ok\":true,\"rid\":1}'\nexec sleep 60");
        engine.request(serde_json::json!({ "cmd": "render", "id": 42 })).unwrap();
        let seen: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(root.join("seen")).unwrap()).unwrap();
        assert_eq!(seen["id"], 42);
        assert_eq!(seen["rid"], 1);
        let _ = engine.conn.child.lock().unwrap().kill();
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn request_accepts_untagged_reply_from_old_engine() {
        let (root, mut engine) = fake_engine("old-engine", "read line\necho '{\"ok\":true}'\nexec sleep 60");
        assert!(engine.request(serde_json::json!({ "cmd": "x" })).is_ok());
        let _ = engine.conn.child.lock().unwrap().kill();
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn request_rejects_reply_without_id_after_ids_seen() {
        let (root, mut engine) = fake_engine("id-lost", "read line\necho '{\"ok\":true,\"rid\":1}'\nread line\necho '{\"ok\":true}'\nexec sleep 60");
        assert!(engine.request(serde_json::json!({ "cmd": "x" })).is_ok());
        assert!(engine.request(serde_json::json!({ "cmd": "y" })).is_err());
        let _ = engine.conn.child.lock().unwrap().kill();
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    fn script_engine(name: &str, script: &str) -> (std::path::PathBuf, std::path::PathBuf) {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("immage-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let bin = root.join("engine");
        std::fs::write(&bin, format!("#!/bin/sh\n{script}\n")).unwrap();
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o700)).unwrap();
        (root, bin)
    }

    // dies on its first run, after a request; answers on the second and later
    #[cfg(unix)]
    const DIE_ONCE: &str = "d=$(dirname \"$0\")\necho x >> \"$d/runs\"\nif [ $(wc -l < \"$d/runs\") -eq 1 ]; then read line; exit 1; fi\nwhile read line; do echo \"$line\" >> \"$d/seen\"; case \"$line\" in *'\"rid\"'*) echo '{\"ok\":true,\"rid\":'$(echo \"$line\" | sed 's/.*\"rid\":\\([0-9]*\\).*/\\1/')'}';; esac; done";

    #[cfg(unix)]
    #[test]
    fn request_fails_at_exit_and_works_after_respawn() {
        let (root, bin) = script_engine("respawn", DIE_ONCE);
        let mut engine = super::Engine::spawn_once(&bin, &root, &root, 1, None).unwrap();
        let err = engine.request(serde_json::json!({ "cmd": "x" })).unwrap_err();
        assert!(err.contains("engine.log"), "{err}");
        assert!(err.contains(&root.display().to_string()), "{err}");
        let link = engine.link();
        assert_eq!(link.wait_dead(), Some(1));
        engine.respawn().unwrap();
        assert_eq!(engine.epoch(), 2);
        engine.request(serde_json::json!({ "cmd": "y" })).unwrap();
        // ids go on counting across the respawn
        let seen = std::fs::read_to_string(root.join("seen")).unwrap();
        assert!(seen.contains("\"rid\":2"), "{seen}");
        engine.quit();
        assert!(link.quitting());
        assert_eq!(link.wait_dead(), None);
        std::fs::remove_dir_all(root).unwrap();
    }

    // a start that is answered goes on at once, without the 400 ms limit;
    // the second start follows one that gave up (an old engine's lock)
    #[cfg(unix)]
    #[test]
    fn spawn_goes_on_once_answered() {
        let (root, bin) = script_engine("answered", DIE_ONCE);
        let t = Instant::now();
        let mut engine = super::Engine::spawn(&bin, &root, &root).unwrap();
        // the first run's wait for its exit, the 600 ms pause, then an answer
        assert!(t.elapsed() < Duration::from_millis(1300), "{:?}", t.elapsed());
        engine.request(serde_json::json!({ "cmd": "x" })).unwrap();
        let seen = std::fs::read_to_string(root.join("seen")).unwrap();
        // the second run's probe; ids go on from the first run's
        assert!(seen.contains("\"rid\":2") && seen.contains("\"rid\":3"), "{seen}");
        engine.quit();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn tagged_and_base_cancel_follow_a_respawn() {
        // the first run holds still until killed; later runs log what they read
        let (root, bin) = script_engine("follow", "d=$(dirname \"$0\")\necho x >> \"$d/runs\"\nif [ $(wc -l < \"$d/runs\") -eq 1 ]; then exec sleep 60; fi\nwhile read line; do echo \"$line\" >> \"$d/seen\"; case \"$line\" in *'\"tag\":'*) echo '{\"ok\":true,\"tag\":'$(echo \"$line\" | sed 's/.*\"tag\":\\([0-9]*\\).*/\\1/')'}';; esac; done");
        let mut engine = super::Engine::spawn_once(&bin, &root, &root, 1, None).unwrap();
        let (tagged, base, link) = (engine.tagged(), engine.base_cancel(), engine.link());
        let tag = tagged.tag();
        let answer = tagged.expect(tag).unwrap();
        // the first run counts itself before it is killed
        while !root.join("runs").exists() { std::thread::sleep(Duration::from_millis(10)); }
        link.restart();
        let err = answer.wait().unwrap_err();
        assert!(err.contains("engine.log"), "{err}");
        assert_eq!(link.wait_dead(), Some(1));
        assert!(link.take_manual());
        assert!(tagged.expect(tagged.tag()).is_err());
        engine.respawn().unwrap();
        let tag = tagged.tag();
        assert_eq!(tag, 3);
        tagged.request(tag, serde_json::json!({ "cmd": "x" })).unwrap();
        base.next_id();
        base.cancel().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !std::fs::read_to_string(root.join("seen")).is_ok_and(|s| s.contains("cancel_base")) {
            assert!(Instant::now() < deadline, "cancel never reached the new engine");
            std::thread::sleep(Duration::from_millis(20));
        }
        engine.quit();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restart_budget_allows_three_in_a_window() {
        let mut b = super::RestartBudget::new(3, Duration::from_secs(60));
        let t = Instant::now();
        assert!(b.allow(t));
        assert!(b.allow(t + Duration::from_secs(10)));
        assert!(b.allow(t + Duration::from_secs(20)));
        assert!(!b.allow(t + Duration::from_secs(30)));
        // the first has aged out
        assert!(b.allow(t + Duration::from_secs(61)));
        assert!(!b.allow(t + Duration::from_secs(62)));
    }

    #[test]
    fn soft_deadlines_by_class() {
        use super::soft_deadline as d;
        let none = serde_json::json!({});
        let secs = |op, req: &serde_json::Value| d(op, req).map(|x| x.as_secs());
        assert_eq!(secs("render", &none), Some(10));
        assert_eq!(secs("render", &serde_json::json!({ "base": true })), None);
        assert_eq!(secs("base", &none), None);
        assert_eq!(secs("set_params", &none), Some(10));
        assert_eq!(secs("open_image", &none), Some(30));
        assert_eq!(secs("history", &none), Some(20));
        assert_eq!(secs("ai_model_ensure", &none), None);
        assert_eq!(secs("export_images", &none), None);
        assert_eq!(secs("print_photo", &none), None);
        assert_eq!(secs("engine_respawn", &none), None);
        assert_eq!(secs("", &none), Some(20));
    }

    // replies after a sleep of 1.2 s; the first run only
    #[cfg(unix)]
    const SLOW: &str = "read line\nsleep 1.2\necho '{\"ok\":true,\"rid\":1}'\nexec sleep 60";

    #[cfg(unix)]
    fn recording(engine: &super::Engine) -> std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>> {
        let events = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = events.clone();
        engine.link().set_events(move |e| sink.lock().unwrap().push(e));
        events
    }

    #[cfg(unix)]
    #[test]
    fn slow_request_says_so_once_then_ready() {
        let (root, bin) = script_engine("slow", SLOW);
        let mut engine = super::Engine::spawn_once(&bin, &root, &root, 1, None).unwrap();
        let events = recording(&engine);
        engine.set_operation("set_params");
        engine.deadline_override = Some(Duration::from_millis(300));
        engine.request(serde_json::json!({ "cmd": "x" })).unwrap();
        let events = events.lock().unwrap().clone();
        assert_eq!(events, vec![serde_json::json!({ "state": "slow", "op": "set_params", "seconds": 0 }),
                                serde_json::json!({ "state": "ready", "epoch": 1 })]);
        drop(events);
        let _ = engine.conn.child.lock().unwrap().kill();
        drop(engine);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn restart_during_a_slow_request_releases_it() {
        let (root, bin) = script_engine("slow-kill", "read line\nexec sleep 60");
        let mut engine = super::Engine::spawn_once(&bin, &root, &root, 1, None).unwrap();
        let events = recording(&engine);
        engine.deadline_override = Some(Duration::from_millis(200));
        let link = engine.link();
        let killer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(600));
            link.restart();
        });
        let started = Instant::now();
        assert!(engine.request(serde_json::json!({ "cmd": "x" })).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        killer.join().unwrap();
        assert_eq!(events.lock().unwrap().len(), 1);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn parent_death_helper() {
        let Some(path) = std::env::var_os("IMMAGE_PARENT_DEATH_TEST") else { return };
        let mut cmd = std::process::Command::new("sleep");
        cmd.arg("60");
        super::kill_with_parent(&mut cmd);
        let child = cmd.spawn().unwrap();
        std::fs::write(path, child.id().to_string()).unwrap();
        // Simulate abrupt application exit without dropping the child.
        std::process::exit(0);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn engine_dies_with_parent() {
        let path = std::env::temp_dir().join(format!("immage-parent-death-{}", std::process::id()));
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "engine::tests::parent_death_helper"])
            .env("IMMAGE_PARENT_DEATH_TEST", &path).status().unwrap();
        assert!(status.success());
        let pid = std::fs::read_to_string(&path).unwrap();
        std::fs::remove_file(path).unwrap();
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat"));
            if stat.as_ref().is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound)
                || stat.as_ref().is_ok_and(|s| s.split_once(") ").is_some_and(|(_, rest)| rest.starts_with('Z'))) {
                break;
            }
            assert!(Instant::now() < deadline, "orphan engine survived parent exit: {pid}");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn folder_wait_times_out_cancels_and_handles_replies() {
        let (tx, rx) = std::sync::mpsc::channel();
        let started = Instant::now();
        assert!(super::Answer(rx, "gone".into()).wait_until(Duration::from_millis(10), || false)
            .unwrap_err().starts_with("Reading photos timed out"));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(tx);
        let (_tx, rx) = std::sync::mpsc::channel();
        assert_eq!(super::Answer(rx, "gone".into()).wait_until(Duration::from_secs(30), || true).unwrap_err(), "superseded");
        let (tx, rx) = std::sync::mpsc::channel();
        tx.send(serde_json::json!({"ok":true,"images":[]})).unwrap();
        assert!(super::Answer(rx, "gone".into()).wait_until(Duration::from_secs(1), || false).is_ok());
        let (tx, rx) = std::sync::mpsc::channel();
        drop(tx);
        assert_eq!(super::Answer(rx, "gone".into()).wait_until(Duration::from_secs(1), || false).unwrap_err(), "gone");
    }

    #[test]
    fn checkpoint_records_are_scoped_bounded_and_preserve_hashes() {
        let mut cache = CacheLog::default();
        let lookup = " 1.25 checkpoint lookup CL0 [full] demosaic 3 none --> (0/0) 4286x2844 sc=1.0000; pipe=0xabc run=2 hash=fffffffffffffffe state=abcdef bytes=195033216 hit=0";
        assert!(!cache.consume(lookup));
        assert!(cache.consume("[engine-cache] begin 42 render"));
        assert!(cache.consume(lookup));
        assert!(!cache.consume(" 1.26 pipe data: cache HIT"));
        assert!(cache.consume("[engine-cache] end"));
        assert!(!cache.consume(lookup));
        assert!(cache.consume("[engine-cache] begin 0 set"));
        assert!(cache.consume(" 1.27 cache invalidate [full] pipe=0xabc hash=abcdef reason=history"));
        let report = cache.report();
        assert_eq!(report["records"][0]["requestId"], 42);
        assert_eq!(report["records"][0]["engineAt"], 1250.0);
        assert_eq!(report["records"][0]["fields"]["hash"], "fffffffffffffffe");
        assert_eq!(report["records"][0]["line"], lookup);
        assert!(report["records"][1]["requestId"].is_null());
        assert_eq!(report["records"][1]["command"], "set");
        assert_eq!(report["records"][1]["sequence"], 2);
        for _ in 2..CACHE_RECORD_LIMIT + 3 { cache.consume(lookup); }
        assert_eq!(cache.records.len(), CACHE_RECORD_LIMIT);
        assert_eq!(cache.dropped, 3);
        cache = CacheLog::default();
        assert!(cache.records.is_empty() && cache.context.is_none() && cache.dropped == 0);
    }

    #[test]
    #[ignore = "requires IMMAGE_TEST_ENGINE and IMMAGE_TEST_RAW"]
    fn native_checkpoint_export() {
        let bin = std::env::var("IMMAGE_TEST_ENGINE").expect("engine binary");
        let raw = std::env::var("IMMAGE_TEST_RAW").expect("raw fixture");
        let runtime = std::env::temp_dir().join(format!("immage-cache-export-{}", std::process::id()));
        let mut engine = super::Engine::spawn(std::path::Path::new(&bin), &runtime, &runtime).unwrap();
        let fixture = runtime.join(std::path::Path::new(&raw).file_name().unwrap());
        std::fs::copy(&raw, &fixture).unwrap();
        engine.request(serde_json::json!({"cmd":"open", "path":fixture})).unwrap();
        engine.cache_trace(true).unwrap();
        engine.request(serde_json::json!({"cmd":"render", "width":700, "height":525, "draft":true,
            "diagnostic_request":42, "rgba":runtime.join("frame.rgba")})).unwrap();
        let report = engine.cache_report();
        let records = report["records"].as_array().unwrap();
        assert!(records.iter().any(|r| r["event"] == "checkpoint lookup" && r["requestId"] == 42
            && r["line"].as_str().unwrap().contains("demosaic")));
        assert!(records.iter().any(|r| r["event"] == "cache replace"));
        assert_eq!(report["droppedRecords"], 0);
        engine.cache_trace(false).unwrap();
        let stopped = engine.cache_report();
        engine.request(serde_json::json!({"cmd":"render", "width":500, "height":375,
            "draft":true, "rgba":runtime.join("frame.rgba")})).unwrap();
        assert_eq!(engine.cache_report()["records"], stopped["records"]);
        engine.cache_trace(true).unwrap();
        assert_eq!(engine.cache_report()["records"], serde_json::json!([]));
        engine.cache_trace(false).unwrap();
        engine.quit();
        std::fs::remove_dir_all(runtime).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn reap_kills_a_child_that_stays() {
        let child = std::sync::Mutex::new(std::process::Command::new("sleep").arg("30").spawn().unwrap());
        let t = Instant::now();
        reap(&child, Duration::from_millis(300));
        assert!(t.elapsed() < Duration::from_secs(5));
        assert!(child.lock().unwrap().try_wait().unwrap().is_some());
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
        let settings = Settings::load(&root);
        assert!(gpu_edits(&root));
        set_gpu_edits(&settings, false).unwrap();
        assert!(!gpu_edits(&root));
        set_gpu_edits(&settings, true).unwrap();
        assert!(gpu_edits(&root));
        // anything but on and off is the default
        settings.set(crate::settings::GPU_EDITS, "bogus").unwrap();
        assert!(gpu_edits(&root));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resource_level_validates() {
        let root = std::env::temp_dir().join(format!("immage-resources-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let settings = Settings::load(&root);
        assert_eq!(resource_level(&root), "default");
        set_resource_level(&settings, "large").unwrap();
        assert_eq!(resource_level(&root), "large");
        assert!(set_resource_level(&settings, "huge").is_err());
        settings.set(crate::settings::RESOURCES, "huge").unwrap();
        assert_eq!(resource_level(&root), "default");
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn timings() {
        let m = parse_timing("     1.6279 [dev_pixelpipe] took 0.004 secs (0.018 CPU) [full] processed `rawprepare' on CPU").unwrap();
        assert_eq!((m.label.as_str(), m.kind.as_str(), m.pipe.as_str(), m.gpu), ("rawprepare", "module", "full", false));
        assert!((m.ms - 4.0).abs() < 1e-9 && (m.cpu_ms - 18.0).abs() < 1e-9);
        let c = parse_timing("     1.7357 [dt_ioppr_transform_image_colorspace] IOP_CS_LAB-->IOP_CS_RGB took 0.005 secs (0.008 CPU) [channelmixerrgb]").unwrap();
        assert_eq!((c.label.as_str(), c.kind.as_str()), ("colorspace for channelmixerrgb", "colorspace"));
        let g = parse_timing("     2.0 [dev_pixelpipe] took 0.010 secs (0.001 CPU) [full] processed `diffuse' on GPU with tiling, blended on GPU").unwrap();
        assert!(g.gpu && g.tiled);
        assert!(parse_timing("[engine] > {\"cmd\": \"render\"}").is_none());
    }
}

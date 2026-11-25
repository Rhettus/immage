// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

// says in engine.log when the interface stops answering, and why: the
// window's event loop (which runs every sync command and passes every page
// call on) not getting round to a probe, a sync command holding it, the
// page's script not running its timer, or a page call left waiting. a
// frozen window with an idle engine otherwise leaves no trace in a support
// bundle.
//
// it only observes. the probe on the event loop is an atomic store; lines are
// written from the watcher thread or a blocking worker, never the event loop,
// and only for slow events. LOCK ORDER: `shared` is a leaf, held only to copy
// or replace small values, never across a file write
use serde::Deserialize;
use specta::Type;
use std::collections::HashSet;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

// how often the watcher looks
const TICK: Duration = Duration::from_millis(500);
// a probe unanswered this long is a stall of the event loop
const MAIN_STALL_MS: u64 = 2_000;
// the page sends a beat a second; none for this long is a stall
const PAGE_STALL_MS: u64 = 3_000;
// a sync command this long on the event loop is noted
const SLOW_DISPATCH: Duration = Duration::from_millis(250);
// a page call still pending this long is noted once
const PENDING_NOTE_MS: u64 = 5_000;

static WATCH: OnceLock<Arc<Inner>> = OnceLock::new();

struct Inner {
    start: Instant,
    log: PathBuf,
    // ms since `start` the probe now waiting was posted (0 = none waiting).
    // the age counts from the post, not the last answer, so a watcher that
    // itself wakes late (App Nap, sleep) does not read as a stall
    posted_ms: AtomicU64,
    answered_any: AtomicBool,
    // ms since `start` of the page's last beat (0 = none yet)
    page_ms: AtomicU64,
    // the page's last beat said its window was hidden, where WebKit throttles
    // its timers far past PAGE_STALL_MS
    page_hidden: AtomicBool,
    main_stalled: AtomicBool,
    page_stalled: AtomicBool,
    shared: Mutex<Shared>,
}

#[derive(Default)]
struct Shared {
    // the sync dispatch running on the event loop, or the last one
    dispatch: Option<(String, Instant, bool)>,
    // calls the page had pending at its last beat
    pending: Vec<PendingCall>,
    // page call ids already noted as long pending
    noted: HashSet<u64>,
}

#[derive(Deserialize, Type, Clone)]
pub struct PendingCall {
    pub id: u64,
    pub name: String,
    pub ms: u64,
}

#[derive(Deserialize, Type)]
pub struct SlowCall {
    pub name: String,
    pub ms: u64,
    pub failed: bool,
}

// what the page reports every second: its calls pending over 2 s, the ones
// that finished after over 1 s since the last beat (at most 10, and how many
// more), the longest its timer was held up (its script blocked) with the
// calls it started just before, and whether its window is visible
#[derive(Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Beat {
    pub pending: Vec<PendingCall>,
    pub slow: Vec<SlowCall>,
    pub slow_more: u32,
    pub gap_ms: u64,
    pub before_gap: Vec<String>,
    pub visible: bool,
}

impl Inner {
    fn now_ms(&self) -> u64 {
        // never 0, which means "none"
        self.start.elapsed().as_millis() as u64 + 1
    }
    fn shared(&self) -> std::sync::MutexGuard<'_, Shared> {
        self.shared.lock().unwrap_or_else(PoisonError::into_inner)
    }
    // one write per line, so it does not interleave with the engine's
    fn note(&self, line: &str) {
        let text = format!("{} [stall] {line}\n", chrono::Local::now().format("%H:%M:%S%.3f"));
        if let Ok(mut file) = std::fs::OpenOptions::new().create(true).append(true).open(&self.log) {
            let _ = file.write_all(text.as_bytes());
        }
    }
}

fn list(calls: &[PendingCall]) -> String {
    if calls.is_empty() {
        return "none".into();
    }
    calls.iter().map(|c| format!("{} {} ms", c.name, c.ms)).collect::<Vec<_>>().join(", ")
}

// starts the watcher; lines go to `log` (the runtime folder's engine.log)
pub fn start<R: Runtime>(app: AppHandle<R>, log: PathBuf) {
    let inner = Arc::new(Inner {
        start: Instant::now(),
        log,
        posted_ms: AtomicU64::new(0),
        answered_any: AtomicBool::new(false),
        page_ms: AtomicU64::new(0),
        page_hidden: AtomicBool::new(false),
        main_stalled: AtomicBool::new(false),
        page_stalled: AtomicBool::new(false),
        shared: Mutex::new(Shared::default()),
    });
    if WATCH.set(inner.clone()).is_err() {
        return;
    }
    inner.note("watching the window's event loop and the page");
    let _ = std::thread::Builder::new().name("stall-watch".into()).spawn(move || loop {
        watch_tick(&app, &inner);
        std::thread::sleep(TICK);
    });
}

fn watch_tick<R: Runtime>(app: &AppHandle<R>, inner: &Arc<Inner>) {
    let now = inner.now_ms();
    let posted = inner.posted_ms.load(Ordering::Acquire);
    if posted == 0 {
        // the last probe was answered: the loop is fine; send the next one
        if inner.main_stalled.swap(false, Ordering::AcqRel) {
            inner.note("the window's event loop answers again");
            // the page's beats come through the event loop, so they stopped
            // too: its silence so far is not the page's own
            if inner.page_ms.load(Ordering::Acquire) != 0 {
                inner.page_ms.store(now, Ordering::Release);
            }
        }
        inner.posted_ms.store(now, Ordering::Release);
        let probe = inner.clone();
        let sent = app.run_on_main_thread(move || {
            probe.answered_any.store(true, Ordering::Release);
            probe.posted_ms.store(0, Ordering::Release);
        });
        if sent.is_err() {
            inner.posted_ms.store(0, Ordering::Release);
        }
    } else {
        let age = now.saturating_sub(posted);
        if age > MAIN_STALL_MS && !inner.main_stalled.swap(true, Ordering::AcqRel) {
            let (dispatch, pending) = {
                let s = inner.shared();
                (s.dispatch.clone(), s.pending.clone())
            };
            let on_loop = match dispatch {
                Some((name, at, true)) => format!("running sync command {name} for {} ms", at.elapsed().as_millis()),
                Some((name, at, false)) => format!("no sync command running (last was {name}, {} ms ago)", at.elapsed().as_millis()),
                None => "no sync command run yet".into(),
            };
            let since = if inner.answered_any.load(Ordering::Acquire) { "" } else { " (still starting up)" };
            inner.note(&format!("the window's event loop has not answered for {age} ms{since}; {on_loop}; page calls pending at its last beat: {}", list(&pending)));
        }
        return;
    }
    let page = inner.page_ms.load(Ordering::Acquire);
    let page_age = now.saturating_sub(page);
    if page != 0 && page_age > PAGE_STALL_MS && !inner.page_hidden.load(Ordering::Acquire)
        && !inner.page_stalled.swap(true, Ordering::AcqRel)
    {
        let pending = inner.shared().pending.clone();
        inner.note(&format!("the page has not reported for {page_age} ms while the event loop answers (its script is busy or blocked, or it is reloading); calls pending at its last beat: {}", list(&pending)));
    }
}

// runs one command's dispatch on the event loop, timing it. async commands
// return at once (their work is spawned), so only sync ones show up slow
pub fn dispatch<T>(name: String, run: impl FnOnce() -> T) -> T {
    let Some(inner) = WATCH.get() else { return run() };
    let started = Instant::now();
    inner.shared().dispatch = Some((name, started, true));
    let out = run();
    let took = started.elapsed();
    let name = {
        let mut s = inner.shared();
        s.dispatch.as_mut().map(|d| {
            d.2 = false;
            d.0.clone()
        })
    };
    if took > SLOW_DISPATCH {
        // off the event loop: the file write waits on nothing the user does
        let inner = inner.clone();
        let name = name.unwrap_or_default();
        std::thread::spawn(move || inner.note(&format!("sync command {name} held the window's event loop {} ms", took.as_millis())));
    }
    out
}

// the page's beat (boot.tsx, commands.ts). async; its writes go to a
// blocking worker
#[tauri::command]
#[specta::specta]
pub async fn stall_beat(beat: Beat) {
    let Some(inner) = WATCH.get() else { return };
    let mut lines = Vec::new();
    inner.page_hidden.store(!beat.visible, Ordering::Release);
    if inner.page_stalled.swap(false, Ordering::AcqRel) {
        lines.push("the page reports again".to_string());
    }
    if beat.gap_ms > 0 {
        lines.push(format!("the page's script was blocked {} ms; calls it started just before: {}", beat.gap_ms,
                           if beat.before_gap.is_empty() { "none".into() } else { beat.before_gap.join(", ") }));
    }
    if !beat.slow.is_empty() {
        let calls = beat.slow.iter()
            .map(|c| format!("{} {} ms{}", c.name, c.ms, if c.failed { " (failed)" } else { "" }))
            .collect::<Vec<_>>().join(", ");
        let more = if beat.slow_more > 0 { format!(" and {} more", beat.slow_more) } else { String::new() };
        lines.push(format!("slow page calls: {calls}{more}"));
    }
    {
        let mut s = inner.shared();
        let current: HashSet<u64> = beat.pending.iter().map(|c| c.id).collect();
        s.noted.retain(|id| current.contains(id));
        for call in beat.pending.iter().filter(|c| c.ms >= PENDING_NOTE_MS) {
            if s.noted.insert(call.id) {
                lines.push(format!("page call {} still waiting after {} ms", call.name, call.ms));
            }
        }
        s.pending = beat.pending;
    }
    inner.page_ms.store(inner.now_ms(), Ordering::Release);
    if !lines.is_empty() {
        let inner = inner.clone();
        let _ = tauri::async_runtime::spawn_blocking(move || {
            for line in lines {
                inner.note(&line);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_pending_calls() {
        assert_eq!(list(&[]), "none");
        let calls = [PendingCall { id: 1, name: "open_folder".into(), ms: 4200 },
                     PendingCall { id: 2, name: "thumb".into(), ms: 2100 }];
        assert_eq!(list(&calls), "open_folder 4200 ms, thumb 2100 ms");
    }
}

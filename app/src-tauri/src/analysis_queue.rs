// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Bounded shared background work. No GUI, model downloads or engine startup.
use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, RwLock};

type Work = Box<dyn FnOnce(Job) + Send + 'static>;
struct Pending {
    key: String,
    foreground: bool,
    work: Work,
}
#[derive(Default)]
struct State {
    queue: VecDeque<Pending>,
    keys: HashSet<(u64, String)>,
    active: usize,
    epoch: u64,
    paused: bool,
    stopped: bool,
    finished: u64,
    failed: u64,
}
/// Lock order: `publish` before `state`. Only `cancel()` and `Drop` hold both.
/// A publish closure may call `submit` (takes `state`) while holding `publish`
/// for reading. Nothing takes `publish` while holding `state`; workers,
/// `enqueue`, `pause` and `status` hold `state` alone. No publish closure may
/// call `cancel()`: it would wait for its own read guard.
/// `current` and `stopped` mirror `State.epoch` / `State.stopped` for the
/// lock-free `Job::cancelled()`; they change only under both locks.
struct Inner {
    state: Mutex<State>,
    changed: Condvar,
    publish: RwLock<u64>,
    current: AtomicU64,
    stopped: AtomicBool,
    capacity: usize,
}
pub struct AnalysisQueue {
    inner: Arc<Inner>,
}
#[derive(Debug, Clone, serde::Serialize, specta::Type)]
pub struct Status {
    pub queued: usize,
    pub active: usize,
    pub paused: bool,
    pub finished: u64,
    pub failed: u64,
}
/// Every result publication goes through commit(). After cancel() returns,
/// every publication from an older epoch has either finished or will return
/// None, so a caller that clears the cache after cancel() never sees an old
/// result reappear. Publications run under a shared read guard: they must do
/// only in-memory and cache work, never file, network or engine IO, because
/// cancel() (on the main thread at exit, and in search_cache_clear) waits for
/// them.
pub struct Job {
    inner: Arc<Inner>,
    epoch: u64,
}
impl Job {
    pub fn cancelled(&self) -> bool {
        self.inner.stopped.load(Ordering::Acquire)
            || self.inner.current.load(Ordering::Acquire) != self.epoch
    }
    pub fn commit<T>(&self, publish: impl FnOnce() -> T) -> Option<T> {
        let guard = self.inner.publish.read().unwrap_or_else(|e| e.into_inner());
        if self.inner.stopped.load(Ordering::Acquire) || *guard != self.epoch {
            None
        } else {
            Some(publish())
        }
    }
}
impl AnalysisQueue {
    pub fn new(workers: usize, capacity: usize) -> Self {
        assert!((1..=8).contains(&workers) && capacity > 0);
        let inner = Arc::new(Inner {
            state: Mutex::new(State::default()),
            changed: Condvar::new(),
            publish: RwLock::new(0),
            current: AtomicU64::new(0),
            stopped: AtomicBool::new(false),
            capacity,
        });
        // One reserved foreground worker keeps queries responsive when scans
        // occupy every background slot (including blocked filesystem calls).
        for foreground_only in std::iter::once(true).chain(std::iter::repeat_n(false, workers)) {
            let inner = inner.clone();
            std::thread::spawn(move || loop {
                let (task, epoch) = {
                    let mut state = inner.state.lock().unwrap();
                    loop {
                        if state.stopped {
                            return;
                        }
                        let foreground = state.queue.iter().position(|task| task.foreground);
                        let position = foreground.or_else(|| {
                            if !foreground_only && !state.paused && !state.queue.is_empty() {
                                Some(0)
                            } else {
                                None
                            }
                        });
                        if let Some(position) = position {
                            let task = state.queue.remove(position).unwrap();
                            state.active += 1;
                            break (task, state.epoch);
                        }
                        state = inner.changed.wait(state).unwrap();
                    }
                };
                let key = task.key;
                let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    (task.work)(Job {
                        inner: inner.clone(),
                        epoch,
                    })
                }));
                let mut state = inner.state.lock().unwrap();
                state.active -= 1;
                state.keys.remove(&(epoch, key));
                state.finished += 1;
                if result.is_err() {
                    state.failed += 1;
                }
                inner.changed.notify_all();
            });
        }
        Self { inner }
    }
    /// False means duplicate, full or stopping; callers retain their own retry
    /// source (the cache). Capacity includes queued and running jobs.
    pub fn submit(&self, key: String, work: impl FnOnce(Job) + Send + 'static) -> bool {
        self.enqueue(key, false, work)
    }
    pub fn submit_foreground(&self, key: String, work: impl FnOnce(Job) + Send + 'static) -> bool {
        self.enqueue(key, true, work)
    }
    fn enqueue(
        &self,
        key: String,
        foreground: bool,
        work: impl FnOnce(Job) + Send + 'static,
    ) -> bool {
        let mut state = self.inner.state.lock().unwrap();
        let epoch = state.epoch;
        if state.stopped
            || state.keys.len() >= self.inner.capacity
            || !state.keys.insert((epoch, key.clone()))
        {
            return false;
        }
        state.queue.push_back(Pending {
            key,
            foreground,
            work: Box::new(work),
        });
        self.inner.changed.notify_all();
        true
    }
    pub fn pause(&self, paused: bool) {
        self.inner.state.lock().unwrap().paused = paused;
        self.inner.changed.notify_all();
    }
    pub fn cancel(&self) {
        let mut fence = self.inner.publish.write().unwrap_or_else(|e| e.into_inner());
        let mut state = self.inner.state.lock().unwrap();
        let epoch = state.epoch;
        state.epoch += 1;
        *fence = state.epoch;
        self.inner.current.store(state.epoch, Ordering::Release);
        let queued: Vec<_> = state.queue.drain(..).map(|task| task.key).collect();
        for key in queued {
            state.keys.remove(&(epoch, key));
        }
        self.inner.changed.notify_all();
        drop(state);
        drop(fence);
    }
    pub fn status(&self) -> Status {
        let state = self.inner.state.lock().unwrap();
        Status {
            queued: state.queue.len(),
            active: state.active,
            paused: state.paused,
            finished: state.finished,
            failed: state.failed,
        }
    }
}
impl Drop for AnalysisQueue {
    fn drop(&mut self) {
        let mut fence = self.inner.publish.write().unwrap_or_else(|e| e.into_inner());
        let mut state = self.inner.state.lock().unwrap();
        state.stopped = true;
        self.inner.stopped.store(true, Ordering::Release);
        state.epoch += 1;
        *fence = state.epoch;
        self.inner.current.store(state.epoch, Ordering::Release);
        state.queue.clear();
        self.inner.changed.notify_all(); // Never join a worker blocked in filesystem/model I/O.
        drop(state);
        drop(fence);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;
    #[test]
    fn bounds_pause_dedup_cancel_publication_and_recovery() {
        let queue = AnalysisQueue::new(1, 2);
        queue.pause(true);
        let (started_tx, started) = mpsc::channel();
        let (release_tx, release) = mpsc::channel();
        let (result_tx, result) = mpsc::channel();
        assert!(queue.submit("a".into(), move |job| {
            started_tx.send(()).unwrap();
            release.recv().unwrap();
            result_tx.send(job.commit(|| 42)).unwrap();
        }));
        assert!(!queue.submit("a".into(), |_| panic!("duplicate")));
        assert!(queue.submit("b".into(), |_| panic!("cancelled queued job")));
        assert!(!queue.submit("c".into(), |_| panic!("over capacity")));
        assert!(started.recv_timeout(Duration::from_millis(30)).is_err());
        queue.pause(false);
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        queue.pause(true);
        queue.cancel();
        release_tx.send(()).unwrap();
        assert_eq!(result.recv_timeout(Duration::from_secs(2)).unwrap(), None);
        // Completion removes the active key before a subsequent dispatch.
        let (tx, rx) = mpsc::channel();
        assert!(queue.submit("recovery".into(), move |job| {
            tx.send(job.commit(|| 7)).unwrap();
        }));
        queue.pause(false);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Some(7));
    }
    #[test]
    fn rebuild_requeues_same_key_without_releasing_cancelled_active_slot() {
        let queue = AnalysisQueue::new(1, 2);
        let (started_tx, started) = mpsc::channel();
        let (release_tx, release) = mpsc::channel();
        assert!(queue.submit("root".into(), move |job| {
            started_tx.send(()).unwrap();
            release.recv().unwrap();
            assert!(job.cancelled());
        }));
        started.recv_timeout(Duration::from_secs(2)).unwrap();
        queue.pause(true);
        queue.cancel();
        let (tx, rx) = mpsc::channel();
        assert!(queue.submit("root".into(), move |job| {
            tx.send(job.commit(|| 42)).unwrap();
        }));
        assert!(!queue.submit("other".into(), |_| panic!("old active slot must count")));
        release_tx.send(()).unwrap();
        queue.pause(false);
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), Some(42));
    }
    #[test]
    fn foreground_query_runs_while_background_is_blocked_and_paused() {
        let q = AnalysisQueue::new(1, 3);
        let (tx, rx) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        assert!(q.submit("scan".into(), move |_| {
            tx.send(()).unwrap();
            wait.recv().unwrap();
        }));
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        q.pause(true);
        assert!(q.submit("paused".into(), |_| panic!("background remains paused")));
        let (tx, rx) = mpsc::channel();
        assert!(q.submit_foreground("query".into(), move |_| {
            tx.send(42).unwrap();
        }));
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)).unwrap(), 42);
        q.cancel();
        release.send(()).unwrap();
    }
    #[test]
    fn panicked_jobs_release_the_worker_and_capacity() {
        let queue = AnalysisQueue::new(1, 2);
        assert!(queue.submit("panic".into(), |_| panic!("intentional")));
        let (tx, rx) = mpsc::channel();
        assert!(queue.submit("next".into(), move |_| {
            tx.send(()).unwrap();
        }));
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(queue.status().failed, 1);
    }
    #[test]
    fn slow_commit_does_not_block_submit_or_status() {
        let queue = AnalysisQueue::new(1, 4);
        let (in_tx, inside) = mpsc::channel();
        let (rel_tx, rel) = mpsc::channel::<()>();
        assert!(queue.submit("slow".into(), move |job| {
            job.commit(|| {
                in_tx.send(()).unwrap();
                rel.recv().unwrap();
            });
        }));
        inside.recv_timeout(Duration::from_secs(2)).unwrap();
        let t = std::time::Instant::now();
        assert!(queue.submit("other".into(), |_| {}));
        let status = queue.status();
        let took = t.elapsed();
        println!("submit+status during publication: {took:?}");
        assert!(took < Duration::from_secs(1));
        assert!(status.active >= 1);
        rel_tx.send(()).unwrap();
    }
    #[test]
    fn cancel_waits_for_publication_and_fences_later_ones() {
        let queue = Arc::new(AnalysisQueue::new(1, 4));
        let flag = Arc::new(AtomicBool::new(false));
        let (in_tx, inside) = mpsc::channel();
        let (go_tx, go) = mpsc::channel::<()>();
        let (after_tx, after) = mpsc::channel();
        let f = flag.clone();
        assert!(queue.submit("pub".into(), move |job| {
            job.commit(|| {
                in_tx.send(()).unwrap();
                std::thread::sleep(Duration::from_millis(50));
                f.store(true, Ordering::SeqCst);
            });
            go.recv().unwrap();
            after_tx.send(job.commit(|| 1)).unwrap();
        }));
        inside.recv_timeout(Duration::from_secs(2)).unwrap();
        let q = queue.clone();
        let f = flag.clone();
        let canceller = std::thread::spawn(move || {
            q.cancel();
            f.load(Ordering::SeqCst)
        });
        assert!(canceller.join().unwrap(), "cancel returned before publication finished");
        go_tx.send(()).unwrap();
        assert_eq!(after.recv_timeout(Duration::from_secs(2)).unwrap(), None);
    }
    #[test]
    fn cancelled_is_prompt_while_a_publication_is_open() {
        let queue = Arc::new(AnalysisQueue::new(2, 4));
        let (in_tx, inside) = mpsc::channel();
        let (rel_tx, rel) = mpsc::channel::<()>();
        let (seen_tx, seen) = mpsc::channel();
        assert!(queue.submit("holder".into(), move |job| {
            job.commit(|| {
                in_tx.send(()).unwrap();
                rel.recv().unwrap();
            });
        }));
        inside.recv_timeout(Duration::from_secs(2)).unwrap();
        let (cancel_tx, cancel_rx) = mpsc::channel::<()>();
        let (c_tx, c_rx) = mpsc::channel();
        let (cont_tx, cont) = mpsc::channel::<()>();
        // A second job from the old epoch, started before cancel().
        assert!(queue.submit("probe".into(), move |job| {
            c_tx.send(()).unwrap();
            cont.recv().unwrap();
            let t = std::time::Instant::now();
            let v = job.cancelled();
            seen_tx.send((v, t.elapsed())).unwrap();
        }));
        c_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let q = queue.clone();
        let th = std::thread::spawn(move || {
            q.cancel();
            drop(cancel_tx);
        });
        // cancel() is now waiting on the open publication, but the epoch is
        // not bumped until it gets the write guard; release the holder first.
        rel_tx.send(()).unwrap();
        th.join().unwrap();
        assert!(cancel_rx.recv().is_err());
        cont_tx.send(()).unwrap();
        let (v, took) = seen.recv_timeout(Duration::from_secs(2)).unwrap();
        println!("cancelled() took {took:?}");
        assert!(v);
        assert!(took < Duration::from_secs(1));
    }
}

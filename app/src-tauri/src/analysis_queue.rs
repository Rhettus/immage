// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

//! Bounded shared background work. No GUI, model downloads or engine startup.
use std::collections::{HashSet, VecDeque};
use std::sync::{Arc, Condvar, Mutex};

type Work = Box<dyn FnOnce(Job) + Send + 'static>;
struct Pending {
    key: String,
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
struct Inner {
    state: Mutex<State>,
    changed: Condvar,
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
/// Every result publication must use commit(), so clearing/rebuilding can
/// cancel old work and clear its output without a late result reappearing.
pub struct Job {
    inner: Arc<Inner>,
    epoch: u64,
}
impl Job {
    pub fn cancelled(&self) -> bool {
        let state = self.inner.state.lock().unwrap();
        state.stopped || state.epoch != self.epoch
    }
    pub fn commit<T>(&self, publish: impl FnOnce() -> T) -> Option<T> {
        let state = self.inner.state.lock().unwrap();
        if state.stopped || state.epoch != self.epoch {
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
            capacity,
        });
        for _ in 0..workers {
            let inner = inner.clone();
            std::thread::spawn(move || loop {
                let (task, epoch) = {
                    let mut state = inner.state.lock().unwrap();
                    loop {
                        if state.stopped {
                            return;
                        }
                        if !state.paused {
                            if let Some(task) = state.queue.pop_front() {
                                state.active += 1;
                                break (task, state.epoch);
                            }
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
            work: Box::new(work),
        });
        self.inner.changed.notify_one();
        true
    }
    pub fn pause(&self, paused: bool) {
        self.inner.state.lock().unwrap().paused = paused;
        self.inner.changed.notify_all();
    }
    pub fn cancel(&self) {
        let mut state = self.inner.state.lock().unwrap();
        let epoch = state.epoch;
        state.epoch += 1;
        let queued: Vec<_> = state.queue.drain(..).map(|task| task.key).collect();
        for key in queued {
            state.keys.remove(&(epoch, key));
        }
        self.inner.changed.notify_all();
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
        let mut state = self.inner.state.lock().unwrap();
        state.stopped = true;
        state.epoch += 1;
        state.queue.clear();
        self.inner.changed.notify_all(); // Never join a worker blocked in filesystem/model I/O.
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
}

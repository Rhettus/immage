// SPDX-License-Identifier: GPL-3.0-or-later
//! Bounded native engine-lock spans. Times use a native monotonic clock.
use std::collections::HashMap;
use std::ops::{Deref, DerefMut};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex, MutexGuard,
};
use std::time::Instant;

#[derive(Clone, Debug)]
pub struct Span {
    pub id: u64,
    pub request: Option<u64>,
    pub operation: &'static str,
    pub wait: f64,
    pub acquired: f64,
    pub released: f64,
}
#[derive(Clone, Debug)]
pub struct Pending {
    pub id: u64,
    pub request: Option<u64>,
    pub operation: &'static str,
    pub wait: f64,
    pub acquired: Option<f64>,
}
struct Recording {
    origin: Instant,
    spans: Vec<Span>,
    active: HashMap<u64, Pending>,
    dropped: usize,
    generation: u64,
}
pub struct TracedMutex<T> {
    inner: Mutex<T>,
    enabled: AtomicBool,
    serial: AtomicU64,
    recording: Mutex<Recording>,
}
impl<T> TracedMutex<T> {
    pub fn new(value: T) -> Self {
        Self {
            inner: Mutex::new(value),
            enabled: AtomicBool::new(false),
            serial: AtomicU64::new(0),
            recording: Mutex::new(Recording {
                origin: Instant::now(),
                spans: vec![],
                active: HashMap::new(),
                dropped: 0,
                generation: 0,
            }),
        }
    }
    pub fn start(&self) {
        let mut r = self.recording.lock().unwrap();
        r.origin = Instant::now();
        r.spans.clear();
        r.active.clear();
        r.dropped = 0;
        r.generation += 1;
        self.enabled.store(true, Ordering::Relaxed);
    }
    pub fn stop(&self) {
        self.enabled.store(false, Ordering::Relaxed);
    }
    pub fn snapshot(&self) -> (Vec<Span>, usize, Vec<Pending>) {
        let r = self.recording.lock().unwrap();
        (
            r.spans.clone(),
            r.dropped,
            r.active.values().cloned().collect(),
        )
    }
    pub fn lock(&self, operation: &'static str, request: Option<u64>) -> Guard<'_, T> {
        let started = if self.enabled.load(Ordering::Relaxed) {
            let mut r = self.recording.lock().unwrap();
            if r.active.len() + r.spans.len() >= 30000 {
                r.dropped += 1;
                None
            } else {
                let id = self.serial.fetch_add(1, Ordering::Relaxed) + 1;
                let wait = r.origin.elapsed().as_secs_f64() * 1000.0;
                r.active.insert(
                    id,
                    Pending {
                        id,
                        request,
                        operation,
                        wait,
                        acquired: None,
                    },
                );
                Some((r.origin, r.generation, wait, id))
            }
        } else {
            None
        };
        let inner = self.inner.lock().unwrap();
        let span = started.map(|(origin, generation, wait, id)| {
            let acquired = origin.elapsed().as_secs_f64() * 1000.0;
            let mut r = self.recording.lock().unwrap();
            if r.generation == generation {
                if let Some(active) = r.active.get_mut(&id) {
                    active.acquired = Some(acquired);
                }
            }
            (
                generation,
                origin,
                Span {
                    id,
                    request,
                    operation,
                    wait,
                    acquired,
                    released: 0.0,
                },
            )
        });
        Guard {
            inner,
            trace: self,
            span,
        }
    }
}
pub struct Guard<'a, T> {
    inner: MutexGuard<'a, T>,
    trace: &'a TracedMutex<T>,
    span: Option<(u64, Instant, Span)>,
}
impl<T> Deref for Guard<'_, T> {
    type Target = T;
    fn deref(&self) -> &T {
        &self.inner
    }
}
impl<T> DerefMut for Guard<'_, T> {
    fn deref_mut(&mut self) -> &mut T {
        &mut self.inner
    }
}
impl<T> Drop for Guard<'_, T> {
    fn drop(&mut self) {
        if let Some((generation, origin, mut span)) = self.span.take() {
            span.released = origin.elapsed().as_secs_f64() * 1000.0;
            let mut r = self.trace.recording.lock().unwrap();
            if r.generation != generation {
                return;
            }
            r.active.remove(&span.id);
            if r.spans.len() < 30000 {
                r.spans.push(span);
            } else {
                r.dropped += 1;
            }
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_completed_owners_and_ignores_prior_recordings() {
        let m = TracedMutex::new(1);
        drop(m.lock("off", None));
        assert!(m.snapshot().0.is_empty());
        m.start();
        let old = m.lock("old", None);
        m.start();
        drop(old);
        assert!(m.snapshot().0.is_empty());
        {
            let mut guard = m.lock("render", Some(7));
            *guard = 3;
        }
        let spans = m.snapshot().0;
        assert_eq!(spans.len(), 1);
        assert_eq!(spans[0].request, Some(7));
        assert!(spans[0].released >= spans[0].acquired && spans[0].acquired >= spans[0].wait);
        m.stop();
        drop(m.lock("off", None));
        assert_eq!(m.snapshot().0.len(), 1);
    }
    #[test]
    fn waiter_interval_intersects_the_owner() {
        use std::sync::{mpsc, Arc};
        let m = Arc::new(TracedMutex::new(()));
        m.start();
        let held = m.lock("owner", Some(1));
        let (tx, rx) = mpsc::channel();
        let other = m.clone();
        let worker = std::thread::spawn(move || {
            tx.send(()).unwrap();
            drop(other.lock("waiter", Some(2)));
        });
        rx.recv().unwrap();
        let deadline = Instant::now() + std::time::Duration::from_secs(1);
        while m.snapshot().2.len() < 2 && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert_eq!(m.snapshot().2.len(), 2, "waiter was not observed");
        drop(held);
        worker.join().unwrap();
        let spans = m.snapshot().0;
        assert_eq!(spans.len(), 2);
        let owner = spans.iter().find(|s| s.operation == "owner").unwrap();
        let waiter = spans.iter().find(|s| s.operation == "waiter").unwrap();
        assert!(waiter.acquired >= owner.released);
        assert!(waiter.wait < owner.released);
    }
    #[test]
    fn reports_pending_owners_and_overflow() {
        let m = TracedMutex::new(());
        m.start();
        let held = m.lock("held", Some(5));
        let pending = m.snapshot().2;
        assert_eq!(pending.len(), 1);
        assert!(pending[0].acquired.is_some());
        drop(held);
        for _ in 0..30000 {
            drop(m.lock("bounded", None));
        }
        let (spans, dropped, pending) = m.snapshot();
        assert_eq!(spans.len(), 30000);
        assert_eq!(dropped, 1);
        assert!(pending.is_empty());
    }
}

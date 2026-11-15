// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors
use crate::{
    local_search::{self, LocalPage, LocalSearchArgs},
    AppState,
};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::State;
#[derive(Default)]
pub struct Requests(Mutex<HashMap<u64, Arc<AtomicBool>>>);
struct Ticket {
    id: u64,
    requests: Arc<Requests>,
    cancelled: Arc<AtomicBool>,
}
impl Requests {
    fn begin(self: &Arc<Self>, id: u64) -> Result<Ticket, String> {
        let mut requests = self.0.lock().map_err(|_| "Search request lock poisoned")?;
        if id == 0 || requests.contains_key(&id) {
            return Err("Invalid or duplicate local search request".into());
        }
        if requests.len() >= 4 {
            return Err("Local search is busy; retry shortly".into());
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        requests.insert(id, cancelled.clone());
        Ok(Ticket {
            id,
            requests: self.clone(),
            cancelled,
        })
    }
    fn cancel(&self, id: u64) {
        if let Ok(requests) = self.0.lock() {
            if let Some(cancelled) = requests.get(&id) {
                cancelled.store(true, Ordering::Release);
            }
        }
    }
    pub fn cancel_all(&self) {
        if let Ok(requests) = self.0.lock() {
            for cancelled in requests.values() {
                cancelled.store(true, Ordering::Release);
            }
        }
    }
}
impl Ticket {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    fn publish<T>(&self, publish: impl FnOnce() -> T) -> Option<T> {
        let _guard = self.requests.0.lock().ok()?;
        if self.cancelled() {
            None
        } else {
            Some(publish())
        }
    }
}
impl Drop for Ticket {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.requests.0.lock() {
            requests.remove(&self.id);
        }
    }
}
#[tauri::command]
#[specta::specta]
pub async fn local_search(
    state: State<'_, AppState>,
    args: LocalSearchArgs,
    request_id: u64,
) -> Result<LocalPage, String> {
    args.validate()?;
    let cache = state
        .search_cache
        .clone()
        .ok_or("Local metadata cache is unavailable")?;
    let ticket = state.local_search_requests.begin(request_id)?;
    let models = state.clip_models.clone();
    let engine = state.tagged.clone();
    let runtime = state.runtime.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    if !state
        .analysis_queue
        .submit_foreground(format!("local-search:{request_id}"), move |job| {
            let cancelled = || job.cancelled() || ticket.cancelled();
            let result = (|| {
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                let config = crate::settings::read_key(&runtime, "immage.library")
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                    .unwrap_or_default();
                let paths = |key: &str| {
                    config[key]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str())
                        .map(PathBuf::from)
                        .collect::<Vec<_>>()
                };
                let roots = paths("folders");
                let hidden = paths("hidden");
                let vector = if args.mode == "smart" && !args.text.trim().is_empty() {
                    Some(crate::clip_infer::text(
                        &models, &engine, &runtime, &args.text,
                    )?)
                } else {
                    None
                };
                if cancelled() {
                    return Err("Search cancelled".into());
                }
                let mut page =
                    local_search::retrieve(&cache, &args, &roots, &hidden, vector, cancelled)?;
                for hit in &mut page.items {
                    hit.image.imgid =
                        engine.cached_photo(&hit.image.path, i64::from(hit.image.version));
                }
                Ok(page)
            })();
            let _ = job.commit(|| ticket.publish(|| send.send(result)));
        })
    {
        return Err("Background queue is full; retry local search shortly".into());
    }
    receive.await.map_err(|_| "Search cancelled".to_string())?
}
#[tauri::command]
#[specta::specta]
pub fn local_search_cancel(state: State<'_, AppState>, request_id: u64) {
    state.local_search_requests.cancel(request_id);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_retains_admission_until_work_exits_and_blocks_late_publication() {
        let requests = Arc::new(Requests::default());
        let mut tickets = Vec::new();
        for id in 1..=4 {
            tickets.push(requests.begin(id).unwrap());
        }
        assert!(requests.begin(1).is_err());
        assert!(requests.begin(5).is_err());
        requests.cancel(1);
        assert!(tickets[0].cancelled());
        assert!(tickets[0].publish(|| panic!("late publish")).is_none());
        assert!(requests.begin(5).is_err());
        tickets.remove(0);
        let next = requests.begin(5).unwrap();
        assert_eq!(next.publish(|| 42), Some(42));
        requests.cancel_all();
        assert!(next.cancelled());
    }
}

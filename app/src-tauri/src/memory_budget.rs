//! One memory budget for Immage's caches, from the computer's RAM and the
//! Memory level (Preferences). The figure is darktable's own available
//! memory at that level (darktable.c: dt_get_available_mem and the
//! resourcelevel fractions), so the render caches, the page's frame cache and
//! its thumbnails all scale together.

use serde::Serialize;
use tauri::State;

use crate::{engine, AppState};

#[derive(Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryBudget {
    pub total_mb: u64,
    pub level: String,
    pub budget_mb: u64,
    pub frame_cache_mb: u64,
    pub thumb_memory_mb: u64,
}

/// the level's share of memory, in 1024ths (darktable.c resource levels)
fn fraction(level: &str) -> u64 {
    match level {
        "small" => 128,
        "large" => 700,
        _ => 512,
    }
}

pub fn compute(total_mb: u64, level: &str) -> MemoryBudget {
    let level = if engine::RESOURCE_LEVELS.contains(&level) { level } else { "default" };
    // darktable leaves a gigabyte to the system below 8 GB
    let usable = if total_mb < 8192 { total_mb.saturating_sub(1024) } else { total_mb };
    let budget_mb = (usable * fraction(level) / 1024).max(512);
    MemoryBudget {
        total_mb,
        level: level.to_string(),
        budget_mb,
        frame_cache_mb: (budget_mb / 10).clamp(128, 2048),
        thumb_memory_mb: (budget_mb / 8).clamp(128, 4096),
    }
}

#[tauri::command]
pub fn memory_budget(state: State<'_, AppState>) -> MemoryBudget {
    use sysinfo::{MemoryRefreshKind, RefreshKind, System};
    let sys = System::new_with_specifics(RefreshKind::nothing().with_memory(MemoryRefreshKind::nothing().with_ram()));
    compute(sys.total_memory() / (1 << 20), &engine::resource_level(&state.runtime))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_level_sizes() {
        let b = compute(8192, "default");
        assert_eq!((b.budget_mb, b.frame_cache_mb, b.thumb_memory_mb), (4096, 409, 512));
        let b = compute(16384, "default");
        assert_eq!((b.budget_mb, b.frame_cache_mb, b.thumb_memory_mb), (8192, 819, 1024));
        let b = compute(65536, "default");
        assert_eq!((b.budget_mb, b.frame_cache_mb, b.thumb_memory_mb), (32768, 2048, 4096));
    }

    #[test]
    fn levels_scale() {
        assert_eq!(compute(16384, "small").budget_mb, 2048);
        assert_eq!(compute(16384, "large").budget_mb, 11200);
        assert_eq!(compute(65536, "small").budget_mb, 8192);
        assert_eq!(compute(65536, "large").budget_mb, 44800);
    }

    #[test]
    fn under_8gb_leaves_a_gigabyte() {
        assert_eq!(compute(4096, "default").budget_mb, 1536);
        assert_eq!(compute(7168, "default").budget_mb, 3072);
    }

    #[test]
    fn clamps_and_unknown_level() {
        let b = compute(1024, "small");
        assert_eq!((b.budget_mb, b.frame_cache_mb, b.thumb_memory_mb), (512, 128, 128));
        let b = compute(1 << 20, "large");
        assert_eq!((b.frame_cache_mb, b.thumb_memory_mb), (2048, 4096));
        assert_eq!(compute(16384, "bogus"), compute(16384, "default"));
    }
}

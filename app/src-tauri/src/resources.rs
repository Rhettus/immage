// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 the Immage authors

use serde_json::{json, Value};
use std::collections::HashSet;
#[cfg(target_os = "linux")]
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

struct Recording {
    stop: mpsc::Sender<()>,
    worker: std::thread::JoinHandle<Value>,
}
static RECORDING: Mutex<Option<Recording>> = Mutex::new(None);
const INTERVAL: Duration = Duration::from_millis(500);

fn unix_ms() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis()
}

#[tauri::command]
pub fn perf_resources_start() -> Result<(), String> {
    let mut recording = RECORDING.lock().map_err(|e| e.to_string())?;
    if std::env::var("IMMAGE_BENCH_RESOURCES").as_deref() == Ok("0") {
        return Err("resource sampling disabled by IMMAGE_BENCH_RESOURCES=0".into());
    }
    if recording.as_ref().is_some_and(|r| r.worker.is_finished()) { *recording = None; }
    if recording.is_some() { return Err("resource recording already running".into()); }
    let (stop, rx) = mpsc::channel();
    let worker = std::thread::Builder::new().name("benchmark-resources".into())
        .spawn(move || collect(rx)).map_err(|e| e.to_string())?;
    *recording = Some(Recording { stop, worker });
    Ok(())
}

#[tauri::command]
pub async fn perf_resources_stop() -> Result<Value, String> {
    let recording = RECORDING.lock().map_err(|e| e.to_string())?.take()
        .ok_or("no resource recording running")?;
    let _ = recording.stop.send(());
    tauri::async_runtime::spawn_blocking(move || recording.worker.join()
        .map_err(|_| "resource recording failed".to_string()))
        .await.map_err(|e| e.to_string())?
}

fn descendants(sys: &System, root: Pid) -> HashSet<Pid> {
    let mut selected = HashSet::from([root]);
    loop {
        let before = selected.len();
        for (pid, p) in sys.processes() {
            if p.parent().is_some_and(|parent| selected.contains(&parent)) { selected.insert(*pid); }
        }
        if before == selected.len() { return selected; }
    }
}

fn refresh(sys: &mut System) {
    sys.refresh_cpu_usage();
    sys.refresh_memory();
    // tasks are read only for our process tree on Linux, avoiding a scan of every system thread
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true,
        ProcessRefreshKind::nothing().with_cpu().with_memory().without_tasks());
}

fn collect(stop: mpsc::Receiver<()>) -> Value {
    let started = unix_ms();
    let root = Pid::from_u32(std::process::id());
    let mut sys = System::new();
    let mut threads = Threads::default();
    let mut gpu = Gpus::new();
    refresh(&mut sys);
    threads.sample(&descendants(&sys, root), 1.0);
    let mut previous = Instant::now();
    let mut samples = Vec::new();
    // a bound also stops an abandoned recording after a webview reload
    while samples.len() < 1200 {
        match stop.recv_timeout(INTERVAL) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => (),
        }
        let tick = Instant::now();
        refresh(&mut sys);
        let selected = descendants(&sys, root);
        let processes: Vec<Value> = selected.iter().filter_map(|pid| {
            sys.process(*pid).map(|p| json!({ "pid": pid.as_u32(), "name": p.name().to_string_lossy(),
                "cpuPercent": p.cpu_usage(), "rssBytes": p.memory() }))
        }).collect();
        let cpu: Vec<f32> = sys.cpus().iter().map(|c| c.cpu_usage()).collect();
        let busiest = threads.sample(&selected, tick.duration_since(previous).as_secs_f64());
        let elapsed = tick.duration_since(previous).as_millis();
        previous = tick;
        let gpus = gpu.sample();
        let mut sample = json!({ "atUnixMs": unix_ms(), "intervalMs": elapsed,
            "cpuPercent": cpu, "processes": processes, "threads": busiest,
            "memory": { "usedBytes": sys.used_memory(), "availableBytes": sys.available_memory(),
                "swapUsedBytes": sys.used_swap() }, "gpus": gpus,
            "memoryPressure": memory_pressure() });
        sample["collectionMs"] = json!(tick.elapsed().as_secs_f64() * 1000.0);
        samples.push(sample);
    }
    json!({ "startedUnixMs": started, "intervalMs": INTERVAL.as_millis(),
        "cpuPercentConvention": "100% = one logical CPU; process totals can exceed 100%",
        "threadSupport": cfg!(target_os = "linux"), "gpuSupport": gpu.support,
        "rendererEvidence": renderer_evidence(&sys, &descendants(&sys, root)),
        "samples": samples })
}

#[derive(Default)]
struct Threads {
    #[cfg(target_os = "linux")]
    ticks: HashMap<(u32, u32), u64>,
}
impl Threads {
    #[cfg(target_os = "linux")]
    fn sample(&mut self, selected: &HashSet<Pid>, seconds: f64) -> Vec<Value> {
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) } as f64;
        let mut next = HashMap::new();
        let mut busy = Vec::new();
        for pid in selected {
            let Ok(tasks) = std::fs::read_dir(format!("/proc/{pid}/task")) else { continue };
            for task in tasks.flatten() {
                let Some(tid) = task.file_name().to_str().and_then(|s| s.parse::<u32>().ok()) else { continue };
                let Ok(stat) = std::fs::read_to_string(task.path().join("stat")) else { continue };
                let Some((name, ticks)) = thread_stat(&stat) else { continue };
                let key = (pid.as_u32(), tid);
                if let Some(before) = self.ticks.get(&key) {
                    let percent = ticks.saturating_sub(*before) as f64 / hz / seconds * 100.0;
                    busy.push((percent, json!({ "pid": pid.as_u32(), "tid": tid, "name": name, "cpuPercent": percent })));
                }
                next.insert(key, ticks);
            }
        }
        self.ticks = next;
        busy.sort_by(|a, b| b.0.total_cmp(&a.0));
        busy.into_iter().take(8).map(|(_, value)| value).collect()
    }
    #[cfg(not(target_os = "linux"))]
    fn sample(&mut self, _: &HashSet<Pid>, _: f64) -> Vec<Value> { Vec::new() }
}

#[cfg(target_os = "linux")]
fn thread_stat(stat: &str) -> Option<(String, u64)> {
    let (head, tail) = stat.rsplit_once(')')?;
    let fields: Vec<_> = tail.split_whitespace().collect();
    let user: u64 = fields.get(11)?.parse().ok()?;
    let system: u64 = fields.get(12)?.parse().ok()?;
    Some((head.split_once('(')?.1.to_string(), user + system))
}

fn memory_pressure() -> Option<String> {
    std::fs::read_to_string("/proc/pressure/memory").ok()
}

struct Gpus {
    devices: Vec<std::path::PathBuf>,
    nvidia: Option<std::process::Child>,
    readings: mpsc::Receiver<Vec<Value>>,
    support: Value,
}
impl Gpus {
    fn new() -> Self {
        let devices: Vec<_> = std::fs::read_dir("/sys/class/drm").into_iter().flatten().flatten()
            .filter(|e| { let n = e.file_name(); let n = n.to_string_lossy();
                n.strip_prefix("card").is_some_and(|v| !v.is_empty() && v.chars().all(|c| c.is_ascii_digit())) })
            .map(|e| e.path().join("device"))
            .filter(|p| p.join("gpu_busy_percent").exists() || p.join("mem_info_vram_used").exists()).collect();
        let (tx, readings) = mpsc::channel();
        // one persistent driver query, rather than launching nvidia-smi for each sample
        let mut command = std::process::Command::new("nvidia-smi");
        command.args(["--query-gpu=index,name,utilization.gpu,utilization.memory,memory.used,memory.total",
            "--format=csv,noheader,nounits", "--loop-ms=1000"])
            .stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::null());
        #[cfg(target_os = "windows")]
        { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut nvidia = command.spawn().ok();
        if let Some(stdout) = nvidia.as_mut().and_then(|p| p.stdout.take()) {
            std::thread::spawn(move || {
                use std::io::BufRead;
                for line in std::io::BufReader::new(stdout).lines().map_while(Result::ok) {
                    if let Some(value) = nvidia_row(&line) {
                        if tx.send(vec![value]).is_err() { break; }
                    }
                }
            });
        }
        let support = json!({ "nvidiaQueryStarted": nvidia.is_some(), "drmDevices": devices.len(),
            "note": "GPU samples are device-wide, not per process; absent or null readings mean unavailable" });
        Self { devices, nvidia, readings, support }
    }
    fn sample(&mut self) -> Vec<Value> {
        let mut latest = std::collections::BTreeMap::new();
        for batch in self.readings.try_iter() {
            for value in batch { latest.insert(value["id"].to_string(), value); }
        }
        let mut values: Vec<_> = latest.into_values().collect();
        for path in &self.devices {
            let read = |name| std::fs::read_to_string(path.join(name)).ok()?.trim().parse::<u64>().ok();
            values.push(json!({ "id": path.parent().and_then(|p| p.file_name()).map(|s| s.to_string_lossy()),
                "source": "drm-sysfs", "busyPercent": read("gpu_busy_percent"),
                "vramUsedBytes": read("mem_info_vram_used"), "vramTotalBytes": read("mem_info_vram_total") }));
        }
        values
    }
}
impl Drop for Gpus {
    fn drop(&mut self) {
        if let Some(child) = self.nvidia.as_mut() { let _ = child.kill(); let _ = child.wait(); }
    }
}
fn nvidia_row(line: &str) -> Option<Value> {
    let f: Vec<_> = line.split(',').map(str::trim).collect();
    if f.len() != 6 || f[0].parse::<u32>().is_err() { return None; }
    let number = |i: usize| f[i].parse::<f64>().ok();
    Some(json!({ "id": format!("nvidia:{}", f[0]), "name": f[1], "source": "nvidia-smi",
        "busyPercent": number(2), "memoryBusyPercent": number(3),
        "vramUsedBytes": number(4).map(|n| n * 1048576.0), "vramTotalBytes": number(5).map(|n| n * 1048576.0) }))
}

#[cfg(target_os = "linux")]
fn renderer_evidence(sys: &System, selected: &HashSet<Pid>) -> Value {
    let processes: Vec<_> = selected.iter().filter_map(|pid| {
        let process = sys.process(*pid)?;
        let maps = std::fs::read_to_string(format!("/proc/{pid}/maps"));
        let libraries: std::collections::BTreeSet<_> = maps.as_ref().ok().into_iter()
            .flat_map(|s| s.lines()).filter_map(|line| line.split_whitespace().last())
            .filter_map(|path| std::path::Path::new(path).file_name()?.to_str())
            .filter(|name| name.starts_with("libEGL") || name.starts_with("libGLX")
                || name.starts_with("libnvidia") || name.starts_with("libvulkan")
                || name.starts_with("libgallium") || name.ends_with("_dri.so"))
            .map(str::to_string).collect();
        let fds = std::fs::read_dir(format!("/proc/{pid}/fd"));
        let fds_readable = fds.is_ok();
        let devices: std::collections::BTreeSet<_> = fds.into_iter().flatten()
            .filter_map(|entry| std::fs::read_link(entry.as_ref().ok()?.path()).ok())
            .map(|p| p.to_string_lossy().into_owned())
            .filter(|p| p.starts_with("/dev/dri/") || p.starts_with("/dev/nvidia")).collect();
        Some(json!({ "pid": pid.as_u32(), "name": process.name().to_string_lossy(),
            "driverLibraries": libraries, "gpuDevices": devices,
            "mapsReadable": maps.is_ok(), "fdsReadable": fds_readable }))
    }).collect();
    json!({ "source": "own-process-tree /proc maps and device descriptors at end of run",
        "compositorAcceleration": "unconfirmed",
        "note": "Loaded drivers and open GPU devices are evidence, not proof of compositor acceleration; WebGL describes its own context only",
        "processes": processes,
        "nvidiaDriverVersion": std::fs::read_to_string("/sys/module/nvidia/version").ok().map(|s| s.trim().to_string()) })
}
#[cfg(not(target_os = "linux"))]
fn renderer_evidence(_: &System, _: &HashSet<Pid>) -> Value { Value::Null }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn nvidia_missing_values_are_not_zero() {
        let value = nvidia_row("0, NVIDIA Test, 98, [N/A], 1024, 8192").unwrap();
        assert_eq!(value["busyPercent"], 98.0);
        assert_eq!(value["vramUsedBytes"], 1073741824.0);
        assert!(value["memoryBusyPercent"].is_null());
        assert!(nvidia_row("driver unavailable").is_none());
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn thread_name_can_contain_parentheses() {
        assert_eq!(thread_stat("123 (worker (main)) R 1 2 3 4 5 6 7 8 9 10 25 7 0"),
            Some(("worker (main)".into(), 32)));
    }
    #[test]
    fn recording_captures_live_cpu_and_memory() {
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || collect(rx));
        let until = Instant::now() + Duration::from_millis(1250);
        while Instant::now() < until { std::hint::spin_loop(); }
        tx.send(()).unwrap();
        let report = worker.join().unwrap();
        println!("resource-smoke-report: {report}");
        let samples = report["samples"].as_array().unwrap();
        assert!(!samples.is_empty());
        #[cfg(target_os = "linux")]
        assert!(samples.iter().flat_map(|s| s["threads"].as_array().unwrap())
            .any(|t| t["cpuPercent"].as_f64().unwrap_or(0.0) > 0.0));
        assert!(!samples[0]["cpuPercent"].as_array().unwrap().is_empty());
        assert!(samples[0]["memory"]["availableBytes"].as_u64().unwrap() > 0);
        assert!(samples[0]["processes"].as_array().unwrap().iter()
            .any(|p| p["pid"] == std::process::id()));
    }
}

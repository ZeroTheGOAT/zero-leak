//! §2 — hardware telemetry.
//!
//! The status bar shows VRAM because on an 8 GB card VRAM is the binding
//! constraint on everything this application does: which model can load, whether
//! a second one can be resident, whether a vision model has room for a 2200-pixel
//! page. An operator who can see 6.8 of 7.1 GiB in use understands why the next
//! request evicted something. One who cannot, does not.
//!
//! GPU figures come from `nvidia-smi`, queried in CSV mode. That is a local
//! process, not a network call, and it is the only interface NVIDIA ships that
//! does not require linking NVML — a DLL that may or may not be present and
//! whose absence would be a link error rather than a missing number. If
//! `nvidia-smi` is not on the machine, the GPU fields say so instead of showing
//! a plausible zero: `gpu_name` carries the reason, and the Models panel's
//! VRAM arithmetic falls back to the catalogue's budget. §1 — a number this
//! application cannot actually measure is not displayed as if it had been.
//!
//! CPU and RAM come from `sysinfo`, which reads them from the OS directly.

use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use crate::error::CoreResult;
use crate::state::AppState;
use crate::types::*;

/// How often the poller publishes. Two seconds is fast enough that a model load
/// is visible while it happens and slow enough that the query costs nothing
/// measurable — `nvidia-smi` takes ~40 ms and `sysinfo` refreshes in ~5 ms.
const POLL_INTERVAL_MS: u64 = 2000;

/// `sysinfo` needs to keep its previous sample to compute CPU utilisation: the
/// figure is a delta between two reads, and a fresh `System` every poll reports
/// either zero or a garbage first value. One long-lived instance, behind a std
/// mutex that is never held across an await.
fn system() -> &'static Mutex<sysinfo::System> {
    static SYS: OnceLock<Mutex<sysinfo::System>> = OnceLock::new();
    SYS.get_or_init(|| {
        let mut s = sysinfo::System::new();
        s.refresh_memory();
        s.refresh_cpu_usage();
        Mutex::new(s)
    })
}

/// Set once `nvidia-smi` has been tried and found missing, so a machine without
/// an NVIDIA GPU does not pay for a failed process spawn every two seconds
/// forever.
fn smi_missing() -> &'static AtomicBool {
    static MISSING: OnceLock<AtomicBool> = OnceLock::new();
    MISSING.get_or_init(|| AtomicBool::new(false))
}

/// The card's measured total, kept for the admission arithmetic in `registry`.
///
/// `nvidia-smi` is a process spawn taking ~40 ms, and `make_room` is
/// synchronous and on the request path, so it cannot query the card itself. This
/// is the last reading the poller took. Zero means nothing has measured it yet.
fn measured_total() -> &'static AtomicU32 {
    static TOTAL: OnceLock<AtomicU32> = OnceLock::new();
    TOTAL.get_or_init(|| AtomicU32::new(0))
}

/// What the card actually has, or nothing if it has not been measured.
///
/// Read by `registry::vram_total_mb`, which every admission decision goes
/// through. Never falls back on its own: the caller decides what an unmeasured
/// card means, and for admission that is the catalogue's tuned figure.
pub fn measured_vram_total_mb() -> Option<u32> {
    let mb = measured_total().load(Ordering::Relaxed);
    (mb > 0).then_some(mb)
}

/// What `nvidia-smi` reported, or nothing.
struct Gpu {
    name: String,
    used_mb: u32,
    total_mb: u32,
    util_pct: u32,
}

/// Queries `nvidia-smi` for the first GPU.
///
/// `--format=csv,noheader,nounits` is asked for specifically so the output is
/// four comma-separated integers and a name — parsing the human-readable table
/// would break the first time NVIDIA adjusted a column width.
fn query_gpu() -> Option<Gpu> {
    if smi_missing().load(Ordering::Relaxed) {
        return None;
    }

    let mut cmd = std::process::Command::new("nvidia-smi");
    cmd.args([
        "--query-gpu=name,memory.used,memory.total,utilization.gpu",
        "--format=csv,noheader,nounits",
    ])
    .stdin(std::process::Stdio::null())
    .stdout(std::process::Stdio::piped())
    .stderr(std::process::Stdio::null());

    // No console window for a query that runs every two seconds.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let out = match cmd.output() {
        Ok(o) if o.status.success() => o,
        Ok(_) => return None,
        Err(_) => {
            // Not installed, or not on PATH. Recorded so we stop asking.
            smi_missing().store(true, Ordering::Relaxed);
            return None;
        }
    };

    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?;
    let cols: Vec<&str> = line.split(',').map(str::trim).collect();
    if cols.len() < 4 {
        return None;
    }

    Some(Gpu {
        name: cols[0].to_string(),
        used_mb: cols[1].parse().unwrap_or(0),
        total_mb: cols[2].parse().unwrap_or(0),
        util_pct: cols[3].parse().unwrap_or(0),
    })
}

/// One reading. Async only because the command interface is; the work is
/// blocking and short, so it runs on a blocking thread rather than stalling the
/// runtime for the 40 ms `nvidia-smi` takes.
pub async fn status(st: &AppState) -> CoreResult<HardwareStatus> {
    let snapshot = tokio::task::spawn_blocking(sample)
        .await
        .unwrap_or_else(|_| sample_fallback());

    // `offloading` is the one field that is a judgement rather than a
    // measurement, and it is derived from what is resident against what the card
    // physically has: if a loaded model needs more than the card can hold,
    // llama.cpp is keeping layers in system RAM. Saying so matters because it is
    // the difference between 40 tokens/sec and 4, and an operator watching a slow
    // answer deserves to know which one they are getting.
    //
    // It used to compare against the *sharing* budget, which is 1081 MiB smaller
    // than the card on purpose. olmOCR-2 is admitted solo at 7387 MiB by design
    // and runs fully offloaded at 54 tok/s, so the warning lit on every
    // handwritten page — the one path where it was certainly wrong — while the
    // measured total sat unused beside it. Against the solo limit it says what it
    // claims to, and because that limit now follows the measured card, a machine
    // smaller than this catalogue was tuned for is reported rather than hidden.
    let mut out = snapshot;
    let resident_mb: u32 = match st.registry.read() {
        Ok(reg) => {
            let loaded = st.loaded_ids();
            reg.all()
                .iter()
                .filter(|e| loaded.contains(&e.id))
                .map(|e| e.estimated_vram_mb)
                .sum()
        }
        Err(_) => 0,
    };

    if out.vram_total_mb == 0 {
        // No measurement available. The catalogue's figures are what the routing
        // decisions were made against, so they are what to show — and the name
        // field already says the numbers are not measured.
        out.vram_total_mb = crate::registry::VRAM_TOTAL_MB;
        out.vram_used_mb = resident_mb.min(crate::registry::VRAM_TOTAL_MB);
    }
    out.vram_budget_mb = crate::registry::vram_budget_mb();
    out.offloading = resident_mb > 0 && resident_mb > crate::registry::vram_solo_mb();

    Ok(out)
}

fn sample_fallback() -> HardwareStatus {
    HardwareStatus {
        gpu_name: "Telemetry unavailable".into(),
        vram_used_mb: 0,
        vram_total_mb: 0,
        vram_budget_mb: 0,
        gpu_util_pct: 0,
        cpu_name: String::new(),
        cpu_util_pct: 0,
        ram_used_mb: 0,
        ram_total_mb: 0,
        offloading: false,
    }
}

/// The blocking half: one `nvidia-smi` query and one `sysinfo` refresh.
fn sample() -> HardwareStatus {
    let gpu = query_gpu();
    if let Some(mb) = gpu.as_ref().map(|g| g.total_mb).filter(|mb| *mb > 0) {
        // Published for `registry::vram_total_mb`, which every admission
        // decision reads. Stored on every sample rather than once, because an
        // eGPU or a driver restart can change what the card reports.
        measured_total().store(mb, Ordering::Relaxed);
    }

    let (cpu_name, cpu_util_pct, ram_used_mb, ram_total_mb) = match system().lock() {
        Ok(mut sys) => {
            sys.refresh_memory();
            sys.refresh_cpu_usage();

            let cpus = sys.cpus();
            let name = cpus
                .first()
                .map(|c| c.brand().trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "CPU".to_string());
            // The mean across cores, which is what Task Manager's single figure
            // is. A per-core maximum would sit at 100% whenever one thread was
            // busy and tell the operator nothing.
            let util = if cpus.is_empty() {
                0.0
            } else {
                cpus.iter().map(|c| c.cpu_usage()).sum::<f32>() / cpus.len() as f32
            };
            let total = sys.total_memory() / (1024 * 1024);
            let used = sys.used_memory() / (1024 * 1024);
            (name, util.round().clamp(0.0, 100.0) as u32, used as u32, total as u32)
        }
        Err(_) => (String::new(), 0, 0, 0),
    };

    let (gpu_name, vram_used_mb, vram_total_mb, gpu_util_pct) = match gpu {
        Some(g) => (g.name, g.used_mb, g.total_mb, g.util_pct.min(100)),
        None => (
            // Named honestly rather than left blank: an empty GPU field reads as
            // "no GPU", which on a machine where nvidia-smi simply is not on
            // PATH would be wrong.
            if smi_missing().load(Ordering::Relaxed) {
                "GPU telemetry unavailable (nvidia-smi not found)".to_string()
            } else {
                "GPU telemetry unavailable".to_string()
            },
            0,
            0,
            0,
        ),
    };

    HardwareStatus {
        gpu_name,
        vram_used_mb,
        vram_total_mb,
        // Filled in by `status`, which has the registry to read the budget from.
        vram_budget_mb: 0,
        gpu_util_pct,
        cpu_name,
        cpu_util_pct,
        ram_used_mb,
        ram_total_mb,
        offloading: false,
    }
}

/// Publishes `core://hardware` on a timer for the lifetime of the process.
///
/// A push rather than a poll from the UI, because the browser surface and the
/// desktop window both need it and `AppState::emit` reaches both from one place.
/// Identical consecutive readings are suppressed: the status bar does not need
/// the same numbers thirty times a minute, and every event is a message on the
/// SSE channel that a background tab has to work through when it wakes up.
pub fn spawn_poller(st: Arc<AppState>) {
    tauri::async_runtime::spawn(async move {
        let mut last: Option<(u32, u32, u32, u32, u32)> = None;
        loop {
            if let Ok(s) = status(&st).await {
                // Compared on the fields that move. Utilisation is rounded to
                // 5% so a GPU idling between 0 and 2% does not emit every tick.
                let key = (
                    s.vram_used_mb / 16,
                    s.gpu_util_pct / 5,
                    s.cpu_util_pct / 5,
                    s.ram_used_mb / 64,
                    u32::from(s.offloading),
                );
                if last != Some(key) {
                    last = Some(key);
                    st.emit("core://hardware", s);
                }
            }
            tokio::time::sleep(std::time::Duration::from_millis(POLL_INTERVAL_MS)).await;
        }
    });
}

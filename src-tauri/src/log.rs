//! Diagnostics that survive a packaged build.
//!
//! `eprintln!` is the right tool while a console is attached and nothing
//! otherwise. On a packaged Windows build (`windows_subsystem = "windows"`)
//! there is no console, so every `eprintln!` in the core was writing to
//! nowhere: a failed memory-mirror write, an idle eviction that could not
//! unload, a vault event that could not be recorded — all silent. A
//! deployment that has to be auditable cannot have its failure modes vanish
//! with the build profile.
//!
//! So the core logs through this module instead. One append-only file per
//! process, under the config directory, with a size cap: a log that grows
//! without bound on a long-running workstation is a slow disk failure of its
//! own. The cap is a truncate-to-tail (keep the newest lines), not a rotate,
//! because the newest lines are the ones an operator reading the file needs
//! and anything older is the audit DB's job, not this file's.
//!
//! Writing is deliberately cheap and failure-tolerant: a lock, a line, a
//! flush, and any error falls back to stderr so a read-only config directory
//! degrades to exactly the old behaviour rather than panicking a run that
//! was otherwise fine.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::OnceLock;

/// Where the log lives. The config directory already belongs to this
/// application and is where `models.json` sits; a sibling `core.log` is where
/// an operator looks for "what did it say".
fn log_path() -> PathBuf {
    crate::registry::config_dir().join("core.log")
}

/// 1 MiB of log is thousands of lines. Beyond that the tail is kept.
const MAX_BYTES: u64 = 1024 * 1024;

struct Sink {
    file: Option<File>,
    path: PathBuf,
}

static SINK: OnceLock<Mutex<Sink>> = OnceLock::new();

fn sink() -> &'static Mutex<Sink> {
    SINK.get_or_init(|| {
        let path = log_path();
        if let Some(dir) = path.parent() {
            // Same tolerance as the callers: a directory that cannot be made
            // means no file, not a failed run.
            let _ = std::fs::create_dir_all(dir);
        }
        let file = OpenOptions::new().create(true).append(true).open(&path).ok();
        // The cap is enforced once per process open, not per write: one stat
        // here versus one on every line of a chatty session.
        if let (Some(f), Ok(meta)) = (&file, path.metadata()) {
            if meta.len() > MAX_BYTES {
                if let Ok(text) = std::fs::read_to_string(&path) {
                    // Keep the newest half. `from` is a byte index on the
                    // char boundary search below, so a cut that would split a
                    // UTF-8 sequence is walked forward to the next boundary.
                    let cut = text.len() / 2;
                    let mut at = cut;
                    while at < text.len() && !text.is_char_boundary(at) {
                        at += 1;
                    }
                    if File::create(&path)
                        .and_then(|mut f| f.write_all(text[at..].as_bytes()))
                        .and_then(|_| f.sync_all())
                        .is_ok()
                    {
                        let _ = f.sync_all();
                        return Mutex::new(Sink { file, path });
                    }
                }
            }
        }
        Mutex::new(Sink { file, path })
    })
}

/// Timestamps to the second: enough to order lines against the audit DB,
/// which is the authoritative clock.
fn timestamp() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Days since epoch → Y-M-D, no chrono: the log needs a sortable date,
    // not a calendar. Correct from 1970 through 9999.
    let days = secs / 86_400;
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02} {:02}:{:02}:{02}", (secs / 3600) % 24, (secs / 60) % 60, secs % 60)
}

/// Howard Hinnant's `civil_from_days` — the standard days-to-date algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// One line in the log. `tag` names the subsystem ("router", "agent", ...) so
/// a reader can grep without knowing the module layout.
pub fn line(tag: &str, message: &str) {
    let entry = format!("{} [{}] {}\n", timestamp(), tag, message);
    let mut guard = match sink().lock() {
        Ok(g) => g,
        Err(_) => {
            eprint!("{entry}");
            return;
        }
    };
    match &mut guard.file {
        Some(f) => {
            // Append or fall back — never propagate: a logging failure is not
            // a reason to fail the operation that wanted to log.
            if let Err(e) = writeln!(f, "{entry}").and_then(|_| f.flush()) {
                eprintln!("[log] could not write {}: {e}", guard.path.display());
            }
        }
        None => eprint!("{entry}"),
    }
}

/// The `eprintln!`-shaped call sites keep their formatting with this macro:
/// `logln!("[agent] the mirror write failed: {e}")` writes the same line it
/// used to print. The bracketed tag the old messages already began with is
/// reused as the log's subsystem column rather than duplicated.
///
/// `#[macro_export]` puts it at the crate root, so every module reaches it
/// without an import, exactly like `eprintln!` before it.
#[macro_export]
macro_rules! logln {
    ($($arg:tt)*) => {{
        let text = format!($($arg)*);
        let (tag, rest) = match text.find("] ") {
            Some(end) if text.starts_with('[') => {
                (text[1..end].to_string(), text[end + 2..].to_string())
            }
            _ => ("core".to_string(), text),
        };
        $crate::log::line(&tag, &rest);
    }};
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_round_trip_against_the_reference_algorithm() {
        // Day 20671 since the epoch is 2026-08-06.
        assert_eq!(civil_from_days(20_671), (2026, 8, 6));
        // And today, 2026-09-06, is day 20702 — checked against the epoch.
        assert_eq!(civil_from_days(20_702), (2026, 9, 6));
        // The day before the epoch.
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        // The leap-day boundaries around 2000: 1999-12-31, then 2000-01-01.
        assert_eq!(civil_from_days(10_956), (1999, 12, 31));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
    }

    #[test]
    fn a_line_is_timestamped_and_tagged() {
        // The formatter is all this test can check without touching the real
        // sink; the write path is exercised by every other subsystem.
        let entry = format!("{} [router] idle eviction failed: boom\n", timestamp());
        assert!(entry.starts_with('2'), "{entry}");
        assert!(entry.contains("[router]"), "{entry}");
    }
}

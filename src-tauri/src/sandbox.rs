//! §8 — command execution, contained.
//!
//! Three things stand between a model-authored command and the workstation, and
//! they are checked in this order:
//!
//!   1. **The deny list**, before the allow list. A command that matches a
//!      denied pattern is refused whatever else it also matches, because
//!      `git clean -xfd` starting with an allowed word does not make it safe.
//!   2. **The allow list**, when it is non-empty. An unlisted executable is
//!      refused rather than run, so the set of things the sandbox can do is
//!      enumerable rather than "everything except what we thought of".
//!   3. **A job object** (`winproc`), which bounds memory, process count and
//!      lifetime, and blocks clipboard and desktop access.
//!
//! What this is not: a security boundary against a determined attacker who
//! already has code execution. Windows 11 Home has no Hyper-V and no Windows
//! Sandbox, so there is no VM to put this in. It is a resource and blast-radius
//! boundary plus an audited allow list, and the honest name for that is
//! containment, not isolation — which is what `winproc`'s header says too.
//!
//! Output streams as it arrives. A five-minute `pip install` that only reports
//! at the end is indistinguishable from a hang, and an operator watching a hang
//! kills it. Both pipes are read on their own threads and every line is emitted
//! as `sandbox://line` and appended to the stored run, so the console and the
//! audit trail see the same bytes.

use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::sync::Arc;

use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, now_ms, AppState, SandboxHandle};
use crate::types::*;

/// Cap on stored output lines per run.
///
/// A command that prints a million lines would otherwise put a million rows in
/// SQLite and a million events on the wire. The cap is generous enough for real
/// build output and the truncation is announced in the transcript rather than
/// silently applied — a tool result that was cut has to say so, or the model
/// reasons about output it never saw.
const MAX_LINES: usize = 4000;

/// Cap on a single line's length. A binary file catted into stdout arrives as
/// one enormous "line"; storing it whole is what turns a mistake into an
/// unopenable database.
const MAX_LINE_CHARS: usize = 4000;

/* ------------------------------------------------------------------ */
/* Policy                                                              */
/* ------------------------------------------------------------------ */

/// The live policy: catalogue defaults with the operator's settings applied.
///
/// Read from settings on every call rather than cached, so the figure the
/// console shows is the figure the next command is actually run under. A policy
/// panel that displays a stale limit is worse than no panel.
pub fn policy(st: &AppState) -> SandboxPolicy {
    let s = st.settings();
    let mut p = crate::registry::default_sandbox_policy();
    if !s.sandbox_root.trim().is_empty() {
        p.working_dir = s.sandbox_root.clone();
    }
    p.network_enabled = s.sandbox_network;
    if s.sandbox_timeout_sec > 0 {
        p.timeout_sec = s.sandbox_timeout_sec;
    }
    if s.sandbox_max_memory_mb > 0 {
        p.max_memory_mb = s.sandbox_max_memory_mb;
    }
    p
}

/// The first token of a command line, lowercased, without path or extension.
///
/// `C:\Python312\python.exe -V` and `python -V` are the same request as far as
/// the allow list is concerned, and a list that only matched the bare word would
/// be bypassed by writing the full path.
fn executable_of(command: &str) -> String {
    let first = command.trim().split_whitespace().next().unwrap_or_default();
    let first = first.trim_matches('"').trim_matches('\'');
    let base = std::path::Path::new(first)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| first.to_string());
    base.to_ascii_lowercase()
}

/// The file a bare program name refers to, resolved the way a shell resolves it.
///
/// `Command::new("npm")` does not run npm. Windows process creation searches
/// `PATH`, but only for the name as written plus `.exe` — it does not consult
/// `PATHEXT`. npm on disk is `npm.cmd`, `tree` is `tree.com`, so on a machine
/// where both are installed and on `PATH` both still come back as "the system
/// cannot find the file specified". The allow list shipped advertising `npm` and
/// `dir` while neither could ever start: a policy panel naming a capability the
/// sandbox did not have, which is the one thing a policy panel must not do.
///
/// So the search happens here — each `PATH` directory against each `PATHEXT`
/// extension, in the order those two variables list them, first hit wins. That
/// is the order a shell resolves in, which matters, because the operator's idea
/// of what `python` means is whatever `where python` prints.
///
/// Resolving before spawning also turns "the system cannot find the file
/// specified" — a message that names nothing — into one that names the program,
/// says it was searched for across `PATH` with every `PATHEXT` suffix, and
/// distinguishes "not installed" from "not allowed".
pub(crate) fn resolve_program(name: &str) -> Option<std::path::PathBuf> {
    let raw = name.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }

    // Anything with a separator is already a path, not a name to look up — but
    // it still gets the extension sweep, so `.\build` finds `.\build.cmd`.
    if raw.contains('\\') || raw.contains('/') {
        return with_extension(std::path::Path::new(raw));
    }

    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        if let Some(hit) = with_extension(&dir.join(raw)) {
            return Some(hit);
        }
    }
    None
}

/// The file `base` names once an extension has been supplied for it.
///
/// The order is the interpreter's, and it is not "whichever file exists". npm
/// installs three siblings — `npm.cmd`, `npm.ps1`, and an extensionless `npm`
/// that is a POSIX shell script — and trying the bare name first finds that
/// shell script, which Windows then refuses with "%1 is not a valid Win32
/// application". So the extension list is consulted first for any name that does
/// not already carry one, exactly as a shell would, and the bare file is only a
/// last resort for the case that a shell could not run either.
///
/// A name that *does* already end in a `PATHEXT` extension is taken as written:
/// `python.exe` must not be looked up as `python.exe.exe`.
fn with_extension(base: &std::path::Path) -> Option<std::path::PathBuf> {
    let exts = path_extensions();
    let name = base.as_os_str().to_string_lossy().to_ascii_lowercase();
    let already_suffixed = exts.iter().any(|e| name.ends_with(&e.to_ascii_lowercase()));

    if already_suffixed {
        return base.is_file().then(|| base.to_path_buf());
    }

    for ext in &exts {
        // `Path::with_extension` would eat a dot already in the stem —
        // `node-v1.2` becomes `node-v1.exe` — so the suffix is appended to the
        // whole name rather than replacing anything.
        let mut candidate = base.as_os_str().to_os_string();
        candidate.push(ext);
        let candidate = std::path::PathBuf::from(candidate);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    base.is_file().then(|| base.to_path_buf())
}

/// `PATHEXT`, split into suffixes. Falls back to the standard set, because the
/// sandbox builds a minimal environment and a missing variable must not quietly
/// reduce the lookup to nothing.
fn path_extensions() -> Vec<String> {
    let raw = std::env::var("PATHEXT").unwrap_or_default();
    let mut out: Vec<String> = raw
        .split(';')
        .map(|e| e.trim())
        .filter(|e| e.starts_with('.') && e.len() > 1)
        .map(|e| e.to_string())
        .collect();
    if out.is_empty() {
        out = [".COM", ".EXE", ".BAT", ".CMD"].iter().map(|s| s.to_string()).collect();
    }
    out
}

/// Why a command was refused, or `None` if it passes.
///
/// The deny check is a substring match on the whole command line, not on the
/// executable, because the dangerous part is often an argument: `net use`,
/// `powershell -enc`, a `curl` buried in a `&&` chain. Substring matching costs
/// some false positives — a file literally named `format` — and that is the
/// right trade for something that refuses rather than deletes.
fn refuse_reason(command: &str, p: &SandboxPolicy) -> Option<String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Some("An empty command was not run.".into());
    }
    let lower = cmd.to_ascii_lowercase();

    for denied in &p.denied_commands {
        let d = denied.to_ascii_lowercase();
        if d.is_empty() {
            continue;
        }
        // A single-word entry has to match as a word, or "rd" would refuse every
        // command containing those two letters. A multi-word entry ("net use",
        // "powershell -enc") is matched as a phrase, since that is the whole
        // reason it was written with a space in it.
        let hit = if d.contains(' ') || d.contains('-') {
            lower.contains(&d)
        } else {
            lower
                .split(|c: char| !c.is_alphanumeric() && c != '.' && c != '_')
                .any(|w| w == d)
        };
        if hit {
            return Some(format!(
                "Refused before anything ran: the command matches the denied pattern '{denied}'. \
                 The deny list is checked first and is not overridable per command — change it in Settings if this is genuinely needed."
            ));
        }
    }

    if !p.allowed_commands.is_empty() {
        let exe = executable_of(cmd);
        let allowed = p
            .allowed_commands
            .iter()
            .any(|a| executable_of(a) == exe || a.to_ascii_lowercase() == exe);
        if !allowed {
            return Some(format!(
                "Refused before anything ran: '{exe}' is not on the sandbox allow list ({}). \
                 The list is what makes the sandbox's reach enumerable, so an unlisted program is refused rather than tried.",
                p.allowed_commands.join(", ")
            ));
        }
    }

    // Shell metacharacters that chain a second command past the check above.
    // `cmd /C` would honour them, and an allowed `python` followed by `&& del`
    // is not an allowed command.
    //
    // The unspaced `&` matters more than it looks. Most programs here are spawned
    // directly, with no interpreter to give an `&` any meaning — but a batch-file
    // entry on the allow list (npm is one) can only be started through the
    // Windows command interpreter, and there the operators are live. So `&` is
    // refused wherever it appears rather than only when surrounded by spaces:
    // `npm run build&whoami` is a single token to a direct spawn and two commands
    // to the interpreter, and the check has to hold for the stricter reading.
    for (pat, what) in [("&&", "&&"), ("||", "||"), ("&", "&"), ("|", "|"), (";", ";"), ("`", "`")] {
        if cmd.contains(pat) {
            return Some(format!(
                "Refused before anything ran: the command contains '{what}', which chains or pipes a second program past the allow list. Run the steps as separate commands."
            ));
        }
    }
    if cmd.contains('>') || cmd.contains('<') {
        return Some(
            "Refused before anything ran: shell redirection is not available in the sandbox, because a redirect writes wherever it is pointed. Have the program write its own output file inside the sandbox folder."
                .into(),
        );
    }

    None
}

/// Splits a command line into program and arguments, honouring double quotes.
///
/// Written out rather than handed to `cmd /C` on purpose: going through the
/// shell would reintroduce every metacharacter the check above just refused, and
/// would make the quoting rules of the check different from the quoting rules of
/// the execution. One parser, used for both.
pub(crate) fn split_args(command: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;

    for ch in command.chars() {
        match ch {
            '"' => quoted = !quoted,
            c if c.is_whitespace() && !quoted => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/* ------------------------------------------------------------------ */
/* Persistence                                                         */
/* ------------------------------------------------------------------ */

pub(crate) fn truncate_line(text: &str) -> String {
    if text.chars().count() <= MAX_LINE_CHARS {
        return text.to_string();
    }
    let cut: String = text.chars().take(MAX_LINE_CHARS).collect();
    format!("{cut}… [line truncated]")
}

/// A refused run, stored and returned. A denial is a first-class outcome, not an
/// error: §13 wants it in the audit trail, and the console shows it in the same
/// place as a successful run so the refusal is visible rather than a silent
/// nothing-happened.
fn denied_run(st: &AppState, command: &str, cwd: &str, reason: String) -> CoreResult<SandboxRun> {
    let run = SandboxRun {
        id: new_id("sbx"),
        command: command.to_string(),
        cwd: cwd.to_string(),
        status: "denied".into(),
        exit_code: None,
        started_at: now_ms(),
        duration_ms: Some(0),
        output: vec![SandboxLine { stream: "system".into(), text: reason, at: now_ms() }],
    };
    st.with_db(|conn| crate::db::insert_sandbox_run(conn, &run))?;
    st.emit("sandbox://line", line_event(&run.id, &run.output[0]));
    Ok(run)
}

fn line_event(run_id: &str, line: &SandboxLine) -> SandboxLineEvent {
    // Read from the task-local rather than threaded through every call site:
    // the whole command runs inside the agent run's task when a tool call
    // started it, so this is the one place the chat the lines belong to can
    // be known. `None` for a console-initiated run, which is correct — the
    // console already has them.
    let (agent_run_id, session_id) = crate::state::current_run()
        .map_or((None, None), |(r, s)| (Some(r), Some(s)));
    SandboxLineEvent {
        run_id: run_id.to_string(),
        stream: line.stream.clone(),
        text: line.text.clone(),
        at: line.at,
        agent_run_id,
        session_id,
    }
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

/// One line from a child's pipe, tagged with which pipe it came from.
struct Chunk {
    stream: &'static str,
    text: String,
}

/// Run a command in the sandbox, in `dir` when the caller has a folder for it to
/// work in.
///
/// `git status`, `cargo build` and `npm test` are about a project, and started
/// from a scratch directory they are about nothing — the sandbox root holds one
/// generated `.py` file and no repository. So an approved workspace becomes the
/// child's working directory when the caller has one, which is also what makes
/// `open("thickness-log.csv")` in a generated script do the obvious thing. The
/// model had been told the workspace *was* the working directory; it was not,
/// and a script that opened a file by name failed on a machine where the file
/// was plainly there.
///
/// Only the working directory moves. The generated script still lands in the
/// sandbox root, so nothing this application writes appears inside the
/// operator's project, and `TEMP` still points there too. Containment is
/// unchanged: the job object, the allow list and the deny list do not depend on
/// where the child starts, and the operator approved the folder before anything
/// here could name it.
pub async fn run(st: Arc<AppState>, command: String, dir: Option<String>) -> CoreResult<SandboxRun> {
    exec(st, command, None, dir).await
}

/// Run a Python script in the sandbox. Separate from `run` because the script
/// has to reach disk before an interpreter can be pointed at it, and inlining
/// source into a command line is how quoting bugs become silent wrong answers.
/// `dir` is the working directory, as for [`run`].
pub async fn run_python(
    st: Arc<AppState>,
    code: String,
    dir: Option<String>,
) -> CoreResult<SandboxRun> {
    let p = policy(&st);
    // The script's own home, which is the sandbox root whatever working
    // directory the child is given: a generated file has no business appearing
    // inside the operator's project folder.
    let sandbox_dir = std::path::PathBuf::from(&p.working_dir);
    std::fs::create_dir_all(&sandbox_dir).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The sandbox folder {} could not be created ({e}), so nothing was executed.",
            p.working_dir
        ))
    })?;

    let script = sandbox_dir.join(format!("{}.py", new_id("script")));
    std::fs::write(&script, code.as_bytes()).map_err(|e| {
        CoreError::ExecutionFailed(format!("The script could not be written to {}: {e}", script.display()))
    })?;

    // `-I` is isolated mode: no `PYTHONPATH`, no user site-packages, and the
    // script's own directory is not put ahead of the standard library. Without
    // it a file named `random.py` in the sandbox folder silently shadows the
    // module, which is a debugging afternoon nobody needs. `-u` is unbuffered,
    // so print output streams as it happens instead of arriving at exit.
    // `-X utf8` forces UTF-8 mode on the stdio, which `PYTHONUTF8` cannot do
    // here: isolated mode ignores every `PYTHON*` environment variable, so a
    // captured script printing `✓` or `°` would otherwise die encoding to the
    // locale codepage (`cp1252` on a Western Windows install). The flag is
    // honoured under `-I` because it is an explicit command-line option.
    // Spelled out in full rather than left relative: the child's working
    // directory is the open folder now, and the script does not live there.
    let command = format!("python -I -u -X utf8 \"{}\"", script.display());
    exec(st, command, Some(script), dir).await
}

/// Strips the environment down to what a Windows program needs to start.
///
/// Shared by a real run and by the interpreter probe below, because a probe run
/// under different variables can report a module the sandbox then cannot import,
/// and a wrong answer here is worse than no answer.
pub(crate) fn inherit_minimal_env(cmd: &mut Command) {
    cmd.env_clear();
    for key in ["PATH", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "NUMBER_OF_PROCESSORS"] {
        if let Ok(v) = std::env::var(key) {
            cmd.env(key, v);
        }
    }
}

/// Python-specific child environment, applied whenever the sandbox runs a
/// command that may be an interpreter.
///
/// `PYTHONUTF8` puts stdio in UTF-8 mode instead of the locale codepage
/// (`cp1252` on a Western Windows install), so a captured script printing `✓`,
/// `°` or `mm²` does not die with `UnicodeEncodeError` before its first check
/// runs. This came up in rehearsal: the local model's dashboard test crashed
/// printing U+2713 under `cp1252`.
///
/// Environment alone is not enough for `execute_python`: its synthesized
/// command runs under `python -I` (isolated mode), which ignores every
/// `PYTHON*` variable. That path therefore also passes `-X utf8` on the
/// command line (see `run_python`). This env covers the rest — `run_command`
/// python, `python -m http.server`, anything the operator or model typed
/// without the flag. Harmless for non-Python children.
fn python_env(cmd: &mut Command) {
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUTF8", "1");
}

/* ------------------------------------------------------------------ */
/* What the interpreter has                                            */
/* ------------------------------------------------------------------ */

/// What `execute_python` can import on this machine.
pub struct PythonPackages {
    /// The interpreter version, when it could be started at all.
    pub version: Option<String>,
    /// Probed names that resolved.
    pub available: Vec<String>,
    /// Probed names that did not.
    pub missing: Vec<String>,
}

/// The third-party modules worth asking about: the ones a model reaches for when
/// it is handed a table to summarise, an image to measure or a report to
/// typeset. The standard library is not probed — it is always there, and on this
/// machine it is what most of these tasks actually need.
const PROBED_MODULES: &[&str] = &[
    "numpy", "pandas", "scipy", "matplotlib", "openpyxl", "xlrd", "PIL", "cv2", "docx", "pptx",
    "reportlab", "fitz", "yaml", "requests",
];

/// Which of `PROBED_MODULES` this machine's interpreter can import.
///
/// On a connected machine `ModuleNotFoundError: pandas` is a one-line fix. Here
/// it is a dead end: the workstation is air-gapped, pip has no index to reach,
/// and a model that has just failed on an import will either promise an install
/// it cannot perform or hand the operator a setup step they cannot carry out.
/// Both happened — a request for the mean of a column came back as "cannot
/// compute, report to operator for environment setup" while `csv` and
/// `statistics` sat in the standard library, unused.
///
/// So the interpreter is asked what it has, once, and the answer goes into the
/// system prompt. Probed rather than written down in source, because the honest
/// answer is machine-specific and this application is meant to be handed to a
/// plant workstation that was set up by somebody else. Cached because it cannot
/// change while the app runs: one interpreter start per session.
impl PythonPackages {
    /// One sentence for the `execute_python` tool description, naming what this
    /// machine can import and what it cannot.
    ///
    /// The absences are listed explicitly rather than left implicit in "standard
    /// library only", because the failure this exists to prevent is a specific
    /// reach for a specific package: a model handed a column of readings writes
    /// `import pandas as pd` unless something tells it not to, and on an
    /// air-gapped workstation that error has no recovery through installing
    /// anything.
    pub fn tool_note(&self) -> String {
        if self.version.is_none() {
            return String::new();
        }
        let mut s = String::from(
            "Nothing can be installed — this machine is offline — so write against what is here: the standard library (csv, json, statistics, math, decimal, re, zipfile, datetime) is complete.",
        );
        if !self.missing.is_empty() {
            s.push_str(&format!(" NOT installed: {}.", self.missing.join(", ")));
        }
        if !self.available.is_empty() {
            s.push_str(&format!(
                " Importable beyond the standard library: {}.",
                self.available.join(", ")
            ));
        }
        s
    }
}

/// The names `python_packages` asks about. Public so a test can require the
/// answer to cover all of them rather than however many the probe got through.
#[cfg(test)]
pub fn probed_modules() -> &'static [&'static str] {
    PROBED_MODULES
}

pub fn python_packages() -> &'static PythonPackages {
    static CACHE: std::sync::OnceLock<PythonPackages> = std::sync::OnceLock::new();
    CACHE.get_or_init(probe_python)
}

fn probe_python() -> PythonPackages {
    let mut out = PythonPackages { version: None, available: vec![], missing: vec![] };

    // No interpreter is a perfectly ordinary state — `python` is on the allow
    // list, not a dependency — and it reports as "nothing known", which reads in
    // the prompt as no claim rather than a false one.
    let Some(python) = resolve_program("python") else {
        return out;
    };

    // `find_spec` rather than `import`: probing must not run a module's
    // top-level code. `-I` matches what `run_python` uses, so user
    // site-packages are out of scope here exactly as they are there.
    let mut script = String::from(
        "import importlib.util as u, sys\nprint('V', sys.version.split()[0])\n",
    );
    for m in PROBED_MODULES {
        script.push_str(&format!(
            "try:\n    print('{m}', 1 if u.find_spec('{m}') else 0)\nexcept Exception:\n    print('{m}', 0)\n"
        ));
    }

    let mut cmd = Command::new(python);
    cmd.args(["-I", "-c", script.as_str()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    inherit_minimal_env(&mut cmd);
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }

    let Ok(o) = cmd.output() else {
        return out;
    };
    for line in String::from_utf8_lossy(&o.stdout).lines() {
        let mut it = line.split_whitespace();
        match (it.next(), it.next()) {
            (Some("V"), Some(v)) => out.version = Some(v.to_string()),
            (Some(m), Some("1")) => out.available.push(m.to_string()),
            (Some(m), Some("0")) => out.missing.push(m.to_string()),
            _ => {}
        }
    }
    out
}

/// How many 50 ms turns to give a child to be reaped. Two seconds is far longer
/// than the millisecond or two a normal exit needs, and short enough that a
/// process wedged in a driver call cannot hold a run's task open for good.
const EXIT_WAIT_TRIES: u32 = 40;

/// Waits, bounded, for a child to be reaped and returns its exit code.
///
/// `wait()` would be simpler and is not an option: it blocks the async task, and
/// a child stuck in a kernel call would never return from it. Checking on a timer
/// and yielding keeps the runtime — and every other run's output — moving.
async fn wait_for_exit(child: &mut std::process::Child, tries: u32) -> Option<i32> {
    for _ in 0..tries {
        if let Ok(Some(s)) = child.try_wait() {
            return s.code();
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    None
}

/// The single execution path. `script` is a file to delete afterwards, and `dir`
/// the working directory to give the child when it should not be the sandbox
/// root.
async fn exec(
    st: Arc<AppState>,
    command: String,
    script: Option<std::path::PathBuf>,
    dir: Option<String>,
) -> CoreResult<SandboxRun> {
    let p = policy(&st);
    // The recorded `cwd` is the one the child actually gets, so the Console and
    // the audit trail cannot disagree with where a command ran. A directory that
    // has gone missing falls back to the sandbox root rather than failing the
    // run: an approved folder can be on a drive that is no longer mounted.
    let cwd = match dir {
        Some(d) if std::path::Path::new(&d).is_dir() => d,
        _ => p.working_dir.clone(),
    };

    if let Some(reason) = refuse_reason(&command, &p) {
        // The audit record is written for a refusal exactly as for a run.
        let started = now_ms();
        st.audit(ToolName::RunCommand, command.clone(), "denied", started, "", None, None, Some(reason.clone()));
        return denied_run(&st, &command, &cwd, reason);
    }

    // The operator's own rules, checked after the built-in deny list so the
    // refusal names whichever fence actually stopped the command. Belt and
    // braces with the check in `dispatch_write`: a future caller that reaches
    // the sandbox without going through the dispatcher still cannot run past
    // an operator rule.
    if let Some(r) = crate::guards::check_command(&st, &command) {
        let reason = r.message("the command");
        let started = now_ms();
        st.audit(ToolName::RunCommand, command.clone(), "denied", started, "", None, None, Some(reason.clone()));
        return denied_run(&st, &command, &cwd, reason);
    }

    let dir = std::path::PathBuf::from(&cwd);
    std::fs::create_dir_all(&dir).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "The sandbox folder {cwd} could not be created ({e}), so nothing was executed."
        ))
    })?;

    let parts = split_args(&command);
    let Some(program) = parts.first().cloned() else {
        return denied_run(&st, &command, &cwd, "An empty command was not run.".into());
    };

    // Resolved rather than handed to `Command` as a bare word — see
    // [`resolve_program`] for why `npm` does not otherwise start. A miss here
    // means the program is allowed by policy and absent from the machine, which
    // is a different problem from a refusal and is worth saying so.
    let Some(resolved) = resolve_program(&program) else {
        let started = now_ms();
        // Two different situations, and the operator can only act on the right
        // one: a bare name that is nowhere on PATH means "install it", a spelled
        // out path that is not there means "fix the path".
        let searched = if program.contains('\\') || program.contains('/') {
            "That path does not name a file, with or without an executable suffix."
        } else {
            "Every folder on PATH was searched, with each suffix in PATHEXT."
        };
        let detail = format!(
            concat!(
                "'{}' is on the sandbox allow list but was not found on this machine. {} ",
                "Nothing ran. This is a missing program rather than a refused one."
            ),
            program, searched
        );
        st.audit(ToolName::RunCommand, command.clone(), "denied", started, "", None, None, Some(detail.clone()));
        return denied_run(&st, &command, &cwd, detail);
    };

    let run_id = new_id("sbx");
    let started_at = now_ms();

    let mut cmd = Command::new(&resolved);
    cmd.args(&parts[1..])
        .current_dir(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    // A minimal environment. Inheriting this process's variables would hand the
    // child the router's API key and whatever else is in the parent — and a
    // sandboxed script has no need for any of it. `PATH`, `SYSTEMROOT` and
    // `TEMP` are what a Windows program needs to start at all.
    inherit_minimal_env(&mut cmd);
    cmd.env("TEMP", &cwd).env("TMP", &cwd);
    python_env(&mut cmd);

    let contained = crate::winproc::spawn_contained(
        cmd,
        crate::winproc::JobLimits::sandbox(p.max_memory_mb, p.max_processes),
    )
    .map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "{} could not be started ({}).",
            crate::fsops::tidy(&resolved),
            e.message()
        ))
    })?;

    let pid = contained.pid;
    // Taken before the child is moved out: the closure captures the job handle,
    // not the `Child`, which is what lets `AppState` hold a killer without
    // holding a Windows type.
    let killer = contained.killer();
    // Held for the lifetime of the run: dropping the last reference closes the
    // job, which terminates anything the child left behind.
    let job = contained.job.clone();
    let mut child = contained.child;

    st.sandbox.lock().expect("sandbox lock").insert(
        run_id.clone(),
        SandboxHandle { run_id: run_id.clone(), pid, kill: killer },
    );

    let mut run = SandboxRun {
        id: run_id.clone(),
        command: command.clone(),
        cwd: cwd.clone(),
        status: "running".into(),
        exit_code: None,
        started_at,
        duration_ms: None,
        output: Vec::new(),
    };
    // Stored while running, so the console has a row to attach lines to and a
    // crash mid-run leaves a record rather than nothing.
    st.with_db(|conn| crate::db::insert_sandbox_run(conn, &run))?;

    /* ---- readers ---- */

    let (tx, rx) = mpsc::channel::<Chunk>();
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();

    // Two threads, because reading one pipe to exhaustion before the other
    // deadlocks the moment the unread pipe's buffer fills — which is exactly
    // what a program that writes a lot of stderr does.
    for (pipe, name) in [
        (stdout.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "stdout"),
        (stderr.map(|s| Box::new(s) as Box<dyn std::io::Read + Send>), "stderr"),
    ] {
        let Some(pipe) = pipe else { continue };
        let tx = tx.clone();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(pipe);
            let mut buf = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        // Lossy on purpose: a build tool that emits a stray
                        // non-UTF-8 byte should not cost the operator the rest
                        // of its output.
                        let text = String::from_utf8_lossy(&buf).trim_end_matches(['\r', '\n']).to_string();
                        if tx.send(Chunk { stream: name, text }).is_err() {
                            break;
                        }
                    }
                }
            }
        });
    }
    // The original sender has to go, or `rx` never sees a disconnect once both
    // reader threads have finished.
    drop(tx);

    /* ---- drain, with a deadline ---- */

    let deadline = std::time::Instant::now()
        + std::time::Duration::from_secs(p.timeout_sec.clamp(1, 3600) as u64);
    let mut truncated = false;
    let mut status = String::new();

    loop {
        // The three ways a run ends, checked in order of who asked for it:
        // the operator, the clock, then the program itself.
        if st.sandbox.lock().expect("sandbox lock").get(&run_id).is_none() {
            status = "killed".into();
            break;
        }
        if std::time::Instant::now() >= deadline {
            let handle = st.sandbox.lock().expect("sandbox lock").remove(&run_id);
            if let Some(h) = handle {
                (h.kill)();
            }
            status = "timeout".into();
            break;
        }

        match rx.recv_timeout(std::time::Duration::from_millis(120)) {
            Ok(chunk) => {
                if run.output.len() >= MAX_LINES {
                    if !truncated {
                        truncated = true;
                        let line = SandboxLine {
                            stream: "system".into(),
                            text: format!(
                                "[output truncated at {MAX_LINES} lines — the command kept running and its remaining output was not stored]"
                            ),
                            at: now_ms(),
                        };
                        st.emit("sandbox://line", line_event(&run_id, &line));
                        let _ = st.with_db(|conn| {
                            crate::db::append_sandbox_line(conn, &run_id, run.output.len() as u32, &line)
                        });
                        run.output.push(line);
                    }
                    continue;
                }
                let line = SandboxLine {
                    stream: chunk.stream.to_string(),
                    text: truncate_line(&chunk.text),
                    at: now_ms(),
                };
                st.emit("sandbox://line", line_event(&run_id, &line));
                let _ = st.with_db(|conn| {
                    crate::db::append_sandbox_line(conn, &run_id, run.output.len() as u32, &line)
                });
                run.output.push(line);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // Both pipes are quiet. If the process is also gone, the run is
                // over; if not, keep waiting. Yielding here is what keeps the
                // async runtime responsive while a long command runs.
                if matches!(child.try_wait(), Ok(Some(_))) {
                    // Give the readers a moment to flush what is still in the
                    // pipe buffers before declaring the run finished.
                    match rx.recv_timeout(std::time::Duration::from_millis(250)) {
                        Ok(chunk) => {
                            let line = SandboxLine {
                                stream: chunk.stream.to_string(),
                                text: truncate_line(&chunk.text),
                                at: now_ms(),
                            };
                            st.emit("sandbox://line", line_event(&run_id, &line));
                            let _ = st.with_db(|conn| {
                                crate::db::append_sandbox_line(conn, &run_id, run.output.len() as u32, &line)
                            });
                            run.output.push(line);
                            continue;
                        }
                        Err(_) => break,
                    }
                }
                tokio::task::yield_now().await;
            }
            // Both readers are done, which means both pipes are closed.
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    /* ---- outcome ---- */
    // A stop that lands while the pipes are closing is still a stop. `kill`
    // removes the handle and the loop above notices that once every 120 ms, but
    // both pipes reach EOF within a millisecond of the process dying — so
    // `Disconnected` breaks the loop first and the operator pressing Stop was
    // recorded as the program ending by itself. What the console then showed for
    // a stopped script was `exited 1`, which reads as "your script failed".
    if status.is_empty() && st.sandbox.lock().expect("sandbox lock").get(&run_id).is_none() {
        status = "killed".into();
    }

    // `status` is non-empty only when something ended the run deliberately: the
    // operator pressing Stop, or the deadline expiring. When it is still empty
    // the program ended itself, and the outcome has to be read off the process.
    let stop_requested = !status.is_empty();
    if stop_requested {
        if let Some(h) = st.sandbox.lock().expect("sandbox lock").remove(&run_id) {
            (h.kill)();
        }
    }

    // Both pipes reaching EOF does not mean the process object has been signalled
    // yet — on Windows the reader threads regularly see the close a few
    // milliseconds first. So the wait comes before the verdict.
    //
    // Reading "not reaped yet" as "then we must have killed it" is what recorded
    // every fast command as `killed` with exit code 0. `python --version` printed
    // its version, exited cleanly, and landed in the console and the history as
    // stopped-before-it-finished with its output marked partial. A status line
    // that contradicts the exit code next to it costs the operator their trust in
    // the whole panel, and this is an audit record: it has to say what happened.
    let mut exit_code = wait_for_exit(&mut child, EXIT_WAIT_TRIES).await;

    if exit_code.is_none() && !stop_requested {
        // Both pipes closed, no deliberate stop, and still alive two seconds
        // later: it is wedged, or it left a grandchild holding the pipes open.
        // Ending it beats holding this task open for good, and `killed` is then
        // the honest word for what happened.
        if let Some(h) = st.sandbox.lock().expect("sandbox lock").remove(&run_id) {
            (h.kill)();
        }
        status = "killed".into();
        exit_code = wait_for_exit(&mut child, EXIT_WAIT_TRIES / 2).await;
    }

    if status.is_empty() {
        status = "exited".into();
    }
    st.sandbox.lock().expect("sandbox lock").remove(&run_id);
    // Closing the job now sweeps up any grandchild that outlived the leader.
    drop(job);

    // A full path, because the script lives in the sandbox root and the child's
    // working directory may be somewhere else entirely.
    if let Some(path) = script {
        let _ = std::fs::remove_file(path);
    }

    let note = match status.as_str() {
        "timeout" => Some(format!(
            "[the command was stopped after {}s by the sandbox timeout — its output above is partial]",
            p.timeout_sec
        )),
        "killed" => Some("[the command was stopped before it finished — its output above is partial]".to_string()),
        _ => None,
    };
    if let Some(text) = note {
        let line = SandboxLine { stream: "system".into(), text, at: now_ms() };
        st.emit("sandbox://line", line_event(&run_id, &line));
        let _ = st.with_db(|conn| {
            crate::db::append_sandbox_line(conn, &run_id, run.output.len() as u32, &line)
        });
        run.output.push(line);
    }

    run.status = status;
    run.exit_code = exit_code;
    run.duration_ms = Some((now_ms() - started_at).max(0) as u64);
    st.with_db(|conn| crate::db::finish_sandbox_run(conn, &run))?;

    // Audit records have a deliberately smaller status vocabulary than process
    // runs. Keeping process states here used to crash the Logs UI when it met an
    // `exited` row from an earlier run.
    let audit_status = match (run.status.as_str(), exit_code) {
        ("exited", Some(0)) => "ok",
        ("denied", _) => "denied",
        _ => "failed",
    };
    st.audit(
        ToolName::RunCommand,
        command,
        audit_status,
        started_at,
        "",
        None,
        None,
        match (run.status.as_str(), exit_code) {
            ("exited", Some(0)) => None,
            ("exited", Some(c)) => Some(format!("Exited with code {c}.")),
            (s, _) => Some(format!("The command {s}.")),
        },
    );

    Ok(run)
}

/* ------------------------------------------------------------------ */
/* Control and history                                                 */
/* ------------------------------------------------------------------ */

pub fn kill(st: &AppState, run_id: &str) -> CoreResult<()> {
    // Removing the handle is itself the stop signal: the drain loop checks for
    // its own presence in the map each pass, so a kill takes effect at the next
    // boundary even if the terminate call loses a race with process exit.
    let handle = st.sandbox.lock().expect("sandbox lock").remove(run_id);
    match handle {
        Some(h) => {
            (h.kill)();
            // Terminate is asynchronous: the call returns before the kernel has
            // torn the process down. A short wait, then the process table is
            // asked whether it is actually gone — because a Stop button that
            // reports success either way is how an operator ends up believing a
            // script stopped while it is still writing to the sandbox folder.
            for _ in 0..20 {
                if !crate::winproc::pid_alive(h.pid) {
                    return Ok(());
                }
                std::thread::sleep(std::time::Duration::from_millis(25));
            }
            // The handle is already out of the map, so the drain loop will stop
            // reading from it regardless; the job object still kills the tree when
            // the app exits. What is not true is that the process has stopped, and
            // that is what the operator is told.
            Err(CoreError::ExecutionFailed(format!(
                "{run_id} was told to stop and process {} is still running after half a second. It has been detached from this application and its job object will end it when the app exits; if it is holding a file open, end it from Task Manager.",
                h.pid
            )))
        }
        None => Err(CoreError::ExecutionFailed(format!(
            "No sandbox run '{run_id}' is active, so nothing was stopped. It had already finished."
        ))),
    }
}

pub fn history(st: &AppState) -> CoreResult<Vec<SandboxRun>> {
    st.with_db(crate::db::sandbox_runs)
}

/// Stops every live run. Called on window close, so a background `pip install`
/// does not keep going after the app is gone. The job objects would kill the
/// tree on process exit anyway; this makes it orderly and immediate.
pub fn kill_all(st: &Arc<AppState>) {
    let handles: Vec<SandboxHandle> = {
        let mut map = st.sandbox.lock().expect("sandbox lock");
        map.drain().map(|(_, h)| h).collect()
    };
    for h in handles {
        (h.kill)();
        // The drain loop that normally writes a run's outcome is on a task that
        // will not get another turn — the process is on its way out. Without this
        // the row stays `running` for good, and the next launch shows a command
        // that looks like it is still executing, with a Stop button that can
        // never succeed against a pid from a dead process. Holding `run_id` on
        // the handle is what makes the row addressable here, where the
        // `SandboxRun` itself is owned by a thread that is being abandoned.
        if let Err(e) = st.with_db(|conn| crate::db::mark_sandbox_stopped(conn, &h.run_id, "killed")) {
            eprintln!("[sandbox] {} was stopped at shutdown but its history row could not be updated: {e}", h.run_id);
        }
    }
}

/// The whole output of a finished run as one string, for a tool result.
pub fn transcript(run: &SandboxRun) -> String {
    let mut s = String::new();
    for line in &run.output {
        if line.stream == "stderr" {
            s.push_str("[stderr] ");
        }
        s.push_str(&line.text);
        if !line.text.ends_with('\n') {
            s.push('\n');
        }
    }
    s
}

#[cfg(test)]
mod resolution {
    use crate::registry::default_sandbox_policy;

    /// Names the command interpreter implements itself. None of them is a file
    /// anywhere on disk, so none can be spawned, so none can be honestly
    /// advertised by a sandbox that has no interpreter to reach them through.
    /// `type` and `dir` were both on the default list; this is what would have
    /// caught them.
    const BUILTINS: &[&str] = &[
        "assoc", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo",
        "endlocal", "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "move", "path",
        "pause", "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir", "set",
        "setlocal", "shift", "start", "time", "title", "type", "ver", "verify", "vol",
    ];

    #[test]
    fn no_default_allow_list_entry_is_an_interpreter_builtin() {
        let p = default_sandbox_policy();
        let bad: Vec<&String> = p
            .allowed_commands
            .iter()
            .filter(|c| BUILTINS.contains(&c.to_ascii_lowercase().as_str()))
            .collect();
        assert!(
            bad.is_empty(),
            "these cannot be started as processes and must not be advertised: {bad:?}"
        );
    }

    /// The deny list is checked before the allow list, so an entry on both is an
    /// entry that is advertised and then always refused. Cheaper to catch here
    /// than in a support call.
    #[test]
    fn nothing_is_both_allowed_and_denied() {
        let p = default_sandbox_policy();
        for a in &p.allowed_commands {
            assert!(
                super::refuse_reason(a, &p).is_none(),
                "'{a}' is on the allow list but its own policy refuses it: {:?}",
                super::refuse_reason(a, &p)
            );
        }
    }

    /// The classic drive-wipers, in both shells this sandbox can reach: Unix
    /// `rm` (as a word, so `rm -rf /` and `rm -rf C:/` both hit) and the
    /// PowerShell spelling `Remove-Item` (a phrase, caught even with
    /// `-Recurse -Force` arguments around it). If one of these stops being
    /// refused, the deny list has regressed, not the test.
    #[test]
    fn recursive_delete_commands_are_refused() {
        let p = default_sandbox_policy();
        for command in ["rm -rf /", "rm -rf C:/Users", "rm C:/sovereign", "Remove-Item -Recurse -Force C:/"] {
            assert!(
                super::refuse_reason(command, &p).is_some(),
                "'{command}' must be refused by the deny list"
            );
        }
        // And the word match must not refuse harmless text that merely
        // contains the letters, the way "rd" would if it were a substring.
        assert!(super::refuse_reason("python transform.py", &p).is_none());
    }

    /// `tree` is the one that matters: it exists only as `tree.com`, so a lookup
    /// that appends `.exe` and stops — which is what Windows process creation
    /// does on its own — cannot find it. If this passes, the `PATHEXT` sweep is
    /// working; `findstr` and `where` would pass without it.
    #[test]
    fn windows_own_programs_resolve() {
        for name in ["findstr", "where", "tree"] {
            let hit = super::resolve_program(name);
            assert!(hit.is_some(), "{name} did not resolve on a Windows machine");
            assert!(hit.unwrap().is_file());
        }
    }

    #[test]
    fn a_name_that_already_has_its_extension_is_not_given_a_second_one() {
        let hit = super::resolve_program("findstr.exe").expect("findstr.exe resolves");
        let s = hit.to_string_lossy().to_ascii_lowercase();
        assert!(s.ends_with("findstr.exe"), "{s}");
    }

    /// npm is the case that made this necessary: `npm.cmd` and an extensionless
    /// `npm` shell script sit side by side, and picking the bare file gets "%1 is
    /// not a valid Win32 application" from Windows. The suffix list has to be
    /// consulted before the bare name, not after.
    #[test]
    fn a_sibling_with_an_extension_beats_the_bare_file() {
        let dir = std::env::temp_dir().join(format!("sovereign-resolve-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(dir.join("probe"), b"#!/bin/sh\n").expect("bare");
        std::fs::write(dir.join("probe.cmd"), b"@echo off\n").expect("cmd");

        let hit = super::with_extension(&dir.join("probe")).expect("probe resolves");
        assert!(
            hit.to_string_lossy().to_ascii_lowercase().ends_with("probe.cmd"),
            "resolved to {hit:?}, which Windows cannot start"
        );

        // With no suffixed sibling, the bare file is still better than nothing —
        // process creation can run an extensionless executable even though the
        // interpreter would not have looked for one.
        std::fs::remove_file(dir.join("probe.cmd")).expect("cleanup");
        let bare = super::with_extension(&dir.join("probe")).expect("bare probe resolves");
        assert!(bare.to_string_lossy().ends_with("probe"), "{bare:?}");
    }

    /// If this machine has an interpreter at all, the probe has to come back
    /// with its version. A probe that quietly returns nothing takes the
    /// `execute_python` guidance with it, and that failure surfaces only as a
    /// model reaching for pandas again — which is exactly the thing it was
    /// added to stop.
    #[test]
    fn the_probe_speaks_when_there_is_an_interpreter() {
        if super::resolve_program("python").is_none() {
            return;
        }
        let pkgs = super::python_packages();
        assert!(pkgs.version.is_some(), "python resolves but the probe reported no version");
        let note = pkgs.tool_note();
        assert!(note.contains("offline"), "{note}");
        assert!(
            !pkgs.available.is_empty() || !pkgs.missing.is_empty(),
            "the probe answered about nothing at all"
        );
    }

    /// The sandbox captures stdout through a pipe, and Python then writes in
    /// the locale codepage (`cp1252` on a Western Windows install) unless UTF-8
    /// mode is forced. A generated dashboard test prints `✓` for a passing
    /// assertion and crashed with `UnicodeEncodeError` before its first check
    /// ran; engineering scripts printing `°` or `mm²` would hit the same wall.
    /// The command mirrors `run_python` (`-I -u -X utf8`): `-X utf8` is what
    /// survives isolated mode, which ignores a `PYTHONUTF8` environment
    /// variable. The child environment must make such output survive capture.
    #[test]
    fn sandboxed_python_prints_non_ascii_to_a_captured_pipe() {
        use std::io::Read;
        use std::process::{Command, Stdio};
        let Some(python) = super::resolve_program("python") else {
            return; // no interpreter on this machine: nothing to sandbox
        };
        let mut cmd = Command::new(python);
        cmd.args(["-I", "-u", "-X", "utf8", "-c", "print('\u{2713} pass')"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        super::inherit_minimal_env(&mut cmd);
        super::python_env(&mut cmd);
        let mut child = cmd.spawn().expect("python should start");
        let mut out = String::new();
        let mut err = String::new();
        child.stdout.take().expect("stdout").read_to_string(&mut out).expect("read stdout");
        child.stderr.take().expect("stderr").read_to_string(&mut err).expect("read stderr");
        let status = child.wait().expect("wait for python");
        assert!(
            status.success(),
            "printing a check mark must not die on encoding. stderr: {err}"
        );
        assert!(out.contains('\u{2713}'), "output was {out:?}");
    }

    #[test]
    fn the_extension_list_is_never_empty() {
        let exts = super::path_extensions();
        assert!(!exts.is_empty());
        assert!(exts.iter().all(|e| e.starts_with('.')), "{exts:?}");
    }

    #[test]
    fn a_program_that_is_not_installed_does_not_resolve() {
        assert!(super::resolve_program("sovereign-no-such-program-9f3a").is_none());
        assert!(super::resolve_program("").is_none());
    }

    /// The gap this closes: the chaining check used to look for an ampersand
    /// with spaces around it, and an ampersand without them chains just as well
    /// once a batch-file entry puts an interpreter in the path.
    #[test]
    fn an_ampersand_without_spaces_is_refused() {
        let p = default_sandbox_policy();
        let reason = super::refuse_reason("npm run build&whoami", &p)
            .expect("an unspaced ampersand must be refused");
        assert!(reason.contains('&'), "{reason}");
        // And the ordinary form still runs.
        assert!(super::refuse_reason("npm run build", &p).is_none());
    }
}

#[cfg(test)]
mod stop_reporting {
    /// Stopping a run has to be recorded as a stop.
    ///
    /// The drain loop learns about a stop by noticing its own handle has left the
    /// map, and it looks once every 120 ms — but the child's pipes reach EOF within
    /// a millisecond of the kill, so the loop almost always exits through
    /// `Disconnected` first. Without a second look after the loop, Stop recorded
    /// `exited 1`: an audit row saying the script failed on its own.
    #[test]
    fn the_outcome_block_looks_again_for_a_stop() {
        let src = include_str!("sandbox.rs");
        let (_, after) = src.split_once("---- outcome ----").expect("the outcome block exists");
        let (block, _) = after.split_once("let stop_requested").expect("stop_requested follows");
        assert!(
            block.contains("is_none()") && block.contains("killed"),
            "a stop that lands as the pipes close will be recorded as a clean exit:\n{block}"
        );
    }
}

//! Process containment. One helper, used by both the router and the sandbox.
//!
//! Every child this application starts is created suspended, assigned to a
//! Windows job object, and only then resumed. The order matters: assigning a
//! process that is already running leaves a window in which it can spawn a
//! grandchild that escapes the job, and a containment boundary with a race in it
//! is not a boundary. Resuming needs the child's threads, which `std::process`
//! does not expose, so they are found through a ToolHelp snapshot.
//!
//! What the job actually enforces:
//!   * `KILL_ON_JOB_CLOSE` — when the handle closes, for any reason including
//!     this process being killed, the whole tree dies. Nothing outlives the app.
//!   * `JOB_MEMORY` — a committed-memory ceiling for the tree, so a runaway
//!     script cannot take the workstation down with it.
//!   * `ACTIVE_PROCESS` — a cap on how many processes the tree may contain, so
//!     a fork bomb fails instead of spreading.
//!   * UI restrictions — no clipboard read or write, no desktop switching, no
//!     global atoms, no system-parameter changes. A sandboxed script has no
//!     business reaching the interactive desktop.
//!
//! What it does not do, stated plainly: a job object is not a security boundary
//! against a determined attacker with code execution. It bounds resources and
//! lifetime, and it is what Windows 11 Home can enforce without Hyper-V or
//! Windows Sandbox, neither of which exists on this SKU. Network isolation is
//! handled separately, by not giving the child any reachable endpoint and by the
//! command deny list — not by the job.

use std::os::windows::io::AsRawHandle;
use std::os::windows::process::CommandExt;
use std::process::{Child, Command};
use std::sync::Arc;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectBasicUIRestrictions, JobObjectExtendedLimitInformation,
    JOBOBJECT_BASIC_LIMIT_INFORMATION, JOBOBJECT_BASIC_UI_RESTRICTIONS,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
    JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION, JOB_OBJECT_LIMIT_JOB_MEMORY,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_UILIMIT_DESKTOP,
    JOB_OBJECT_UILIMIT_DISPLAYSETTINGS, JOB_OBJECT_UILIMIT_EXITWINDOWS,
    JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_READCLIPBOARD,
    JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
};
use windows::Win32::System::Threading::{
    OpenThread, ResumeThread, TerminateProcess, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW,
    CREATE_SUSPENDED, THREAD_SUSPEND_RESUME,
};

use crate::error::{CoreError, CoreResult};

#[derive(Debug, Clone, Copy)]
pub struct JobLimits {
    pub max_memory_mb: u32,
    pub max_processes: u32,
    /// UI restrictions are right for a sandboxed script and wrong for the
    /// inference router, which needs to talk to the GPU driver.
    pub restrict_ui: bool,
}

impl JobLimits {
    /// The router: bounded and killed with the app, but otherwise unrestricted.
    /// It has to reach the display driver to use CUDA at all.
    pub fn router() -> Self {
        Self { max_memory_mb: 24_576, max_processes: 8, restrict_ui: false }
    }

    pub fn sandbox(max_memory_mb: u32, max_processes: u32) -> Self {
        Self { max_memory_mb, max_processes, restrict_ui: true }
    }

    /// A persistent dev server (vite/next/webpack under node). Killed with the
    /// app like the router, but with headroom for the child processes a dev
    /// server legitimately spawns — esbuild workers, thread pools, HMR sockets.
    /// No UI restriction: some dev servers open a browser window themselves.
    pub fn dev_server() -> Self {
        Self { max_memory_mb: 16_384, max_processes: 16, restrict_ui: false }
    }
}

/// Owns the job handle. Dropping it kills everything inside the job, because
/// `KILL_ON_JOB_CLOSE` is set — that is the whole point of holding it.
pub struct Job {
    handle: HANDLE,
}

// The handle is only ever used with thread-safe Win32 calls.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    fn create(limits: JobLimits) -> CoreResult<Self> {
        // SAFETY: a null name creates an unnamed job; the handle is checked.
        let handle = unsafe { CreateJobObjectW(None, None) }
            .map_err(|e| CoreError::ExecutionFailed(format!("Could not create a job object: {e}")))?;

        let mut ext = JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
            BasicLimitInformation: JOBOBJECT_BASIC_LIMIT_INFORMATION {
                LimitFlags: JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                    | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                    | JOB_OBJECT_LIMIT_JOB_MEMORY
                    | JOB_OBJECT_LIMIT_ACTIVE_PROCESS,
                ActiveProcessLimit: limits.max_processes.max(1),
                ..Default::default()
            },
            JobMemoryLimit: (limits.max_memory_mb as usize).saturating_mul(1024 * 1024),
            ..Default::default()
        };

        // SAFETY: `ext` outlives the call and the size matches the struct.
        unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &mut ext as *mut _ as *const _,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        }
        .map_err(|e| {
            let _ = unsafe { CloseHandle(handle) };
            CoreError::ExecutionFailed(format!("Could not apply job limits: {e}"))
        })?;

        if limits.restrict_ui {
            let mut ui = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: JOB_OBJECT_UILIMIT_DESKTOP
                    | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS
                    | JOB_OBJECT_UILIMIT_EXITWINDOWS
                    | JOB_OBJECT_UILIMIT_GLOBALATOMS
                    | JOB_OBJECT_UILIMIT_READCLIPBOARD
                    | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS
                    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
            };
            // A failure here is not fatal — the resource limits above are the
            // ones that matter — but it must not pass silently.
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectBasicUIRestrictions,
                    &mut ui as *mut _ as *const _,
                    std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                )
            };
            if let Err(e) = ok {
                eprintln!("[winproc] UI restrictions were not applied: {e}");
            }
        }

        Ok(Self { handle })
    }

    fn assign(&self, child: &Child) -> CoreResult<()> {
        let process = HANDLE(child.as_raw_handle() as _);
        // SAFETY: both handles are live for the duration of the call.
        unsafe { AssignProcessToJobObject(self.handle, process) }.map_err(|e| {
            CoreError::ExecutionFailed(format!(
                "Could not place the child process in its job object, so it was not started: {e}"
            ))
        })
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Closing the last handle terminates the job's processes, because
        // KILL_ON_JOB_CLOSE is set. No explicit TerminateJobObject needed.
        let _ = unsafe { CloseHandle(self.handle) };
    }
}

/// A contained child: the process, and the job that bounds it.
pub struct Contained {
    pub child: Child,
    pub pid: u32,
    /// Held by the caller. Dropping the last reference ends the tree, because the
    /// job is created with `KILL_ON_JOB_CLOSE`.
    pub job: Arc<Job>,
}

impl Contained {
    /// A closure that kills the tree and can be stored without the `Child`.
    /// This is what `AppState` holds, so `state.rs` needs no Windows types.
    pub fn killer(&self) -> Arc<dyn Fn() + Send + Sync> {
        let job = self.job.clone();
        let pid = self.pid;
        Arc::new(move || {
            // Keeping the job alive in the closure means dropping the last
            // reference is what actually terminates the tree.
            let _ = &job;
            terminate_pid(pid);
        })
    }
}

/// Whether a process with this id is still running.
///
/// Asked after a terminate so "Stop" can report what actually happened. A stop
/// button that returns success whether or not the process died is the class of
/// control that trains an operator to distrust the whole panel — and a `pip
/// install` that survives its own Stop keeps writing to the sandbox folder.
///
/// A pid that cannot be opened is treated as gone: the only reasons `OpenProcess`
/// fails for a child this process launched are that it exited or that its id was
/// reused, and reporting "still running" for an exited process would be the
/// wrong way round.
pub fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::STILL_ACTIVE;
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // SAFETY: the handle is closed on every path out.
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let mut code: u32 = 0;
                let alive = GetExitCodeProcess(h, &mut code).is_ok() && code == STILL_ACTIVE.0 as u32;
                let _ = CloseHandle(h);
                alive
            }
            Err(_) => false,
        }
    }
}

fn terminate_pid(pid: u32) {
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE};
    // SAFETY: the handle is closed on both paths.
    unsafe {
        if let Ok(h) = OpenProcess(PROCESS_TERMINATE, false, pid) {
            let _ = TerminateProcess(h, 1);
            let _ = CloseHandle(h);
        }
    }
}

/// Spawns `cmd` suspended, contains it, then resumes it.
///
/// `CREATE_NO_WINDOW` keeps console children from flashing a window over the
/// app; `CREATE_NEW_PROCESS_GROUP` means a Ctrl-C in a parent console does not
/// travel into the child.
pub fn spawn_contained(mut cmd: Command, limits: JobLimits) -> CoreResult<Contained> {
    let job = Job::create(limits)?;

    cmd.creation_flags(
        (CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP).0,
    );

    let child = cmd.spawn().map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not start the process: {e}"))
    })?;
    let pid = child.id();

    // Contain before it runs a single instruction.
    if let Err(e) = job.assign(&child) {
        terminate_pid(pid);
        return Err(e);
    }

    if let Err(e) = resume_process(pid) {
        terminate_pid(pid);
        return Err(e);
    }

    Ok(Contained { child, pid, job: Arc::new(job) })
}

/// Resumes every thread belonging to `pid`. A freshly created suspended process
/// has exactly one, but resuming all of them is correct either way.
fn resume_process(pid: u32) -> CoreResult<()> {
    // SAFETY: the snapshot handle is closed before returning on every path.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0).map_err(|e| {
            CoreError::ExecutionFailed(format!("Could not enumerate threads to resume the child: {e}"))
        })?;

        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };

        let mut resumed = 0usize;
        if Thread32First(snapshot, &mut entry).is_ok() {
            loop {
                if entry.th32OwnerProcessID == pid {
                    if let Ok(thread) = OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID)
                    {
                        if ResumeThread(thread) != u32::MAX {
                            resumed += 1;
                        }
                        let _ = CloseHandle(thread);
                    }
                }
                entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
                if Thread32Next(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);

        if resumed == 0 {
            return Err(CoreError::ExecutionFailed(
                "The child process was created but could not be resumed; it was terminated rather than left suspended.".into(),
            ));
        }
    }
    Ok(())
}

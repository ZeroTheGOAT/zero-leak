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
/// Returning an absolute path has a second effect worth having: what the audit
/// record and the console report is the file that ran, not the word the model
/// typed. Two `python`s on `PATH` stop being an unanswerable question.
fn resolve_program(name: &str) -> Option<std::path::PathBuf> {
    let raw = name.trim().trim_matches('"');
    if raw.is_empty() {
        return None;
    }

    // Anything with a separator is already a path, not a name to look up — but
    // it still gets the extension sweep, so `.\build` finds `.\build.cmd`.
    if raw.contains('\') || raw.contains('/') {
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

/// The first of `base`, `base.exe`, `base.cmd`, … that exists as a file.
///
/// The bare name is tried first so a command written with its extension already
/// on it is not turned into `python.exe.exe`. `PATHEXT` supplies the rest, with
/// a fallback list for the case where the variable is missing from the minimal
/// environment the sandbox builds.
fn with_extension(base: &std::path::Path) -> Option<std::path::PathBuf> {
    if base.is_file() {
        return Some(base.to_path_buf());
    }
    let pathext =
        std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_string());
    for ext in pathext.split(';') {
        let ext = ext.trim();
        if ext.is_empty() {
            continue;
        }
        // `Path::with_extension` would eat a dot already in the stem —
        // `node-v1.2` becomes `node-v1.exe` — so the suffix is appended to the
        // whole name instead of replacing anything.
        let mut name = base.as_os_str().to_os_string();
        name.push(ext);
        let candidate = std::path::PathBuf::from(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}


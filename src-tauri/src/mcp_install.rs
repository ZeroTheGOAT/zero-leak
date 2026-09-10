//! Operator-triggered npm setup. Never invoked by an agent or at MCP launch.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use crate::error::{CoreError, CoreResult};
use crate::state::AppState;
use crate::types::{McpServerConfig, ToolName};

fn package_name(spec: &str) -> CoreResult<&str> {
    let (name, version) = match spec.rfind('@').filter(|index| *index > 0) {
        Some(index) => (&spec[..index], Some(&spec[index + 1..])),
        None => (spec, None),
    };
    let part = |s: &str| !s.is_empty() && !s.starts_with(['.', '-'])
        && s.bytes().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || b"._-".contains(&c));
    let valid = if let Some(scoped) = name.strip_prefix('@') {
        scoped.split_once('/').is_some_and(|(scope, name)| part(scope) && part(name))
    } else { part(name) };
    if !valid || spec.len() > 250 || version.is_some_and(|v| v.is_empty()
        || !v.bytes().all(|c| c.is_ascii_alphanumeric() || b"._+-".contains(&c))) {
        return Err(CoreError::InvalidDocument("Enter an npm package name, optionally followed by @version. URLs, local paths and command flags are not package names.".into()));
    }
    Ok(name)
}

fn npm_cli(node: &Path) -> CoreResult<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(parent) = node.parent() {
        candidates.push(parent.join("node_modules/npm/bin/npm-cli.js"));
        candidates.push(parent.join("../lib/node_modules/npm/bin/npm-cli.js"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        candidates.push(PathBuf::from(appdata).join("npm/node_modules/npm/bin/npm-cli.js"));
    }
    candidates.into_iter().find(|path| path.is_file()).ok_or_else(||
        CoreError::ExecutionFailed("npm-cli.js was not found beside Node. Install Node.js with npm, restart ZeroLeak, and retry.".into()))
}

async fn install_into(node: &Path, cli: &Path, dir: &Path, spec: &str, name: &str) -> CoreResult<PathBuf> {
    std::fs::write(dir.join("package.json"), serde_json::to_vec_pretty(&json!({
        "name": "zeroleak-mcp-install", "version": "1.0.0", "private": true
    }))?)?;
    let job = crate::winproc::Job::create(crate::winproc::JobLimits::sandbox(1024, 8))?;
    let mut child = tokio::process::Command::new(node)
        .arg(cli).arg("install").arg("--prefix").arg(dir)
        .args(["--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--loglevel=error", "--registry=https://registry.npmjs.org", "--"])
        .arg(spec).current_dir(dir)
        .stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::piped()).kill_on_drop(true).spawn()
        .map_err(|e| CoreError::ExecutionFailed(format!("npm could not start: {e}")))?;
    if let Some(handle) = child.raw_handle() {
        if !handle.is_null() { job.assign_raw(handle as isize).map_err(|e| { let _ = child.start_kill(); e })?; }
    }
    let output = tokio::time::timeout(Duration::from_secs(180), child.wait_with_output()).await
        .map_err(|_| CoreError::Timeout("npm installation exceeded three minutes. Check connectivity and retry.".into()))??;
    if !output.status.success() {
        let detail: String = String::from_utf8_lossy(&output.stderr).chars().take(3000).collect();
        return Err(CoreError::ExecutionFailed(format!("npm installation failed: {detail}")));
    }
    let package = dir.join("node_modules").join(name);
    let manifest: Value = serde_json::from_str(&std::fs::read_to_string(package.join("package.json"))?)?;
    let bin = match &manifest["bin"] {
        Value::String(bin) => Some(bin.as_str()),
        Value::Object(bins) if bins.len() == 1 => bins.values().next().and_then(Value::as_str),
        _ => None,
    }.ok_or_else(|| CoreError::InvalidDocument("This package does not expose exactly one executable. Install it manually and connect its server entry file using Existing local server.".into()))?;
    let entry = package.join(bin).canonicalize()?;
    if !entry.is_file() || !entry.starts_with(dir.canonicalize()?) {
        return Err(CoreError::InvalidDocument("The package executable must be a file inside the installation folder.".into()));
    }
    Ok(entry)
}

pub async fn install(st: &Arc<AppState>, spec: &str, node_path: Option<String>) -> CoreResult<McpServerConfig> {
    if st.settings().block_public_internet {
        return Err(CoreError::Denied("Package downloads are blocked by System → Block public egress. Connect an existing local server or enable egress for installation.".into()));
    }
    let name = package_name(spec)?;
    let node = crate::mcp::resolve_executable(node_path.as_deref().filter(|s| !s.trim().is_empty()).unwrap_or("node"))?;
    let cli = npm_cli(&node)?;
    let id = format!("mcp-{}", uuid::Uuid::new_v4());
    let dir = crate::registry::config_dir().join("mcp").join(&id);
    std::fs::create_dir_all(&dir)?;
    let started = Instant::now();
    let installed = install_into(&node, &cli, &dir, spec, name).await;
    st.audit(ToolName::RunCommand, format!("operator npm MCP installation: {spec}"),
        if installed.is_ok() { "ok" } else { "failed" }, started, "", None, None, None);
    match installed {
        Ok(entry) => Ok(McpServerConfig { id, name: name.to_string(),
            command: node.to_string_lossy().into_owned(), args: vec![entry.to_string_lossy().into_owned()],
            env: Default::default(), cwd: Some(dir.to_string_lossy().into_owned()), enabled: true }),
        Err(error) => { let _ = std::fs::remove_dir_all(&dir); Err(error) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_registry_packages_and_rejects_paths_and_flags() {
        assert_eq!(package_name("@modelcontextprotocol/server-filesystem@1.2.3").unwrap(), "@modelcontextprotocol/server-filesystem");
        assert_eq!(package_name("my-server@latest").unwrap(), "my-server");
        for bad in ["", "--ignore-scripts=false", "https://example.com/pkg", "../pkg", "@scope/../pkg", "pkg --flag", "pkg@", "pkg;calc"] {
            assert!(package_name(bad).is_err(), "{bad}");
        }
    }
}

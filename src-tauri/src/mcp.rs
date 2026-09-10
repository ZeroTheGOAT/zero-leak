//! Minimal local-stdio MCP client.
//!
//! Servers use installed executables from Settings. No shell is involved in
//! MCP sessions, and every agent invocation passes through the
//! normal execute-risk approval gate before this module is reached.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};

use crate::error::{CoreError, CoreResult};
use crate::types::{AppSettings, McpServerConfig, McpToolSummary};

const MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MESSAGE: usize = 8 * 1024 * 1024;

struct Connection {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    stdout: BufReader<tokio::process::ChildStdout>,
    _job: Arc<crate::winproc::Job>,
    next_id: u64,
}

struct Slot {
    config: McpServerConfig,
    retired: bool,
    connection: Option<Connection>,
}

type Pool = HashMap<String, Arc<tokio::sync::Mutex<Slot>>>;
static CONNECTIONS: OnceLock<tokio::sync::Mutex<Pool>> = OnceLock::new();

fn connections() -> &'static tokio::sync::Mutex<Pool> {
    CONNECTIONS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

pub(crate) fn resolve_executable(raw: &str) -> CoreResult<PathBuf> {
    let raw = raw.trim().trim_matches('"');
    if raw.is_empty() || raw.contains(['\n', '\r', '\0']) {
        return Err(CoreError::InvalidDocument("Choose an MCP executable.".into()));
    }
    // Windows .cmd/.bat launch through a shell. Use the actual interpreter so
    // arguments containing spaces and metacharacters remain separate arguments.
    let lower = raw.to_ascii_lowercase();
    if lower.ends_with(".cmd") || lower.ends_with(".bat") || raw.eq_ignore_ascii_case("npx") || raw.eq_ignore_ascii_case("npm") {
        return Err(CoreError::InvalidDocument("Use Install npm package for npx/npm servers, or select node.exe plus the installed server script. Shell wrappers (.cmd/.bat) cannot be used as MCP executables.".into()));
    }
    let path = Path::new(raw);
    if path.is_absolute() && path.is_file() { return Ok(path.to_path_buf()); }
    if !raw.contains(['/', '\\']) {
        if let Some(paths) = std::env::var_os("PATH") {
            for dir in std::env::split_paths(&paths).filter(|dir| dir.is_absolute()) {
                for name in [raw.to_string(), format!("{raw}.exe")] {
                    let candidate = dir.join(name);
                    if candidate.is_file() { return Ok(candidate); }
                }
            }
        }
    }
    Err(CoreError::InvalidDocument(format!("Executable '{raw}' was not found. Browse to its full path, or install it and restart ZeroLeak so PATH is refreshed.")))
}

pub(crate) fn validate_config(config: &McpServerConfig) -> CoreResult<()> {
    if config.id.trim().is_empty() || config.name.trim().is_empty() {
        return Err(CoreError::InvalidDocument("Each MCP server needs an id and display name.".into()));
    }
    resolve_executable(&config.command)?;
    if let Some(cwd) = config.cwd.as_deref().filter(|v| !v.is_empty()) {
        if !Path::new(cwd).is_absolute() || !Path::new(cwd).is_dir() {
            return Err(CoreError::InvalidDocument(format!("MCP working directory '{cwd}' must be an existing absolute folder.")));
        }
    }
    for (key, value) in &config.env {
        let valid = !key.is_empty() && key.bytes().enumerate().all(|(i, c)| c.is_ascii_alphabetic() || c == b'_' || (i > 0 && c.is_ascii_digit()));
        if !valid || value.contains('\0') {
            return Err(CoreError::InvalidDocument("MCP environment needs valid variable names and values without NUL bytes.".into()));
        }
    }
    if config.args.iter().any(|arg| arg.contains('\0')) {
        return Err(CoreError::InvalidDocument("MCP arguments cannot contain NUL bytes.".into()));
    }
    Ok(())
}

fn server<'a>(settings: &'a AppSettings, id: &str) -> CoreResult<&'a McpServerConfig> {
    let server = settings.mcp_servers.iter().find(|server| server.id == id && server.enabled)
        .ok_or_else(|| CoreError::Denied(format!("No enabled MCP server named '{id}' is configured.")))?;
    validate_config(server)?;
    Ok(server)
}

async fn send<W: AsyncWrite + Unpin>(stdin: &mut W, message: &Value) -> CoreResult<()> {
    // MCP stdio uses one compact JSON message per line, not LSP headers.
    let mut body = serde_json::to_vec(message)?;
    if body.len() > MAX_MESSAGE { return Err(CoreError::ExecutionFailed("MCP request exceeds 8 MiB.".into())); }
    body.push(b'\n');
    stdin.write_all(&body).await?;
    stdin.flush().await?;
    Ok(())
}

async fn bounded_line<R: AsyncBufRead + Unpin>(reader: &mut R) -> CoreResult<String> {
    let mut bytes = Vec::new();
    loop {
        let buf = reader.fill_buf().await?;
        if buf.is_empty() { break; }
        let count = buf.iter().position(|b| *b == b'\n').map_or(buf.len(), |i| i + 1);
        if bytes.len() + count > MAX_MESSAGE { return Err(CoreError::ExecutionFailed("MCP response exceeds 8 MiB.".into())); }
        let done = buf[count - 1] == b'\n';
        bytes.extend_from_slice(&buf[..count]);
        reader.consume(count);
        if done { break; }
    }
    String::from_utf8(bytes).map_err(|_| CoreError::ExecutionFailed("MCP output is not valid UTF-8.".into()))
}

async fn receive<R: AsyncBufRead + Unpin>(reader: &mut R) -> CoreResult<Value> {
    let first = bounded_line(reader).await?;
    if first.is_empty() {
        return Err(CoreError::ExecutionFailed(
            "The MCP server closed its output before answering.".into(),
        ));
    }
    let trimmed = first.trim();
    // Standard MCP stdio. Also accept legacy framed responses for older local tools.
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed).map_err(Into::into);
    }

    let mut length = trimmed
        .strip_prefix("Content-Length:")
        .and_then(|value| value.trim().parse::<usize>().ok());
    let mut header_bytes = first.len();
    loop {
        let line = bounded_line(reader).await?;
        header_bytes += line.len();
        if header_bytes > 16384 { return Err(CoreError::ExecutionFailed("MCP headers exceed 16 KiB.".into())); }
        if line == "\r\n" || line == "\n" || line.is_empty() {
            break;
        }
        if length.is_none() {
            length = line
                .trim()
                .strip_prefix("Content-Length:")
                .and_then(|value| value.trim().parse::<usize>().ok());
        }
    }
    let length = length.ok_or_else(|| {
        CoreError::ExecutionFailed("The MCP server returned a response without Content-Length.".into())
    })?;
    if length > MAX_MESSAGE {
        return Err(CoreError::ExecutionFailed(format!(
            "The MCP server returned {length} bytes, above the 8 MiB response limit."
        )));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    Ok(serde_json::from_slice(&body)?)
}

async fn request<W: AsyncWrite + Unpin, R: AsyncBufRead + Unpin>(
    stdin: &mut W,
    stdout: &mut R,
    id: u64,
    method: &str,
    params: Value,
) -> CoreResult<Value> {
    send(
        stdin,
        &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
    )
    .await?;
    loop {
        let response = receive(stdout).await?;
        if let Some(method) = response.get("method").and_then(Value::as_str) {
            if let Some(server_id) = response.get("id") {
                let reply = if method == "ping" {
                    json!({ "jsonrpc": "2.0", "id": server_id, "result": {} })
                } else {
                    json!({ "jsonrpc": "2.0", "id": server_id, "error": { "code": -32601, "message": "Client capability not supported" } })
                };
                send(stdin, &reply).await?;
            }
            continue;
        }
        if response.get("id").and_then(Value::as_u64) != Some(id) {
            continue;
        }
        if let Some(error) = response.get("error") {
            return Err(CoreError::ExecutionFailed(format!(
                "MCP {method} failed: {error}"
            )));
        }
        return Ok(response.get("result").cloned().unwrap_or(Value::Null));
    }
}

async fn connect(config: &McpServerConfig) -> CoreResult<Connection> {
    // Contained in a job object like every other child: bounds memory/processes
    // and kills the tree with the app (KILL_ON_JOB_CLOSE). tokio has no
    // suspended-spawn, so containment happens immediately after spawn (tiny
    // race, documented) rather than before first instruction as in
    // `winproc::spawn_contained`.
    let job = crate::winproc::Job::create(crate::winproc::JobLimits::sandbox(1024, 8)).map_err(|error| {
        CoreError::ExecutionFailed(format!(
            "The MCP server '{}' job could not be created ({error}).",
            config.name
        ))
    })?;
    let mut command = tokio::process::Command::new(resolve_executable(&config.command)?);
    if let Some(cwd) = config.cwd.as_deref().filter(|s| !s.is_empty()) { command.current_dir(cwd); }
    for (key, raw) in &config.env {
        let value = if let Some(name) = raw.strip_prefix("${").and_then(|v| v.strip_suffix('}')) {
            std::env::var(name).map_err(|_| CoreError::InvalidDocument(format!("Set environment variable '{name}' before starting ZeroLeak.")))?
        } else { raw.clone() };
        command.env(key, value);
    }
    let mut child = command.args(&config.args)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .map_err(|error| {
            CoreError::ExecutionFailed(format!(
                "The MCP server '{}' could not start ({error}).",
                config.name
            ))
        })?;
    // Contain now; the handle is held to the end of the session so the tree
    // dies with it even if `kill` below is skipped by an early return.
    // tokio's `raw_handle` is Option<*mut c_void> on this version.
    if let Some(handle) = child.raw_handle() {
        if !handle.is_null() {
            // A containment failure refuses to run rather than running
            // uncontained.
            job.assign_raw(handle as isize).map_err(|e| {
                let _ = child.start_kill();
                e
            })?;
        }
    }
    let job = Arc::new(job);
    let mut stdin = child.stdin.take().ok_or_else(|| {
        CoreError::ExecutionFailed("The MCP server did not open an input channel.".into())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        CoreError::ExecutionFailed("The MCP server did not open an output channel.".into())
    })?;
    let mut stdout = BufReader::new(stdout);

    tokio::time::timeout(MCP_TIMEOUT, async {
        let initialized = request(
            &mut stdin,
            &mut stdout,
            1,
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "zeroleak-ai", "version": "0.1.0" }
            }),
        )
        .await?;
        let version = initialized.get("protocolVersion").and_then(Value::as_str).unwrap_or_default();
        if !["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"].contains(&version) {
            return Err(CoreError::ExecutionFailed(format!("MCP server negotiated unsupported protocol '{version}'.")));
        }
        send(
            &mut stdin,
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }),
        )
        .await
    })
    .await
    .map_err(|_| CoreError::Timeout(format!("MCP server '{}' did not initialize within 30 seconds.", config.name)))??;

    Ok(Connection {
        child,
        stdin,
        stdout,
        _job: job,
        next_id: 2,
    })
}

async fn close(slot: &mut Slot) {
    if let Some(mut connection) = slot.connection.take() { let _ = connection.child.kill().await; }
}

/// Removing, disabling or editing a configuration shuts down its old process.
/// The per-server mutex avoids one slow server blocking every other server.
pub async fn reconcile(settings: &AppSettings) {
    let slots: Vec<_> = connections().lock().await.iter().map(|(id, slot)| (id.clone(), slot.clone())).collect();
    for (id, slot) in slots {
        let mut held = slot.lock().await;
        if !settings.mcp_servers.iter().any(|s| s.enabled && s == &held.config) {
            held.retired = true;
            close(&mut held).await;
            let mut pool = connections().lock().await;
            if pool.get(&id).is_some_and(|current| Arc::ptr_eq(current, &slot)) { pool.remove(&id); }
        }
    }
}

async fn session(config: &McpServerConfig, method: &str, params: Value) -> CoreResult<Value> {
    let slot = {
        let mut pool = connections().lock().await;
        pool.entry(config.id.clone()).or_insert_with(|| Arc::new(tokio::sync::Mutex::new(Slot {
            config: config.clone(), retired: false, connection: None,
        }))).clone()
    };
    let mut slot = slot.lock().await;
    if slot.retired { return Err(CoreError::Denied("MCP configuration changed. Retry using the saved configuration.".into())); }
    if slot.config != *config { close(&mut slot).await; slot.config = config.clone(); }
    if slot.connection.is_none() { slot.connection = Some(connect(config).await?); }
    let connection = slot.connection.as_mut().expect("MCP connection inserted");
    let id = connection.next_id;
    connection.next_id = connection.next_id.saturating_add(1);
    let result = match tokio::time::timeout(MCP_TIMEOUT,
        request(&mut connection.stdin, &mut connection.stdout, id, method, params)).await {
        Ok(result) => result,
        Err(_) => Err(CoreError::Timeout(format!("MCP server '{}' did not answer within 30 seconds.", config.name))),
    };
    // A timed-out request leaves an unread response on the stream. Always close
    // it, so the next call starts a clean session instead of consuming stale data.
    if result.is_err() { close(&mut slot).await; }
    result
}

pub async fn list_tools(settings: &AppSettings, server_id: &str) -> CoreResult<Vec<McpToolSummary>> {
    let config = server(settings, server_id)?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = std::collections::HashSet::new();
    for _ in 0..100 {
        let params = cursor.as_ref().map_or_else(|| json!({}), |c| json!({ "cursor": c }));
        let result = session(config, "tools/list", params).await?;
        let page = result.get("tools").and_then(Value::as_array)
            .ok_or_else(|| CoreError::ExecutionFailed("MCP tools/list did not return a tools array.".into()))?;
        for tool in page {
            if let Some(name) = tool.get("name").and_then(Value::as_str) {
                tools.push(McpToolSummary {
                    name: name.to_string(),
                    description: tool.get("description").and_then(Value::as_str).unwrap_or_default().to_string(),
                    input_schema: tool.get("inputSchema").cloned().unwrap_or_else(|| json!({ "type": "object" })),
                });
            }
        }
        cursor = result.get("nextCursor").and_then(Value::as_str).map(str::to_owned);
        if let Some(next) = &cursor {
            if !seen.insert(next.clone()) { return Err(CoreError::ExecutionFailed("MCP server repeated a pagination cursor.".into())); }
        } else { return Ok(tools); }
    }
    Err(CoreError::ExecutionFailed("MCP tool list exceeded 100 pages.".into()))
}

pub async fn call_tool(
    settings: &AppSettings,
    server_id: &str,
    tool: &str,
    arguments: Value,
) -> CoreResult<String> {
    let config = server(settings, server_id)?;
    let result = session(
        config,
        "tools/call",
        json!({ "name": tool, "arguments": arguments }),
    )
    .await?;
    if result.get("isError").and_then(Value::as_bool) == Some(true) {
        return Err(CoreError::ExecutionFailed(format!("MCP tool '{tool}' failed: {result}")));
    }
    let text = result
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n");
    if text.is_empty() {
        Ok(serde_json::to_string_pretty(&result)?)
    } else {
        Ok(text)
    }
}

pub async fn list_resources(settings: &AppSettings, server_id: &str) -> CoreResult<Value> {
    let config = server(settings, server_id)?;
    session(config, "resources/list", json!({})).await
}

pub async fn read_resource(
    settings: &AppSettings,
    server_id: &str,
    uri: &str,
) -> CoreResult<String> {
    let config = server(settings, server_id)?;
    let result = session(config, "resources/read", json!({ "uri": uri })).await?;
    Ok(result
        .get("contents")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| item.get("text").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join("\n"))
}

pub async fn list_prompts(settings: &AppSettings, server_id: &str) -> CoreResult<Value> {
    let config = server(settings, server_id)?;
    session(config, "prompts/list", json!({})).await
}

pub async fn get_prompt(
    settings: &AppSettings,
    server_id: &str,
    name: &str,
    arguments: Value,
) -> CoreResult<Value> {
    let config = server(settings, server_id)?;
    session(config, "prompts/get", json!({ "name": name, "arguments": arguments })).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn stdio_uses_a_single_json_line_even_for_multiline_text() {
        let (mut writer, reader) = tokio::io::duplex(4096);
        let value = json!({ "jsonrpc": "2.0", "id": 1, "params": { "text": "a\nb" } });
        send(&mut writer, &value).await.unwrap();
        let mut reader = BufReader::new(reader);
        let line = bounded_line(&mut reader).await.unwrap();
        assert!(line.starts_with('{'));
        assert_eq!(line.matches('\n').count(), 1);
        assert_eq!(serde_json::from_str::<Value>(&line).unwrap(), value);
    }

    #[tokio::test]
    async fn accepts_standard_and_legacy_responses_and_bounds_unframed_output() {
        let value = json!({ "jsonrpc": "2.0", "id": 1, "result": {} });
        let raw = serde_json::to_string(&value).unwrap();
        for wire in [format!("{raw}\n"), format!("Content-Length: {}\r\n\r\n{raw}", raw.len())] {
            assert_eq!(receive(&mut BufReader::new(wire.as_bytes())).await.unwrap(), value);
        }
        let oversized = vec![b'x'; MAX_MESSAGE + 1];
        assert!(receive(&mut BufReader::new(oversized.as_slice())).await.is_err());
    }

    #[tokio::test]
    async fn answers_server_requests_before_matching_the_client_response() {
        let (client, server) = tokio::io::duplex(4096);
        let (client_read, mut client_write) = tokio::io::split(client);
        let (server_read, mut server_write) = tokio::io::split(server);
        let mut client_read = BufReader::new(client_read);
        let mut server_read = BufReader::new(server_read);
        let server = async {
            let message = receive(&mut server_read).await.unwrap();
            assert_eq!(message["method"], "tools/list");
            // Same numeric id, opposite direction: this must be answered as a
            // server request, not mistaken for our tools/list response.
            send(&mut server_write, &json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" })).await.unwrap();
            assert!(receive(&mut server_read).await.unwrap().get("result").is_some());
            send(&mut server_write, &json!({ "jsonrpc": "2.0", "id": "q", "method": "sampling/createMessage" })).await.unwrap();
            assert_eq!(receive(&mut server_read).await.unwrap()["error"]["code"], -32601);
            send(&mut server_write, &json!({ "jsonrpc": "2.0", "method": "notifications/progress" })).await.unwrap();
            send(&mut server_write, &json!({ "jsonrpc": "2.0", "id": 7, "result": { "tools": [] } })).await.unwrap();
        };
        let client = request(&mut client_write, &mut client_read, 7, "tools/list", json!({}));
        let ((), result) = tokio::join!(server, client);
        assert_eq!(result.unwrap(), json!({ "tools": [] }));
    }
}

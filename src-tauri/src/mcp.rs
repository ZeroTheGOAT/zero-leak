//! Minimal local-stdio MCP client.
//!
//! Servers are explicit executable paths from Settings. No shell is involved,
//! no package is downloaded, and every agent invocation passes through the
//! normal execute-risk approval gate before this module is reached.

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::error::{CoreError, CoreResult};
use crate::types::{AppSettings, McpServerConfig, McpToolSummary};

const MCP_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_MESSAGE: usize = 8 * 1024 * 1024;

fn server<'a>(settings: &'a AppSettings, id: &str) -> CoreResult<&'a McpServerConfig> {
    let server = settings
        .mcp_servers
        .iter()
        .find(|server| server.id == id && server.enabled)
        .ok_or_else(|| CoreError::Denied(format!("No enabled MCP server named '{id}' is configured.")))?;
    let command = Path::new(&server.command);
    if !command.is_absolute() || !command.is_file() {
        return Err(CoreError::Denied(format!(
            "The MCP server '{}' must name an existing absolute executable path. Nothing was launched.",
            server.name
        )));
    }
    Ok(server)
}

async fn send(stdin: &mut tokio::process::ChildStdin, message: &Value) -> CoreResult<()> {
    let body = serde_json::to_vec(message)?;
    let header = format!("Content-Length: {}\r\n\r\n", body.len());
    stdin.write_all(header.as_bytes()).await?;
    stdin.write_all(&body).await?;
    stdin.flush().await?;
    Ok(())
}

async fn receive<R: AsyncBufRead + Unpin>(reader: &mut R) -> CoreResult<Value> {
    let mut first = String::new();
    let n = reader.read_line(&mut first).await?;
    if n == 0 {
        return Err(CoreError::ExecutionFailed(
            "The MCP server closed its output before answering.".into(),
        ));
    }
    let trimmed = first.trim();
    // A few local servers still use newline-delimited JSON. Supporting it costs
    // no ambiguity because a framed header can never begin with `{`.
    if trimmed.starts_with('{') {
        return serde_json::from_str(trimmed).map_err(Into::into);
    }

    let mut length = trimmed
        .strip_prefix("Content-Length:")
        .and_then(|value| value.trim().parse::<usize>().ok());
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).await?;
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

async fn request(
    stdin: &mut tokio::process::ChildStdin,
    stdout: &mut BufReader<tokio::process::ChildStdout>,
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

async fn session(
    config: &McpServerConfig,
    method: &str,
    params: Value,
) -> CoreResult<Value> {
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
    let mut child = tokio::process::Command::new(&config.command)
        .args(&config.args)
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
    let _job = std::sync::Arc::new(job);
    let mut stdin = child.stdin.take().ok_or_else(|| {
        CoreError::ExecutionFailed("The MCP server did not open an input channel.".into())
    })?;
    let stdout = child.stdout.take().ok_or_else(|| {
        CoreError::ExecutionFailed("The MCP server did not open an output channel.".into())
    })?;
    let mut stdout = BufReader::new(stdout);

    let result = tokio::time::timeout(MCP_TIMEOUT, async {
        request(
            &mut stdin,
            &mut stdout,
            1,
            "initialize",
            json!({
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": { "name": "servergen-ai", "version": "0.1.0" }
            }),
        )
        .await?;
        send(
            &mut stdin,
            &json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": {} }),
        )
        .await?;
        request(&mut stdin, &mut stdout, 2, method, params).await
    })
    .await
    .map_err(|_| CoreError::Timeout(format!("MCP server '{}' did not answer within 30 seconds.", config.name)))?;

    let _ = child.kill().await;
    result
}

pub async fn list_tools(settings: &AppSettings, server_id: &str) -> CoreResult<Vec<McpToolSummary>> {
    let config = server(settings, server_id)?;
    let result = session(config, "tools/list", json!({})).await?;
    Ok(result
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|tool| {
            Some(McpToolSummary {
                name: tool.get("name")?.as_str()?.to_string(),
                description: tool
                    .get("description")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
            })
        })
        .collect())
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

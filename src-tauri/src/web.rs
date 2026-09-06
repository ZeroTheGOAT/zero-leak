//! The browser transport.
//!
//! The desktop window and a browser tab are the same application. All heavy
//! compute already lives in a separate native process — `llama-server.exe`
//! talking to CUDA — and the UI only renders text, so a tab has exactly the same
//! access to this machine's 20 cores and 8188 MiB of VRAM that a WebView2 window
//! does. What a browser cannot do on its own is spawn that process, put it in a
//! job object, or read a path on `C:`. So the browser gets a transport to the
//! core rather than a copy of it: every request here goes through
//! `api::dispatch`, the same function Tauri IPC calls.
//!
//! At 8 GB of VRAM the browser mode also earns its keep. A WebView2 window holds
//! a few hundred MiB for compositing. Running with no window (`--no-window`)
//! hands that back to the model, which matters when olmOCR-2 alone peaks at
//! 7387 MiB against a 7106 MiB working budget.
//!
//! ## Being honest about the attack surface
//!
//! Tauri IPC is reachable only from the webview this process created. A TCP
//! listener is reachable by anything that can open a socket to it. That is a
//! genuinely larger surface, and no amount of layering makes it equal. What is
//! done about it:
//!
//!   * Bound to `127.0.0.1` only — never `0.0.0.0`. Nothing off this machine can
//!     connect, regardless of firewall state.
//!   * A 256-bit session token, new on every launch, delivered once via `?k=`
//!     and then held as an `HttpOnly; SameSite=Strict` cookie. `HttpOnly` keeps
//!     it out of reach of page script; `SameSite=Strict` means another site
//!     cannot make the browser attach it. The token is written to a file under
//!     `%LOCALAPPDATA%`, which is ACL'd to this user, not to a world-readable
//!     path.
//!   * `Origin` is checked on every state-changing request, which is what stops
//!     a page on another origin from driving the core.
//!   * `Host` is checked, which is what stops DNS rebinding: an attacker's
//!     domain resolving to 127.0.0.1 still arrives with the wrong `Host`.
//!   * No CORS headers are sent at all, so no cross-origin read can succeed even
//!     if the checks above were bypassed.
//!   * A strict CSP is set on the served HTML, because the webview's configured
//!     CSP applies to the webview and does not follow the page into a browser.
//!
//! What remains true: another *local* process running as this user could read
//! the token file and drive the core. That is also true of Tauri IPC (it could
//! inject into the process) and of the router's own port. On a single-user
//! workstation this is the same trust boundary; on a shared machine it is worth
//! knowing rather than being told it is airtight.

use std::convert::Infallible;
use std::net::TcpListener as StdListener;
use std::path::PathBuf;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{extract::DefaultBodyLimit, Json, Router};
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use crate::error::{CoreError, CoreResult};
use crate::state::AppState;

const COOKIE_NAME: &str = "sovereign_session";

/// Mirrors the webview CSP, adjusted for a browser: `connect-src 'self'` is what
/// lets the page reach `/api/*` and nothing else. `style-src 'unsafe-inline'` is
/// required because React writes inline `style` attributes; script has no such
/// exemption.
const CSP: &str = "default-src 'self'; \
     script-src 'self'; \
     style-src 'self' 'unsafe-inline'; \
     img-src 'self' data: blob:; \
     font-src 'self' data:; \
     connect-src 'self'; \
     media-src 'self' blob:; \
     object-src 'none'; \
     base-uri 'none'; \
     form-action 'none'; \
     frame-ancestors 'none'";

struct Web {
    st: Arc<AppState>,
    token: String,
    port: u16,
}

/* ------------------------------------------------------------------ */
/* Start-up                                                           */
/* ------------------------------------------------------------------ */

/// Binds the loopback listener, starts serving, and returns the URL that
/// includes the one-time token.
///
/// The bind happens synchronously so the caller has a real port to report — the
/// URL is written to a file and possibly opened in a browser, and neither can
/// wait on a task that may not have bound yet.
pub fn serve(st: Arc<AppState>, requested_port: u16) -> CoreResult<String> {
    let std_listener = StdListener::bind(("127.0.0.1", requested_port)).map_err(|e| {
        CoreError::ExecutionFailed(format!(
            "Could not bind 127.0.0.1:{requested_port} for browser access: {e}. The desktop window is unaffected."
        ))
    })?;
    std_listener.set_nonblocking(true).map_err(|e| {
        CoreError::ExecutionFailed(format!("Could not configure the loopback listener: {e}"))
    })?;
    let port = std_listener
        .local_addr()
        .map_err(|e| CoreError::ExecutionFailed(format!("Could not read the bound port: {e}")))?
        .port();

    // 256 bits from the same CSPRNG that backs uuid v4.
    let token = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    );
    let url = format!("http://127.0.0.1:{port}/?k={token}");

    if let Ok(mut slot) = st.web_url.write() {
        *slot = Some(url.clone());
    }

    let ctx = Arc::new(Web { st: st.clone(), token, port });

    let app = Router::new()
        .route("/api/invoke", post(invoke))
        .route("/api/events", get(events))
        // Five minutes of 16 kHz mono PCM is about 9.6 MiB (12.8 MiB as
        // base64). Keep the local browser transport aligned with Tauri IPC.
        .layer(DefaultBodyLimit::max(18 * 1024 * 1024))
        // One page, so anything unrecognised resolves to the app shell.
        .fallback(assets)
        .with_state(ctx);

    tauri::async_runtime::spawn(async move {
        let listener = match tokio::net::TcpListener::from_std(std_listener) {
            Ok(l) => l,
            Err(e) => {
                st.emit(
                    "core://status",
                    crate::types::CoreStatus {
                        state: "core_only".into(),
                        ipc: true,
                        router: false,
                        router_version: None,
                        detail: format!("Browser access could not start: {e}. The desktop window still works."),
                    },
                );
                return;
            }
        };
        // A serve error here means the socket died; the desktop transport is
        // independent of it, so this is reported and not fatal.
        let _ = axum::serve(listener, app).await;
    });

    Ok(url)
}

/// Writes the session URL where the user can find it again, under a per-user
/// ACL'd directory rather than the shared `C:\sovereign` tree.
pub fn write_session_file(url: &str) -> Option<PathBuf> {
    let base = std::env::var("LOCALAPPDATA").ok()?;
    let dir = PathBuf::from(base).join("SovereignWorkbench");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join("session-url.txt");
    let body = format!(
        "Sovereign AI Workbench — browser access for this session only.\n\
         This link contains a one-time token. It stops working when the app exits.\n\n\
         {url}\n"
    );
    std::fs::write(&path, body).ok()?;
    Some(path)
}

/* ------------------------------------------------------------------ */
/* Guards                                                             */
/* ------------------------------------------------------------------ */

/// Constant-time comparison. A 256-bit token on loopback is not realistically
/// attackable by timing, but a variable-time compare on a secret is the kind of
/// thing that is free to get right and awkward to explain later.
fn ct_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

fn header_str<'a>(h: &'a HeaderMap, name: header::HeaderName) -> Option<&'a str> {
    h.get(name).and_then(|v| v.to_str().ok())
}

/// Rejects a request whose `Host` is not one of ours. This is the DNS-rebinding
/// check: a hostile domain pointed at 127.0.0.1 arrives with its own name here.
fn host_ok(ctx: &Web, h: &HeaderMap) -> bool {
    match header_str(h, header::HOST) {
        Some(host) => {
            host == format!("127.0.0.1:{}", ctx.port) || host == format!("localhost:{}", ctx.port)
        }
        // HTTP/1.1 requires Host. Absent means a client we did not write.
        None => false,
    }
}

/// Rejects a cross-origin request. Browsers send `Origin` on every POST,
/// including same-origin ones, so requiring it here costs nothing and is what
/// stops another page from driving the core. `EventSource` and plain navigations
/// send no `Origin`, which is why this is not applied to GET — those are covered
/// by `SameSite=Strict` on the cookie plus the `Host` check.
fn origin_ok(ctx: &Web, h: &HeaderMap) -> bool {
    match header_str(h, header::ORIGIN) {
        Some(o) => {
            o == format!("http://127.0.0.1:{}", ctx.port)
                || o == format!("http://localhost:{}", ctx.port)
        }
        None => false,
    }
}

fn cookie_token(h: &HeaderMap) -> Option<String> {
    header_str(h, header::COOKIE)?
        .split(';')
        .map(str::trim)
        .find_map(|kv| kv.strip_prefix(COOKIE_NAME).and_then(|r| r.strip_prefix('=')))
        .map(str::to_string)
}

fn authorised(ctx: &Web, h: &HeaderMap) -> bool {
    cookie_token(h).map(|t| ct_eq(&t, &ctx.token)).unwrap_or(false)
}

/// Local brute-force throttle: counts unauthorised `/api/invoke` hits per
/// minute and answers 429 past the budget. The 256-bit token is not guessable,
/// but an unthrottled endpoint lets a local process try forever for free.
fn auth_failures() -> &'static std::sync::Mutex<(u64, u32)> {
    static FAILURES: std::sync::OnceLock<std::sync::Mutex<(u64, u32)>> = std::sync::OnceLock::new();
    FAILURES.get_or_init(|| std::sync::Mutex::new((0, 0)))
}

fn auth_throttled(now: u64) -> bool {
    const WINDOW_MS: u64 = 60_000;
    const BUDGET: u32 = 30;
    let guard = auth_failures().lock().unwrap_or_else(|e| e.into_inner());
    now - guard.0 <= WINDOW_MS && guard.1 >= BUDGET
}

fn note_auth_failure(now: u64) {
    const WINDOW_MS: u64 = 60_000;
    let mut guard = auth_failures().lock().unwrap_or_else(|e| e.into_inner());
    if now - guard.0 > WINDOW_MS {
        *guard = (now, 1);
    } else {
        guard.1 = guard.1.saturating_add(1);
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn deny(status: StatusCode, detail: &str) -> Response {
    let mut r = (status, Json(json!({ "ok": false, "error": detail }))).into_response();
    hardening(r.headers_mut());
    r
}

fn hardening(h: &mut HeaderMap) {
    for (k, v) in [
        (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        (header::REFERRER_POLICY, "no-referrer"),
        (header::CACHE_CONTROL, "no-store"),
    ] {
        if let Ok(val) = v.parse() {
            h.insert(k, val);
        }
    }
    for (k, v) in [
        ("cross-origin-opener-policy", "same-origin"),
        ("cross-origin-resource-policy", "same-origin"),
    ] {
        if let (Ok(name), Ok(val)) = (k.parse::<header::HeaderName>(), v.parse()) {
            h.insert(name, val);
        }
    }
}

/* ------------------------------------------------------------------ */
/* POST /api/invoke                                                   */
/* ------------------------------------------------------------------ */

/// The whole command surface, over one route.
///
/// A core error comes back as HTTP 200 with `{ok:false,error}` rather than a 4xx.
/// That is deliberate: Tauri's `invoke` rejects with the serialised `CoreError`
/// string, and the browser transport has to produce a rejection carrying the
/// *same* text so `services/core.ts` and every component above it cannot tell
/// which transport it is on. A transport-level 4xx is reserved for the guards,
/// which are a different kind of failure.
async fn invoke(
    axum::extract::State(ctx): axum::extract::State<Arc<Web>>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if !host_ok(&ctx, &headers) {
        return deny(StatusCode::FORBIDDEN, "Rejected: unexpected Host header.");
    }
    if !origin_ok(&ctx, &headers) {
        return deny(
            StatusCode::FORBIDDEN,
            "Rejected: this request did not come from the workbench page on this machine.",
        );
    }
    if auth_throttled(now_ms()) {
        return deny(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many unauthorised attempts. Wait a minute and open the workbench link for this launch.",
        );
    }
    if !authorised(&ctx, &headers) {
        note_auth_failure(now_ms());
        return deny(
            StatusCode::UNAUTHORIZED,
            "This session is not authorised. Open the workbench using the link the application printed for this launch.",
        );
    }

    let Some(Json(payload)) = body else {
        return deny(StatusCode::BAD_REQUEST, "The request body was not JSON.");
    };
    let Some(command) = payload.get("command").and_then(Value::as_str) else {
        return deny(StatusCode::BAD_REQUEST, "The request named no command.");
    };
    let args = payload.get("args").cloned().unwrap_or_else(|| json!({}));

    let out = match crate::api::dispatch(&ctx.st, command, &args).await {
        Ok(data) => json!({ "ok": true, "data": data }),
        // `to_string()`, not `message()`: that is exactly what `CoreError`'s
        // `Serialize` impl produces, so a browser rejection carries the same
        // words — recovery hint included — as the IPC one.
        Err(e) => json!({ "ok": false, "error": e.to_string() }),
    };

    let mut r = Json(out).into_response();
    hardening(r.headers_mut());
    r
}

/* ------------------------------------------------------------------ */
/* GET /api/events                                                    */
/* ------------------------------------------------------------------ */

/// Replays `AppState::emit` to the browser.
///
/// The payload bytes are the ones the desktop window receives — `emit`
/// serialises once and sends the same string to both — so the two transports
/// cannot drift in what an event contains.
async fn events(
    axum::extract::State(ctx): axum::extract::State<Arc<Web>>,
    headers: HeaderMap,
) -> Response {
    if !host_ok(&ctx, &headers) {
        return deny(StatusCode::FORBIDDEN, "Rejected: unexpected Host header.");
    }
    if !authorised(&ctx, &headers) {
        return deny(StatusCode::UNAUTHORIZED, "This session is not authorised.");
    }

    let rx = ctx.st.events.subscribe();
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        loop {
            match rx.recv().await {
                Ok(line) => return Some((Ok::<Event, Infallible>(Event::default().data(line)), rx)),
                // The channel drops for a slow receiver rather than blocking the
                // agent loop, which is the right trade — but a dropped
                // `core://model` would leave a panel showing something untrue,
                // so say so instead of pretending the stream was continuous.
                Err(RecvError::Lagged(n)) => {
                    let notice = json!({ "event": "core://resync", "payload": { "dropped": n } });
                    return Some((Ok(Event::default().data(notice.to_string())), rx));
                }
                Err(RecvError::Closed) => return None,
            }
        }
    });

    let mut r = Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response();
    hardening(r.headers_mut());
    r
}

/* ------------------------------------------------------------------ */
/* Static assets                                                      */
/* ------------------------------------------------------------------ */

/// Serves the built frontend, and performs the one-time token handshake.
///
/// The token arrives once in the query string, is exchanged for an `HttpOnly`
/// cookie, and the browser is redirected to the clean path — so the token does
/// not sit in the address bar, is not readable by page script, and is not
/// carried in a `Referer` (`no-referrer` above).
async fn assets(
    axum::extract::State(ctx): axum::extract::State<Arc<Web>>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    if !host_ok(&ctx, &headers) {
        return deny(StatusCode::FORBIDDEN, "Rejected: unexpected Host header.");
    }

    if !authorised(&ctx, &headers) {
        // The token is hex, so there is nothing to percent-decode.
        let supplied = uri.query().and_then(|q| {
            q.split('&')
                .find_map(|kv| kv.strip_prefix("k=").map(str::to_string))
        });
        match supplied {
            Some(t) if ct_eq(&t, &ctx.token) => {
                let clean = uri.path().to_string();
                let mut r = Response::builder()
                    .status(StatusCode::SEE_OTHER)
                    .header(header::LOCATION, clean)
                    .header(
                        header::SET_COOKIE,
                        format!("{COOKIE_NAME}={}; Path=/; HttpOnly; SameSite=Strict", ctx.token),
                    )
                    .body(Body::empty())
                    .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
                hardening(r.headers_mut());
                return r;
            }
            _ => return unauthorised_page(),
        }
    }

    // Decode *before* checking. `%2e%2e%2f` is `../`, and a check on the raw
    // path lets it through to whatever decodes next — today nothing does, which
    // makes that safe by accident rather than by design. A malformed escape is
    // rejected rather than repaired: guessing at a caller's intent is how a
    // check ends up disagreeing with the code that uses its output.
    let Some(decoded) = percent_decode(uri.path()) else {
        return deny(
            StatusCode::BAD_REQUEST,
            "Rejected: the path contains a malformed escape or is not valid UTF-8.",
        );
    };
    if decoded.contains("..") {
        return deny(StatusCode::BAD_REQUEST, "Rejected: the path traverses upward.");
    }
    // A colon would be a drive letter or an NTFS alternate data stream; a NUL
    // truncates the path for anything below that takes a C string.
    if decoded.contains(':') || decoded.contains('\0') {
        return deny(
            StatusCode::BAD_REQUEST,
            "Rejected: that is not a relative path to a bundled asset.",
        );
    }
    let rel = decoded.trim_start_matches(['/', '\\']);
    let rel = if rel.is_empty() { "index.html" } else { rel };

    // An unknown path that is not a file request resolves to the app shell, so
    // the single-page router keeps working on a deep link or a refresh.
    let (bytes, mime) = match load_asset(&ctx.st, rel) {
        Some(v) => v,
        None => match load_asset(&ctx.st, "index.html") {
            Some(v) => v,
            None => return missing_build_page(),
        },
    };

    let is_html = mime.starts_with("text/html");
    let mut b = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime);
    if is_html {
        b = b.header("content-security-policy", CSP);
    }
    let mut r = b
        .body(Body::from(bytes))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    hardening(r.headers_mut());
    r
}

/// Release builds serve the frontend embedded in the executable; a development
/// build has nothing embedded, so `dist/` on disk is used. Web mode in
/// development therefore needs `npm run build` first — the Vite dev server is a
/// different origin and proxying it would mean relaxing the checks above.
fn load_asset(st: &AppState, rel: &str) -> Option<(Vec<u8>, String)> {
    if let Some(asset) = st.app.asset_resolver().get(format!("/{rel}")) {
        return Some((asset.bytes, asset.mime_type));
    }
    // Containment is proved against the resolved path rather than argued from
    // the shape of the string. Both sides are canonicalised, so symlinks, 8.3
    // short names and any encoding this server does not understand are all
    // covered by the same one comparison.
    for dir in dist_dirs() {
        let Ok(root) = dir.canonicalize() else { continue };
        let Ok(real) = root.join(rel).canonicalize() else { continue };
        if !real.starts_with(&root) || !real.is_file() {
            continue;
        }
        if let Ok(bytes) = std::fs::read(&real) {
            return Some((bytes, mime_for(rel).to_string()));
        }
    }
    None
}

/// Percent-decoding for request paths.
///
/// Hand-written rather than pulled from a crate because the check that consumes
/// it must not be surprised by an encoding this server does not understand, and
/// twelve auditable lines are easier to be sure of than a dependency's edge
/// cases. `None` means a malformed escape or non-UTF-8 bytes, and the caller
/// turns that into a refusal.
fn percent_decode(s: &str) -> Option<String> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            out.push(hex_val(*b.get(i + 1)?)? << 4 | hex_val(*b.get(i + 2)?)?);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn dist_dirs() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("..").join("dist"));
    }
    out.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..").join("dist"));
    out
}

fn mime_for(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).as_deref() {
        Some("html") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff2") => "font/woff2",
        Some("woff") => "font/woff",
        Some("ttf") => "font/ttf",
        Some("map") => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/* ------------------------------------------------------------------ */
/* The two pages this module renders itself                            */
/* ------------------------------------------------------------------ */

fn page(status: StatusCode, title: &str, body: &str) -> Response {
    let html = format!(
        "<!doctype html><meta charset=\"utf-8\"><title>{title}</title>\
         <style>body{{background:#0b0d10;color:#e6e8eb;font:14px/1.6 ui-sans-serif,system-ui,sans-serif;\
         margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center}}\
         main{{max-width:34rem;padding:2rem}}h1{{font-size:1.05rem;margin:0 0 .75rem;font-weight:600}}\
         p{{margin:0 0 .75rem;color:#9aa3ad}}code{{color:#e6e8eb;background:#15181d;padding:.15rem .35rem;\
         border-radius:.25rem}}</style><main><h1>{title}</h1>{body}</main>"
    );
    let mut r = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "text/html; charset=utf-8")
        .header("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'")
        .body(Body::from(html))
        .unwrap_or_else(|_| StatusCode::INTERNAL_SERVER_ERROR.into_response());
    hardening(r.headers_mut());
    r
}

fn unauthorised_page() -> Response {
    page(
        StatusCode::UNAUTHORIZED,
        "This session needs its launch link",
        "<p>Browser access is authorised per launch, so a bookmarked address will not work after a restart.</p>\
         <p>The current link is in <code>%LOCALAPPDATA%\\SovereignWorkbench\\session-url.txt</code>, \
         and the desktop window shows it under <b>Open in browser</b>.</p>",
    )
}

fn missing_build_page() -> Response {
    page(
        StatusCode::SERVICE_UNAVAILABLE,
        "The frontend has not been built",
        "<p>The core is running and this listener works, but there is no built frontend to serve.</p>\
         <p>Run <code>npm run build</code> once. A release build embeds the frontend and does not need this; \
         a development build serves <code>dist/</code> from disk, because the Vite dev server is a different \
         origin and proxying it would mean relaxing the origin checks that protect this port.</p>",
    )
}

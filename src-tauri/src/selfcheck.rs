//! `check_page` — the agent looking at its own work.
//!
//! A run that writes files, starts a server and reports success has verified
//! nothing: the model only knows what it *wrote*, not what the browser
//! *renders*. This module is the missing observation step of the build loop.
//! It takes the workspace's running server, fetches the page as a browser
//! would, checks the HTML for the failure shapes a silent server produces
//! (a 404 body, a dev-server error page, references the server itself cannot
//! answer), renders the page in a real Chromium and asks the local vision
//! model what is wrong with the picture — all loopback, all local, the same
//! containment as every other process the app launches.
//!
//! The report it returns is what closes the loop: the agent reads it, fixes
//! what it names, and checks again, instead of asserting a URL works because
//! it started a server that printed one.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use crate::agent::Step;
use crate::error::{CoreError, CoreResult};
use crate::state::{new_id, AppState};
use crate::types::{DevServerState, StepKind, ToolName};
use crate::winproc::{self, JobLimits};

/// How many page references are probed. A hand-built page has a handful; a
/// framework build has dozens; a cap keeps a pathological page from turning
/// one tool call into a crawl.
const MAX_REFS: usize = 30;

/// How long the renderer may take. `--virtual-time-budget` makes Chromium
/// fast-forward timers and settle, so this only bounds a hung GPU or a page
/// that never stops loading.
const RENDER_TIMEOUT: Duration = Duration::from_secs(45);

/// The rendered viewport: wide enough for the desktop layout, short enough
/// that the vision model spends its token budget on content, not letterboxing.
const WINDOW: &str = "1280,800";

pub async fn check_page(st: &std::sync::Arc<AppState>, workspace_id: &str) -> CoreResult<String> {
    // The run's own server, from the same registry the composer bar reads —
    // not a URL the model claims, which is exactly what is being checked.
    let server = st
        .dev_servers
        .status()
        .into_iter()
        .find(|s| s.workspace_id == workspace_id && s.status == DevServerState::Running)
        .and_then(|s| s.url.clone())
        .ok_or_else(|| {
            CoreError::ExecutionFailed(
                "No running server for this workspace, so there is no page to check. Start one \
first: serve_folder for finished files, start_dev_server for a dev server."
                    .into(),
            )
        })?;

    let step = Step::start(st, StepKind::Verifying, "Checking the served page")
        .tool(ToolName::CheckPage)
        .detail(format!("Fetching {server}"));

    match run_checks(st, &server).await {
        Ok(report) => {
            step.detail(report.verdict()).ok(st);
            Ok(report.render(&server))
        }
        Err(e) => {
            step.fail(st, &e.to_string());
            Err(e)
        }
    }
}

/// Everything the checks found, kept separately from how it is worded so the
/// verdict line is derived, not hand-maintained per branch.
struct Report {
    http: String,
    title: Option<String>,
    error_markers: Vec<String>,
    broken_refs: Vec<String>,
    screenshot: Screenshot,
}

enum Screenshot {
    /// The page rendered, and the local vision model read the picture.
    Critiqued(String),
    /// The page rendered but the vision model could not read it — the HTTP and
    /// reference checks still stand, and the report says what did not happen
    /// rather than implying a visual pass.
    RenderedNotCritiqued(String),
    /// No renderer on this machine, or it failed.
    Unavailable(String),
}

impl Report {
    fn verdict(&self) -> String {
        let problems = self.error_markers.len() + self.broken_refs.len();
        let visual = match &self.screenshot {
            Screenshot::Critiqued(_) => None,
            Screenshot::RenderedNotCritiqued(why) => {
                Some(format!("the page rendered but the vision model could not read it ({why})"))
            }
            Screenshot::Unavailable(why) => {
                Some(format!("the page was NOT visually inspected ({why})"))
            }
        };
        if let Some(why) = &visual {
            return format!("{problems} problem(s) found; {why}");
        }
        if problems == 0 {
            "The page answers, its references resolve and it was visually inspected — see the vision findings.".into()
        } else {
            format!("{problems} problem(s) found — fix them and check again.")
        }
    }

    fn render(&self, url: &str) -> String {
        let mut out = format!("Page check for {url}\n\n{}\n", self.http);
        match &self.title {
            Some(t) => out.push_str(&format!("Title: {t}\n")),
            None => out.push_str("Title: none — a page without a <title> is unfinished.\n"),
        }
        if !self.error_markers.is_empty() {
            out.push_str(&format!(
                "\nError text visible in the served HTML (each means the page a visitor gets is an error page):\n{}\n",
                self.error_markers.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n")
            ));
        }
        if !self.broken_refs.is_empty() {
            out.push_str(&format!(
                "\nReferences the server does not answer (these arrive as broken images, missing styles or dead scripts in the browser):\n{}\n",
                self.broken_refs.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n")
            ));
        }
        match &self.screenshot {
            Screenshot::Critiqued(findings) => out.push_str(&format!(
                "\nThe page was rendered in a real browser and read by the local vision model. Its findings:\n\n{findings}"
            )),
            Screenshot::RenderedNotCritiqued(why) => out.push_str(&format!(
                "\nThe page rendered in a real browser, but the vision model could not read the picture: {why}. The HTTP and reference checks above still apply."
            )),
            Screenshot::Unavailable(why) => {
                out.push_str(&format!("\nThe page was NOT visually inspected: {why}. The HTTP and reference checks above still apply."))
            }
        }
        out
    }
}

async fn run_checks(st: &std::sync::Arc<AppState>, url: &str) -> CoreResult<Report> {
    // ---- fetch, as a browser would ----
    let resp = st
        .http
        .get(url)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| CoreError::ExecutionFailed(format!("The URL did not answer: {e}")))?;
    let status = resp.status();
    let content_type = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(CoreError::ExecutionFailed(format!(
            "The server answered {status} for its own front page, so every visitor gets an error page."
        )));
    }
    let is_html = content_type.contains("text/html");
    let http = format!("HTTP {status} ({})", if is_html { "HTML" } else { content_type.as_str() });
    if !is_html {
        return Ok(Report {
            http: format!("{http} — not a web page"),
            title: None,
            error_markers: vec![],
            broken_refs: vec![],
            screenshot: Screenshot::Unavailable(
                "the front page is not HTML, so there is nothing to render".into(),
            ),
        });
    }

    // ---- HTML checks ----
    let title = extract_title(&body);
    let error_markers = error_markers(&body);
    let refs = local_references(&body);
    let mut broken_refs = Vec::new();
    for reference in refs.iter().take(MAX_REFS) {
        let probe = st
            .http
            .get(format!("{url}{reference}"))
            .timeout(Duration::from_secs(5))
            .send()
            .await;
        match probe {
            Ok(r) if r.status().is_success() => {}
            Ok(r) => broken_refs.push(format!("{reference} (answers {})", r.status())),
            Err(e) => broken_refs.push(format!("{reference} ({e})")),
        }
    }

    // ---- render, then let the vision model read the picture ----
    // `render` polls its child with blocking sleeps for up to RENDER_TIMEOUT,
    // so it belongs on the blocking pool: called inline it would park an async
    // worker — and with it every other chat's turn — for as long as the page
    // takes to paint.
    let rendered = tokio::task::spawn_blocking({
        let url = url.to_string();
        move || render(&url)
    })
    .await
    .unwrap_or_else(|e| Err(format!("the renderer task failed ({e})")));
    let screenshot = match rendered {
        Ok(bytes) => match vision_critique(st, &bytes).await {
            Ok(findings) => Screenshot::Critiqued(findings),
            Err(why) => Screenshot::RenderedNotCritiqued(why),
        },
        Err(why) => Screenshot::Unavailable(why),
    };

    Ok(Report { http, title, error_markers, broken_refs, screenshot })
}

/// Shows the rendered page to the local vision model and asks what is wrong
/// with it. Whichever vision-capable model the router picks for a photograph
/// (Gemma 4 E4B with its own projector, MiniCPM-V as an alternative) — the
/// question is about layout and completeness, not transcription.
async fn vision_critique(st: &std::sync::Arc<AppState>, png: &[u8]) -> Result<String, String> {
    let decision = {
        let reg = st.registry.read().unwrap_or_else(|e| e.into_inner());
        reg.route(crate::registry::TaskKind::Photograph, None)
    };
    let model_id = decision.model_id.ok_or_else(|| {
        "no vision model is configured for page critique — check the Models panel".to_string()
    })?;
    let step = crate::agent::Step::start(st, StepKind::Vision, "Looking at the rendered page")
        .tool(ToolName::CheckPage)
        .model(Some(model_id.clone()));
    let prompt = "This is a screenshot of the web page that was just built and served on this \
machine. Inspect it for defects a visitor would see: a blank page, raw unrendered HTML showing as \
text, broken-image placeholders, missing styles, overlapping or cut-off elements, or a visible \
error message. Quote any visible error text exactly as it appears. If the page renders correctly, \
say \"The page renders correctly\" and describe in one sentence what is on it. Answer only from \
what is visible in this image.";
    match crate::router::vision(st, &model_id, vec![png.to_vec()], prompt).await {
        Ok(answer) => {
            step.detail(format!("{} characters of findings from {model_id}.", answer.len())).ok(st);
            Ok(answer)
        }
        Err(e) => {
            step.fail(st, &e.to_string());
            Err(e.to_string())
        }
    }
}

/// Failure text a functioning front page never contains. Each is a server
/// framework's own error body, seen verbatim in the wild.
const ERROR_MARKERS: &[&str] = &[
    "Cannot GET",
    "Whitelabel Error Page",
    "Error response",
    "404 Not Found",
    "500 Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
];

fn error_markers(body: &str) -> Vec<String> {
    ERROR_MARKERS
        .iter()
        .filter(|m| body.contains(*m))
        .map(|m| m.to_string())
        .collect()
}

fn extract_title(body: &str) -> Option<String> {
    // ASCII lowercasing, because these offsets are used to slice `body`.
    // `to_lowercase` is full Unicode folding and does not preserve byte length —
    // one `\u{130}` (dotted capital I, an ordinary letter in a Turkish or
    // Azerbaijani page title) becomes two chars and shifts everything after it,
    // so the title came out cut in the wrong place, and a shift that landed
    // mid-character panicked inside the tool call. Every marker searched for here
    // is ASCII: an HTML tag and attribute name cannot be anything else.
    let lower = body.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let after = lower[start..].find('>')? + start + 1;
    let end = lower[after..].find("</title>")? + after;
    let title = body[after..end].trim();
    (!title.is_empty()).then(|| title.to_string())
}

/// Local references worth probing: `src` and `href` values that point inside
/// the site rather than off it. External URLs are skipped — this is a
/// loopback check, not a link checker for the public web.
fn local_references(body: &str) -> Vec<String> {
    // ASCII, so the offsets stay valid in `body` — see `extract_title`.
    let lower = body.to_ascii_lowercase();
    let mut out = Vec::new();
    for attr in ["src=\"", "src='", "href=\"", "href='"] {
        let quote = attr.chars().last().unwrap();
        let mut from = 0usize;
        while let Some(rel) = lower[from..].find(attr) {
            let at = from + rel + attr.len();
            let end = body[at..].find(quote).map(|e| at + e).unwrap_or(body.len());
            let value = body[at..end].trim();
            from = end.min(body.len().saturating_sub(1));
            let stripped = value.split(['?', '#']).next().unwrap_or("").trim();
            if stripped.is_empty()
                || stripped.starts_with("http://")
                || stripped.starts_with("https://")
                || stripped.starts_with("//")
                || stripped.starts_with("data:")
                || stripped.starts_with('#')
                || stripped.starts_with("mailto:")
                || stripped.starts_with("javascript:")
            {
                continue;
            }
            let reference = format!("/{}", trimmed_path(stripped));
            if !out.contains(&reference) {
                out.push(reference);
            }
            if out.len() >= MAX_REFS * 2 {
                return out;
            }
        }
    }
    out
}

/// URL-path clean-up: a leading `./` or `../` run folded against the root,
/// backslashes normalised, so `{url}/style.css` is the URL the browser would
/// actually request.
fn trimmed_path(value: &str) -> String {
    let normalised = value.replace('\\', "/");
    let mut parts: Vec<&str> = Vec::new();
    for segment in normalised.split('/') {
        match segment {
            "" | "." => continue,
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    parts.join("/")
}

/// Renders `url` to a PNG with a discovered Chromium, job-contained like
/// every process the app launches. Returns the PNG bytes.
fn render(url: &str) -> Result<Vec<u8>, String> {
    let browser = find_chromium().ok_or(
        "no Chromium (Chrome or Edge) was found on this machine to render the page with".to_string(),
    )?;
    // Unique per call, not per process. Two chats can be checking two pages at
    // once — the app runs concurrent chats by design — and on one shared name the
    // second call's `remove_file` deleted the first call's screenshot before it
    // was read, or the first call read the second call's image and the model was
    // shown a page it had not asked about. Chromium is worse about the profile:
    // it will not start on a directory another instance holds, and the winner's
    // `remove_dir_all` pulls it out from under the loser mid-render.
    let key = format!("{}-{}", std::process::id(), new_id("shot"));
    let shot = std::env::temp_dir().join(format!("sovereign-checkpage-{key}.png"));
    let profile = std::env::temp_dir().join(format!("sovereign-checkpage-profile-{key}"));
    let _ = std::fs::remove_file(&shot);

    let mut cmd = Command::new(&browser);
    cmd.args([
        "--headless=new",
        "--disable-gpu",
        // A renderer for an air-gapped workbench must not chat: the same
        // quiet flags a kiosk would use, and a throwaway profile.
        "--disable-background-networking",
        "--disable-sync",
        "--disable-component-update",
        "--metrics-recording-only",
        "--no-first-run",
        "--no-default-browser-check",
        &format!("--screenshot={}", shot.display()),
        &format!("--window-size={WINDOW}"),
        "--virtual-time-budget=8000",
        &format!("--user-data-dir={}", profile.display()),
        url,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null());

    let contained = winproc::spawn_contained(cmd, JobLimits::dev_server())
        .map_err(|e| format!("the renderer could not start ({e})"))?;
    let kill = contained.killer();
    let deadline = Instant::now() + RENDER_TIMEOUT;
    let mut child = contained.child;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(250));
            }
            _ => {
                drop(child);
                (kill)();
                // The profile is this call's own, so it goes with this call.
                let _ = std::fs::remove_dir_all(&profile);
                return Err("the renderer did not finish in time and was stopped".into());
            }
        }
    }
    // Read first, then clean up on both paths: a page that produced no screenshot
    // used to leave its Chromium profile behind on every attempt.
    let bytes = std::fs::read(&shot).map_err(|e| format!("no screenshot was produced ({e})"));
    let _ = std::fs::remove_file(&shot);
    let _ = std::fs::remove_dir_all(&profile);
    let bytes = bytes?;
    if bytes.len() < 200 {
        return Err("the screenshot came back empty".into());
    }
    Ok(bytes)
}

/// The first render-capable Chromium on this machine, in preference order.
/// Edge and Chrome are the same engine the app's own webviews run on, so the
/// screenshot is what the operator's browser shows to within a version.
fn find_chromium() -> Option<PathBuf> {
    const CANDIDATES: &[&str] = &[
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    ];
    CANDIDATES.iter().map(Path::new).find(|p| p.is_file()).map(Path::to_path_buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_references_are_relative_paths_only() {
        let html = r##"<html><head>
            <link rel="stylesheet" href="style.css">
            <script src="/app.js"></script>
            <script src="https://cdn.example.com/lib.js"></script>
            <img src="./images/pump.png?v=2">
            <img src="data:image/png;base64,xx">
            <a href="#top">Top</a>
            <a href="mailto:x@y.z">Mail</a>
            </head><body src='broken.svg'></body></html>"##;
        // The scan is per-attribute (every `src`, then every `href`), so the
        // order is attribute order, not document order.
        assert_eq!(
            local_references(html),
            vec!["/app.js".to_string(), "/images/pump.png".to_string(), "/broken.svg".to_string(), "/style.css".to_string()]
        );
    }

    #[test]
    fn a_missing_title_is_reported_and_error_bodies_are_named() {
        assert_eq!(extract_title("<head><title>  </title></head>"), None);
        assert_eq!(extract_title("<HEAD><TITLE>Pump room</TITLE></HEAD>").as_deref(), Some("Pump room"));
        assert_eq!(error_markers("Cannot GET /"), vec!["Cannot GET".to_string()]);
        assert!(error_markers("<h1>Welcome</h1>").is_empty());
    }

    /// The markers are found in a lowercased copy and the value is cut out of the
    /// original, so the two must have identical byte offsets. Full Unicode
    /// lowercasing does not: `\u{130}` folds to two chars and shifted every offset
    /// after it, which cut the title in the wrong place and panicked when the
    /// shift landed inside a character.
    #[test]
    fn a_title_survives_letters_that_change_length_when_lowercased() {
        assert_eq!(
            extract_title("<html><head><title>\u{130}zmir Pump Room</title></head></html>").as_deref(),
            Some("\u{130}zmir Pump Room")
        );
        // The shifting letter ahead of the tag, which is where it moved the
        // offsets of everything that mattered.
        assert_eq!(
            extract_title("<html><body>\u{130}\u{130}\u{130}</body><head><title>Plan</title></head></html>")
                .as_deref(),
            Some("Plan")
        );
        assert_eq!(
            local_references("<p>\u{130}\u{130}</p><script src=\"/app.js\"></script>"),
            vec!["/app.js".to_string()]
        );
    }

    #[test]
    fn dot_segments_fold_against_the_root() {
        assert_eq!(trimmed_path("./a/../b/c.css"), "b/c.css");
        assert_eq!(trimmed_path("..\\/assets\\app.js"), "assets/app.js");
    }
}

//! Legacy web integration, subject to the sovereign HTTP guard.
//!
//! The rest of the core still goes through `AppState::classify_url`, which
//! refuses public hosts. This module must pass the same guard before sending;
//! public requests are refused even when a legacy setting enabled an integration.
//! The retained parser implementation combines independent, keyless
//! sources; provider mode reads a key from a named environment
//! variable. `fetch` reads one public page the operator or a search result
//! pointed at, so a lookup whose engines fail can still read the source
//! directly instead of stopping.

use std::collections::{HashSet, VecDeque};
use std::sync::Arc;

use reqwest::{RequestBuilder, Url};
use serde_json::{json, Value};

use crate::error::{CoreError, CoreResult};
use crate::state::AppState;
use crate::types::{WebSearchMode, WebSearchProvider};

const MAX_RESPONSE: usize = 2 * 1024 * 1024;
const USER_AGENT: &str = "Servergen-AI/0.1 local web search";

#[derive(Debug, Clone)]
struct SearchHit {
    title: String,
    url: String,
    snippet: String,
    source: &'static str,
}

pub async fn search(st: &Arc<AppState>, query: &str, limit: usize) -> CoreResult<String> {
    let settings = st.settings();
    if settings.web_search_mode == WebSearchMode::Disabled {
        return Err(CoreError::Denied(
            "Web search is disabled in Settings → Tools.".into(),
        ));
    }
    let limit = limit.clamp(1, 10);
    match settings.web_search_mode {
        WebSearchMode::Disabled => unreachable!(),
        WebSearchMode::Direct => search_direct(st, query, limit).await,
        WebSearchMode::Provider => {
            search_provider(st, query, limit, settings.web_search_provider, &settings.web_search_api_key_env).await
        }
    }
}

/// Fetches one public page and returns its readable text.
///
/// This is the second half of the fallback the operator opted into with the
/// web-tools setting: `search` asks engines for candidate pages, and a run that
/// comes back holding a URL — a search hit worth reading, a source an engine's
/// snippet cut short, or a page the operator named — reads it here rather than
/// reporting it unread. An engine that answers with nothing usable is not the
/// end of the lookup; it is the pointer at the next thing to try.
pub async fn fetch(st: &Arc<AppState>, url: &str) -> CoreResult<String> {
    let settings = st.settings();
    if settings.web_search_mode == WebSearchMode::Disabled {
        return Err(CoreError::Denied(
            "Web tools are disabled in Settings → Tools.".into(),
        ));
    }
    let url = normalise_public_url(url)?;
    let (bytes, content_type) =
        response_with_type(st, st.http.get(url.as_str()), "the page").await?;

    let body = if content_type.contains("html") {
        let html = String::from_utf8_lossy(&bytes);
        let (title, text) = html_to_text(&html);
        if text.is_empty() {
            return Err(CoreError::ExecutionFailed(
                "That page returned HTML with no readable text, perhaps because it renders \
                 everything with script. Try another page."
                    .into(),
            ));
        }
        format!("Title: {title}\n\n{text}")
    } else if content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.contains("rss")
        || content_type.contains("atom")
    {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        return Err(CoreError::ExecutionFailed(format!(
            "That page returned '{content_type}', which is not readable text. Only pages, \
             feeds and plain text can be fetched."
        )));
    };
    Ok(format!("Fetched {}\n\n{body}", url.as_str()))
}

/// Accepts only absolute http(s) URLs to public hosts.
///
/// `classify_url` is not used here because it refuses public destinations —
/// this module is the deliberate exception — so the check is the mirror image:
/// a fetch may not name loopback, a literal private address, or a non-web
/// scheme. A search engine hands back public links, and the operator names
/// public sites; anything else arriving here is a mistake or a probe.
fn normalise_public_url(raw: &str) -> CoreResult<Url> {
    let url = Url::parse(raw).map_err(|error| {
        CoreError::ExecutionFailed(format!("'{raw}' is not a valid URL: {error}"))
    })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CoreError::ExecutionFailed(format!(
            "Only http and https pages can be fetched, not '{}'.",
            url.scheme()
        )));
    }
    let Some(host) = url
        .host_str()
        .map(|h| h.trim_start_matches('[').trim_end_matches(']'))
        .map(str::to_ascii_lowercase)
    else {
        return Err(CoreError::ExecutionFailed(
            "That URL names no host to fetch from.".into(),
        ));
    };
    // Loopback is named separately only so the refusal can point at the right
    // tool. A model that has just started a preview and wants to look at it
    // reaches for web_fetch, gets refused, and — observed — spends the rest of
    // the run retrying the same URL through the same tool. The policy does not
    // bend; the sentence says where to go instead.
    let loopback = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .map(|ip| ip.is_loopback())
            .unwrap_or(false);
    let refused = if host == "localhost" {
        true
    } else if let Ok(ip) = host.parse::<std::net::IpAddr>() {
        match ip {
            std::net::IpAddr::V4(v4) => {
                v4.is_loopback()
                    || v4.is_private()
                    || v4.is_link_local()
                    || v4.is_unspecified()
                    || v4.is_broadcast()
                    || v4.is_documentation()
            }
            std::net::IpAddr::V6(v6) => {
                v6.is_loopback()
                    || v6.is_unspecified()
                    // Unique-local fc00::/7 and link-local fe80::/10.
                    || (v6.segments()[0] & 0xfe00) == 0xfc00
                    || (v6.segments()[0] & 0xffc0) == 0xfe80
            }
        }
    } else {
        false
    };
    if refused {
        let instead = if loopback {
            " A page on this machine is checked with check_page, which fetches it, renders it in \
a real browser and reports what is actually on it — use that instead of this tool."
        } else {
            ""
        };
        return Err(CoreError::ExecutionFailed(format!(
            "Refused to fetch '{host}'. The web tools read public pages only, never anything \
             on this machine or its local network.{instead}"
        )));
    }
    Ok(url)
}

/// Removes whole blocks whose contents are never prose: script, style, and
/// friends. Case-insensitive on the tag name, and `to_ascii_lowercase` keeps
/// byte offsets identical to the original, which is what makes the indices
/// found on the lowered copy safe to slice the original with.
fn strip_tag_blocks(html: &str, tags: &[&str]) -> String {
    let lower = html.to_ascii_lowercase();
    let mut out = String::with_capacity(html.len());
    let mut i = 0usize;
    while i < html.len() {
        let Some(open) = lower[i..].find('<').map(|p| i + p) else {
            out.push_str(&html[i..]);
            break;
        };
        let after = &lower[open + 1..];
        let matched = tags.iter().find(|tag| {
            after.starts_with(*tag)
                && after[tag.len()..]
                    .chars()
                    .next()
                    .is_none_or(|c| c == ' ' || c == '>' || c == '/' || c == '\t' || c == '\n' || c == '\r')
        });
        match matched {
            Some(tag) => {
                out.push_str(&html[i..open]);
                let close = format!("</{tag}>");
                match lower[open..].find(&close) {
                    Some(p) => i = open + p + close.len(),
                    // Unterminated: drop the rest rather than push script
                    // contents as if they were prose.
                    None => i = html.len(),
                }
            }
            None => {
                out.push_str(&html[i..open + 1]);
                i = open + 1;
            }
        }
    }
    out
}

/// HTML to readable text: a title, and the body with tags gone, entities
/// decoded and blank lines collapsed. Structure survives only where it carries
/// meaning — one line per block element, a space per table cell — because that
/// is what keeps a table or a list legible to the model without the markup.
fn html_to_text(html: &str) -> (String, String) {
    let title = xml_field(html, "title")
        .map(clean_xml_text)
        .unwrap_or_else(|| "Untitled".into());
    let cleaned = strip_tag_blocks(html, &["script", "style", "noscript", "template", "svg"]);
    let mut out = String::with_capacity(cleaned.len());
    let mut tag = String::new();
    let mut in_tag = false;
    for ch in cleaned.chars() {
        match ch {
            '<' => {
                in_tag = true;
                tag.clear();
            }
            '>' => {
                in_tag = false;
                let name = tag.trim().trim_start_matches('/').to_ascii_lowercase();
                match name.as_str() {
                    "br" => out.push('\n'),
                    "td" | "th" => out.push(' '),
                    "p" | "div" | "li" | "tr" | "section" | "article" | "blockquote" | "pre"
                    | "table" | "ul" | "ol" | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                        out.push('\n')
                    }
                    _ => {}
                }
            }
            _ if in_tag => tag.push(ch),
            _ => out.push(ch),
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">");
    let lines = decoded
        .lines()
        // Whitespace inside a line carries no meaning once the markup is gone,
        // and consecutive table cells each add their own separator.
        .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|line| !line.is_empty())
        .collect::<Vec<_>>();
    (title, lines.join("\n"))
}

async fn response_bytes(
    st: &Arc<AppState>,
    request: RequestBuilder,
    provider: &str,
) -> CoreResult<Vec<u8>> {
    response_with_type(st, request, provider)
        .await
        .map(|(bytes, _)| bytes)
}

/// The one request path shared by every public call this module makes: applied
/// headers, byte accounting, and the same refusal of oversized responses.
async fn response_with_type(
    st: &Arc<AppState>,
    request: RequestBuilder,
    provider: &str,
) -> CoreResult<(Vec<u8>, String)> {
    // Legacy web tools must pass the sovereign boundary too. Building a request
    // performs no I/O; public hosts are refused before send or DNS resolution.
    let prepared = request.try_clone().ok_or_else(|| CoreError::Denied("Cannot inspect this request safely.".into()))?.build()?;
    st.classify_url(prepared.url().as_str())?;
    let response = request.header("User-Agent", USER_AGENT).send().await?;
    let status = response.status();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = response.bytes().await?;
    // Count every completed public response, including a provider error that
    // causes a fallback. Those bytes still crossed the workstation boundary.
    st.count_public_request(bytes.len() as u64);
    if !status.is_success() {
        return Err(CoreError::ExecutionFailed(format!(
            "{provider} returned HTTP {status}; no search result was used."
        )));
    }
    if bytes.len() > MAX_RESPONSE {
        return Err(CoreError::ExecutionFailed(format!(
            "{provider} returned more than 2 MiB, so the response was refused."
        )));
    }
    Ok((bytes.to_vec(), content_type))
}

async fn search_direct(st: &Arc<AppState>, query: &str, limit: usize) -> CoreResult<String> {
    let mut failures = Vec::new();
    let mut sources: Vec<VecDeque<SearchHit>> = Vec::new();

    let mut duck_url = Url::parse("https://html.duckduckgo.com/html/")
        .map_err(|error| CoreError::ExecutionFailed(error.to_string()))?;
    duck_url.query_pairs_mut().append_pair("q", query);
    match response_bytes(st, st.http.get(duck_url), "DuckDuckGo").await
        .and_then(|bytes| parse_duckduckgo_hits(&String::from_utf8_lossy(&bytes), limit))
    {
        Ok(results) => sources.push(results.into()),
        Err(error) => failures.push(format!("DuckDuckGo: {}", error.message())),
    }

    // Do not stop at the first non-empty engine. A valid response can still be
    // poorly ranked for the operator's question, which made direct mode look
    // successful while giving the model no usable evidence.
    let mut bing_url = Url::parse("https://www.bing.com/search")
        .map_err(|error| CoreError::ExecutionFailed(error.to_string()))?;
    bing_url
        .query_pairs_mut()
        .append_pair("q", query)
        .append_pair("format", "rss")
        .append_pair("setlang", "en-US");
    match response_bytes(st, st.http.get(bing_url), "Bing").await
        .and_then(|bytes| parse_bing_rss_hits(&String::from_utf8_lossy(&bytes), limit))
    {
        Ok(results) => sources.push(results.into()),
        Err(error) => failures.push(format!("Bing: {}", error.message())),
    }

    // News RSS adds dated launch announcements and current reporting without
    // scraping a browser-only result page or giving a third party an API key.
    let mut news_url = Url::parse("https://news.google.com/rss/search")
        .map_err(|error| CoreError::ExecutionFailed(error.to_string()))?;
    news_url
        .query_pairs_mut()
        .append_pair("q", query)
        .append_pair("hl", "en-US")
        .append_pair("gl", "US")
        .append_pair("ceid", "US:en");
    match response_bytes(st, st.http.get(news_url), "Google News").await
        .and_then(|bytes| parse_google_news_rss(&String::from_utf8_lossy(&bytes), limit))
    {
        Ok(results) => sources.push(results.into()),
        Err(error) => failures.push(format!("Google News: {}", error.message())),
    }

    // Wikipedia is narrower than a general engine, but its structured API is
    // useful for stable reference pages and is independent of both engines.
    let mut wiki_url = Url::parse("https://en.wikipedia.org/w/api.php")
        .map_err(|error| CoreError::ExecutionFailed(error.to_string()))?;
    wiki_url
        .query_pairs_mut()
        .append_pair("action", "query")
        .append_pair("list", "search")
        .append_pair("format", "json")
        .append_pair("utf8", "1")
        .append_pair("srsearch", query)
        .append_pair("srlimit", &limit.to_string());
    match response_bytes(st, st.http.get(wiki_url), "Wikipedia").await
        .and_then(|bytes| {
            let value: Value = serde_json::from_slice(&bytes)?;
            parse_wikipedia_hits(&value, limit)
        })
    {
        Ok(results) => sources.push(results.into()),
        Err(error) => failures.push(format!("Wikipedia: {}", error.message())),
    }

    let results = merge_results(sources, limit);
    if results.is_empty() {
        Err(CoreError::ExecutionFailed(format!(
            "Every direct search source failed. {}",
            failures.join(" ")
        )))
    } else {
        Ok(render_hits(&results))
    }
}

async fn search_provider(
    st: &Arc<AppState>,
    query: &str,
    limit: usize,
    provider: WebSearchProvider,
    key_name: &str,
) -> CoreResult<String> {
    let key_name = key_name.trim();
    if key_name.is_empty() {
        return Err(CoreError::Denied(
            "The selected web-search provider needs an API-key environment variable name."
                .into(),
        ));
    }
    let key = std::env::var(key_name).map_err(|_| {
        CoreError::Denied(format!(
            "Environment variable '{key_name}' is not set, so no provider request was made."
        ))
    })?;

    match provider {
        WebSearchProvider::Brave => {
            let mut url = Url::parse("https://api.search.brave.com/res/v1/web/search")
                .map_err(|error| CoreError::ExecutionFailed(error.to_string()))?;
            url.query_pairs_mut()
                .append_pair("q", query)
                .append_pair("count", &limit.to_string());
            let bytes = response_bytes(
                st,
                st.http
                    .get(url)
                    .header("Accept", "application/json")
                    .header("X-Subscription-Token", key),
                "Brave Search",
            )
            .await?;
            let value: Value = serde_json::from_slice(&bytes)?;
            parse_brave(&value, limit).map(|results| with_source("Brave Search", results))
        }
        WebSearchProvider::Tavily => {
            let bytes = response_bytes(
                st,
                st.http.post("https://api.tavily.com/search").json(&json!({
                    "api_key": key,
                    "query": query,
                    "max_results": limit,
                    "search_depth": "basic"
                })),
                "Tavily",
            )
            .await?;
            let value: Value = serde_json::from_slice(&bytes)?;
            parse_tavily(&value, limit).map(|results| with_source("Tavily", results))
        }
    }
}

fn with_source(source: &str, results: String) -> String {
    format!("Search source: {source}\n\n{results}")
}

fn result_key(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn merge_results(mut sources: Vec<VecDeque<SearchHit>>, limit: usize) -> Vec<SearchHit> {
    let mut merged = Vec::new();
    let mut seen_urls = HashSet::new();
    let mut seen_titles = HashSet::new();

    while merged.len() < limit {
        let mut inspected = false;
        for source in &mut sources {
            let Some(hit) = source.pop_front() else { continue };
            inspected = true;
            let url_key = result_key(hit.url.trim_end_matches('/'));
            let title_key = result_key(&hit.title);
            if url_key.is_empty() || title_key.is_empty() {
                continue;
            }
            if seen_urls.insert(url_key) && seen_titles.insert(title_key) {
                merged.push(hit);
                if merged.len() == limit {
                    break;
                }
            }
        }
        if !inspected {
            break;
        }
    }
    merged
}

fn render_hits(results: &[SearchHit]) -> String {
    let mut source_names = Vec::new();
    for hit in results {
        if !source_names.contains(&hit.source) {
            source_names.push(hit.source);
        }
    }
    let sources = source_names.join(", ");
    let rows = results
        .iter()
        .enumerate()
        .map(|(index, hit)| {
            let snippet = if hit.snippet.is_empty() {
                String::new()
            } else {
                format!("\n{}", hit.snippet)
            };
            format!(
                "{}. {}\n{}{}\nSource: {}",
                index + 1,
                hit.title,
                hit.url,
                snippet,
                hit.source
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    format!("Combined search sources: {sources}\n\n{rows}")
}

fn clean_html(value: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for ch in value.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(ch),
            _ => {}
        }
    }
    out.replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn duckduckgo_target(href: &str) -> String {
    let candidate = if href.starts_with("//") {
        format!("https:{href}")
    } else {
        href.to_string()
    };
    if let Ok(url) = Url::parse(&candidate) {
        if let Some((_, target)) = url.query_pairs().find(|(name, _)| name == "uddg") {
            return target.into_owned();
        }
    }
    candidate
}

fn parse_duckduckgo_hits(html: &str, limit: usize) -> CoreResult<Vec<SearchHit>> {
    let mut results = Vec::new();
    let mut rest = html;
    while results.len() < limit {
        let Some(at) = rest.find("class=\"result__a\"") else { break };
        rest = &rest[at..];
        let Some(href_at) = rest.find("href=\"") else { break };
        let href_rest = &rest[href_at + 6..];
        let Some(href_end) = href_rest.find('"') else { break };
        let href = &href_rest[..href_end];
        let Some(text_start) = href_rest[href_end..].find('>') else { break };
        let text_rest = &href_rest[href_end + text_start + 1..];
        let Some(text_end) = text_rest.find("</a>") else { break };
        let after_title = &text_rest[text_end + 4..];
        let next_result = after_title.find("class=\"result__a\"").unwrap_or(after_title.len());
        let result_tail = &after_title[..next_result];
        let snippet = result_tail
            .find("class=\"result__snippet\"")
            .and_then(|at| {
                let tagged = &result_tail[at..];
                let content_start = tagged.find('>')? + 1;
                let content = &tagged[content_start..];
                let end = content
                    .find("</a>")
                    .or_else(|| content.find("</div>"))
                    .or_else(|| content.find("</span>"))?;
                let cleaned = clean_html(&content[..end]);
                (!cleaned.is_empty()).then_some(cleaned)
            });
        results.push(SearchHit {
            title: clean_html(&text_rest[..text_end]),
            url: duckduckgo_target(href),
            snippet: snippet.unwrap_or_default(),
            source: "DuckDuckGo",
        });
        rest = after_title;
    }
    if results.is_empty() {
        Err(CoreError::ExecutionFailed(
            "DuckDuckGo returned no readable search results.".into(),
        ))
    } else {
        Ok(results)
    }
}

fn xml_field<'a>(item: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}");
    let close = format!("</{name}>");
    let tag_start = item.find(&open)?;
    let after_name = &item[tag_start + open.len()..];
    if !after_name.starts_with('>')
        && !after_name.starts_with(' ')
        && !after_name.starts_with('\t')
    {
        return None;
    }
    let start = tag_start + open.len() + after_name.find('>')? + 1;
    let end = item[start..].find(&close)? + start;
    Some(item[start..end].trim())
}

fn clean_xml_text(value: &str) -> String {
    let value = value
        .strip_prefix("<![CDATA[")
        .and_then(|value| value.strip_suffix("]]>") )
        .unwrap_or(value);
    clean_html(value)
}

fn parse_bing_rss_hits(xml: &str, limit: usize) -> CoreResult<Vec<SearchHit>> {
    let mut results = Vec::new();
    let mut rest = xml;
    while results.len() < limit {
        let Some(start) = rest.find("<item>") else { break };
        rest = &rest[start + "<item>".len()..];
        let Some(end) = rest.find("</item>") else { break };
        let item = &rest[..end];
        rest = &rest[end + "</item>".len()..];

        let title = xml_field(item, "title").map(clean_xml_text).unwrap_or_default();
        let url = xml_field(item, "link").map(clean_xml_text).unwrap_or_default();
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let snippet = xml_field(item, "description")
            .map(clean_xml_text)
            .unwrap_or_default();
        results.push(SearchHit {
            title,
            url,
            snippet,
            source: "Bing",
        });
    }
    if results.is_empty() {
        Err(CoreError::ExecutionFailed(
            "Bing returned no readable RSS search results.".into(),
        ))
    } else {
        Ok(results)
    }
}

fn parse_google_news_rss(xml: &str, limit: usize) -> CoreResult<Vec<SearchHit>> {
    let mut results = Vec::new();
    let mut rest = xml;
    while results.len() < limit {
        let Some(start) = rest.find("<item>") else { break };
        rest = &rest[start + "<item>".len()..];
        let Some(end) = rest.find("</item>") else { break };
        let item = &rest[..end];
        rest = &rest[end + "</item>".len()..];

        let title = xml_field(item, "title").map(clean_xml_text).unwrap_or_default();
        let url = xml_field(item, "link").map(clean_xml_text).unwrap_or_default();
        if title.is_empty() || url.is_empty() {
            continue;
        }
        let publisher = xml_field(item, "source")
            .map(clean_xml_text)
            .unwrap_or_default();
        let published = xml_field(item, "pubDate")
            .map(clean_xml_text)
            .unwrap_or_default();
        let description = xml_field(item, "description")
            .map(clean_xml_text)
            .unwrap_or_default();
        let details = [publisher, published, description]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ");
        results.push(SearchHit {
            title,
            url,
            snippet: details,
            source: "Google News",
        });
    }
    if results.is_empty() {
        Err(CoreError::ExecutionFailed(
            "Google News returned no readable RSS search results.".into(),
        ))
    } else {
        Ok(results)
    }
}

fn parse_wikipedia_hits(value: &Value, limit: usize) -> CoreResult<Vec<SearchHit>> {
    let rows = value
        .pointer("/query/search")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            CoreError::ExecutionFailed(
                "Wikipedia's response did not contain a search result list.".into(),
            )
        })?;
    let rendered = rows
        .iter()
        .take(limit)
        .filter_map(|row| {
            let title = row.get("title").and_then(Value::as_str)?;
            let page_id = row.get("pageid").and_then(Value::as_u64)?;
            let snippet = row
                .get("snippet")
                .and_then(Value::as_str)
                .map(clean_html)
                .unwrap_or_default();
            Some(SearchHit {
                title: title.to_string(),
                url: format!("https://en.wikipedia.org/?curid={page_id}"),
                snippet,
                source: "Wikipedia",
            })
        })
        .collect::<Vec<_>>();
    if rendered.is_empty() {
        Err(CoreError::ExecutionFailed(
            "Wikipedia returned no search results.".into(),
        ))
    } else {
        Ok(rendered)
    }
}

fn parse_brave(value: &Value, limit: usize) -> CoreResult<String> {
    format_json_results(value.pointer("/web/results"), limit)
}

fn parse_tavily(value: &Value, limit: usize) -> CoreResult<String> {
    format_json_results(value.get("results"), limit)
}

fn format_json_results(results: Option<&Value>, limit: usize) -> CoreResult<String> {
    let rows = results.and_then(Value::as_array).ok_or_else(|| {
        CoreError::ExecutionFailed("The search provider response did not contain a result list.".into())
    })?;
    let rendered = rows
        .iter()
        .take(limit)
        .enumerate()
        .map(|(index, row)| {
            let title = row.get("title").and_then(Value::as_str).unwrap_or("Untitled");
            let url = row.get("url").and_then(Value::as_str).unwrap_or_default();
            let snippet = row
                .get("description")
                .or_else(|| row.get("content"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("{}. {title}\n{url}\n{snippet}", index + 1)
        })
        .collect::<Vec<_>>();
    if rendered.is_empty() {
        Err(CoreError::ExecutionFailed("The search returned no results.".into()))
    } else {
        Ok(rendered.join("\n\n"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A refusal that leaves the model with nowhere to go is how one run spent
    /// three tool calls re-fetching the same dead preview URL. The loopback
    /// refusal names check_page; the private-network one has nothing to offer
    /// and says nothing.
    #[test]
    fn the_loopback_refusal_names_the_tool_that_does_the_job() {
        let why = normalise_public_url("http://127.0.0.1:49386/").unwrap_err().to_string();
        assert!(why.contains("check_page"), "{why}");
        let lan = normalise_public_url("http://192.168.1.14/").unwrap_err().to_string();
        assert!(!lan.contains("check_page"), "{lan}");
    }

    #[test]
    fn direct_results_are_reduced_to_titles_and_links() {
        let html = r#"<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">One &amp; Two</a><a class="result__snippet">Useful <b>current</b> information</a>"#;
        let hits = parse_duckduckgo_hits(html, 5).expect("result should parse");
        let result = render_hits(&hits);
        assert!(result.contains("One & Two"));
        assert!(result.contains("https://example.com/a"));
        assert!(result.contains("Useful current information"));
        assert!(!result.contains("duckduckgo.com/l/"));
    }

    #[test]
    fn bing_rss_results_are_reduced_to_readable_sources() {
        let xml = r#"<rss><channel><item><title>One &amp; Two</title><link>https://example.com/a</link><description><![CDATA[Useful <b>result</b>]]></description></item></channel></rss>"#;
        let hits = parse_bing_rss_hits(xml, 5).expect("result should parse");
        let result = render_hits(&hits);
        assert!(result.contains("One & Two"));
        assert!(result.contains("https://example.com/a"));
        assert!(result.contains("Useful result"));
    }

    #[test]
    fn wikipedia_results_keep_stable_page_urls() {
        let value = json!({ "query": { "search": [{
            "pageid": 42,
            "title": "A source",
            "snippet": "A <span>short</span> result"
        }] } });
        let hits = parse_wikipedia_hits(&value, 3).expect("result should parse");
        let result = render_hits(&hits);
        assert!(result.contains("https://en.wikipedia.org/?curid=42"));
        assert!(result.contains("A short result"));
    }

    #[test]
    fn news_results_include_publisher_and_publication_date() {
        let xml = r#"<rss><channel><item><title>Product launches</title><link>https://news.google.com/articles/1</link><pubDate>Tue, 02 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[A dated <b>announcement</b>]]></description><source url="https://example.com">Example News</source></item></channel></rss>"#;
        let hits = parse_google_news_rss(xml, 5).expect("result should parse");
        let result = render_hits(&hits);
        assert!(result.contains("Example News"));
        assert!(result.contains("02 Sep 2026"));
        assert!(result.contains("A dated announcement"));
    }

    #[test]
    fn direct_results_are_round_robin_ranked_and_deduplicated() {
        let hit = |title: &str, url: &str, source: &'static str| SearchHit {
            title: title.into(),
            url: url.into(),
            snippet: String::new(),
            source,
        };
        let sources = vec![
            VecDeque::from(vec![
                hit("Shared result", "https://example.com/shared", "DuckDuckGo"),
                hit("Duck second", "https://example.com/duck", "DuckDuckGo"),
            ]),
            VecDeque::from(vec![
                hit("Shared result", "https://example.com/shared", "Bing"),
                hit("Bing second", "https://example.com/bing", "Bing"),
            ]),
        ];
        let results = merge_results(sources, 3);
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].title, "Shared result");
        assert_eq!(results[1].title, "Duck second");
        assert_eq!(results[2].title, "Bing second");
    }

    #[test]
    fn provider_results_keep_their_source_url() {
        let value = json!({ "results": [{
            "title": "Source",
            "url": "https://example.com/source",
            "content": "A short result"
        }] });
        let result = parse_tavily(&value, 3).expect("provider result should parse");
        assert!(result.contains("https://example.com/source"));
        assert!(result.contains("A short result"));
    }

    #[test]
    fn fetched_pages_are_reduced_to_readable_text() {
        let html = "<html><head><title>Specs &amp; Dates</title>\
             <style>body{display:none}</style>\
             <script>tracking(\"hidden\");</script></head>\
             <body><h1>Release</h1><p>Launched <b>June 5, 2025</b> &amp; priced at $699.</p>\
             <script>more_tracking()</script>\
             <table><tr><td>Chip</td><td>8 Elite</td></tr></table></body></html>";
        let (title, text) = html_to_text(html);
        assert_eq!(title, "Specs & Dates");
        assert!(text.contains("Release"));
        assert!(text.contains("Launched June 5, 2025 & priced at $699."));
        assert!(text.contains("Chip 8 Elite"));
        assert!(!text.contains("tracking"));
        assert!(!text.contains("display:none"));
        // One line per block, no blank ones.
        assert!(text.lines().all(|line| !line.trim().is_empty()));
    }

    #[test]
    fn unterminated_script_blocks_drop_the_rest_of_the_page() {
        let html = "<p>Readable</p><script>var x = 1;";
        let (_, text) = html_to_text(html);
        assert_eq!(text, "Readable");
    }

    #[test]
    fn fetch_accepts_only_public_http_pages() {
        assert!(normalise_public_url("https://example.com/page?a=1").is_ok());
        assert!(normalise_public_url("http://example.com/").is_ok());
        assert!(normalise_public_url("https://www.gsmarena.com/oneplus_pad_3-13864.php").is_ok());
        // This machine and its LAN are not public pages.
        assert!(normalise_public_url("http://localhost:8080/admin").is_err());
        assert!(normalise_public_url("http://127.0.0.1:3928/api/invoke").is_err());
        assert!(normalise_public_url("http://192.168.1.1/router").is_err());
        assert!(normalise_public_url("http://10.0.0.5/internal").is_err());
        assert!(normalise_public_url("http://[::1]/").is_err());
        assert!(normalise_public_url("http://[fe80::1]/").is_err());
        // The cloud metadata endpoint and the unspecified address are both
        // "this machine" by another spelling.
        assert!(normalise_public_url("http://169.254.169.254/latest/meta-data/").is_err());
        assert!(normalise_public_url("http://0.0.0.0/").is_err());
        // Not web schemes, and not URLs at all.
        assert!(normalise_public_url("file:///C:/sovereign/secret.txt").is_err());
        assert!(normalise_public_url("ftp://example.com/doc").is_err());
        assert!(normalise_public_url("example.com/page").is_err());
        assert!(normalise_public_url("").is_err());
    }
}

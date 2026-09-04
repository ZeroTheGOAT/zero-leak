//! §1 / §3 — the model catalogue, the routing table and the tool catalogue.
//!
//! The catalogue is **data, not logic**. On first run the built-in seed below is
//! written to `<config>/models.json`; from then on the file on disk is the
//! authority. Adding, removing, re-quantising or re-prioritising a model is a
//! text edit — no code change, no rebuild, no `match` statement anywhere in the
//! core that names a specific model.
//!
//! Paths in the catalogue use the token `${MODELS_ROOT}`, expanded at load time
//! against `settings.models_directory`. That is why moving the weights is a
//! settings change rather than an edit to seven paths, and why the seed file is
//! not tied to one machine's user profile.
//!
//! Every measured number came from `llama-bench -p 512 -n 128 -r 2 -ngl 99` on
//! this workstation. Nothing here is estimated.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{CoreError, CoreResult};
use crate::types::*;

/// The card this catalogue was measured on: 8187 MiB installed, of which the
/// desktop compositor holds roughly a gigabyte, leaving ~7106 MiB actually free.
///
/// These two are the *fallbacks*. Everything that admits a model goes through
/// `vram_total_mb`, `vram_budget_mb` and `vram_solo_mb` below, which prefer what
/// `nvidia-smi` measured on the machine actually running. The same build then
/// admits correctly on hardware this catalogue was not tuned for: a 6 GiB laptop
/// refuses olmOCR-2 with a reason the operator can read instead of letting the
/// WDDM driver page it into system RAM and serve the demo at a tenth of the
/// speed. §1 — the numbers a decision is made from should be the machine's own.
pub const VRAM_BUDGET_MB: u32 = 7106;
pub const VRAM_TOTAL_MB: u32 = 8187;

/// The only address the router is ever bound to.
///
/// This was an editable setting, and the Settings panel offered it beside the
/// port while the spawn passed a hardcoded `--host 127.0.0.1` — so the field the
/// operator could type into had no effect, and the Sovereignty panel presented
/// that same ignored field as the daemon's actual bind. Both readings were wrong,
/// and the fixable half is not the code: §1 forbids the models being reachable
/// from off the machine, so a host the operator can change is a setting whose
/// only working value is this one. It is a constant, the panel states it as a
/// fact, and the port stays configurable because a port collision is real.
pub const ROUTER_BIND_HOST: &str = "127.0.0.1";

/// What the display alone needs left over: 512 MiB, which is what Windows holds
/// on this card with nothing running.
const DISPLAY_RESERVE_MB: u32 = 512;
/// What to leave when two models are meant to share the card. Larger than the
/// display reserve because a second model's KV cache grows during a request, and
/// derived from the pair above so the tuned machine reproduces 7106 exactly.
const SHARING_RESERVE_MB: u32 = VRAM_TOTAL_MB - VRAM_BUDGET_MB;

/// The card's total, measured if `nvidia-smi` has answered once this session.
///
/// The hardware poller samples every two seconds and publishes the reading;
/// `make_room` is synchronous and on the request path, so it cannot spawn
/// `nvidia-smi` itself. Before the first sample — and on a machine with no
/// `nvidia-smi` at all — this is the catalogue's figure, which is what the
/// tuning was done against.
pub fn vram_total_mb() -> u32 {
    crate::hardware::measured_vram_total_mb().unwrap_or(VRAM_TOTAL_MB)
}

/// The sharing budget: what all resident models together may occupy.
pub fn vram_budget_mb() -> u32 {
    sharing_budget(vram_total_mb())
}

/// Split out from `vram_budget_mb` so the arithmetic is testable without a card.
fn sharing_budget(total_mb: u32) -> u32 {
    total_mb.saturating_sub(SHARING_RESERVE_MB).max(1)
}

/// The most a *single* model may occupy when it is the only thing resident.
///
/// The sharing budget leaves room for a second model beside the first, and for
/// the desktop. A model that is alone on the card needs neither, and the largest
/// specialist here — olmOCR 2 at 7387 MiB, whose own catalogue note says
/// "nothing else may be resident" — sits above the sharing budget and below
/// this one.
///
/// Without the distinction that note described a configuration the code refused
/// to enter: every handwritten page and every olmOCR re-read failed admission
/// with "needs about 7387 MiB and the working budget is 7106 MiB", so the
/// Handwriting primary could not load at all.
pub fn vram_solo_mb() -> u32 {
    solo_budget(vram_total_mb())
}

/// Split out from `vram_solo_mb` so the arithmetic is testable without a card.
fn solo_budget(total_mb: u32) -> u32 {
    total_mb.saturating_sub(DISPLAY_RESERVE_MB).max(1)
}

const MODELS_ROOT_TOKEN: &str = "${MODELS_ROOT}";

/* ------------------------------------------------------------------ */
/* Routing                                                             */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TaskKind {
    Code,
    Reasoning,
    DigitalDocument,
    ScannedDocument,
    Handwriting,
    EngineeringDrawing,
    Photograph,
    LongContext,
    KnowledgeQuery,
    Embedding,
}

/// How a decision was reached. `Classifier` is last on purpose: consulting a
/// model to pick a model is the expensive path, and the brief forbids taking it
/// when a rule can decide.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RouteBasis {
    FileType,
    Rule,
    TokenBudget,
    Classifier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteRule {
    pub kind: TaskKind,
    pub label: String,
    pub basis: RouteBasis,
    /// `None` means no model at all — native extraction handles it.
    pub model_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model_id: Option<String>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteDecision {
    pub kind: TaskKind,
    pub basis: RouteBasis,
    pub model_id: Option<String>,
    pub reason: String,
}

fn rule(
    kind: TaskKind,
    label: &str,
    basis: RouteBasis,
    model_id: Option<&str>,
    fallback: Option<&str>,
    detail: &str,
) -> RouteRule {
    RouteRule {
        kind,
        label: label.into(),
        basis,
        model_id: model_id.map(str::to_string),
        fallback_model_id: fallback.map(str::to_string),
        detail: detail.into(),
    }
}

pub fn routing_rules() -> Vec<RouteRule> {
    use RouteBasis::*;
    use TaskKind::*;
    vec![
        rule(DigitalDocument, "Digital PDF / DOCX / XLSX / PPTX", FileType, None, None,
            "Native text extraction. No model is loaded and no OCR is run."),
        rule(ScannedDocument, "Scanned or photographed page", FileType, Some("paddleocr-vl-1.6"), Some("olmocr-2"),
            "Printed text with no embedded text layer. 0.87 GiB and 280 tok/s. A page it returns too thin to be a transcription is read again by olmOCR."),
        rule(Handwriting, "Handwritten notes / poor-quality scan", Rule, Some("olmocr-2"), Some("qwen3.5-9b"),
            "Chosen when the file is marked handwritten, and reached by escalation when the printed-text reader returns a page of fragments."),
        rule(EngineeringDrawing, "Engineering drawing / P&ID", Rule, Some("qwen3.5-9b"), Some("olmocr-2"),
            "Tag extraction plus vision reasoning over topology, in one pass."),
        rule(Photograph, "Equipment photograph", FileType, Some("qwen3.5-9b"), None,
            "Uses the model's own f16 projector."),
        rule(Code, "Source code", FileType, Some("nemotron-cascade-8b"), Some("qwen3.5-9b"),
            "Matched on extension against the known source-file set."),
        rule(LongContext, "Input over 14k tokens", TokenBudget, Some("nemotron-3-nano-4b"), None,
            "The 9B fits 16k; this fits 65k in the same preset and 195k at f16."),
        rule(KnowledgeQuery, "Question against indexed knowledge", Rule, Some("qwen3.5-9b"), None,
            "Retrieval first, then reasoning over the retrieved passages with citations."),
        rule(Reasoning, "General reasoning / mixed task", Classifier, Some("qwen3.5-9b"), Some("nemotron-cascade-8b"),
            "The only path that may consult a classifier, and only when rules cannot decide."),
        rule(Embedding, "Indexing / embedding", Rule, Some("bge-m3"), None,
            "Served by llama-server in embedding mode, bound to loopback."),
    ]
}

fn supports_route(model: &ModelEntry, kind: TaskKind) -> bool {
    use ModelCapability::*;
    let has = |cap| model.capabilities.contains(&cap);
    match kind {
        TaskKind::DigitalDocument => false,
        TaskKind::ScannedDocument => has(Ocr) || has(Documents),
        TaskKind::Handwriting => has(Handwriting) || has(Ocr) || has(Vision),
        TaskKind::EngineeringDrawing => has(Drawings) || has(Vision),
        TaskKind::Photograph => has(Vision),
        TaskKind::Code => has(Coding),
        TaskKind::LongContext => has(LongContext),
        TaskKind::KnowledgeQuery | TaskKind::Reasoning => has(Reasoning) || has(General),
        TaskKind::Embedding => has(Embeddings),
    }
}

/* ------------------------------------------------------------------ */
/* §7  Tool catalogue                                                  */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDescriptor {
    pub name: ToolName,
    pub label: String,
    pub risk: ToolRisk,
    pub requires_approval: bool,
    pub summary: String,
}

fn tool(name: ToolName, label: &str, risk: ToolRisk, requires_approval: bool, summary: &str) -> ToolDescriptor {
    ToolDescriptor { name, label: label.into(), risk, requires_approval, summary: summary.into() }
}

pub fn tool_catalogue() -> Vec<ToolDescriptor> {
    use ToolName::*;
    use ToolRisk::{Execute, Read, Write};
    vec![
        tool(ListFiles, "List files", Read, false, "Enumerate a directory inside an approved workspace."),
        tool(UpdatePlan, "Update plan", Read, false, "Publish or revise the run's live step plan. No disk or network effect."),
        tool(AskOperator, "Ask the operator", Read, false, "Pause and ask the operator a free-text question when the task cannot proceed without their answer."),
        tool(ReadFile, "Read file", Read, false, "Read a file inside an approved workspace."),
        tool(SearchFiles, "Search files", Read, false, "Content and filename search across a workspace."),
        tool(QueryKnowledge, "Query knowledge base", Read, false, "Hybrid retrieval over the local index, returning citations."),
        tool(OcrDocument, "OCR document", Read, false, "Extract text, tables and bounding boxes from a scan."),
        tool(AnalyzeImage, "Analyse image", Read, false, "Vision analysis of a photograph or drawing."),
        tool(CheckPage, "Check page", Read, false, "Fetch, render and visually inspect the workspace's served page to verify the build."),
        tool(ReadSpreadsheet, "Read spreadsheet", Read, false, "Read cells, formulas and sheet structure."),
        tool(AnalyzeData, "Analyse data", Read, false, "Deterministic calculation over extracted tables."),
        tool(InspectArtifact, "Inspect artifact", Read, false, "Reopen a generated file to confirm it parses."),
        tool(WebSearch, "Search the web", Read, false, "Use only the explicitly selected public search method."),
        tool(WebFetch, "Fetch web page", Read, false, "Read one public page found by search or named by the operator, behind the same Settings switch."),
        tool(McpListTools, "Inspect MCP server", Execute, true, "Launch a configured local MCP executable and list its tools."),
        tool(McpCall, "Call MCP tool", Execute, true, "Launch a configured local MCP executable and call one advertised tool."),
        tool(CreateDirectory, "Create directory", Write, true, "Create a folder inside an approved workspace."),
        tool(WriteFile, "Write file", Write, true, "Create or overwrite a file. Overwrites show a diff first."),
        tool(EditFile, "Edit file", Write, true, "Apply a reviewed diff to an existing file."),
        tool(WriteSpreadsheet, "Write spreadsheet", Write, true, "Write cells into an XLSX workbook."),
        tool(GenerateText, "Generate text file", Write, true, "Write a script, note or Markdown file into the artifacts folder."),
        tool(GenerateDocx, "Generate DOCX", Write, true, "Produce a Word document, then verify it opens."),
        tool(GenerateXlsx, "Generate XLSX", Write, true, "Produce a workbook, then verify it opens."),
        tool(GeneratePptx, "Generate PPTX", Write, true, "Produce a deck, then verify it opens."),
        tool(GeneratePdf, "Generate PDF", Write, true, "Produce a PDF, then verify page count and text."),
        tool(ExecutePython, "Run Python", Execute, true, "Run a script in the sandbox. No network, memory-capped, timed out."),
        tool(RunCommand, "Run command", Execute, true, "Run an allow-listed command in the sandbox working directory."),
        tool(ServeFolder, "Host folder", Read, false, "Serve a workspace folder on a loopback URL in the operator's browser. Read-only; loopback only."),
        tool(StartDevServer, "Start dev server", Execute, true, "Run the workspace's dev script as a persistent process and return its verified localhost URL. Outlives the run that started it."),
    ]
}

pub fn tool_by_name(name: ToolName) -> Option<ToolDescriptor> {
    tool_catalogue().into_iter().find(|t| t.name == name)
}

/* ------------------------------------------------------------------ */
/* Defaults                                                            */
/* ------------------------------------------------------------------ */

/// `C:\sovereign` on Windows: short, outside any user profile, and outside
/// anything a sync client would be configured to replicate. Installations can
/// relocate the complete harness with `SOVEREIGN_HOME`; every subsystem derives
/// its paths from this one root.
pub fn sovereign_root() -> PathBuf {
    std::env::var_os("SOVEREIGN_HOME")
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:/sovereign"))
}

pub fn config_dir() -> PathBuf {
    sovereign_root().join("config")
}

pub fn default_sandbox_policy() -> SandboxPolicy {
    SandboxPolicy {
        working_dir: sovereign_root().join("sandbox").to_string_lossy().replace('\\', "/"),
        network_enabled: false,
        // A read or a version check is done in seconds; a real build is not.
        // `cargo build`, an `npm run build` over a cold cache, a test suite —
        // these run minutes, and a timeout that kills them mid-build costs the
        // whole build. The operator sees each command's output as it streams
        // and can stop the run, so the ceiling exists for a hung process, not
        // for a slow one.
        timeout_sec: 1800,
        max_memory_mb: 4096,
        max_processes: 8,
        // Every entry has to be a real file that can be found and started. This
        // list previously carried `type` and `dir`, and neither could ever run:
        // both are built into the command interpreter, so there is no file to
        // start, and a sandbox that has no interpreter cannot reach them. `dir`
        // appeared to work on developer machines only because Git for Windows
        // installs a `dir.exe` of its own, which does something else and is
        // absent on a plant workstation. Advertising a capability the sandbox
        // does not have is worse than a short list: the operator reads the
        // policy panel to know what the agent can do.
        //
        // `tree`, `where` and `findstr` ship with Windows, so those three work
        // on any machine. The rest are the toolchains this workbench exists to
        // drive, and are refused with "allowed but not installed" when absent —
        // which is the honest answer. Browsing and printing files does not need
        // a command at all; `fs_list` and `fs_read` do it inside a workspace.
        // `npx` runs the local build tools a project carries in node_modules —
        // vite, tsc, eslint — without a global install, which is what makes
        // `build this app` a runnable request rather than a refusal.
        allowed_commands: [
                "python", "pip", "git", "node", "npm", "npx", "cargo", "findstr", "where", "tree",
            ]
            .iter().map(|s| s.to_string()).collect(),
        // Everything here either destroys data, changes machine state, or pulls
        // bytes off the network. The deny list is checked before the allow list.
        denied_commands: [
            "del", "rmdir", "rd", "rm", "Remove-Item", "format", "diskpart", "vssadmin",
            "reg", "schtasks", "sc", "net", "netsh", "bcdedit",
            "takeown", "icacls", "cipher", "wmic", "powershell -enc",
            "Invoke-WebRequest", "Invoke-Expression", "curl", "wget", "certutil",
        ].iter().map(|s| s.to_string()).collect(),
    }
}

/// Whether a candidate directory actually holds weights, rather than merely
/// existing.
///
/// The catalogue stores `<model-id>/<file>.gguf` and speech weights in `stt/`, so
/// one level down is enough to tell a populated models root from an empty one.
fn holds_weights(dir: &Path) -> bool {
    fn is_weight(path: &Path) -> bool {
        matches!(
            path.extension()
                .and_then(|e| e.to_str())
                .map(str::to_ascii_lowercase)
                .as_deref(),
            Some("gguf" | "bin" | "safetensors")
        )
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    entries.flatten().any(|entry| {
        let path = entry.path();
        is_weight(&path)
            || (path.is_dir()
                && std::fs::read_dir(&path)
                    .map(|inner| inner.flatten().any(|e| is_weight(&e.path())))
                    .unwrap_or(false))
    })
}

/// Where the weights are, if nothing has told us otherwise: a `models` folder
/// beside the sovereign root, else beside the executable, else the checked-in
/// development location.
///
/// The one that *holds weights* wins, not the first one that exists. Those came
/// apart on this very machine: `C:/sovereign/models` is part of the installed
/// layout and was created empty, so the first-existing rule pointed a fresh
/// database at an empty folder while all seven models — and the three whisper
/// weights under `stt/` — sat in the third candidate. The catalogue then loaded
/// with every path missing, which the Models panel can only report as models not
/// being installed. A directory that exists but holds nothing is still the right
/// answer when none of the candidates has weights yet, because it is the folder
/// the operator is meant to fill; it is the wrong answer when a populated one is
/// sitting behind it in the list.
pub fn detect_models_root() -> String {
    fn normalised(path: &Path) -> String {
        path.to_string_lossy().replace('\\', "/")
    }
    let candidates = [
        sovereign_root().join("models"),
        std::env::current_exe().ok()
            .and_then(|p| p.parent().map(|d| d.join("models")))
            .unwrap_or_default(),
        PathBuf::from("C:/Users/harih/OneDrive/Documents/ocr/models"),
    ];
    if let Some(c) = candidates.iter().find(|c| holds_weights(c)) {
        return normalised(c);
    }
    if let Some(c) = candidates.iter().find(|c| c.is_dir()) {
        return normalised(c);
    }
    normalised(&sovereign_root().join("models"))
}

fn detect_llama_server() -> String {
    let candidates = [
        sovereign_root().join("runtime/llama.cpp/llama-server.exe"),
        std::env::current_exe().ok()
            .and_then(|p| p.parent().map(|d| d.join("llama.cpp/llama-server.exe")))
            .unwrap_or_default(),
    ];
    for c in candidates.iter() {
        if c.is_file() {
            return c.to_string_lossy().replace('\\', "/");
        }
    }
    sovereign_root().join("runtime/llama.cpp/llama-server.exe")
        .to_string_lossy().replace('\\', "/")
}

pub fn default_settings() -> AppSettings {
    AppSettings {
        llama_server_path: detect_llama_server(),
        model_preset_path: config_dir().join("models.ini").to_string_lossy().replace('\\', "/"),
        models_directory: detect_models_root(),
        router_port: 18080,
        // Two. The byte budget in `router::make_room` is the real limit;
        // `--models-max` is the router's own count, and at 1 the router evicted
        // whatever the budget had just admitted — so the embeddings model and
        // the chat model, which fit together (1300 + 4945 MiB inside 7106),
        // thrashed against each other on every retrieval query.
        max_resident_models: 2,
        // Three idle minutes and a model gives its VRAM back, swept by
        // `router::evict_idle`. Long enough to survive a pause for thought
        // mid-conversation, short enough that a finished chat is not still
        // holding 4945 MiB when the operator drops in a scanned drawing. Zero
        // keeps every loaded model resident for the session.
        model_idle_evict_sec: 180,
        extended_thinking: false,

        allow_private_server: false,
        private_server_url: String::new(),
        private_server_name: String::new(),
        block_public_internet: true,
        // The store starts locked. It only unlocks on an explicit, audited
        // operator choice in Settings > Sovereignty.
        allow_replicated_store: false,

        web_search_mode: WebSearchMode::Disabled,
        web_search_provider: WebSearchProvider::Brave,
        web_search_api_key_env: "BRAVE_SEARCH_API_KEY".into(),
        mcp_servers: Vec::new(),

        default_mode: AgentMode::Plan,
        approval_policy: ApprovalPolicy::AskAlways,
        // No operator rules by default. The workstation's built-in guards
        // (workspace containment, the sandbox allow list) are unconditional;
        // what goes here is whatever the operator adds in Settings.
        guard_rules: Vec::new(),

        sandbox_root: sovereign_root().join("sandbox").to_string_lossy().replace('\\', "/"),
        sandbox_network: false,
        // 600 s, not 120: a real build or test suite (cargo test, npm test) runs
        // minutes, and a sandbox that kills it at two produces a partial output
        // the model will misread as a failure. Long enough to complete, still
        // short enough that a hung process ends within one coffee.
        sandbox_timeout_sec: 1800,
        sandbox_max_memory_mb: 4096,

        knowledge_root: sovereign_root().join("knowledge").to_string_lossy().replace('\\', "/"),
        watch_knowledge_folder: false,
        retrieval_top_k: 8,
        hybrid_retrieval: true,

        memory_root: sovereign_root().join("memories").to_string_lossy().replace('\\', "/"),
        use_global_memories: true,
        use_project_memories: true,
        capture_memories: true,

        artifact_root: sovereign_root().join("artifacts").to_string_lossy().replace('\\', "/"),
        verify_artifacts: true,

        show_right_panel: false,
    }
}

/* ------------------------------------------------------------------ */
/* The catalogue                                                       */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelCatalogue {
    /// Bumped only if the on-disk shape changes incompatibly.
    pub version: u32,
    pub models: Vec<ModelEntry>,
    /// Editable task-to-model choices. Older catalogues omit this field and
    /// receive the built-in defaults when loaded.
    #[serde(default)]
    pub routing: Vec<RouteRule>,
}

#[allow(clippy::too_many_arguments)]
fn entry(
    id: &str,
    display_name: &str,
    backend: ModelBackend,
    source: &str,
    projector: Option<&str>,
    architecture: &str,
    quantization: &str,
    context_size: u32,
    trained_context: u32,
    kv_cache_type: Option<&str>,
    capabilities: &[ModelCapability],
    estimated_vram_mb: u32,
    file_size_bytes: u64,
    priority: ModelPriority,
    pp: Option<f64>,
    tg: Option<f64>,
    note: Option<&str>,
) -> ModelEntry {
    ModelEntry {
        id: id.into(),
        display_name: display_name.into(),
        backend,
        location: ModelLocation::ThisDevice,
        source: format!("{MODELS_ROOT_TOKEN}/{source}"),
        projector: projector.map(|p| format!("{MODELS_ROOT_TOKEN}/{p}")),
        architecture: architecture.into(),
        quantization: quantization.into(),
        context_size,
        trained_context,
        kv_cache_type: kv_cache_type.map(str::to_string),
        capabilities: capabilities.to_vec(),
        estimated_vram_mb,
        file_size_bytes,
        priority,
        prompt_tokens_per_sec: pp,
        gen_tokens_per_sec: tg,
        note: note.map(str::to_string),
        preset_options: None,
    }
}

/// Attaches extra `llama-server` preset keys. They live here as catalogue data
/// rather than as a `match` on model id somewhere in the router, which is the
/// difference between a tunable and a hardcoded model.
fn with_opts(mut e: ModelEntry, opts: &[(&str, &str)]) -> ModelEntry {
    e.preset_options = Some(
        opts.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect(),
    );
    e
}

/// The seed. Written to disk once, then never consulted again unless the file
/// is deleted. Present in the binary only so a fresh install has something to
/// start from.
pub fn seed_catalogue() -> ModelCatalogue {
    use ModelBackend::LlamaCpp;
    use ModelCapability::*;
    use ModelPriority::*;

    ModelCatalogue {
        version: 1,
        routing: routing_rules(),
        models: vec![
            with_opts(entry("qwen3.5-9b", "Qwen3.5 9B", LlamaCpp,
                "qwen3.5-9b/Qwen_Qwen3.5-9B-Q4_K_M.gguf",
                Some("qwen3.5-9b/mmproj-Qwen_Qwen3.5-9B-f16.gguf"),
                "qwen35", "Q4_K_M", 16384, 262144, Some("q8_0"),
                &[General, Reasoning, Coding, Vision, Drawings, Documents, Tools],
                6883, 6169341984 + 918165952, Primary, Some(2011.0), Some(42.8),
                Some("Reads engineering drawings and P&IDs more accurately than the dedicated OCR models — it recovered line tag 8\"-P-2103-A2A that both OCR models misread.")),
                // llama.cpp warns at load that Qwen-VL needs at least 1024
                // image tokens for grounding tasks. Reading a tag off a P&ID is
                // a grounding task, so the floor is set rather than defaulted.
                &[("image-min-tokens", "1024")]),

            entry("nemotron-3-nano-4b", "Nemotron 3 Nano 4B", LlamaCpp,
                "nemotron-3-nano-4b/NVIDIA-Nemotron3-Nano-4B-Q4_K_M.gguf", None,
                "nemotron_h", "Q4_K_M", 131072, 1048576, Some("f16"),
                &[General, Reasoning, LongContext, Tools],
                2939, 2837072864, Primary, Some(3678.0), Some(81.3),
                Some("Hybrid Mamba/Transformer: KV cache grows sub-linearly, so it fits 195k tokens at f16 where the 9B fits 12.5k. Long-document work routes here.")),

            entry("nemotron-cascade-8b", "Nemotron Cascade 8B", LlamaCpp,
                "nemotron-cascade-8b/nvidia_Nemotron-Cascade-8B-Q4_K_M.gguf", None,
                "qwen3", "Q4_K_M", 16384, 32768, Some("q8_0"),
                &[General, Reasoning, Coding, Tools],
                4945, 5027784704, Fallback, Some(2479.0), Some(50.3), None),

            entry("olmocr-2", "olmOCR 2 (7B)", LlamaCpp,
                "olmocr-2/allenai_olmOCR-2-7B-1025-Q4_K_M.gguf",
                Some("olmocr-2/mmproj-allenai_olmOCR-2-7B-1025-f16.gguf"),
                "qwen2vl", "Q4_K_M", 16384, 128000, Some("f16"),
                &[Ocr, Handwriting, Documents, Vision],
                7387, 4683072672 + 1354163296, Specialist, Some(2633.0), Some(54.0),
                Some("Best on handwriting, and the only model that emits real HTML table markup. Peaks at 7387 MiB — at the edge of the 7106 MiB budget, so nothing else may be resident.")),

            entry("paddleocr-vl-1.6", "PaddleOCR-VL 1.6", LlamaCpp,
                "paddleocr-vl-1.6/PaddleOCR-VL-1.6-GGUF.gguf",
                Some("paddleocr-vl-1.6/PaddleOCR-VL-1.6-GGUF-mmproj.gguf"),
                "paddleocr", "Q4_K_M", 16384, 131072, Some("f16"),
                &[Ocr, Documents],
                2071, 935769056 + 881770560, Specialist, Some(21305.0), Some(280.2),
                Some("A 0.47B OCR specialist, not a chat model — a text-only prompt returns garbage. Transcribed a full 7-row inspection table in 5.2 s.")),

            // Served by llama-server in embedding mode, not a Python sidecar:
            // the GGUF conversion runs on the same runtime as everything else,
            // so there is no second process tree to secure or supervise.
            with_opts(entry("bge-m3", "BGE-M3 (embeddings)", LlamaCpp,
                "bge-m3/bge-m3-Q8_0.gguf", None,
                "bert", "Q8_0", 8192, 8192, None,
                &[Embeddings], 1300, 634553760, Primary, None, None,
                Some("Upstream ships a PyTorch pickle, which llama.cpp cannot load, so the Q8_0 GGUF conversion sits beside it; the original .bin is untouched. Verified through the router: 1024 dimensions, already L2-normalised.")),
                // BGE models pool on the CLS token. Mean pooling silently
                // degrades retrieval instead of failing, so it is pinned.
                &[("embedding", "true"), ("pooling", "cls")]),

            entry("minicpm-v-4.5", "MiniCPM-V 4.5", LlamaCpp,
                "minicpm-v-4.5/MiniCPM-V-4_5-Q4_K_M.gguf",
                Some("minicpm-v-4.5/mmproj-model-f16.gguf"),
                "qwen3", "Q4_K_M", 8192, 40960, Some("f16"),
                &[Vision, Documents],
                4945, 5026714304 + 1095113184, Disabled, Some(2390.5), Some(50.4),
                Some("Not routed to. On the P&ID it produced no answer at all — an unclosed reasoning block consumed the whole budget. Qwen3.5-9B covers the same ground correctly. Kept so the decision stays visible and reversible.")),
        ],
    }
}

/* ------------------------------------------------------------------ */
/* Load / seed / query                                                 */
/* ------------------------------------------------------------------ */

#[derive(Debug, Clone)]
pub struct Registry {
    models: Vec<ModelEntry>,
    pub rules: Vec<RouteRule>,
    pub path: PathBuf,
}

impl Registry {
    /// Reads `<config>/models.json`, writing the seed first if it is absent.
    /// A malformed file is an error, not a silent fallback to the seed: if the
    /// operator edited it and got it wrong, they need to be told.
    pub fn load_or_seed(config_dir: &Path, models_root: &str) -> CoreResult<Self> {
        let path = config_dir.join("models.json");
        if !path.exists() {
            std::fs::create_dir_all(config_dir)?;
            let json = serde_json::to_string_pretty(&seed_catalogue())
                .map_err(|e| CoreError::ExecutionFailed(format!("Could not serialise the model catalogue: {e}")))?;
            std::fs::write(&path, json)?;
        }

        let raw = std::fs::read_to_string(&path)?;
        let cat: ModelCatalogue = serde_json::from_str(&raw).map_err(|e| {
            CoreError::InvalidDocument(format!(
                "{} is not a valid model catalogue: {e}. Delete the file to regenerate the built-in one.",
                path.display()
            ))
        })?;

        let root = models_root.trim_end_matches(['/', '\\']).to_string();
        let rules = if cat.routing.is_empty() {
            routing_rules()
        } else {
            cat.routing
        };
        let models = cat
            .models
            .into_iter()
            .map(|mut m| {
                m.source = m.source.replace(MODELS_ROOT_TOKEN, &root);
                m.projector = m.projector.map(|p| p.replace(MODELS_ROOT_TOKEN, &root));
                m
            })
            .collect();

        Ok(Self { models, rules, path })
    }

    pub fn all(&self) -> &[ModelEntry] {
        &self.models
    }

    pub fn routes(&self) -> &[RouteRule] {
        &self.rules
    }

    /// Changes the primary and optional fallback for one real routing rule and
    /// persists it beside the catalogue. Native extraction remains fixed: it
    /// is deliberately model-free and is not an editable route.
    pub fn set_route(
        &mut self,
        kind: TaskKind,
        model_id: String,
        fallback_model_id: Option<String>,
        models_root: &str,
    ) -> CoreResult<Vec<RouteRule>> {
        let usable = |id: &str| {
            self.models
                .iter()
                .find(|model| model.id == id)
                .filter(|model| {
                    model.priority != ModelPriority::Disabled && supports_route(model, kind)
                })
        };
        if usable(&model_id).is_none() {
            return Err(CoreError::ModelLoadFailed(format!(
                "The selected model '{model_id}' is missing, disabled, or lacks the capability for this route, so the route was not changed."
            )));
        }
        if let Some(fallback) = fallback_model_id.as_deref() {
            if fallback == model_id {
                return Err(CoreError::ModelLoadFailed(
                    "The fallback must be different from the primary model.".into(),
                ));
            }
            if usable(fallback).is_none() {
                return Err(CoreError::ModelLoadFailed(format!(
                    "The fallback model '{fallback}' is missing, disabled, or lacks the capability for this route, so the route was not changed."
                )));
            }
        }

        let rule = self
            .rules
            .iter_mut()
            .find(|rule| rule.kind == kind)
            .ok_or_else(|| CoreError::ModelLoadFailed("That routing rule does not exist.".into()))?;
        if rule.model_id.is_none() {
            return Err(CoreError::ModelLoadFailed(
                "Native document extraction does not use a model and cannot be rerouted.".into(),
            ));
        }
        rule.model_id = Some(model_id);
        rule.fallback_model_id = fallback_model_id;
        self.persist(models_root)?;
        Ok(self.rules.clone())
    }

    fn persist(&self, models_root: &str) -> CoreResult<()> {
        let root = models_root.trim_end_matches(['/', '\\']);
        let stored = self
            .models
            .iter()
            .cloned()
            .map(|mut entry| {
                if !root.is_empty() {
                    entry.source = entry.source.replace(root, MODELS_ROOT_TOKEN);
                    entry.projector = entry
                        .projector
                        .map(|path| path.replace(root, MODELS_ROOT_TOKEN));
                }
                entry
            })
            .collect();
        let json = serde_json::to_string_pretty(&ModelCatalogue {
            version: 1,
            models: stored,
            routing: self.rules.clone(),
        })
        .map_err(|e| {
            CoreError::ExecutionFailed(format!("Could not serialise the model catalogue: {e}"))
        })?;
        std::fs::write(&self.path, json)?;
        Ok(())
    }

    /// Adds or replaces one local model and persists the catalogue the UI is
    /// editing. URLs are deliberately refused here: the catalogue is for files
    /// on this device, while the separately guarded private-server setting owns
    /// the only non-local provider path.
    pub fn upsert_local_model(
        &mut self,
        model: ModelEntry,
        models_root: &str,
    ) -> CoreResult<Vec<ModelEntry>> {
        let id = model.id.trim();
        if id.is_empty() || model.display_name.trim().is_empty() {
            return Err(CoreError::InvalidDocument(
                "A model needs both an id and a display name before it can be added.".into(),
            ));
        }
        if model.source.trim().is_empty() || model.source.contains("://") {
            return Err(CoreError::InvalidDocument(
                "A local model source must be a filesystem path, not a URL.".into(),
            ));
        }
        if model.location != ModelLocation::ThisDevice
            || model.backend == ModelBackend::PrivateEndpoint
        {
            return Err(CoreError::InvalidDocument(
                "The local model catalogue only accepts this-device llama.cpp or Python models."
                    .into(),
            ));
        }
        if model.context_size == 0 || model.trained_context == 0 {
            return Err(CoreError::InvalidDocument(
                "Context sizes must be greater than zero.".into(),
            ));
        }

        if let Some(index) = self.models.iter().position(|entry| entry.id == id) {
            self.models[index] = model;
        } else {
            self.models.push(model);
        }

        self.persist(models_root)?;
        Ok(self.models.clone())
    }

    pub fn get(&self, id: &str) -> Option<&ModelEntry> {
        self.models.iter().find(|m| m.id == id)
    }

    pub fn require(&self, id: &str) -> CoreResult<&ModelEntry> {
        self.get(id).ok_or_else(|| {
            CoreError::ModelLoadFailed(format!(
                "No model with id '{id}' is in the catalogue at {}.",
                self.path.display()
            ))
        })
    }

    /// Whether the weights are actually on disk. A catalogue entry is a claim;
    /// this is the check.
    pub fn is_present(&self, id: &str) -> bool {
        self.get(id).is_some_and(|m| {
            Path::new(&m.source).is_file()
                && m.projector.as_deref().is_none_or(|p| Path::new(p).is_file())
        })
    }

    /// Candidates for a capability, best first: primary before fallback before
    /// specialist, disabled never. Ties break on generation speed.
    pub fn by_capability(&self, cap: ModelCapability) -> Vec<&ModelEntry> {
        let rank = |p: ModelPriority| match p {
            ModelPriority::Primary => 0,
            ModelPriority::Fallback => 1,
            ModelPriority::Specialist => 2,
            ModelPriority::Disabled => 3,
        };
        let mut v: Vec<&ModelEntry> = self
            .models
            .iter()
            .filter(|m| m.priority != ModelPriority::Disabled && m.capabilities.contains(&cap))
            .collect();
        v.sort_by(|a, b| {
            rank(a.priority).cmp(&rank(b.priority)).then_with(|| {
                b.gen_tokens_per_sec
                    .unwrap_or(0.0)
                    .total_cmp(&a.gen_tokens_per_sec.unwrap_or(0.0))
            })
        });
        v
    }

    pub fn embedding_model(&self) -> Option<&ModelEntry> {
        self.by_capability(ModelCapability::Embeddings).first().copied()
    }

    /// The model to escalate to when the primary's transcription cannot be
    /// trusted — §3's "or the file is marked handwritten" clause, from the other
    /// direction.
    ///
    /// Distinct from the substitution `route` already makes. That one covers
    /// weights that are not on disk and answers before any work is done; this one
    /// answers after a first pass has come back unreadable, which is the case the
    /// Handwriting and ScannedDocument rules are written for: a poor-quality scan
    /// or a page of handwriting that PaddleOCR renders as a few characters of
    /// noise should be tried again by olmOCR rather than returned as the best that
    /// could be managed.
    ///
    /// `None` means there is nothing better to try — no fallback declared, its
    /// weights are absent, or it is the model that just failed. Callers must not
    /// invent one: escalating to a model that is not there produces a second
    /// failure and hides the first.
    pub fn escalation(&self, kind: TaskKind, tried: &str) -> Option<String> {
        let fallback = self.rules.iter().find(|r| r.kind == kind)?.fallback_model_id.clone()?;
        if fallback == tried || !self.is_present(&fallback) {
            return None;
        }
        // A fallback that cannot do the task is not a fallback. The rules are
        // operator-editable, so this is checked rather than assumed.
        let entry = self.get(&fallback)?;
        (entry.priority != ModelPriority::Disabled && supports_route(entry, kind)).then_some(fallback)
    }

    /// §3 — routing, deterministic wherever the rules can decide.
    ///
    /// `token_estimate` overrides the task rule when the input will not fit:
    /// there is no point routing a 40k-token document to a model configured
    /// for 16k, whatever the file type says.
    pub fn route(&self, kind: TaskKind, token_estimate: Option<u32>) -> RouteDecision {
        let rule = self.rules.iter().find(|r| r.kind == kind);

        let Some(rule) = rule else {
            return RouteDecision {
                kind,
                basis: RouteBasis::Rule,
                model_id: None,
                reason: "No routing rule matched; nothing was loaded.".into(),
            };
        };

        // Native extraction: the correct answer is no model at all.
        if rule.model_id.is_none() {
            return RouteDecision {
                kind,
                basis: rule.basis,
                model_id: None,
                reason: rule.detail.clone(),
            };
        }

        let primary = rule.model_id.as_deref().unwrap_or_default();

        // Context first. A model that cannot hold the input is not a candidate,
        // however well it matches the task.
        if let Some(tokens) = token_estimate {
            let fits = self.get(primary).is_some_and(|m| tokens + 2048 <= m.context_size);
            if !fits {
                if let Some(long) = self
                    .by_capability(ModelCapability::LongContext)
                    .into_iter()
                    .find(|m| tokens + 2048 <= m.context_size && self.is_present(&m.id))
                {
                    return RouteDecision {
                        kind,
                        basis: RouteBasis::TokenBudget,
                        model_id: Some(long.id.clone()),
                        reason: format!(
                            "About {tokens} tokens of input exceeds what {primary} is configured for, so {} was chosen for its context.",
                            long.display_name
                        ),
                    };
                }
            }
        }

        if self.is_present(primary) {
            return RouteDecision {
                kind,
                basis: rule.basis,
                model_id: Some(primary.to_string()),
                reason: rule.detail.clone(),
            };
        }

        // Primary weights are missing. Say so, and name the substitute.
        if let Some(fb) = rule.fallback_model_id.as_deref() {
            if self.is_present(fb) {
                return RouteDecision {
                    kind,
                    basis: rule.basis,
                    model_id: Some(fb.to_string()),
                    reason: format!("{primary} is not on disk, so the fallback {fb} was used."),
                };
            }
        }

        RouteDecision {
            kind,
            basis: rule.basis,
            model_id: Some(primary.to_string()),
            reason: format!(
                "{primary} was selected by rule but its weights were not found on disk."
            ),
        }
    }

    /// Chooses the model that owns a conversational agent turn.
    ///
    /// `route` above also serves document workers, where returning PaddleOCR or
    /// olmOCR is correct. Those specialists deliberately do not support chat or
    /// tools, so using the same decision as the top-level agent model hands the
    /// orchestration prompt to a transcription model. A turn coordinator must be
    /// present, fit the context, support tools, and support the task capability;
    /// the document tool performs its own worker routing later.
    pub fn route_agent(&self, kind: TaskKind, token_estimate: Option<u32>) -> RouteDecision {
        let worker = self.route(kind, token_estimate);
        let needed = match kind {
            TaskKind::Code => ModelCapability::Coding,
            TaskKind::DigitalDocument | TaskKind::ScannedDocument | TaskKind::Handwriting => {
                ModelCapability::Documents
            }
            TaskKind::EngineeringDrawing => ModelCapability::Drawings,
            TaskKind::Photograph => ModelCapability::Vision,
            TaskKind::LongContext => ModelCapability::LongContext,
            TaskKind::KnowledgeQuery | TaskKind::Reasoning => ModelCapability::Reasoning,
            // Embedding is never a user-facing agent turn, but failing closed is
            // safer than ever selecting the embedding model as a chat model.
            TaskKind::Embedding => ModelCapability::Reasoning,
        };
        let fits = |model: &ModelEntry| {
            token_estimate.is_none_or(|tokens| tokens.saturating_add(2048) <= model.context_size)
        };
        let is_coordinator = |model: &ModelEntry| {
            model.priority != ModelPriority::Disabled
                && model.capabilities.contains(&ModelCapability::Tools)
                && model.capabilities.contains(&needed)
                && fits(model)
                && self.is_present(&model.id)
        };

        if let Some(selected) = worker
            .model_id
            .as_deref()
            .and_then(|id| self.get(id))
            .filter(|model| is_coordinator(model))
        {
            return RouteDecision {
                model_id: Some(selected.id.clone()),
                ..worker
            };
        }

        let candidate = self
            .by_capability(ModelCapability::Tools)
            .into_iter()
            .find(|model| is_coordinator(model))
            // A custom catalogue can omit a narrow capability from an otherwise
            // valid reasoning/tool model. Prefer an honest general coordinator
            // over an OCR/embedding specialist, while naming the fallback.
            .or_else(|| {
                self.by_capability(ModelCapability::Tools)
                    .into_iter()
                    .find(|model| {
                        model.capabilities.contains(&ModelCapability::Reasoning)
                            && fits(model)
                            && self.is_present(&model.id)
                    })
            });

        let Some(candidate) = candidate else {
            // No coordinator, so say why honestly. Either no installed model can
            // run this kind of turn at all, or one can but none has room for this
            // conversation. The single old message — "no model is registered for
            // this kind of task" — blamed the catalogue for what is usually a
            // context-budget miss, and sent the operator hunting for a model that
            // was already installed.
            let tool_and_cap = |m: &ModelEntry| {
                m.priority != ModelPriority::Disabled
                    && m.capabilities.contains(&ModelCapability::Tools)
                    && m.capabilities.contains(&needed)
                    && self.is_present(&m.id)
            };
            let capable: Vec<&ModelEntry> = self
                .by_capability(ModelCapability::Tools)
                .into_iter()
                .filter(|m| tool_and_cap(m))
                .collect();
            let reason = if capable.is_empty() {
                format!(
                    "No installed model supports both tools and {needed:?}, so nothing can run this as an \
agent turn; an OCR, embedding, or other specialist cannot coordinate."
                )
            } else if let Some(tokens) = token_estimate {
                let biggest = capable.iter().map(|m| m.context_size).max().unwrap_or(0);
                format!(
                    "Every {needed:?}-capable tool model fits less than the ~{tokens} tokens this turn \
needs (the largest window is {biggest}), and no substitute fits either. Shorten the task or raise a \
model's context size."
                )
            } else {
                format!(
                    "The installed {needed:?}-capable tool models were not selected for this turn."
                )
            };
            return RouteDecision {
                kind,
                basis: worker.basis,
                model_id: None,
                reason,
            };
        };

        let worker_name = worker
            .model_id
            .as_deref()
            .and_then(|id| self.get(id))
            .map(|model| model.display_name.as_str());
        let reason = match worker_name {
            Some(name) => format!(
                "{name} is the specialist for the input but cannot coordinate tool calls. {} coordinates the turn and the document tool routes extraction separately.",
                candidate.display_name
            ),
            None if kind == TaskKind::DigitalDocument => format!(
                "The attachment is extracted natively without a worker model. {} coordinates the turn and answers from that extracted content.",
                candidate.display_name
            ),
            _ => format!(
                "{} was selected as the installed tool-capable coordinator for {:?}.",
                candidate.display_name, needed
            ),
        };

        RouteDecision {
            kind,
            basis: worker.basis,
            model_id: Some(candidate.id.clone()),
            reason,
        }
    }

    /// §3 — file-type routing. Extension only: opening a file to decide how to
    /// open it is the sort of unnecessary work the brief rules out. `Handwriting`
    /// and `EngineeringDrawing` are never decided here — every image returns
    /// `ScannedDocument` whatever its extension — so a caller that needs one of
    /// the narrow kinds must ask `documents::classify_image`, which reads the
    /// name and the pixels. A drawing is a file name carrying a drawing marker
    /// (p&id, schematic, isometric, …) or a near-white sheet with ≥ 6 sampled
    /// long straight-line runs; handwriting is a file name carrying a handwriting
    /// marker (handwrit, notes, sketch, …) and nothing more. No OCR-confidence
    /// number exists in that decision.
    pub fn classify_path(path: &str) -> TaskKind {
        let ext = Path::new(path)
            .extension()
            .map(|e| e.to_string_lossy().to_lowercase())
            .unwrap_or_default();
        match ext.as_str() {
            "docx" | "xlsx" | "pptx" | "doc" | "xls" | "ppt" | "pdf" | "csv" | "tsv" | "rtf" => {
                TaskKind::DigitalDocument
            }
            "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff" | "gif" => {
                TaskKind::ScannedDocument
            }
            "ts" | "tsx" | "js" | "jsx" | "py" | "rs" | "c" | "h" | "cpp" | "hpp" | "cs"
            | "java" | "go" | "rb" | "php" | "sh" | "ps1" | "sql" | "json" | "yaml" | "yml"
            | "toml" | "ini" => TaskKind::Code,
            _ => TaskKind::Reasoning,
        }
    }
}

#[cfg(test)]
mod local_model_catalogue_tests {
    use super::*;

    fn local_model(source: &str) -> ModelEntry {
        ModelEntry {
            id: "local-test".into(),
            display_name: "Local Test".into(),
            backend: ModelBackend::LlamaCpp,
            location: ModelLocation::ThisDevice,
            source: source.into(),
            projector: None,
            architecture: "llama".into(),
            quantization: "Q4_K_M".into(),
            context_size: 32_768,
            trained_context: 32_768,
            kv_cache_type: None,
            capabilities: vec![ModelCapability::General, ModelCapability::Tools],
            estimated_vram_mb: 4_096,
            file_size_bytes: 1,
            priority: ModelPriority::Primary,
            prompt_tokens_per_sec: None,
            gen_tokens_per_sec: None,
            note: None,
            preset_options: None,
        }
    }

    #[test]
    fn a_local_model_is_persisted_with_a_portable_root() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-model-catalogue-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary catalogue directory");
        let path = dir.join("models.json");
        let mut registry = Registry {
            models: Vec::new(),
            rules: routing_rules(),
            path: path.clone(),
        };

        let saved = registry
            .upsert_local_model(local_model("C:/models/local-test.gguf"), "C:/models")
            .expect("local model should be accepted");
        assert_eq!(saved.len(), 1);
        let raw = std::fs::read_to_string(path).expect("catalogue should be written");
        assert!(raw.contains("${MODELS_ROOT}/local-test.gguf"));
        assert!(!raw.contains("C:/models/local-test.gguf"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_public_model_url_is_refused() {
        let mut registry = Registry {
            models: Vec::new(),
            rules: routing_rules(),
            path: std::env::temp_dir().join("unused-servergen-catalogue.json"),
        };
        let error = registry
            .upsert_local_model(local_model("https://example.com/model.gguf"), "C:/models")
            .expect_err("URLs do not belong in the local catalogue");
        assert!(error.message().contains("filesystem path"));
        assert!(registry.models.is_empty());
    }

    fn present_model(
        dir: &Path,
        id: &str,
        capabilities: Vec<ModelCapability>,
        priority: ModelPriority,
    ) -> ModelEntry {
        let source = dir.join(format!("{id}.gguf"));
        std::fs::write(&source, b"test weights").expect("temporary model marker");
        let mut model = local_model(&source.to_string_lossy());
        model.id = id.into();
        model.display_name = id.into();
        model.capabilities = capabilities;
        model.priority = priority;
        model
    }

    #[test]
    fn scanned_document_worker_never_becomes_the_turn_coordinator() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-agent-route-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");
        let specialist = present_model(
            &dir,
            "paddleocr-vl-1.6",
            vec![ModelCapability::Ocr, ModelCapability::Documents],
            ModelPriority::Specialist,
        );
        let coordinator = present_model(
            &dir,
            "qwen3.5-9b",
            vec![
                ModelCapability::General,
                ModelCapability::Reasoning,
                ModelCapability::Documents,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        let registry = Registry {
            models: vec![specialist, coordinator],
            rules: routing_rules(),
            path: dir.join("models.json"),
        };

        assert_eq!(
            registry.route(TaskKind::ScannedDocument, None).model_id.as_deref(),
            Some("paddleocr-vl-1.6")
        );
        let agent = registry.route_agent(TaskKind::ScannedDocument, None);
        assert_eq!(agent.model_id.as_deref(), Some("qwen3.5-9b"));
        assert!(agent.reason.contains("cannot coordinate tool calls"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_edited_route_is_capability_checked_and_survives_reload() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-editable-route-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");
        let first = present_model(
            &dir,
            "code-primary",
            vec![ModelCapability::Coding, ModelCapability::Tools],
            ModelPriority::Primary,
        );
        let second = present_model(
            &dir,
            "code-fallback",
            vec![ModelCapability::Coding, ModelCapability::Tools],
            ModelPriority::Fallback,
        );
        let incompatible = present_model(
            &dir,
            "embedding-only",
            vec![ModelCapability::Embeddings],
            ModelPriority::Primary,
        );
        let path = dir.join("models.json");
        let mut registry = Registry {
            models: vec![first, second, incompatible],
            rules: routing_rules(),
            path,
        };
        let root = dir.to_string_lossy().to_string();

        registry
            .set_route(
                TaskKind::Code,
                "code-primary".into(),
                Some("code-fallback".into()),
                &root,
            )
            .expect("compatible route should save");
        assert!(registry
            .set_route(TaskKind::Code, "embedding-only".into(), None, &root)
            .is_err());

        let reloaded = Registry::load_or_seed(&dir, &root).expect("saved route should reload");
        let route = reloaded
            .routes()
            .iter()
            .find(|route| route.kind == TaskKind::Code)
            .expect("code route");
        assert_eq!(route.model_id.as_deref(), Some("code-primary"));
        assert_eq!(route.fallback_model_id.as_deref(), Some("code-fallback"));

        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn native_document_extraction_still_gets_a_conversational_coordinator() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-native-route-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");
        let coordinator = present_model(
            &dir,
            "qwen3.5-9b",
            vec![
                ModelCapability::Reasoning,
                ModelCapability::Documents,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        let registry = Registry {
            models: vec![coordinator],
            rules: routing_rules(),
            path: dir.join("models.json"),
        };

        assert!(registry.route(TaskKind::DigitalDocument, None).model_id.is_none());
        let agent = registry.route_agent(TaskKind::DigitalDocument, None);
        assert_eq!(agent.model_id.as_deref(), Some("qwen3.5-9b"));
        assert!(agent.reason.contains("extracted natively"));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// When no coordinator exists, the `None` answer must say why — and it is
    /// usually not "nothing is registered". A tool-capable model that is present
    /// but too small for the conversation is a different diagnosis from no
    /// capable model at all; blurring them sends the operator hunting for a
    /// model that was already installed.
    #[test]
    fn a_missing_coordinator_names_whether_the_cause_is_capability_or_context() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-no-coordinator-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");

        // No coordinator at all: nothing in the catalogue can run the turn as an
        // agent, whatever the conversation's size.
        let none_at_all = Registry {
            models: vec![],
            rules: routing_rules(),
            path: dir.join("empty-models.json"),
        };
        let empty = none_at_all.route_agent(TaskKind::ScannedDocument, Some(1_000));
        assert_eq!(empty.model_id, None);
        assert!(
            empty.reason.contains("No installed model supports both tools"),
            "{}",
            empty.reason
        );

        // A coordinator is present but far smaller than the conversation.
        let mut tiny = present_model(
            &dir,
            "tiny-coordinator",
            vec![
                ModelCapability::Reasoning,
                ModelCapability::Documents,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        tiny.context_size = 32_768;
        let registry = Registry {
            models: vec![tiny],
            rules: routing_rules(),
            path: dir.join("small-models.json"),
        };
        let fits_nobody = registry.route_agent(TaskKind::ScannedDocument, Some(1_000_000));
        assert_eq!(fits_nobody.model_id, None);
        assert!(
            fits_nobody.reason.contains("fits less than the ~1000000 tokens"),
            "{}",
            fits_nobody.reason
        );
        assert!(
            !fits_nobody.reason.contains("No installed model supports"),
            "the model is installed; the message must not say otherwise: {}",
            fits_nobody.reason
        );

        // The same catalogue answers fine for a conversation that fits: the
        // model was never the problem.
        let fits = registry.route_agent(TaskKind::ScannedDocument, None);
        assert_eq!(fits.model_id.as_deref(), Some("tiny-coordinator"));

        let _ = std::fs::remove_dir_all(dir);
    }

    /// The estimate the caller now passes to `route_agent` is the whole first
    /// request — message text *plus* the tool schemas attached to it — so a turn
    /// that looked roomy on messages alone is routinely several thousand tokens
    /// bigger than selection used to believe (a fresh turn rejected by the server
    /// with a context 500, before compaction had anything to drop). Routing must
    /// honour that larger figure: a Reasoning turn that no longer fits the 16k
    /// primary moves to the installed long-context coordinator rather than being
    /// blessed onto the model whose server window it would overflow.
    #[test]
    fn a_turn_too_big_for_the_16k_reasoner_moves_to_the_long_context_coordinator() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-schema-reasoning-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");
        let mut primary = present_model(
            &dir,
            "qwen3.5-9b",
            vec![
                ModelCapability::General,
                ModelCapability::Reasoning,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        primary.context_size = 16_384; // the live catalogue runs it here
        let mut long = present_model(
            &dir,
            "nemotron-3-nano-4b",
            vec![
                ModelCapability::General,
                ModelCapability::Reasoning,
                ModelCapability::LongContext,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        long.context_size = 131_072;
        let registry = Registry {
            models: vec![primary, long],
            rules: routing_rules(),
            path: dir.join("models.json"),
        };

        // Message text alone (~10k) with its routing slack still fits the 16k
        // primary…
        let fits = registry.route_agent(TaskKind::Reasoning, Some(10_000));
        assert_eq!(fits.model_id.as_deref(), Some("qwen3.5-9b"));
        // …but once the tool schemas the request carries are counted the same
        // turn needs more than the primary's window holds, and must not be sent
        // there to be rejected by the server.
        let decision = registry.route_agent(TaskKind::Reasoning, Some(15_000));
        assert_eq!(decision.model_id.as_deref(), Some("nemotron-3-nano-4b"));
        assert_eq!(decision.basis, RouteBasis::TokenBudget);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// The Coding twin of the overflow guard. The coding models run at 16k, so
    /// a code request whose full size crosses that line must not be left with
    /// the 16k coder — the installed long-context coordinator (which can reason
    /// and drive tools even though it is not tagged for coding) takes it, so the
    /// operator gets an answer instead of a context 500.
    #[test]
    fn a_code_turn_over_the_coding_windows_is_not_left_on_the_16k_coder() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-schema-coding-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");
        let mut coder = present_model(
            &dir,
            "nemotron-cascade-8b",
            vec![
                ModelCapability::General,
                ModelCapability::Reasoning,
                ModelCapability::Coding,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        coder.context_size = 16_384;
        let mut long = present_model(
            &dir,
            "nemotron-3-nano-4b",
            vec![
                ModelCapability::General,
                ModelCapability::Reasoning,
                ModelCapability::LongContext,
                ModelCapability::Tools,
            ],
            ModelPriority::Primary,
        );
        long.context_size = 131_072;
        let registry = Registry {
            models: vec![coder, long],
            rules: routing_rules(),
            path: dir.join("models.json"),
        };

        let fits = registry.route_agent(TaskKind::Code, Some(10_000));
        assert_eq!(fits.model_id.as_deref(), Some("nemotron-cascade-8b"));

        let decision = registry.route_agent(TaskKind::Code, Some(15_000));
        assert_eq!(
            decision.model_id.as_deref(),
            Some("nemotron-3-nano-4b"),
            "a 15k-token code request must leave the 16k coder"
        );
        assert_eq!(decision.basis, RouteBasis::TokenBudget);

        let _ = std::fs::remove_dir_all(dir);
    }

    /// §3 — the second chance the ScannedDocument rule promises, and its limits.
    ///
    /// `route` substitutes when weights are missing, before any work is done.
    /// This is the other case: PaddleOCR-VL has already run and returned a page
    /// of fragments, so the fallback is tried with the page it failed on. The
    /// three `None` answers matter as much as the `Some`: escalating to the model
    /// that just failed loops, escalating to absent weights fails twice and hides
    /// the first failure, and escalating to a model the operator disabled
    /// overrides their decision.
    #[test]
    fn an_unreadable_page_escalates_once_and_never_to_a_dead_end() {
        let dir = std::env::temp_dir().join(format!(
            "servergen-escalation-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&dir).expect("temporary routing directory");
        let fast = present_model(
            &dir,
            "paddleocr-vl-1.6",
            vec![ModelCapability::Ocr, ModelCapability::Documents],
            ModelPriority::Specialist,
        );
        let thorough = present_model(
            &dir,
            "olmocr-2",
            vec![ModelCapability::Ocr, ModelCapability::Handwriting],
            ModelPriority::Specialist,
        );
        let mut registry = Registry {
            models: vec![fast, thorough],
            rules: routing_rules(),
            path: dir.join("models.json"),
        };

        // The page came back as fragments from the fast reader, so olmOCR reads it.
        assert_eq!(
            registry.escalation(TaskKind::ScannedDocument, "paddleocr-vl-1.6").as_deref(),
            Some("olmocr-2")
        );
        // Already olmOCR's own failure: there is nothing better to try.
        assert_eq!(registry.escalation(TaskKind::ScannedDocument, "olmocr-2"), None);
        // A task whose fallback is not installed does not get a phantom retry.
        assert_eq!(registry.escalation(TaskKind::Handwriting, "olmocr-2"), None);

        // An operator who disables a model has decided it is not to be used, and
        // a failure elsewhere does not reopen that decision.
        registry
            .models
            .iter_mut()
            .find(|m| m.id == "olmocr-2")
            .expect("thorough reader")
            .priority = ModelPriority::Disabled;
        assert_eq!(registry.escalation(TaskKind::ScannedDocument, "paddleocr-vl-1.6"), None);

        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
mod vram_budgets {
    use super::*;

    /// The whole point of deriving the budgets rather than hardcoding them: on
    /// the machine the catalogue was measured on, the derivation has to reproduce
    /// the two numbers every tuning decision in `router` was made against.
    #[test]
    fn the_tuned_card_reproduces_the_catalogue_figures() {
        assert_eq!(sharing_budget(VRAM_TOTAL_MB), VRAM_BUDGET_MB);
        assert_eq!(solo_budget(VRAM_TOTAL_MB), 7_675);
    }

    /// olmOCR-2 needs 7387 MiB. It is admitted solo here and refused on a
    /// smaller card — which is the correct answer, and the one the operator can
    /// act on. Letting it load anyway is how a demo ends up serving 4 tok/s from
    /// system RAM with nothing on screen to say why.
    #[test]
    fn the_handwriting_model_fits_solo_here_and_not_on_a_six_gigabyte_card() {
        assert!(7_387 <= solo_budget(VRAM_TOTAL_MB));
        assert!(7_387 > solo_budget(6_144));
    }

    /// The chat and embedding models share on this card (4945 + 1300), which is
    /// what `max_resident_models: 2` exists for.
    #[test]
    fn the_sharing_pair_still_fits_the_sharing_budget() {
        assert!(4_945 + 1_300 <= sharing_budget(VRAM_TOTAL_MB));
    }

    /// A larger card is allowed to hold more rather than being pinned to the
    /// figures this laptop happened to have.
    #[test]
    fn a_bigger_card_gets_a_bigger_budget() {
        assert!(sharing_budget(16_384) > sharing_budget(VRAM_TOTAL_MB));
        assert!(solo_budget(16_384) > solo_budget(VRAM_TOTAL_MB));
    }

    /// A budget of zero would make every admission impossible and divide-by-zero
    /// the panel's percentage bar. Nonsense readings floor at 1 MiB instead, and
    /// the reserve is never subtracted below that.
    #[test]
    fn an_absurd_reading_cannot_produce_a_zero_budget() {
        assert_eq!(sharing_budget(0), 1);
        assert_eq!(solo_budget(0), 1);
        assert_eq!(sharing_budget(256), 1);
    }

    /// Solo is the looser of the two by construction: a model alone on the card
    /// needs no room for a neighbour.
    #[test]
    fn solo_is_never_stricter_than_sharing() {
        for total in [0, 256, 2_048, 6_144, VRAM_TOTAL_MB, 16_384, 24_576] {
            assert!(solo_budget(total) >= sharing_budget(total), "{total} MiB");
        }
    }
}

#[cfg(test)]
mod models_root_detection {
    use super::*;

    fn scratch(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("servergen-root-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("scratch directory");
        dir
    }

    /// The case that actually happened: the installed layout creates
    /// `<sovereign>/models` empty, and the weights are somewhere else.
    #[test]
    fn an_empty_directory_does_not_look_like_a_models_root() {
        let dir = scratch("empty");
        assert!(!holds_weights(&dir));
        std::fs::create_dir_all(dir.join("stt")).expect("empty subdirectory");
        assert!(!holds_weights(&dir), "a directory of empty directories is still empty");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// How the catalogue stores them: `<model-id>/<file>.gguf`.
    #[test]
    fn a_gguf_one_level_down_is_a_models_root() {
        let dir = scratch("gguf");
        std::fs::create_dir_all(dir.join("qwen3.5-9b")).expect("model directory");
        std::fs::write(dir.join("qwen3.5-9b/Q4_K_M.gguf"), b"x").expect("weight file");
        assert!(holds_weights(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Speech weights are `.bin` under `stt/`, and a root holding only those is
    /// still a root — the mic has to work on a machine where the chat models were
    /// not copied over.
    #[test]
    fn whisper_weights_alone_still_count() {
        let dir = scratch("stt");
        std::fs::create_dir_all(dir.join("stt")).expect("stt directory");
        std::fs::write(dir.join("stt/ggml-base.bin"), b"x").expect("weight file");
        assert!(holds_weights(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A README beside the weights is normal; a directory of only documentation
    /// is not a models root.
    #[test]
    fn documentation_is_not_a_weight() {
        let dir = scratch("docs");
        std::fs::write(dir.join("MANIFEST.md"), b"x").expect("doc file");
        std::fs::create_dir_all(dir.join("olmocr-2")).expect("model directory");
        std::fs::write(dir.join("olmocr-2/README.md"), b"x").expect("doc file");
        assert!(!holds_weights(&dir));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_path_that_is_not_there_holds_nothing() {
        assert!(!holds_weights(&std::env::temp_dir().join("servergen-absent-root")));
    }
}

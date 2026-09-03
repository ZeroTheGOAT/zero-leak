//! §15 — the failures this application is required to handle.
//!
//! Every fallible path in the core returns `CoreError`. The ten variants are
//! exactly the ten failure modes the brief enumerates, plus two that are not
//! failures of a subsystem but of authority: `Denied` (a boundary was crossed)
//! and `NotImplemented` (this build genuinely does not do that yet).
//!
//! `NotImplemented` exists so the core can be honest instead of plausible. A
//! command that returns it produces a visible, specific message in the UI. It
//! never returns an empty list that reads like "nothing found".

use serde::{Serialize, Serializer};

use crate::types::CoreFailure;

#[derive(Debug, Clone)]
pub enum CoreError {
    ModelLoadFailed(String),
    InsufficientVram(String),
    CorruptModel(String),
    OcrFailed(String),
    InvalidDocument(String),
    Timeout(String),
    MalformedToolCall(String),
    ExecutionFailed(String),
    PrivateServerUnreachable(String),
    IndexFailed(String),
    /// A workspace boundary, deny list, or permission decision refused this.
    /// Never retried and never escalated.
    Denied(String),
    /// Not implemented in this build. Carries what is missing and what to do.
    NotImplemented { what: String, instead: String },
}

pub type CoreResult<T> = Result<T, CoreError>;

impl CoreError {
    /// Maps onto `CoreFailure['kind']` in src/types/index.ts. `Denied` and
    /// `NotImplemented` have no §15 kind of their own; both surface as
    /// `execution_failed`, which is what they are from the caller's side.
    pub fn kind(&self) -> &'static str {
        match self {
            Self::ModelLoadFailed(_) => "model_load_failed",
            Self::InsufficientVram(_) => "insufficient_vram",
            Self::CorruptModel(_) => "corrupt_model",
            Self::OcrFailed(_) => "ocr_failed",
            Self::InvalidDocument(_) => "invalid_document",
            Self::Timeout(_) => "timeout",
            Self::MalformedToolCall(_) => "malformed_tool_call",
            Self::ExecutionFailed(_) | Self::Denied(_) | Self::NotImplemented { .. } => {
                "execution_failed"
            }
            Self::PrivateServerUnreachable(_) => "private_server_unreachable",
            Self::IndexFailed(_) => "index_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::ModelLoadFailed(m)
            | Self::InsufficientVram(m)
            | Self::CorruptModel(m)
            | Self::OcrFailed(m)
            | Self::InvalidDocument(m)
            | Self::Timeout(m)
            | Self::MalformedToolCall(m)
            | Self::ExecutionFailed(m)
            | Self::PrivateServerUnreachable(m)
            | Self::IndexFailed(m)
            | Self::Denied(m) => m.clone(),
            Self::NotImplemented { what, .. } => {
                format!("{what} is not implemented in this build.")
            }
        }
    }

    /// What the app did instead. Shown verbatim, so it must be actionable.
    pub fn recovery(&self) -> Option<String> {
        match self {
            Self::InsufficientVram(_) => Some(
                "Nothing was loaded. Evict the resident model, or pick one with a smaller \
                 context, before retrying."
                    .into(),
            ),
            Self::ModelLoadFailed(_) => Some(
                "The router was left in its previous state. Check the preset path and the \
                 llama-server binary in Settings > Runtime."
                    .into(),
            ),
            Self::CorruptModel(_) => Some(
                "The file was not loaded. Verify the GGUF against its published checksum; \
                 the weights on disk were not modified."
                    .into(),
            ),
            Self::OcrFailed(_) => Some(
                "No text was recorded for the page rather than a guess. The original file is \
                 unchanged and can be re-ingested."
                    .into(),
            ),
            Self::Timeout(_) => Some(
                "The process was terminated with its job object, so nothing is left running."
                    .into(),
            ),
            Self::Denied(_) => Some(
                "No action was taken. Grant access to the folder, or approve the command, \
                 and run it again."
                    .into(),
            ),
            Self::PrivateServerUnreachable(_) => Some(
                "The request was not retried elsewhere. Public cloud inference is never used \
                 as a fallback."
                    .into(),
            ),
            Self::IndexFailed(_) => Some(
                "The file was left out of the index rather than half-indexed. Other sources \
                 are unaffected."
                    .into(),
            ),
            Self::NotImplemented { instead, .. } => Some(instead.clone()),
            _ => None,
        }
    }

    pub fn to_failure(&self, id: String, at: i64) -> CoreFailure {
        CoreFailure {
            id,
            kind: self.kind().to_string(),
            message: self.message(),
            recovery: self.recovery(),
            at,
        }
    }

    pub fn not_implemented(what: &str, instead: &str) -> Self {
        Self::NotImplemented {
            what: what.to_string(),
            instead: instead.to_string(),
        }
    }
}

impl std::fmt::Display for CoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self.recovery() {
            Some(r) => write!(f, "{} {}", self.message(), r),
            None => write!(f, "{}", self.message()),
        }
    }
}

impl std::error::Error for CoreError {}

/// Tauri requires `Serialize` on the error type. It serialises to a plain
/// string because that is what the frontend renders: `core.ts` catches and
/// reads `e.message`. Structured failures travel over `agent://failure`
/// instead, where the UI has a panel to put them in.
impl Serialize for CoreError {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

/* ---- conversions from the crates the core actually uses ---- */

impl From<rusqlite::Error> for CoreError {
    fn from(e: rusqlite::Error) -> Self {
        // A database fault is never a silent empty result.
        Self::ExecutionFailed(format!("Local database error: {e}"))
    }
}

impl From<std::io::Error> for CoreError {
    fn from(e: std::io::Error) -> Self {
        Self::ExecutionFailed(e.to_string())
    }
}

impl From<serde_json::Error> for CoreError {
    fn from(e: serde_json::Error) -> Self {
        Self::MalformedToolCall(format!("Could not parse JSON: {e}"))
    }
}

impl From<reqwest::Error> for CoreError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() {
            Self::Timeout(format!("Inference request timed out: {e}"))
        } else if e.is_connect() {
            Self::ModelLoadFailed(format!(
                "Could not reach the local inference router: {e}. Start it from the Models panel."
            ))
        } else {
            Self::ExecutionFailed(e.to_string())
        }
    }
}

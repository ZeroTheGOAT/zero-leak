//! §13 — reading the audit log.
//!
//! Writing is `db::record_tool_call`, called from the agent's tool dispatcher.
//! This module is only the read side, and it is deliberately thin: the log is
//! append-only and the query does no filtering or interpretation, because the
//! value of an audit trail is that what the operator sees is what was written.
//!
//! There is no delete, no redact and no export-with-exclusions. An auditable
//! record that this application can prune is not an auditable record.

use crate::error::CoreResult;
use crate::state::AppState;
use crate::types::{StoreGateDecision, ToolCallRecord};

/// The most recent tool calls, newest first.
///
/// Paged from the newest end rather than the oldest, because the question being
/// asked of this screen is almost always "what just happened".
pub fn list(st: &AppState, limit: u32) -> CoreResult<Vec<ToolCallRecord>> {
    st.with_db(|conn| crate::db::audit_page(conn, limit, 0))
}

/// The most recent §11 store-gate decisions — refusals and audited overrides.
///
/// Read side only, like `list`: the table is append-only by construction and
/// this query filters nothing, so what the panel shows is what was recorded.
pub fn gate_list(st: &AppState, limit: u32) -> CoreResult<Vec<StoreGateDecision>> {
    st.with_db(|conn| crate::db::store_gate_page(conn, limit))
}

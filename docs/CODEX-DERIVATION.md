# OpenAI Codex-derived runtime features

ZeroLeak AI adapts selected control-plane designs from the Apache-2.0 licensed
[OpenAI Codex CLI](https://github.com/openai/codex). It does not embed the Codex
TUI, OpenAI authentication, cloud task service, updater, public connectors, or
telemetry exporters.

## Upstream design map

| ZeroLeak capability | Codex design source | ZeroLeak implementation |
| --- | --- | --- |
| Root-scoped child-agent tree | `codex-rs/core/src/agent/control.rs`, `agent/registry.rs` | `src-tauri/src/multi_agent.rs` |
| Spawn and history forks | `tools/handlers/multi_agents_v2/spawn.rs` | `spawn_agent`, `fork_turns` in `agent.rs` |
| Agent status and completion notification | `agent/status.rs`, completion watcher in `agent/control.rs` | SQLite `subagents`, mailbox notifications, `agent://subagent` |
| Agent messaging and interruption | `tools/handlers/multi_agents_v2/*` | `send_message`, `followup_task`, `interrupt_agent` |
| Bounded waits | `tools/handlers/multi_agents_v2/wait.rs` | notification-backed `wait_agent`, 10–60 second bound |
| Per-role configuration | Codex custom agent roles | built-in roles plus `.zeroleak/agents/<role>.md` |
| Explicit skill loading | Codex skills | `.zeroleak/skills/<name>/SKILL.md`, loaded only for `$name` |
| Thread/turn/item boundary | Codex app-server protocol | ZeroLeak typed turns and structured Tauri/SSE events |
| Persistent MCP lifecycle | Codex MCP manager | contained local stdio sessions, tools/resources/prompts |
| Parallel safe tool calls | Codex tool runtime | parallel read-only dispatch; ordered side effects |

## Sovereign modifications

- Every child captures the root chat and approved workspace at reservation.
- Project and global memories keep their existing scope checks. Child agents do
  not write durable memory; the root performs one synthesis after collection.
- Explorer, reviewer, document, and verifier roles are enforced read-only in
  the native dispatcher. Prompt instructions cannot waive this restriction.
- Child writes use the same central diff, approval, guardrail, and audit path as
  root writes.
- Public Codex services are not contacted. Models continue through ZeroLeak's
  loopback/private-server router.
- Child transcripts are durable but archived from the ordinary chat sidebar;
  the agent activity dock is their user-facing lifecycle surface.

## License and branding

The upstream copyright and Apache-2.0 attribution are recorded in
`THIRD_PARTY_NOTICES.md`. ZeroLeak is not an OpenAI product. No OpenAI trademark
is used as ZeroLeak's product name or mark.


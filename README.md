# ZeroLeak AI — Local Agentic Workflow Workbench

**ZeroLeak AI** is an offline, air-gapped desktop agentic workflow workstation designed for organizations where source code and sensitive documents must never leave local infrastructure.

For problem statement **26117**, open **Workflows** in the title bar. The [industrial workflow guide](MRPL_WORKFLOWS.md) covers inspection packages, verified dashboards, evidence, receipts, readiness and network checks. [Synthetic rehearsal inputs](examples/mrpl-demo/README.md) and [open-dataset P&ID and UML samples](examples/open-datasets/README.md) are included.

The active native core in this checkout is `src-tauri`. A standalone `npm run dev` serves the interface only; use the native launch below for OCR, models, tools and generated files.

---

## Key Features

- **Nerve-derived workbench UI**: Source-ported under Apache-2.0 with the original Outfit/Iosevka typography, theme tokens, titlebar, docked workbench, composer controls, and complete settings information architecture.
- **Local-Only & Air-Gapped Security**:
  - Out-of-the-box integration with **Ollama** (`http://127.0.0.1:11434`), **llama.cpp / vLLM** (`http://127.0.0.1:8080`), and custom enterprise OpenAI-compatible servers.
  - Zero telemetry, zero external network requests.
- **Approval Mode Selector**:
  - `✋ Ask for approval`: Prompt before modifying files or executing shell commands.
  - `💻 Approve for me`: Autonomous execution with safe-guards for potentially destructive operations.
- **Interactive Multi-Panel Right Drawer**:
  - `📋 Review (Ctrl+Shift+G)`: Side-by-side & unified code diff viewer with Accept/Reject.
  - `💻 Terminal (Ctrl+\`)`: Multi-session embedded terminal emulator (PowerShell, bash, cmd).
  - `🌐 Browser (Ctrl+T)`: Interactive visual canvas & floorplan schematic viewer.
  - `📁 Files (Ctrl+P)`: Workspace file explorer with one-click `@context` pinning.
- **Complete Settings Suite**:
  - Permissions (Default workspace permissions, Full access toggle).
  - Model endpoints, speed/reasoning budget, default editor (Visual Studio, VS Code, Cursor).
- **Codex-style local harness**:
  - Separate personal chats and project chats, with one durable transcript per chat.
  - Global memories for operator preferences and isolated memories per workspace.
  - Chat-level controls for using memories and contributing future memories.
  - Global and project `AGENTS.md` instructions, loaded before each local-model run.
  - Session-scoped artifact folders with project/chat provenance and verification.
  - Inspectable JSONL transcript mirrors and Markdown memory mirrors alongside the SQLite source of truth.
- **OpenAI Codex-derived agent control plane**:
  - Session-scoped child-agent trees with canonical task paths and durable hidden transcripts.
  - `spawn_agent`, `list_agents`, `send_message`, `followup_task`, `interrupt_agent`, and bounded `wait_agent` coordination tools.
  - Full, recent-turn, or empty context forks; per-agent local model and reasoning overrides.
  - Explorer, coder, reviewer, document, and verifier roles with backend-enforced read-only restrictions where appropriate.
  - Parent/child cancellation, completion notifications, concurrency/depth limits, and inspectable activity in the chat timeline.
  - Persistent local MCP sessions with tools, resources, and reusable prompts.

The control-plane design is adapted from the Apache-2.0 licensed
[OpenAI Codex CLI](https://github.com/openai/codex). ZeroLeak uses its own local
model router, storage, tools, UI, and security policies; it is not an OpenAI
product and does not use OpenAI branding as its product identity. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

---

## Quick Start

### 1. Run in Development Mode
```bash
cd zero-leak-app
npm install
npm run dev
```
Open [http://localhost:5173](http://localhost:5173) in your browser.

### 2. Build for Production
```bash
npm run build
```

### 3. Run as Desktop Application (Zero)
```bash
npm run zero dev
```

---

## Customization & Extensibility
All components are modular and located in `src/components/`:
- `src/components/layout/`: TitleBar and Sidebar
- `src/components/chat/`: ChatContainer, EmptyState, FloatingInput, ApprovalPopover, ModelSelectorModal
- `src/components/panels/`: RightPanel, DiffReviewer, TerminalView, SchematicView, FileExplorerView
- `src/components/settings/`: SettingsView with Permissions & Local LLM Endpoints
- `src/services/core.ts`: Typed bridge to the native local core.
- `src-tauri/src/agent.rs`: Local model orchestration, context assembly and tool loop.
- `src-tauri/src/harness.rs`: Harness layout, memories, instructions and transcript mirrors.

---

## Harness home

On first native start, Zero Leak creates `C:/sovereign` by default. Set `SOVEREIGN_HOME` before launch to relocate the entire harness. The core creates the following layout automatically:

```text
C:/sovereign/
├── AGENTS.md                 # durable global operator instructions
├── HARNESS.md                # local description of the generated layout
├── config/                   # model and runtime configuration
├── state/workbench.db        # canonical SQLite state
├── sessions/<chat-id>/
│   ├── metadata.json
│   └── transcript.jsonl      # inspectable append-only chat mirror
├── memories/
│   ├── global.md
│   └── projects/<workspace-id>.md
├── projects/<workspace-id>/
│   ├── project.json
│   ├── AGENTS.md             # project-only durable instructions
│   ├── memories/
│   └── artifacts/
├── artifacts/<chat-id>/      # generated files scoped to their chat
├── knowledge/                # local retrieval sources and index material
├── sandbox/                  # isolated command working directory
└── models/                   # local model weights
```

SQLite is canonical. The JSONL and Markdown files are generated recovery and inspection surfaces. Do not store passwords, tokens, private keys, or document-source facts in memories.

### Memory commands

- `Remember globally: ...` stores a global memory.
- `Remember for this project: ...` stores a memory only for the active workspace.
- `Remember: ...` stores project memory when a workspace is active, otherwise global memory.

The Memories panel can add, disable, forget, and inspect memories; edit global or project instructions; and set per-chat memory controls. Memory is treated as preference/context, never as evidence for engineering values or current file contents.

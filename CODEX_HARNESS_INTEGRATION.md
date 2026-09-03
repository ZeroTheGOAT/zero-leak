# Codex-style turn harness integration

## Outcome

The workbench keeps its existing React/Zero interface and local llama.cpp model stack, but adopts the Codex app-server lifecycle at the product boundary:

1. A chat can be opened without choosing or loading a model.
2. Files selected in the composer are inert draft inputs. Selecting them never reads, OCRs, indexes, routes, or opens another panel.
3. Only an explicit Send action starts a turn.
4. The submitted turn owns its text, local inputs, mode, project, memory policy, model decision, streamed events, and final answer.
5. Normal answers, including OCR/transcription text, finish in the main transcript. The Artifacts area contains only files the user explicitly asked the agent to create or export.

The OpenAI Codex app-server calls these primitives threads, turns, and items. Zero Leak retains the existing user-facing word “chat” and the existing UI, while its native bridge uses the same separation.

## Plan, compaction, thinking

Three harness mechanics follow the Codex pattern:

- **`update_plan` (task decomposition).** Offered in both modes whenever tools
  are offered. For multi-step work the model publishes a 1–12 step plan before
  working it and revises it — statuses `pending` / `in_progress` / `completed` —
  as it goes, sending the complete list every time. Each revision replaces the
  whole plan, is emitted as `agent://plan` for the originating chat, and is
  rendered as a live checklist above the run's timeline. The tool result echoes
  the stored plan back so the model reasons from what was published. The plan
  is advice, not a side effect: it touches no disk and no network.
- **Context auto-compaction.** Before every tool round, the conversation is
  estimated against the loaded model's context window minus the answer budget
  and a fitting margin. At the threshold, the system prompt, the current
  request and the last two tool rounds are kept; the older rounds are replaced
  by one summary completion on the same model (with a deterministic
  truncation fallback if that call fails), shown as a visible "Compacting
  context" step. Cuts happen only at round boundaries, never mid-round.
- **Visible thinking.** With Extended Thinking enabled in Settings, the
  reasoning stream (`reasoning_content`, deepseek-shaped) is surfaced as a
  separate collapsed Thinking block — streamed deltas for the answer turn, one
  block per tool round — and never mixed into the answer text. With Extended
  Thinking off, reasoning is still parsed into its own field and discarded:
  the earlier invariant (no reasoning in any answer, step, or timeline) holds
  exactly as before.

## Ask, batch, and the build loop

The remaining Codex CLI capabilities, matched to the workbench's own shapes:

- **Ask the operator (`ask_operator`).** A read tool, offered whenever tools
  are offered, for the case no risk table can decide: the task is genuinely
  ambiguous or a requirement cannot be inferred. The model calls it with one
  question (≤500 chars, plus optional context); the core parks the run on a
  channel and emits `agent://question`; a free-text prompt appears beside the
  permission prompt, and the typed reply is fed back as the tool result. If
  the operator does not answer within 15 minutes the reply says so and tells
  the model to continue with what it has; cancelling the run answers the
  question the same way. The system prompt steers usage: ask when stuck, not
  for permission (write tools already pause for approval) and not for
  anything a tool result already answers.
- **Batch diff approvals.** `change_apply_all` / `change_discard_all` give a
  multi-file change one decision instead of one per file — a model that edits
  six files to add one feature is not asking for six approvals. Honesty stays
  per-file: a proposal whose file changed on disk since the diff was made is
  skipped, reported in the returned failed list, and stays in the review
  panel; the rest of the batch still goes through. The review panel offers
  "Write all N" / "Discard all" whenever more than one file is pending.
- **Git and the build loop.** The Agent-mode system prompt now teaches the
  developer's loop the sandbox can actually run: prove code runs (node, cargo,
  python via `run_command`; `npm test` / `cargo test` for suites), read the
  failure output, fix what the error names, and iterate until it passes or
  there is a specific reason to stop — never report success while an error is
  on the screen. Git is taught as a local tool (`git status`, `diff`, `add`,
  `commit` in the open folder) with hard lines: no history rewrites, no
  force-push, no branch the run was not told to touch. The allow-list (python,
  pip, git, node, npm, cargo, findstr, where, tree), the 600 s command
  timeout and the 60-round tool loop are what make this reachable in
  practice.

## Operator safety guardrails

Settings → Permissions → **Safety guardrails** holds operator-authored hard stops,
stored with the other agent settings and re-read on every check, so a rule
added or lifted mid-run takes effect on the very next tool call. Two kinds:

- **Protected path** — an absolute path prefix (`D:/` protects the whole
  drive; `C:/sovereign/models` protects that subtree). Judged against the
  resolved absolute path, so a relative spelling or a `..` detour cannot
  dodge the rule.
- **Forbidden command** — a pattern matched against the command text for
  `run_command` and the source of `execute_python`. A single word matches on
  word boundaries (`force` catches `git push --force`, not `forcefully`); a
  phrase or anything containing a space, dash, or slash matches as a
  substring. This is the operator's own layer on top of the sandbox's
  built-in deny list, which already refuses the destructive core on every
  install: `del`, `rmdir`, `rd`, `rm`, `Remove-Item`, `format`, `diskpart`,
  `vssadmin`, the registry and service tools, and the network fetchers.

Enforcement is layered at three choke points:

1. `dispatch_write` — before the approval gate. A session grant or an
   operator approval click cannot waive a protected path; the rules are the
   floor under the approval system, not another prompt.
2. `apply_change` — re-checked at write time. A diff that sat in the review
   panel while a rule was added is still refused at accept time.
3. `sandbox::exec` — re-checked after the built-in deny list, so a future
   caller that bypasses the dispatcher cannot slip past.

A refusal is a first-class tool result, not a crash: it names the rule, its
note, what the action would have touched, and that it cannot be worked
around in the run. The system prompt teaches the model that a result
beginning "Refused by the safety rule" is final — no retry, no alternate
spelling, no mid-run ask to lift it; say what was blocked and continue.

## Non-negotiable invariants

- `document_pick` is selection only. It may open the operating-system picker and return absolute paths; it may not read file bytes or emit model/agent activity.
- A draft is owned by one chat. Switching chats cannot move text or an attachment into a different chat.
- `turn_start` is the only composer operation allowed to start orchestration.
- A turn must contain non-empty user instructions. An attachment by itself remains a draft and cannot auto-submit.
- Model discovery and model loading are separate. Listing or displaying models never loads one.
- The coordinator model must support tools and the capability required by the task. OCR-only specialists cannot be selected as the conversational coordinator.
- Document workers remain specialized: native extraction first; PaddleOCR/olmOCR/vision only when the document tool actually needs them.
- Every completion carries its originating chat id and full final message. Changing the visible chat while a run is active cannot redirect its answer.
- Generated files require explicit artifact intent. “Read,” “show,” “explain,” and “transcribe” are conversational requests, not file-generation requests.
- The local-only boundary does not change: no public network access, no external Codex service, and no movement of source files outside configured local roots.

## Lifecycle

```text
open/new chat
    -> idle (no model)
    -> select local files
    -> draft { text, inputs[] } (still no model)
    -> explicit Send
    -> turn/start
       -> validate chat + input
       -> persist the user message
       -> classify task
       -> choose a tool-capable coordinator
       -> load coordinator on demand
       -> inspect attachments through tools
          -> native extraction, or a separately routed OCR/vision worker
       -> stream structured steps + answer text
       -> persist and emit the full final answer for the originating chat
    -> idle
```

## Native bridge contract

The UI submits typed input items instead of two unrelated fields:

```json
{
  "threadId": "sess-…",
  "input": [
    { "type": "text", "text": "Transcribe the heading and totals." },
    { "type": "localImage", "path": "C:/…/photo.jpg" },
    { "type": "localFile", "path": "C:/…/report.pdf" }
  ],
  "mode": "plan",
  "workspaceId": null,
  "useMemories": true,
  "contributeMemories": true
}
```

`turn_start` normalizes this wire shape into the existing internal orchestrator input. The older `agent_start` command remains as a compatibility surface but is no longer used by the composer.

Completion events contain `runId`, `sessionId`, `mode`, the complete `message`, citations, timing, model provenance, and proposed file changes. Streaming deltas are presentation updates; the completion message is authoritative.

## Routing design

Routing is deliberately two-stage:

- Coordinator routing chooses a present, context-fitting model with `tools` plus the task capability. Examples: coding for source changes, drawings/vision for visual engineering questions, documents for document conversations, and reasoning for general work.
- Worker routing happens only inside a document/image tool. Digital files use native extraction when possible. Printed scans can use PaddleOCR, handwriting can use olmOCR, and drawings/photos can use the configured vision model.

This prevents an OCR specialist—which is intentionally not a chat/tool model—from receiving the whole agent loop. Missing or incompatible coordinator models fail closed with an actionable error instead of loading a knowingly wrong model.

## Transcript and artifact projection

- User text and attachment names appear together in the user message.
- Structured tool activity remains in the agent timeline.
- The final natural-language answer is always committed to the main transcript from the authoritative completion payload.
- Citations and proposed changes stay attached to that answer.
- Artifact generators are offered only when the prompt contains explicit create/save/export intent for a deliverable. Generated files may be shown as cards beside the answer and in the Artifacts panel; extracted text itself is never silently converted into an artifact.

## Regression matrix

| Scenario | Expected result |
| --- | --- |
| Select one photo and wait | Draft chip only; no route, load, OCR, transcript item, or panel change |
| Select several files and switch chats | Each chat retains only its own draft |
| Photo with empty text | Send remains disabled |
| “What text is visible?” + photo | Explicit turn; document worker reads it; answer appears in transcript; no artifact |
| “Save the transcription as notes.md” + photo | Answer appears in transcript and requested file appears in Artifacts |
| Digital PDF + question | Native extraction may run, but a tool-capable coordinator answers |
| Printed scan + question | Tool-capable coordinator runs; OCR specialist is used only by the document tool |
| Switch chats during a long answer | Stream is shown only in the originating chat; final answer is stored there |
| Multi-step task in either mode | A plan checklist appears before the tool work and stays current; each revision replaces the whole plan |
| Very long tool-heavy run | A "Compacting context" step appears before the window overflows; system prompt, current request and last two rounds survive |
| Extended Thinking on | Reasoning appears in a separate collapsed Thinking block, never in the answer text |
| Extended Thinking off | No thinking events at all; answers, steps and timeline are exactly as before |
| Ambiguous request in Agent mode | The agent asks one clear question and the run pauses until it is answered, times out after 15 min, or is cancelled |
| Answering an agent question mid-run | The typed reply becomes the tool result and the run continues from it |
| Run with several proposed files | "Write all N" applies the batch; a file changed on disk since its diff stays in the panel with its reason |
| "Fix the failing test" in a repo | The agent runs the suite, reads the failure, edits, and re-runs until green — or stops and says what blocked it |
| "Commit the change" in a repo | The agent shows `git status`/`git diff` first, then `git add` + `git commit`; history is never rewritten |
| Write into a protected path | The call is refused before the approval gate; the refusal names the rule and the run continues |
| Command matching a forbidden pattern | The run is refused by the operator rule, with a denied audit entry; no retry or alternate spelling succeeds |
| Rule added while a diff sits in review | The write is still refused at apply time; the change stays in the panel |
| Follow-up with no attachment | Existing chat history is used; no previous draft attachment is resent |
| Model weights/capability missing | Turn fails visibly before generation; no incompatible specialist is substituted |

## Verification gates

- TypeScript production build passes.
- Frontend lint passes.
- Rust unit and integration tests pass.
- Routing tests cover coordinator capability filtering and specialist separation.
- Intent tests cover conversational transcription versus explicit artifact creation.
- Serialization tests cover typed local image/file turn inputs and originating-chat completion fields.
- Plan tests cover validation (bounds, statuses, lengths) and the complete-list-every-time render.
- Compaction tests cover round-boundary cuts, system-prompt survival, and threshold slack.
- Reasoning tests cover the deepseek field split and the no-field path.
- Operator-question tests cover the wire shape and the timeout/cancellation reply markers.
- Batch-change tests cover path selection (unapplied-only for apply, everything for discard) and the failed-list wire shape.
- Guardrail tests cover path prefix boundaries (separator, drive root, case), command word/phrase matching, refusal wording, and the three enforcement points.


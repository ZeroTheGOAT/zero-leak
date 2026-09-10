# Sub-agent visibility and 7 GB VRAM readiness — September 10, 2026

Sources now includes a Sub-agents section even when the conversation has no attachments or outputs. It previews three tasks, prioritizes active work, and opens the full list through View all. Selecting a task opens its conversation in the existing side panel. The parent chat remains selected. The panel shows the delegated task, live status, actions, output, plan and saved transcript, with a back-to-list button and a Stop action for that child.

Child event buffers are registered when work is reserved, so opening the panel late retains activity already received by this app. Completed activity is saved through the existing local transcript mechanism. Stored and live answers are merged by run identity. Delayed history responses cannot populate another child's panel, and a stale registry response cannot replace newer completion status. Every list, lookup and history request retains the root-chat scope. Child work counts against its parent chat in the status bar. Child transcripts are excluded from the main and archived chat lists and remain accessible through Sources.

## Small GPU controls and reliability fixes

- GPUs with 8 GB or less, including this RTX 4060 Laptop with a roughly 7 GB working budget, have one active child across the entire workstation and no nested delegation. Both new tasks and follow-ups enforce capacity. Older saved settings requesting more children are capped when loaded and when updated.
- Automatic child work inherits the parent's selected model and memory preference. An explicit model choice bypasses an unnecessary classifier-model request. Local chat, embedding and vision inference requests are serialized. A parent waiting for its child releases its model pins so a specialist can use the available memory.
- Stop retains the child's slot in a visible Stopping state until its run ends. A stopped reservation cannot start. Child runs are registered before their asynchronous work begins, repeated completions are ignored, and an old completion cannot overwrite a restarted task. A resumed child is associated with the current parent run for cancellation.
- Read-only roles receive read-only tool schemas. A live rehearsal exposed that they previously received execution tools which the role guard would reject; the offered tools and role instructions now agree. Role restrictions remain enforced in the backend.

## Verification performed

- `npm run build`: passed TypeScript compilation and production Vite build.
- `npm run lint`: passed with 24 existing warnings; no warnings in the new modules.
- `cargo test --manifest-path src-tauri/Cargo.toml --quiet -- --include-ignored`, with Cargo offline: **395 passed, 0 failed, 0 ignored**, including the real-weight geometry check against the installed Gemma and Cascade files.
- Full frontend regression suite: 46 passed across seven files, including all prompt tests and ten new sub-agent tests. Coverage includes live work before panel opening, full-list navigation, parent retention, cross-chat isolation, delayed/stale replies, launch failure, completion deduplication, history retry and child-only interruption.
- The test dependencies are pinned to the verified, Node-compatible versions. A clean `npm ci --offline --ignore-scripts --no-audit --no-fund --cache .uifix/npm-cache` installed all 193 packages from local archives; `npm run check` then passed. `npm ls --depth=0` reports no dependency problems. The prompt tests use the already-present Testing Library event helpers and retain their original assertions.
- Chromium browser checks using simulated local core responses: Sources, all five fixture agents, individual live chat, and the parent/child layout at 1296 × 850 and 900 × 650. No page errors or horizontal page overflow. Rendered screenshots were inspected.
- `git diff --check`: passed.

Browser evidence is in `.uifix/subagent-validation/`. The initial five-agent navigation check uses a simulated boundary; the additional native checks below use the actual app and local model.

## Native model rehearsal

An isolated temporary harness outside OneDrive reused the installed weights without copying projects, memories or documents. The app rejected an attempted setting of eight children/four levels by returning the enforced one-child/one-level profile.

The coordinator spawned exactly one explorer, waited for it, and received the correct result of 23 × 19: **437**. The child transcript retained the task and answer. Only **Gemma 4 E4B** was loaded. Peak sampled GPU memory was **4,757 MiB (4.65 GiB)**. This measures that specific rehearsal, not a maximum for all model/context/document combinations.

A Chromium browser connected to the real native core opened Sources, the one-child list and the saved child chat. The result was verified at 1296 × 850 and 900 × 650 with no page errors or horizontal overflow. Screenshots are `native-child-chat.png` and `native-child-chat-small.png`.

A separate native check started two small requests against the same local model, observed the second request waiting for the inference slot, and cancelled it in **125 ms** while the other chat remained active. The other request was then cancelled. The test application was closed and GPU memory released afterward.

Native readiness passed the public HTTP guard, sandbox policy, inference executable, document/coding/scan routes, Python, Node, Poppler, artifact exporters and GPU checks. Its one warning was the intentionally empty knowledge index in the isolated harness. The user's actual installation has four knowledge sources. The public TEST-NET guard check refused the address without contacting it.

## Readiness findings and limits

The native and frontend defaults now agree with the local-only design: public internet blocked, web search disabled and sandbox network policy off. An added native regression test protects those defaults. Existing saved network settings are retained; child limits are constrained to the GPU profile.

A read-only check of the default local installation, `C:/zeroD/state/workbench.db`, found its configured inference executable and model directory present, four knowledge sources, public networking blocked, and sandbox networking off. Its saved web-search mode is still `direct`; public HTTP requests remain refused by the backend guard. File presence and source counts are not model warm-up or accuracy checks.

The earlier missing-test-dependency blocker is resolved. The lockfile now pins Vitest 4.1.10, jsdom 29.1.1 and Testing Library React 16.3.2, matching the clean installation and verified runtime.

The sandbox's network setting is a policy flag, not an OS packet filter. Arbitrary child-process sockets are not covered by the application HTTP guard. Rehearse with appropriate machine-level network containment and independently verify traffic before claiming an air gap.

The native executable was built with the packaged frontend. An installer bundle and machine-wide packet capture were not produced in this pass. The live rehearsal validates delegation, memory use and cancellation for the selected local model; it does not certify the accuracy of arbitrary engineering conclusions, OCR documents or generated applications. Larger contexts and different specialists have different memory requirements. The existing byte-budget admission checks remain in force.

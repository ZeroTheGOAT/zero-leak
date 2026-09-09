# Hackathon polish and validation

This pass keeps the existing desktop design, native tools, model catalogue,
permission policy, and local storage layout. It addresses failures at the
boundaries between the UI and native core.

## What changed

- Document refreshes preserve fully loaded text and tables while the source
  hash and extraction timestamp match. Re-extraction invalidates that cache.
- Multi-file import reports the current file and position in the batch.
  Repeated clicks cannot launch duplicate import batches.
- A refused or disconnected turn returns a failed submission result. The
  composer keeps the draft, including the first draft on the welcome screen.
- Questions and permission requests stay visible until acknowledged by the
  native core. In-flight controls are disabled, failed delivery has an inline
  retry message, and duplicate events do not duplicate prompts.
- Finishing a run clears its own unanswered questions. Other runs retain theirs.
- HTTP replies are validated before use. Authentication failures explain how
  to reopen the launch link. Availability probes have a deadline; writes do not
  receive automatic timeouts or retries.
- Event subscriptions share one stream and close it when unused. A reconnect
  reopens a closed stream and checks persisted run receipts for missed
  completions. A still-running receipt never becomes a fabricated completion.
- Queued follow-ups resume only after the connected state reaches the UI.
- Revision sources can be reordered with explicit earlier/new revision labels.
  Workflow launch explains missing files and requires an approved, active project.
- Receipt fetching distinguishes loading, errors, and an empty result. Readiness
  failures have a distinct failure indicator.
- Knowledge sources can be filtered by filename, path, or status. Index actions
  show progress and block duplicate clicks while busy.
- Search uses the live model catalogue, including custom models. Choosing a
  project opens a task scoped to that project.
- Modal keyboard handling respects input composition and prevents workspace
  shortcuts from opening other panels behind a dialog.
- Build configuration uses the supported chunk-splitting option. README launch
  instructions distinguish the UI preview, native development, and installers.

## Verification performed

- `npm ci` completed for the original checkout; the test dependencies were then
  added with npm and recorded in `package-lock.json`.
- `npm test`: 36 regression tests covering document cache invalidation,
  submission failure, first-chat drafts, import concurrency, prompt queues,
  native null acknowledgements, interrupted event streams, receipt recovery,
  queued follow-ups, workflow source ordering, and panel loading/error states.
- `npm run build`: TypeScript and production Vite compilation.
- `npm run lint`: no errors; pre-existing React lint warnings remain.
- `git diff --check`: whitespace and conflict-marker checks.

Frontend tests use a simulated native command/event boundary and a DOM test
environment. They do not run an LLM or claim to validate OCR accuracy. The cloud
browser could not access the local preview, so no rendered-browser visual
verification is claimed. This environment has no Rust toolchain, Windows desktop
runtime, or local GPU/model pack; native compilation and model rehearsal remain
to be performed on the target laptop.

## Laptop rehearsal

1. Install the locked frontend dependencies with `npm ci`, then run `npm run check`.
2. Run `cargo test --locked --manifest-path src-tauri/Cargo.toml` on the configured
   Windows development machine, then launch with `npm run zero dev`.
3. Open **Workflows → Readiness** and check the actual model files, routes, GPU,
   inference executable, local tools, knowledge index, and exporters.
4. Use the synthetic files in `examples/mrpl-demo` for an inspection and a revision
   comparison. Confirm the earlier/new source order, quoted measurements, page
   references, populated worksheets, and opened Word/Excel outputs.
5. Rehearse the local dashboard workflow and inspect its actual test output and
   browser preview. Model-generated engineering conclusions still need source
   review, as described in `MRPL_WORKFLOWS.md`.

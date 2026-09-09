# Industrial workflows for problem statement 26117

Open **Workflows** in the title bar. The panel has four sections: Workflows, Run receipts, Readiness and Network. Start the native core, not a standalone Vite server, to execute tasks.

## Workflows

Automatic chat routing first calls local Gemma E4B with thinking enabled, recent conversation and capability descriptions for all bundled models. Gemma chooses an installed, enabled tool-capable coordinator whose context fits the request. OCR and embedding specialists remain tool workers. Invalid selections fail visibly instead of reverting to keyword routing. The choice stays in place for the final answer unless more context requires another Gemma selection; configured workflow recovery remains available. This adds one local inference call and requires Gemma E4B to be installed. Selection quality still needs real-model rehearsal.

- **Inspection approval package:** attach an inspection report and supporting sources; index the applicable SOP in Knowledge. The agent plans, reads/OCRs, retrieves local knowledge, produces a draft Word approval note and an Excel action tracker, and inspects its artifacts.
- **Verified internal dashboard:** attach a tracker or use **Use latest tracker** after the inspection workflow. The coding route takes precedence over spreadsheet attachment type. The agent writes code, runs sandbox checks, serves locally and checks the page.

Dashboard runs receive native workbook extraction in their initial context and a focused coding tool set. Repeated tool failures or an unfinished workflow can trigger the operator-configured local fallback model. The fallback keeps the same workspace, evidence and permission policy, and its selection is recorded in the receipt.
- **Cross-document discrepancy review:** attach at least two comparable sources. The workflow requests both source quotations, comparison conditions, missing information, and a review workbook.
- **Document revision impact:** attach the old revision first and the new revision second. It requests changes and conclusions needing review, preserving both sources in an Excel workbook.

Inputs stay as drafts until Start. Use the up/down controls to put revision sources in the correct order; the first two rows are labeled Earlier revision and New revision. The panel explains missing inputs and refuses to start in an unapproved or archived project. Draft files and notes remain scoped to the project and survive opening Settings. These workflows use the existing real agent tools and permission policy. They are instructions for autonomous execution, not deterministic engineering-analysis algorithms; completion depends on model performance and available evidence.

## Evidence and receipts

The core starts a SQLite receipt before each run. It records actual routing/loading steps, tool outcomes, source citations, sandbox commands and output, exit codes, generated artifacts and verification results. The UI polls the active chat's receipts; it never reconstructs old activity as fact. Export produces a Markdown artifact below the configured artifact root, with project and chat provenance.

The core checks workflow evidence before the final answer and allows up to two repair attempts for missing work, while respecting recorded operator refusals. A workflow ending without required evidence is marked **incomplete**. Header-only review workbooks are rejected during generation. Package verification means the file reopened structurally; it is not certification of factual accuracy. A successful command naming tests does not prove that a useful suite was written. Read the captured output and check the synthetic evaluation key.

On restart, unfinished receipts become **interrupted**. Duplicate concurrent turns in the same chat are refused. Deleting a chat removes its receipts. Receipts retain submitted paths as inputs; that field alone does not establish that the agent read every file.

Citation clicks open the referenced page and select an exactly matching extracted passage when possible. Page images come from that page's embedded scan. Changed source hashes are refused. Native/vector PDFs without an embedded page scan show extracted text and an explicit unavailable-preview message rather than page-one pixels under another page number.

## Readiness and sovereignty

Readiness checks local model files/projectors and task routes, the inference executable, local tools, GPU telemetry, indexed knowledge, and in-memory Word/Excel/PowerPoint exporter samples. It does not run a model warm-up, benchmark accuracy, install software, or certify that every combination fits in VRAM.

Public HTTP destinations are refused, including legacy public web tools. Private inference requires the exact configured HTTP(S) origin and path boundary at a private IP literal. Hostname-prefix spoofing, embedded URL credentials and unapproved ports are refused. Use a private IP when configuring an on-prem endpoint. This avoids treating an arbitrary DNS name as evidence of an on-prem address.

The core HTTP client does not follow redirects. Managed static previews apply a Content Security Policy limiting scripts, styles, fonts and fetches to local resources. A file passed to `serve_folder` is refused rather than registered as a working folder preview. Independently launched development servers still require their own browser-content policy and OS network containment.

Network displays the last 500 application HTTP guard decisions and can evaluate a public TEST-NET address without contacting it. Exported receipts include the decisions associated with their run. Allowed guard decisions do not prove transmission. This is **not** an OS firewall or machine-wide packet monitor; independent capture must cover the process and children for the hackathon sovereignty demonstration.

The headless server supports `--headless --no-open-browser --port <port>`. The session launch link remains required for browser authentication.

## Rehearsal data

See `examples/mrpl-demo/README.md`. The two PDFs have image-only pages and deliberately differ at one measurement. The supplied SOP and equipment are synthetic and contain no proprietary data.

## Verification

Run `npm run check` and `cargo test --locked --manifest-path src-tauri/Cargo.toml` on Windows. Add `--offline` to Cargo only after the required dependencies are cached. This checkout's native directory is `src-tauri`.

Regression tests cover compressed scan decoding, distinct page images, revision differences, private endpoint matching, receipt recovery and chat isolation, network run isolation, failed execution evidence, missing artifact checks and workflow routing. Real-model rehearsal is also needed on the target GPU; tests alone cannot certify generated engineering content.

### Development rehearsal observations

The synthetic inspection workflow produced a Word draft and a populated four-sheet Excel tracker, both reopened successfully. It also demonstrated recovery after a header-only workbook was rejected. The dashboard was generated through the local coding/fallback path, then required QA feedback to correct missing DOM references. Independent checks passed for source-record consistency, DOM targets, initial counts, equipment filtering, empty results and clearing filters; the rendered browser controls were also exercised directly.

The local model's generated regression tests contained errors and incorrect expectations. Independent QA corrected the loader and used a separate suite grounded in the actual workbook. Treat coding output and generated tests as work requiring review, not as an unattended correctness guarantee. The native screenshot command did not produce an image on this development machine; page-check details report that limitation. Browser verification was performed separately. Rehearse and resolve the renderer setup on the venue machine before claiming automatic visual verification.

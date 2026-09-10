# Models, context and MCP setup

Use the native app (`npm run zero dev`), or the browser address served by its
native core. A standalone Vite preview cannot save configuration or load models.

## Add or edit a model

1. Open **Settings → Providers → Add model**, or **Scoped Models → Add local model**.
2. Give the model a unique catalogue id and display name. Browse to its existing
   GGUF file. For vision/OCR, also select the matching mmproj GGUF.
3. Select the capabilities it actually supports. These choices determine which
   routing menus offer the model. Choose **Routing** to assign it to work.
4. Save. Use **Restart model runtime** in Scoped Models to apply catalogue or
   path changes. Resident models unload; active tasks must finish first.

Each model card now has an Edit button. Editing preserves its extra preset
options. Duplicate ids are refused by Add, and a failed save keeps the draft.
The core checks GGUF magic bytes and rejects missing files and tiny pointer files;
this is not a full tensor-integrity or model-compatibility test.

Other inference runtimes can be registered as a **private OpenAI-compatible
server**, subject to the existing network guard. Arbitrary Python weight files
are not accepted as llama.cpp models.

## Context beside Thinking Effort

Open the model/effort control on the right of the composer. Its **Context** section offers:

- **Auto · fit hardware**: the default. llama.cpp uses its native memory fitter
  with automatic context, one sequence, and headroom for runtime buffers and the
  vision projector. There is no app-imposed 64K ceiling. The GGUF training limit
  is the upper bound; the available memory at load determines the fitted size.
  It favors GPU residency and can move layers into system RAM if the model cannot
  fit entirely on the GPU, even at the minimum automatic context.
- **Custom**: type an exact positive token count or choose a preset/Max. The upper
  bound is the model's training context, read from its GGUF header when available.
  A small GPU does not lower this control's maximum. The runtime keeps the
  requested context and may move model layers to CPU/system RAM, reducing speed.
  A request that cannot fit total available memory may still fail to load; the
  chosen value remains saved so it can be adjusted.

Apply saves the choice for that model and restarts the local runtime. Changes are
disabled while tasks are active. Other models keep their own choices. The card
shows the running context reported by `/props`, and chat compaction uses that same
window. Context and thinking effort are separate controls.

For a private server, this control sets the app's conversation budget; the server
must already support that context size. It cannot reconfigure a remote runtime.

Use a llama.cpp build supporting `--fit`, `--fit-target`, `--fit-ctx`, automatic
GPU layers and router-mode `/props?model=...`. See the
[llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
The hardware/model combination still needs a real load and chat rehearsal.

## Add MCP servers

Open **Settings → Tools → MCP servers**.

**Existing local server:** choose an executable, or enter a PATH command such as
`node` or `python`. Enter one argument per line, or a JSON string array to preserve
empty arguments. Configure its optional working directory and JSON environment.
Use `{"TOKEN":"${MY_TOKEN}"}` to resolve a credential from the app's launch
environment without storing the credential value. Add and then **Check tools**.

**Install npm package:** enter a package such as
`@modelcontextprotocol/server-filesystem`, optionally with `@version`, and its
server arguments. Node and npm must already be installed. Public egress must be
enabled in **System** for the explicit installation. The installer uses a separate
folder, disables lifecycle scripts/audit/funding requests, and saves an exact
dependency lock. Later MCP sessions run the installed entry file directly and
do not use npx or download packages. Public egress can then be blocked again.
Packages needing install scripts or multiple executable entry points need manual
installation and an explicit local server configuration.

**Import JSON:** accepts a standard `mcpServers` map or a single stdio definition.
An npx definition opens the npm setup form for review; it does not execute on
import. Import npm servers one at a time. HTTP/SSE server configurations are
explicitly rejected because this workbench currently supports local stdio MCP.

Check tools starts the server and shows its advertised tools or a readable error.
The client uses [standard newline-delimited MCP stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
returns argument schemas to the agent, follows tool-list pagination and handles
server pings. Timed-out connections are discarded. Disabling, editing or removing
a server closes its old session. Agent tool calls retain their existing approvals.
Removing a configuration does not delete installed package files.

## Validation

Frontend regression tests cover model-save failures, vision/projector validation,
file picking, MCP imports, exact arguments, installation retry, settings ordering,
custom context bounds and runtime restart errors. Run `npm run check`.

Native tests cover MCP framing and server requests, bounded responses, npm package
validation, atomic catalogue writes, portable paths, context persistence, GGUF
training limits and automatic/manual presets. Run:

```powershell
cargo test --locked --manifest-path src-tauri/Cargo.toml
```

The Windows validation workflow runs both checks on pull requests. A passing
build does not establish GPU fit or OCR accuracy. On the target laptop, add and
load a real custom model, try Auto and a larger Custom context, restart the app to
verify persistence, and connect/check/call/disable one local MCP server.

# Modifications to Nerve

This file is the itemized modification notice required by Apache-2.0 Section
4(b). ZeroLeak AI is a derivative work of
[Nerve](https://github.com/ThilinaTLM/nerve) (Copyright © 2026 ThilinaTLM,
Apache-2.0).

**Upstream baseline:** `265be58` — `fix(ci): stabilize cross-platform release
checks (#276)`, Nerve v0.26.0.

Nerve is the authoritative UI and harness implementation. Every surface not
listed below is retained unmodified: the workbench application, UI kit, design
tokens, Outfit/Iosevka typography, spacing, colour, light/dark themes,
component states, panels, docks, composer, window controls, status bar,
keyboard shortcuts, dialogs, loading states, responsive behaviour, animation,
contracts, protocol, harness, storage architecture, memory, context,
compaction, transcripts, artifacts, provenance, skills, tool execution,
suggestions, plans, permissions, tasks, and settings pages.

An unmodified copy of the upstream tree is kept at `../_nerve_reference` for
side-by-side audit. `git diff` against it enumerates the complete change set.

**Current change surface:** 155 tracked files differ from upstream (1,012
insertions, 388 deletions), plus 20 new files (5,937 lines) — 18 of them source
and tests (5,376 lines), the other two this notice and the Windows baseline
record, both under `docs/zeroleak/`. One tracked file carries the
test-hermeticity fix in §1. Twenty tracked files and all 18 new source files
carry the local-only provider surface in §3 and the local model lifecycle in
§4 — three of those twenty also carry a branding substitution. The remaining 134
carry the branding and derivation changes in §2.

---

## 1. Test harness portability

| File                                                    | Change                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/tools/test/git/git-service-workflows.test.ts` | Pin `core.autocrlf=false` and `core.eol=lf` for fixture repositories. |

**Why.** The fixture pinned `user.name`/`user.email` per repository for
determinism but inherited the host's global `core.autocrlf`, which Git for
Windows defaults to `true`. Committed fixture content was therefore checked out
CRLF-translated and compared against LF expectations, so three tests failed on
Windows regardless of product behaviour. The flags are applied both per-command
(so `clone` and `init` materialise the working tree verbatim) and persisted into
each repository (so the `GitService` calls under test, which spawn Git without
the fixture's flags, keep reading content back byte-exactly).

This is a test-hermeticity fix only. No product code was changed, and behaviour
on Linux and macOS is unchanged.

---

## 2. Branding

Product name, application identity, window and tray presentation, installer
metadata, and the on-disk state directory become ZeroLeak AI.

### 2.1 Application identity

| File                                                                                                        | Change                                                                                                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop-shell/src/desktop-identity.ts`                                                            | `DESKTOP_APP_NAME` → `ZeroLeak AI`; `DESKTOP_APP_ID` → `ai.zeroleak.workbench`; `MACOS_TRAY_GUID` regenerated (a distinct application must not reuse another application's tray GUID).                   |
| `packages/desktop-shell/electron-builder.yml`                                                               | `appId`, `productName`, `executableName` (`zeroleak-desktop`), `artifactName`, `copyright` (retains ThilinaTLM's Nerve copyright), Linux `maintainer`, and the Linux `.desktop` entry `Name`/`Keywords`. |
| `packages/desktop-shell/package.json`                                                                       | `bin` key and `desktopName` renamed `nerve-desktop` → `zeroleak-desktop`.                                                                                                                                |
| `packages/desktop-shell/src/bin.ts`, `scripts/verify-npm-tarballs.mjs`, `scripts/smoke-desktop-package.mjs` | Follow the executable rename.                                                                                                                                                                            |
| `package.json`                                                                                              | Root workspace `name` → `zeroleak-ai`.                                                                                                                                                                   |
| `packages/workbench-app/vite.config.ts`, `packages/workbench-app/index.html`                                | PWA manifest `name`/`short_name`/`description` and document title.                                                                                                                                       |
| `assets/brand/*.svg`                                                                                        | Accessible `<title>` text only. The artwork geometry is unchanged — see §2.5.                                                                                                                            |

### 2.2 State directories

The portable home moves from `~/.nerve` to `~/.zeroleak`, and the
project-scoped resource directory from `<project>/.nerve/` to
`<project>/.zeroleak/`.

| File                                                                                    | Change                                                  |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `packages/desktop-shell/src/daemon/profile.ts`                                          | Default home → `~/.zeroleak`.                           |
| `packages/workbench-server/src/infrastructure/storage-bootstrap/paths.ts`               | `resolveDataDir` default → `~/.zeroleak`.               |
| `packages/workbench-server/src/domains/agents/prompting/resource-loader.ts`             | `NERVE_DIR_NAME` → `.zeroleak`.                         |
| `packages/workbench-server/src/domains/prompt-suggestions/prompt-suggestion.service.ts` | Same directory constant.                                |
| `packages/workbench-server/src/infrastructure/configuration/project-configuration.ts`   | Project config path → `.zeroleak/config`.               |
| `packages/workbench-server/src/domains/permissions/project-permissions.repository.ts`   | Project permissions path.                               |
| `packages/workbench-server/src/domains/permissions/permission-policy.service.ts`        | Project permissions path.                               |
| `packages/workbench-server/src/domains/task-definitions/task-definition.repository.ts`  | Project task-definition path.                           |
| `packages/workbench-app/.../CreatePromptSuggestionDialog.svelte`                        | Displayed suggestion paths.                             |
| `.gitignore`                                                                            | Adds `.zeroleak` alongside the retained `.nerve` entry. |

**Environment variable.** `ZEROLEAK_HOME` is the documented override.
`NERVE_HOME` is still honoured as a fallback so an existing Nerve home can be
pointed at without renaming it:

```ts
const explicitHome = env.ZEROLEAK_HOME ?? env.NERVE_HOME;
```

**Legacy import is unaffected.** `data-directory-migration.ts` carries only
dialog copy changes. The offline migrator still accepts exactly the released
Nerve 0.26 `nerve-workbench-state` v2 layout and still stages into a
`nerve-home` v1 home; the storage format identifiers are deliberately retained
(§2.4), so a home written by upstream Nerve remains readable.

### 2.3 User-facing prose

`Nerve` was replaced with `ZeroLeak AI` in user-visible strings across the
tree. The replacement used the case-sensitive word-boundary pattern
`\bNerve\b`, which by construction cannot touch CamelCase identifiers
(`NerveMessage`, `NerveErrorCode`, `NerveHomeManifest`, `buildNerveSystemPrompt`,
`NerveMark`, `NerveBadge`, …) because the trailing boundary fails against a
following word character, and cannot touch lowercase identifiers (`nerve-faux`,
`nerve.sqlite`, `cm-nerve-*`, `@nervekit/*`) because it is case-sensitive. Only
the literal `"Nerve Protocol"` needed explicit masking, since the protocol name
is retained.

Two greps verify the pass: no occurrence of `ZeroLeak AI[A-Za-z]` anywhere
(nothing was mangled mid-identifier), and every surviving `Nerve*` token is one
of the intended retained identifiers below.

`NOTICE`, `README.md`, `AGENTS.md`, and `docs/**` were rewritten rather than
mechanically substituted, because they had to state the derivation, the
air-gapped posture, and the corrected default paths.

### 2.4 Identifiers deliberately retained

These are **not** user-facing. Retaining them preserves attribution, keeps the
fork mergeable with upstream, and keeps existing on-disk and on-the-wire data
readable.

| Kind                    | Retained value                                                                                                                                                                                                | Reason                                                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace package names | `@nervekit/contracts`, `@nervekit/harness`, `@nervekit/ui-kit`, … and their `author`/`repository`/`homepage`/`description` metadata                                                                           | Private workspace packages; they are Nerve's code and the metadata is attribution.                                                                                                                         |
| Type and function names | `NerveMessage`, `NerveMessageKind`, `NerveErrorCode`, `NerveHome*`, `NervePaths`, `NerveDependencies`, `NerveDesktopBridge`, `buildNerveSystemPrompt`, `NerveSimpleStreamDefaults`, `NerveMark`, `NerveBadge` | Source-internal. Renaming them would produce a large diff against upstream with no user-visible effect.                                                                                                    |
| Protocol                | media type `application/vnd.nerve.protocol.v1+json`; the name "Nerve Protocol"; the `codec.ts` version error string                                                                                           | Wire compatibility. The protocol is Nerve's, and renaming it would break interoperability with Nerve clients.                                                                                              |
| Storage format ids      | `nerve-home`, `nerve-workbench-state`, `nerve-storage-migrations`, `data/nerve.sqlite`                                                                                                                        | On-disk compatibility; changing them would make existing homes unreadable and fail closed at startup.                                                                                                      |
| Theme                   | theme id `nerve`, selector `:root[data-theme="nerve"]`, and its design tokens                                                                                                                                 | The requirement is that themes stay pixel-identical. Only the human-readable label in `ThemePreviewPicker.svelte` changed, to `ZeroLeak` — single-word, matching the neighbouring `Ocean`/`Forest` labels. |
| CSS class prefixes      | `cm-nerve-*`, `.nerve-badge`                                                                                                                                                                                  | Internal styling hooks.                                                                                                                                                                                    |
| Faux provider           | provider id `nerve-faux`                                                                                                                                                                                      | Test and development fixture id referenced by stored data.                                                                                                                                                 |
| Release infrastructure  | `Nerve Release Bot` in `.github/workflows/tag-release.yml`; the `Nerve Test` git fixture author                                                                                                               | Upstream's signing identity and a test fixture; neither ships.                                                                                                                                             |

### 2.5 Artwork retained

`assets/brand/nerve-mark.svg`, `nerve-mark-small.svg`, and `nerve-app-icon.svg`
keep Nerve's exact path geometry, viewBox, and colours. Only the accessible
`<title>` element changed. The requirement that the application be visually
identical to Nerve governs here; substituting different artwork would violate
it. The files also keep their `nerve-*` filenames so the diff against upstream
stays reviewable.

### 2.6 Not yet branded

`packages/website` (the marketing and documentation site, roughly 200
occurrences) is unchanged. It is not part of the desktop application and is not
built by `pnpm desktop`. Its `NERVE_HOME` and `~/.nerve` references are
consequently stale relative to §2.2.

### 2.7 Formatting, and one regression

`pnpm check` initially failed on 25 files: `ZeroLeak AI` is longer than
`Nerve`, so substituted lines exceeded oxfmt's print width. The repository's own
formatter (`oxfmt`) reflowed them; no manual reformatting was applied.

One genuine regression was introduced and fixed. In
`packages/workbench-app/src/lib/features/settings/views/pages/transcription/transcription-settings.test.ts`
the vocabulary fixture used `"Nerve"` and `"nerve"` as a case-variant pair to
exercise case-insensitive deduplication. The case-sensitive replacement rewrote
only the capitalized form, so the pair stopped being a duplicate and the
assertion saw three values instead of two. The lowercase member was updated to
`zeroleak ai`, restoring the intended pairing.

---

## 3. Local-only provider surface

**Approved change 3.** ZeroLeak AI must not present — and must not be able to
reach — a public cloud model provider. Upstream Nerve builds its model registry
from `builtinModels()` in `@earendil-works/pi-ai/providers/all`, which installs
pi-ai's complete hosted catalogue (Anthropic, OpenAI, Google, xAI, Groq,
Bedrock, Vertex, Azure, and the rest) into a process-wide registry at import
time. That import is removed from every call site. The registry now starts
empty and is populated only from local runtimes the operator has configured:
llama.cpp, Ollama, vLLM, an approved local Python inference server, and
optional private on-premise OpenAI-compatible endpoints.

Nerve's provider architecture is otherwise intact. A local runtime is an
ordinary pi-ai `Provider`, built with pi-ai's own `createProvider`, installed
into pi-ai's own `MutableModels`, discovered through pi-ai's `refreshModels`
publication protocol, and resolved by Nerve's existing `resolveAgentModel`
precedence (custom model → scripted provider → registry → `nerve-faux`
fallback). Persistence goes through Nerve's `writeHomeConfiguration`; the
protocol through Nerve's `defineOperation`; the settings UI is composed from the
same `SettingsEntityListSection` and `SettingsListItem` primitives as the
upstream Custom providers and Custom models sections. No new visual language is
introduced.

### 3.1 Cloud catalogue removal

| File                                                          | Change                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/src/models/model-registry.ts`               | `builtinModels()` → `createModels()`. `builtinProviderIds` starts empty, so it now means "provider registered with the harness" rather than "provider pi-ai ships". `apiStreams` is exported so application-owned providers stream through the same dispatch table as registry-owned ones. Adds `unregisterManagedProvider(id)`, so a disabled or deleted runtime leaves the model picker at once. |
| `packages/workbench-server/src/app/runtime/server-runtime.ts` | The shared pi-ai `Models` instance is built by `localModels({ runtimes: localRuntimes.runtimes(), credentials })` instead of `builtinModels({ credentials })`. A `LocalRuntimeStore` is constructed before it (its runtime list is what the registry is built from) and `attach()`ed to it afterwards; it is exposed on `ServerRuntime` and on both adapter contexts.                              |
| `packages/workbench-server/src/domains/auth/auth-manager.ts`  | The default `models` becomes `localModels({ credentials, runtimes: [] })`: a caller that supplies no registry gets an empty one rather than the hosted catalogue. `listProviderMetadata` reports `ZEROLEAK_<RUNTIME_ID>_API_KEY` for a local runtime — resolved through the new `isLocalRuntimeProvider(provider)` predicate — instead of the cloud env-var table's guess at a name.               |

`providerEnvVarName()` keeps its table of cloud environment-variable names. It
is unreachable for local runtimes after the change above, and no cloud provider
is ever registered, so it is left in place to keep the diff minimal.

### 3.2 Contract — `@nervekit/contracts`

| File                                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/domains/providers/local-runtimes.ts`    | **New** (203 lines). `localRuntimeKindSchema` (`llama-cpp`, `ollama`, `vllm`, `python`, `onprem-openai`), `localModelDiscoverySchema` (`openai-models`, `ollama-tags`, `none`), `localRuntimeSchema`, `localRuntimeProbeSchema`, `localRuntimeCatalogSchema`, the three request schemas, `localRuntimePresets`, `localRuntimeKindLabel()`, `defaultLocalRuntimes()`, and `defaultLocalRuntimeCatalog`.                                                                                               |
| `packages/contracts/src/domains/providers/index.ts`             | Re-exports the new module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/contracts/src/domains/providers/operations.ts`        | Four operations appended to `providersOperationDefinitions`: `localRuntime.list` (read), `localRuntime.upsert` (mutation), `localRuntime.delete` (mutation), `localRuntime.probe` (read). Declared with Nerve's own `defineOperation`, targeting `workbench_server`, following upstream's permission convention (`recommended` for mutations, `none` for reads).                                                                                                                                     |
| `packages/contracts/src/domains/settings/home-configuration.ts` | Adds `localRuntimeConfigSchema` and an optional `localRuntimes` array on `providersConfigSchema`. Headers use the same `headerConfigSchema` credential-reference form as custom providers, so an on-premise gateway token lives in the secret store rather than in `providers.json`. The key is optional on purpose: absent means the home has never been seeded (the store writes the preset set), while an explicit `[]` means the operator removed every runtime and must not have them restored. |

### 3.3 Provider implementation — `@nervekit/harness`

| File                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/src/models/local-runtimes.ts` | **New** (440 lines; the per-model record handling in it is §4's, and the shared HTTP plumbing it originally carried was extracted to `local-runtime-http.ts` in §4). `createLocalRuntimeProvider(runtime, options?)` builds a pi-ai `Provider` whose `refreshModels` performs discovery and publishes the result through pi-ai's `publication.update()` protocol. Discovered models are priced at zero on every axis (input, output, cache read, cache write), carry the runtime's configured headers, and honour a server-reported context length, falling back to `DEFAULT_LOCAL_CONTEXT_WINDOW` (32768) and `DEFAULT_LOCAL_MAX_TOKENS` (4096). Auth is deliberately asymmetric: a keyless loopback server resolves as configured with no credential and offers no interactive login, while a runtime marked `requiresApiKey` stays unconfigured until a token is stored, preferring a stored token over `ZEROLEAK_<ID>_API_KEY`. `probeLocalRuntime()` reports reachability, round-trip latency, and served model ids, and reports a transport or HTTP failure rather than throwing. `localRuntimeDiscoveryUrl()` maps `openai-models` to `<baseUrl>/models` and `ollama-tags` to the host's `/api/tags`. `localModels()` returns a pi-ai `MutableModels` holding exactly the enabled runtimes. `isLocalRuntimeProvider()` reports provenance from a `WeakSet` populated at construction, so a caller holding only a `Provider` can still tell it came from a local runtime. |
| `packages/harness/src/models/index.ts`          | Re-exports the new module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

### 3.4 Persistence and protocol — `@nervekit/workbench-server`

| File                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-server/src/domains/providers/local-runtime.store.ts`               | **New** (237 lines; the `attachModelConfiguration()` / `resync()` pair in it is §4's). `LocalRuntimeStore` owns the configured runtimes in `config/providers.json` under `localRuntimes`, writing through Nerve's `writeHomeConfiguration`. It reads its state in the constructor rather than in a hydration step because `server-runtime` needs the runtime list before it can build the shared `Models` instance; the home configuration is already in memory by then, so no I/O is involved. `#syncRegistry()` reconciles both pi-ai registries after every edit, so enabling, disabling, editing, or deleting a runtime takes effect without a restart, and then schedules a best-effort `refresh` (which reports errors in its result rather than rejecting, so a currently switched-off endpoint cannot fail the edit that enabled it). `probe()` resolves the stored token, delegates to the harness probe, and answers "This runtime is not configured." for an unknown id without contacting anything. |
| `packages/workbench-server/src/domains/providers/index.ts`                             | Exports `LocalRuntimeStore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/workbench-server/src/domains/providers/provider-catalog.store.ts`            | Bug fix made necessary by the new key. `write()` reconstructed the `providers` block from the validated custom-provider catalog plus `authentication`, so any `localRuntimes` already on disk was dropped — silently removing every configured local endpoint whenever a custom provider was saved. It now carries `localRuntimes` through unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/workbench-server/src/adapters/protocol/handlers/platform-method-handlers.ts` | Handlers for the four operations. `localRuntime.delete` also deletes the runtime's stored API key. Both mutations publish `providerCatalogChanged`, reusing the notification the custom-provider handlers already use.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/workbench-server/src/app/bootstrap/create-server-adapter-contexts.ts`        | Threads `localRuntimes` through `AdapterInfrastructure` into the platform method context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/workbench-server/src/app/runtime/server-runtime.ts`                          | See §3.1.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 3.5 Providers settings UI — `@nervekit/workbench-app`

Paths below are relative to `packages/workbench-app/src/lib`.

| File                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/settings/views/pages/providers/LocalRuntimesSection.svelte`  | **New** (211 lines). The Local runtimes section: a per-runtime enable/disable `Switch`, Test (probe) reporting reachable/unreachable and served models through `SettingsInlineMessage`, Edit, and Delete behind the shared `ConfirmDialog`. Built from `SettingsEntityListSection` and `SettingsListItem` — the same primitives as the upstream Custom providers section.                                                                                                                                                                           |
| `features/settings/views/pages/providers/LocalRuntimeDialog.svelte`    | **New** (433 lines). Add/edit dialog: kind, display name, base URL, API surface, discovery mode, token requirement, headers, and compatibility overrides, with the token written through the existing `setProviderApiKey` / `getCredentialKey` path. `LOCAL_API_ITEMS` deliberately offers a narrower list than pi-ai's `piApiSchema` — OpenAI Chat Completions, OpenAI Responses, Anthropic Messages — because the hosted-only surfaces (Azure, Vertex, Bedrock, Codex) can never apply, even though the stored contract can still represent them. |
| `features/auth/api/local-runtime.api.ts`                               | **New** (28 lines). Client bindings for the four operations, through Nerve's `protocolRequest`.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `features/settings/views/pages/providers/ProvidersSettingsPage.svelte` | Inserts `LocalRuntimesSection` between the upstream API keys and Custom providers sections. No upstream section is removed, renamed, or reordered.                                                                                                                                                                                                                                                                                                                                                                                                  |
| `features/settings/views/pages/providers/ApiKeysSection.svelte`        | Adds local-runtime ids to the existing `reserved` set, so a runtime's token is managed in exactly one place — its own section — rather than appearing twice.                                                                                                                                                                                                                                                                                                                                                                                        |
| `features/settings/state/provider-catalog-state.svelte.ts`             | Adds `localRuntimes` to the shared catalog state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `features/settings/state/provider-catalog-actions.svelte.ts`           | Loads the runtime catalog alongside the provider catalog in the same single-flight request.                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `features/settings/registry/settings-pages.ts`                         | Registers the `local-runtimes` section anchor on the Providers page, between `api-keys` and `custom-providers`, so the section is reachable from the settings navigation and from search. (The `local-models` anchor beside it is §4’s.)                                                                                                                                                                                                                                                                                                            |
| `api.ts`                                                               | Re-exports the new types and the new API module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### 3.6 Runtimes seeded into a new home

Nothing is contacted until a runtime is probed or a model is selected, so
seeding all five costs nothing.

| Runtime                               | Base URL                    | Discovery       | Enabled                  |
| ------------------------------------- | --------------------------- | --------------- | ------------------------ |
| llama.cpp                             | `http://127.0.0.1:8080/v1`  | `openai-models` | yes                      |
| Ollama                                | `http://127.0.0.1:11434/v1` | `ollama-tags`   | yes                      |
| vLLM                                  | `http://127.0.0.1:8000/v1`  | `openai-models` | yes                      |
| Local Python runtime                  | `http://127.0.0.1:8081/v1`  | `openai-models` | yes                      |
| On-premise OpenAI-compatible endpoint | `http://127.0.0.1:9000/v1`  | `openai-models` | no — needs a token first |

Every preset addresses the loopback interface, and the only preset that needs a
credential ships disabled so it cannot be reached before one is stored. Both
properties are asserted, over the whole preset list, in
`local-runtime-validation.test.ts`.

### 3.7 Tests

**New suites** — 51 cases, all passing. (The same three files now hold 59; the 8 added to `local-runtimes.test.ts` cover §4 and are described in §4.7.)

| File                                                                           | Cases                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/test/providers/local-runtime-validation.test.ts`           | 20 — schema defaults and rejections; preset invariants (loopback only, one preset per kind, distinct id and port per runtime, credential-requiring preset disabled); catalog versioning.                                                                                                                  |
| `packages/harness/test/models/local-runtimes.test.ts`                          | 20 — discovery URLs; probe success, HTTP failure, transport failure, and discovery-disabled; header and token propagation; the four auth resolution paths; zero pricing; reported context length; `localModels` installing only enabled runtimes.                                                         |
| `packages/workbench-server/test/domains/providers/local-runtime.store.test.ts` | 11 — seeding; the explicitly-emptied list; header round-tripping through the credential form; upsert, replace, and remove persistence; registry reconciliation on enable, disable, and delete; probe of an unknown and of an unreachable runtime; and the `ProviderCatalogStore` preservation regression. |

**Rewritten upstream suites.** Withdrawing the hosted catalogue invalidated the
fixtures of three upstream tests. Each was rewritten to assert the same property
against the air-gapped equivalent. No assertion was weakened, and none was
deleted.

| File                                                                           | Why it had to change, and what it asserts now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/harness/test/models/resolution.test.ts`                              | Upstream asserted that `listAvailableModels()` returns OpenRouter's registered catalogue beyond its first eight models — a property of pi-ai's builtin OpenRouter provider, which no longer exists. The non-truncation property is now asserted against a local runtime serving twelve models, with an exact length comparison (stronger than upstream's `> 8`), and a second case asserts the point of the change: the only provider the registry reports is `nerve-faux`.                                                                                                                                                                                               |
| `packages/workbench-server/test/adapters/http/auth.test.ts`                    | Two of six cases depended on the hosted catalogue: one resolved request routing through a cloud provider's model, the other asserted that a subscription provider is advertised. They were rewritten as the air-gapped equivalents — a token-protected on-premise gateway's api key, base URL, and gateway headers all survive `requestAuthForPiModel`; and `listProviderMetadata` advertises the configured runtime with `ZEROLEAK_ONPREM_GATEWAY_API_KEY` while offering no OAuth provider at all. The other four cases are untouched.                                                                                                                                  |
| `packages/workbench-server/test/domains/agents/auto-compaction-runner.test.ts` | The fixture selected `xai/grok-build-0.1` for its 256k context window, which the runner read out of the builtin catalogue; with no catalogue it fell back to `nerve-faux`'s 128k window and the comparison failed. The fixture now supplies the window the way the workbench does at runtime — through the runner's `customModels` dependency — using `local-vllm/qwen3-32b` (256k) and `local-llama-cpp/gemma3-27b-it` (400k). Every assertion value is unchanged (`contextWindow` 256000, `thresholdTokens` 204800, `keepRecentTokens` 38400, `contextTokens` 205000), and the suite still proves the _selected_ agent's window is used rather than the active agent's. |

### 3.8 Deliberately unchanged

- The Subscriptions and API keys sections of the Providers page are retained in
  full, as is `AddProviderDialog`. All three are data-driven from the provider
  metadata the server reports, so with no cloud provider registered they simply
  list nothing. No upstream surface was deleted to reach the air-gapped result.
- `modelDefinitionSchema` and the Scoped Models page are untouched. A model can
  still be added by hand for a runtime whose discovery is set to `none`.
- pi-ai's `piApiSchema` is not narrowed — only the dialog's offered list is — so
  a configuration naming another API surface still parses.
- OAuth flow management, `PiAiCredentialStore`, and the encrypted secret store
  are unchanged apart from the branding prose in §2.3.
- The Atlassian, Jira, Confluence, and Tavily integration-credential sections
  are left in place. They are integration credentials rather than model
  providers, and removing them was not among the approved changes.

---

## 4. Local model lifecycle management

**Approved change 4.** A local runtime answers a discovery request with little
more than a list of model ids, and what it does say about a model is often wrong
about the weights actually loaded — `/v1/models` reports the architecture's
training context length, not the `--ctx-size` the process was started with.
§3 made the runtimes reachable; this change makes the models on them
administrable. An operator can import a model by hand, override the capabilities
a model picker depends on, switch a model off without discarding its
configuration, ask a model to complete a real prompt, and — where the runtime
permits it — load and unload its weights.

Nothing here reports a fact it did not obtain. Residency is `unknown`, with a
reason, when a runtime cannot be asked; a runtime that binds its weights at
process start says so rather than offering a load button that cannot work; and
the model test issues an actual completion rather than another metadata request,
because reaching a server proves nothing about whether its weights can emit a
token. The surface is composed from the same `SettingsSection`,
`SettingsListItem`, `SettingsInlineMessage`, `Switch`, and `ConfirmDialog`
primitives as §3 and as the upstream Custom models section. No new visual
language is introduced.

### 4.1 Capability resolution

One rule decides every capability of every local model. It is stated once, in
`resolveLocalModel()`, and applied in all three places that need it — the pi-ai
model handed to the inference path, the inventory row rendered in settings, and
the dialog's placeholder text:

> the operator's override, then what the runtime reported, then the air-gapped
> default.

An override wins over discovery for the reason above: the operator knows what the
process was started with and the runtime frequently does not. The function is
exported rather than duplicated because the settings page must show the values
the model will actually be given at inference time, and one rule in one place is
the only way those two are guaranteed to agree. An empty field in the dialog
stores no override at all, so it keeps meaning "use what the runtime reports"
rather than silently pinning whatever the runtime happened to report when the
dialog was opened.

### 4.2 Residency: what can and cannot be controlled

`localRuntimeControlsResidency(kind)` is the single predicate, and it is true
only for Ollama. Ollama keeps a model pool and accepts a `keep_alive` per
request, so residency there is a setting; llama.cpp, vLLM, and a local Python
runtime bind their weights when the process starts, so residency there is a
fact. The server and the settings page read the same predicate, so the UI never
offers a control the backend would have to refuse.

| Runtime kind                                   | Residency read from                                                                                                                           | Load / unload                                                                                                                                                                        |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `ollama`                                       | `/api/ps`, matching both the current `model` key and the legacy `name` key; reports resident size and eviction time when Ollama supplies them | `/api/generate` carrying a model and a `keep_alive` and nothing else — `5m` to load, `0` to evict — which is Ollama's own way to manage the pool without generating anything         |
| `llama-cpp`, `vllm`, `python`, `onprem-openai` | the runtime's discovery listing: a model it serves is resident, a model it does not serve is not                                              | not offered. The operation is still answered — with the real residency and a plain statement that the request changed nothing and the server must be restarted with the model wanted |

A load is never reported from the fact that the request succeeded. The status is
read back from the runtime afterwards, so a load the server accepted and then
dropped is visible rather than claimed.

### 4.3 Contract — `@nervekit/contracts`

| File                                                            | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/contracts/src/domains/providers/local-models.ts`      | **New** (199 lines). `localModelOverridesSchema` (`displayName`, `contextWindow`, `maxTokens`, `reasoning`, `input`, every field optional so an absent one keeps the discovered value); `localModelRecordSchema`, the stored record (`runtimeId`, `modelId`, `imported`, `enabled`, `overrides`); `localModelEntrySchema` and `localModelInventorySchema`, the reconciled inventory the settings page renders, carrying already-resolved values so no client repeats the merge; `localModelResidencySchema` (`loaded` / `unloaded` / `unknown`) and `localModelStatusSchema` (residency, `controllable`, optional `sizeBytes`, `expiresAt`, `detail`, `error`); `localModelTestResultSchema` (`ok`, `latencyMs`, `sample`, `error`); the five request schemas; `localModelKey(runtimeId, modelId)`, because two runtimes commonly serve the same model id — the same GGUF behind llama.cpp and behind Ollama — so nothing may be keyed by model id alone; and `localRuntimeControlsResidency()` per §4.2. |
| `packages/contracts/src/domains/providers/operations.ts`        | Nine operations appended to `providersOperationDefinitions`: `localModel.list`, `.refresh`, `.status` and `.test` as reads, `.import`, `.update`, `.remove`, `.load` and `.unload` as mutations. Declared with Nerve's own `defineOperation` and carrying the same permission convention as the four runtime operations in §3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/contracts/src/domains/settings/home-configuration.ts` | Adds `localModelConfigSchema` and an optional `localModels` array on `providersConfigSchema`. Nothing in a model record is a secret, so — unlike a runtime's headers — it is stored literally rather than through the secret store. Absent and empty mean the same thing here, which is the opposite of `localRuntimes`: every discovered model is usable with no configuration at all, so there is nothing to seed and nothing the two cases could distinguish.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `packages/contracts/src/domains/providers/index.ts`             | Re-exports the new module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 4.4 Lifecycle implementation — `@nervekit/harness`

| File                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/harness/src/models/local-runtime-http.ts`    | **New** (137 lines). The HTTP plumbing now shared by discovery, residency, and the model test, extracted out of §3's `local-runtimes.ts` so all three phrase a failure identically — an operator reading `Ollama responded 404 Not Found` should not have to work out which subsystem said it. `requestLocalJson()` rejects with the runtime's own display name in the message, so any caller can hand the text straight to the UI, and `describeFetchError()` renders a timeout and an abort the same way because from the caller's side nothing answered in either case. Three timeouts, each sized by what the request does: `LOCAL_METADATA_TIMEOUT_MS` 4s (a loopback server either answers at once or is not listening), `LOCAL_COMPLETION_TIMEOUT_MS` 120s (a completion may have to fault weights in from a cold page cache first), `LOCAL_LOAD_TIMEOUT_MS` 300s (loading scales with model size). `nativeRootUrl()` climbs back off a `/v1` suffix, since Ollama serves its OpenAI-compatible surface there but its pool and catalog under `/api`. Deliberately not re-exported from the models barrel: this is internal plumbing, not harness API. |
| `packages/harness/src/models/local-model-lifecycle.ts` | **New** (420 lines). `localModelStatus()`, `loadLocalModel()`, and `unloadLocalModel()` implement §4.2. `testLocalModel()` sends `LOCAL_MODEL_TEST_PROMPT` (“Reply with the single word: ok”) capped at 24 tokens, in whichever of the three dialects the runtime is configured for — OpenAI chat completions, OpenAI responses, or Anthropic messages — and returns the measured latency plus a whitespace-collapsed sample capped at 160 characters, so a pass is visibly a completion rather than a green tick. A runtime that answers with no text is a failure, not a pass.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/harness/src/models/local-runtimes.ts`        | Extended, not restructured. `resolveLocalModel()` is exported for §4.1. `createLocalRuntimeProvider` gains `models`, the record set (records belonging to another runtime are ignored, so a caller may hand over the whole catalog), and `onDiscovered`, called with everything a discovery request returned and called before disabled models are filtered out. Imported, enabled records become the provider's static baseline, which is what lets a runtime with `discovery: "none"` offer anything at all, and pi-ai merges a later refresh over that baseline by model id, so an imported model the runtime eventually reports picks up whatever the runtime says about it. Disabled records are withheld from the published catalog.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/harness/src/models/index.ts`                 | Re-exports `local-model-lifecycle.js`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### 4.5 Persistence and protocol — `@nervekit/workbench-server`

| File                                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/workbench-server/src/domains/providers/local-model.store.ts`                 | **New** (342 lines). `LocalModelStore` owns the records in `config/providers.json` under `localModels`, written through Nerve's existing `writeHomeConfiguration`, and serves the residency and test operations. It keeps the last discovery result per runtime itself rather than reading it back out of the published pi-ai catalog, because a model the operator switched off is deliberately absent from that catalog and would otherwise be indistinguishable from a model the runtime had stopped serving. `inventory()` asks any enabled, discoverable runtime that has not yet been asked in this process before it answers, so `discovered` always reflects a real request rather than an assumption carried over from a cache, and a runtime whose discovery fails loses its remembered listing instead of keeping a stale one. Every write calls `runtimes.resync()`, which is what makes a configuration change reach the model pickers. A discovery failure never fails the request that triggered it. |
| `packages/workbench-server/src/domains/providers/local-runtime.store.ts`               | Gains the `attachModelConfiguration()` / `resync()` pair, so the runtime store can rebuild each provider with the current model records and a configuration edit takes effect without a restart.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/workbench-server/src/adapters/protocol/handlers/platform-method-handlers.ts` | Handlers for the nine operations. Every mutation publishes `providerCatalogChanged`, and so does `localModel.refresh` — refresh included because discovery replaces the runtime's published models even though nothing the operator stored has changed. `localRuntime.delete` now also calls `localModels.forgetRuntime()`, so a deleted runtime's model configuration does not outlive it in `providers.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/workbench-server/src/app/runtime/server-runtime.ts`                          | Constructs `LocalModelStore` after `LocalRuntimeStore`, wires the two together, passes the records and an `onDiscovered` callback into `localModels()`, and attaches both stores to the shared pi-ai `Models` instance.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/workbench-server/src/app/bootstrap/create-server-adapter-contexts.ts`        | Threads `localModels` through `AdapterInfrastructure` into the platform method context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `packages/workbench-server/src/domains/providers/index.ts`                             | Exports `LocalModelStore`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 4.6 Local models settings UI — `@nervekit/workbench-app`

Paths below are relative to `packages/workbench-app/src/lib`.

| File                                                                   | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `features/settings/views/pages/providers/LocalModelsSection.svelte`    | **New** (377 lines). The Local models section: one row per model, grouped by configured runtime, each runtime's own listing first and the models it is configured for but no longer serving after it. Each row carries an enable/disable `Switch`, Test, Configure, and Remove behind the shared `ConfirmDialog`, plus Status, Load, and Unload only where `localRuntimeControlsResidency` is true. Results appear through `SettingsInlineMessage`, newest reading first, and a per-runtime Refresh re-asks what that runtime is serving. |
| `features/settings/views/pages/providers/LocalModelDialog.svelte`      | **New** (265 lines). Import and configure in one dialog: runtime, model id, display name, context window, max tokens, reasoning, and image input. An empty capability field stores no override, per §4.1. Importing onto a runtime with discovery switched off cannot be verified against that runtime — such a runtime cannot be asked what it serves — so the dialog says so and points at the model test instead of implying a check it did not perform.                                                                               |
| `features/auth/api/local-model.api.ts`                                 | **New** (61 lines). Client bindings for the nine operations, through Nerve's existing `protocolRequest`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `features/settings/views/pages/providers/ProvidersSettingsPage.svelte` | Inserts `LocalModelsSection` directly after `LocalRuntimesSection`. No upstream section is removed, renamed, or reordered.                                                                                                                                                                                                                                                                                                                                                                                                                |
| `features/settings/registry/settings-pages.ts`                         | Registers the `local-models` section anchor beside `local-runtimes`, so the section is reachable from the settings navigation and from search.                                                                                                                                                                                                                                                                                                                                                                                            |
| `features/settings/state/provider-catalog-state.svelte.ts`             | Adds `localModels` to the shared provider catalog state.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `features/settings/state/provider-catalog-actions.svelte.ts`           | Loads the inventory in the same single-flight `Promise.all` as the provider and runtime catalogs. `applyLocalModelInventory()` adopts the inventory a mutation returned, since every mutation answers with the whole reconciled list and leaves nothing to re-fetch.                                                                                                                                                                                                                                                                      |
| `api.ts`                                                               | Re-exports the new types and the new API module.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### 4.7 Tests

**New coverage** — 54 cases, all passing.

| File                                                                         | Cases                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/harness/test/models/local-model-lifecycle.test.ts`                 | 23. Ollama residency read from the pool, from a listing that only carries the legacy `name` key, for a model it is not holding, and when the pool cannot be read; startup-loaded residency when the model is served, when it is not, when the runtime is unreachable, and when discovery is switched off; load and unload reading the result back from the runtime, a refused load, token and header propagation, and both operations reporting that they changed nothing on a startup-loaded runtime; the model test completing in all three dialects, an empty answer counting as a failure, latency measurement, sample truncation, and transport failure.                                                                                                                                                                                                                        |
| `packages/workbench-server/test/domains/providers/local-model.store.test.ts` | 23. Each discoverable runtime asked once before the inventory answers; runtime listing order and runtime grouping preserved; override resolution; a disabled model kept in the inventory so it can be switched back on; an imported model offered on a runtime that cannot be asked, and its flip to discovered once the runtime reports it; configuration retained for a model the runtime stopped serving; a failed discovery forgetting that runtime's listing; persistence to `providers.json` with the configured runtimes left intact; a toggle surviving an override edit and a re-import; removal for both imported and discovered models; a deleted runtime's records discarded; providers rebuilt so a configuration change reaches the model pickers; and the residency, load, and test paths against an endpoint that is not listening or a runtime that does not exist. |
| `packages/harness/test/models/local-runtimes.test.ts`                        | 8 added to the §3 suite. Overrides applied to a discovered model; a disabled model withheld from the published catalog; an imported model offered on a runtime that cannot be asked, kept across a discovery refresh, and withheld when switched off; a discovered model leaving the catalog once the runtime stops serving it; records belonging to another runtime ignored; and `onDiscovered` reporting what the runtime actually served, before filtering.                                                                                                                                                                                                                                                                                                                                                                                                                       |

No upstream suite needed rewriting for this change. The model records are a new
key in `providers.json` and a new argument with a default, so every existing
fixture still describes a valid configuration.

### 4.8 Deliberately unchanged

- Nerve's `resolveAgentModel` precedence is untouched. A local model reaches an
  agent through the registry exactly as in §3; nothing here adds a resolution
  path.
- The Custom models page and `modelDefinitionSchema` are untouched. Configuring a
  local model and hand-writing a model definition remain independent, and the
  latter is still the escape hatch for anything the former does not model.
- Pricing stays zero on every axis. A local model has no per-token cost, and
  making it configurable would invite a number that means nothing.
- No model is downloaded, converted, or quantised. Acquiring weights is the
  runtime's job — `ollama pull`, a GGUF placed on disk — and ZeroLeak AI
  administers what a runtime already serves rather than becoming a second
  package manager.

---

## 5. Local transcription

Transcription is retargeted from a hosted service to local speech-to-text.
There is no hosted path left: `transcription.service.ts` spawns the
`whisper-cli` binary (resolved from `ZEROLEAK_WHISPER_BIN`, defaulting to the
sovereign deployment layout at `C:/sovereign/runtime/whisper.cpp`), decodes the
captured WAV in a private temporary directory, and returns the transcript text.
Model weights are the multilingual ggml Tiny/Base/Small variants, resolved from
`ZEROLEAK_STT_MODELS_DIR` or the `models/stt` directory beside the checkout.

- The `transcriptionModelSchema` enum in `@nervekit/contracts` becomes
  `whisper-tiny | whisper-base | whisper-small`; a stored hosted model id is
  mapped to `whisper-base` on read so existing homes keep loading.
- Nerve's ChatGPT subscription transcription, its Codex OAuth dependency, the
  "Connect ChatGPT to use voice input" auth gate, and the voice-input setup
  guide are removed. Voice input needs no account.
- Expected languages become the whisper.cpp decoding language (first code
  wins, `auto` detects); vocabulary terms become the initial prompt.
- The settings page copy describes the local runtime instead of the OpenAI
  models.

---

## 6. Verification

Run on win32 x64, Node 24.13.1, pnpm 11.20.0, against the tree described above.

| Gate                                                                                     | Result                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run check` (oxfmt, eslint, package boundaries, per-package `svelte-check` / `tsc`) | pass. The 5 remaining `svelte-check` warnings (`AgentPreviewSection.svelte`, `ArgumentsSection.svelte`, `CompleteResultSection.svelte`, `StatusBar.svelte`) are upstream's — all four files are byte-identical to `../_nerve_reference`. |
| `pnpm run build`                                                                         | pass — every package, web assets copied into `workbench-server/dist/web`, export check clean.                                                                                                                                            |
| `npx electron-builder --dir --publish never` (in `packages/desktop-shell`)               | pass — produces `release/win-unpacked/zeroleak-desktop.exe`.                                                                                                                                                                             |
| `node --test "scripts/**/*.test.mjs"`                                                    | 44/44 pass                                                                                                                                                                                                                               |
| `pnpm --filter @nervekit/contracts test`                                                 | 127/127 pass                                                                                                                                                                                                                             |
| `pnpm --filter @nervekit/harness test`                                                   | 101/101 pass                                                                                                                                                                                                                             |
| `pnpm --filter @nervekit/workbench-app test`                                             | 478/478 pass                                                                                                                                                                                                                             |
| `pnpm --filter @nervekit/desktop-shell test`                                             | 79/79 pass                                                                                                                                                                                                                               |
| `pnpm --filter @nervekit/workbench-server test`                                          | 573 tests, 533 pass, 40 fail — see below                                                                                                                                                                                                 |
| `pnpm --workspace-concurrency=1 -r --no-bail --if-present test`                          | 9 of the 10 test-bearing packages pass; the tenth is `workbench-server`, with the failure set below.                                                                                                                                     |

**The `workbench-server` failures are the recorded Windows baseline, unchanged.**
Normalising both sides — dropping the `#` comments, the `✖ ` prefix, and the
per-test duration — and diffing against
`docs/zeroleak/windows-baseline-failures.txt`:

- **0 failures added.** Every failing name is already in the baseline.
- **0 baseline failures masked.** 50 of the 51 baseline names failed again; the
  fifty-first is the daemon-lease test described below, which passed in this
  run. The comparison is made set-against-set rather than by
  count: one baseline entry — `publishes, heartbeats, republishes, annotates,
and removes one lease` — is a timing-dependent daemon-lease test that passes
  or fails with host load, and has passed in some runs. It stays in the baseline
  rather than being removed from it.

The 40 reported failures and the 51 baseline names are not the same tally: the
run's `fail` count is leaf tests only, while the baseline was captured from the
full reporter output and so also names the 10 parent suites containing them.

See the platform note below for why these failures exist in the unmodified
upstream tree.

**Note on `-r` and bail.** `pnpm -r run` stops at the first failing package
(`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`). A truncated run reports fewer failures
than exist and must not be read as an improvement; `--no-bail` is required for
any comparison against the baseline.

---

## Platform note: upstream test coverage on Windows

Upstream Nerve runs its complete suite (`pnpm run test:full`) only on
`ubuntu-latest`. Its Windows CI job runs a deliberately narrow subset
(`pnpm --filter @nervekit/workbench-server test:migrations`). See
`.github/workflows/ci.yml`.

A set of `workbench-server` tests consequently fails on Windows in the
unmodified upstream tree, for host-environment reasons rather than product
defects — SQLite temp-directory teardown hitting Windows file locking
(`EBUSY` on `.sqlite`/`-shm`/`-wal`), and assertions written against POSIX
absolute paths. These failures are recorded in
`docs/zeroleak/windows-baseline-failures.txt`, captured from the upstream tree
before any ZeroLeak change, so that the effect of ZeroLeak's own changes can
be measured against it.

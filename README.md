# ZeroLeak AI

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

**An air-gapped, local-only desktop coding harness with the focus of a small agent and the workflow of a complete workbench.**

ZeroLeak AI keeps agent activity visible and gives you direct control over models, permissions, tools, approvals, Git, and background tasks while working with local projects. Every model runs on your own hardware: no request leaves the machine, and no public cloud provider is offered.

ZeroLeak AI is a derivative work of [Nerve](https://github.com/ThilinaTLM/nerve) by ThilinaTLM, used under the Apache-2.0 license. Nerve is the authoritative UI and harness implementation; see [`NOTICE`](NOTICE) and [`docs/zeroleak/MODIFICATIONS.md`](docs/zeroleak/MODIFICATIONS.md).

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="packages/website/src/assets/shots/d5-git-dark.webp">
  <img src="packages/website/src/assets/shots/d5-git-light.webp" alt="ZeroLeak AI desktop workbench showing a coding conversation, tool activity, and Git changes">
</picture>

> [!NOTE]
> ZeroLeak AI is beta software. It runs on Linux, Windows 11, and macOS and is distributed under the [Apache-2.0 license](LICENSE).

## Quick start

ZeroLeak AI is built and run from source so that the deployed binary can be
audited and installed inside an isolated network. It requires Node.js 24 or
newer, pnpm 11.20.0, and rustup; the Rust version is pinned in
`rust-toolchain.toml`.

```sh
pnpm install
pnpm desktop
```

ZeroLeak AI starts a local loopback daemon by default, and its application data
stays under `~/.zeroleak`. Use `pnpm dev` for the daemon and browser UI
development servers.

## Highlights

- Follow streaming messages, reasoning, tool calls, plans, approvals, questions, logs, and task output.
- Change the model, thinking level, agent mode, and permission policy without restarting a conversation.
- Work with conversations, files, Git changes, pull requests, project notes, and background tasks in one workbench.
- Configure providers, tools, global skills, and project resources from the UI.
- Run entirely on local model runtimes — llama.cpp, Ollama, vLLM, approved local Python runtimes, and optional private on-premise OpenAI-compatible endpoints.
- Import, configure, test, enable, disable, load, and unload local models from the UI.
- Transcribe audio with local speech-to-text models (Whisper.cpp Tiny/Base, Moonshine Tiny).
- Keep projects and ZeroLeak AI state local by default.

## Security posture

ZeroLeak AI is intended for isolated and air-gapped environments:

- No public cloud model provider is exposed in the product.
- Inference, transcription, and tool execution run on the local host or on an
  explicitly configured on-premise endpoint.
- Project data, conversations, memories, transcripts, and artifacts are stored
  locally under `~/.zeroleak` and the project's own `.zeroleak` directory.

Report vulnerabilities through the private channels in [`SECURITY.md`](SECURITY.md).

## Documentation

- [Architecture](docs/architecture/codebase.md)
- [Storage](docs/architecture/storage.md)
- [Modifications relative to Nerve](docs/zeroleak/MODIFICATIONS.md)
- [Release runbook](docs/runbooks/release.md)

Nerve's own product and developer documentation remains a useful reference for
every unmodified surface: <https://nerve.tlmtech.dev/>.

## Contributing, security, and license

Contributions are welcome. Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a change.

ZeroLeak AI is licensed under Apache-2.0. See [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE).

## Acknowledgements

ZeroLeak AI is built on [Nerve](https://github.com/ThilinaTLM/nerve) by
ThilinaTLM (Apache-2.0). If Nerve is useful to you, you can
[support its continued development on Patreon](https://www.patreon.com/cw/thilinatlm).

Nerve's model routing, provider integrations, and streaming are built on
[@earendil-works/pi-ai](https://github.com/earendil-works/pi), a unified LLM API
client by Mario Zechner (MIT license).

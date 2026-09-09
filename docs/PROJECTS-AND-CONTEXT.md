# Project folders and conversation context

The default home is `C:/zeroD`. `SOVEREIGN_HOME` still overrides it. An older
installation stays on `C:/sovereign` until its home is moved, so upgrading does
not silently create an empty database. On this workstation the old path is a
compatibility junction to `C:/zeroD`; it preserves historical links.

New managed projects use `projects/<project-name>/files`, with project
instructions and metadata alongside `files`. Names are normalized to lowercase
with hyphens, without random suffixes. Conflicting names are rejected instead of
merging workspaces. Existing project identifiers and folders remain intact.

Model context is automatically sized from the configured baseline, available
GPU capacity, KV-cache geometry and trained limit, up to the existing 65,536
token automatic cap. The generated `config/models.ini` records the configured
launch window; the catalogue baseline alone does not show the available context.

Compaction counts tool schemas once and still reserves output and safety space.
It preserves the current request across repeated compactions, including when
an older continuation summary is present. Continuation summaries now have up
to 2,048 output tokens and process the complete older transcript in bounded
segments, including tool-call arguments, instead of truncating it at 24,000
bytes. Summaries retain constraints, decisions, results and unfinished steps.

Summaries are lossy context, not source evidence. SQLite remains canonical;
transcript mirrors and project files remain local. Cross-turn history replay
still uses its existing bounded recent-history policy. These changes do not
promise unlimited recall or change the network policy.

`rebase-zeroD.py` is the one-time migration used after moving this workstation's
home. It backs up the canonical database and rebases live path fields, while
preserving historical transcripts and audit records. Run it with the app closed.

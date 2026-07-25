# Ground Control for Codex

A local-first, fail-closed workflow control plane for Codex.

The v0.1 package installs a reproducible, project-local engineering workflow
for Codex. It combines pinned Matt Pocock skills with a separate Ground Control
Router overlay and single-coordinator rules. The packed artifact can initialize,
diagnose, qualify, inspect provider state, and uninstall itself in a fresh Git
worktree without provider credentials, a second download, or network access.

Ground Control for Codex is an independent community project. It is not
affiliated with or endorsed by OpenAI.

## Requirements

- macOS
- Node.js 22 or newer
- Git

## Local package smoke test

```sh
npm pack
npm install --prefix /tmp/codex-ground-control \
  ./codex-ground-control-0.1.0.tgz
/tmp/codex-ground-control/node_modules/.bin/codex-ground-control --help
```

No package has been published by this repository.

## CLI

Run commands from an existing Git worktree:

```sh
codex-ground-control init --dry-run
codex-ground-control init
codex-ground-control doctor
codex-ground-control qualify
codex-ground-control provider
codex-ground-control uninstall
```

Add `--json` to a command to emit exactly one JSON receipt on stdout. Exit code
`0` means success, `2` means an operational blocker was detected, and `64`
means invalid command usage.

`init --dry-run` reports which managed files would be added, updated, or left
unchanged and performs no writes. A normal project-local installation:

- copies pinned, unmodified Matt Pocock skills into `.agents/skills/`;
- installs the Ground Control Router as a separate first-party overlay;
- appends one clearly marked managed block to `AGENTS.md`;
- records ownership, before/after SHA-256 hashes, release provenance, and the
  `AGENTS.md` backup association in `.codex-ground-control/manifest.json`.

Re-running `init` against the same release is idempotent. `doctor` verifies the
installed workflow, managed block, vendored bytes, release lock, and MIT license
hash. `uninstall` removes only unchanged files owned by Ground Control and
restores the exact pre-install project instructions. Drift fails closed and is
left untouched for the user to resolve.

Project-local installation remains the default. Without `--global`, commands
do not read or modify `~/.codex`, `~/.agents/skills`, or other user-level
targets.

### Explicit global installation

Use global scope only when the workflow should apply across projects:

```sh
codex-ground-control init --global --dry-run
codex-ground-control init --global
codex-ground-control uninstall --global
```

In an interactive terminal, global `init` and `uninstall` print a path-level
diff and require `y` or `yes`. Automation and JSON mode must add the separate
`--confirm-global` flag:

```sh
codex-ground-control init --global --confirm-global --json
codex-ground-control uninstall --global --confirm-global --json
```

Global scope manages only the bounded targets `~/.codex/AGENTS.md`,
`~/.agents/skills/`, and product state under `~/.codex-ground-control/`.
It refuses filesystem roots, a project rooted at the entire home directory,
symlinked roots and symlinked managed paths. There is no force option.

Before user configuration changes, global init creates a private, verifiable
backup under `~/.codex-ground-control/backups/<backup-id>/`. Receipts contain
the opaque backup ID and logical `~/` paths, never the previous instruction
contents or absolute home path. An interrupted install leaves a transaction
that blocks further init until confirmed global uninstall safely recovers it.

Backups are retained while an installation or recoverable partial transaction
exists and are consumed after successful restoration. Audit evidence under
`~/.codex-ground-control/evidence/` has separate ownership and is preserved by
ordinary uninstall. A missing or modified backup, manifest, managed block, or
tool-owned asset produces a conflict before destructive cleanup.

The `qualify` command runs a packaged deterministic fixture; `provider` reports
that no optional providers are configured.

## Matt Pocock skills provenance

`release-lock.json` records the upstream repository, exact revision, install
mapping, file sizes, SHA-256 hashes, aggregate content hash, and MIT license
source. The npm tarball carries those exact bytes under
`vendor/mattpocock-skills/`, so initialization never downloads a mutable second
copy.

Ground Control does not patch the vendored files. Product-specific routing and
authority rules live under `assets/overlays/`. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution and license
text.

## Development

```sh
npm run release-lock:verify
npm run typecheck
npm test
```

The acceptance suite packs and installs the real npm tarball into a temporary
home, creates a fresh Git repository, denies network calls in the CLI process,
and verifies dry-run, empty and existing project instructions, idempotent
initialization, explicit global confirmation, private backups, interrupted
install recovery, symlink fault injection, doctor integrity checks, drift
refusal, evidence retention, and exact restoration through the public
executable.

## License

MIT

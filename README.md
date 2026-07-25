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
- Codex CLI

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
codex-ground-control qualify verify <run-identity> <evidence-anchor>
codex-ground-control qualify reproduce <run-identity> <scenario-id>
codex-ground-control provider list
codex-ground-control provider enable pi-glm
codex-ground-control provider qualify pi-glm --allow-live
codex-ground-control provider run pi-glm analysis "Review this bounded input" --allow-live
codex-ground-control provider disable pi-glm
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

Re-running `init` against the same release is idempotent. `doctor` is read-only:
it verifies macOS, Node.js, the Git boundary, Codex CLI, the installation
manifest, managed block, vendored skills and release lock. It also reports
ambient hooks, native Codex entry points, Pi/AGY/Grok public CLI versions, and
the independent `core`, provider, `native`, and `write` gates. Provider
detection or credential presence never means enabled, authorized, or qualified.
Optional provider absence does not fail `core`.

Each doctor finding has a stable ID, severity, state, scope, observed summary,
and next action. Human output groups core, provider, and fail-closed boundary
findings; `--json` emits the same decision as one versioned object. Doctor does
not repair configuration, install providers, inspect credential values, or run
live qualification.

`uninstall` removes only unchanged files owned by Ground Control and restores
the exact pre-install project instructions. Drift fails closed and is left
untouched for the user to resolve.

Project-local installation remains the default. Without `--global`, `init` and
`uninstall` do not modify `~/.codex`, `~/.agents/skills`, or other user-owned
configuration. `doctor` only reads the presence and shape of
`~/.codex/hooks.json` and the two native entry-point flags in
`~/.codex/config.toml`, without printing their contents. Qualification evidence
and project-scoped provider preferences are the explicit product-owned
exception under `~/.codex-ground-control/`; they do not alter Codex or provider
configuration.

### Explicit global installation

Use global scope only when the workflow should apply across projects:

```sh
codex-ground-control init --global --dry-run
codex-ground-control init --global
codex-ground-control doctor --global
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

The default `qualify` command runs the full packaged offline release campaign.
It makes no model or provider-network calls and writes every run to a new
directory under
`~/.codex-ground-control/evidence/qualification/<run-identity>/`. The JSON
receipt reports the campaign, terminal state, pass/fail counts, run identity,
runtime fingerprint, evidence-index path, and external SHA-256 anchor.

Each evidence index binds every run file by byte count and SHA-256.
`qualify verify` rejects an incorrect external anchor, missing or modified
evidence, unindexed files, strict-schema drift, and stale runtime/component
fingerprints. `qualify reproduce` reruns one scenario from an existing
campaign snapshot into a new run; it never upgrades that affected-only result
into a full release qualification. Expected fail-closed observations count as
passes, while expectation mismatches create stable issue records with evidence
and reproduction instructions.

The campaign, result, issue-ledger, and public-receipt schemas are shipped
under `schemas/qualification/`. Unknown fields and illegal states are rejected,
and a packaged audit fixture detects drift between receipt-schema decisions and
the public behavior validator. Qualification evidence records only allowlisted
runtime facts and component hashes, never credential or arbitrary environment
values.

### Optional provider lifecycle

Pi GLM (`zai-coding-cn/glm-5.2`), Pi DeepSeek
(`deepseek/deepseek-v4-pro`), Pi MiniMax (`minimax-cn/MiniMax-M3`), AGY, and
Grok are independent optional gates. `provider list` reports the same
detected, configured, enabled, qualified, drifted, disabled, blocked, and
execution-decision fields in JSON and human modes. Each Pi entry also reports
its exact public provider/model identity. `configured` means only that the
profile's documented credential environment variable was observed; Ground
Control does not read provider credential values or private CLI credential
stores.

All providers ship disabled and unqualified. `provider enable <id>` records a
project-scoped preference but cannot authorize execution without current
qualification evidence. `provider disable <id>` immediately blocks new
qualification or execution while preserving credentials and historical
evidence. Preferences are stored under
`~/.codex-ground-control/providers/<project-key>/` without the project path or
credential values.

Live qualification is never implicit:

```sh
codex-ground-control provider qualify <pi-glm|pi-deepseek|pi-minimax|agy|grok> --allow-live
```

Without `--allow-live`, the command fails before starting a provider process.
For Pi, qualification accepts only a unique JSON-mode assistant completion
whose runtime provider/model identity exactly matches the selected profile;
model prose or a zero exit code alone is insufficient.
The command runs only the packaged `public-sources-v1` probe; there is no CLI
argument for a user prompt or private repository context. Provider receipts
bind the observed public CLI version, provider-specific FleetRunner adapter,
model or search contract, output schema, fixed probe, source rules, and shared
FleetRunner boundary. Evidence is append-only under
`~/.codex-ground-control/evidence/providers/`.

CLI or contract drift invalidates only providers that depend on that
fingerprint. A provider failure updates only its own gate: other current
providers and the default offline core qualification remain usable.

After a Pi profile has current qualification evidence, the main Codex may send
one bounded brief with an explicit live flag:

```sh
codex-ground-control provider run pi-deepseek review "Review only this supplied boundary." --allow-live
```

Supported activities are `analysis`, `exploration`, `testing`, and `review`.
Ground Control places the brief in the single fixed prompt argv slot. Pi runs
in an isolated empty directory with tools, sessions, extensions, skills,
prompt templates, context files, and approval prompts disabled, and inherits
only the selected profile's environment allowlist. Strict output is labelled
`candidate-evidence`; receipts state that `codex-main` remains completion
authority, review is required, and no workspace changes were applied.

The offline campaign also qualifies the deterministic FleetRunner boundary.
Jobs can select only a manifest adapter, allowed activity, bounded prompt and
timeout, and a named strict output contract. Command, argv, shell, tools,
environment, working directory, and recursive delegation are fixed outside the
job. FleetRunner launches with `shell=false`, passes only allowlisted
environment variables, and runs in either an isolated empty directory or a
controlled workspace copy under the run.

Every FleetRunner execution creates a new run containing normalized `job.json`,
public `metadata.json`, bounded raw `stdout.txt` and `stderr.txt`, and a final
`receipt.json`. A run succeeds only after a zero exit code and strict JSON
contract validation. The only normalization is one complete JSON fence;
trailing prose, multiple fences, malformed or internally invalid payloads,
timeouts, process failures, and stdout/stderr floods have stable fail-closed
states. Timeout handling terminates the complete process group. Qualification
continues to require native runtime entry points and all native workers to be
disabled, the native and write gates to be blocked, and the external writer
count to remain zero; those blocked gates do not prevent an independently
qualified core leaf fixture from passing.
The runtime fingerprint binds that allowlisted native-entry state, so changing
either switch makes earlier evidence `qualification-drifted`.

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
refusal, runtime incompatibility, provider isolation, secret non-disclosure,
evidence retention, and exact restoration through the public executable.

## License

MIT

<h1 align="center">Ground Control for Codex</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/codex-ground-control/v/0.2.0"><img src="https://img.shields.io/npm/v/codex-ground-control?label=npm&amp;color=CB3837" alt="npm version" /></a>
  <a href="https://github.com/eisen0419/codex-ground-control/releases/latest"><img src="https://img.shields.io/github/v/release/eisen0419/codex-ground-control?display_name=tag&amp;sort=semver&amp;color=4493F8" alt="GitHub release" /></a>
  <img src="https://img.shields.io/badge/release-v0.2.0_App--native-2EA44F" alt="Release: v0.2.0 App-native" />
  <img src="https://img.shields.io/badge/Node.js-%3E%3D22-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22 or newer" />
  <img src="https://img.shields.io/badge/platform-macOS-111111?logo=apple&amp;logoColor=white" alt="Platform: macOS" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="License: MIT" /></a>
</p>

<p align="center">
  <sub>English · <a href="https://github.com/eisen0419/codex-ground-control/blob/main/docs/readme/README.zh-CN.md">简体中文</a></sub>
</p>

<p align="center">
  <strong>An App-native, local-first, fail-closed workflow control plane for Codex.</strong><br />
  Work in Local or an App-managed Worktree, qualify every execution boundary,
  and keep one Codex completion authority in control.
</p>

<h3 align="center">
  <a href="#quick-start"><ins>Install App-native v0.2.0</ins></a>
  ·
  <a href="https://github.com/eisen0419/codex-ground-control/releases/tag/v0.2.0">Read the v0.2.0 release audit</a>
</h3>

<p align="center">
  <a href="#architecture">Architecture</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#runtime-cli">Runtime CLI</a> ·
  <a href="#optional-provider-lifecycle">Provider boundaries</a> ·
  <a href="https://github.com/eisen0419/codex-ground-control/releases/tag/v0.2.0">Release audit</a>
</p>

Ground Control v0.2 is designed for people doing software development with
Codex in the ChatGPT desktop app on macOS. The App owns chats, tasks, Local
checkouts, Worktrees, Handoff, branches, and approvals. Ground Control is the
skill-driven workflow layer inside the current App task; it does not require a
separately installed Codex CLI and it never creates, removes, or hands off an
App Worktree.

The `codex-ground-control` executable still provides deterministic bootstrap,
diagnosis, qualification, and bounded Provider operations. It now sits behind
the Ground Control skill as an internal runtime rather than acting as the
product UI or a second task orchestrator.

Ground Control for Codex is an independent community project. It is not
affiliated with or endorsed by OpenAI or Matt Pocock.

## Why Ground Control?

<table>
<tr>
<td width="50%" valign="top">

### Native to the Codex App

Start from a Local or App-managed Worktree task. Ground Control installs an
App-facing skill and operates only in the checkout supplied to that task.

Local, Worktree, and Handoff share one repository identity when they share Git
common storage; separate clones stay isolated.

</td>
<td width="50%" valign="top">

### Fail closed, never open

Missing, stale, blocked, or mismatched capability evidence prevents execution
instead of silently relaxing the boundary.

Provider detection and credentials never imply authorization.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### Evidence you can verify

Offline qualification produces immutable receipts, hashes, issue records, and
reproducible scenarios without model or provider-network calls.

`qualify verify` detects tampering and runtime drift.

</td>
<td width="50%" valign="top">

### Ownership you can reverse

Managed files carry before/after hashes and exact backup associations.
Uninstall restores only verified product-owned bytes.

Conflicts fail closed and remain available for human resolution.

</td>
</tr>
</table>

## Architecture

Ground Control separates installation, execution, and evidence. `codex-main`
inside the current App task is the only workspace writer and completion
authority. Optional providers are bounded leaf adapters: they can return
candidate evidence, but they cannot write the project, delegate again, change
authorization, or declare completion. The App—not Ground Control—owns task and
Worktree lifecycle.

<p align="center">
  <a href="https://eisen0419.github.io/codex-ground-control/architecture/ground-control.html">
    <img src="docs/assets/ground-control-architecture-motion.gif" width="960" alt="Animated Archify trace of the Ground Control App-native architecture: ChatGPT desktop app to Codex task to Ground Control skill, with the CLI behind the skill, one Codex writer, repository-scoped identity, independent gates, and bounded Provider leaves" />
  </a>
</p>

<p align="center">
  <sub>
    6-second motion preview generated from the validated <a href="https://github.com/tt-a1i/archify">Archify</a> trace ·
    <a href="docs/assets/ground-control-architecture.png">static PNG</a> ·
    <a href="https://eisen0419.github.io/codex-ground-control/architecture/ground-control.html">interactive HTML</a> ·
    <a href="docs/architecture/ground-control.architecture.json">typed JSON source</a>
  </sub>
</p>

The gate is evaluated per adapter and per current runtime fingerprint. A pass
for one provider never qualifies another. The default release campaign is
offline; all live provider operations require the explicit `--allow-live`
flag. Native-agent and external-write gates remain blocked in v0.2.

### Isolated App surface qualification

Before any live Pi qualification, the Ground Control skill can call
`qualify_app_surface` with no project, brief, or Provider input. The tool uses
the production widget resource and a real host elicitation form, but it does
not inspect Provider qualification, create a `LeafRunIntent`, grant
`--allow-live`, or call the production LeafRun operations.

Accept, decline, cancel, missing elicitation support, and host errors all
preserve zero Provider starts, zero worker starts, and zero network requests.
A passed result qualifies only the MCP App widget/host transaction. It does not
qualify Pi, a native Codex reviewer, or an unobserved pixel-level render. The
card can repeat the same isolated check without remounting into a live run.

### Visible Pi LeafRuns in the App

The v0.2 package includes an MCP App status card for bounded Pi work in the
current Codex task. The Ground Control skill first calls `prepare_leaf_run`;
this creates a short-lived, repository-scoped intent and shows **Ready** without
starting Pi. The card's **Start with Codex permissions** action then calls the
app-only `start_leaf_run` tool. Codex applies the user's native Ground Control
permission setting—**Always ask**, **Any changes**, **Important actions**,
**Never ask**, or **Use my default**—before deciding whether to dispatch it.
Ground Control does not show a second confirmation or persist that setting.

`start_leaf_run` is accurately annotated as non-read-only, open-world, and
idempotent. A Codex denial or cancellation means the MCP server receives no
start call and starts zero Provider processes. After dispatch, an expired
intent, changed brief, or qualification drift still fails closed before Pi
starts. Choosing a less interactive Codex permission mode removes the extra
mouse click without weakening those runtime gates.

The supported product boundary is the local plugin installed in Codex. MCP
does not give this stdio server a signed host-approval receipt, so direct calls
from another local MCP client are unsupported and do not create a stronger OS
privilege boundary. Ground Control's App-only visibility and Codex permission
policy are host-enforced; the runtime checks above remain server-enforced.

While running, the card polls `get_leaf_run` and shows **Working**, duration,
exact token/cost usage when validated Pi `message_end.usage` is present, and the
evidence receipt. Missing usage is `unknown` and is never estimated. **Done**
means candidate evidence is ready for `codex-main` review; it does not grant Pi
workspace-write or completion authority, and the card does not impersonate a
native Codex sub-agent task.

## Quick start

Requirements:

- macOS
- ChatGPT desktop app with Codex
- Node.js 22 or newer
- Git

No standalone Codex CLI is required.

1. Open the target Git repository in the ChatGPT desktop app.
2. Start a Codex task in **Local** or in an App-created **Worktree**.
3. In the target App task, ask Codex to preview and install the version-pinned
   v0.2 release:

   ```sh
   npx --yes codex-ground-control@0.2.0 init --dry-run
   npx --yes codex-ground-control@0.2.0 init
   ```

4. Start a fresh Codex task if the current task does not refresh newly installed
   skills, then invoke **Ground Control**. The skill calls the runtime for
   `doctor`, offline qualification, and Provider gates.

Project-local installation is the default. It changes only the checkout
selected by the App plus product-owned evidence and repository-scoped Provider
state under `~/.codex-ground-control/`. It does not create or manage Worktrees.
Global installation remains a separate, previewed, explicitly confirmed flow.

> **Release status:** `0.2.0` is the current App-native release on npm and
> GitHub. Pin the version in installation and recovery commands.

If this repository already has a v0.1 managed workflow, ask the App task to run
`npx --yes codex-ground-control@0.1.0 uninstall` first, review that exact
restoration, and then install v0.2. v0.2 deliberately refuses to
reinterpret a v0.1 ownership manifest against a different asset inventory;
repository-scoped Provider state and evidence remain available.

### Latest published release: v0.2.0

The npm package and GitHub Release attachment are byte-for-byte copies of the
audited v0.2.0 candidate. The Release page records the source commit, complete
test and qualification results, per-Provider status, artifact size, and
SHA-256 digest.

- [npm package](https://www.npmjs.com/package/codex-ground-control/v/0.2.0)
- [GitHub Release and audit](https://github.com/eisen0419/codex-ground-control/releases/tag/v0.2.0)

Use a downloaded tarball without contacting npm:

```sh
npx --yes --offline \
  --package=./codex-ground-control-0.2.0.tgz \
  codex-ground-control init --dry-run
```

### v0.2.0 qualification

| Release gate | Published evidence |
| --- | --- |
| Source | Immutable [`v0.2.0`](https://github.com/eisen0419/codex-ground-control/tree/v0.2.0) tag |
| App surface | Fresh-task Host acceptance and repeat-self-test evidence |
| Test and static gates | Full suite, typecheck, release-lock, and reproducible double-pack |
| Offline core | Isolated campaign plus evidence verification and reproduction |
| Optional providers | Each Provider reports its own final enabled, qualified, current, and blocked state |

See the
[v0.2.0 Release](https://github.com/eisen0419/codex-ground-control/releases/tag/v0.2.0)
for the complete audit and download verification.

### Previous audited release: v0.1.0

The CLI-first v0.1.0 release remains available for audit and version-pinned
recovery. Its published tarball SHA-256 is
`a480fa43563f03f62eec30ca6a62e02d7bf6f01183187da38e88d6e1d0da0c18`.
See the [v0.1.0 Release](https://github.com/eisen0419/codex-ground-control/releases/tag/v0.1.0).

## Runtime CLI

The Ground Control skill invokes this deterministic interface behind the App
experience. The examples below document the runtime contract for auditing,
development, and automation; App-only users do not need to operate a separate
Codex CLI:

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
- installs the App-facing Ground Control skill and its Codex metadata;
- installs the Ground Control Router as a separate first-party overlay;
- appends one clearly marked managed block to `AGENTS.md`;
- records ownership, before/after SHA-256 hashes, release provenance, and the
  `AGENTS.md` backup association in `.codex-ground-control/manifest.json`.

Re-running `init` against the same release is idempotent. `doctor` is read-only:
it verifies macOS, Node.js, the Git boundary, installation manifest, managed
block, vendored skills, and release lock. A standalone Codex CLI, when present,
is reported only as optional host-compatibility information; absence or version
drift does not fail `core`. Doctor also reports ambient hooks, native Codex
entry points, Pi/AGY/Grok public CLI versions, and the independent `core`,
Provider, `native`, and `write` gates. Provider detection or credential
presence never means enabled, authorized, or qualified. Optional Provider
absence does not fail `core`.

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
and repository-scoped Provider preferences are the explicit product-owned
exception under `~/.codex-ground-control/`; they do not alter Codex or Provider
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
Grok are independent optional gates. Every gate has an immutable
`ProviderRuntimeProfile/Auth` binding: executable, manifest-controlled argv,
`shell: false`, an environment allowlist, provider-owned authentication,
presence probe, conflict policy, and status authority.

`provider list` reports the same status chain in JSON and human modes:
`detected → authenticated → enabled → qualified → current → run-authorized`.
`authenticated` is tri-state: `true` means a safe local binding was observed,
`false` means absent or unsafe, and `null` means the provider has no safe
read-only presence probe. It does not prove that a remote session is still
valid. `qualified` records a saved passed live qualification; `current` also
requires its evidence and full runtime profile fingerprint to remain unchanged.
`run-authorized` is never saved and is true only for the current `qualify` or
`run` request carrying `--allow-live`. The legacy `configured` field remains a
presence-only compatibility alias.

Pi authentication stays in one profile-specific API key environment variable.
AGY authentication stays in its provider-native system keyring, so its
read-only status is `unknown`; ambient `GOOGLE_API_KEY` and `GEMINI_API_KEY`
values are ignored. Grok authentication stays in `~/.grok/auth.json`; the
read-only probe rejects unsafe paths plus empty or oversized files, and an
authorized run copies only the safe bytes into a disposable `GROK_HOME`.
Ground Control never merges these
credentials into one login or stores their values.

Each Pi entry also reports its exact public provider/model identity. AGY reports
its `research-only` role, Google surface, fixed `plan` mode, and
`gemini-3.6-flash-high` model. Grok reports its `research-only` role, X.com
surface, fixed `web-only` mode, and `grok-4.5` model.

All providers ship disabled and unqualified. `provider enable <id>` records a
repository-scoped preference but cannot authorize execution without current
qualification evidence. Local, linked Worktrees, App-managed Worktrees, and
Handoff share that preference when they share the same Git common storage;
a separate clone gets a separate identity. `provider disable <id>` immediately blocks new
qualification or execution while preserving credentials and historical
evidence. Preferences are stored under
`~/.codex-ground-control/providers/<repository-key>/` without the repository
path or credential values.

Live qualification is never implicit:

```sh
codex-ground-control provider qualify <pi-glm|pi-deepseek|pi-minimax|agy|grok> --allow-live
```

Without `--allow-live`, the command fails before starting a provider process.
For Pi, qualification accepts only a unique JSON-mode assistant completion
whose runtime provider/model identity exactly matches the selected profile;
model prose or a zero exit code alone is insufficient.
For AGY, Ground Control requires CLI 1.1.7 or newer and starts a fixed
`gemini-3.6-flash-high` invocation with `--sandbox`, `--mode plan`, and a
bounded print timeout. Its cwd is a per-run isolated empty directory, while
provider API-key environment variables and unrelated secrets are withheld.
The adapter rejects any run-created workspace files before returning. Only a
fresh structured Google Search observation of the exact Python Software
Foundation website and identity can pass. Ground Control then independently
fetches that exact HTTPS URL, checks every redirect against the origin/path
allowlist, caps the response at 1 MB, and requires the public `Python` content
marker. Wrong or stale observations, trailing prose, and unverifiable sources
fail closed.
For Grok, Ground Control requires CLI 0.2.93 or newer. The adapter copies only
the cached Grok authentication file into a disposable per-run `GROK_HOME`,
switches the child process to a separate isolated `HOME`, and removes the
temporary runtime after success, failure, or timeout. User compatibility
imports, rules, agents, MCPs, hooks, memory, subagents, telemetry, feedback, and
auto-update are disabled before Grok starts. The fixed invocation exposes only
`web_search` and `web_fetch`, denies the Agent tool, uses strict sandboxing, and
never inherits API-key variables or unrelated secrets.

Grok qualification uses its native JSON Schema output and a strict adapter
envelope. It accepts only the exact official X account pairs
`https://x.com/xai` with `@xai`, or `https://x.com/SpaceXAI` with
`@spacexai`. Case variants, lookalikes, redirects, stale observations, unknown
envelopes, mixed prose, and workspace writes fail closed.
The command runs only the packaged `public-sources-v1` probe; there is no CLI
argument for a user prompt or private repository context. Provider receipts
bind the observed public CLI version, provider-specific FleetRunner adapter,
model or search contract, output schema, fixed probe, source rules, and shared
FleetRunner boundary. Evidence is append-only under
`~/.codex-ground-control/evidence/providers/`.

CLI or contract drift invalidates only providers that depend on that
fingerprint. A provider failure updates only its own gate: other current
providers and the default offline core qualification remain usable.
AGY and Grok receipts retain only the fixed public probe, verified public
source observation, CLI version, component fingerprints, and evidence hashes.
They label the output as qualification evidence, keep `codex-main` as
completion authority, and state that no workspace changes were applied. Grok
receipts also record the public research boundary and that temporary
authentication was neither retained nor recorded.

After a Pi profile has current qualification evidence, ask the Ground Control
skill to prepare one visible, bounded Pi LeafRun. In the App-native path, the
user starts the exact intent from the MCP App card and Codex applies the
configured native plugin permission policy. The MCP server translates only a
Codex host-dispatched `start_leaf_run` call into the internal per-run
`--allow-live` boundary; it does not add another permission prompt.

The equivalent internal execution layer remains:

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

The architecture has one single Codex coordinator and only bounded external
leaf adapters. Provider gates are independent, the default release campaign is
offline, and every live provider operation requires explicit `--allow-live`.
The native and external write gates remain blocked in v0.2; no provider is
allowed to write the project or claim completion.

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

To smoke-test a locally packed artifact:

```sh
npm pack
npm install --prefix /tmp/codex-ground-control \
  ./codex-ground-control-0.2.0.tgz
/tmp/codex-ground-control/node_modules/.bin/codex-ground-control --help
```

The acceptance suite packs and installs the real npm tarball into a temporary
home, creates a fresh Git repository, denies network calls in the CLI process,
and verifies dry-run, empty and existing project instructions, idempotent
initialization, explicit global confirmation, private backups, interrupted
install recovery, symlink fault injection, doctor integrity checks, drift
refusal, runtime incompatibility, provider isolation, secret non-disclosure,
evidence retention, and exact restoration through the public executable.

## Scope

Ground Control v0.2 is intentionally narrow: individual macOS ChatGPT desktop
app users, one Codex workspace writer per task, project-local installation by
default, App-owned Local/Worktree/Handoff lifecycle, and independently gated
leaf adapters. It does not reimplement the App UI, create or steer Codex tasks
or Worktrees, promise team authorization or Windows/Linux support, provide
general-purpose agent orchestration, grant Provider write access, or allow
autonomous completion by an external model.

## License

MIT

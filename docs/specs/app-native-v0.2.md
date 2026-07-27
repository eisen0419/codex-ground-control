# Ground Control for Codex v0.2 — App-native product contract

Status: released
Target version: `0.2.0`
Published release: `0.2.0`

## Product promise

Ground Control is a local-first, fail-closed workflow for people doing software
development in Codex inside the ChatGPT desktop app.

The primary user journey is:

1. Open a Git repository or project folder in the ChatGPT desktop app.
2. Select Codex and start a task in Local or an App-managed Worktree.
3. Invoke the Ground Control skill explicitly, or let Codex select it from the
   task description.
4. Let the skill call the deterministic Ground Control CLI runtime for
   installation checks, qualification, and bounded Provider operations.
5. Review changes, receipts, and evidence in the same Codex task.

The npm CLI remains a supported bootstrap and maintenance interface, but it is
not the primary product UI and it is not the Codex host.

This contract follows the official
[ChatGPT desktop quickstart](https://learn.chatgpt.com/docs/quickstart),
[Codex Worktree model](https://learn.chatgpt.com/docs/environments/git-worktrees),
and [skill discovery locations](https://learn.chatgpt.com/docs/build-skills).

## Product seams

### App host seam

The ChatGPT desktop app owns chats, tasks, Local checkouts, Worktrees, Handoff,
branch controls, approvals, and task lifecycle. Ground Control operates only in
the checkout supplied to the current Codex task. Codex native plugin
permissions are the sole user-facing approval policy for Ground Control App
tools; Ground Control must not add a parallel per-run approval UI.

Ground Control must not create, remove, move, or hand off App Worktrees. It must
not require a separately installed `codex` CLI executable for its core gate.
When a standalone Codex CLI is present, `doctor` may report its public version
as optional compatibility information.

### Skill seam

The App-facing interface is a repository or user skill discovered from
`.agents/skills/ground-control/` or `~/.agents/skills/ground-control/`.

The skill owns the user journey and calls the CLI runtime behind the interface.
It must preserve explicit authorization for global writes. For live Provider
network execution, it must rely on Codex native plugin permissions to govern
the app-only start tool while retaining the internal per-run `--allow-live`
boundary.

### ProviderRuntimeProfile/Auth seam

Every optional Provider has one immutable `ProviderRuntimeProfile/Auth`
contract behind the skill. It binds the public executable identity to
manifest-controlled argv, `shell: false`, the FleetRunner environment
allowlist, provider-owned authentication, a read-only presence probe,
credential-conflict handling, and the evidence authority that can make a
qualification current. Arbitrary user argv and a Ground Control credential
vault are outside this seam.

The public status chain is:
`detected → authenticated → enabled → qualified → current → run-authorized`.
Each stage remains independently observable:

- `authenticated` is `true` only when the profile's safe local presence probe
  observes its configured binding, `false` when that binding is absent or
  unsafe, and `null` when no safe read-only probe exists. It does not validate a
  remote session.
- `qualified` records that the latest saved live qualification passed.
  `current` additionally requires the saved evidence and complete runtime
  fingerprint, including the runtime profile, to remain unchanged.
- `run-authorized` is never persisted. It is `true` only in a `qualify` or
  `run` request that contains the explicit `--allow-live` flag.

Authentication stays provider-owned:

| Provider | Source | Read-only status | Run materialization |
| --- | --- | --- | --- |
| Pi profiles | One profile-specific API key environment variable | Presence only; values are never read into receipts | Only the profile key admitted by the adapter environment allowlist |
| AGY | Provider-native system keyring | `unknown`; Ground Control has no safe presence probe and ignores unrelated Google API key variables | AGY reads its native keyring during the explicitly authorized live run |
| Grok | `~/.grok/auth.json` | Safe-file presence check that rejects symlinks, unsafe ancestors, empty files, and oversized files | Copy into a disposable `GROK_HOME`; never retain or record the contents |

One control surface therefore does not mean one cross-provider login. Login,
credential presence, an enabled preference, or historical qualification never
grants live execution.

### Repository identity seam

Provider preferences and qualification evidence are scoped to one local Git
repository, not one checkout path.

Local, linked Worktrees, Codex-managed Worktrees, permanent Worktrees, and
Handoff between those checkouts must resolve the same repository key when they
share Git common storage. Separate clones must remain isolated.

For ordinary non-bare repositories, v0.2 keeps the existing local-checkout key
so v0.1 Provider state and evidence remain readable.

### LeafRunIntent v1 seam

A visible Pi run begins as a short-lived `LeafRunIntent v1`, not as a Provider
process. The intent binds the Git common-storage repository key, fixed Pi
profile, supported activity, SHA-256 of the bounded brief, current qualification
fingerprint, preparation time, and expiry. The raw brief is not persisted in
the intent or either event journal. The existing private FleetRunner evidence
contract still retains its normalized job input for reproducibility.

Local, linked Worktree, and Handoff checkouts that share Git common storage
resolve the same intent namespace. A changed brief, expired intent, or changed
qualification fingerprint fails closed. Starting an already-started intent
returns its existing run identity without another Provider process.

### LeafRunEvent v1 seam

Each intent owns an append-only `events.jsonl` control journal, and each
FleetRunner execution owns an append-only `events.jsonl` execution journal.
Both contain immutable `LeafRunEvent v1` records with monotonically increasing
sequence numbers. The intent journal covers preparation, acceptance of a
Codex host-dispatched start, run start, and terminal completion; a host denial
does not reach the MCP server and therefore creates no false server-side
denial event. The FleetRunner journal covers sanitized process start, bounded
output-byte progress, process exit, and run finish.

Events may contain digests, fixed stage names, byte counts, terminal state,
duration, exact usage, and receipt references. They must not contain the raw
brief, credentials, raw Provider output, process environment, or hidden model
reasoning. If an event sink is configured, delivery occurs only after the
corresponding FleetRunner record is durably appended.

### RuntimeUsage v1 seam

Pi usage is accepted only from the validated JSON-mode assistant
`message_end.usage` object for the exact configured Provider/model identity.
`RuntimeUsage v1` preserves reported input, output, cache-read, cache-write, total
token, and cost fields without estimation. Missing usage is reported as
`status: unknown`; malformed or internally inconsistent usage fails the strict
candidate contract. A UI must never derive token counts from text length or
elapsed time.

### MCP App status and permission seam

The packaged MCP App renders a status card in the current Codex task. The
model-visible, read-only `qualify_app_surface` tool exercises that production
widget resource and host elicitation without project, brief, or Provider input.
It does not resolve Provider qualification, create a production
`LeafRunIntent`, start a worker, request network access, or grant
`--allow-live`. Accept, decline, cancel, missing elicitation support, and host
errors all return explicit isolated outcomes with zero Provider, worker, and
network starts. A pass qualifies only the observed MCP App widget/host
transaction; it does not qualify Pi, a native reviewer, or an unobserved
pixel-level render.

The model-visible `prepare_leaf_run` tool prepares the intent and card without
network execution. The app-only, idempotent `start_leaf_run` tool is annotated
as non-read-only and open-world. Codex applies the user's native plugin
permission setting—**Always ask**, **Any changes**, **Important actions**,
**Never ask**, or **Use my default**—before deciding whether to dispatch that
tool call. Ground Control does not request a second elicitation, persist the
selected setting, or override the host decision.

If Codex denies or cancels the action, the MCP server receives no start call
and no Provider process starts. Once Codex dispatches the call, the server
records `codex-host-permission` for that run identity and still checks intent
expiry, brief equality, current qualification fingerprint, and idempotency
before any Provider process starts. That record is not a reusable entitlement
and does not bypass any Provider gate.

The supported trust boundary is the local plugin installed in Codex. The MCP
transport does not provide this stdio server with a signed host-approval
receipt. App-only visibility and permission dispatch are therefore host
enforcement, not a new OS privilege boundary; direct invocation from another
local MCP client is unsupported. Runtime qualification, intent, drift, and
idempotency checks remain server-enforced.

The app-only `get_leaf_run` tool lets the card display `Ready`, `Working`, or
`Done`, a coarse current stage, duration, exact-or-unknown runtime usage, and
evidence receipt. The card
is not a native Codex child task and does not claim a clickable native-agent
relationship. The MCP server translates only a Codex host-dispatched start
into the internal per-run `--allow-live` boundary; the CLI remains behind the
skill.

### Upgrade seam

An existing v0.1 managed workflow must be removed with the version-pinned v0.1
runtime before v0.2 initialization. v0.2 must fail closed rather than
reinterpret a v0.1 ownership manifest against the new asset inventory. This
explicit uninstall/reinstall step does not remove Provider evidence or the
repository-scoped preference state described above.

### Deterministic runtime seam

The Ground Control CLI remains responsible for reversible installation,
read-only diagnosis, offline qualification, Provider lifecycle gates,
FleetRunner execution, and append-only evidence. It does not become a second
chat/task/worktree orchestrator.

The single-writer and completion-authority rules remain unchanged:
`codex-main` is the only workspace writer and completion authority; Provider
adapters return candidate evidence only.

## Acceptance contract

Runtime acceptance tests run through the packed npm tarball and public CLI
seam. Documentation and architecture assertions inspect their checked-in source
artifacts directly.

| ID | Observable acceptance condition |
| --- | --- |
| APP-01 | In an initialized Git repository with Node.js available and no `codex` executable on `PATH`, `doctor --json` exits `0`, the core gate passes, and standalone CLI absence is reported as optional. |
| APP-02 | Project initialization installs `.agents/skills/ground-control/SKILL.md` and `agents/openai.yaml` in addition to the bounded Router skill. |
| APP-03 | Enabling a Provider in Local is visible from a linked Worktree of the same repository, and changing it in the Worktree is visible from Local. |
| APP-04 | The Local and Worktree observations use exactly one Provider state file under `~/.codex-ground-control/providers/`. |
| APP-05 | A separate clone resolves a separate Provider state scope. |
| APP-06 | No Ground Control runtime command creates, deletes, or hands off a Git worktree. |
| APP-07 | README quick start begins in the ChatGPT desktop app; standalone Codex CLI is not listed as a requirement. |
| APP-08 | The visible Pi architecture path is Developer → ChatGPT desktop app → Codex task → Ground Control skill → MCP App status card → `LeafRunIntent v1` → Codex native permission gate → LeafRun worker → FleetRunner → Provider leaves; `codex-main` remains the sole writer and completion authority, and the CLI appears behind the skill as an internal runtime. |
| APP-09 | Existing offline qualification, fail-closed Provider gates, single-writer rules, explicit `--allow-live`, exact restoration, and evidence verification continue to pass. |
| APP-10 | `provider list --json` exposes the complete detected → authenticated → enabled → qualified → current → run-authorized chain and an immutable runtime/auth profile without returning credential values. |
| APP-11 | AGY reports provider-owned system-keyring authentication as `unknown`; ambient `GOOGLE_API_KEY` or `GEMINI_API_KEY` values cannot change that status. |
| APP-12 | Grok reports cached authentication only after a safe read-only inspection of `~/.grok/auth.json`; a missing, symlinked, unsafe, empty, or oversized source cannot report authenticated. |
| APP-13 | Provider qualification evidence fingerprints the runtime profile, and status distinguishes a historical passed qualification from current evidence after drift. |
| APP-14 | Local and linked Worktree preparation resolve one repository identity; the persisted `LeafRunIntent v1` contains only the brief digest, current qualification fingerprint, and expiry, never the raw brief. |
| APP-15 | Retrying `start_leaf_run` for an already-started intent returns the original run identity and cannot create a second Provider process. |
| APP-16 | `LeafRunEvent v1` records are durably ordered in `events.jsonl` and contain no raw brief, credentials, raw Provider output, environment values, or hidden reasoning. |
| APP-17 | The MCP App exposes model-visible preparation plus app-only start/status tools. `start_leaf_run` is non-read-only, open-world, and idempotent so Codex native plugin permissions govern dispatch; Ground Control never creates a second live-start elicitation. |
| APP-18 | The status card reports `RuntimeUsage v1` exactly from validated Pi `message_end.usage`; missing usage is `unknown` and never estimated. |
| APP-19 | The model-visible `qualify_app_surface` tool reuses the production widget and host elicitation without Provider inputs or production intent state; accept, decline, cancel, unavailable, and error outcomes all preserve zero Provider starts, zero worker starts, zero network requests, and no `--allow-live` authorization. |
| APP-20 | A Codex-dispatched `start_leaf_run` call does not require the client to advertise elicitation support; the runtime still rejects a direct start without the internal `codex-host-permission` source and preserves expiry, brief, qualification-drift, and idempotency gates. |

## Non-goals

- Reimplementing the App’s chat, task, Worktree, Handoff, branch, or approval UI.
- Automatically creating or steering other Codex tasks.
- Treating mere App, CLI, Provider, or credential detection as authorization
  for Provider execution.
- Combining Pi, AGY, and Grok credentials into a Ground Control login or token
  store.
- Automating Git remote changes, npm publication, tag creation, or GitHub
  Release creation from the Ground Control product runtime.

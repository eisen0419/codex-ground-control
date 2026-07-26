# Ground Control for Codex v0.2 — App-native product contract

Status: implementation target
Target version: `0.2.0`
Latest published release while this contract is implemented: `0.1.0`

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
the checkout supplied to the current Codex task.

Ground Control must not create, remove, move, or hand off App Worktrees. It must
not require a separately installed `codex` CLI executable for its core gate.
When a standalone Codex CLI is present, `doctor` may report its public version
as optional compatibility information.

### Skill seam

The App-facing interface is a repository or user skill discovered from
`.agents/skills/ground-control/` or `~/.agents/skills/ground-control/`.

The skill owns the user journey and calls the CLI runtime behind the interface.
It must preserve explicit authorization for global writes and live Provider
network execution.

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
| APP-08 | The architecture main path is Developer → ChatGPT desktop app → Codex task → Ground Control skill → `codex-main`; the CLI appears behind the skill as an internal runtime. |
| APP-09 | Existing offline qualification, fail-closed Provider gates, single-writer rules, explicit `--allow-live`, exact restoration, and evidence verification continue to pass. |
| APP-10 | `provider list --json` exposes the complete detected → authenticated → enabled → qualified → current → run-authorized chain and an immutable runtime/auth profile without returning credential values. |
| APP-11 | AGY reports provider-owned system-keyring authentication as `unknown`; ambient `GOOGLE_API_KEY` or `GEMINI_API_KEY` values cannot change that status. |
| APP-12 | Grok reports cached authentication only after a safe read-only inspection of `~/.grok/auth.json`; a missing, symlinked, unsafe, empty, or oversized source cannot report authenticated. |
| APP-13 | Provider qualification evidence fingerprints the runtime profile, and status distinguishes a historical passed qualification from current evidence after drift. |

## Non-goals

- Reimplementing the App’s chat, task, Worktree, Handoff, branch, or approval UI.
- Automatically creating or steering other Codex tasks.
- Treating App or CLI detection as authorization for Provider execution.
- Combining Pi, AGY, and Grok credentials into a Ground Control login or token
  store.
- Publishing `0.2.0`, changing a Git remote, creating a tag, or creating a
  GitHub Release as part of this implementation.

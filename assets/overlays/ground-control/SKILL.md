---
name: ground-control
description: Run the App-native Ground Control workflow in the current Codex task, including bounded setup, diagnosis, offline qualification, and fail-closed Provider routing without taking ownership of App worktrees or completion authority.
---

# Ground Control for Codex

Use this skill from Codex in the ChatGPT desktop app. Keep the current Codex
task as the user-facing control surface and use the deterministic Ground Control
CLI runtime behind this skill.

## App-owned context

- Work only in the Local checkout or Worktree supplied to this task.
- The ChatGPT desktop app owns chats, tasks, Worktrees, Handoff, branch controls,
  approvals, and task lifecycle.
- Ground Control must not create, remove, or hand off worktrees.
- Do not require a separately installed `codex` CLI. The current Codex task is
  the host.

## Route

1. Read the applicable `AGENTS.md` files and inspect the current Git status.
2. If Ground Control is not initialized, preview the version-pinned package
   before applying project-local files. Use the exact package source supplied
   by the user or release workflow. For a published v0.2 release:

   ```text
   npx --yes codex-ground-control@0.2.0 init --dry-run --json
   npx --yes codex-ground-control@0.2.0 init --json
   ```

   For an unpublished candidate, replace the package selector with its explicit
   local tarball path; do not silently fall back to `latest`.

3. Run read-only diagnosis through the same version-pinned CLI runtime behind
   this skill:

   ```text
   npx --yes codex-ground-control@0.2.0 doctor --json
   ```

4. Run offline qualification through that same runtime only when fresh
   qualification evidence is needed:

   ```text
   npx --yes codex-ground-control@0.2.0 qualify --json
   ```

5. Route optional Provider work through `multi-agent-router`. For a visible Pi
   run, prefer the packaged MCP App flow described below. Provider detection,
   credentials, or an enabled preference never imply qualification or
   authorization. Codex native plugin permissions are the user-facing
   authorization policy for App tool calls.
6. Read Provider status in this order:
   `detected → authenticated → enabled → qualified → current → run-authorized`.
   Treat `authenticated: null` as a truthful unavailable presence probe, not a
   pass. Do not infer `run-authorized` from any earlier stage.

## App surface self-test

Use the isolated App check before any live Pi qualification when the user wants
to verify plugin loading, the real widget, or host elicitation:

1. Call `qualify_app_surface` with no arguments. It must not resolve a Provider
   qualification, create a production `LeafRunIntent`, start a worker, access
   the network, or translate the result into `--allow-live`.
2. Let the host present the elicitation form and let the returned production
   widget show the isolated outcome. The card may repeat this same tool call.
3. Treat accept, decline, cancel, missing elicitation support, and host errors
   as self-test outcomes only. Every outcome must keep Provider, worker, and
   network start counts at zero.
4. Report a pass only for the MCP App widget/host transaction that was actually
   observed. Do not infer Pi qualification, native reviewer qualification, or
   pixel-level rendering that the user did not observe.

## Visible Pi LeafRun

Use the App card for `pi-glm`, `pi-deepseek`, and `pi-minimax` when the user
would benefit from seeing a bounded leaf run in the current task:

1. Call `prepare_leaf_run` with the App-selected checkout, fixed profile,
   supported activity, and bounded brief. Preparation must not start Pi.
2. Let the returned MCP App card show `Ready`. Do not call the app-only
   `start_leaf_run` tool on the user's behalf.
3. When the user chooses **Start with Codex permissions**, let Codex apply the
   user's native Ground Control permission setting before it dispatches the
   app-only `start_leaf_run` tool. Ground Control must not issue a second
   elicitation. A host denial means no start call is dispatched; expiry, brief
   mismatch, or qualification drift still fails closed before any Provider
   process starts.
4. Let the card poll `get_leaf_run` and show `Working` or `Done`, elapsed time,
   exact `RuntimeUsage v1` when Pi reports it, and the evidence receipt. Missing
   usage is `unknown` and is never estimated.
5. Treat the card as an interactive status surface, not a native Codex
   sub-agent thread. `codex-main` still reviews the candidate evidence and
   decides completion.

The MCP App server may translate only a Codex host-dispatched
`start_leaf_run` call into the internal CLI/runtime `--allow-live` flag for
that run. It must not persist, override, or imitate the user's Codex permission
setting, and the internal flag is not reusable authorization. If the MCP App
is unavailable, stay fail-closed and report that visible LeafRun execution is
unavailable; do not silently fall back to a live CLI call.

The supported trust boundary is the local plugin installed in Codex. App-only
visibility and permission dispatch are host-enforced; the MCP transport does
not give the stdio server a signed host-approval receipt. Treat direct calls
from another local MCP client as unsupported, never as a stronger OS privilege
boundary. Runtime qualification, intent, drift, and idempotency checks remain
server-enforced.

## Provider authentication

- Keep authentication provider-owned; Ground Control has no shared credential
  vault or cross-provider login.
- Pi uses only its profile-specific environment binding admitted by the
  FleetRunner manifest.
- AGY uses its native system keyring. Its read-only authentication status is
  `unknown`; ignore ambient Google API key variables for this profile.
- Grok uses a safely inspected `~/.grok/auth.json`, copied only into a
  disposable `GROK_HOME` for the explicitly authorized run.
- Never print, persist, fingerprint, or copy credential values into task
  receipts or repository state.

## Authority

- `codex-main` remains the only coordinator, workspace writer, and completion
  authority.
- Provider operations require their own current qualification and gate.
- Live Provider execution additionally requires explicit user intent, a
  `start_leaf_run` call allowed by Codex native plugin permissions, and the
  internal per-run `--allow-live` boundary.
- Treat every Provider result as candidate evidence and verify it before use.
- Global installation, Git writes, publication, and other external mutations
  require their own explicit authorization.

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

5. Route optional Provider work through `multi-agent-router`. Provider detection,
   credentials, or an enabled preference never imply qualification or
   authorization.
6. Read Provider status in this order:
   `detected → authenticated → enabled → qualified → current → run-authorized`.
   Treat `authenticated: null` as a truthful unavailable presence probe, not a
   pass. Do not infer `run-authorized` from any earlier stage.

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
- Live Provider execution additionally requires explicit user intent and
  `--allow-live`.
- Treat every Provider result as candidate evidence and verify it before use.
- Global installation, Git writes, publication, and other external mutations
  require their own explicit authorization.

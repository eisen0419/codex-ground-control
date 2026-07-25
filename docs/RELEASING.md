# Ground Control v0.1 release-candidate procedure

Run the release-candidate command only from a clean checkout on macOS with
Node.js 22 or newer, Git, Codex CLI, and any provider credentials required for
the live campaigns:

```sh
npm run release-candidate -- --allow-live
```

The command runs `release-lock:verify`, type checking, and the complete test
suite before packing. It packs the npm artifact twice in isolated npm
environments and requires identical SHA-256 hashes. It then installs the real
tarball under a temporary `HOME`, creates fresh Git worktrees, and exercises
the public CLI for initialization, idempotent re-initialization, diagnosis,
offline qualification, evidence verification, all five independent live
provider campaigns, safe uninstall, exact project restoration, and a
user-modification conflict.

Each run uses a new non-overwriting directory under `release-candidate/`. Its
main artifacts are:

- `codex-ground-control-0.1.0.tgz`
- `release-report.json`
- `RELEASE_CANDIDATE.md`
- `receipts/` with one public CLI receipt per operation
- `evidence/` with copied offline and available provider evidence

The package scan rejects sensitive environment values, common encoded-token
forms, personal absolute paths, undeclared package roots, and vendored files
not covered by `release-lock.json`. The license check requires the project MIT
license, complete third-party notices, locked Matt skills provenance, and zero
unlicensed runtime dependencies.

Live qualification is deliberately serial because all providers share one
project-scoped state file. A provider failure remains attached to that
provider, the remaining campaigns continue, and the offline evidence is
verified again afterward. A live campaign that is not run keeps the overall
gate blocked. A campaign that ran but failed remains a current partial
limitation and leaves only that provider disabled/unqualified; it does not
become a core failure, a false provider success, or a release blocker when all
release-blocking checks passed. If the failed provider is not safely disabled
or the offline evidence no longer verifies afterward, failure isolation itself
becomes a release blocker.

The command also performs read-only npm registry and GitHub public-name checks.
GitHub repository names are owner-scoped, so its result is an observation, not
a reservation; the intended owner must still be checked immediately before
creating a remote.

For a deterministic offline rehearsal, use:

```sh
npm run release-candidate -- \
  --skip-repository-checks \
  --skip-live \
  --skip-name-checks
```

Every skipped or failed gate is listed under `limitations`;
`blockingLimitations` identifies the subset that blocks the candidate. An
exit code `2` means the report was generated but at least one release-blocking
check failed. Exit code `0` means all release-blocking checks passed; optional
providers may still be disabled/unqualified and listed as partial evidence. It
does not authorize publication.

The command does not create a GitHub remote, push, publish to npm, or create a
release. Those remote actions remain outside Ticket 11.

Recovery uses the packed public CLI. Project-local `uninstall` restores exact
pre-install instructions and preserves modified managed files as conflicts.
Global recovery requires
`codex-ground-control uninstall --global --confirm-global`; missing or modified
recovery assets fail closed, and no force path exists.

# Ground Control for Codex

A local-first, fail-closed workflow control plane for Codex.

This repository currently contains the public CLI tracer bullet for the v0.1
package lifecycle. It proves that the packed artifact can initialize, diagnose,
qualify, inspect provider state, and uninstall itself in a fresh Git worktree
without provider credentials or network access.

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
codex-ground-control init
codex-ground-control doctor
codex-ground-control qualify
codex-ground-control provider
codex-ground-control uninstall
```

Add `--json` to a command to emit exactly one JSON receipt on stdout. Exit code
`0` means success, `2` means an operational blocker was detected, and `64`
means invalid command usage.

The current tracer bullet creates only
`.codex-ground-control/manifest.json`. Re-running `init` is idempotent.
`uninstall` removes only the unchanged managed state and is also safe to repeat.
The `qualify` command runs a packaged deterministic fixture; `provider` reports
that no optional providers are configured.

## Development

```sh
npm test
```

The acceptance suite packs and installs the real npm tarball into a temporary
home, creates a fresh Git repository, denies network calls in the CLI process,
and verifies the complete lifecycle through the public executable.

## License

MIT

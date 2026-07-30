# Pi native-session spike

This is a throwaway prototype for one question:

> Can an isolated Pi RPC process provide an exact native session ID,
> provider-native events that drive a Ground Control App card, and an exact
> abort that leaves a sibling Pi session responsive?

It does not replace or modify the v0.2 runtime.

## Safety boundary

- Without `--allow-live`, the command starts two isolated Pi RPC processes in
  offline mode, verifies their native session identities, and exits without a
  model request.
- With `--allow-live`, exactly one process receives one no-tools prompt. The
  spike requests abort immediately after Pi emits `agent_start`.
- The sibling process remains offline and receives no prompt.
- Offline Pi runs with a disposable `HOME`, Agent directory, and session
  directory.
- Live Pi keeps authentication provider-owned: it reads Pi's existing native
  authentication through the allowlisted `HOME`/`PI_CODING_AGENT_DIR`, while
  its session directory remains disposable. Ground Control does not copy or
  persist the credential.
- The child environment is profile-scoped. It admits only runtime basics,
  proxy settings, Pi's native config path, and the `pi-glm` credential binding
  when present; unrelated ambient variables and other Provider credentials are
  withheld.
- Pi runs with no tools, no extensions, no skills, no prompt templates, no
  context files, and telemetry disabled.
- Only sanitized session, event, card, and cancellation evidence is printed.
  Raw prompts, model output, Provider error text, Provider stderr, transcript
  paths, process IDs, credentials, and process-incarnation values are not
  emitted.

## Run

Offline protocol probe:

```sh
npm --prefix spikes/pi-native-session run spike
```

One-shot live cancellation probe:

```sh
npm --prefix spikes/pi-native-session run spike -- --allow-live
```

Override the Pi executable without changing the prototype:

```sh
PI_SPIKE_BIN=/absolute/path/to/pi npm --prefix spikes/pi-native-session run spike
```

An optional temporary evidence path may be supplied:

```sh
npm --prefix spikes/pi-native-session run spike -- \
  --allow-live \
  --evidence /private/tmp/codex-ground-control-v0.3-pi-spike.json
```

The evidence file is sanitized but remains a temporary artifact. It is not a
release qualification receipt.

## App-card boundary

`run.mjs` projects the real native events through
`leaf-session-contract.mjs` and emits the exact structured card state expected
by the prototype MCP App. This proves the data path, not Codex host rendering.
Pixel-level host acceptance still requires installing the isolated prototype
plugin in a fresh Codex App task.

## Product-surface logic prototype

This second throwaway prototype asks:

> Can `delegate_leaf`, `inspect_leaf`, and `cancel_leaf` express the complete
> user-facing lifecycle while Provider events and exact runtime identity remain
> private implementation details?

It uses only in-memory synthetic sessions. It does not start Pi, call a model,
read Provider authentication, write the repository, or access the network.
Drive it interactively with:

```sh
npm --prefix spikes/pi-native-session run prototype:surface
```

Delegate two tasks to check sibling isolation, inject Provider events, inspect
the public cards, or drift a private runtime binding before cancellation. Every
action redraws the complete public state.

Initial interactive verdict:

- the three public operations are sufficient for the proposed user-facing
  lifecycle;
- Provider events remain an internal adapter concern;
- process incarnation remains absent from every public card;
- cancellation fails closed with `LEAF_SESSION_IDENTITY_MISMATCH` after private
  binding drift, without changing the target card or a sibling card.

This verdict applies only to the in-memory product vocabulary. It does not
prove MCP transport behavior, persistence, crash recovery, or a live Provider
run.

## Product-surface MCP App prototype

This third throwaway prototype asks:

> Can one local MCP App expose only `delegate_leaf`, `inspect_leaf`, and
> `cancel_leaf` while sharing one in-memory state projection with its card?

Run its deterministic local contract validation:

```sh
npm --prefix spikes/pi-native-session run prototype:mcp:validate
```

Or start the local stdio server:

```sh
npm --prefix spikes/pi-native-session run prototype:mcp
```

The server creates only synthetic in-memory sessions. `delegate_leaf` projects
an internal synthetic `agent_start`, `inspect_leaf` reads the same card state,
and `cancel_leaf` performs an exact in-memory cancellation followed by a
synthetic settle. The card can call `inspect_leaf` and `cancel_leaf` through the
MCP App bridge and consumes the same structured result returned to the model.

Tool annotations describe the prototype's actual behavior: all tools are
closed-world; inspect is read-only and idempotent; delegate is a non-idempotent
memory mutation; cancel is an idempotent memory mutation. This does not prove
the production `delegate_leaf` open-world permission path. Real Codex Host
rendering and permission dispatch require a separately authorized plugin
installation and fresh visible task.

Initial local MCP verdict:

- in-memory and stdio transports expose exactly the same three tools;
- strict input schemas reject unknown fields and unknown task IDs return a
  bounded `LEAF_TASK_NOT_FOUND` tool error;
- delegate, inspect, cancel, and repeated cancel share one structured card
  state, while a sibling task remains running;
- the widget contains App bridge calls for inspect and cancel plus standard
  size-change notifications;
- public results contain none of the private runtime or credential markers
  scanned by the validator;
- Pi starts, Provider calls, network requests, and repository writes remain
  zero.

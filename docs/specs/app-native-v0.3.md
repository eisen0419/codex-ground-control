# App-native v0.3 product contract

Status: migration gate passed, redesign authorized, production unchanged
Date: 2026-07-28
Last verified: 2026-08-01
Supersedes: no released contract; v0.2 remains the production implementation

## Decision

Ground Control v0.3 is a bounded external leaf-session bridge for the Codex
App. It is not a second task orchestrator, worktree manager, credential
manager, or generic multi-provider control plane.

The user-visible job is:

> From the current Codex App task, delegate one bounded leaf activity to an
> external Agent, observe its provider-native session and structured progress,
> inspect the result, and cancel that exact session.

The existing v0.2 implementation is frozen while this contract and its spike
are evaluated. No v0.2 runtime module may be deleted, merged, or redirected
until every gate in [Migration gate](#migration-gate) has fresh evidence.

## Non-negotiable ownership

| Owner | Owns | Must not own |
| --- | --- | --- |
| Codex App | Task, Local/Worktree/Handoff lifecycle, selected checkout, native plugin permission decision | Provider credentials or Provider session storage |
| `codex-main` | Repository writes, integration, completion decision | Provider authentication |
| Ground Control | Leaf task identity, exact runtime binding, normalized events, event cursor, sanitized card state | Worktree lifecycle, raw credentials, hidden reasoning, Provider transcript ownership |
| Provider adapter | Provider-native launch, session reference, structured event translation, exact cancellation | Repository writes or completion authority |
| Provider | Authentication, model runtime, native session and transcript | Codex task or worktree lifecycle |

One control surface does not mean one cross-provider login. Every adapter uses
the Provider's existing native authentication and reports only
`ready`, `login-required`, `unavailable`, or `error`.

## Product surface

The semantic public surface has three operations:

1. `delegate_leaf`
   - Starts one bounded leaf task after Codex native plugin permission allows
     the open-world operation.
   - Returns a Ground Control task ID and a sanitized App card.
2. `inspect_leaf`
   - Returns current sanitized state, the latest provider-native event cursor,
     and result metadata.
3. `cancel_leaf`
   - Cancels only the runtime bound to the requested Ground Control task.
   - Fails closed if the native session or process incarnation no longer
     matches.

MCP App transport may split preparation and start internally when required by
the host transaction, but that split is not part of the product vocabulary.
There is no user-facing qualification or custom authorization operation in
this surface.

### Host rendering adapter

`render_leaf_card` is a transport-only Host adapter, not a fourth semantic
product operation. It accepts only a Ground Control `taskId`, invokes the same
`inspect_leaf` handler, returns the exact same sanitized projection, and binds
that result to the production MCP App resource. It is model-visible so a Codex
turn can attach the card without first delegating a task, but it is strictly
read-only, closed-world, and idempotent.

The adapter cannot create a task, resolve Host roots, start or recover a
runtime, send Provider input, cancel a session, or synthesize a fallback
projection. A missing or invalid task fails with the same sanitized Host
operation error as `inspect_leaf`.

## LeafRuntime seam

The seam is extracted only from demonstrated Provider behavior:

```text
probe(context) -> capabilities
start(spec, context) -> nativeSessionRef
observe(nativeSessionRef, cursor) -> events
cancel(nativeSessionRef) -> cancellation result
send(nativeSessionRef, input) -> optional
```

The first implementation is `pi-rpc`. A second Provider is not added until the
Pi path passes the migration gate. Common helpers are extracted only after a
second real implementation demonstrates common behavior.

`nativeSessionRef` is private runtime state:

```json
{
  "adapterId": "pi-rpc",
  "provider": "pi",
  "modelProvider": "zai-coding-cn",
  "model": "glm-5.2",
  "sessionId": "provider-native session ID",
  "processIncarnation": "per-launch unguessable identity"
}
```

The App card may expose the Provider, model, and native session ID. It never
exposes the process incarnation, PID, session file path, environment, API key,
raw prompt, raw transcript, or hidden reasoning.

## Canonical event contract

Every accepted event has:

- the exact `nativeSessionRef` binding;
- a monotonically increasing Ground Control sequence;
- `source: provider-native`;
- one normalized type;
- a sanitized timestamp and optional public metadata.

Initial normalized types are:

| Type | Meaning |
| --- | --- |
| `session.created` | The provider returned the expected native session identity. |
| `turn.started` | A provider-native event proves the leaf turn started. |
| `turn.progress` | A provider-native event proves bounded progress. |
| `turn.completed` | The provider settled with an accepted result. |
| `turn.cancel.requested` | Ground Control sent cancellation to the exact bound runtime. |
| `turn.cancelled` | The exact runtime settled after cancellation. |
| `turn.failed` | The exact runtime ended without an accepted result. |

Terminal text, screen scraping, elapsed time, process existence, or an App
poll response cannot by themselves create `turn.completed`.

## State and App card contract

The public state machine is:

```text
starting -> running -> completed
                    -> failed
                    -> cancelling -> cancelled
starting ----------> failed
```

The App card is a projection of normalized state, not a separate authority. It
contains:

- Ground Control task ID;
- adapter/profile and Provider/model identity;
- native session ID and whether the session is inspectable;
- `state`, `stage`, latest normalized event, and `canCancel`;
- sanitized result metadata when terminal.

If the Codex host exposes no API for registering an external session as a
first-class Codex child task, the card must say that it is a Provider-native
session. It must not imitate a native Codex subagent thread.

## Exact cancellation

`cancel_leaf(taskId)` resolves the private binding stored for that task and
compares all of:

- Ground Control task ID;
- adapter ID;
- native session ID;
- process incarnation.

Only an exact match may receive the Provider-native abort command. Ground
Control then waits for the same session to become idle or emit an accepted
terminal cancellation event. It never uses a process-name match, broad PID
scan, terminal title, working directory, or repository identity as a kill
target.

A sibling session must remain responsive after cancellation. A changed or
missing identity returns a blocked result without signaling any process.

## Capability and permission boundary

- Codex native plugin permissions govern `delegate_leaf`.
- The Pi spike runs with no tools, extensions, skills, prompt templates, or
  context files.
- The Pi child receives an explicit profile-scoped environment allowlist.
  Offline mode receives no Provider credential binding. Live `pi-glm` may
  receive only its own `ZAI_CODING_CN_API_KEY` binding when present, or use
  Pi's provider-owned native authentication through the allowlisted
  `HOME`/`PI_CODING_AGENT_DIR`.
- The production Pi leaf remains read-only unless a future host-enforced
  capability test proves a narrower tool set safe.
- Prompt instructions are not a security boundary.
- Provider login state never authorizes a run.
- No second Ground Control permission lease or credential vault is introduced.

## Repository and worktree identity

- The Codex App-selected checkout is passed as `cwd`.
- Ground Control makes zero worktree create, delete, switch, or handoff calls.
- Local and linked Worktree observations share the repository identity derived
  from Git common-dir.
- Provider native session identity and repository identity remain independent.

## Failure isolation

- One adapter failure cannot block `codex-main`, another adapter, or offline
  diagnostics.
- Missing structured events cannot be upgraded to completion using terminal
  output.
- Loss of the runtime binding blocks cancellation rather than broadening its
  target.
- Raw Provider output is not persisted in the App card or normalized event
  journal.

## Executable acceptance contract

| ID | Observable condition |
| --- | --- |
| V3-01 | An App-only user can delegate, inspect, and cancel without invoking a standalone CLI. |
| V3-02 | The App-selected checkout is used and Ground Control performs no worktree lifecycle operation. |
| V3-03 | A live start is governed by Codex native plugin permissions; no second Ground Control authorization prompt is created. |
| V3-04 | A Pi RPC `get_state` response yields an exact native session ID before the first prompt. |
| V3-05 | A Pi provider-native `agent_start` event changes the card from `starting` to `running` and enables exact cancellation. |
| V3-06 | A normal provider-native settle event changes only the matching card to `completed`. |
| V3-07 | A cancellation request requires task, adapter, session, and process-incarnation equality. |
| V3-08 | An accepted Pi RPC abort followed by the matching settle changes the card to `cancelled`. |
| V3-09 | Cancelling one Pi session leaves a sibling Pi RPC session responsive. |
| V3-10 | A mismatched or stale native session reference sends no abort and returns a blocked result. |
| V3-11 | The App card contains no process incarnation, PID, session path, credential, raw prompt, raw transcript, or hidden reasoning. |
| V3-12 | Terminal/screen fallback is marked degraded and cannot independently produce `completed`. |
| V3-13 | Existing v0.2 tests remain green while the spike is isolated. |
| V3-14 | A real Codex App host renders the card from the same state used by `inspect_leaf`; simulated rendering is not pixel-level host evidence. |
| V3-15 | The Pi child receives only the profile-scoped environment allowlist; unrelated credentials and ambient variables do not cross the process boundary. |

## Pi spike

The spike answers one question:

> Can one isolated Pi RPC process provide an exact native session ID,
> provider-native events that drive the App card, and an exact abort that does
> not affect a sibling session?

The spike:

- lives under `spikes/pi-native-session/`;
- is excluded from the published npm package;
- creates Ground Control-owned session state only under the system temporary
  directory;
- in live mode, lets Pi read its existing provider-owned authentication
  through an allowlisted native config location; Ground Control does not copy,
  print, fingerprint, or persist credentials;
- invokes Pi with a generated `--session-id`, isolated `--session-dir`, no
  tools, no extensions, no skills, no prompt templates, and no context files;
- refuses a network prompt unless its one-shot command includes
  `--allow-live`;
- records only sanitized event types, session identity, card projections, and
  cancellation evidence;
- removes its temporary Pi home and session data at exit.

The spike shell is throwaway. Only a validated state/event decision may later
move into production code.

## Evidence status

On 2026-07-28, the explicitly authorized hardened `pi-glm` no-tools probe
observed the exact Pi native session ID, `agent_start`, a `running` card
projection, an accepted exact abort, the matching cancellation settle, and a
responsive offline sibling. All six executable checks passed. The sanitized
evidence file had mode `0600`, passed its credential/path/output scan, and had
SHA-256
`d9082b32dcd83d7b0c4e72f761e8d4c5bbc2a4912f2517dd69c3b236c38b3064`.

The isolated App-host prototype then proved locally that
`inspect_leaf_prototype` and `render_leaf_card_prototype` return the same
structured state, the render tool links the MCP App resource, the resource CSP
allows no network or external resource domains, and the public card state
contains none of the forbidden runtime or Provider fields. This validation
started no runtime and made no network request.

On 2026-07-31, fresh task
`019fb52f-f793-7733-9e00-624e0aabf8ea` completed model turn
`019fb52f-fe7d-72b3-9876-a124d2d36ab7`. Codex control-plane access was
explicitly authorized for that turn while its read-only runtime network policy
remained restricted. The turn completed exactly one MCP business-tool call:
the installed local `render_leaf_card_prototype` from
`app-host-prototype@codex-ground-control-v0-3-spike`. The completed item
attached
`ui://codex-ground-control/v0.3-spike/native-session-card.html` and returned
`cancelled / turn.cancelled`, native session
`82f31f62-07fe-4aff-be8a-26601d37a57f`, and the same sanitized evidence
SHA-256. Codex performed deferred-tool discovery before that call, but no
second business tool was called. The immutable plugin started no Pi, Provider,
or worker and made no network request; `--allow-live` was not used.

Computer Use was not permitted to control Codex itself, and the latest
Chronicle frame still showed the coordinator task rather than the fresh task.
The new task is therefore retained as fresh native Host-tool and resource-link
evidence, not claimed as independent foreground pixel observation.

The read-only Host widget and the three-operation product widget were then
aligned to the same compact, state-first visual language. Both local MCP
validators passed with zero Pi, Provider, network, and repository-write
activity.

The subsequent reduced-independence Standards and Spec review hardened four
observable seams:

- repeated or late `agent_start` events can no longer replay a task into
  `running`;
- a native settle without an accepted result now produces `turn.failed`
  instead of leaving the card without a terminal projection;
- the prototype plugin manifest and Host scripts no longer contain a
  machine-specific checkout path, and the installed-cache entry point now uses
  only Node built-ins rather than reaching back into the source checkout;
- a completed Codex turn is not accepted as Host evidence unless that exact
  turn contains only one action item and it is the completed
  `render_leaf_card_prototype` call from the expected plugin.

After these changes, the complete repository suite passed 126/126 together
with `typecheck`, `release-lock:verify`, both local MCP validators, an isolated
plugin-cache startup, and syntax checks for every v0.3 prototype module. None
of these checks started Pi or made a Provider request.

The local marketplace installation was then updated in place to
`app-host-prototype` `0.3.0-alpha.1`. Its installed cache matched the source
plugin byte-for-byte, contained no `node_modules`, and passed a read-only MCP
initialize, tool-list, and widget-resource read directly from the cache with
zero tool calls. This proves the install artifact is self-contained; by itself
it was not the foreground Host render required by V3-14.

Later on 2026-07-31, the user explicitly authorized one additional
`render_leaf_card_prototype` call in the foreground Codex Desktop Host task
`019fa5a0-73f5-7ee3-8e8f-87c6a390f46f`. Turn
`019fb53e-1e80-7d90-ad79-167060078bd7` completed call
`call_AjeglCRM3jDc2jsRlo96v16i` and attached the expected MCP App resource.
The resulting foreground screenshot is retained as
[app-native-v0.3-foreground-host-card.png](../assets/evidence/app-native-v0.3-foreground-host-card.png)
(1587 x 1104, SHA-256
`fd8a4968d12247a8a2470585c1df4707e2351e5b83616d37054322d0415126cb`).

The card pixels visibly show the compact `Leaf card prototype`, terminal
`已精确取消` state, all three lifecycle steps, `turn.cancelled · #3`, stage
`provider-cancelled`, task suffix `4e48`, native-session suffix `a57f`, evidence
suffix `c38b3064`, and all three isolation checks. The complete card is visible
without clipping or overflow. Those visible identifiers match the structured
result already returned by the render call, so V3-14 and migration gate item 4
pass. The task was persistent, but the render invocation and attached resource
were new; item 4 is therefore stated below in terms of a fresh foreground
render call, which is the observable anti-staleness condition.

The card's historical `Provider 已启动` step is part of the immutable sanitized
fixture; it does not mean this acceptance call started a Provider. The
prototype call itself started no Pi, Provider, or worker, made no plugin
network request, and did not use `--allow-live`.

Immediately before the final live gate on 2026-07-31, the offline probe was
rerun against Pi `0.81.1`. Both RPC session identities matched, two offline Pi
processes started, and Provider-native turn starts and model requests remained
zero.

The user then explicitly authorized one hardened
`pi-glm / glm-5.2 / no-tools / --allow-live` probe, with cancellation required
immediately after `agent_start`. The first workspace-sandboxed invocation
failed closed before `agent_start` and wrote no evidence file. A subsequent
read-only Pi diagnostic observed `EPERM` while Pi attempted to create its
provider-owned settings lock, so that failed attempt is retained as Host
sandbox evidence rather than Provider behavior.

After Host approval to execute the same scoped probe with Pi's native
configuration permissions, native session
`5f32057b-7290-43d6-8ab6-8dd59001ba50` emitted `turn.started`, projected a
cancellable `running` card, accepted exact abort, and emitted the matching
`turn.cancelled` 56 ms later. Offline sibling
`3d3aac70-5ad9-44b4-a69d-92c0b79b1ca8` remained responsive. All six executable
checks passed. The sanitized evidence file had mode `0600`, contained none of
the forbidden credential, path, prompt, transcript, process, or Provider-error
markers, and had SHA-256
`e8f2fd7947df423f9b2bb1631d2eada56e8cdf8a9ab40e9b66690c2cf58f39f1`.

All five migration gate items now have fresh evidence for this source revision.
The migration gate passed on 2026-07-31. This verdict authorizes a separate
production redesign task; it does not itself modify or supersede v0.2.

On 2026-08-01, the production v0.3 Host rendering adapter received its first
foreground acceptance. After Codex Desktop restarted and renegotiated the MCP
tool list, the foreground task completed exactly one Ground Control business
tool call: model-visible `render_leaf_card` for
`host-render-acceptance-20260801-9e2b`. The call returned the durable sanitized
projection `cancelled / provider-cancelled / turn.cancelled #4`, with
`canCancel: false`, and attached
`ui://codex-ground-control/v0.3/leaf-session.html`. The projection contained no
process incarnation, PID, state path, credential, prompt, transcript, or hidden
reasoning.

The fresh foreground frame is retained as
[app-native-v0.3-production-foreground-host-card.jpg](../assets/evidence/app-native-v0.3-production-foreground-host-card.jpg)
(2496 x 1404, SHA-256
`de7ce0c88f2ff27bad5fd1001ae3adbbd8fa3a9b7a37d77f66cc06e7a9959d1a`).
The complete production `Leaf card` is visible: title and terminal status,
three lifecycle stages, latest event and stage, task and native-session
suffixes, and the action row all remain inside the Host container without
clipping, overlap, or horizontal overflow. The displayed identifiers and state
match the structured result returned by the same render call, so V3-14 passes
for the production v0.3 resource rather than the earlier prototype.

This rendering acceptance used a unique terminal fixture produced offline by
the production domain reducer and append-only state store. Its historical
`Provider 运行` step exercises the terminal card projection; the acceptance
call itself did not invoke `delegate_leaf`, start Pi, Provider, or worker, make
a network request, or use `--allow-live`. It proves the read-only Host rendering
seam and production card pixels only; it does not add live runtime evidence for
the remaining v0.3 product operations.

### Production delegation attempts

On 2026-08-01, one explicitly authorized production `delegate_leaf` call used
the bounded `pi-glm / glm-5.2` profile. It failed closed with
`LEAF_PRODUCTION_HOST_DISPATCH_REQUIRED` before Pi, Provider, or worker startup.
The connected Codex Desktop client had not advertised the MCP `roots`
capability, so the SDK rejected the server's attempted `roots/list` request.
The production state root contained no task record or `pi-sessions` directory
after the call.

The production entry then passed its explicit Host-configured STDIO working
directory into the server. A roots-capable Host still takes precedence and must
return exactly one local selected checkout; a Host without roots may use only
the canonical, existing, bounded STDIO directory. Missing, relative,
nonexistent, or filesystem-root directories fail closed before process startup.
Contract tests cover all three cases, including roots precedence over the
configured fallback.

After a Host restart, a second separately authorized and unique production
delegation, `p06-live-gate-20260801-02`, started the bounded
`pi-glm / glm-5.2` profile. Pi returned native session
`38ca9201-2538-4abf-b726-b4079dcf6e86`. The private append-only journal then
recorded only the matching Provider-native transitions:

1. `session.created #1` at `2026-07-31T19:57:12.276Z`;
2. `turn.started #2` at `2026-07-31T19:57:12.293Z`;
3. `turn.progress #3` at `2026-07-31T19:57:14.288Z`;
4. `turn.completed #4` at `2026-07-31T19:57:14.289Z`.

The same read-only production `render_leaf_card` adapter returned
`completed / provider-completed / turn.completed #4`, `canCancel: false`, and
`result.disposition: candidate-evidence`. All five task commit files had mode
`0600`. The public projection exposed no process incarnation, PID, state path,
credential, prompt, transcript, reasoning, or raw Provider output.

The user retained the resulting real Codex Host terminal card as
[app-native-v0.3-production-live-completed-host-card.png](../assets/evidence/app-native-v0.3-production-live-completed-host-card.png)
(1678 x 678, SHA-256
`7c8a401409cfb93c5dfb2b795dedd9bbc7209f5a2c76851569e21b538a771e10`).
The visible `Pi · GLM 5.2` title, activity/profile, completed status, all three
lifecycle stages, `turn.completed #4`, task and native-session suffixes,
`provider-completed` stage, and action row match the structured projection.
The complete card remains inside the Host container without clipping, overlap,
or horizontal overflow.

This run proves the repaired no-roots Host dispatch, real Pi/Provider start,
native session creation, Provider-native running/progress/normal-settle events,
durable completion, final sanitized production projection, and a matching real
Host terminal-card pixel observation. It does not add exact-cancellation
evidence: the Provider completed in about two seconds before the foreground
cancel button could be used. No second delegation was attempted.

The STDIO fallback supports the controlled canary only when the MCP server's
configured `cwd` is the current checkout; it does not prove dynamic
App-selected checkout resolution across arbitrary tasks or linked worktrees.
The remaining production live gaps are a fresh running-card pixel observation,
exact Host-card cancellation and matching cancelled settle, and dynamic
checkout proof beyond this configured canary.

## Migration gate

Gate verdict: passed on 2026-07-31. Existing v0.2 remains the production
implementation while the separately authorized redesign is planned.

1. Offline protocol probe proves Pi RPC session identity without a model call.
2. A one-shot live spike proves native start event, running card projection,
   exact abort, matching cancellation settle, and sibling survival.
3. Contract tests pass using the same event and card semantics.
4. A fresh read-only render call in a foreground Codex App task displays the
   production v0.3 card and the observed state matches `inspect_leaf`.
5. Existing `npm test`, typecheck, and release-lock verification remain green.

Passing the gate authorizes a separate redesign task. It does not itself
authorize deleting FleetRunner, Provider lifecycle, qualification, evidence,
or v0.2 tools.

---
name: multi-agent-router
description: Route bounded engineering work only after the active Matt Pocock workflow phase is known, while enforcing one Codex coordinator, one workspace writer, user-only skill boundaries, independent capability gates, and leaf-only adapters.
---

# Ground Control Router

Keep the main Codex as the only user-facing coordinator, workspace writer, and
completion authority.

## Route in this order

1. Read the applicable `AGENTS.md` files and identify the active Matt Pocock
   engineering phase.
2. If the next required skill is user-only and the user has not invoked it,
   stop routing. Return one `$skill-name` command with a short reason and the
   phase that follows. Do not invoke, simulate, or delegate around that skill.
3. Decide whether a bounded independent task would materially improve speed,
   expertise, or independent verification. Keep simple and tightly coupled
   work in the main Codex.
4. Resolve the proposed adapter in the installed Ground Control capability
   manifest. Dispatch only when its own gate is `passed`, it is enabled, and it
   is qualified for the current fingerprint. Missing, unknown, blocked, or
   stale evidence fails closed.
5. Give the adapter one bounded brief: objective, allowed inputs, forbidden
   actions, acceptance checks, output limit, and required structured result.
6. Accept adapter output only as evidence. The main Codex inspects it, reruns
   proportionate verification, and decides completion.

## Authority boundaries

- External adapters are leaf tools. They cannot create workers or recursively
  delegate.
- External adapters cannot edit the workspace, change authorization, commit,
  or declare completion.
- A passed gate authorizes only the adapter bound to that gate. One blocked
  gate does not disable unrelated qualified adapters.
- Configuration and model self-report are not capability evidence.
- Never include credentials or private data that the bounded task does not
  require.

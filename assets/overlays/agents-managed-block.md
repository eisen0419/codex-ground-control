<!-- codex-ground-control:managed:start -->
## Ground Control for Codex

This block is managed by `codex-ground-control`. Keep project-specific
instructions outside these markers.

### Workflow control

- Identify the applicable Matt Pocock engineering phase before delegating any
  work.
- A skill marked as user-only must be explicitly invoked by the user. The
  Router may recommend its single next command, but must not invoke it,
  simulate it, or delegate around it.
- The main Codex is the only user-facing coordinator, workspace writer, and
  completion authority.
- External models are bounded leaf adapters. They may not delegate, edit the
  workspace, change authorization, commit, or claim completion.
- Use only an adapter whose independent capability gate is passed and whose
  installed manifest says it is enabled and qualified. Unknown, missing, or
  stale evidence fails closed.
- Prefer the main Codex for tightly coupled or simple work. Delegate only a
  bounded independent scope that materially improves speed, expertise, or
  independent verification.
- Treat adapter output as evidence. The main Codex must inspect it and rerun
  proportionate verification before accepting it.
<!-- codex-ground-control:managed:end -->

# v0.3 App host prototype

This directory is a throwaway host-rendering prototype. It is not part of the
v0.2 plugin, npm package, or production runtime.

It answers only one acceptance question:

> Can a real Codex App host render the same sanitized state returned by an
> inspect tool?

The two read-only tools return the same immutable fixture:

- `inspect_leaf_prototype` returns the authoritative structured snapshot
  without attaching UI.
- `render_leaf_card_prototype` returns that same snapshot and attaches the MCP
  App resource.

The fixture was manually reduced from the explicitly authorized hardened
`pi-glm / no-tools / --allow-live` probe. It contains the final cancelled card
and the SHA-256 of the sanitized source evidence; it does not contain a
credential, process identity, filesystem path, prompt, transcript, reasoning,
or Provider error output.

Validate the local MCP contract:

```sh
npm --prefix spikes/pi-native-session/app-host-prototype run validate
```

The plugin manifest resolves `standalone-server.mjs` relative to the installed
plugin directory and contains no machine-specific checkout path. That entry
point uses only Node built-ins, so Codex's cached plugin copy does not depend on
the repository's `node_modules`. The validator copies the plugin into an
isolated temporary cache, starts the manifest command there, and compares its
tools, resource, and structured result with the SDK-backed development server.

The validator also exercises the Host evidence parser: a completed Codex turn
is accepted only when that same turn contains exactly one action item, namely a
completed `render_leaf_card_prototype` MCP tool call from this plugin.

The current widget uses the same compact, state-first visual language as the
three-operation product-surface prototype. IDs and the evidence hash remain
available in full through the element title while the visible card keeps them
secondary and truncated.

Real host acceptance requires a separately authorized local plugin install and
a fresh render invocation in a foreground Codex task. That turn must call only
`render_leaf_card_prototype`; it must not run the Pi spike again.

With that authorization in place, `node host-turn.mjs` creates the fresh
persistent task and runs the guarded model turn. Passing an existing thread ID
instead resumes that task. The script rejects the result unless the completed
turn contains exactly one MCP action item and it is the expected render call.
Codex control-plane access is separate from the turn's read-only,
network-restricted runtime and from the plugin's zero-network implementation.

After any widget revision, local HTTP preview and MCP contract validation do
not replace a fresh foreground Codex Host render. Treat that final visual check
as a separate evidence gate.

The 2026-07-31 acceptance kept these evidence classes separate: a standalone
fresh task proved the guarded Host turn and resource attachment, while a later
new render call in the visible Codex Desktop task produced the retained
[foreground Host screenshot](../../../docs/assets/evidence/app-native-v0.3-foreground-host-card.png).
The screenshot visibly matches the immutable structured snapshot and closes
the pixel-level Host-rendering gate. `Provider 已启动` on the card describes the
historical sanitized fixture; the rendering call itself starts no runtime.

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  createLeafProductionComposition,
  registerLeafMcpTools,
} from "../src/v0.3/leaf-mcp-composition.js";
import { createNodePiRpcProcessBoundary } from "../src/v0.3/pi-rpc-adapter.js";

const checkout = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtureExecutable = fileURLToPath(
  new URL("./v0.3-node-process-recovery.test.mjs", import.meta.url),
);

function register(composition) {
  const tools = new Map();
  registerLeafMcpTools({
    server: {
      registerTool(name, definition, handler) {
        tools.set(name, { definition, handler });
      },
    },
    composition,
  });
  return tools;
}

function productionOptions({
  rootDirectory,
  processBoundary,
  sessionIds,
  incarnations,
}) {
  return {
    rootDirectory,
    processBoundary,
    command: process.execPath,
    commandArgs: [fixtureExecutable, "--v0.3-offline-pi-rpc-fixture"],
    profiles: {
      "offline-fixture": {
        adapterId: "pi-rpc",
        modelProvider: "offline-fixture",
        model: "deterministic",
        environment: {
          SAFE_MARKER: "allowed",
          PROVIDER_CREDENTIAL: "must-not-cross",
        },
        environmentAllowlist: ["SAFE_MARKER"],
      },
    },
    sessionIdFactory: () => sessionIds.shift(),
    sessionDirectoryFromSessionId(sessionId) {
      return join(rootDirectory, "pi-sessions", sessionId);
    },
    processIncarnationFactory: () => incarnations.shift(),
    clock: () => "2026-07-31T04:00:00.000Z",
    requestTimeoutMs: 2_000,
    hostDispatchFromCall(callContext) {
      if (callContext?.dispatched !== true) {
        throw new Error("raw-host-permission-detail");
      }
      return { selectedCheckout: checkout };
    },
  };
}

async function allJournalText(rootDirectory) {
  const chunks = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else {
        chunks.push(await readFile(target, "utf8"));
      }
    }
  }
  await visit(rootDirectory);
  return chunks.join("\n");
}

test("offline production Host flow delegates, recovers, exactly cancels, isolates siblings, and leaks no private material", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-e2e-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const rootDirectory = join(temporaryDirectory, "state");
  const processBoundary = createNodePiRpcProcessBoundary();
  t.after(() => processBoundary.close());
  const sessionIds = [
    "00000000-0000-4000-8000-000000001001",
    "00000000-0000-4000-8000-000000001002",
    "00000000-0000-4000-8000-000000001003",
  ];
  const incarnations = [
    "incarnation-e2e-1001",
    "incarnation-e2e-1002",
    "incarnation-e2e-1003",
  ];
  const first = createLeafProductionComposition(
    productionOptions({
      rootDirectory,
      processBoundary,
      sessionIds,
      incarnations,
    }),
  );
  const firstTools = register(first);
  const baseInput = {
    adapterId: "pi-rpc",
    profile: "offline-fixture",
    activity: "offline end-to-end",
    input: "fixture:start",
  };

  const denied = await firstTools.get("delegate_leaf").handler(
    { ...baseInput, taskId: "leaf-denied" },
    {},
  );
  assert.equal(denied.isError, true);
  assert.equal(
    denied.content[0].text,
    "LEAF_PRODUCTION_HOST_DISPATCH_REQUIRED",
  );
  assert.equal(
    JSON.stringify(denied).includes("raw-host-permission-detail"),
    false,
  );

  for (const taskId of ["leaf-1001", "leaf-1002"]) {
    const delegated = await firstTools.get("delegate_leaf").handler(
      { ...baseInput, taskId },
      { dispatched: true },
    );
    assert.equal(delegated.structuredContent.stage, "session-created");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const running = await firstTools.get("inspect_leaf").handler({ taskId });
    assert.equal(running.structuredContent.state, "running");
    assert.equal(running.structuredContent.latestEvent.type, "turn.started");
  }

  await firstTools.get("delegate_leaf").handler(
    {
      ...baseInput,
      taskId: "leaf-crash",
      input: "fixture:crash",
    },
    { dispatched: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const crashed = await firstTools.get("inspect_leaf").handler({
    taskId: "leaf-crash",
  });
  assert.equal(crashed.isError, true);
  assert.equal(
    crashed.content[0].text,
    "LEAF_SERVICE_ADAPTER_UNAVAILABLE",
  );
  assert.equal(JSON.stringify(crashed).includes("fixture:crash"), false);
  const crashRecovery = await firstTools.get("inspect_leaf").handler({
    taskId: "leaf-crash",
  });
  assert.equal(crashRecovery.structuredContent.state, "starting");
  assert.equal(crashRecovery.structuredContent.canCancel, false);

  const rebuilt = createLeafProductionComposition(
    productionOptions({
      rootDirectory,
      processBoundary,
      sessionIds: ["must-not-start-during-recovery"],
      incarnations: ["must-not-start-during-recovery"],
    }),
  );
  const rebuiltTools = register(rebuilt);
  const recovered = await rebuiltTools.get("inspect_leaf").handler({
    taskId: "leaf-1001",
  });
  assert.equal(recovered.structuredContent.state, "running");
  assert.equal(recovered.structuredContent.canCancel, true);

  const cancelled = await rebuiltTools.get("cancel_leaf").handler({
    taskId: "leaf-1001",
  });
  assert.equal(cancelled.structuredContent.state, "cancelled");
  assert.equal(
    cancelled.structuredContent.latestEvent.type,
    "turn.cancelled",
  );
  const sibling = await rebuiltTools.get("inspect_leaf").handler({
    taskId: "leaf-1002",
  });
  assert.equal(sibling.structuredContent.state, "running");
  assert.equal(sibling.structuredContent.canCancel, true);

  for (const result of [recovered, cancelled, sibling]) {
    const publicBytes = JSON.stringify(result).toLowerCase();
    for (const forbidden of [
      "processincarnation",
      "incarnation-e2e",
      "pid",
      "sessionpath",
      "environment",
      "provider_credential",
      "rawprompt",
      "transcript",
      "reasoning",
      "raw-host-permission-detail",
    ]) {
      assert.equal(publicBytes.includes(forbidden), false);
    }
  }

  const journal = (await allJournalText(rootDirectory)).toLowerCase();
  for (const forbidden of [
    "fixture:start",
    "fixture:crash",
    "raw-host-permission-detail",
    "codex-host",
    checkout.toLowerCase(),
    "safe_marker",
    "provider_credential",
    "transcript",
    "reasoning",
    "rawprovidererror",
  ]) {
    assert.equal(journal.includes(forbidden), false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import {
  createLeafMcpComposition,
} from "../src/v0.3/leaf-mcp-composition.js";

test("MCP composition exposes only three operations and returns the exact inspect card", async () => {
  const cards = new Map();
  const calls = [];
  const service = {
    async delegateLeaf(spec) {
      calls.push(["delegate", spec]);
      cards.set(spec.taskId, {
        schemaVersion: "0.3",
        taskId: spec.taskId,
        state: "starting",
      });
      return cards.get(spec.taskId);
    },
    async inspectLeaf(taskId) {
      calls.push(["inspect", taskId]);
      return cards.get(taskId);
    },
    async cancelLeaf(taskId) {
      calls.push(["cancel", taskId]);
      cards.set(taskId, {
        ...cards.get(taskId),
        state: "cancelled",
      });
      return cards.get(taskId);
    },
  };
  const composition = createLeafMcpComposition({ service });

  assert.deepEqual(
    composition.definitions.map(({ name }) => name),
    ["delegate_leaf", "inspect_leaf", "cancel_leaf"],
  );
  assert.equal(
    composition.definitions[0].annotations.openWorldHint,
    true,
  );
  assert.equal(
    composition.definitions[0].inputSchema.additionalProperties,
    false,
  );
  assert.equal(
    Object.hasOwn(
      composition.definitions[0].inputSchema.properties,
      "permissionGranted",
    ),
    false,
  );
  assert.deepEqual(
    composition.definitions.map(({ annotations }) => annotations),
    [
      {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: false,
      },
      {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
        idempotentHint: true,
      },
      {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: true,
        idempotentHint: true,
      },
    ],
  );
  assert.equal(
    composition.definitions.some(
      ({ name }) => name.includes("authorize"),
    ),
    false,
  );

  const spec = {
    taskId: "leaf-701",
    adapterId: "pi-rpc",
    profile: "pi-glm",
    activity: "testing",
  };
  const delegated =
    await composition.handlers.delegate_leaf(spec);
  assert.deepEqual(
    delegated,
    await service.inspectLeaf("leaf-701"),
  );
  const inspected =
    await composition.handlers.inspect_leaf({
      taskId: "leaf-701",
    });
  assert.deepEqual(
    inspected,
    await service.inspectLeaf("leaf-701"),
  );
  const cancelled =
    await composition.handlers.cancel_leaf({
      taskId: "leaf-701",
    });
  assert.deepEqual(
    cancelled,
    await service.inspectLeaf("leaf-701"),
  );
  assert.deepEqual(calls[0], ["delegate", spec]);
  assert.equal(
    calls.some(([operation]) => operation === "permission"),
    false,
  );
});

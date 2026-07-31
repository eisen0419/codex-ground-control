import assert from "node:assert/strict";
import test from "node:test";

import {
  createLeafRuntimeRegistry,
} from "../src/v0.3/leaf-runtime-registry.js";

const firstBinding = Object.freeze({
  adapterId: "pi-rpc",
  provider: "pi",
  modelProvider: "zai-coding-cn",
  model: "glm-5.2",
  sessionId: "00000000-0000-4000-8000-000000000401",
  processIncarnation: "launch-401",
});

test("runtime registry resolves only an exact task and native-session binding", () => {
  const registry = createLeafRuntimeRegistry();
  const runtime = Object.freeze({ opaque: "runtime-401" });

  registry.register({
    taskId: "leaf-401",
    nativeSessionBinding: firstBinding,
    runtime,
  });

  assert.equal(
    registry.resolve({
      taskId: "leaf-401",
      nativeSessionBinding: firstBinding,
    }),
    runtime,
  );
  assert.throws(
    () =>
      registry.resolve({
        taskId: "leaf-401",
        nativeSessionBinding: {
          ...firstBinding,
          processIncarnation: "stale-launch",
        },
      }),
    (error) =>
      error?.code === "LEAF_RUNTIME_IDENTITY_MISMATCH" &&
      error.retryable === false,
  );
  assert.throws(
    () =>
      registry.resolve({
        taskId: "leaf-402",
        nativeSessionBinding: firstBinding,
      }),
    (error) =>
      error?.code === "LEAF_RUNTIME_NOT_FOUND" &&
      error.retryable === false,
  );
});

test("runtime registry cannot overwrite a task and retiring one task preserves its sibling", () => {
  const registry = createLeafRuntimeRegistry();
  const firstRuntime = Object.freeze({ opaque: "runtime-401" });
  const siblingRuntime = Object.freeze({ opaque: "runtime-402" });
  const siblingBinding = Object.freeze({
    ...firstBinding,
    sessionId: "00000000-0000-4000-8000-000000000402",
    processIncarnation: "launch-402",
  });

  registry.register({
    taskId: "leaf-401",
    nativeSessionBinding: firstBinding,
    runtime: firstRuntime,
  });
  registry.register({
    taskId: "leaf-402",
    nativeSessionBinding: siblingBinding,
    runtime: siblingRuntime,
  });

  assert.throws(
    () =>
      registry.register({
        taskId: "leaf-cross-task",
        nativeSessionBinding: firstBinding,
        runtime: Object.freeze({ opaque: "cross-task-runtime" }),
      }),
    (error) => error?.code === "LEAF_RUNTIME_IDENTITY_MISMATCH",
  );
  assert.throws(
    () =>
      registry.register({
        taskId: "leaf-401",
        nativeSessionBinding: {
          ...firstBinding,
          processIncarnation: "replacement-launch",
        },
        runtime: Object.freeze({ opaque: "replacement" }),
      }),
    (error) => error?.code === "LEAF_RUNTIME_CONFLICT",
  );
  assert.equal(
    registry.retire({
      taskId: "leaf-401",
      nativeSessionBinding: firstBinding,
    }),
    firstRuntime,
  );
  assert.equal(
    registry.resolve({
      taskId: "leaf-402",
      nativeSessionBinding: siblingBinding,
    }),
    siblingRuntime,
  );
});

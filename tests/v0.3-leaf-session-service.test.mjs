import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLeafRuntimeRegistry,
} from "../src/v0.3/leaf-runtime-registry.js";
import {
  createLeafSessionService,
} from "../src/v0.3/leaf-session-service.js";
import {
  createLeafStateStore,
} from "../src/v0.3/leaf-state-store.js";

const binding = Object.freeze({
  adapterId: "pi-rpc",
  provider: "pi",
  modelProvider: "zai-coding-cn",
  model: "glm-5.2",
  sessionId: "00000000-0000-4000-8000-000000000501",
  processIncarnation: "launch-501",
});

async function withStore(callback) {
  const rootDirectory = mkdtempSync(
    join(tmpdir(), "leaf-session-service-test-"),
  );
  try {
    return await callback(
      createLeafStateStore({ rootDirectory }),
      rootDirectory,
    );
  } finally {
    rmSync(rootDirectory, { recursive: true, force: true });
  }
}

test("delegate persists session.created before exposing the exact live runtime", async () => {
  await withStore(async (store) => {
    const registry = createLeafRuntimeRegistry();
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe() {
        return [];
      },
      async cancel() {
        throw new Error("not expected");
      },
      async recover() {
        return null;
      },
    };
    const service = createLeafSessionService({
      store,
      registry,
      adapters: new Map([["pi-rpc", adapter]]),
      clock: () => "2026-07-31T01:00:00.000Z",
    });

    const card = await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });

    assert.equal(card.state, "starting");
    assert.equal(card.stage, "session-created");
    assert.equal(card.latestEvent.sequence, 1);
    assert.equal(
      registry.resolve({
        taskId: "leaf-501",
        nativeSessionBinding: binding,
      }),
      runtime,
    );
    assert.deepEqual(
      store.readEvents("leaf-501", { afterSequence: 0 }),
      [
        {
          taskId: "leaf-501",
          nativeSessionBinding: binding,
          sequence: 1,
          type: "session.created",
          source: "provider-native",
          observedAt: "2026-07-31T01:00:00.000Z",
        },
      ],
    );
  });
});

test("inspect commits ordered Provider events before returning a terminal projection", async () => {
  await withStore(async (store) => {
    const cursors = [];
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        cursors.push(afterSequence);
        return [
          {
            nativeSessionBinding: binding,
            sequence: 2,
            observedAt: "2026-07-31T01:00:01.000Z",
            signal: { type: "turn.started" },
          },
          {
            nativeSessionBinding: binding,
            sequence: 3,
            observedAt: "2026-07-31T01:00:02.000Z",
            signal: {
              type: "result.accepted",
              result: { disposition: "candidate-evidence" },
            },
          },
          {
            nativeSessionBinding: binding,
            sequence: 4,
            observedAt: "2026-07-31T01:00:03.000Z",
            signal: { type: "turn.settled" },
          },
        ];
      },
      async cancel() {
        throw new Error("not expected");
      },
      async recover() {
        return null;
      },
    };
    const registry = createLeafRuntimeRegistry();
    const service = createLeafSessionService({
      store,
      registry,
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });

    const card = await service.inspectLeaf("leaf-501");

    assert.deepEqual(cursors, [1]);
    assert.deepEqual(
      {
        state: card.state,
        stage: card.stage,
        latestEvent: card.latestEvent,
        result: card.result,
      },
      {
        state: "completed",
        stage: "provider-completed",
        latestEvent: {
          sequence: 4,
          type: "turn.completed",
          source: "provider-native",
          observedAt: "2026-07-31T01:00:03.000Z",
        },
        result: { disposition: "candidate-evidence" },
      },
    );
    assert.equal(store.readTask("leaf-501").state, "completed");
    assert.throws(
      () =>
        registry.resolve({
          taskId: "leaf-501",
          nativeSessionBinding: binding,
        }),
      (error) => error?.code === "LEAF_RUNTIME_NOT_FOUND",
    );
  });
});

test("cancel commits the request before one exact abort and settles only the target", async () => {
  await withStore(async (store) => {
    const cancelCalls = [];
    let observeCount = 0;
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        observeCount += 1;
        if (afterSequence === 1) {
          return [
            {
              nativeSessionBinding: binding,
              sequence: 2,
              observedAt: "2026-07-31T01:00:01.000Z",
              signal: { type: "turn.started" },
            },
          ];
        }
        if (afterSequence === 3) {
          return [
            {
              nativeSessionBinding: binding,
              sequence: 4,
              observedAt: "2026-07-31T01:00:03.000Z",
              signal: { type: "turn.settled" },
            },
          ];
        }
        return [];
      },
      async cancel(input) {
        cancelCalls.push(input);
      },
      async recover() {
        return null;
      },
    };
    const registry = createLeafRuntimeRegistry();
    const service = createLeafSessionService({
      store,
      registry,
      adapters: { "pi-rpc": adapter },
      clock: (() => {
        const timestamps = [
          "2026-07-31T01:00:00.000Z",
          "2026-07-31T01:00:02.000Z",
        ];
        return () => timestamps.shift();
      })(),
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    assert.equal((await service.inspectLeaf("leaf-501")).state, "running");

    const card = await service.cancelLeaf("leaf-501");

    assert.equal(card.state, "cancelled");
    assert.equal(card.latestEvent.sequence, 4);
    assert.equal(cancelCalls.length, 1);
    assert.deepEqual(cancelCalls[0], {
      nativeSessionBinding: binding,
      runtime,
      afterSequence: 3,
    });
    assert.equal(observeCount, 2);
    assert.throws(
      () =>
        registry.resolve({
          taskId: "leaf-501",
          nativeSessionBinding: binding,
        }),
      (error) => error?.code === "LEAF_RUNTIME_NOT_FOUND",
    );
  });
});

test("a restarted service recovers only the persisted binding and reports unavailable cancellation truthfully", async () => {
  await withStore(async (store) => {
    const firstRuntime = Object.freeze({ opaque: "runtime-before-restart" });
    const recoveredRuntime = Object.freeze({
      opaque: "runtime-after-restart",
    });
    const startAdapter = {
      async start() {
        return {
          nativeSessionBinding: binding,
          runtime: firstRuntime,
        };
      },
      async observe({ afterSequence }) {
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const firstService = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": startAdapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await firstService.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    assert.equal(
      (await firstService.inspectLeaf("leaf-501")).state,
      "running",
    );

    const recoverCalls = [];
    const recoveredRegistry = createLeafRuntimeRegistry();
    const recoveredAdapter = {
      ...startAdapter,
      async recover(input) {
        recoverCalls.push(input);
        return {
          nativeSessionBinding: binding,
          runtime: recoveredRuntime,
        };
      },
    };
    const recoveredService = createLeafSessionService({
      store,
      registry: recoveredRegistry,
      adapters: { "pi-rpc": recoveredAdapter },
    });

    const recoveredCard =
      await recoveredService.inspectLeaf("leaf-501");

    assert.equal(recoveredCard.state, "running");
    assert.equal(recoveredCard.canCancel, true);
    assert.deepEqual(recoverCalls, [
      {
        taskId: "leaf-501",
        nativeSessionBinding: binding,
        afterSequence: 2,
      },
    ]);
    assert.equal(
      recoveredRegistry.resolve({
        taskId: "leaf-501",
        nativeSessionBinding: binding,
      }),
      recoveredRuntime,
    );

    const unavailableService = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: {},
    });
    const unavailableCard =
      await unavailableService.inspectLeaf("leaf-501");
    assert.equal(unavailableCard.state, "running");
    assert.equal(unavailableCard.canCancel, false);
    assert.equal(
      JSON.stringify(unavailableCard).includes("runtime-before-restart"),
      false,
    );
  });
});

test("concurrent cancellation sends one exact abort and a stale registry blocks without signalling", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    let cancelCount = 0;
    let settled = false;
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        if (afterSequence === 1) {
          return [
            {
              nativeSessionBinding: binding,
              sequence: 2,
              observedAt: "2026-07-31T01:00:01.000Z",
              signal: { type: "turn.started" },
            },
          ];
        }
        if (afterSequence === 3 && settled) {
          return [
            {
              nativeSessionBinding: binding,
              sequence: 4,
              observedAt: "2026-07-31T01:00:03.000Z",
              signal: { type: "turn.settled" },
            },
          ];
        }
        return [];
      },
      async cancel() {
        cancelCount += 1;
        settled = true;
      },
      async recover() {
        return {
          nativeSessionBinding: binding,
          runtime,
        };
      },
    };
    const service = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: (() => {
        const timestamps = [
          "2026-07-31T01:00:00.000Z",
          "2026-07-31T01:00:02.000Z",
        ];
        return () =>
          timestamps.shift() ??
          "2026-07-31T01:00:04.000Z";
      })(),
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await service.inspectLeaf("leaf-501");

    const [first, second] = await Promise.all([
      service.cancelLeaf("leaf-501"),
      service.cancelLeaf("leaf-501"),
    ]);

    assert.equal(first.state, "cancelled");
    assert.equal(second.state, "cancelled");
    assert.equal(cancelCount, 1);

    const staleRegistry = createLeafRuntimeRegistry();
    const staleBinding = {
      ...binding,
      processIncarnation: "stale-launch",
    };
    staleRegistry.register({
      taskId: "leaf-501",
      nativeSessionBinding: staleBinding,
      runtime: Object.freeze({ opaque: "stale-runtime" }),
    });
    const staleService = createLeafSessionService({
      store,
      registry: staleRegistry,
      adapters: { "pi-rpc": adapter },
    });
    const terminal = await staleService.cancelLeaf("leaf-501");
    assert.equal(terminal.state, "cancelled");
    assert.equal(cancelCount, 1);
  });
});

test("recoverLeaf stops at injected bounds without synthesizing a terminal event", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {},
      async recover() {
        return {
          nativeSessionBinding: binding,
          runtime,
        };
      },
    };
    const first = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await first.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await first.inspectLeaf("leaf-501");

    const waits = [];
    const clockValues = [
      "2026-07-31T01:00:02.000Z",
      "2026-07-31T01:00:02.010Z",
      "2026-07-31T01:00:02.020Z",
      "2026-07-31T01:00:02.030Z",
    ];
    const restarted = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () =>
        clockValues.shift() ??
        "2026-07-31T01:00:02.030Z",
      wait: async (milliseconds) => {
        waits.push(milliseconds);
      },
      recoveryPolicy: {
        maxAttempts: 2,
        deadlineMs: 100,
        pollIntervalMs: 10,
      },
    });

    const result = await restarted.recoverLeaf("leaf-501");

    assert.equal(result.status, "pending");
    assert.equal(
      result.error.code,
      "LEAF_SERVICE_RECOVERY_TIMEOUT",
    );
    assert.equal(result.error.retryable, false);
    assert.equal(result.projection.state, "running");
    assert.deepEqual(waits, [10]);
    assert.deepEqual(
      store.readEvents("leaf-501", { afterSequence: 2 }),
      [],
    );
  });
});

test("delegate exact-cleans a started runtime after persistence, registration, or send failure", async () => {
  await withStore(async (store, rootDirectory) => {
    const cleanupCalls = [];
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async send() {
        throw new Error("raw-provider-secret");
      },
      async observe() {
        return [];
      },
      async cancel(input) {
        cleanupCalls.push(input);
      },
      async recover() {
        return null;
      },
    };

    chmodSync(rootDirectory, 0o500);
    const persistenceService = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await assert.rejects(
      persistenceService.delegateLeaf({
        taskId: "leaf-persistence",
        adapterId: "pi-rpc",
        profile: "pi-glm",
        activity: "testing",
      }),
      (error) =>
        error?.code === "LEAF_SERVICE_PERSISTENCE_ERROR" &&
        !error.message.includes("raw-provider-secret"),
    );
    chmodSync(rootDirectory, 0o700);

    const conflictingRegistry = createLeafRuntimeRegistry();
    conflictingRegistry.register({
      taskId: "leaf-registration",
      nativeSessionBinding: binding,
      runtime: Object.freeze({ opaque: "existing-runtime" }),
    });
    const registrationService = createLeafSessionService({
      store,
      registry: conflictingRegistry,
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await assert.rejects(
      registrationService.delegateLeaf({
        taskId: "leaf-registration",
        adapterId: "pi-rpc",
        profile: "pi-glm",
        activity: "testing",
      }),
      (error) => error?.code === "LEAF_SERVICE_IDENTITY_ERROR",
    );

    const sendService = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await assert.rejects(
      sendService.delegateLeaf({
        taskId: "leaf-send",
        adapterId: "pi-rpc",
        profile: "pi-glm",
        activity: "testing",
        input: "bounded prompt",
      }),
      (error) =>
        error?.code === "LEAF_SERVICE_ADAPTER_UNAVAILABLE" &&
        !error.message.includes("raw-provider-secret"),
    );

    assert.equal(cleanupCalls.length, 3);
    for (const call of cleanupCalls) {
      assert.deepEqual(call, {
        nativeSessionBinding: binding,
        runtime,
      });
    }
  });
});

test("inspect accepts an exact duplicate but rejects conflicts, gaps, and binding drift", async () => {
  await withStore(async (store) => {
    let observed = [];
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe() {
        return observed;
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const service = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    observed = [
      {
        nativeSessionBinding: binding,
        sequence: 2,
        observedAt: "2026-07-31T01:00:01.000Z",
        signal: { type: "turn.started" },
      },
    ];
    assert.equal((await service.inspectLeaf("leaf-501")).state, "running");
    assert.equal((await service.inspectLeaf("leaf-501")).state, "running");
    assert.equal(store.readEvents("leaf-501").length, 2);

    observed = [
      {
        nativeSessionBinding: binding,
        sequence: 2,
        observedAt: "2026-07-31T01:00:09.000Z",
        signal: { type: "turn.started" },
      },
    ];
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) => error?.code === "LEAF_SERVICE_SEQUENCE_ERROR",
    );

    observed = [
      {
        nativeSessionBinding: binding,
        sequence: 4,
        observedAt: "2026-07-31T01:00:04.000Z",
        signal: {
          type: "result.accepted",
          result: { disposition: "candidate-evidence" },
        },
      },
    ];
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) => error?.code === "LEAF_SERVICE_SEQUENCE_ERROR",
    );

    observed = [
      {
        nativeSessionBinding: binding,
        sequence: 0,
        observedAt: "2026-07-31T01:00:00.000Z",
        signal: { type: "turn.started" },
      },
    ];
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) => error?.code === "LEAF_SERVICE_SEQUENCE_ERROR",
    );

    observed = [
      {
        nativeSessionBinding: {
          ...binding,
          processIncarnation: "stale-launch",
        },
        sequence: 3,
        observedAt: "2026-07-31T01:00:03.000Z",
        signal: {
          type: "result.accepted",
          result: { disposition: "candidate-evidence" },
        },
      },
    ];
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) => error?.code === "LEAF_SERVICE_IDENTITY_ERROR",
    );
  });
});

test("a failed terminal persistence never appears in the public projection", async () => {
  await withStore(async (store, rootDirectory) => {
    let observed = [];
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe() {
        return observed;
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const service = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    observed = [
      {
        nativeSessionBinding: binding,
        sequence: 2,
        observedAt: "2026-07-31T01:00:01.000Z",
        signal: { type: "turn.started" },
      },
      {
        nativeSessionBinding: binding,
        sequence: 3,
        observedAt: "2026-07-31T01:00:02.000Z",
        signal: {
          type: "result.accepted",
          result: { disposition: "candidate-evidence" },
        },
      },
    ];
    assert.equal(
      (await service.inspectLeaf("leaf-501")).stage,
      "provider-result-observed",
    );

    const digest = createHash("sha256")
      .update("leaf-501")
      .digest("hex");
    const taskDirectory = join(rootDirectory, "tasks", digest);
    chmodSync(taskDirectory, 0o500);
    observed = [
      {
        nativeSessionBinding: binding,
        sequence: 4,
        observedAt: "2026-07-31T01:00:03.000Z",
        signal: { type: "turn.settled" },
      },
    ];
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) => error?.code === "LEAF_SERVICE_PERSISTENCE_ERROR",
    );
    chmodSync(taskDirectory, 0o700);
    assert.equal(
      store.readTask("leaf-501").stage,
      "provider-result-observed",
    );
    assert.equal(store.readTask("leaf-501").state, "running");
  });
});

test("cancel blocks after durable intent when a stale registry cannot accept exact recovery", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    let cancelCount = 0;
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {
        cancelCount += 1;
      },
      async recover() {
        return { nativeSessionBinding: binding, runtime };
      },
    };
    const first = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await first.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await first.inspectLeaf("leaf-501");

    const staleRegistry = createLeafRuntimeRegistry();
    staleRegistry.register({
      taskId: "leaf-501",
      nativeSessionBinding: {
        ...binding,
        processIncarnation: "stale-launch",
      },
      runtime: Object.freeze({ opaque: "stale-runtime" }),
    });
    const restarted = createLeafSessionService({
      store,
      registry: staleRegistry,
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:02.000Z",
    });

    const result = await restarted.cancelLeaf("leaf-501");

    assert.equal(result.status, "blocked");
    assert.equal(result.error.code, "LEAF_SERVICE_IDENTITY_ERROR");
    assert.equal(result.projection.state, "cancelling");
    assert.equal(cancelCount, 0);
    assert.equal(store.readTask("leaf-501").state, "cancelling");

    const recovered = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
    });
    const retry = await recovered.cancelLeaf("leaf-501");
    assert.equal(retry.state, "cancelling");
    assert.equal(cancelCount, 1);
  });
});

test("service cancellation leaves an exact sibling runtime and durable task untouched", async () => {
  await withStore(async (store) => {
    const bindings = new Map(
      ["leaf-501", "leaf-502"].map((taskId, index) => [
        taskId,
        Object.freeze({
          ...binding,
          sessionId: `00000000-0000-4000-8000-00000000050${index + 1}`,
          processIncarnation: `launch-50${index + 1}`,
        }),
      ]),
    );
    const runtimes = new Map(
      [...bindings].map(([taskId]) => [
        taskId,
        Object.freeze({ opaque: `runtime-${taskId}` }),
      ]),
    );
    const cancelledSessions = new Set();
    const adapter = {
      async start(spec) {
        return {
          nativeSessionBinding: bindings.get(spec.taskId),
          runtime: runtimes.get(spec.taskId),
        };
      },
      async observe({
        nativeSessionBinding,
        afterSequence,
      }) {
        if (afterSequence === 1) {
          return [
            {
              nativeSessionBinding,
              sequence: 2,
              observedAt: "2026-07-31T01:00:01.000Z",
              signal: { type: "turn.started" },
            },
          ];
        }
        if (
          afterSequence === 3 &&
          cancelledSessions.has(nativeSessionBinding.sessionId)
        ) {
          return [
            {
              nativeSessionBinding,
              sequence: 4,
              observedAt: "2026-07-31T01:00:03.000Z",
              signal: { type: "turn.settled" },
            },
          ];
        }
        return [];
      },
      async cancel({ nativeSessionBinding }) {
        cancelledSessions.add(nativeSessionBinding.sessionId);
      },
      async recover() {
        return null;
      },
    };
    const service = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: (() => {
        const values = [
          "2026-07-31T01:00:00.000Z",
          "2026-07-31T01:00:00.100Z",
          "2026-07-31T01:00:02.000Z",
        ];
        return () => values.shift();
      })(),
    });
    for (const taskId of bindings.keys()) {
      await service.delegateLeaf({
        taskId,
        adapterId: "pi-rpc",
        profile: "pi-glm",
        activity: "testing",
      });
      await service.inspectLeaf(taskId);
    }

    assert.equal((await service.cancelLeaf("leaf-501")).state, "cancelled");
    assert.equal((await service.inspectLeaf("leaf-502")).state, "running");
    assert.deepEqual(
      [...cancelledSessions],
      [bindings.get("leaf-501").sessionId],
    );
    assert.equal(store.readTask("leaf-502").latestEvent.sequence, 2);
  });
});

test("delegate rejects an invalid public spec before starting an adapter", async () => {
  await withStore(async (store) => {
    let starts = 0;
    const service = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: {
        "pi-rpc": {
          async start() {
            starts += 1;
            throw new Error("must not run");
          },
        },
      },
    });

    await assert.rejects(
      service.delegateLeaf({
        taskId: "leaf-501",
        adapterId: "pi-rpc",
        profile: "pi-glm",
        activity: "testing",
        credential: "must-not-cross",
      }),
      (error) => error?.code === "LEAF_SERVICE_UNEXPECTED",
    );
    assert.equal(starts, 0);
  });
});

test("recoverLeaf distinguishes adapter failure from a bounded not-found timeout", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const initialAdapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const initial = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": initialAdapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await initial.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await initial.inspectLeaf("leaf-501");

    const restarted = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: {
        "pi-rpc": {
          ...initialAdapter,
          async recover() {
            throw new Error("raw-provider-secret");
          },
        },
      },
    });
    const result = await restarted.recoverLeaf("leaf-501");

    assert.equal(result.status, "blocked");
    assert.equal(
      result.error.code,
      "LEAF_SERVICE_ADAPTER_UNAVAILABLE",
    );
    assert.equal(
      JSON.stringify(result).includes("raw-provider-secret"),
      false,
    );
    assert.equal(result.projection.state, "running");
    assert.equal(result.projection.canCancel, false);
  });
});

test("inspect preserves sanitized adapter identity and sequence categories", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    let observed = [
      {
        nativeSessionBinding: binding,
        sequence: 2,
        observedAt: "2026-07-31T01:00:01.000Z",
        signal: { type: "turn.started" },
      },
    ];
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe() {
        if (observed instanceof Error) {
          throw observed;
        }
        return observed;
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const service = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await service.inspectLeaf("leaf-501");

    observed = Object.assign(new Error("raw-identity-secret"), {
      category: "identity",
    });
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) =>
        error?.code === "LEAF_SERVICE_IDENTITY_ERROR" &&
        !error.message.includes("raw-identity-secret"),
    );

    observed = Object.assign(new Error("raw-sequence-secret"), {
      category: "sequence",
    });
    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) =>
        error?.code === "LEAF_SERVICE_SEQUENCE_ERROR" &&
        !error.message.includes("raw-sequence-secret"),
    );
  });
});

test("service sanitizes injected clock and wait failures", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const initial = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await initial.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await initial.inspectLeaf("leaf-501");

    const brokenClock = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock() {
        throw new Error("raw-clock-secret");
      },
    });
    await assert.rejects(
      brokenClock.recoverLeaf("leaf-501"),
      (error) =>
        error?.code === "LEAF_SERVICE_UNEXPECTED" &&
        !error.message.includes("raw-clock-secret"),
    );

    const brokenWait = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
      wait() {
        throw new Error("raw-wait-secret");
      },
      recoveryPolicy: {
        maxAttempts: 2,
        deadlineMs: 1_000,
        pollIntervalMs: 1,
      },
    });
    await assert.rejects(
      brokenWait.recoverLeaf("leaf-501"),
      (error) =>
        error?.code === "LEAF_SERVICE_UNEXPECTED" &&
        !error.message.includes("raw-wait-secret"),
    );
  });
});

test("service rejects a recovered binding with private extra fields", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {},
      async recover() {
        return {
          nativeSessionBinding: {
            ...binding,
            transcript: "/private/raw.jsonl",
          },
          runtime,
        };
      },
    };
    const initial = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await initial.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await initial.inspectLeaf("leaf-501");

    const restarted = createLeafSessionService({
      store,
      registry: createLeafRuntimeRegistry(),
      adapters: { "pi-rpc": adapter },
      recoveryPolicy: { maxAttempts: 1 },
    });
    const result = await restarted.recoverLeaf("leaf-501");

    assert.equal(result.status, "blocked");
    assert.equal(result.error.code, "LEAF_SERVICE_IDENTITY_ERROR");
    assert.equal(result.projection.canCancel, false);
    assert.equal(
      JSON.stringify(result).includes("/private/raw.jsonl"),
      false,
    );
  });
});

test("adapter unavailability retires the failed runtime for exact recovery", async () => {
  await withStore(async (store) => {
    const runtime = Object.freeze({ opaque: "runtime-501" });
    let failObservation = false;
    const adapter = {
      async start() {
        return { nativeSessionBinding: binding, runtime };
      },
      async observe({ afterSequence }) {
        if (failObservation) {
          throw new Error("raw-adapter-secret");
        }
        return afterSequence === 1
          ? [
              {
                nativeSessionBinding: binding,
                sequence: 2,
                observedAt: "2026-07-31T01:00:01.000Z",
                signal: { type: "turn.started" },
              },
            ]
          : [];
      },
      async cancel() {},
      async recover() {
        return null;
      },
    };
    const registry = createLeafRuntimeRegistry();
    const service = createLeafSessionService({
      store,
      registry,
      adapters: { "pi-rpc": adapter },
      clock: () => "2026-07-31T01:00:00.000Z",
    });
    await service.delegateLeaf({
      taskId: "leaf-501",
      adapterId: "pi-rpc",
      profile: "pi-glm",
      activity: "testing",
    });
    await service.inspectLeaf("leaf-501");
    failObservation = true;

    await assert.rejects(
      service.inspectLeaf("leaf-501"),
      (error) =>
        error?.code === "LEAF_SERVICE_ADAPTER_UNAVAILABLE" &&
        !error.message.includes("raw-adapter-secret"),
    );
    assert.throws(
      () =>
        registry.resolve({
          taskId: "leaf-501",
          nativeSessionBinding: binding,
        }),
      (error) => error?.code === "LEAF_RUNTIME_NOT_FOUND",
    );
  });
});

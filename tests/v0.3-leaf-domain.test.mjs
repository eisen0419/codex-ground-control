import assert from "node:assert/strict";
import test from "node:test";

import {
  applyProviderNativeSignal,
  classifyLeafDomainError,
  createLeafTaskRecord,
  requestExactCancellation,
  toPublicLeafProjection,
  validateLeafTaskRecord,
  validateNormalizedLeafEvent,
  validatePublicLeafProjection,
} from "../src/v0.3/leaf-domain.js";

const nativeSessionBinding = Object.freeze({
  adapterId: "pi-rpc",
  provider: "pi",
  modelProvider: "zai-coding-cn",
  model: "glm-5.2",
  sessionId: "00000000-0000-4000-8000-000000000301",
  processIncarnation: "launch-301",
});

function createStartingTask(overrides = {}) {
  return createLeafTaskRecord({
    taskId: "leaf-301",
    profile: "pi-glm",
    activity: "testing",
    nativeSessionBinding,
    ...overrides,
  });
}

function applySignal(task, sequence, signal, overrides = {}) {
  return applyProviderNativeSignal(task, {
    taskId: task.taskId,
    nativeSessionBinding:
      overrides.nativeSessionBinding ?? nativeSessionBinding,
    sequence,
    observedAt:
      overrides.observedAt ??
      `2026-07-31T00:00:${String(sequence).padStart(2, "0")}.000Z`,
    signal,
  });
}

function createRunningTask(overrides = {}) {
  const binding = overrides.nativeSessionBinding ?? nativeSessionBinding;
  const starting = createStartingTask(overrides);
  const sessionCreated = applyProviderNativeSignal(starting, {
    taskId: starting.taskId,
    nativeSessionBinding: binding,
    sequence: 1,
    observedAt: "2026-07-31T00:00:01.000Z",
    signal: { type: "session.created" },
  });
  return applyProviderNativeSignal(sessionCreated, {
    taskId: starting.taskId,
    nativeSessionBinding: binding,
    sequence: 2,
    observedAt: "2026-07-31T00:00:02.000Z",
    signal: { type: "turn.started" },
  });
}

test("dispatch receipt, native session creation, and turn start stay distinct", () => {
  const starting = createStartingTask();

  assert.deepEqual(toPublicLeafProjection(starting), {
    schemaVersion: "0.3",
    taskId: "leaf-301",
    adapterId: "pi-rpc",
    profile: "pi-glm",
    activity: "testing",
    provider: "pi",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    nativeSession: null,
    state: "starting",
    stage: "dispatch-received",
    latestEvent: null,
    canCancel: false,
    result: null,
  });

  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  assert.deepEqual(toPublicLeafProjection(sessionCreated).nativeSession, {
    id: "00000000-0000-4000-8000-000000000301",
    inspectable: true,
  });
  assert.equal(sessionCreated.state, "starting");
  assert.equal(sessionCreated.stage, "session-created");

  const running = applySignal(sessionCreated, 2, {
    type: "turn.started",
  });
  const runningProjection = toPublicLeafProjection(running);
  assert.deepEqual(
    {
      state: running.state,
      stage: running.stage,
      latestEvent: runningProjection.latestEvent,
      canCancel: runningProjection.canCancel,
    },
    {
      state: "running",
      stage: "provider-running",
      latestEvent: {
        sequence: 2,
        type: "turn.started",
        source: "provider-native",
        observedAt: "2026-07-31T00:00:02.000Z",
      },
      canCancel: true,
    },
  );
  assert.equal(running.latestEvent.taskId, "leaf-301");
  assert.deepEqual(
    running.latestEvent.nativeSessionBinding,
    nativeSessionBinding,
  );
});

test("Provider settle completes only after an accepted sanitized result", () => {
  const running = createRunningTask();
  const failed = applySignal(running, 3, { type: "turn.settled" });

  assert.equal(failed.state, "failed");
  assert.equal(failed.latestEvent.type, "turn.failed");
  assert.equal(failed.result, null);

  const accepted = applySignal(createRunningTask(), 3, {
    type: "result.accepted",
    result: { disposition: "candidate-evidence" },
  });
  const completed = applySignal(accepted, 4, { type: "turn.settled" });
  const projection = toPublicLeafProjection(completed);

  assert.deepEqual(
    {
      state: projection.state,
      stage: projection.stage,
      latestEvent: projection.latestEvent,
      canCancel: projection.canCancel,
      result: projection.result,
    },
    {
      state: "completed",
      stage: "provider-completed",
      latestEvent: {
        sequence: 4,
        type: "turn.completed",
        source: "provider-native",
        observedAt: "2026-07-31T00:00:04.000Z",
      },
      canCancel: false,
      result: { disposition: "candidate-evidence" },
    },
  );
});

test("a Provider settle may fail before session creation without inventing identity", () => {
  const failed = applySignal(createStartingTask(), 1, {
    type: "turn.settled",
  });
  const projection = toPublicLeafProjection(failed);

  assert.equal(projection.state, "failed");
  assert.equal(projection.nativeSession, null);
  assert.equal(projection.latestEvent.type, "turn.failed");
  assert.deepEqual(validateLeafTaskRecord(failed), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(validatePublicLeafProjection(projection), {
    valid: true,
    errors: [],
  });
});

test("exact cancellation validates the whole private identity and sequence", () => {
  const running = createRunningTask();
  const cancelling = requestExactCancellation(running, {
    taskId: "leaf-301",
    nativeSessionBinding,
    sequence: 3,
    observedAt: "2026-07-31T00:00:03.000Z",
  });
  const cancellingProjection = toPublicLeafProjection(cancelling);

  assert.deepEqual(
    {
      state: cancelling.state,
      stage: cancelling.stage,
      latestEvent: cancellingProjection.latestEvent,
    },
    {
      state: "cancelling",
      stage: "provider-abort-requested",
      latestEvent: {
        sequence: 3,
        type: "turn.cancel.requested",
        source: "provider-native",
        observedAt: "2026-07-31T00:00:03.000Z",
      },
    },
  );

  for (const mismatched of [
    { taskId: "leaf-other", nativeSessionBinding },
    {
      taskId: "leaf-301",
      nativeSessionBinding: {
        ...nativeSessionBinding,
        sessionId: "session-other",
      },
    },
    {
      taskId: "leaf-301",
      nativeSessionBinding: {
        ...nativeSessionBinding,
        processIncarnation: "stale-launch",
      },
    },
  ]) {
    assert.throws(
      () =>
        requestExactCancellation(running, {
          ...mismatched,
          sequence: 3,
          observedAt: "2026-07-31T00:00:03.000Z",
        }),
      (error) =>
        classifyLeafDomainError(error).code ===
        "LEAF_SESSION_IDENTITY_MISMATCH",
    );
  }

  assert.throws(
    () =>
      requestExactCancellation(running, {
        taskId: "leaf-301",
        nativeSessionBinding,
        sequence: 4,
        observedAt: "2026-07-31T00:00:04.000Z",
      }),
    (error) =>
      classifyLeafDomainError(error).code === "LEAF_EVENT_OUT_OF_ORDER",
  );
  assert.throws(
    () =>
      requestExactCancellation(running, {
        taskId: "leaf-301",
        nativeSessionBinding,
        sequence: 3,
        observedAt: "not-a-timestamp",
      }),
    (error) =>
      classifyLeafDomainError(error).code === "LEAF_EVENT_INVALID",
  );
  assert.equal(running.state, "running");
});

test("a matching settle cancels only the requested task", () => {
  const first = createRunningTask();
  const siblingBinding = Object.freeze({
    ...nativeSessionBinding,
    sessionId: "00000000-0000-4000-8000-000000000302",
    processIncarnation: "launch-302",
  });
  const sibling = createRunningTask({
    taskId: "leaf-302",
    nativeSessionBinding: siblingBinding,
  });
  const cancelling = requestExactCancellation(first, {
    taskId: "leaf-301",
    nativeSessionBinding,
    sequence: 3,
    observedAt: "2026-07-31T00:00:03.000Z",
  });
  const cancelled = applySignal(cancelling, 4, { type: "turn.settled" });

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.latestEvent.type, "turn.cancelled");
  assert.equal(toPublicLeafProjection(cancelled).canCancel, false);
  assert.equal(toPublicLeafProjection(sibling).state, "running");
  assert.equal(toPublicLeafProjection(sibling).canCancel, true);
});

test("Provider-native events require the exact task and private binding", () => {
  const running = createRunningTask();
  const mismatches = [
    { taskId: "leaf-other", nativeSessionBinding },
    {
      taskId: "leaf-301",
      nativeSessionBinding: {
        ...nativeSessionBinding,
        sessionId: "session-other",
      },
    },
    {
      taskId: "leaf-301",
      nativeSessionBinding: {
        ...nativeSessionBinding,
        processIncarnation: "stale-launch",
      },
    },
  ];

  for (const mismatch of mismatches) {
    assert.throws(
      () =>
        applyProviderNativeSignal(running, {
          ...mismatch,
          sequence: 3,
          observedAt: "2026-07-31T00:00:03.000Z",
          signal: {
            type: "result.accepted",
            result: { disposition: "candidate-evidence" },
          },
        }),
      (error) =>
        classifyLeafDomainError(error).code ===
        "LEAF_EVENT_IDENTITY_MISMATCH",
    );
  }

  assert.equal(running.state, "running");
  assert.equal(running.latestEvent.sequence, 2);
});

test("duplicate and late events are no-ops while sequence gaps fail closed", () => {
  const running = createRunningTask();

  assert.equal(
    applySignal(running, 2, { type: "turn.started" }),
    running,
  );
  assert.equal(
    applySignal(running, 1, { type: "session.created" }),
    running,
  );
  assert.throws(
    () =>
      applySignal(running, 4, {
        type: "result.accepted",
        result: { disposition: "candidate-evidence" },
      }),
    (error) =>
      classifyLeafDomainError(error).code === "LEAF_EVENT_OUT_OF_ORDER",
  );

  const accepted = applySignal(running, 3, {
    type: "result.accepted",
    result: { disposition: "candidate-evidence" },
  });
  const completed = applySignal(accepted, 4, { type: "turn.settled" });

  assert.equal(
    applySignal(completed, 2, { type: "turn.started" }),
    completed,
  );
  assert.equal(
    applySignal(completed, 5, { type: "turn.started" }),
    completed,
  );
  assert.equal(completed.state, "completed");
});

test("missing Provider signals never prove death or create a terminal state", () => {
  const starting = createStartingTask();
  const running = createRunningTask();

  assert.equal(applyProviderNativeSignal(starting, null), starting);
  assert.equal(
    applyProviderNativeSignal(running, {
      taskId: "leaf-301",
      nativeSessionBinding,
      signal: null,
    }),
    running,
  );
  assert.equal(toPublicLeafProjection(starting).state, "starting");
  assert.equal(toPublicLeafProjection(running).state, "running");
});

test("private records round-trip while public schemas reject sensitive data", () => {
  const running = createRunningTask();
  const projection = toPublicLeafProjection(running);
  const restored = JSON.parse(JSON.stringify(running));

  assert.deepEqual(validateLeafTaskRecord(running), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(validateLeafTaskRecord(restored), {
    valid: true,
    errors: [],
  });
  assert.deepEqual(toPublicLeafProjection(restored), projection);
  assert.deepEqual(validateNormalizedLeafEvent(running.latestEvent), {
    valid: true,
    errors: [],
  });
  assert.equal(
    validateNormalizedLeafEvent(projection.latestEvent).valid,
    false,
  );
  assert.deepEqual(validatePublicLeafProjection(projection), {
    valid: true,
    errors: [],
  });
  assert.equal(
    validatePublicLeafProjection({ ...projection, pid: 1234 }).valid,
    false,
  );

  assert.throws(
    () =>
      createStartingTask({
        nativeSessionBinding: {
          ...nativeSessionBinding,
          pid: 1234,
        },
      }),
    (error) =>
      classifyLeafDomainError(error).code === "LEAF_BINDING_INVALID",
  );
  assert.throws(
    () =>
      applyProviderNativeSignal(running, {
        taskId: "leaf-301",
        nativeSessionBinding,
        sequence: 3,
        observedAt: "2026-07-31T00:00:03.000Z",
        signal: {
          type: "result.accepted",
          result: { disposition: "candidate-evidence" },
          rawProviderError: "secret-error",
        },
      }),
    (error) =>
      classifyLeafDomainError(error).code === "LEAF_EVENT_INVALID",
  );
  for (const forbidden of [
    "nativeSessionBinding",
    "processIncarnation",
    "pid",
    "sessionPath",
    "environment",
    "credential",
    "rawPrompt",
    "transcript",
    "reasoning",
    "rawProviderError",
  ]) {
    assert.equal(Object.hasOwn(projection, forbidden), false);
    assert.equal(Object.hasOwn(projection.nativeSession, forbidden), false);
  }
});

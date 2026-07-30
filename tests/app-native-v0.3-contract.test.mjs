import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPiEvent,
  createLeafTask,
  requestExactCancellation,
  toAppCard,
} from "../spikes/pi-native-session/leaf-session-contract.mjs";

const nativeSessionRef = Object.freeze({
  adapterId: "pi-rpc",
  provider: "pi",
  modelProvider: "zai-coding-cn",
  model: "glm-5.2",
  sessionId: "00000000-0000-4000-8000-000000000301",
  processIncarnation: "launch-301",
});

test("a Pi native start event drives an inspectable running App card", () => {
  const starting = createLeafTask({
    taskId: "leaf-301",
    profile: "pi-glm",
    activity: "testing",
    nativeSessionRef,
  });
  const running = applyPiEvent(starting, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:01.000Z",
    event: { type: "agent_start" },
  });

  assert.deepEqual(toAppCard(running), {
    schemaVersion: "0.3",
    taskId: "leaf-301",
    adapterId: "pi-rpc",
    profile: "pi-glm",
    activity: "testing",
    provider: "pi",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    nativeSession: {
      id: "00000000-0000-4000-8000-000000000301",
      inspectable: true,
    },
    state: "running",
    stage: "provider-running",
    latestEvent: {
      sequence: 1,
      type: "turn.started",
      source: "provider-native",
      observedAt: "2026-07-28T00:00:01.000Z",
    },
    canCancel: true,
    result: null,
  });
});

test("a duplicate Pi native start cannot replay the running transition", () => {
  const running = applyPiEvent(
    createLeafTask({
      taskId: "leaf-301",
      profile: "pi-glm",
      activity: "testing",
      nativeSessionRef,
    }),
    {
      nativeSessionRef,
      observedAt: "2026-07-28T00:00:01.000Z",
      event: { type: "agent_start" },
    },
  );

  assert.throws(
    () =>
      applyPiEvent(running, {
        nativeSessionRef,
        observedAt: "2026-07-28T00:00:02.000Z",
        event: { type: "agent_start" },
      }),
    /Pi start event is not valid for the current leaf state/,
  );
  assert.equal(running.latestEvent.sequence, 1);
});

test("exact Pi cancellation settles only the bound session card", () => {
  const starting = createLeafTask({
    taskId: "leaf-301",
    profile: "pi-glm",
    activity: "testing",
    nativeSessionRef,
  });
  const running = applyPiEvent(starting, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:01.000Z",
    event: { type: "agent_start" },
  });
  const cancelling = requestExactCancellation(running, {
    taskId: "leaf-301",
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:02.000Z",
  });
  const cancelled = applyPiEvent(cancelling, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:03.000Z",
    event: { type: "agent_settled" },
  });

  assert.deepEqual(
    {
      state: cancelled.state,
      stage: cancelled.stage,
      latestEvent: cancelled.latestEvent,
      canCancel: cancelled.canCancel,
    },
    {
      state: "cancelled",
      stage: "provider-cancelled",
      latestEvent: {
        sequence: 3,
        type: "turn.cancelled",
        source: "provider-native",
        observedAt: "2026-07-28T00:00:03.000Z",
      },
      canCancel: false,
    },
  );
});

test("a stale process incarnation blocks cancellation without changing a sibling", () => {
  const first = applyPiEvent(
    createLeafTask({
      taskId: "leaf-301",
      profile: "pi-glm",
      activity: "testing",
      nativeSessionRef,
    }),
    {
      nativeSessionRef,
      observedAt: "2026-07-28T00:00:01.000Z",
      event: { type: "agent_start" },
    },
  );
  const siblingRef = {
    ...nativeSessionRef,
    sessionId: "00000000-0000-4000-8000-000000000302",
    processIncarnation: "launch-302",
  };
  const sibling = applyPiEvent(
    createLeafTask({
      taskId: "leaf-302",
      profile: "pi-glm",
      activity: "testing",
      nativeSessionRef: siblingRef,
    }),
    {
      nativeSessionRef: siblingRef,
      observedAt: "2026-07-28T00:00:01.000Z",
      event: { type: "agent_start" },
    },
  );

  assert.throws(
    () =>
      requestExactCancellation(first, {
        taskId: "leaf-301",
        nativeSessionRef: {
          ...nativeSessionRef,
          processIncarnation: "stale-launch",
        },
        observedAt: "2026-07-28T00:00:02.000Z",
      }),
    (error) =>
      error?.code === "LEAF_SESSION_IDENTITY_MISMATCH",
  );
  assert.equal(toAppCard(first).state, "running");
  assert.equal(toAppCard(sibling).state, "running");
  assert.equal(toAppCard(sibling).canCancel, true);
});

test("only a matching native settle completes the card without exposing raw output", () => {
  const starting = createLeafTask({
    taskId: "leaf-301",
    profile: "pi-glm",
    activity: "testing",
    nativeSessionRef,
  });
  const running = applyPiEvent(starting, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:01.000Z",
    event: { type: "agent_start" },
  });
  const resultObserved = applyPiEvent(running, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:02.000Z",
    event: {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [
          {
            type: "text",
            text: "raw Provider output must not enter the card",
          },
        ],
      },
    },
  });
  const completed = applyPiEvent(resultObserved, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:03.000Z",
    event: { type: "agent_settled" },
  });
  const card = toAppCard(completed);

  assert.deepEqual(
    {
      state: card.state,
      stage: card.stage,
      latestEvent: card.latestEvent,
      canCancel: card.canCancel,
      result: card.result,
    },
    {
      state: "completed",
      stage: "provider-completed",
      latestEvent: {
        sequence: 3,
        type: "turn.completed",
        source: "provider-native",
        observedAt: "2026-07-28T00:00:03.000Z",
      },
      canCancel: false,
      result: {
        disposition: "candidate-evidence",
      },
    },
  );
  assert.equal(JSON.stringify(card).includes("raw Provider"), false);
  assert.equal(
    Object.hasOwn(card.nativeSession, "processIncarnation"),
    false,
  );
});

test("a Pi native settle without an accepted result fails the running card", () => {
  const running = applyPiEvent(
    createLeafTask({
      taskId: "leaf-301",
      profile: "pi-glm",
      activity: "testing",
      nativeSessionRef,
    }),
    {
      nativeSessionRef,
      observedAt: "2026-07-28T00:00:01.000Z",
      event: { type: "agent_start" },
    },
  );
  const failed = applyPiEvent(running, {
    nativeSessionRef,
    observedAt: "2026-07-28T00:00:02.000Z",
    event: { type: "agent_settled" },
  });

  assert.deepEqual(
    {
      state: failed.state,
      stage: failed.stage,
      latestEvent: failed.latestEvent,
      canCancel: failed.canCancel,
      result: failed.result,
    },
    {
      state: "failed",
      stage: "provider-failed",
      latestEvent: {
        sequence: 2,
        type: "turn.failed",
        source: "provider-native",
        observedAt: "2026-07-28T00:00:02.000Z",
      },
      canCancel: false,
      result: null,
    },
  );
});

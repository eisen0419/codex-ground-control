// THROWAWAY PROTOTYPE
//
// Question: Can delegate_leaf, inspect_leaf, and cancel_leaf express the
// complete user-facing lifecycle while Provider events and exact runtime
// identity remain private implementation details?

import { randomUUID } from "node:crypto";

import {
  applyPiEvent,
  createLeafTask,
  requestExactCancellation,
  toAppCard,
} from "./leaf-session-contract.mjs";

function requiredTask(tasks, taskId) {
  const task = tasks.get(taskId);
  if (!task) {
    const error = new Error("Leaf task was not found.");
    error.code = "LEAF_TASK_NOT_FOUND";
    throw error;
  }
  return task;
}

export function createProductSurfacePrototype({
  idFactory = randomUUID,
  now = () => new Date().toISOString(),
} = {}) {
  const tasks = new Map();
  const liveBindings = new Map();

  function delegateLeaf({
    profile = "pi-glm",
    activity = "testing",
    permissionGranted = false,
  } = {}) {
    if (!permissionGranted) {
      const error = new Error(
        "Codex native plugin permission is required.",
      );
      error.code = "CODEX_PERMISSION_REQUIRED";
      throw error;
    }

    const taskId = idFactory();
    const nativeSessionRef = Object.freeze({
      adapterId: "pi-rpc",
      provider: "pi",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: idFactory(),
      processIncarnation: idFactory(),
    });
    const task = createLeafTask({
      taskId,
      profile,
      activity,
      nativeSessionRef,
    });
    tasks.set(taskId, task);
    liveBindings.set(taskId, nativeSessionRef);
    return toAppCard(task);
  }

  function inspectLeaf({ taskId }) {
    return toAppCard(requiredTask(tasks, taskId));
  }

  function cancelLeaf({ taskId }) {
    const task = requiredTask(tasks, taskId);
    const liveBinding = liveBindings.get(taskId);
    const cancelling = requestExactCancellation(task, {
      taskId,
      nativeSessionRef: liveBinding,
      observedAt: now(),
    });
    tasks.set(taskId, cancelling);
    return toAppCard(cancelling);
  }

  function acceptProviderEvent({ taskId, event }) {
    const task = requiredTask(tasks, taskId);
    const updated = applyPiEvent(task, {
      nativeSessionRef: liveBindings.get(taskId),
      observedAt: now(),
      event,
    });
    tasks.set(taskId, updated);
    return toAppCard(updated);
  }

  function simulateBindingDrift({ taskId }) {
    const binding = liveBindings.get(taskId);
    requiredTask(tasks, taskId);
    liveBindings.set(taskId, {
      ...binding,
      processIncarnation: idFactory(),
    });
  }

  function inspectAll() {
    return [...tasks.values()].map(toAppCard);
  }

  return Object.freeze({
    delegateLeaf,
    inspectLeaf,
    cancelLeaf,
    prototype: Object.freeze({
      acceptProviderEvent,
      simulateBindingDrift,
      inspectAll,
    }),
  });
}

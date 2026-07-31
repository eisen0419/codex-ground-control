function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function copyNativeSessionRef(value) {
  return {
    adapterId: requiredString(value?.adapterId, "adapterId"),
    provider: requiredString(value?.provider, "provider"),
    modelProvider: requiredString(
      value?.modelProvider,
      "modelProvider",
    ),
    model: requiredString(value?.model, "model"),
    sessionId: requiredString(value?.sessionId, "sessionId"),
    processIncarnation: requiredString(
      value?.processIncarnation,
      "processIncarnation",
    ),
  };
}

function sameNativeSession(left, right) {
  return (
    left.adapterId === right?.adapterId &&
    left.provider === right?.provider &&
    left.modelProvider === right?.modelProvider &&
    left.model === right?.model &&
    left.sessionId === right?.sessionId &&
    left.processIncarnation === right?.processIncarnation
  );
}

function identityMismatch(message) {
  const error = new Error(message);
  error.code = "LEAF_SESSION_IDENTITY_MISMATCH";
  return error;
}

export function createLeafTask(input) {
  return {
    schemaVersion: "0.3-prototype",
    taskId: requiredString(input?.taskId, "taskId"),
    profile: requiredString(input?.profile, "profile"),
    activity: requiredString(input?.activity, "activity"),
    nativeSessionRef: copyNativeSessionRef(
      input?.nativeSessionRef,
    ),
    state: "starting",
    stage: "session-created",
    latestEvent: null,
    canCancel: false,
    result: null,
  };
}

export function applyPiEvent(task, input) {
  if (
    !sameNativeSession(
      task.nativeSessionRef,
      input?.nativeSessionRef,
    )
  ) {
    throw identityMismatch(
      "Pi event does not match the bound native session.",
    );
  }
  const observedAt = requiredString(
    input?.observedAt,
    "observedAt",
  );
  if (input?.event?.type === "message_end") {
    if (
      task.state !== "running" ||
      input.event.message?.role !== "assistant" ||
      input.event.message?.stopReason !== "stop"
    ) {
      throw new Error(
        "Pi message end is not an accepted leaf result.",
      );
    }
    return {
      ...task,
      stage: "provider-result-observed",
      latestEvent: {
        sequence: (task.latestEvent?.sequence ?? 0) + 1,
        type: "turn.progress",
        source: "provider-native",
        observedAt,
      },
      result: {
        disposition: "candidate-evidence",
      },
    };
  }
  if (input?.event?.type === "agent_settled") {
    if (task.state === "cancelling") {
      return {
        ...task,
        state: "cancelled",
        stage: "provider-cancelled",
        latestEvent: {
          sequence: (task.latestEvent?.sequence ?? 0) + 1,
          type: "turn.cancelled",
          source: "provider-native",
          observedAt,
        },
        canCancel: false,
      };
    }
    if (
      task.state === "running" &&
      task.result?.disposition === "candidate-evidence"
    ) {
      return {
        ...task,
        state: "completed",
        stage: "provider-completed",
        latestEvent: {
          sequence: (task.latestEvent?.sequence ?? 0) + 1,
          type: "turn.completed",
          source: "provider-native",
          observedAt,
        },
        canCancel: false,
      };
    }
    if (
      task.state === "starting" ||
      task.state === "running"
    ) {
      return {
        ...task,
        state: "failed",
        stage: "provider-failed",
        latestEvent: {
          sequence: (task.latestEvent?.sequence ?? 0) + 1,
          type: "turn.failed",
          source: "provider-native",
          observedAt,
        },
        canCancel: false,
        result: null,
      };
    }
    throw new Error(
      "Pi settled before an accepted terminal transition.",
    );
  }
  if (input?.event?.type !== "agent_start") {
    throw new Error(
      `Unsupported Pi event: ${input?.event?.type ?? "missing"}.`,
    );
  }
  if (task.state !== "starting") {
    throw new Error(
      "Pi start event is not valid for the current leaf state.",
    );
  }
  return {
    ...task,
    state: "running",
    stage: "provider-running",
    latestEvent: {
      sequence: (task.latestEvent?.sequence ?? 0) + 1,
      type: "turn.started",
      source: "provider-native",
      observedAt,
    },
    canCancel: true,
  };
}

export function requestExactCancellation(task, input) {
  if (
    task.taskId !== input?.taskId ||
    !sameNativeSession(
      task.nativeSessionRef,
      input?.nativeSessionRef,
    )
  ) {
    throw identityMismatch(
      "Cancellation target does not match the bound native session.",
    );
  }
  if (task.state !== "running") {
    throw new Error(
      "Only a running leaf task can be cancelled.",
    );
  }
  return {
    ...task,
    state: "cancelling",
    stage: "provider-abort-requested",
    latestEvent: {
      sequence: (task.latestEvent?.sequence ?? 0) + 1,
      type: "turn.cancel.requested",
      source: "provider-native",
      observedAt: requiredString(
        input?.observedAt,
        "observedAt",
      ),
    },
    canCancel: false,
  };
}

export function toAppCard(task) {
  return {
    schemaVersion: "0.3",
    taskId: task.taskId,
    adapterId: task.nativeSessionRef.adapterId,
    profile: task.profile,
    activity: task.activity,
    provider: task.nativeSessionRef.provider,
    modelProvider: task.nativeSessionRef.modelProvider,
    model: task.nativeSessionRef.model,
    nativeSession: {
      id: task.nativeSessionRef.sessionId,
      inspectable: true,
    },
    state: task.state,
    stage: task.stage,
    latestEvent:
      task.latestEvent === null
        ? null
        : { ...task.latestEvent },
    canCancel: task.canCancel,
    result: task.result,
  };
}

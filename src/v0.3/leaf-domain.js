const BINDING_KEYS = Object.freeze([
  "adapterId",
  "provider",
  "modelProvider",
  "model",
  "sessionId",
  "processIncarnation",
]);
const LEAF_TASK_KEYS = Object.freeze([
  "schemaVersion",
  "taskId",
  "adapterId",
  "profile",
  "activity",
  "provider",
  "modelProvider",
  "model",
  "nativeSessionBinding",
  "sessionCreated",
  "state",
  "stage",
  "latestEvent",
  "result",
]);
const PUBLIC_PROJECTION_KEYS = Object.freeze([
  "schemaVersion",
  "taskId",
  "adapterId",
  "profile",
  "activity",
  "provider",
  "modelProvider",
  "model",
  "nativeSession",
  "state",
  "stage",
  "latestEvent",
  "canCancel",
  "result",
]);
const NORMALIZED_EVENT_KEYS = Object.freeze([
  "taskId",
  "nativeSessionBinding",
  "sequence",
  "type",
  "source",
  "observedAt",
]);
const PUBLIC_EVENT_KEYS = Object.freeze([
  "sequence",
  "type",
  "source",
  "observedAt",
]);
const PROVIDER_SIGNAL_KEYS = Object.freeze([
  "taskId",
  "nativeSessionBinding",
  "sequence",
  "observedAt",
  "signal",
]);
const CANCELLATION_KEYS = Object.freeze([
  "taskId",
  "nativeSessionBinding",
  "sequence",
  "observedAt",
]);
const PUBLIC_IDENTITY_KEYS = Object.freeze([
  "taskId",
  "adapterId",
  "profile",
  "activity",
  "provider",
  "modelProvider",
  "model",
]);
const DELEGATION_REQUIRED_KEYS = Object.freeze([
  "taskId",
  "adapterId",
  "profile",
  "activity",
]);
const DELEGATION_OPTIONAL_KEYS = Object.freeze([
  "cwd",
  "modelProvider",
  "model",
  "sessionId",
  "input",
]);
const DELEGATION_KEYS = new Set([
  ...DELEGATION_REQUIRED_KEYS,
  ...DELEGATION_OPTIONAL_KEYS,
]);

const PROVIDER_SIGNAL_TYPES = new Set([
  "session.created",
  "turn.started",
  "result.accepted",
  "turn.settled",
]);
const NORMALIZED_EVENT_TYPES = new Set([
  "session.created",
  "turn.started",
  "turn.progress",
  "turn.completed",
  "turn.cancel.requested",
  "turn.cancelled",
  "turn.failed",
]);
const TERMINAL_STATES = new Set(["completed", "failed", "cancelled"]);
const PUBLIC_STAGES = new Map([
  ["starting", new Set(["dispatch-received", "session-created"])],
  ["running", new Set(["provider-running", "provider-result-observed"])],
  ["completed", new Set(["provider-completed"])],
  ["failed", new Set(["provider-failed"])],
  ["cancelling", new Set(["provider-abort-requested"])],
  ["cancelled", new Set(["provider-cancelled"])],
]);

export const LEAF_DOMAIN_ERROR_CODES = Object.freeze({
  bindingInvalid: "LEAF_BINDING_INVALID",
  cancellationNotAllowed: "LEAF_CANCELLATION_NOT_ALLOWED",
  eventIdentityMismatch: "LEAF_EVENT_IDENTITY_MISMATCH",
  eventInvalid: "LEAF_EVENT_INVALID",
  eventOutOfOrder: "LEAF_EVENT_OUT_OF_ORDER",
  sessionIdentityMismatch: "LEAF_SESSION_IDENTITY_MISMATCH",
  stateTransitionInvalid: "LEAF_STATE_TRANSITION_INVALID",
  taskInvalid: "LEAF_TASK_INVALID",
  unexpected: "LEAF_DOMAIN_UNEXPECTED",
});

class LeafDomainError extends Error {
  constructor(code, message, category) {
    super(message);
    this.name = "LeafDomainError";
    this.code = code;
    this.category = category;
  }
}

function domainError(code, message, category) {
  return new LeafDomainError(code, message, category);
}

export function classifyLeafDomainError(error) {
  if (error instanceof LeafDomainError) {
    return Object.freeze({
      code: error.code,
      category: error.category,
      retryable: false,
    });
  }
  return Object.freeze({
    code: LEAF_DOMAIN_ERROR_CODES.unexpected,
    category: "unexpected",
    retryable: false,
  });
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function hasExactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function isTimestamp(value) {
  return isNonEmptyString(value) && !Number.isNaN(Date.parse(value));
}

function isSequence(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validation(valid, message) {
  return Object.freeze({
    valid,
    errors: Object.freeze(valid ? [] : [message]),
  });
}

export function validateLeafDelegationSpec(value) {
  const valid =
    isRecord(value) &&
    Object.keys(value).every((key) => DELEGATION_KEYS.has(key)) &&
    DELEGATION_REQUIRED_KEYS.every((key) =>
      isNonEmptyString(value[key]),
    ) &&
    DELEGATION_OPTIONAL_KEYS.every(
      (key) =>
        !Object.hasOwn(value, key) || isNonEmptyString(value[key]),
    );
  return validation(valid, "Leaf delegation spec is invalid.");
}

function isNativeSessionBinding(value) {
  return (
    hasExactKeys(value, BINDING_KEYS) &&
    BINDING_KEYS.every((key) => isNonEmptyString(value[key]))
  );
}

function isAcceptedResult(value) {
  return (
    hasExactKeys(value, ["disposition"]) &&
    value.disposition === "candidate-evidence"
  );
}

function isResult(value) {
  return value === null || isAcceptedResult(value);
}

function eventTypeIs(value, type) {
  return value?.latestEvent?.type === type;
}

function stateIsConsistent(value, hasNativeSession) {
  switch (value.stage) {
    case "dispatch-received":
      return (
        !hasNativeSession &&
        value.latestEvent === null &&
        value.result === null
      );
    case "session-created":
      return (
        hasNativeSession &&
        eventTypeIs(value, "session.created") &&
        value.result === null
      );
    case "provider-running":
      return (
        hasNativeSession &&
        eventTypeIs(value, "turn.started") &&
        value.result === null
      );
    case "provider-result-observed":
      return (
        hasNativeSession &&
        eventTypeIs(value, "turn.progress") &&
        isAcceptedResult(value.result)
      );
    case "provider-abort-requested":
      return hasNativeSession && eventTypeIs(value, "turn.cancel.requested");
    case "provider-completed":
      return (
        hasNativeSession &&
        eventTypeIs(value, "turn.completed") &&
        isAcceptedResult(value.result)
      );
    case "provider-failed":
      return eventTypeIs(value, "turn.failed") && value.result === null;
    case "provider-cancelled":
      return hasNativeSession && eventTypeIs(value, "turn.cancelled");
    default:
      return false;
  }
}

function isProviderSignal(value) {
  if (!isRecord(value) || !PROVIDER_SIGNAL_TYPES.has(value.type)) {
    return false;
  }
  if (value.type === "result.accepted") {
    return (
      hasExactKeys(value, ["type", "result"]) &&
      isAcceptedResult(value.result)
    );
  }
  return hasExactKeys(value, ["type"]);
}

export function validateNormalizedLeafEvent(value) {
  const valid =
    hasExactKeys(value, NORMALIZED_EVENT_KEYS) &&
    isNonEmptyString(value.taskId) &&
    isNativeSessionBinding(value.nativeSessionBinding) &&
    isSequence(value.sequence) &&
    NORMALIZED_EVENT_TYPES.has(value.type) &&
    value.source === "provider-native" &&
    isTimestamp(value.observedAt);
  return validation(valid, "NormalizedLeafEvent does not match schema 0.3.");
}

function isPublicLeafEvent(value) {
  return (
    hasExactKeys(value, PUBLIC_EVENT_KEYS) &&
    isSequence(value.sequence) &&
    NORMALIZED_EVENT_TYPES.has(value.type) &&
    value.source === "provider-native" &&
    isTimestamp(value.observedAt)
  );
}

export function validateLeafTaskRecord(value) {
  const binding = value?.nativeSessionBinding;
  const valid =
    hasExactKeys(value, LEAF_TASK_KEYS) &&
    value.schemaVersion === "0.3" &&
    PUBLIC_IDENTITY_KEYS.every((key) => isNonEmptyString(value[key])) &&
    typeof value.sessionCreated === "boolean" &&
    PUBLIC_STAGES.get(value.state)?.has(value.stage) === true &&
    (value.latestEvent === null ||
      (validateNormalizedLeafEvent(value.latestEvent).valid &&
        value.latestEvent.taskId === value.taskId &&
        sameNativeSessionBinding(
          value.latestEvent.nativeSessionBinding,
          binding,
        ))) &&
    isResult(value.result) &&
    isNativeSessionBinding(binding) &&
    value.adapterId === binding?.adapterId &&
    value.provider === binding?.provider &&
    value.modelProvider === binding?.modelProvider &&
    value.model === binding?.model &&
    stateIsConsistent(value, value.sessionCreated);
  return validation(valid, "LeafTaskRecord does not match schema 0.3.");
}

export function validatePublicLeafProjection(value) {
  const validNativeSession =
    value?.nativeSession === null ||
    (hasExactKeys(value?.nativeSession, ["id", "inspectable"]) &&
      isNonEmptyString(value.nativeSession.id) &&
      value.nativeSession.inspectable === true);
  const valid =
    hasExactKeys(value, PUBLIC_PROJECTION_KEYS) &&
    value.schemaVersion === "0.3" &&
    PUBLIC_IDENTITY_KEYS.every((key) => isNonEmptyString(value[key])) &&
    validNativeSession &&
    PUBLIC_STAGES.get(value.state)?.has(value.stage) === true &&
    (value.latestEvent === null || isPublicLeafEvent(value.latestEvent)) &&
    typeof value.canCancel === "boolean" &&
    (!value.canCancel || value.state === "running") &&
    isResult(value.result) &&
    stateIsConsistent(value, value.nativeSession !== null);
  return validation(valid, "PublicLeafProjection does not match schema 0.3.");
}

function copyNativeSessionBinding(value) {
  if (!isNativeSessionBinding(value)) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.bindingInvalid,
      "NativeSessionBinding does not match the private schema.",
      "validation",
    );
  }
  return Object.freeze(
    Object.fromEntries(BINDING_KEYS.map((key) => [key, value[key]])),
  );
}

function taskString(value, label) {
  if (!isNonEmptyString(value)) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.taskInvalid,
      `${label} must be a non-empty string.`,
      "validation",
    );
  }
  return value;
}

function freezeLeafTaskRecord(record) {
  return Object.freeze({
    ...record,
    nativeSessionBinding: copyNativeSessionBinding(
      record.nativeSessionBinding,
    ),
    latestEvent:
      record.latestEvent === null
        ? null
        : Object.freeze({
            ...record.latestEvent,
            nativeSessionBinding: copyNativeSessionBinding(
              record.latestEvent.nativeSessionBinding,
            ),
          }),
    result:
      record.result === null ? null : Object.freeze({ ...record.result }),
  });
}

function assertLeafTaskRecord(task) {
  if (!validateLeafTaskRecord(task).valid) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.taskInvalid,
      "LeafTaskRecord does not match the private domain contract.",
      "validation",
    );
  }
  return task;
}

function sameNativeSessionBinding(left, right) {
  return (
    isNativeSessionBinding(left) &&
    isNativeSessionBinding(right) &&
    BINDING_KEYS.every((key) => left[key] === right[key])
  );
}

function normalizedEvent(task, sequence, type, observedAt) {
  return Object.freeze({
    taskId: task.taskId,
    nativeSessionBinding: copyNativeSessionBinding(
      task.nativeSessionBinding,
    ),
    sequence,
    type,
    source: "provider-native",
    observedAt,
  });
}

function eventEnvelopeIsValid(input) {
  return (
    hasExactKeys(input, PROVIDER_SIGNAL_KEYS) &&
    isSequence(input.sequence) &&
    isTimestamp(input.observedAt) &&
    isProviderSignal(input.signal)
  );
}

function throwInvalidEvent() {
  throw domainError(
    LEAF_DOMAIN_ERROR_CODES.eventInvalid,
    "Provider-native signal does not satisfy the domain contract.",
    "validation",
  );
}

function assertNextSequence(task, sequence) {
  const latestSequence = task.latestEvent?.sequence ?? 0;
  if (sequence <= latestSequence) {
    return false;
  }
  if (sequence !== latestSequence + 1) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.eventOutOfOrder,
      "Provider-native event sequence contains a gap.",
      "sequence",
    );
  }
  return true;
}

export function createLeafTaskRecord(input) {
  if (
    !hasExactKeys(input, [
      "taskId",
      "profile",
      "activity",
      "nativeSessionBinding",
    ])
  ) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.taskInvalid,
      "Leaf task input does not match schema 0.3.",
      "validation",
    );
  }
  const binding = copyNativeSessionBinding(input.nativeSessionBinding);
  return freezeLeafTaskRecord({
    schemaVersion: "0.3",
    taskId: taskString(input.taskId, "taskId"),
    adapterId: binding.adapterId,
    profile: taskString(input.profile, "profile"),
    activity: taskString(input.activity, "activity"),
    provider: binding.provider,
    modelProvider: binding.modelProvider,
    model: binding.model,
    nativeSessionBinding: binding,
    sessionCreated: false,
    state: "starting",
    stage: "dispatch-received",
    latestEvent: null,
    result: null,
  });
}

export function applyProviderNativeSignal(task, input) {
  assertLeafTaskRecord(task);
  if (input === null || input === undefined) {
    return task;
  }
  if (
    task.taskId !== input?.taskId ||
    !sameNativeSessionBinding(
      task.nativeSessionBinding,
      input?.nativeSessionBinding,
    )
  ) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.eventIdentityMismatch,
      "Provider signal does not match the private leaf task binding.",
      "identity",
    );
  }
  if (input.signal === null) {
    if (
      !hasExactKeys(input, [
        "taskId",
        "nativeSessionBinding",
        "signal",
      ])
    ) {
      throwInvalidEvent();
    }
    return task;
  }
  if (!eventEnvelopeIsValid(input)) {
    throwInvalidEvent();
  }
  if (!assertNextSequence(task, input.sequence)) {
    return task;
  }
  if (TERMINAL_STATES.has(task.state)) {
    return task;
  }

  let next;
  if (
    input.signal.type === "session.created" &&
    task.state === "starting" &&
    !task.sessionCreated
  ) {
    next = {
      ...task,
      sessionCreated: true,
      stage: "session-created",
    };
  } else if (
    input.signal.type === "turn.started" &&
    task.state === "starting" &&
    task.sessionCreated
  ) {
    next = {
      ...task,
      state: "running",
      stage: "provider-running",
    };
  } else if (
    input.signal.type === "result.accepted" &&
    task.state === "running" &&
    task.result === null
  ) {
    next = {
      ...task,
      stage: "provider-result-observed",
      result: Object.freeze({
        disposition: "candidate-evidence",
      }),
    };
  } else if (
    input.signal.type === "turn.settled" &&
    task.state === "cancelling"
  ) {
    next = {
      ...task,
      state: "cancelled",
      stage: "provider-cancelled",
    };
  } else if (
    input.signal.type === "turn.settled" &&
    (task.state === "starting" || task.state === "running")
  ) {
    next = task.result
      ? {
          ...task,
          state: "completed",
          stage: "provider-completed",
        }
      : {
          ...task,
          state: "failed",
          stage: "provider-failed",
          result: null,
        };
  } else {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.stateTransitionInvalid,
      "Provider-native signal is invalid for the current leaf state.",
      "state",
    );
  }

  const normalizedType =
    {
      "result.accepted": "turn.progress",
      "turn.settled":
        next.state === "completed"
          ? "turn.completed"
          : next.state === "cancelled"
            ? "turn.cancelled"
            : "turn.failed",
    }[input.signal.type] ?? input.signal.type;

  return freezeLeafTaskRecord({
    ...next,
    latestEvent: normalizedEvent(
      task,
      input.sequence,
      normalizedType,
      input.observedAt,
    ),
  });
}

export function requestExactCancellation(task, input) {
  assertLeafTaskRecord(task);
  if (
    task.taskId !== input?.taskId ||
    !sameNativeSessionBinding(
      task.nativeSessionBinding,
      input?.nativeSessionBinding,
    )
  ) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.sessionIdentityMismatch,
      "Cancellation target does not match the private native-session binding.",
      "identity",
    );
  }
  if (
    !hasExactKeys(input, CANCELLATION_KEYS) ||
    !isSequence(input.sequence) ||
    !isTimestamp(input.observedAt)
  ) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.eventInvalid,
      "Cancellation request does not satisfy the domain contract.",
      "validation",
    );
  }
  if (!assertNextSequence(task, input.sequence)) {
    return task;
  }
  if (TERMINAL_STATES.has(task.state)) {
    return task;
  }
  if (task.state !== "running") {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.cancellationNotAllowed,
      "Only a running leaf task can enter cancellation.",
      "state",
    );
  }

  return freezeLeafTaskRecord({
    ...task,
    state: "cancelling",
    stage: "provider-abort-requested",
    latestEvent: normalizedEvent(
      task,
      input.sequence,
      "turn.cancel.requested",
      input.observedAt,
    ),
  });
}

export function toPublicLeafProjection(task, options = {}) {
  assertLeafTaskRecord(task);
  const canCancel =
    options.canCancel === undefined
      ? task.state === "running"
      : options.canCancel === true && task.state === "running";
  const projection = {
    schemaVersion: "0.3",
    taskId: task.taskId,
    adapterId: task.adapterId,
    profile: task.profile,
    activity: task.activity,
    provider: task.provider,
    modelProvider: task.modelProvider,
    model: task.model,
    nativeSession: task.sessionCreated
      ? Object.freeze({
          id: task.nativeSessionBinding.sessionId,
          inspectable: true,
        })
      : null,
    state: task.state,
    stage: task.stage,
    latestEvent:
      task.latestEvent === null
        ? null
        : Object.freeze({
            sequence: task.latestEvent.sequence,
            type: task.latestEvent.type,
            source: task.latestEvent.source,
            observedAt: task.latestEvent.observedAt,
          }),
    canCancel,
    result:
      task.result === null ? null : Object.freeze({ ...task.result }),
  };
  if (!validatePublicLeafProjection(projection).valid) {
    throw domainError(
      LEAF_DOMAIN_ERROR_CODES.taskInvalid,
      "Leaf task cannot produce a valid public projection.",
      "validation",
    );
  }
  return Object.freeze(projection);
}

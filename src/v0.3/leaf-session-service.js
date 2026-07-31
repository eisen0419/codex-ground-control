import {
  applyProviderNativeSignal,
  createLeafTaskRecord,
  requestExactCancellation,
  toPublicLeafProjection,
  validateLeafDelegationSpec,
} from "./leaf-domain.js";

export const LEAF_SESSION_SERVICE_ERROR_CODES = Object.freeze({
  adapterUnavailable: "LEAF_SERVICE_ADAPTER_UNAVAILABLE",
  identity: "LEAF_SERVICE_IDENTITY_ERROR",
  persistence: "LEAF_SERVICE_PERSISTENCE_ERROR",
  recoveryTimeout: "LEAF_SERVICE_RECOVERY_TIMEOUT",
  sequence: "LEAF_SERVICE_SEQUENCE_ERROR",
  unexpected: "LEAF_SERVICE_UNEXPECTED",
});

class LeafSessionServiceError extends Error {
  constructor(code, message, category) {
    super(message);
    this.name = "LeafSessionServiceError";
    this.code = code;
    this.category = category;
    this.retryable = false;
  }
}

function serviceError(code, message, category) {
  return new LeafSessionServiceError(code, message, category);
}

export function classifyLeafSessionServiceError(error) {
  if (error instanceof LeafSessionServiceError) {
    return Object.freeze({
      code: error.code,
      category: error.category,
      retryable: false,
    });
  }
  return Object.freeze({
    code: LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
    category: "unexpected",
    retryable: false,
  });
}

function findAdapter(adapters, adapterId) {
  return (
    adapters instanceof Map
      ? adapters.get(adapterId)
      : adapters?.[adapterId]
  );
}

function adapterFrom(adapters, adapterId) {
  const adapter = findAdapter(adapters, adapterId);
  if (!adapter || typeof adapter.start !== "function") {
    throw serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable,
      "The requested leaf adapter is unavailable.",
      "adapter-unavailable",
    );
  }
  return adapter;
}

function nowFrom(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
      "The leaf service clock failed.",
      "unexpected",
    );
  }
  const timestamp =
    value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
      "The leaf service clock returned an invalid timestamp.",
      "unexpected",
    );
  }
  return timestamp;
}

function validStartResult(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.hasOwn(value, "nativeSessionBinding") &&
    Object.hasOwn(value, "runtime") &&
    value.runtime !== null &&
    value.runtime !== undefined
  );
}

const BINDING_KEYS = Object.freeze([
  "adapterId",
  "provider",
  "modelProvider",
  "model",
  "sessionId",
  "processIncarnation",
]);

function sameBinding(left, right) {
  return (
    validBinding(left) &&
    validBinding(right) &&
    BINDING_KEYS.every((key) => left[key] === right[key])
  );
}

function validBinding(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === BINDING_KEYS.length &&
    BINDING_KEYS.every(
      (key) =>
        Object.hasOwn(value, key) &&
        typeof value[key] === "string" &&
        value[key].trim() !== "",
    )
  );
}

function observationEnvelope(task, value) {
  return {
    taskId: task.taskId,
    nativeSessionBinding: value?.nativeSessionBinding,
    sequence: value?.sequence,
    observedAt: value?.observedAt,
    signal: value?.signal,
  };
}

function duplicateNormalizedType(signal, durableType) {
  if (signal?.type === "session.created") {
    return "session.created";
  }
  if (signal?.type === "turn.started") {
    return "turn.started";
  }
  if (
    signal?.type === "result.accepted" &&
    signal.result?.disposition === "candidate-evidence"
  ) {
    return "turn.progress";
  }
  if (
    signal?.type === "turn.settled" &&
    ["turn.completed", "turn.cancelled", "turn.failed"].includes(
      durableType,
    )
  ) {
    return durableType;
  }
  return null;
}

function sourceError(error, fallbackCode, fallbackMessage) {
  if (error instanceof LeafSessionServiceError) {
    return error;
  }
  if (error?.category === "identity") {
    return serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.identity,
      "Leaf session identity failed closed.",
      "identity",
    );
  }
  if (error?.category === "sequence") {
    return serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.sequence,
      "Leaf session sequence failed closed.",
      "sequence",
    );
  }
  return serviceError(fallbackCode, fallbackMessage, "persistence");
}

function adapterOperationError(error, fallbackMessage) {
  if (error?.category === "identity") {
    return serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.identity,
      "Leaf adapter identity failed closed.",
      "identity",
    );
  }
  if (error?.category === "sequence") {
    return serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.sequence,
      "Leaf adapter sequence failed closed.",
      "sequence",
    );
  }
  return serviceError(
    LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable,
    fallbackMessage,
    "adapter-unavailable",
  );
}

export function createLeafSessionService({
  store,
  registry,
  adapters,
  clock = () => new Date().toISOString(),
  wait = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  recoveryPolicy = {},
} = {}) {
  if (
    !store ||
    typeof store.createTask !== "function" ||
    typeof store.commitTask !== "function" ||
    typeof store.readTask !== "function" ||
    !registry ||
    typeof registry.register !== "function" ||
    typeof registry.resolve !== "function" ||
    typeof registry.retire !== "function"
  ) {
    throw serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
      "Leaf session service dependencies are invalid.",
      "unexpected",
    );
  }
  const policy = Object.freeze({
    maxAttempts: recoveryPolicy.maxAttempts ?? 3,
    deadlineMs: recoveryPolicy.deadlineMs ?? 5_000,
    pollIntervalMs: recoveryPolicy.pollIntervalMs ?? 100,
  });
  if (
    !Number.isSafeInteger(policy.maxAttempts) ||
    policy.maxAttempts < 1 ||
    policy.maxAttempts > 20 ||
    !Number.isSafeInteger(policy.deadlineMs) ||
    policy.deadlineMs < 1 ||
    policy.deadlineMs > 60_000 ||
    !Number.isSafeInteger(policy.pollIntervalMs) ||
    policy.pollIntervalMs < 0 ||
    policy.pollIntervalMs > 5_000 ||
    typeof wait !== "function"
  ) {
    throw serviceError(
      LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
      "Leaf recovery policy exceeds its bounded contract.",
      "unexpected",
    );
  }

  const taskQueues = new Map();
  const cancelDispatched = new Set();

  function retireExactRuntime(task) {
    try {
      registry.retire({
        taskId: task.taskId,
        nativeSessionBinding: task.nativeSessionBinding,
      });
    } catch {
      // Missing or stale runtime identity is already fail-closed.
    }
  }

  function retireTerminalRuntime(task) {
    if (!["completed", "failed", "cancelled"].includes(task.state)) {
      return;
    }
    cancelDispatched.delete(task.taskId);
    retireExactRuntime(task);
  }

  async function withTaskLock(taskId, operation) {
    const previous = taskQueues.get(taskId) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    taskQueues.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (taskQueues.get(taskId) === current) {
        taskQueues.delete(taskId);
      }
    }
  }

  async function observeDurableTask(task, adapter, runtime) {
    let observed;
    try {
      observed = await adapter.observe({
        nativeSessionBinding: task.nativeSessionBinding,
        runtime,
        afterSequence: task.latestEvent?.sequence ?? 0,
      });
    } catch (error) {
      const normalized = adapterOperationError(
        error,
        "The leaf adapter could not provide structured events.",
      );
      if (
        normalized.code ===
        LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable
      ) {
        retireExactRuntime(task);
      }
      throw normalized;
    }
    if (!Array.isArray(observed)) {
      throw serviceError(
        LEAF_SESSION_SERVICE_ERROR_CODES.sequence,
        "The leaf adapter returned an invalid event sequence.",
        "sequence",
      );
    }
    let durable = task;
    for (const providerEvent of observed) {
      const latestSequence = durable.latestEvent?.sequence ?? 0;
      if (
        Number.isSafeInteger(providerEvent?.sequence) &&
        providerEvent.sequence > 0 &&
        providerEvent.sequence <= latestSequence
      ) {
        let committed;
        try {
          committed = store
            .readEvents(durable.taskId, {
              afterSequence: providerEvent.sequence - 1,
            })
            .find(
              (event) =>
                event.sequence === providerEvent.sequence,
            );
        } catch (error) {
          throw sourceError(
            error,
            LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
            "Durable leaf events could not be read.",
          );
        }
        if (
          !sameBinding(
            committed?.nativeSessionBinding,
            providerEvent.nativeSessionBinding,
          )
        ) {
          throw serviceError(
            LEAF_SESSION_SERVICE_ERROR_CODES.identity,
            "A repeated event did not match the durable runtime identity.",
            "identity",
          );
        }
        if (
          committed.observedAt !== providerEvent.observedAt ||
          duplicateNormalizedType(
            providerEvent.signal,
            committed.type,
          ) !== committed.type
        ) {
          throw serviceError(
            LEAF_SESSION_SERVICE_ERROR_CODES.sequence,
            "A repeated event conflicted with the durable sequence.",
            "sequence",
          );
        }
        continue;
      }
      let next;
      try {
        next = applyProviderNativeSignal(
          durable,
          observationEnvelope(durable, providerEvent),
        );
      } catch (error) {
        const identity = error?.category === "identity";
        throw serviceError(
          identity
            ? LEAF_SESSION_SERVICE_ERROR_CODES.identity
            : LEAF_SESSION_SERVICE_ERROR_CODES.sequence,
          identity
            ? "The observed event did not match the durable runtime identity."
            : "The observed event sequence failed closed.",
          identity ? "identity" : "sequence",
        );
      }
      if (next === durable) {
        continue;
      }
      try {
        durable = store.commitTask(next);
      } catch (error) {
        throw sourceError(
          error,
          LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
          "A normalized leaf event could not be persisted.",
        );
      }
    }
    return durable;
  }

  async function recoverExactRuntime(task, adapter) {
    if (!adapter || typeof adapter.recover !== "function") {
      return Object.freeze({
        runtime: null,
        failure: "adapter-unavailable",
      });
    }
    let recovered;
    try {
      recovered = await adapter.recover({
        nativeSessionBinding: task.nativeSessionBinding,
        afterSequence: task.latestEvent?.sequence ?? 0,
      });
    } catch {
      return Object.freeze({
        runtime: null,
        failure: "adapter-unavailable",
      });
    }
    if (recovered === null || recovered === undefined) {
      return Object.freeze({
        runtime: null,
        failure: "not-found",
      });
    }
    if (
      !validStartResult(recovered) ||
      !sameBinding(
        task.nativeSessionBinding,
        recovered.nativeSessionBinding,
      )
    ) {
      return Object.freeze({
        runtime: null,
        failure: "identity",
      });
    }
    try {
      registry.register({
        taskId: task.taskId,
        nativeSessionBinding: task.nativeSessionBinding,
        runtime: recovered.runtime,
      });
    } catch {
      return Object.freeze({
        runtime: null,
        failure: "identity",
      });
    }
    return Object.freeze({
      runtime: recovered.runtime,
      failure: null,
    });
  }

  return Object.freeze({
    async delegateLeaf(spec) {
      if (!validateLeafDelegationSpec(spec).valid) {
        throw serviceError(
          LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
          "Leaf delegation input does not satisfy the public contract.",
          "unexpected",
        );
      }
      return withTaskLock(spec?.taskId, async () => {
        const adapter = adapterFrom(adapters, spec?.adapterId);
        let started;
        let registered = false;
        try {
          started = await adapter.start(spec);
          if (!validStartResult(started)) {
            throw serviceError(
              LEAF_SESSION_SERVICE_ERROR_CODES.identity,
              "The leaf adapter returned an invalid runtime identity.",
              "identity",
            );
          }
          const initial = createLeafTaskRecord({
            taskId: spec?.taskId,
            profile: spec?.profile,
            activity: spec?.activity,
            nativeSessionBinding: started.nativeSessionBinding,
          });
          let durable;
          try {
            durable = store.createTask(initial);
            durable = store.commitTask(
              applyProviderNativeSignal(durable, {
                taskId: durable.taskId,
                nativeSessionBinding:
                  durable.nativeSessionBinding,
                sequence: 1,
                observedAt: nowFrom(clock),
                signal: { type: "session.created" },
              }),
            );
          } catch (error) {
            throw sourceError(
              error,
              LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
              "Leaf session state could not be persisted.",
            );
          }
          try {
            registry.register({
              taskId: durable.taskId,
              nativeSessionBinding:
                durable.nativeSessionBinding,
              runtime: started.runtime,
            });
            registered = true;
          } catch {
            throw serviceError(
              LEAF_SESSION_SERVICE_ERROR_CODES.identity,
              "The live runtime could not be bound to the durable task.",
              "identity",
            );
          }
          if (
            Object.hasOwn(spec, "input") &&
            typeof adapter.send === "function"
          ) {
            try {
              await adapter.send({
                nativeSessionBinding:
                  durable.nativeSessionBinding,
                runtime: started.runtime,
                input: spec.input,
              });
            } catch (error) {
              throw adapterOperationError(
                error,
                "The leaf adapter could not accept the bounded input.",
              );
            }
          }
          return toPublicLeafProjection(durable);
        } catch (error) {
          if (started && validStartResult(started)) {
            try {
              await adapter.cancel({
                nativeSessionBinding:
                  started.nativeSessionBinding,
                runtime: started.runtime,
              });
            } catch {
              // Cleanup is best-effort but remains scoped to the exact runtime.
            }
            if (registered) {
              try {
                registry.retire({
                  taskId: spec?.taskId,
                  nativeSessionBinding:
                    started.nativeSessionBinding,
                });
              } catch {
                // The original sanitized failure remains authoritative.
              }
            }
          }
          if (error instanceof LeafSessionServiceError) {
            throw error;
          }
          throw adapterOperationError(
            error,
            "The leaf adapter could not start the bounded session.",
          );
        }
      });
    },
    async inspectLeaf(taskId) {
      return withTaskLock(taskId, async () => {
        let durable;
        try {
          durable = store.readTask(taskId);
        } catch (error) {
          throw sourceError(
            error,
            LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
            "The durable leaf task could not be read.",
          );
        }
        if (["completed", "failed", "cancelled"].includes(durable.state)) {
          retireTerminalRuntime(durable);
          return toPublicLeafProjection(durable);
        }
        const adapter = findAdapter(adapters, durable.adapterId);
        if (!adapter) {
          return toPublicLeafProjection(durable, {
            canCancel: false,
          });
        }
        let runtime;
        try {
          runtime = registry.resolve({
            taskId,
            nativeSessionBinding:
              durable.nativeSessionBinding,
          });
        } catch {
          const recovered = await recoverExactRuntime(
            durable,
            adapter,
          );
          runtime = recovered.runtime;
          if (!runtime) {
            return toPublicLeafProjection(durable, {
              canCancel: false,
            });
          }
        }
        if (typeof adapter.observe !== "function") {
          throw serviceError(
            LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable,
            "The leaf adapter cannot observe structured events.",
            "adapter-unavailable",
          );
        }
        durable = await observeDurableTask(
          durable,
          adapter,
          runtime,
        );
        retireTerminalRuntime(durable);
        return toPublicLeafProjection(durable);
      });
    },
    async cancelLeaf(taskId) {
      return withTaskLock(taskId, async () => {
        let durable;
        try {
          durable = store.readTask(taskId);
        } catch (error) {
          throw sourceError(
            error,
            LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
            "The durable leaf task could not be read.",
          );
        }
        if (["completed", "failed", "cancelled"].includes(durable.state)) {
          retireTerminalRuntime(durable);
          return toPublicLeafProjection(durable);
        }
        const shouldSendCancel = !cancelDispatched.has(taskId);
        if (durable.state === "running") {
          let cancelling;
          try {
            cancelling = requestExactCancellation(durable, {
              taskId,
              nativeSessionBinding:
                durable.nativeSessionBinding,
              sequence:
                (durable.latestEvent?.sequence ?? 0) + 1,
              observedAt: nowFrom(clock),
            });
            durable = store.commitTask(cancelling);
          } catch (error) {
            throw sourceError(
              error,
              LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
              "The cancellation request could not be persisted.",
            );
          }
        } else if (durable.state !== "cancelling") {
          throw serviceError(
            LEAF_SESSION_SERVICE_ERROR_CODES.identity,
            "The durable leaf task is not exactly cancellable.",
            "identity",
          );
        }

        const adapter = findAdapter(adapters, durable.adapterId);
        if (!adapter || typeof adapter.cancel !== "function") {
          return Object.freeze({
            status: "blocked",
            projection: toPublicLeafProjection(durable, {
              canCancel: false,
            }),
            error: classifyLeafSessionServiceError(
              serviceError(
                LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable,
                "The exact leaf adapter is unavailable for cancellation.",
                "adapter-unavailable",
              ),
            ),
          });
        }
        let runtime;
        try {
          runtime = registry.resolve({
            taskId,
            nativeSessionBinding:
              durable.nativeSessionBinding,
          });
        } catch {
          const recovered = await recoverExactRuntime(
            durable,
            adapter,
          );
          runtime = recovered.runtime;
          if (!runtime) {
            const adapterUnavailable =
              recovered.failure === "adapter-unavailable";
            return Object.freeze({
              status: "blocked",
              projection: toPublicLeafProjection(durable, {
                canCancel: false,
              }),
              error: classifyLeafSessionServiceError(
                serviceError(
                  adapterUnavailable
                    ? LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable
                    : LEAF_SESSION_SERVICE_ERROR_CODES.identity,
                  adapterUnavailable
                    ? "The leaf adapter failed during exact recovery."
                    : "No exact live runtime is available for cancellation.",
                  adapterUnavailable
                    ? "adapter-unavailable"
                    : "identity",
                ),
              ),
            });
          }
        }

        if (shouldSendCancel) {
          try {
            await adapter.cancel({
              nativeSessionBinding:
                durable.nativeSessionBinding,
              runtime,
            });
            cancelDispatched.add(taskId);
          } catch (error) {
            throw adapterOperationError(
              error,
              "The exact leaf runtime could not be cancelled.",
            );
          }
        }
        if (typeof adapter.observe !== "function") {
          return toPublicLeafProjection(durable);
        }
        durable = await observeDurableTask(
          durable,
          adapter,
          runtime,
        );
        if (durable.state === "cancelled") {
          retireTerminalRuntime(durable);
        }
        return toPublicLeafProjection(durable);
      });
    },
    async recoverLeaf(taskId) {
      return withTaskLock(taskId, async () => {
        let durable;
        try {
          durable = store.readTask(taskId);
        } catch (error) {
          throw sourceError(
            error,
            LEAF_SESSION_SERVICE_ERROR_CODES.persistence,
            "The durable leaf task could not be read.",
          );
        }
        if (["completed", "failed", "cancelled"].includes(durable.state)) {
          retireTerminalRuntime(durable);
          return toPublicLeafProjection(durable);
        }
        const adapter = findAdapter(adapters, durable.adapterId);
        if (!adapter) {
          return Object.freeze({
            status: "blocked",
            projection: toPublicLeafProjection(durable, {
              canCancel: false,
            }),
            error: classifyLeafSessionServiceError(
              serviceError(
                LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable,
                "The leaf adapter is unavailable for recovery.",
                "adapter-unavailable",
              ),
            ),
          });
        }
        const startedAt = Date.parse(nowFrom(clock));
        let runtime = null;
        let hadExactRuntime = false;
        let recoveryFailure = null;
        for (
          let attempt = 1;
          attempt <= policy.maxAttempts;
          attempt += 1
        ) {
          if (Date.parse(nowFrom(clock)) - startedAt >= policy.deadlineMs) {
            break;
          }
          try {
            runtime = registry.resolve({
              taskId,
              nativeSessionBinding:
                durable.nativeSessionBinding,
            });
          } catch {
            const recovered = await recoverExactRuntime(
              durable,
              adapter,
            );
            runtime = recovered.runtime;
            recoveryFailure = recovered.failure;
            if (
              recoveryFailure === "adapter-unavailable" ||
              recoveryFailure === "identity"
            ) {
              break;
            }
          }
          if (runtime) {
            hadExactRuntime = true;
            if (typeof adapter.observe !== "function") {
              break;
            }
            durable = await observeDurableTask(
              durable,
              adapter,
              runtime,
            );
            if (
              ["completed", "failed", "cancelled"].includes(
                durable.state,
              )
            ) {
              retireTerminalRuntime(durable);
              return toPublicLeafProjection(durable);
            }
          }
          if (attempt < policy.maxAttempts) {
            const elapsed =
              Date.parse(nowFrom(clock)) - startedAt;
            if (elapsed >= policy.deadlineMs) {
              break;
            }
            try {
              await wait(
                Math.min(
                  policy.pollIntervalMs,
                  policy.deadlineMs - elapsed,
                ),
              );
            } catch {
              throw serviceError(
                LEAF_SESSION_SERVICE_ERROR_CODES.unexpected,
                "The leaf recovery wait failed.",
                "unexpected",
              );
            }
          }
        }
        if (
          !hadExactRuntime &&
          (recoveryFailure === "adapter-unavailable" ||
            recoveryFailure === "identity")
        ) {
          const unavailable =
            recoveryFailure === "adapter-unavailable";
          return Object.freeze({
            status: "blocked",
            projection: toPublicLeafProjection(durable, {
              canCancel: false,
            }),
            error: classifyLeafSessionServiceError(
              serviceError(
                unavailable
                  ? LEAF_SESSION_SERVICE_ERROR_CODES.adapterUnavailable
                  : LEAF_SESSION_SERVICE_ERROR_CODES.identity,
                unavailable
                  ? "The leaf adapter failed during bounded recovery."
                  : "Recovered runtime identity did not match the durable task.",
                unavailable
                  ? "adapter-unavailable"
                  : "identity",
              ),
            ),
          });
        }
        const timeout = serviceError(
          LEAF_SESSION_SERVICE_ERROR_CODES.recoveryTimeout,
          "Leaf recovery reached its bounded deadline.",
          "recovery-timeout",
        );
        return Object.freeze({
          status: hadExactRuntime ? "pending" : "blocked",
          projection: toPublicLeafProjection(durable, {
            canCancel: hadExactRuntime,
          }),
          error: classifyLeafSessionServiceError(timeout),
        });
      });
    },
  });
}

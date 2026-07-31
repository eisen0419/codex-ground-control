const BINDING_KEYS = Object.freeze([
  "adapterId",
  "provider",
  "modelProvider",
  "model",
  "sessionId",
  "processIncarnation",
]);

export const LEAF_RUNTIME_REGISTRY_ERROR_CODES = Object.freeze({
  conflict: "LEAF_RUNTIME_CONFLICT",
  identityMismatch: "LEAF_RUNTIME_IDENTITY_MISMATCH",
  invalid: "LEAF_RUNTIME_INVALID",
  notFound: "LEAF_RUNTIME_NOT_FOUND",
  unexpected: "LEAF_RUNTIME_UNEXPECTED",
});

class LeafRuntimeRegistryError extends Error {
  constructor(code, message, category) {
    super(message);
    this.name = "LeafRuntimeRegistryError";
    this.code = code;
    this.category = category;
    this.retryable = false;
  }
}

function registryError(code, message, category) {
  return new LeafRuntimeRegistryError(code, message, category);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function validBinding(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === BINDING_KEYS.length &&
    BINDING_KEYS.every(
      (key) =>
        Object.hasOwn(value, key) && isNonEmptyString(value[key]),
    )
  );
}

function sameBinding(left, right) {
  return (
    validBinding(left) &&
    validBinding(right) &&
    BINDING_KEYS.every((key) => left[key] === right[key])
  );
}

function validateEntry(entry) {
  if (
    entry === null ||
    Array.isArray(entry) ||
    typeof entry !== "object" ||
    !isNonEmptyString(entry.taskId) ||
    !validBinding(entry.nativeSessionBinding) ||
    !Object.hasOwn(entry, "runtime") ||
    entry.runtime === null ||
    entry.runtime === undefined
  ) {
    throw registryError(
      LEAF_RUNTIME_REGISTRY_ERROR_CODES.invalid,
      "Runtime registry entry does not satisfy the private contract.",
      "validation",
    );
  }
}

function validateLookup(lookup) {
  if (
    lookup === null ||
    Array.isArray(lookup) ||
    typeof lookup !== "object" ||
    !isNonEmptyString(lookup.taskId) ||
    !validBinding(lookup.nativeSessionBinding)
  ) {
    throw registryError(
      LEAF_RUNTIME_REGISTRY_ERROR_CODES.invalid,
      "Runtime registry lookup does not satisfy the private contract.",
      "validation",
    );
  }
}

export function createLeafRuntimeRegistry() {
  const entries = new Map();

  function exactEntry(lookup) {
    validateLookup(lookup);
    const entry = entries.get(lookup.taskId);
    if (!entry) {
      throw registryError(
        LEAF_RUNTIME_REGISTRY_ERROR_CODES.notFound,
        "No live runtime is registered for the leaf task.",
        "identity",
      );
    }
    if (
      !sameBinding(
        entry.nativeSessionBinding,
        lookup.nativeSessionBinding,
      )
    ) {
      throw registryError(
        LEAF_RUNTIME_REGISTRY_ERROR_CODES.identityMismatch,
        "Live runtime identity does not match the durable task binding.",
        "identity",
      );
    }
    return entry;
  }

  return Object.freeze({
    register(entry) {
      validateEntry(entry);
      if (entries.has(entry.taskId)) {
        throw registryError(
          LEAF_RUNTIME_REGISTRY_ERROR_CODES.conflict,
          "A live runtime is already registered for the leaf task.",
          "identity",
        );
      }
      if (
        [...entries.values()].some((existing) =>
          sameBinding(
            existing.nativeSessionBinding,
            entry.nativeSessionBinding,
          ),
        )
      ) {
        throw registryError(
          LEAF_RUNTIME_REGISTRY_ERROR_CODES.identityMismatch,
          "A native-session binding is already owned by another leaf task.",
          "identity",
        );
      }
      entries.set(entry.taskId, {
        nativeSessionBinding: Object.freeze({
          ...entry.nativeSessionBinding,
        }),
        runtime: entry.runtime,
      });
      return entry.runtime;
    },
    resolve(lookup) {
      return exactEntry(lookup).runtime;
    },
    retire(lookup) {
      const entry = exactEntry(lookup);
      entries.delete(lookup.taskId);
      return entry.runtime;
    },
  });
}

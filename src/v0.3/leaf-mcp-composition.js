import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import { z } from "zod";

import { createLeafRuntimeRegistry } from "./leaf-runtime-registry.js";
import { createLeafSessionService } from "./leaf-session-service.js";
import { createLeafStateStore } from "./leaf-state-store.js";
import {
  createNodePiRpcProcessBoundary,
  createPiRpcAdapter,
} from "./pi-rpc-adapter.js";

const TASK_ID_PATTERN = "^[A-Za-z0-9][A-Za-z0-9._:-]*$";
const TASK_ID_REGEXP = new RegExp(TASK_ID_PATTERN);
const MAX_TASK_ID_LENGTH = 256;
const MAX_IDENTITY_LENGTH = 128;
const MAX_ACTIVITY_LENGTH = 256;
const MAX_INPUT_LENGTH = 8_192;
const MAX_CHECKOUT_LENGTH = 4_096;
const RESERVED_PROFILE_ENVIRONMENT = new Set([
  "PI_CODING_AGENT_SESSION_DIR",
  "PI_TELEMETRY",
  "PI_OFFLINE",
]);

const TASK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["taskId"]),
  properties: Object.freeze({
    taskId: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_TASK_ID_LENGTH,
      pattern: TASK_ID_PATTERN,
    }),
  }),
});

const DELEGATE_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze([
    "taskId",
    "adapterId",
    "profile",
    "activity",
  ]),
  properties: Object.freeze({
    taskId: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_TASK_ID_LENGTH,
      pattern: TASK_ID_PATTERN,
    }),
    adapterId: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_IDENTITY_LENGTH,
    }),
    profile: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_IDENTITY_LENGTH,
    }),
    activity: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_ACTIVITY_LENGTH,
    }),
    input: Object.freeze({
      type: "string",
      minLength: 1,
      maxLength: MAX_INPUT_LENGTH,
    }),
  }),
});

const TASK_HOST_INPUT_SCHEMA = z.strictObject({
  taskId: z
    .string()
    .min(1)
    .max(MAX_TASK_ID_LENGTH)
    .regex(TASK_ID_REGEXP),
});
const DELEGATE_HOST_INPUT_SCHEMA = z.strictObject({
  taskId: z
    .string()
    .min(1)
    .max(MAX_TASK_ID_LENGTH)
    .regex(TASK_ID_REGEXP),
  adapterId: z.string().min(1).max(MAX_IDENTITY_LENGTH),
  profile: z.string().min(1).max(MAX_IDENTITY_LENGTH),
  activity: z.string().min(1).max(MAX_ACTIVITY_LENGTH),
  input: z.string().min(1).max(MAX_INPUT_LENGTH).optional(),
});
const HOST_INPUT_SCHEMAS = Object.freeze({
  delegate_leaf: DELEGATE_HOST_INPUT_SCHEMA,
  inspect_leaf: TASK_HOST_INPUT_SCHEMA,
  cancel_leaf: TASK_HOST_INPUT_SCHEMA,
});

const DEFINITIONS = Object.freeze([
  Object.freeze({
    name: "delegate_leaf",
    title: "Delegate external leaf session",
    description:
      "Handle one Host-dispatched leaf delegation after Codex native permission routing. This operation creates no second authorization lease.",
    inputSchema: DELEGATE_INPUT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: false,
    }),
  }),
  Object.freeze({
    name: "inspect_leaf",
    title: "Inspect external leaf session",
    description:
      "Return the durable sanitized projection for one Ground Control leaf task.",
    inputSchema: TASK_INPUT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
      idempotentHint: true,
    }),
  }),
  Object.freeze({
    name: "cancel_leaf",
    title: "Cancel exact external leaf session",
    description:
      "Request cancellation only for the exact native session bound to one durable leaf task.",
    inputSchema: TASK_INPUT_SCHEMA,
    annotations: Object.freeze({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
      idempotentHint: true,
    }),
  }),
]);

export function createLeafMcpComposition({ service } = {}) {
  if (
    !service ||
    typeof service.delegateLeaf !== "function" ||
    typeof service.inspectLeaf !== "function" ||
    typeof service.cancelLeaf !== "function"
  ) {
    throw new TypeError(
      "Leaf MCP composition requires the public session service.",
    );
  }
  return Object.freeze({
    definitions: DEFINITIONS,
    handlers: Object.freeze({
      async delegate_leaf(input, hostDispatchContext) {
        await service.delegateLeaf(input, hostDispatchContext);
        return service.inspectLeaf(input.taskId);
      },
      async inspect_leaf({ taskId }) {
        return service.inspectLeaf(taskId);
      },
      async cancel_leaf({ taskId }) {
        await service.cancelLeaf(taskId);
        return service.inspectLeaf(taskId);
      },
    }),
  });
}

const START_KEYS = new Set([
  "taskId",
  "adapterId",
  "profile",
  "activity",
  "input",
]);
const HOST_DISPATCH_KEYS = Object.freeze(["selectedCheckout"]);

export const LEAF_PRODUCTION_ERROR_CODES = Object.freeze({
  closed: "LEAF_PRODUCTION_CLOSED",
  hostDispatchRequired: "LEAF_PRODUCTION_HOST_DISPATCH_REQUIRED",
  invalid: "LEAF_PRODUCTION_INVALID",
  profileUnavailable: "LEAF_PRODUCTION_PROFILE_UNAVAILABLE",
  unexpected: "LEAF_PRODUCTION_UNEXPECTED",
});

class LeafProductionError extends Error {
  constructor(code, message, category) {
    super(message);
    this.name = "LeafProductionError";
    this.code = code;
    this.category = category;
    this.retryable = false;
  }
}

function productionError(code, message, category) {
  return new LeafProductionError(code, message, category);
}

function isRecord(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function boundedString(value, maximum) {
  return nonEmptyString(value) && value.length <= maximum;
}

function exactKeys(value, keys) {
  return (
    isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validateStartInput(input) {
  return (
    isRecord(input) &&
    Object.keys(input).every((key) => START_KEYS.has(key)) &&
    boundedString(input.taskId, MAX_TASK_ID_LENGTH) &&
    TASK_ID_REGEXP.test(input.taskId) &&
    boundedString(input.adapterId, MAX_IDENTITY_LENGTH) &&
    boundedString(input.profile, MAX_IDENTITY_LENGTH) &&
    boundedString(input.activity, MAX_ACTIVITY_LENGTH) &&
    (!Object.hasOwn(input, "input") ||
      boundedString(input.input, MAX_INPUT_LENGTH))
  );
}

function validateHostDispatch(context) {
  return (
    exactKeys(context, HOST_DISPATCH_KEYS) &&
    boundedString(context.selectedCheckout, MAX_CHECKOUT_LENGTH) &&
    isAbsolute(context.selectedCheckout)
  );
}

function normalizeProfiles(profiles) {
  if (!isRecord(profiles) || Object.keys(profiles).length === 0) {
    throw productionError(
      LEAF_PRODUCTION_ERROR_CODES.invalid,
      "Leaf production profiles are invalid.",
      "validation",
    );
  }
  const normalized = new Map();
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (
      !boundedString(profileId, MAX_IDENTITY_LENGTH) ||
      !exactKeys(profile, [
        "adapterId",
        "modelProvider",
        "model",
        "environment",
        "environmentAllowlist",
      ]) ||
      profile.adapterId !== "pi-rpc" ||
      !boundedString(profile.modelProvider, MAX_IDENTITY_LENGTH) ||
      !boundedString(profile.model, MAX_ACTIVITY_LENGTH) ||
      !isRecord(profile.environment) ||
      !Array.isArray(profile.environmentAllowlist) ||
      profile.environmentAllowlist.length > 64 ||
      new Set(profile.environmentAllowlist).size !==
        profile.environmentAllowlist.length ||
      !profile.environmentAllowlist.every(
        (name) =>
          typeof name === "string" &&
          /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
          !RESERVED_PROFILE_ENVIRONMENT.has(name),
      )
    ) {
      throw productionError(
        LEAF_PRODUCTION_ERROR_CODES.invalid,
        "Leaf production profile does not satisfy the explicit contract.",
        "validation",
      );
    }
    const environment = {};
    for (const name of profile.environmentAllowlist) {
      const descriptor = Object.getOwnPropertyDescriptor(
        profile.environment,
        name,
      );
      if (
        descriptor &&
        Object.hasOwn(descriptor, "value") &&
        typeof descriptor.value === "string" &&
        descriptor.value !== ""
      ) {
        environment[name] = descriptor.value;
      }
    }
    normalized.set(
      profileId,
      Object.freeze({
        adapterId: profile.adapterId,
        modelProvider: profile.modelProvider,
        model: profile.model,
        environment: Object.freeze(environment),
        environmentAllowlist: Object.freeze([
          ...profile.environmentAllowlist,
        ]),
      }),
    );
  }
  return normalized;
}

function generatedString(factory, label) {
  let value;
  try {
    value = factory();
  } catch {
    throw productionError(
      LEAF_PRODUCTION_ERROR_CODES.unexpected,
      "Leaf production " + label + " generation failed.",
      "unexpected",
    );
  }
  if (!nonEmptyString(value)) {
    throw productionError(
      LEAF_PRODUCTION_ERROR_CODES.unexpected,
      "Leaf production " + label + " is invalid.",
      "unexpected",
    );
  }
  return value;
}

export function createLeafProductionComposition({
  rootDirectory,
  processBoundary = createNodePiRpcProcessBoundary(),
  command = "pi",
  commandArgs = [],
  profiles,
  sessionIdFactory = randomUUID,
  sessionDirectoryFromSessionId,
  processIncarnationFactory = randomUUID,
  hostDispatchFromCall,
  clock = () => new Date().toISOString(),
  wait,
  recoveryPolicy,
  requestTimeoutMs,
  maxLineBytes,
  maxBufferedEvents,
} = {}) {
  const profileMap = normalizeProfiles(profiles);
  if (
    !processBoundary ||
    typeof processBoundary.close !== "function" ||
    typeof sessionDirectoryFromSessionId !== "function" ||
    typeof hostDispatchFromCall !== "function"
  ) {
    throw productionError(
      LEAF_PRODUCTION_ERROR_CODES.invalid,
      "Leaf production process boundary cannot guarantee cleanup.",
      "validation",
    );
  }
  const environmentNames = [
    ...new Set(
      [...profileMap.values()].flatMap(
        (profile) => profile.environmentAllowlist,
      ),
    ),
  ];
  const store = createLeafStateStore({ rootDirectory });
  const registry = createLeafRuntimeRegistry();
  const adapter = createPiRpcAdapter({
    processBoundary,
    idFactory: processIncarnationFactory,
    clock,
    command,
    commandArgs,
    sessionDirectory(spec) {
      return sessionDirectoryFromSessionId(spec.sessionId);
    },
    environment(spec) {
      return profileMap.get(spec.profile)?.environment ?? {};
    },
    environmentAllowlist: environmentNames,
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(maxLineBytes === undefined ? {} : { maxLineBytes }),
    ...(maxBufferedEvents === undefined ? {} : { maxBufferedEvents }),
  });
  const service = createLeafSessionService({
    store,
    registry,
    adapters: { "pi-rpc": adapter },
    clock,
    ...(wait === undefined ? {} : { wait }),
    ...(recoveryPolicy === undefined ? {} : { recoveryPolicy }),
  });
  let closed = false;
  let closing = null;

  function assertOpen() {
    if (closed || closing) {
      throw productionError(
        LEAF_PRODUCTION_ERROR_CODES.closed,
        "Leaf production composition is closed.",
        "lifecycle",
      );
    }
  }

  const publicService = Object.freeze({
    async delegateLeaf(input, hostCallContext) {
      assertOpen();
      let hostDispatchContext;
      try {
        hostDispatchContext = await hostDispatchFromCall(hostCallContext);
      } catch {
        throw productionError(
          LEAF_PRODUCTION_ERROR_CODES.hostDispatchRequired,
          "A fresh Codex Host dispatch context is required.",
          "host-dispatch",
        );
      }
      if (!validateHostDispatch(hostDispatchContext)) {
        throw productionError(
          LEAF_PRODUCTION_ERROR_CODES.hostDispatchRequired,
          "A fresh Codex Host dispatch context is required.",
          "host-dispatch",
        );
      }
      if (!validateStartInput(input)) {
        throw productionError(
          LEAF_PRODUCTION_ERROR_CODES.invalid,
          "Leaf production delegation input is invalid.",
          "validation",
        );
      }
      const profile = profileMap.get(input.profile);
      if (!profile || input.adapterId !== profile.adapterId) {
        throw productionError(
          LEAF_PRODUCTION_ERROR_CODES.profileUnavailable,
          "The requested leaf profile is unavailable.",
          "adapter-unavailable",
        );
      }
      return service.delegateLeaf({
        taskId: input.taskId,
        adapterId: profile.adapterId,
        profile: input.profile,
        activity: input.activity,
        cwd: hostDispatchContext.selectedCheckout,
        modelProvider: profile.modelProvider,
        model: profile.model,
        sessionId: generatedString(sessionIdFactory, "session identity"),
        ...(Object.hasOwn(input, "input") ? { input: input.input } : {}),
      });
    },
    async inspectLeaf(taskId) {
      assertOpen();
      return service.inspectLeaf(taskId);
    },
    async cancelLeaf(taskId) {
      assertOpen();
      return service.cancelLeaf(taskId);
    },
  });
  const mcp = createLeafMcpComposition({ service: publicService });

  return Object.freeze({
    definitions: mcp.definitions,
    handlers: mcp.handlers,
    start(input, hostDispatchContext) {
      return mcp.handlers.delegate_leaf(input, hostDispatchContext);
    },
    inspect(taskId) {
      return mcp.handlers.inspect_leaf({ taskId });
    },
    cancel(taskId) {
      return mcp.handlers.cancel_leaf({ taskId });
    },
    recover(taskId) {
      assertOpen();
      return service.recoverLeaf(taskId);
    },
    close() {
      if (closed) {
        return Promise.resolve();
      }
      if (!closing) {
        closing = Promise.resolve(processBoundary.close()).finally(() => {
          closed = true;
          closing = null;
        });
      }
      return closing;
    },
  });
}

function sanitizedToolError(error, fallbackCode) {
  const code =
    typeof error?.code === "string" &&
    /^(LEAF_|PI_RPC_)[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : fallbackCode;
  return Object.freeze({
    isError: true,
    content: Object.freeze([
      Object.freeze({
        type: "text",
        text: code,
      }),
    ]),
  });
}

function toolResult(projection) {
  return Object.freeze({
    content: Object.freeze([
      Object.freeze({
        type: "text",
        text:
          "Leaf task " + projection.taskId + " is " + projection.state + ".",
      }),
    ]),
    structuredContent: projection,
  });
}

export function registerLeafMcpTools({
  server,
  composition,
} = {}) {
  if (
    !server ||
    typeof server.registerTool !== "function" ||
    !composition ||
    !Array.isArray(composition.definitions) ||
    !composition.handlers
  ) {
    throw new TypeError(
      "Leaf Host registration dependencies are invalid.",
    );
  }
  const names = composition.definitions.map(({ name }) => name);
  if (
    names.length !== 3 ||
    names[0] !== "delegate_leaf" ||
    names[1] !== "inspect_leaf" ||
    names[2] !== "cancel_leaf"
  ) {
    throw new TypeError(
      "Leaf Host registration requires the three-operation contract.",
    );
  }

  for (const definition of composition.definitions) {
    server.registerTool(
      definition.name,
      Object.freeze({
        title: definition.title,
        description: definition.description,
        inputSchema: HOST_INPUT_SCHEMAS[definition.name],
        annotations: definition.annotations,
      }),
      async (input, callContext) => {
        try {
          const projection =
            definition.name === "delegate_leaf"
              ? await composition.handlers.delegate_leaf(
                  input,
                  callContext,
                )
              : await composition.handlers[definition.name](input);
          return toolResult(projection);
        } catch (error) {
          return sanitizedToolError(
            error,
            definition.name === "delegate_leaf"
              ? "LEAF_HOST_DISPATCH_REQUIRED"
              : "LEAF_HOST_OPERATION_FAILED",
          );
        }
      },
    );
  }

  return Object.freeze({
    toolNames: Object.freeze([...names]),
  });
}

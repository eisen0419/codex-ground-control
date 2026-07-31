const TASK_INPUT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: Object.freeze(["taskId"]),
  properties: Object.freeze({
    taskId: Object.freeze({
      type: "string",
      minLength: 1,
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
    taskId: Object.freeze({ type: "string", minLength: 1 }),
    adapterId: Object.freeze({ type: "string", minLength: 1 }),
    profile: Object.freeze({ type: "string", minLength: 1 }),
    activity: Object.freeze({ type: "string", minLength: 1 }),
    cwd: Object.freeze({ type: "string", minLength: 1 }),
    modelProvider: Object.freeze({
      type: "string",
      minLength: 1,
    }),
    model: Object.freeze({ type: "string", minLength: 1 }),
    sessionId: Object.freeze({ type: "string", minLength: 1 }),
    input: Object.freeze({ type: "string", minLength: 1 }),
  }),
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
      async delegate_leaf(input) {
        await service.delegateLeaf(input);
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

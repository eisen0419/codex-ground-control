import assert from "node:assert/strict";
import test from "node:test";

import {
  createPiRpcAdapter,
} from "../src/v0.3/pi-rpc-adapter.js";

function createFakeBoundary({ responseId, stateSessionId } = {}) {
  const sessions = [];
  return {
    sessions,
    async start(options) {
      const sessionId =
        options.args[
          options.args.indexOf("--session-id") + 1
        ];
      const session = {
        options,
        sessionId,
        commands: [],
        stopped: false,
      };
      sessions.push(session);
      return {
        write(line) {
          const command = JSON.parse(line);
          session.commands.push(command);
          const data =
            command.type === "get_state"
              ? { sessionId, isStreaming: false }
              : { accepted: true };
          options.onLine(
            JSON.stringify({
              type: "response",
              id: responseId?.(command.id) ?? command.id,
              success: true,
              data:
                command.type === "get_state" && stateSessionId
                  ? { ...data, sessionId: stateSessionId }
                  : data,
            }),
          );
        },
        async stop() {
          session.stopped = true;
        },
      };
    },
    async recover() {
      return null;
    },
    emit(index, value) {
      sessions[index].options.onLine(JSON.stringify(value));
    },
  };
}

test("Pi RPC adapter validates get_state and exposes only normalized ordered signals", async () => {
  const boundary = createFakeBoundary();
  const ids = ["incarnation-601", "incarnation-602"];
  const timestamps = [
    "2026-07-31T02:00:01.000Z",
    "2026-07-31T02:00:02.000Z",
    "2026-07-31T02:00:03.000Z",
  ];
  const adapter = createPiRpcAdapter({
    processBoundary: boundary,
    idFactory: () => ids.shift(),
    clock: () => timestamps.shift(),
    command: "/controlled/pi",
    commandArgs: ["fixture-entry"],
    environment: {
      SAFE_MARKER: "allowed",
      UNRELATED_CREDENTIAL: "must-not-cross",
    },
    environmentAllowlist: ["SAFE_MARKER"],
  });

  const first = await adapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000601",
  });
  const second = await adapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000602",
  });

  assert.notEqual(
    first.nativeSessionBinding.processIncarnation,
    second.nativeSessionBinding.processIncarnation,
  );
  assert.equal(boundary.sessions[0].commands[0].type, "get_state");
  assert.equal(
    boundary.sessions[0].options.env.SAFE_MARKER,
    "allowed",
  );
  assert.equal(
    Object.hasOwn(
      boundary.sessions[0].options.env,
      "UNRELATED_CREDENTIAL",
    ),
    false,
  );
  boundary.emit(0, {
    type: "agent_start",
    pid: 999,
    prompt: "must not cross",
  });
  boundary.emit(0, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "raw output" }],
      reasoning: "hidden",
    },
  });
  boundary.emit(0, {
    type: "agent_settled",
    transcript: "/private/session.jsonl",
  });

  assert.deepEqual(
    await adapter.observe({
      nativeSessionBinding: first.nativeSessionBinding,
      runtime: first.runtime,
      afterSequence: 1,
    }),
    [
      {
        nativeSessionBinding: first.nativeSessionBinding,
        sequence: 2,
        observedAt: "2026-07-31T02:00:01.000Z",
        signal: { type: "turn.started" },
      },
      {
        nativeSessionBinding: first.nativeSessionBinding,
        sequence: 3,
        observedAt: "2026-07-31T02:00:02.000Z",
        signal: {
          type: "result.accepted",
          result: { disposition: "candidate-evidence" },
        },
      },
      {
        nativeSessionBinding: first.nativeSessionBinding,
        sequence: 4,
        observedAt: "2026-07-31T02:00:03.000Z",
        signal: { type: "turn.settled" },
      },
    ],
  );
  assert.equal(
    JSON.stringify(
      await adapter.observe({
        nativeSessionBinding: first.nativeSessionBinding,
        runtime: first.runtime,
        afterSequence: 1,
      }),
    ).includes("raw output"),
    false,
  );
});

test("Pi RPC adapter rejects mismatched response and session identities with sanitized errors", async () => {
  const wrongResponseAdapter = createPiRpcAdapter({
    processBoundary: createFakeBoundary({
      responseId: (id) => `${id}-stale`,
    }),
    idFactory: () => "incarnation-603",
    command: "/controlled/pi",
  });
  await assert.rejects(
    wrongResponseAdapter.start({
      cwd: "/controlled/checkout",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000603",
    }),
    (error) =>
      error?.code === "PI_RPC_ADAPTER_IDENTITY_ERROR" &&
      !error.message.includes("stale"),
  );

  const wrongSessionAdapter = createPiRpcAdapter({
    processBoundary: createFakeBoundary({
      stateSessionId:
        "00000000-0000-4000-8000-000000000699",
    }),
    idFactory: () => "incarnation-604",
    command: "/controlled/pi",
  });
  await assert.rejects(
    wrongSessionAdapter.start({
      cwd: "/controlled/checkout",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000604",
    }),
    (error) => error?.code === "PI_RPC_ADAPTER_IDENTITY_ERROR",
  );
});

test("Pi RPC adapter compares the full binding before aborting and preserves a sibling", async () => {
  const boundary = createFakeBoundary();
  const ids = ["incarnation-605", "incarnation-606"];
  const adapter = createPiRpcAdapter({
    processBoundary: boundary,
    idFactory: () => ids.shift(),
    command: "/controlled/pi",
  });
  const active = await adapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000605",
  });
  const sibling = await adapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000606",
  });

  await assert.rejects(
    adapter.cancel({
      nativeSessionBinding: {
        ...active.nativeSessionBinding,
        processIncarnation: "stale-incarnation",
      },
      runtime: active.runtime,
    }),
    (error) => error?.code === "PI_RPC_ADAPTER_IDENTITY_ERROR",
  );
  assert.equal(
    boundary.sessions[0].commands.filter(
      ({ type }) => type === "abort",
    ).length,
    0,
  );

  await adapter.cancel({
    nativeSessionBinding: active.nativeSessionBinding,
    runtime: active.runtime,
  });

  assert.equal(
    boundary.sessions[0].commands.filter(
      ({ type }) => type === "abort",
    ).length,
    1,
  );
  assert.equal(
    boundary.sessions[1].commands.filter(
      ({ type }) => type === "abort",
    ).length,
    0,
  );
  assert.equal(
    (
      await adapter.observe({
        nativeSessionBinding: sibling.nativeSessionBinding,
        runtime: sibling.runtime,
        afterSequence: 1,
      })
    ).length,
    0,
  );
});

test("Pi RPC recovery continues normalized sequencing from the durable cursor", async () => {
  let callbacks;
  const binding = Object.freeze({
    adapterId: "pi-rpc",
    provider: "pi",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000607",
    processIncarnation: "incarnation-607",
  });
  const processBoundary = {
    async start() {
      throw new Error("not expected");
    },
    async recover(options) {
      callbacks = options;
      return {
        write(line) {
          const command = JSON.parse(line);
          options.onLine(
            JSON.stringify({
              type: "response",
              id: command.id,
              success: true,
              data: { sessionId: binding.sessionId },
            }),
          );
        },
        async stop() {},
      };
    },
  };
  const adapter = createPiRpcAdapter({
    processBoundary,
    clock: () => "2026-07-31T02:00:08.000Z",
  });

  const recovered = await adapter.recover({
    nativeSessionBinding: binding,
    afterSequence: 7,
  });
  callbacks.onLine(JSON.stringify({ type: "agent_start" }));

  assert.deepEqual(
    await adapter.observe({
      nativeSessionBinding: binding,
      runtime: recovered.runtime,
      afterSequence: 7,
    }),
    [
      {
        nativeSessionBinding: binding,
        sequence: 8,
        observedAt: "2026-07-31T02:00:08.000Z",
        signal: { type: "turn.started" },
      },
    ],
  );
});

test("Pi RPC adapter sanitizes injected boundary failures before process or public output", async () => {
  const boundary = createFakeBoundary();
  const environmentFailure = createPiRpcAdapter({
    processBoundary: boundary,
    idFactory: () => "incarnation-608",
    environment() {
      throw new Error("raw-environment-secret");
    },
  });
  await assert.rejects(
    environmentFailure.start({
      cwd: "/controlled/checkout",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000608",
    }),
    (error) =>
      error?.code === "PI_RPC_ADAPTER_UNEXPECTED" &&
      !error.message.includes("raw-environment-secret"),
  );
  assert.equal(boundary.sessions.length, 0);

  const idFailure = createPiRpcAdapter({
    processBoundary: boundary,
    idFactory() {
      throw new Error("raw-id-secret");
    },
  });
  await assert.rejects(
    idFailure.start({
      cwd: "/controlled/checkout",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000609",
    }),
    (error) =>
      error?.code === "PI_RPC_ADAPTER_UNEXPECTED" &&
      !error.message.includes("raw-id-secret"),
  );
  assert.equal(boundary.sessions.length, 0);

  const missingRuntime = createPiRpcAdapter({
    processBoundary: {
      async start() {
        return null;
      },
      async recover() {
        return null;
      },
    },
    idFactory: () => "incarnation-610",
  });
  await assert.rejects(
    missingRuntime.start({
      cwd: "/controlled/checkout",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000610",
    }),
    (error) => error?.code === "PI_RPC_ADAPTER_UNAVAILABLE",
  );
});

test("Pi RPC adapter rejects non-canonical recovery bindings before touching the process boundary", async () => {
  let recoverCalls = 0;
  const processBoundary = {
    async start() {
      throw new Error("not expected");
    },
    async recover() {
      recoverCalls += 1;
      return null;
    },
  };
  const adapter = createPiRpcAdapter({ processBoundary });

  await assert.rejects(
    adapter.recover({
      nativeSessionBinding: {
        adapterId: "pi-rpc",
        provider: "pi",
        modelProvider: "zai-coding-cn",
        model: "glm-5.2",
        sessionId: "00000000-0000-4000-8000-000000000610",
        processIncarnation: "incarnation-610",
        transcript: "/private/raw.jsonl",
      },
      afterSequence: 2,
    }),
    (error) => error?.code === "PI_RPC_ADAPTER_IDENTITY_ERROR",
  );
  assert.equal(recoverCalls, 0);
});

test("Pi RPC event clock failures become sanitized adapter errors", async () => {
  const boundary = createFakeBoundary();
  const adapter = createPiRpcAdapter({
    processBoundary: boundary,
    idFactory: () => "incarnation-611",
    clock() {
      throw new Error("raw-clock-secret");
    },
  });
  const started = await adapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000611",
  });

  assert.doesNotThrow(() => {
    boundary.emit(0, { type: "agent_start" });
  });
  await assert.rejects(
    adapter.observe({
      nativeSessionBinding: started.nativeSessionBinding,
      runtime: started.runtime,
      afterSequence: 1,
    }),
    (error) =>
      error?.code === "PI_RPC_ADAPTER_UNEXPECTED" &&
      !error.message.includes("raw-clock-secret"),
  );
});

test("Pi RPC requests have an enforced hard cap and bounded timeout cleanup", async () => {
  assert.throws(
    () =>
      createPiRpcAdapter({
        processBoundary: createFakeBoundary(),
        requestTimeoutMs: 60_001,
      }),
    (error) => error?.code === "PI_RPC_ADAPTER_UNEXPECTED",
  );

  let stopped = false;
  const adapter = createPiRpcAdapter({
    processBoundary: {
      async start() {
        return {
          write() {},
          async stop() {
            stopped = true;
            throw new Error("raw-stop-secret");
          },
        };
      },
      async recover() {
        return null;
      },
    },
    idFactory: () => "incarnation-612",
    requestTimeoutMs: 5,
  });
  await assert.rejects(
    adapter.start({
      cwd: "/controlled/checkout",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000612",
    }),
    (error) =>
      error?.code === "PI_RPC_ADAPTER_UNAVAILABLE" &&
      !error.message.includes("raw-stop-secret"),
  );
  assert.equal(stopped, true);
});

test("Pi RPC probe never reports ready without boundary evidence", async () => {
  const unavailable = createPiRpcAdapter({
    processBoundary: createFakeBoundary(),
  });
  assert.deepEqual(await unavailable.probe(), {
    status: "unavailable",
  });

  const failed = createPiRpcAdapter({
    processBoundary: {
      ...createFakeBoundary(),
      async probe() {
        throw new Error("raw-probe-secret");
      },
    },
  });
  assert.deepEqual(await failed.probe(), { status: "error" });

  const ready = createPiRpcAdapter({
    processBoundary: {
      ...createFakeBoundary(),
      async probe() {
        return { status: "ready", detail: "must-not-cross" };
      },
    },
  });
  assert.deepEqual(await ready.probe(), { status: "ready" });
});

test("Pi RPC bounds structured lines and uncommitted event buffering", async () => {
  assert.throws(
    () =>
      createPiRpcAdapter({
        processBoundary: createFakeBoundary(),
        maxLineBytes: 1_048_577,
      }),
    (error) => error?.code === "PI_RPC_ADAPTER_UNEXPECTED",
  );
  assert.throws(
    () =>
      createPiRpcAdapter({
        processBoundary: createFakeBoundary(),
        maxBufferedEvents: 10_001,
      }),
    (error) => error?.code === "PI_RPC_ADAPTER_UNEXPECTED",
  );

  const lineBoundary = createFakeBoundary();
  const lineAdapter = createPiRpcAdapter({
    processBoundary: lineBoundary,
    idFactory: () => "incarnation-613",
    maxLineBytes: 256,
  });
  const lineRuntime = await lineAdapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000613",
  });
  assert.equal(lineBoundary.sessions[0].options.maxLineBytes, 256);
  lineBoundary.sessions[0].options.onLine("x".repeat(257));
  await assert.rejects(
    lineAdapter.observe({
      nativeSessionBinding: lineRuntime.nativeSessionBinding,
      runtime: lineRuntime.runtime,
      afterSequence: 1,
    }),
    (error) => error?.code === "PI_RPC_ADAPTER_UNAVAILABLE",
  );
  assert.equal(lineBoundary.sessions[0].stopped, true);

  const eventBoundary = createFakeBoundary();
  const eventAdapter = createPiRpcAdapter({
    processBoundary: eventBoundary,
    idFactory: () => "incarnation-614",
    maxBufferedEvents: 2,
  });
  const eventRuntime = await eventAdapter.start({
    cwd: "/controlled/checkout",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000614",
  });
  eventBoundary.emit(0, { type: "agent_start" });
  eventBoundary.emit(0, {
    type: "message_end",
    message: {
      role: "assistant",
      stopReason: "stop",
    },
  });
  assert.equal(
    (
      await eventAdapter.observe({
        nativeSessionBinding: eventRuntime.nativeSessionBinding,
        runtime: eventRuntime.runtime,
        afterSequence: 1,
      })
    ).length,
    2,
  );
  await eventAdapter.observe({
    nativeSessionBinding: eventRuntime.nativeSessionBinding,
    runtime: eventRuntime.runtime,
    afterSequence: 3,
  });
  eventBoundary.emit(0, { type: "agent_start" });
  eventBoundary.emit(0, { type: "agent_start" });
  eventBoundary.emit(0, { type: "agent_start" });
  const buffered = await eventAdapter.observe({
    nativeSessionBinding: eventRuntime.nativeSessionBinding,
    runtime: eventRuntime.runtime,
    afterSequence: 3,
  });
  assert.equal(buffered.length, 2);
  await assert.rejects(
    eventAdapter.observe({
      nativeSessionBinding: eventRuntime.nativeSessionBinding,
      runtime: eventRuntime.runtime,
      afterSequence: buffered.at(-1).sequence,
    }),
    (error) => error?.code === "PI_RPC_ADAPTER_UNAVAILABLE",
  );
  assert.equal(eventBoundary.sessions[0].stopped, true);
});

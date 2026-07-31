import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createLeafProductionComposition,
  registerLeafMcpTools,
} from "../src/v0.3/leaf-mcp-composition.js";

function createRpcBoundary() {
  const starts = [];
  return {
    starts,
    closeCount: 0,
    async start(options) {
      const record = { options, commands: [], stopped: false };
      starts.push(record);
      return {
        write(line) {
          const command = JSON.parse(line);
          record.commands.push(command);
          options.onLine(
            JSON.stringify({
              type: "response",
              id: command.id,
              success: true,
              data:
                command.type === "get_state"
                  ? {
                      sessionId:
                        options.nativeSessionBinding.sessionId,
                    }
                  : { accepted: true },
            }),
          );
        },
        async stop() {
          record.stopped = true;
        },
      };
    },
    async recover() {
      return null;
    },
    emit(index, value) {
      starts[index].options.onLine(JSON.stringify(value));
    },
    async close() {
      this.closeCount += 1;
      for (const record of starts) {
        record.stopped = true;
      }
    },
  };
}

async function journalText(rootDirectory) {
  const chunks = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else {
        chunks.push(await readFile(target, "utf8"));
      }
    }
  }
  await visit(rootDirectory);
  return chunks.join("\n");
}

function sessionDirectoryFactory(rootDirectory) {
  return (sessionId) =>
    join(rootDirectory, "pi-sessions", sessionId);
}

test("production composition requires an ephemeral Host dispatch and uses only the Host checkout plus profile environment", async (t) => {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-production-"),
  );
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const boundary = createRpcBoundary();
  const composition = createLeafProductionComposition({
    rootDirectory,
    processBoundary: boundary,
    command: "/offline/node-fixture",
    profiles: {
      "offline-fixture": {
        adapterId: "pi-rpc",
        modelProvider: "offline",
        model: "deterministic",
        environment: {
          SAFE_MARKER: "allowed",
          AMBIENT_CREDENTIAL: "must-not-cross",
        },
        environmentAllowlist: ["SAFE_MARKER"],
      },
    },
    sessionIdFactory: () =>
      "00000000-0000-4000-8000-000000000901",
    sessionDirectoryFromSessionId:
      sessionDirectoryFactory(rootDirectory),
    processIncarnationFactory: () => "incarnation-901",
    clock: () => "2026-07-31T03:00:00.000Z",
    hostDispatchFromCall(callContext) {
      if (callContext?.hostRequest !== "fresh-call") {
        throw new Error("raw-host-dispatch-secret");
      }
      return { selectedCheckout: "/host-selected/checkout" };
    },
  });
  t.after(() => composition.close());
  const input = {
    taskId: "leaf-901",
    adapterId: "pi-rpc",
    profile: "offline-fixture",
    activity: "offline acceptance",
  };

  await assert.rejects(
    composition.start(input),
    (error) => error?.code === "LEAF_PRODUCTION_HOST_DISPATCH_REQUIRED",
  );
  assert.equal(boundary.starts.length, 0);
  await assert.rejects(
    composition.start(
      {
        ...input,
        taskId: "leaf\ncontrol",
        input: "x".repeat(8_193),
      },
      { hostRequest: "fresh-call" },
    ),
    (error) => error?.code === "LEAF_PRODUCTION_INVALID",
  );
  assert.equal(boundary.starts.length, 0);

  const card = await composition.start(input, {
    hostRequest: "fresh-call",
  });
  assert.deepEqual(card, await composition.inspect("leaf-901"));
  assert.equal(boundary.starts[0].options.cwd, "/host-selected/checkout");
  assert.deepEqual(boundary.starts[0].options.env, {
    SAFE_MARKER: "allowed",
    PI_CODING_AGENT_SESSION_DIR: join(
      rootDirectory,
      "pi-sessions",
      "00000000-0000-4000-8000-000000000901",
    ),
    PI_TELEMETRY: "0",
  });
  const sessionDirectoryIndex =
    boundary.starts[0].options.args.indexOf("--session-dir");
  assert.equal(sessionDirectoryIndex >= 0, true);
  assert.equal(
    boundary.starts[0].options.args[sessionDirectoryIndex + 1],
    join(
      rootDirectory,
      "pi-sessions",
      "00000000-0000-4000-8000-000000000901",
    ),
  );
  assert.equal(
    boundary.starts[0].options.args.includes("deterministic"),
    true,
  );

  const persisted = await journalText(rootDirectory);
  for (const forbidden of [
    "codex-host",
    "/host-selected/checkout",
    "SAFE_MARKER",
    "AMBIENT_CREDENTIAL",
  ]) {
    assert.equal(persisted.includes(forbidden), false);
  }

  await composition.close();
  await composition.close();
  assert.equal(boundary.closeCount, 1);
  await assert.rejects(
    composition.inspect("leaf-901"),
    (error) => error?.code === "LEAF_PRODUCTION_CLOSED",
  );
});

test("Host registration exposes exactly three tools and every public card is the inspect projection", async (t) => {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-host-registration-"),
  );
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const boundary = createRpcBoundary();
  const composition = createLeafProductionComposition({
    rootDirectory,
    processBoundary: boundary,
    command: "/offline/node-fixture",
    profiles: {
      "offline-fixture": {
        adapterId: "pi-rpc",
        modelProvider: "offline",
        model: "deterministic",
        environment: {},
        environmentAllowlist: [],
      },
    },
    sessionIdFactory: () =>
      "00000000-0000-4000-8000-000000000902",
    sessionDirectoryFromSessionId:
      sessionDirectoryFactory(rootDirectory),
    processIncarnationFactory: () => "incarnation-902",
    clock: () => "2026-07-31T03:00:00.000Z",
    hostDispatchFromCall(callContext) {
      dispatchReads += 1;
      assert.equal(callContext.hostRequest, "fresh-call");
      return { selectedCheckout: "/host-selected/checkout" };
    },
  });
  t.after(() => composition.close());
  const registered = new Map();
  const server = {
    registerTool(name, definition, handler) {
      registered.set(name, { definition, handler });
    },
  };
  let dispatchReads = 0;
  registerLeafMcpTools({
    server,
    composition,
  });

  assert.deepEqual([...registered.keys()], [
    "delegate_leaf",
    "inspect_leaf",
    "cancel_leaf",
  ]);
  assert.equal(
    registered.get("delegate_leaf").definition.annotations.openWorldHint,
    true,
  );
  assert.equal(
    registered.get("inspect_leaf").definition.annotations.readOnlyHint,
    true,
  );
  const registeredDelegateSchema =
    registered.get("delegate_leaf").definition.inputSchema;
  assert.equal(
    registeredDelegateSchema.safeParse({
      taskId: "leaf-schema",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline acceptance",
    }).success,
    true,
  );
  assert.equal(
    registeredDelegateSchema.safeParse({
      taskId: "leaf-schema",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline acceptance",
      cwd: "/must-not-cross",
    }).success,
    false,
  );

  const delegated = await registered.get("delegate_leaf").handler(
    {
      taskId: "leaf-902",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline acceptance",
    },
    { hostRequest: "fresh-call" },
  );
  assert.deepEqual(
    delegated.structuredContent,
    await composition.inspect("leaf-902"),
  );
  const inspected = await registered.get("inspect_leaf").handler({
    taskId: "leaf-902",
  });
  assert.deepEqual(inspected.structuredContent, delegated.structuredContent);
  assert.equal(dispatchReads, 1);
  assert.equal(
    JSON.stringify(delegated).includes("incarnation-902"),
    false,
  );
});

test("Host registration lists the three-operation contract through the real MCP SDK", async (t) => {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-real-mcp-"),
  );
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  let observedHostCallContext = null;
  const composition = createLeafProductionComposition({
    rootDirectory,
    processBoundary: createRpcBoundary(),
    command: "/offline/node-fixture",
    profiles: {
      "offline-fixture": {
        adapterId: "pi-rpc",
        modelProvider: "offline",
        model: "deterministic",
        environment: {},
        environmentAllowlist: [],
      },
    },
    sessionIdFactory: () =>
      "00000000-0000-4000-8000-000000000904",
    sessionDirectoryFromSessionId:
      sessionDirectoryFactory(rootDirectory),
    processIncarnationFactory: () => "incarnation-904",
    hostDispatchFromCall(callContext) {
      observedHostCallContext = callContext;
      return { selectedCheckout: "/host-selected/checkout" };
    },
  });
  t.after(() => composition.close());
  const server = new McpServer({
    name: "ground-control-v0.3-test",
    version: "0.3.0",
  });
  const client = new Client({
    name: "ground-control-v0.3-test-client",
    version: "0.3.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(() => client.close());
  t.after(() => server.close());

  registerLeafMcpTools({ server, composition });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const listed = await client.listTools();

  assert.deepEqual(
    listed.tools.map(({ name }) => name),
    ["delegate_leaf", "inspect_leaf", "cancel_leaf"],
  );
  assert.deepEqual(
    Object.keys(
      listed.tools.find(({ name }) => name === "delegate_leaf")
        .inputSchema.properties,
    ).sort(),
    ["activity", "adapterId", "input", "profile", "taskId"],
  );
  assert.equal(
    listed.tools.find(({ name }) => name === "delegate_leaf")
      .inputSchema.properties.input.maxLength,
    8_192,
  );
  assert.equal(
    listed.tools.find(({ name }) => name === "delegate_leaf")
      .inputSchema.additionalProperties,
    false,
  );
  const delegated = await client.callTool({
    name: "delegate_leaf",
    arguments: {
      taskId: "leaf-real-mcp",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline acceptance",
    },
  });
  const inspected = await client.callTool({
    name: "inspect_leaf",
    arguments: { taskId: "leaf-real-mcp" },
  });
  assert.equal(typeof observedHostCallContext?.requestId, "number");
  assert.deepEqual(
    delegated.structuredContent,
    inspected.structuredContent,
  );
});

test("a terminal provider projection retires its exact production runtime", async (t) => {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-terminal-retire-"),
  );
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  const boundary = createRpcBoundary();
  const composition = createLeafProductionComposition({
    rootDirectory,
    processBoundary: boundary,
    command: "/offline/node-fixture",
    profiles: {
      "offline-fixture": {
        adapterId: "pi-rpc",
        modelProvider: "offline",
        model: "deterministic",
        environment: {},
        environmentAllowlist: [],
      },
    },
    sessionIdFactory: () =>
      "00000000-0000-4000-8000-000000000903",
    sessionDirectoryFromSessionId:
      sessionDirectoryFactory(rootDirectory),
    processIncarnationFactory: () => "incarnation-903",
    clock: () => "2026-07-31T03:00:00.000Z",
    hostDispatchFromCall(callContext) {
      if (callContext?.hostRequest !== "fresh-call") {
        throw new Error("raw-host-dispatch-secret");
      }
      return { selectedCheckout: "/host-selected/checkout" };
    },
  });
  t.after(() => composition.close());
  await composition.start(
    {
      taskId: "leaf-903",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline acceptance",
    },
    { hostRequest: "fresh-call" },
  );
  boundary.emit(0, {
    type: "agent_start",
    sessionId: "00000000-0000-4000-8000-000000000903",
  });
  assert.equal((await composition.inspect("leaf-903")).state, "running");
  boundary.emit(0, {
    type: "message_end",
    sessionId: "00000000-0000-4000-8000-000000000903",
    message: { role: "assistant", stopReason: "stop" },
  });
  boundary.emit(0, {
    type: "agent_settled",
    sessionId: "00000000-0000-4000-8000-000000000903",
  });

  const terminal = await composition.inspect("leaf-903");
  assert.equal(terminal.state, "completed");
  assert.equal(terminal.canCancel, false);
  assert.equal(boundary.starts[0].stopped, true);
});

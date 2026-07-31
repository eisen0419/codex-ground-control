import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ListRootsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";

import { createLeafMcpComposition } from "../src/v0.3/leaf-mcp-composition.js";
import {
  GROUND_CONTROL_V03_WIDGET_URI,
  createLeafMcpAppServer,
  createLeafProductionMcpAppServer,
} from "../src/v0.3/mcp-app-server.js";

function fixtureComposition() {
  const cards = new Map();
  const composition = createLeafMcpComposition({
    service: {
      async delegateLeaf(input) {
        cards.set(input.taskId, {
          schemaVersion: "0.3",
          taskId: input.taskId,
          adapterId: input.adapterId,
          profile: input.profile,
          activity: input.activity,
          provider: "pi",
          modelProvider: "zai-coding-cn",
          model: "glm-5.2",
          nativeSession: null,
          state: "starting",
          stage: "dispatch-received",
          latestEvent: null,
          canCancel: false,
          result: null,
        });
      },
      async inspectLeaf(taskId) {
        return cards.get(taskId);
      },
      async cancelLeaf(taskId) {
        return cards.get(taskId);
      },
    },
  });
  return Object.freeze({
    ...composition,
    async close() {},
  });
}

function widgetElement() {
  const listeners = new Map();
  return {
    className: "",
    dataset: {},
    disabled: false,
    textContent: "",
    title: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      return listeners.get(type)?.({ type });
    },
  };
}

function productionFixtureOptions({
  starts,
  sessionRoot,
  sessionId,
  processIncarnation,
  timestamp,
}) {
  return {
    processBoundary: {
      async start(options) {
        starts.push(options);
        return {
          write(line) {
            const request = JSON.parse(line);
            options.onLine(
              JSON.stringify({
                type: "response",
                id: request.id,
                success: true,
                data:
                  request.type === "get_state"
                    ? {
                        sessionId:
                          options.nativeSessionBinding.sessionId,
                      }
                    : { accepted: true },
              }),
            );
          },
          async stop() {},
        };
      },
      async recover() {
        return null;
      },
      async close() {},
    },
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
    sessionIdFactory: () => sessionId,
    sessionDirectoryFromSessionId: (currentSessionId) =>
      join(sessionRoot, "sessions", currentSessionId),
    processIncarnationFactory: () => processIncarnation,
    clock: () => timestamp,
  };
}

test("v0.3 MCP App publishes three semantic operations plus one read-only Host renderer", async (t) => {
  const server = createLeafMcpAppServer({
    composition: fixtureComposition(),
  });
  const client = new Client({
    name: "ground-control-v0.3-app-test",
    version: "0.3.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(() => client.close());
  t.after(() => server.close());
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name),
    [
      "delegate_leaf",
      "inspect_leaf",
      "cancel_leaf",
      "render_leaf_card",
    ],
  );
  for (const tool of tools.tools) {
    assert.equal(
      tool._meta.ui.resourceUri,
      GROUND_CONTROL_V03_WIDGET_URI,
    );
  }
  assert.deepEqual(
    tools.tools.map(({ _meta }) => _meta.ui.visibility),
    [["model"], ["app"], ["app"], ["model"]],
  );
  assert.deepEqual(
    tools.tools.map(
      ({ _meta }) => _meta["openai/widgetAccessible"],
    ),
    [false, true, true, false],
  );
  const renderer = tools.tools.find(
    ({ name }) => name === "render_leaf_card",
  );
  assert.deepEqual(renderer.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });

  const resources = await client.listResources();
  assert.deepEqual(
    resources.resources.map(({ uri }) => uri),
    [GROUND_CONTROL_V03_WIDGET_URI],
  );
  const resource = await client.readResource({
    uri: GROUND_CONTROL_V03_WIDGET_URI,
  });
  assert.equal(resource.contents[0].mimeType, RESOURCE_MIME_TYPE);
  assert.match(
    resource.contents[0].text,
    /data-ground-control-version="0\.3"/,
  );
  assert.match(
    resource.contents[0].text,
    /data-ground-control-layout="compact-progress"/,
  );
  for (const requiredControl of [
    'id="step-session"',
    'id="step-provider"',
    'id="step-result"',
    'id="inspect"',
    'id="cancel"',
  ]) {
    assert.equal(
      resource.contents[0].text.includes(requiredControl),
      true,
      `compact progress card should include ${requiredControl}`,
    );
  }
  assert.equal(
    resource.contents[0].text.match(
      /class="step-line"/g,
    )?.length,
    2,
    "progress connectors should be separate elements after their labels",
  );
  assert.deepEqual(resource.contents[0]._meta.ui.csp, {
    connectDomains: [],
    resourceDomains: [],
  });

  const defaultConfig = JSON.parse(
    await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    defaultConfig.mcpServers["codex-ground-control"].args,
    ["src/mcp-app-server.js"],
  );
});

test("read-only Host renderer returns the exact inspect projection without delegating or cancelling", async (t) => {
  const projection = {
    schemaVersion: "0.3",
    taskId: "leaf-render-card",
    adapterId: "pi-rpc",
    profile: "pi-glm",
    activity: "bounded review",
    provider: "pi",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    nativeSession: {
      id: "00000000-0000-4000-8000-000000000309",
      inspectable: true,
    },
    state: "cancelled",
    stage: "provider-cancelled",
    latestEvent: {
      sequence: 4,
      type: "turn.cancelled",
      source: "provider-native",
      observedAt: "2026-08-01T02:30:00.000Z",
    },
    canCancel: false,
    result: null,
  };
  let inspectCalls = 0;
  let delegateCalls = 0;
  let cancelCalls = 0;
  const compositionContract = createLeafMcpComposition({
    service: {
      async delegateLeaf() {
        delegateCalls += 1;
      },
      async inspectLeaf(taskId) {
        inspectCalls += 1;
        assert.equal(taskId, projection.taskId);
        return projection;
      },
      async cancelLeaf() {
        cancelCalls += 1;
      },
    },
  });
  const server = createLeafMcpAppServer({
    composition: Object.freeze({
      ...compositionContract,
      async close() {},
    }),
  });
  const client = new Client({
    name: "ground-control-v0.3-read-only-render-test",
    version: "0.3.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(() => client.close());
  t.after(() => server.close());
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const rendered = await client.callTool({
    name: "render_leaf_card",
    arguments: { taskId: projection.taskId },
  });
  const inspected = await client.callTool({
    name: "inspect_leaf",
    arguments: { taskId: projection.taskId },
  });

  assert.deepEqual(rendered.structuredContent, projection);
  assert.deepEqual(rendered.structuredContent, inspected.structuredContent);
  assert.equal(inspectCalls, 2);
  assert.equal(delegateCalls, 0);
  assert.equal(cancelCalls, 0);
  assert.equal(
    JSON.stringify(rendered).includes("processIncarnation"),
    false,
  );
});

test("final Host preview exercises the packaged production widget instead of a spike fork", async () => {
  const preview = await readFile(
    new URL(
      "../designs/ground-control-v0.3-card/host-preview.html",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    preview,
    /assets\/apps\/ground-control\/v0\.3-leaf-session\.html/,
  );
  assert.equal(
    preview.includes("product-surface-mcp-prototype/widget.html"),
    false,
  );
  assert.equal(
    preview.includes('kind: "synthetic-leaf-task-state"'),
    false,
  );
});

test("v0.3 MCP App calls delegate, inspect, and exact cancel through one sanitized projection and owns composition cleanup", async (t) => {
  const cards = new Map();
  let delegateCallContext = null;
  let closeCount = 0;
  const compositionContract = createLeafMcpComposition({
    service: {
      async delegateLeaf(input, callContext) {
        delegateCallContext = callContext;
        cards.set(input.taskId, {
          schemaVersion: "0.3",
          taskId: input.taskId,
          adapterId: input.adapterId,
          profile: input.profile,
          activity: input.activity,
          provider: "pi",
          modelProvider: "offline",
          model: "deterministic",
          nativeSession: null,
          state: "starting",
          stage: "dispatch-received",
          latestEvent: null,
          canCancel: true,
          result: null,
        });
      },
      async inspectLeaf(taskId) {
        return cards.get(taskId);
      },
      async cancelLeaf(taskId) {
        cards.set(taskId, {
          ...cards.get(taskId),
          state: "cancelled",
          stage: "cancelled",
          canCancel: false,
        });
      },
    },
  });
  const composition = Object.freeze({
    ...compositionContract,
    async close() {
      closeCount += 1;
    },
  });
  const server = createLeafMcpAppServer({ composition });
  const client = new Client({
    name: "ground-control-v0.3-app-call-test",
    version: "0.3.0",
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  let clientClosed = false;
  let serverClosed = false;
  t.after(async () => {
    if (!clientClosed) await client.close();
    if (!serverClosed) await server.close();
  });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const delegated = await client.callTool({
    name: "delegate_leaf",
    arguments: {
      taskId: "leaf-app-call",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline Host integration",
    },
  });
  const inspected = await client.callTool({
    name: "inspect_leaf",
    arguments: { taskId: "leaf-app-call" },
  });
  assert.equal(typeof delegateCallContext?.requestId, "number");
  assert.deepEqual(delegated.structuredContent, inspected.structuredContent);

  const cancelled = await client.callTool({
    name: "cancel_leaf",
    arguments: { taskId: "leaf-app-call" },
  });
  const afterCancel = await client.callTool({
    name: "inspect_leaf",
    arguments: { taskId: "leaf-app-call" },
  });
  assert.deepEqual(cancelled.structuredContent, afterCancel.structuredContent);
  assert.equal(afterCancel.structuredContent.state, "cancelled");
  assert.equal(afterCancel.structuredContent.canCancel, false);
  for (const privateField of [
    "processIncarnation",
    "sessionDirectory",
    "selectedCheckout",
  ]) {
    assert.equal(JSON.stringify(afterCancel).includes(privateField), false);
  }

  await client.close();
  clientClosed = true;
  await server.close();
  serverClosed = true;
  await server.close();
  assert.equal(closeCount, 1);
});

test("v0.3 widget polls inspect_leaf and can cancel only the exact displayed task", async () => {
  const widget = await readFile(
    new URL(
      "../assets/apps/ground-control/v0.3-leaf-session.html",
      import.meta.url,
    ),
    "utf8",
  );
  const script = widget.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, "v0.3 widget inline script should exist");

  const elements = Object.fromEntries(
    [
      "card",
      "status",
      "title",
      "subtitle",
      "task",
      "session",
      "stage",
      "event",
      "step-session",
      "step-session-mark",
      "step-provider",
      "step-provider-mark",
      "step-result",
      "step-result-mark",
      "inspect",
      "cancel",
      "note",
    ].map((id) => [id, widgetElement()]),
  );
  const running = {
    schemaVersion: "0.3",
    taskId: "leaf-widget-301",
    adapterId: "pi-rpc",
    profile: "pi-glm",
    activity: "bounded review",
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
      sequence: 2,
      type: "turn.started",
      source: "provider-native",
      observedAt: "2026-07-31T04:00:02.000Z",
    },
    canCancel: true,
    result: null,
  };
  const starting = {
    ...running,
    state: "starting",
    stage: "session-created",
    latestEvent: {
      ...running.latestEvent,
      sequence: 1,
      type: "session.created",
    },
    canCancel: false,
  };
  const calls = [];
  let resolveInspect = null;
  let poll = null;
  let pollInterval = null;
  let clearCount = 0;
  const windowListeners = new Map();
  const hostParent = { postMessage() {} };
  const window = {
    openai: {
      toolOutput: starting,
      async callTool(name, args) {
        calls.push({ name, args });
        if (name === "inspect_leaf") {
          return new Promise((resolve) => {
            resolveInspect = resolve;
          });
        }
        if (name === "cancel_leaf") {
          return {
            structuredContent: {
              ...running,
              state: "cancelled",
              stage: "cancelled",
              canCancel: false,
              latestEvent: {
                ...running.latestEvent,
                sequence: 4,
                type: "turn.cancelled",
              },
            },
          };
        }
        throw new Error("unexpected widget tool call");
      },
    },
    parent: hostParent,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener() {},
    setInterval(callback, interval) {
      poll = callback;
      pollInterval = interval;
      return 1;
    },
    clearInterval() {
      clearCount += 1;
    },
    setTimeout() {
      return 1;
    },
  };
  const document = {
    body: {},
    documentElement: { lang: "" },
    getElementById(id) {
      return elements[id];
    },
  };

  runInNewContext(script, {
    console,
    document,
    navigator: { language: "zh-CN" },
    window,
  });
  assert.equal(elements.task.textContent, "leaf-wid…-301");
  assert.equal(elements.task.title, "leaf-widget-301");
  assert.equal(elements.session.textContent, "00000000…0301");
  assert.equal(
    elements.session.title,
    "00000000-0000-4000-8000-000000000301",
  );
  assert.equal(elements.card.dataset.state, "starting");
  assert.equal(elements["step-session"].className, "step is-done");
  assert.equal(elements["step-provider"].className, "step");
  assert.equal(elements.cancel.disabled, true);

  assert.equal(typeof poll, "function");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      name: "inspect_leaf",
      args: { taskId: "leaf-widget-301" },
    },
  ]);
  assert.equal(pollInterval, 500);
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  resolveInspect({ structuredContent: running });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(elements.card.dataset.state, "running");
  assert.equal(elements["step-provider"].className, "step is-current");
  assert.equal(elements.cancel.disabled, false);

  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  const resolveStaleInspect = resolveInspect;
  poll();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  await elements.cancel.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));
  resolveStaleInspect({ structuredContent: running });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    {
      name: "inspect_leaf",
      args: { taskId: "leaf-widget-301" },
    },
    {
      name: "inspect_leaf",
      args: { taskId: "leaf-widget-301" },
    },
    {
      name: "cancel_leaf",
      args: { taskId: "leaf-widget-301" },
    },
  ]);
  assert.equal(
    calls.some(({ name }) => name === "delegate_leaf"),
    false,
  );
  assert.equal(elements.status.textContent, "已取消");
  assert.equal(elements.card.dataset.state, "cancelled");
  assert.equal(elements["step-result"].className, "step is-current");
  assert.equal(elements.cancel.disabled, true);
  assert.equal(clearCount, 1);
});

test("production MCP App resolves one Host root as the selected checkout and fails closed for ambiguous roots", async (t) => {
  const rootDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-mcp-app-"),
  );
  const fallbackDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-mcp-fallback-"),
  );
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  t.after(() => rm(fallbackDirectory, { recursive: true, force: true }));
  const starts = [];
  const server = createLeafProductionMcpAppServer({
    rootDirectory,
    hostWorkingDirectory: fallbackDirectory,
    ...productionFixtureOptions({
      starts,
      sessionRoot: rootDirectory,
      sessionId: "00000000-0000-4000-8000-000000000305",
      processIncarnation: "incarnation-305",
      timestamp: "2026-07-31T04:10:00.000Z",
    }),
  });
  const client = new Client(
    {
      name: "ground-control-v0.3-roots-test",
      version: "0.3.0",
    },
    {
      capabilities: { roots: {} },
    },
  );
  let roots = [
    { uri: pathToFileURL(rootDirectory).href },
    { uri: pathToFileURL(join(rootDirectory, "other")).href },
  ];
  client.setRequestHandler(ListRootsRequestSchema, async () => ({
    roots,
  }));
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(() => client.close());
  t.after(() => server.close());
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const ambiguous = await client.callTool({
    name: "delegate_leaf",
    arguments: {
      taskId: "leaf-roots-ambiguous",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline Host roots",
    },
  });
  assert.equal(ambiguous.isError, true);
  assert.equal(
    ambiguous.content[0].text,
    "LEAF_PRODUCTION_HOST_DISPATCH_REQUIRED",
  );
  assert.equal(starts.length, 0);

  roots = [{ uri: pathToFileURL(rootDirectory).href }];
  const delegated = await client.callTool({
    name: "delegate_leaf",
    arguments: {
      taskId: "leaf-roots-exact",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline Host roots",
    },
  });
  assert.equal(delegated.isError, undefined);
  assert.equal(delegated.structuredContent.taskId, "leaf-roots-exact");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].cwd, rootDirectory);
});

test("production MCP App uses an explicit Host stdio working directory when the client has no roots capability", async (t) => {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-mcp-cwd-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const starts = [];
  const productionOptions = productionFixtureOptions({
    starts,
    sessionRoot: temporaryDirectory,
    sessionId: "00000000-0000-4000-8000-000000000306",
    processIncarnation: "incarnation-306",
    timestamp: "2026-08-01T03:40:00.000Z",
  });

  assert.throws(
    () => createLeafProductionMcpAppServer({
      ...productionOptions,
      rootDirectory: join(temporaryDirectory, "relative-state"),
      hostWorkingDirectory: "relative",
    }),
    /working directory/,
  );
  assert.throws(
    () => createLeafProductionMcpAppServer({
      ...productionOptions,
      rootDirectory: join(temporaryDirectory, "root-state"),
      hostWorkingDirectory: "/",
    }),
    /working directory/,
  );
  assert.throws(
    () => createLeafProductionMcpAppServer({
      ...productionOptions,
      rootDirectory: join(temporaryDirectory, "missing-state"),
      hostWorkingDirectory: join(temporaryDirectory, "missing-checkout"),
    }),
    /working directory/,
  );

  const unconfigured = createLeafProductionMcpAppServer({
    ...productionOptions,
    rootDirectory: join(temporaryDirectory, "unconfigured-state"),
  });
  const unconfiguredClient = new Client({
    name: "ground-control-v0.3-no-roots-unconfigured-test",
    version: "0.3.0",
  });
  const [firstClientTransport, firstServerTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(() => unconfiguredClient.close());
  t.after(() => unconfigured.close());
  await Promise.all([
    unconfigured.connect(firstServerTransport),
    unconfiguredClient.connect(firstClientTransport),
  ]);
  const blocked = await unconfiguredClient.callTool({
    name: "delegate_leaf",
    arguments: {
      taskId: "leaf-cwd-unconfigured",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline Host cwd",
    },
  });
  assert.equal(blocked.isError, true);
  assert.equal(
    blocked.content[0].text,
    "LEAF_PRODUCTION_HOST_DISPATCH_REQUIRED",
  );
  assert.equal(starts.length, 0);

  const configured = createLeafProductionMcpAppServer({
    ...productionOptions,
    rootDirectory: join(temporaryDirectory, "configured-state"),
    hostWorkingDirectory: temporaryDirectory,
  });
  const configuredClient = new Client({
    name: "ground-control-v0.3-no-roots-configured-test",
    version: "0.3.0",
  });
  const [secondClientTransport, secondServerTransport] =
    InMemoryTransport.createLinkedPair();
  t.after(() => configuredClient.close());
  t.after(() => configured.close());
  await Promise.all([
    configured.connect(secondServerTransport),
    configuredClient.connect(secondClientTransport),
  ]);
  const delegated = await configuredClient.callTool({
    name: "delegate_leaf",
    arguments: {
      taskId: "leaf-cwd-configured",
      adapterId: "pi-rpc",
      profile: "offline-fixture",
      activity: "offline Host cwd",
    },
  });
  assert.equal(delegated.isError, undefined);
  assert.equal(delegated.structuredContent.taskId, "leaf-cwd-configured");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].cwd, await realpath(temporaryDirectory));
});

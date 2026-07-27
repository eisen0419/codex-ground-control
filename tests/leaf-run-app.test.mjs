import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  completeLeafRun,
  inspectLeafRun,
  prepareLeafRun,
  startLeafRun,
} from "../src/leaf-run.js";
import {
  GROUND_CONTROL_WIDGET_URI,
  createGroundControlMcpServer,
  groundControlToolDefinitions,
  isMainModule,
  readGroundControlWidget,
} from "../src/mcp-app-server.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function blockedAppSurfaceState() {
  return {
    schemaVersion: "1",
    kind: "app-surface-self-test",
    state: "blocked",
    stage: "host-elicitation-declined",
    reason: "host-elicitation-declined",
    hostElicitation: {
      supported: true,
      action: "decline",
      confirmed: false,
    },
    isolation: {
      providerStarts: 0,
      workerStarts: 0,
      networkRequests: 0,
      productionIntentCreated: false,
      liveAuthorizationGranted: false,
    },
    widget: {
      resourceUri: GROUND_CONTROL_WIDGET_URI,
      mimeType: "text/html;profile=mcp-app",
    },
  };
}

function passedAppSurfaceState() {
  return {
    ...blockedAppSurfaceState(),
    state: "passed",
    stage: "host-elicitation-accepted",
    reason: null,
    hostElicitation: {
      supported: true,
      action: "accept",
      confirmed: true,
    },
  };
}

function createWidgetElement() {
  const listeners = new Map();
  return {
    disabled: false,
    textContent: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatch(type) {
      return listeners.get(type)?.({ type });
    },
  };
}

async function exerciseWidgetRepeatButton() {
  const widget = readGroundControlWidget();
  const script = widget.match(
    /<script>\s*([\s\S]*?)<\/script>/,
  )?.[1];
  assert.ok(script, "widget inline script should exist");

  const elementIds = [
    "eyebrow",
    "title",
    "state",
    "profile-label",
    "profile",
    "stage-label",
    "stage",
    "duration-label",
    "duration",
    "usage-label",
    "usage",
    "receipt-label",
    "receipt",
    "note",
    "start",
  ];
  const elements = Object.fromEntries(
    elementIds.map((id) => [id, createWidgetElement()]),
  );
  const windowListeners = new Map();
  const hostMessages = [];
  const compatibilityCalls = [];
  const dispatchWindowEvent = (type, event) => {
    for (const listener of windowListeners.get(type) ?? []) {
      listener(event);
    }
  };
  const hostParent = {
    postMessage(message) {
      hostMessages.push(message);
      if (message.method !== "ui/initialize") {
        return;
      }
      queueMicrotask(() => {
        dispatchWindowEvent("message", {
          source: hostParent,
          data: {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: "2026-01-26",
              hostInfo: {
                name: "fixture-host",
                version: "1.0.0",
              },
              hostCapabilities: {},
              hostContext: {
                locale: "zh-CN",
              },
            },
          },
        });
      });
    },
  };
  const window = {
    openai: {
      locale: "zh-CN",
      toolOutput: blockedAppSurfaceState(),
      async callTool(name, args) {
        compatibilityCalls.push({ name, args });
        return {
          structuredContent: passedAppSurfaceState(),
        };
      },
    },
    parent: hostParent,
    addEventListener(type, listener) {
      const listeners = windowListeners.get(type) ?? [];
      listeners.push(listener);
      windowListeners.set(type, listeners);
    },
    removeEventListener() {},
    requestAnimationFrame(callback) {
      callback();
      return 1;
    },
    setInterval() {
      return 1;
    },
    clearInterval() {},
    setTimeout() {
      return 1;
    },
  };
  const documentElement = {
    lang: "",
    style: {
      height: "",
    },
    getBoundingClientRect() {
      return { height: 480 };
    },
  };
  const document = {
    body: {},
    documentElement,
    title: "",
    getElementById(id) {
      return elements[id];
    },
  };

  runInNewContext(script, {
    console,
    document,
    navigator: {
      language: "zh-CN",
    },
    queueMicrotask,
    ResizeObserver: undefined,
    window,
  });
  await new Promise((resolve) => setImmediate(resolve));
  elements.start.dispatch("click");
  await new Promise((resolve) => setImmediate(resolve));

  return {
    compatibilityCalls,
    elements,
    hostMessages,
  };
}

function initializeRepository(directory) {
  execFileSync("git", ["init", "-q"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "Fixture"], {
    cwd: directory,
  });
  execFileSync("git", ["config", "user.email", "fixture@example.test"], {
    cwd: directory,
  });
  execFileSync("git", ["commit", "--allow-empty", "-qm", "fixture"], {
    cwd: directory,
  });
}

test("LeafRun intent binds repository identity without persisting the raw brief", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-leaf-intent-"));
  const projectRoot = join(sandbox, "project");
  const worktreeRoot = join(sandbox, "worktree");
  const homeDirectory = join(sandbox, "home");
  execFileSync("mkdir", ["-p", projectRoot, homeDirectory]);
  initializeRepository(projectRoot);
  execFileSync(
    "git",
    ["worktree", "add", "-q", "--detach", worktreeRoot],
    { cwd: projectRoot },
  );
  const now = () => new Date("2026-07-27T00:00:00.000Z");
  const qualificationFingerprint = "a".repeat(64);
  const resolveQualificationFingerprint = () =>
    qualificationFingerprint;
  try {
    const local = prepareLeafRun({
      projectRoot,
      homeDirectory,
      profile: "pi-glm",
      activity: "analysis",
      brief: "private bounded brief",
      qualificationFingerprint,
      now,
      randomUUID: () =>
        "11111111-1111-4111-8111-111111111111",
    });
    const linked = prepareLeafRun({
      projectRoot: worktreeRoot,
      homeDirectory,
      profile: "pi-glm",
      activity: "testing",
      brief: "second private brief",
      qualificationFingerprint,
      now,
      randomUUID: () =>
        "22222222-2222-4222-8222-222222222222",
    });

    assert.equal(local.repositoryKey, linked.repositoryKey);
    assert.match(local.briefSha256, /^[0-9a-f]{64}$/);
    assert.equal(
      local.qualificationFingerprint,
      qualificationFingerprint,
    );
    assert.equal(local.state, "prepared");
    assert.equal(local.stage, "awaiting-authorization");
    const intentPath = join(
      homeDirectory,
      ".codex-ground-control",
      "leaf-runs",
      local.repositoryKey,
      local.intentId,
      "intent.json",
    );
    const persisted = readFileSync(intentPath, "utf8");
    assert.equal(persisted.includes("private bounded brief"), false);
    assert.equal(persisted.includes(local.briefSha256), true);

    let spawnCount = 0;
    await assert.rejects(
      startLeafRun({
        projectRoot,
        homeDirectory,
        intentId: local.intentId,
        brief: "private bounded brief",
        now,
        resolveQualificationFingerprint,
        spawnWorker: async () => {
          spawnCount += 1;
          return { pid: 999 };
        },
      }),
      (error) =>
        error.code === "LEAF_RUN_AUTHORIZATION_REQUIRED",
    );
    assert.equal(spawnCount, 0);

    const started = await startLeafRun({
      projectRoot,
      homeDirectory,
      intentId: local.intentId,
      brief: "private bounded brief",
      now,
      resolveQualificationFingerprint,
      randomUUID: () =>
        "33333333-3333-4333-8333-333333333333",
      authorization: {
        source: "codex-host-permission",
      },
      spawnWorker: async (job) => {
        spawnCount += 1;
        assert.match(
          readFileSync(
            join(dirname(intentPath), "events.jsonl"),
            "utf8",
          ),
          /"type":"run\.started"/,
        );
        assert.equal(job.brief, "private bounded brief");
        assert.equal(job.profile, "pi-glm");
        assert.equal(job.activity, "analysis");
        return { pid: 1234 };
      },
    });
    assert.equal(started.state, "running");
    assert.equal(started.stage, "provider-execution");
    assert.equal(started.runIdentity, "33333333-3333-4333-8333-333333333333");
    assert.equal(spawnCount, 1);
    const persistedStart = JSON.parse(
      readFileSync(
        join(dirname(intentPath), "start.json"),
        "utf8",
      ),
    );
    assert.deepEqual(persistedStart.authorization, {
      source: "codex-host-permission",
      acceptedAt: "2026-07-27T00:00:00.000Z",
      reusable: false,
    });

    const retried = await startLeafRun({
      projectRoot,
      homeDirectory,
      intentId: local.intentId,
      brief: "private bounded brief",
      now,
      resolveQualificationFingerprint,
      spawnWorker: async () => {
        spawnCount += 1;
        return { pid: 5678 };
      },
    });
    assert.equal(retried.runIdentity, started.runIdentity);
    assert.equal(spawnCount, 1);
    assert.equal(
      inspectLeafRun({
        projectRoot: worktreeRoot,
        homeDirectory,
        intentId: local.intentId,
      }).state,
      "running",
    );
    assert.throws(
      () =>
        completeLeafRun({
          projectRoot,
          homeDirectory,
          intentId: local.intentId,
          runIdentity: started.runIdentity,
          terminalState: "passed",
          runtimeUsage: {
            schemaVersion: "1",
            source: "pi-message-end",
            status: "reported",
            inputTokens: 1,
            outputTokens: 1,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 999,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          receipt:
            "~/.codex-ground-control/evidence/providers/receipt/evidence-index.json",
          now,
        }),
      (error) => error.code === "LEAF_RUN_RESULT_INVALID",
    );
    const finished = completeLeafRun({
      projectRoot,
      homeDirectory,
      intentId: local.intentId,
      runIdentity: started.runIdentity,
      terminalState: "passed",
      runtimeUsage: {
        schemaVersion: "1",
        source: "pi-message-end",
        status: "unknown",
      },
      receipt:
        "~/.codex-ground-control/evidence/providers/receipt/evidence-index.json",
      now: () => new Date("2026-07-27T00:00:05.000Z"),
    });
    assert.equal(finished.state, "passed");
    assert.equal(finished.stage, "evidence-ready");
    assert.equal(finished.durationMs, 5_000);
    await assert.rejects(
      startLeafRun({
        projectRoot,
        homeDirectory,
        intentId: local.intentId,
        brief: "different brief",
        now,
        resolveQualificationFingerprint,
        authorization: {
          source: "codex-host-permission",
        },
        spawnWorker: async () => ({ pid: 1 }),
      }),
      (error) => error.code === "LEAF_RUN_BRIEF_MISMATCH",
    );
    await assert.rejects(
      startLeafRun({
        projectRoot,
        homeDirectory,
        intentId: linked.intentId,
        brief: "second private brief",
        now: () => new Date("2026-07-27T00:11:00.000Z"),
        resolveQualificationFingerprint,
        authorization: {
          source: "codex-host-permission",
        },
        spawnWorker: async () => ({ pid: 1 }),
      }),
      (error) => error.code === "LEAF_RUN_INTENT_EXPIRED",
    );

    const eventLog = readFileSync(
      join(dirname(intentPath), "events.jsonl"),
      "utf8",
    );
    assert.equal(eventLog.includes("private bounded brief"), false);
    assert.match(eventLog, /"type":"intent\.prepared"/);
    assert.match(eventLog, /"type":"authorization\.accepted"/);
    assert.match(
      eventLog,
      /"source":"codex-host-permission"/,
    );
    assert.match(eventLog, /"type":"run\.started"/);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("MCP App localizes the in-task LeafRun card without changing tool safety metadata", () => {
  const definitions = groundControlToolDefinitions("zh-CN");
  const selfTest = definitions.find(
    ({ name }) => name === "qualify_app_surface",
  );
  const prepare = definitions.find(
    ({ name }) => name === "prepare_leaf_run",
  );
  const start = definitions.find(
    ({ name }) => name === "start_leaf_run",
  );
  const inspect = definitions.find(
    ({ name }) => name === "get_leaf_run",
  );

  assert.ok(selfTest);
  assert.equal(selfTest.title, "验证 App 界面");
  assert.equal(
    selfTest.meta.ui.resourceUri,
    GROUND_CONTROL_WIDGET_URI,
  );
  assert.deepEqual(
    selfTest.meta.ui.visibility,
    ["model", "app"],
  );
  assert.equal(
    selfTest.meta["openai/widgetAccessible"],
    true,
  );
  assert.deepEqual(selfTest.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.equal(prepare.meta.ui.resourceUri, GROUND_CONTROL_WIDGET_URI);
  assert.equal(
    prepare.meta["openai/toolInvocation/invoking"],
    "正在准备 Pi 叶节点…",
  );
  assert.deepEqual(start.meta.ui.visibility, ["app"]);
  assert.equal(
    start.meta["openai/widgetAccessible"],
    true,
  );
  assert.deepEqual(start.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
    idempotentHint: true,
  });
  assert.match(
    start.description,
    /Codex Host 权限策略/,
  );
  assert.equal(
    start.meta["openai/toolInvocation/invoking"],
    "正在应用 Codex 权限…",
  );
  assert.deepEqual(inspect.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.equal(
    inspect.meta["openai/widgetAccessible"],
    true,
  );
  assert.equal(
    GROUND_CONTROL_WIDGET_URI,
    "ui://codex-ground-control/v0.2/leaf-run.html",
  );

  const widget = readGroundControlWidget();
  assert.match(widget, /text\/html;profile=mcp-app/);
  assert.match(widget, /ui\/notifications\/tool-result/);
  assert.match(widget, /tools\/call/);
  assert.match(widget, /qualify_app_surface/);
  assert.match(widget, /App 界面隔离自检/);
  assert.match(widget, /重新运行隔离自检/);
  assert.match(widget, /Provider 启动：0/);
  assert.match(widget, /App surface self-test/);
  assert.match(widget, /Repeat isolated self-test/);
  assert.match(widget, /Provider starts: 0/);
  assert.match(widget, /window\.openai\.locale/);
  assert.match(widget, /hostContext\?\.locale/);
  assert.match(
    widget,
    /ui\/notifications\/host-context-changed/,
  );
  assert.match(widget, /let bridgeReady = false/);
  assert.match(widget, /event\.source !== window\.parent/);
  assert.match(
    widget,
    /ui\/notifications\/size-changed/,
  );
  assert.match(widget, /ResizeObserver/);
  assert.ok(
    widget.indexOf("if (bridgeReady)") <
      widget.indexOf(
        'typeof window.openai.callTool === "function"',
      ),
  );
  assert.match(widget, /start_leaf_run/);
  assert.match(widget, /Start with Codex permissions/);
  assert.match(widget, /get_leaf_run/);
  assert.match(widget, /stageLabel: "Stage"/);
  assert.equal(widget.includes("innerHTML ="), false);

  const englishDefinitions =
    groundControlToolDefinitions("en-US");
  const englishSelfTest = englishDefinitions.find(
    ({ name }) => name === "qualify_app_surface",
  );
  const englishStart = englishDefinitions.find(
    ({ name }) => name === "start_leaf_run",
  );
  assert.equal(
    englishSelfTest.title,
    "Qualify App Surface",
  );
  assert.match(
    englishStart.description,
    /Codex host permission policy/i,
  );
});

test("MCP App repeat self-test uses the available Host tool-call capability", async () => {
  const {
    compatibilityCalls,
    elements,
    hostMessages,
  } = await exerciseWidgetRepeatButton();

  assert.equal(compatibilityCalls.length, 1);
  assert.equal(
    compatibilityCalls[0].name,
    "qualify_app_surface",
  );
  assert.equal(
    compatibilityCalls[0].args.locale,
    "zh-CN",
  );
  assert.equal(
    hostMessages.some(
      ({ method }) => method === "tools/call",
    ),
    false,
  );
  assert.equal(elements.state.textContent, "已验证");
  assert.equal(elements.start.disabled, false);
});

test("npm artifact carries the local Ground Control plugin manifest", () => {
  const plugin = JSON.parse(
    readFileSync(
      join(repositoryRoot, ".codex-plugin", "plugin.json"),
      "utf8",
    ),
  );
  const mcp = JSON.parse(
    readFileSync(join(repositoryRoot, ".mcp.json"), "utf8"),
  );
  assert.equal(plugin.name, "codex-ground-control");
  assert.equal(plugin.version, "0.2.0");
  assert.equal(plugin.mcpServers, "./.mcp.json");
  assert.equal(plugin.skills, "./assets/overlays/");
  assert.deepEqual(
    mcp.mcpServers["codex-ground-control"].args,
    ["src/mcp-app-server.js"],
  );
  assert.equal(
    mcp.mcpServers["codex-ground-control"].cwd,
    ".",
  );
  assert.equal(
    existsSync(
      join(
        repositoryRoot,
        "assets",
        "apps",
        "ground-control",
        "leaf-run.html",
      ),
    ),
    true,
  );
});

test("MCP App main guard accepts a symlinked package path", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-mcp-main-"));
  const linkedEntry = join(sandbox, "mcp-app-server.js");
  const entry = join(
    repositoryRoot,
    "src",
    "mcp-app-server.js",
  );
  try {
    symlinkSync(entry, linkedEntry);
    assert.equal(
      isMainModule(
        new URL(
          "../src/mcp-app-server.js",
          import.meta.url,
        ),
        linkedEntry,
      ),
      true,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("App surface self-test exercises host elicitation with zero production starts", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-app-surface-"));
  const homeDirectory = join(sandbox, "home");
  const decisions = [
    {
      response: {
        action: "accept",
        content: { confirm: true },
      },
      state: "passed",
      stage: "host-elicitation-accepted",
      reason: null,
      action: "accept",
      confirmed: true,
    },
    {
      response: { action: "decline" },
      state: "blocked",
      stage: "host-elicitation-declined",
      reason: "host-elicitation-declined",
      action: "decline",
      confirmed: false,
    },
    {
      response: { action: "cancel" },
      state: "blocked",
      stage: "host-elicitation-cancelled",
      reason: "host-elicitation-cancelled",
      action: "cancel",
      confirmed: false,
    },
    {
      response: {
        action: "accept",
        content: { confirm: false },
      },
      state: "blocked",
      stage: "host-confirmation-not-affirmed",
      reason: "host-confirmation-not-affirmed",
      action: "accept",
      confirmed: false,
    },
    {
      response: new Error("fixture host failure"),
      state: "blocked",
      stage: "host-elicitation-error",
      reason: "host-elicitation-error",
      action: "error",
      confirmed: false,
    },
  ];
  let decisionIndex = 0;
  let productionOperationCalls = 0;
  const failIfProductionOperationRuns = () => {
    productionOperationCalls += 1;
    throw new Error(
      "App surface self-test must not touch production operations.",
    );
  };
  const server = createGroundControlMcpServer({
    homeDirectory,
    operations: {
      resolveCurrentProviderQualification:
        failIfProductionOperationRuns,
      prepareLeafRun: failIfProductionOperationRuns,
      startLeafRun: failIfProductionOperationRuns,
      inspectLeafRun: failIfProductionOperationRuns,
    },
  });
  const client = new Client(
    { name: "app-surface-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request) => {
      assert.equal(request.params.mode, "form");
      assert.match(
        request.params.message,
        /不会启动 Pi 或任何 Provider/,
      );
      assert.equal(
        request.params.message.includes("--allow-live"),
        true,
      );
      assert.equal(
        request.params.requestedSchema.properties.confirm.title,
        "运行隔离 App 界面自检",
      );
      assert.match(
        request.params.requestedSchema.properties.confirm.description,
        /不能授权或启动 live 执行/,
      );
      const response = decisions[decisionIndex].response;
      if (response instanceof Error) {
        throw response;
      }
      return response;
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const listed = await client.listTools();
    const selfTest = listed.tools.find(
      ({ name }) => name === "qualify_app_surface",
    );
    assert.ok(selfTest);
    assert.equal(selfTest.outputSchema.type, "object");
    assert.deepEqual(
      selfTest._meta.ui.visibility,
      ["model", "app"],
    );
    assert.equal(selfTest.annotations.readOnlyHint, true);
    assert.equal(selfTest.annotations.openWorldHint, false);
    const resource = await client.readResource({
      uri: GROUND_CONTROL_WIDGET_URI,
    });
    assert.equal(
      resource.contents[0].mimeType,
      "text/html;profile=mcp-app",
    );
    assert.equal(
      resource.contents[0]._meta["openai/widgetDescription"],
      "Ground Control App 界面资格验证与受限 Pi LeafRun 状态卡。",
    );

    for (
      decisionIndex = 0;
      decisionIndex < decisions.length;
      decisionIndex += 1
    ) {
      const expected = decisions[decisionIndex];
      const result = await client.callTool({
        name: "qualify_app_surface",
        arguments: {},
      });
      assert.equal(result.structuredContent.state, expected.state);
      assert.equal(result.structuredContent.stage, expected.stage);
      assert.equal(result.structuredContent.reason, expected.reason);
      assert.deepEqual(
        result.structuredContent.hostElicitation,
        {
          supported: true,
          action: expected.action,
          confirmed: expected.confirmed,
        },
      );
      assert.deepEqual(
        result.structuredContent.isolation,
        {
          providerStarts: 0,
          workerStarts: 0,
          networkRequests: 0,
          productionIntentCreated: false,
          liveAuthorizationGranted: false,
        },
      );
      assert.match(
        result.content[0].text,
        /Pi、Provider、worker 和网络启动均为 0/,
      );
      assert.equal(productionOperationCalls, 0);
    }
    assert.equal(
      existsSync(join(homeDirectory, ".codex-ground-control")),
      false,
    );
  } finally {
    await client.close();
    await server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("App surface self-test preserves English when the host requests an English locale", async () => {
  const server = createGroundControlMcpServer();
  const client = new Client(
    {
      name: "app-surface-english-locale-test",
      version: "1.0.0",
    },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(
    ElicitRequestSchema,
    async (request) => {
      assert.match(
        request.params.message,
        /never starts Pi or any Provider/i,
      );
      assert.equal(
        request.params.requestedSchema.properties.confirm.title,
        "Exercise the isolated App surface",
      );
      return {
        action: "accept",
        content: { confirm: true },
      };
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.callTool({
      name: "qualify_app_surface",
      arguments: {},
      _meta: {
        "openai/locale": "en-US",
      },
    });
    assert.equal(result.structuredContent.state, "passed");
    assert.match(
      result.content[0].text,
      /Pi, Provider, worker, and network starts remain zero/i,
    );
  } finally {
    await client.close();
    await server.close();
  }
});

test("App surface self-test blocks safely when host elicitation is unavailable", async () => {
  let productionOperationCalls = 0;
  const failIfProductionOperationRuns = () => {
    productionOperationCalls += 1;
    throw new Error(
      "Unavailable self-test must not touch production operations.",
    );
  };
  const server = createGroundControlMcpServer({
    operations: {
      resolveCurrentProviderQualification:
        failIfProductionOperationRuns,
      prepareLeafRun: failIfProductionOperationRuns,
      startLeafRun: failIfProductionOperationRuns,
      inspectLeafRun: failIfProductionOperationRuns,
    },
  });
  const client = new Client(
    {
      name: "app-surface-no-elicitation-test",
      version: "1.0.0",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.callTool({
      name: "qualify_app_surface",
      arguments: {},
    });
    assert.equal(result.structuredContent.state, "blocked");
    assert.equal(
      result.structuredContent.stage,
      "host-elicitation-unavailable",
    );
    assert.deepEqual(
      result.structuredContent.hostElicitation,
      {
        supported: false,
        action: "unavailable",
        confirmed: false,
      },
    );
    assert.equal(
      result.structuredContent.isolation.providerStarts,
      0,
    );
    assert.equal(productionOperationCalls, 0);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP App delegates live start approval to Codex host permissions without a second elicitation", async () => {
  const fingerprint = "b".repeat(64);
  const baseState = {
    schemaVersion: "1",
    intentId: "11111111-1111-4111-8111-111111111111",
    repositoryKey: "c".repeat(32),
    profile: "pi-glm",
    activity: "analysis",
    briefSha256: "d".repeat(64),
    qualificationFingerprint: fingerprint,
    preparedAt: "2026-07-27T00:00:00.000Z",
    expiresAt: "2026-07-27T00:10:00.000Z",
    state: "prepared",
  };
  let elicitationCount = 0;
  let providerStarts = 0;
  const server = createGroundControlMcpServer({
    operations: {
      resolveCurrentProviderQualification: () => ({
        providerId: "pi-glm",
        fingerprint,
        qualifiedAt: "2026-07-27T00:00:00.000Z",
      }),
      prepareLeafRun: (options) => {
        assert.equal(
          options.qualificationFingerprint,
          fingerprint,
        );
        return baseState;
      },
      startLeafRun: async (options) => {
        assert.deepEqual(options.authorization, {
          source: "codex-host-permission",
        });
        providerStarts += 1;
        return {
          ...baseState,
          reason: null,
        };
      },
      inspectLeafRun: () => baseState,
    },
  });
  const client = new Client(
    { name: "leaf-run-test", version: "1.0.0" },
    { capabilities: { elicitation: {} } },
  );
  client.setRequestHandler(
    ElicitRequestSchema,
    async () => {
      elicitationCount += 1;
      throw new Error(
        "start_leaf_run must not create a second permission prompt",
      );
    },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const listed = await client.listTools();
    const start = listed.tools.find(
      ({ name }) => name === "start_leaf_run",
    );
    assert.deepEqual(start._meta.ui.visibility, ["app"]);
    assert.equal(start.annotations.readOnlyHint, false);
    assert.equal(start.annotations.openWorldHint, true);
    assert.equal(start.annotations.idempotentHint, true);
    const resource = await client.readResource({
      uri: GROUND_CONTROL_WIDGET_URI,
    });
    assert.equal(
      resource.contents[0].mimeType,
      "text/html;profile=mcp-app",
    );

    const prepared = await client.callTool({
      name: "prepare_leaf_run",
      arguments: {
        projectRoot: "/fixture/project",
        profile: "pi-glm",
        activity: "analysis",
        brief: "private bounded brief",
      },
    });
    assert.equal(
      prepared.structuredContent.intentId,
      baseState.intentId,
    );
    assert.equal(
      prepared._meta.leafRun.brief,
      "private bounded brief",
    );

    const accepted = await client.callTool({
      name: "start_leaf_run",
      arguments: {
        projectRoot: "/fixture/project",
        intentId: baseState.intentId,
        brief: "private bounded brief",
      },
    });
    assert.equal(elicitationCount, 0);
    assert.equal(providerStarts, 1);
    assert.equal(accepted.structuredContent.reason, null);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP App does not require elicitation capability after Codex dispatches an approved start", async () => {
  const intent = {
    schemaVersion: "1",
    intentId: "11111111-1111-4111-8111-111111111111",
    repositoryKey: "c".repeat(32),
    profile: "pi-glm",
    activity: "analysis",
    briefSha256: "d".repeat(64),
    qualificationFingerprint: "b".repeat(64),
    preparedAt: "2026-07-27T00:00:00.000Z",
    expiresAt: "2026-07-27T00:10:00.000Z",
    state: "prepared",
    stage: "awaiting-authorization",
  };
  let providerStarts = 0;
  const server = createGroundControlMcpServer({
    operations: {
      startLeafRun: async (options) => {
        assert.deepEqual(options.authorization, {
          source: "codex-host-permission",
        });
        providerStarts += 1;
        return {
          ...intent,
          reason: null,
        };
      },
    },
  });
  const client = new Client(
    {
      name: "leaf-run-no-elicitation-test",
      version: "1.0.0",
    },
    { capabilities: {} },
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const result = await client.callTool({
      name: "start_leaf_run",
      arguments: {
        projectRoot: "/fixture/project",
        intentId: intent.intentId,
        brief: "private bounded brief",
      },
    });
    assert.equal(providerStarts, 1);
    assert.equal(result.structuredContent.reason, null);
  } finally {
    await client.close();
    await server.close();
  }
});

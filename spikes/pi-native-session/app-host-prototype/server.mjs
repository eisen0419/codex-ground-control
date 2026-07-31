#!/usr/bin/env node

import {
  readFileSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export const PROTOTYPE_WIDGET_URI =
  "ui://codex-ground-control/v0.3-spike/native-session-card.html";

const FIXTURE_URL = new URL("./fixture.json", import.meta.url);
const WIDGET_URL = new URL("./widget.html", import.meta.url);
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function readPrototypeSnapshot() {
  return clone(JSON.parse(readFileSync(FIXTURE_URL, "utf8")));
}

export function readPrototypeWidget() {
  return readFileSync(WIDGET_URL, "utf8");
}

export function prototypeToolDefinitions() {
  return [
    {
      name: "inspect_leaf_prototype",
      title: "检查 v0.3 叶任务快照",
      description:
        "只读返回已通过 live probe 的脱敏 Pi native-session 终态，不启动任何运行时。",
      annotations: READ_ONLY_ANNOTATIONS,
      meta: {
        ui: {
          visibility: ["model"],
        },
        "openai/toolInvocation/invoking": "正在读取脱敏叶任务快照…",
        "openai/toolInvocation/invoked": "叶任务快照已读取",
      },
    },
    {
      name: "render_leaf_card_prototype",
      title: "显示 v0.3 叶任务状态卡",
      description:
        "在 Codex App 中显示与 inspect_leaf_prototype 完全相同的脱敏 Pi native-session 终态。",
      annotations: READ_ONLY_ANNOTATIONS,
      meta: {
        ui: {
          resourceUri: PROTOTYPE_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "openai/outputTemplate": PROTOTYPE_WIDGET_URI,
        "openai/widgetAccessible": false,
        "openai/toolInvocation/invoking": "正在生成叶任务状态卡…",
        "openai/toolInvocation/invoked": "叶任务状态卡已生成",
      },
    },
  ];
}

function snapshotResult() {
  const structuredContent = readPrototypeSnapshot();
  return {
    content: [
      {
        type: "text",
        text:
          "这是已审计 live probe 的只读终态。Pi native session 已在 agent_start 后被精确取消，兄弟会话保持可响应。",
      },
    ],
    structuredContent,
  };
}

export function createPrototypeMcpServer() {
  const server = new McpServer(
    {
      name: "codex-ground-control-v0-3-host-spike",
      version: "0.3.0-alpha.1",
    },
    {
      instructions:
        "Render one immutable, sanitized Pi native-session result. This prototype never starts Pi, calls a Provider, writes a repository, or performs network access.",
    },
  );

  registerAppResource(
    server,
    "Ground Control v0.3 Pi native-session 状态卡",
    PROTOTYPE_WIDGET_URI,
    {
      description:
        "只读显示加固版 Pi live probe 的脱敏终态。",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: PROTOTYPE_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readPrototypeWidget(),
          _meta: {
            "openai/widgetDescription":
              "Ground Control v0.3 外部 Pi native-session 只读状态卡。",
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
          },
        },
      ],
    }),
  );

  for (const definition of prototypeToolDefinitions()) {
    registerAppTool(
      server,
      definition.name,
      {
        title: definition.title,
        description: definition.description,
        inputSchema: {},
        annotations: definition.annotations,
        _meta: definition.meta,
      },
      async () => snapshotResult(),
    );
  }

  return server;
}

export async function runPrototypeMcpServer() {
  const server = createPrototypeMcpServer();
  await server.connect(new StdioServerTransport());
}

export function isMainModule(
  moduleUrl,
  scriptArgument = process.argv[1],
) {
  if (!scriptArgument) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) ===
      realpathSync(scriptArgument)
    );
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  runPrototypeMcpServer().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );
    process.exitCode = 1;
  });
}

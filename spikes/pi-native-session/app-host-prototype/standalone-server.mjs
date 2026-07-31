#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";

const PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const LATEST_PROTOCOL_VERSION = "2025-11-25";
const WIDGET_URI =
  "ui://codex-ground-control/v0.3-spike/native-session-card.html";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const FIXTURE_URL = new URL("./fixture.json", import.meta.url);
const WIDGET_URL = new URL("./widget.html", import.meta.url);
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
const RESOURCE_UI = Object.freeze({
  prefersBorder: true,
  csp: {
    connectDomains: [],
    resourceDomains: [],
  },
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot() {
  return clone(JSON.parse(readFileSync(FIXTURE_URL, "utf8")));
}

function toolDefinitions() {
  return [
    {
      name: "inspect_leaf_prototype",
      title: "检查 v0.3 叶任务快照",
      description:
        "只读返回已通过 live probe 的脱敏 Pi native-session 终态，不启动任何运行时。",
      inputSchema: {
        type: "object",
        properties: {},
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      annotations: READ_ONLY_ANNOTATIONS,
      execution: {
        taskSupport: "forbidden",
      },
      _meta: {
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
      inputSchema: {
        type: "object",
        properties: {},
        $schema: "http://json-schema.org/draft-07/schema#",
      },
      annotations: READ_ONLY_ANNOTATIONS,
      execution: {
        taskSupport: "forbidden",
      },
      _meta: {
        ui: {
          resourceUri: WIDGET_URI,
          visibility: ["model", "app"],
        },
        "ui/resourceUri": WIDGET_URI,
        "openai/outputTemplate": WIDGET_URI,
        "openai/widgetAccessible": false,
        "openai/toolInvocation/invoking": "正在生成叶任务状态卡…",
        "openai/toolInvocation/invoked": "叶任务状态卡已生成",
      },
    },
  ];
}

function resourceContents() {
  return {
    contents: [
      {
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE,
        text: readFileSync(WIDGET_URL, "utf8"),
        _meta: {
          "openai/widgetDescription":
            "Ground Control v0.3 外部 Pi native-session 只读状态卡。",
          ui: RESOURCE_UI,
        },
      },
    ],
  };
}

function toolResult() {
  return {
    content: [
      {
        type: "text",
        text:
          "这是已审计 live probe 的只读终态。Pi native session 已在 agent_start 后被精确取消，兄弟会话保持可响应。",
      },
    ],
    structuredContent: snapshot(),
  };
}

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    result,
  });
}

function reject(id, code, message) {
  writeMessage({
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  });
}

function handleRequest(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    const requested = params?.protocolVersion;
    respond(id, {
      protocolVersion: PROTOCOL_VERSIONS.has(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION,
      capabilities: {
        resources: {
          listChanged: true,
        },
        tools: {
          listChanged: true,
        },
      },
      serverInfo: {
        name: "codex-ground-control-v0-3-host-spike",
        version: "0.3.0-alpha.1",
      },
      instructions:
        "Render one immutable, sanitized Pi native-session result. This prototype never starts Pi, calls a Provider, writes a repository, or performs network access.",
    });
    return;
  }
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, {
      tools: toolDefinitions(),
    });
    return;
  }
  if (method === "tools/call") {
    if (
      params?.name !== "inspect_leaf_prototype" &&
      params?.name !== "render_leaf_card_prototype"
    ) {
      reject(id, -32602, `Tool ${String(params?.name)} not found`);
      return;
    }
    respond(id, toolResult());
    return;
  }
  if (method === "resources/list") {
    respond(id, {
      resources: [
        {
          uri: WIDGET_URI,
          name: "Ground Control v0.3 Pi native-session 状态卡",
          description:
            "只读显示加固版 Pi live probe 的脱敏终态。",
          mimeType: RESOURCE_MIME_TYPE,
          _meta: {
            ui: RESOURCE_UI,
          },
        },
      ],
    });
    return;
  }
  if (method === "resources/templates/list") {
    respond(id, {
      resourceTemplates: [],
    });
    return;
  }
  if (method === "resources/read") {
    if (params?.uri !== WIDGET_URI) {
      reject(
        id,
        -32602,
        `Resource ${String(params?.uri)} not found`,
      );
      return;
    }
    respond(id, resourceContents());
    return;
  }
  if (id !== undefined) {
    reject(id, -32601, `Method ${String(method)} not found`);
  }
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});
lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    reject(null, -32700, "Parse error");
    return;
  }
  if (message?.method === "notifications/initialized") {
    return;
  }
  handleRequest(message);
});

#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const CODEX_BIN =
  process.env.CODEX_APP_SERVER_BIN ?? "codex";
const PROJECT_ROOT = realpathSync(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const MCP_SERVER = "ground-control-v0-3-host-spike";
const MCP_TOOL = "render_leaf_card_prototype";
const TASK_NAME =
  "Ground Control v0.3 App host 卡片验收";

const child = spawn(
  CODEX_BIN,
  ["app-server", "--listen", "stdio://"],
  {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  },
);

const pending = new Map();
const notifications = [];
let nextId = 0;
let stderr = "";

function send(payload) {
  child.stdin.write(`${JSON.stringify(payload)}\n`);
}

function request(method, params) {
  const id = ++nextId;
  send({ id, method, params });
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
  });
}

const outputLines = createInterface({
  input: child.stdout,
  crlfDelay: Infinity,
});
outputLines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id !== undefined && pending.has(message.id)) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      entry.reject(
        new Error(
          `${entry.method}: ${message.error.message ?? "request failed"}`,
        ),
      );
    } else {
      entry.resolve(message.result);
    }
    return;
  }
  if (message.method) {
    notifications.push(message);
  }
});

child.stderr.on("data", (chunk) => {
  stderr += chunk.toString("utf8");
});

child.on("exit", (code, signal) => {
  if (pending.size === 0) {
    return;
  }
  const reason =
    `Codex app-server exited before replying: ` +
    `code=${String(code)} signal=${String(signal)}`;
  for (const { reject } of pending.values()) {
    reject(new Error(reason));
  }
  pending.clear();
});

try {
  await request("initialize", {
    clientInfo: {
      name: "ground-control-v0-3-host-probe",
      version: "0.3.0-alpha.1",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  send({ method: "initialized", params: {} });

  const started = await request("thread/start", {
    cwd: PROJECT_ROOT,
    approvalPolicy: "never",
    sandbox: "read-only",
    environments: [],
    ephemeral: false,
    historyMode: "paginated",
    experimentalRawEvents: false,
  });
  const threadId = started.thread.id;

  await request("thread/name/set", {
    threadId,
    name: TASK_NAME,
  });
  await request("thread/inject_items", {
    threadId,
    items: [
      {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text:
              "只调用本地只读 render_leaf_card_prototype，验收真实 Codex App host 卡片；不启动 Pi、不联网、不使用 --allow-live。",
          },
        ],
      },
    ],
  });

  const status = await request("mcpServerStatus/list", {
    threadId,
    detail: "full",
  });
  const target = status.data.find(
    ({ name }) => name === MCP_SERVER,
  );
  if (!target) {
    throw new Error(
      `Fresh task did not load MCP server ${MCP_SERVER}.`,
    );
  }
  if (!Object.hasOwn(target.tools, MCP_TOOL)) {
    throw new Error(
      `Fresh task did not expose tool ${MCP_TOOL}.`,
    );
  }
  const descriptor = target.tools[MCP_TOOL];
  if (
    descriptor.annotations?.readOnlyHint !== true ||
    descriptor.annotations?.openWorldHint !== false
  ) {
    throw new Error(
      "Fresh task loaded unsafe tool annotations.",
    );
  }

  const result = await request("mcpServer/tool/call", {
    threadId,
    server: MCP_SERVER,
    tool: MCP_TOOL,
    arguments: {},
  });
  if (result.isError === true) {
    throw new Error("The App-host render tool returned an error.");
  }
  if (
    result.structuredContent?.kind !==
      "provider-native-leaf-card" ||
    result.structuredContent?.card?.state !== "cancelled"
  ) {
    throw new Error(
      "The App-host render tool returned an unexpected state.",
    );
  }

  const observedCallEnd = notifications.find(
    ({ method, params }) =>
      method === "mcpServer/toolCallCompleted" &&
      params?.threadId === threadId,
  );

  console.log(
    JSON.stringify(
      {
        state: "tool-call-passed",
        threadId,
        taskName: TASK_NAME,
        server: MCP_SERVER,
        tool: MCP_TOOL,
        annotations: {
          readOnlyHint:
            descriptor.annotations.readOnlyHint,
          destructiveHint:
            descriptor.annotations.destructiveHint,
          openWorldHint:
            descriptor.annotations.openWorldHint,
          idempotentHint:
            descriptor.annotations.idempotentHint,
        },
        cardState: result.structuredContent.card.state,
        latestEvent:
          result.structuredContent.card.latestEvent.type,
        evidenceSha256:
          result.structuredContent.proof
            .sourceEvidenceSha256,
        modelTurnStarted: false,
        piStarted: false,
        allowLiveUsed: false,
        appServerCompletionObserved:
          Boolean(observedCallEnd),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (stderr.trim()) {
    console.error(stderr.trim());
  }
  throw error;
} finally {
  child.stdin.end();
  child.kill("SIGTERM");
}

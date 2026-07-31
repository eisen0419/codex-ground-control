#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
  requireExclusiveMcpToolCall,
} from "./host-evidence.mjs";

const CODEX_BIN =
  process.env.CODEX_APP_SERVER_BIN ?? "codex";
const PROJECT_ROOT = realpathSync(
  fileURLToPath(new URL("../../..", import.meta.url)),
);
const REQUESTED_THREAD_ID = process.argv[2] ?? null;
const TARGET_SERVER = "ground-control-v0-3-host-spike";
const TARGET_TOOL = "render_leaf_card_prototype";
const TASK_NAME =
  "Ground Control v0.3 alpha.1 真实 Host 验收";

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

function waitForNotification(predicate, timeoutMs = 180000) {
  const existing = notifications.find(predicate);
  if (existing) {
    return Promise.resolve(existing);
  }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(() => {
      const match = notifications.find(predicate);
      if (match) {
        clearInterval(timer);
        resolve(match);
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for Codex turn completion."));
      }
    }, 50);
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
      name: "ground-control-v0-3-host-turn",
      version: "0.3.0-alpha.1",
    },
    capabilities: {
      experimentalApi: true,
    },
  });
  send({ method: "initialized", params: {} });

  const session = REQUESTED_THREAD_ID
    ? await request("thread/resume", {
        threadId: REQUESTED_THREAD_ID,
        cwd: PROJECT_ROOT,
        approvalPolicy: "never",
        sandbox: "read-only",
        excludeTurns: true,
      })
    : await request("thread/start", {
        cwd: PROJECT_ROOT,
        approvalPolicy: "never",
        sandbox: "read-only",
        environments: [],
        ephemeral: false,
        historyMode: "paginated",
        experimentalRawEvents: false,
      });
  const thread = session.thread;
  const threadId = thread.id;

  if (!REQUESTED_THREAD_ID) {
    await request("thread/name/set", {
      threadId,
      name: TASK_NAME,
    });
  }

  const started = await request("turn/start", {
    threadId,
    input: [
      {
        type: "text",
        text:
          "这是 Ground Control v0.3 alpha.1 的真实 Codex App Host 验收。只调用 app-host-prototype 中的 render_leaf_card_prototype 一次，并让 Codex App 显示返回的状态卡。不要调用其他业务工具；不要启动 Pi、Provider 或 worker，不要使用 --allow-live。允许本模型回合使用 Codex 控制面联网，但候选插件、Pi 和 Provider 必须保持零网络。",
      },
    ],
    approvalPolicy: "never",
    sandboxPolicy: {
      type: "readOnly",
      networkAccess: false,
    },
    environments: [],
    collaborationMode: {
      mode: "default",
      settings: {
        model: session.model,
        reasoning_effort: "low",
        developer_instructions:
          "You are a deterministic Codex App host acceptance executor. " +
          "Call exactly one business tool: " +
          "mcp__ground_control_v0_3_host_spike__render_leaf_card_prototype " +
          "with an empty object. Do not use shell, browser, web, memory, " +
          "files, Pi, Provider, worker, or any other business tool. " +
          "Do not request or use --allow-live. After the card result, " +
          "briefly report its state and stop.",
      },
    },
  });
  const turnId = started.turn.id;

  const completed = await waitForNotification(
    ({ method, params }) =>
      method === "turn/completed" &&
      params?.threadId === threadId &&
      params?.turn?.id === turnId,
  );

  const turn = completed.params.turn;
  if (turn.status !== "completed") {
    throw new Error(
      `Codex host turn ended with status ${String(turn.status)}.`,
    );
  }
  requireExclusiveMcpToolCall(notifications, {
    threadId,
    turnId,
    server: TARGET_SERVER,
    tool: TARGET_TOOL,
  });

  console.log(
    JSON.stringify(
      {
        state: "turn-and-tool-call-completed",
        threadId,
        taskName:
          REQUESTED_THREAD_ID ? null : TASK_NAME,
        freshTaskCreated: !REQUESTED_THREAD_ID,
        turnId,
        turnStatus: turn.status,
        server: TARGET_SERVER,
        requestedTool: TARGET_TOOL,
        exclusiveToolCallObserved: true,
        sandbox: "read-only",
        codexControlPlaneNetworkAuthorized: true,
        pluginNetworkAllowed: false,
        piStarted: false,
        allowLiveUsed: false,
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

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  startPiRpcSession,
} from "../spikes/pi-native-session/pi-rpc-session.mjs";
import {
  createPiInvocation,
} from "../spikes/pi-native-session/pi-invocation.mjs";

const fixture = fileURLToPath(
  new URL("./fixtures/pi-rpc-fixture.mjs", import.meta.url),
);

test("live Pi invocation keeps provider-native auth while isolating session state", () => {
  const invocation = createPiInvocation({
    allowLive: true,
    root: "/tmp/live-root",
    sessionId: "00000000-0000-4000-8000-000000000310",
    environment: {
      PATH: "/usr/bin",
      HOME: "/Users/provider",
      PI_CODING_AGENT_DIR: "/Users/provider/.pi/agent",
      ZAI_CODING_CN_API_KEY: "profile-secret",
      DEEPSEEK_API_KEY: "other-profile-secret",
      UNRELATED_SECRET: "must-not-cross",
    },
  });

  assert.equal(invocation.env.PATH, "/usr/bin");
  assert.equal(invocation.env.HOME, "/Users/provider");
  assert.equal(
    invocation.env.PI_CODING_AGENT_DIR,
    "/Users/provider/.pi/agent",
  );
  assert.equal(
    invocation.env.ZAI_CODING_CN_API_KEY,
    "profile-secret",
  );
  assert.equal(
    Object.hasOwn(invocation.env, "DEEPSEEK_API_KEY"),
    false,
  );
  assert.equal(
    Object.hasOwn(invocation.env, "UNRELATED_SECRET"),
    false,
  );
  assert.equal(
    invocation.env.PI_CODING_AGENT_SESSION_DIR,
    "/tmp/live-root/sessions",
  );
  assert.equal(invocation.env.PI_TELEMETRY, "0");
  assert.equal(Object.hasOwn(invocation.env, "PI_OFFLINE"), false);
  assert.equal(invocation.args.includes("--no-tools"), true);
  assert.equal(invocation.args.includes("--offline"), false);
});

test("offline Pi invocation isolates auth and forbids network", () => {
  const invocation = createPiInvocation({
    allowLive: false,
    root: "/tmp/offline-root",
    sessionId: "00000000-0000-4000-8000-000000000309",
    environment: {
      PATH: "/usr/bin",
      HOME: "/Users/provider",
      PI_CODING_AGENT_DIR: "/Users/provider/.pi/agent",
      ZAI_CODING_CN_API_KEY: "must-not-cross",
      UNRELATED_SECRET: "must-not-cross",
    },
  });

  assert.equal(invocation.env.PATH, "/usr/bin");
  assert.equal(invocation.env.HOME, "/tmp/offline-root");
  assert.equal(
    invocation.env.PI_CODING_AGENT_DIR,
    "/tmp/offline-root/agent",
  );
  assert.equal(
    invocation.env.PI_CODING_AGENT_SESSION_DIR,
    "/tmp/offline-root/sessions",
  );
  assert.equal(invocation.env.PI_OFFLINE, "1");
  assert.equal(
    Object.hasOwn(invocation.env, "ZAI_CODING_CN_API_KEY"),
    false,
  );
  assert.equal(
    Object.hasOwn(invocation.env, "UNRELATED_SECRET"),
    false,
  );
  assert.equal(invocation.args.includes("--no-tools"), true);
  assert.equal(invocation.args.includes("--offline"), true);
});

test("Pi RPC receives only the caller-supplied environment", async () => {
  const variable = "PI_RPC_AMBIENT_SECRET_FOR_TEST";
  const previous = process.env[variable];
  process.env[variable] = "must-not-cross";
  let session;

  try {
    session = await startPiRpcSession({
      command: process.execPath,
      commandArgs: [fixture],
      cwd: process.cwd(),
      provider: "zai-coding-cn",
      model: "glm-5.2",
      sessionId: "00000000-0000-4000-8000-000000000308",
      env: {
        PI_RPC_ALLOWED_MARKER: "allowed",
      },
    });
    const state = await session.getState();
    assert.equal(state.ambientSecretPresent, false);
    assert.equal(state.allowedMarkerPresent, true);
  } finally {
    await session?.stop();
    if (previous === undefined) {
      delete process.env[variable];
    } else {
      process.env[variable] = previous;
    }
  }
});

test("Pi RPC failures never expose Provider stderr or raw error text", async () => {
  const secret = "provider-secret-must-not-leak";
  const session = await startPiRpcSession({
    command: process.execPath,
    commandArgs: [fixture],
    cwd: process.cwd(),
    provider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000307",
    env: {
      PI_RPC_FIXTURE_PROMPT_FAILURE_SECRET: secret,
    },
  });

  try {
    await assert.rejects(
      session.prompt("bounded fixture prompt"),
      (error) =>
        error?.code === "PI_RPC_PROCESS_FAILED" &&
        !error.message.includes(secret),
    );
  } finally {
    await session.stop();
  }
});

test("Pi RPC exact abort leaves a sibling native session responsive", async () => {
  const active = await startPiRpcSession({
    command: process.execPath,
    commandArgs: [fixture],
    cwd: process.cwd(),
    provider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000311",
  });
  const sibling = await startPiRpcSession({
    command: process.execPath,
    commandArgs: [fixture],
    cwd: process.cwd(),
    provider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000312",
  });

  try {
    assert.equal(
      (await active.getState()).sessionId,
      active.nativeSessionRef.sessionId,
    );
    assert.equal(
      (await sibling.getState()).sessionId,
      sibling.nativeSessionRef.sessionId,
    );

    await active.prompt("bounded fixture prompt");
    await active.waitForEvent(
      (event) => event.type === "agent_start",
    );
    await active.abort(active.nativeSessionRef);
    await active.waitForEvent(
      (event) => event.type === "agent_settled",
    );

    assert.deepEqual(
      {
        sessionId: (await active.getState()).sessionId,
        isStreaming: (await active.getState()).isStreaming,
        abortCount: (await active.getState()).abortCount,
      },
      {
        sessionId:
          "00000000-0000-4000-8000-000000000311",
        isStreaming: false,
        abortCount: 1,
      },
    );
    assert.deepEqual(
      {
        sessionId: (await sibling.getState()).sessionId,
        isStreaming: (await sibling.getState()).isStreaming,
        abortCount: (await sibling.getState()).abortCount,
      },
      {
        sessionId:
          "00000000-0000-4000-8000-000000000312",
        isStreaming: false,
        abortCount: 0,
      },
    );
  } finally {
    await Promise.all([active.stop(), sibling.stop()]);
  }
});

test("Pi RPC rejects a stale process incarnation before sending abort", async () => {
  const session = await startPiRpcSession({
    command: process.execPath,
    commandArgs: [fixture],
    cwd: process.cwd(),
    provider: "zai-coding-cn",
    model: "glm-5.2",
    sessionId: "00000000-0000-4000-8000-000000000313",
  });

  try {
    await session.prompt("bounded fixture prompt");
    await session.waitForEvent(
      (event) => event.type === "agent_start",
    );
    await assert.rejects(
      session.abort({
        ...session.nativeSessionRef,
        processIncarnation: "stale-incarnation",
      }),
      (error) =>
        error?.code === "LEAF_SESSION_IDENTITY_MISMATCH",
    );
    assert.equal((await session.getState()).abortCount, 0);
    assert.equal((await session.getState()).isStreaming, true);
  } finally {
    await session.stop();
  }
});

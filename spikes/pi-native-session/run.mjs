import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyPiEvent,
  createLeafTask,
  requestExactCancellation,
  toAppCard,
} from "./leaf-session-contract.mjs";
import { createPiInvocation } from "./pi-invocation.mjs";
import { startPiRpcSession } from "./pi-rpc-session.mjs";

const argumentsList = process.argv.slice(2);
const allowLive = argumentsList.includes("--allow-live");
const evidenceIndex = argumentsList.indexOf("--evidence");
const evidencePath =
  evidenceIndex >= 0
    ? argumentsList[evidenceIndex + 1]
    : null;
if (evidenceIndex >= 0 && !evidencePath) {
  throw new Error("--evidence requires an explicit path.");
}

const provider = "zai-coding-cn";
const model = "glm-5.2";
const profile = "pi-glm";
const command = process.env.PI_SPIKE_BIN ?? "pi";
const temporaryRoot = mkdtempSync(
  join(tmpdir(), "cgc-pi-native-session-"),
);
const activeRoot = join(temporaryRoot, "active");
const siblingRoot = join(temporaryRoot, "sibling");
mkdirSync(activeRoot, { recursive: true, mode: 0o700 });
mkdirSync(siblingRoot, { recursive: true, mode: 0o700 });

function isolatedOptions(root, sessionId, offline) {
  const invocation = createPiInvocation({
    allowLive: !offline,
    root,
    sessionId,
    environment: process.env,
  });
  const sessionDirectory = invocation.sessionDirectory;
  mkdirSync(sessionDirectory, {
    recursive: true,
    mode: 0o700,
  });
  return {
    command,
    cwd: process.cwd(),
    provider,
    model,
    sessionId,
    env: invocation.env,
    args: invocation.args,
  };
}

function publicSession(session) {
  return {
    adapterId: session.nativeSessionRef.adapterId,
    provider: session.nativeSessionRef.provider,
    modelProvider:
      session.nativeSessionRef.modelProvider,
    model: session.nativeSessionRef.model,
    sessionId: session.nativeSessionRef.sessionId,
  };
}

function printEvidence(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

let active;
let sibling;
let finalEvidence;
try {
  active = await startPiRpcSession(
    isolatedOptions(
      activeRoot,
      randomUUID(),
      !allowLive,
    ),
  );
  sibling = await startPiRpcSession(
    isolatedOptions(
      siblingRoot,
      randomUUID(),
      true,
    ),
  );
  const activeState = await active.getState();
  const siblingState = await sibling.getState();
  if (
    activeState.sessionId !==
      active.nativeSessionRef.sessionId ||
    siblingState.sessionId !==
      sibling.nativeSessionRef.sessionId
  ) {
    throw new Error(
      "Pi RPC returned an unexpected native session ID.",
    );
  }

  let leafTask = createLeafTask({
    taskId: randomUUID(),
    profile,
    activity: "testing",
    nativeSessionRef: active.nativeSessionRef,
  });
  const startingCard = toAppCard(leafTask);
  printEvidence({
    kind: "card",
    card: startingCard,
  });

  if (!allowLive) {
    finalEvidence = {
      schemaVersion: "0.3-spike",
      mode: "offline",
      state: "passed",
      checks: {
        activeSessionIdentity: true,
        siblingSessionIdentity: true,
        rpcProcessesStarted: 2,
        providerNativeTurnStarts: 0,
        modelRequests: 0,
        networkPolicy: "pi-offline",
      },
      active: publicSession(active),
      sibling: publicSession(sibling),
      card: startingCard,
      nextAction:
        "Run the same command with --allow-live for the one-shot event and cancellation probe.",
    };
  } else {
    await active.prompt(
      "Ground Control v0.3 cancellation spike. Begin a short response; no tools are available.",
    );
    const started = await active.waitForEvent(
      (event) => event.type === "agent_start",
      30000,
    );
    leafTask = applyPiEvent(leafTask, {
      nativeSessionRef: active.nativeSessionRef,
      observedAt: new Date().toISOString(),
      event: started,
    });
    const runningCard = toAppCard(leafTask);
    printEvidence({
      kind: "card",
      card: runningCard,
    });

    leafTask = requestExactCancellation(leafTask, {
      taskId: leafTask.taskId,
      nativeSessionRef: active.nativeSessionRef,
      observedAt: new Date().toISOString(),
    });
    await active.abort(active.nativeSessionRef);
    const settled = await active.waitForEvent(
      (event) => event.type === "agent_settled",
      30000,
    );
    leafTask = applyPiEvent(leafTask, {
      nativeSessionRef: active.nativeSessionRef,
      observedAt: new Date().toISOString(),
      event: settled,
    });
    const cancelledCard = toAppCard(leafTask);
    printEvidence({
      kind: "card",
      card: cancelledCard,
    });

    const activeAfter = await active.getState();
    const siblingAfter = await sibling.getState();
    const checks = {
      nativeSessionIdentity:
        activeAfter.sessionId ===
        active.nativeSessionRef.sessionId,
      providerNativeStartObserved:
        runningCard.latestEvent?.type === "turn.started",
      runningCardObserved:
        runningCard.state === "running" &&
        runningCard.canCancel,
      exactAbortAccepted:
        activeAfter.isStreaming === false,
      matchingCancellationSettled:
        cancelledCard.state === "cancelled" &&
        cancelledCard.latestEvent?.type ===
          "turn.cancelled",
      siblingStillResponsive:
        siblingAfter.sessionId ===
          sibling.nativeSessionRef.sessionId &&
        siblingAfter.isStreaming === false,
    };
    finalEvidence = {
      schemaVersion: "0.3-spike",
      mode: "live",
      state: Object.values(checks).every(Boolean)
        ? "passed"
        : "failed",
      checks,
      active: publicSession(active),
      sibling: publicSession(sibling),
      cards: {
        starting: startingCard,
        running: runningCard,
        cancelled: cancelledCard,
      },
    };
  }

  printEvidence({
    kind: "summary",
    evidence: finalEvidence,
  });
  if (evidencePath) {
    writeFileSync(
      evidencePath,
      `${JSON.stringify(finalEvidence, null, 2)}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );
  }
  if (finalEvidence.state !== "passed") {
    process.exitCode = 1;
  }
} finally {
  await Promise.allSettled([
    active?.stop(),
    sibling?.stop(),
  ]);
  rmSync(temporaryRoot, {
    recursive: true,
    force: true,
  });
}

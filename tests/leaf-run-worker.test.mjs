import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeLeafRunJob,
} from "../src/leaf-run-worker-core.js";

const fingerprint = "a".repeat(64);
const job = Object.freeze({
  schemaVersion: "1",
  projectRoot: "/fixture/project",
  homeDirectory: "/fixture/home",
  intentId: "11111111-1111-4111-8111-111111111111",
  runIdentity: "22222222-2222-4222-8222-222222222222",
  profile: "pi-glm",
  activity: "analysis",
  brief: "bounded private brief",
  qualificationFingerprint: fingerprint,
});
const runtimeUsage = Object.freeze({
  schemaVersion: "1",
  source: "pi-message-end",
  status: "reported",
  inputTokens: 10,
  outputTokens: 2,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  totalTokens: 16,
  cost: {
    input: 0.1,
    output: 0.2,
    cacheRead: 0.03,
    cacheWrite: 0.01,
    total: 0.34,
  },
});

test("LeafRun worker preserves exact usage and expected qualification", async () => {
  let completion;
  const outcome = await executeLeafRunJob(job, {
    resolveCurrentProviderQualification: () => ({
      providerId: "pi-glm",
      fingerprint,
      qualifiedAt: "2026-07-27T00:00:00.000Z",
    }),
    runProviderOperation: (options) => {
      assert.equal(options.allowLive, true);
      assert.equal(options.prompt, job.brief);
      assert.equal(
        options.expectedQualificationFingerprint,
        fingerprint,
      );
      return {
        result: {
          execution: {
            terminalState: "succeeded",
            runtimeUsage,
            evidence: {
              index:
                "~/.codex-ground-control/evidence/receipt.json",
            },
          },
        },
      };
    },
    completeLeafRun: (value) => {
      completion = value;
      return value;
    },
  });

  assert.equal(outcome.terminalState, "passed");
  assert.equal(completion.runtimeUsage, runtimeUsage);
  assert.equal(
    completion.receipt,
    "~/.codex-ground-control/evidence/receipt.json",
  );
});

test("LeafRun worker blocks qualification drift before provider start", async () => {
  let providerStarts = 0;
  let completion;
  const outcome = await executeLeafRunJob(job, {
    resolveCurrentProviderQualification: () => ({
      providerId: "pi-glm",
      fingerprint: "b".repeat(64),
      qualifiedAt: "2026-07-27T00:01:00.000Z",
    }),
    runProviderOperation: () => {
      providerStarts += 1;
      throw new Error("provider must not start");
    },
    completeLeafRun: (value) => {
      completion = value;
      return value;
    },
  });

  assert.equal(providerStarts, 0);
  assert.equal(outcome.terminalState, "blocked");
  assert.equal(
    completion.reason,
    "LEAF_RUN_QUALIFICATION_DRIFTED",
  );
  assert.deepEqual(completion.runtimeUsage, {
    schemaVersion: "1",
    source: "pi-message-end",
    status: "unknown",
  });
});

test("LeafRun worker does not retry a failed terminal-state write", async () => {
  let completionWrites = 0;
  await assert.rejects(
    executeLeafRunJob(job, {
      resolveCurrentProviderQualification: () => ({
        providerId: "pi-glm",
        fingerprint,
        qualifiedAt: "2026-07-27T00:00:00.000Z",
      }),
      runProviderOperation: () => ({
        result: {
          execution: {
            terminalState: "succeeded",
            runtimeUsage,
            evidence: {
              index:
                "~/.codex-ground-control/evidence/receipt.json",
            },
          },
        },
      }),
      completeLeafRun: () => {
        completionWrites += 1;
        throw new Error("terminal state write failed");
      },
    }),
    /terminal state write failed/,
  );
  assert.equal(completionWrites, 1);
});

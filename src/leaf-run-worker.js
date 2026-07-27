#!/usr/bin/env node

import { executeLeafRunJob } from "./leaf-run-worker-core.js";

const MAX_JOB_BYTES = 32 * 1024;

function validJob(job) {
  return (
    job &&
    job.schemaVersion === "1" &&
    typeof job.projectRoot === "string" &&
    job.projectRoot !== "" &&
    typeof job.homeDirectory === "string" &&
    job.homeDirectory !== "" &&
    typeof job.intentId === "string" &&
    typeof job.runIdentity === "string" &&
    ["pi-glm", "pi-deepseek", "pi-minimax"].includes(
      job.profile,
    ) &&
    ["analysis", "exploration", "testing", "review"].includes(
      job.activity,
    ) &&
    typeof job.brief === "string" &&
    job.brief.trim() !== "" &&
    Buffer.byteLength(job.brief, "utf8") <= 8 * 1024 &&
    typeof job.qualificationFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(
      job.qualificationFingerprint,
    )
  );
}

async function readJob() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_JOB_BYTES) {
      throw new Error("LeafRun worker job is too large.");
    }
    chunks.push(chunk);
  }
  const parsed = JSON.parse(
    Buffer.concat(chunks).toString("utf8"),
  );
  if (!validJob(parsed)) {
    throw new Error("LeafRun worker job is invalid.");
  }
  return parsed;
}

async function main() {
  const job = await readJob();
  await executeLeafRunJob(job);
}

main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validAgySourceRules,
  verifyAgySourceObservation,
} from "./agy-source-verifier.mjs";

const providerId = process.argv[2];
const prompt = process.argv[3];
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

let record;
try {
  const catalog = JSON.parse(
    readFileSync(
      join(fixtureDirectory, "public-probes-v1.json"),
      "utf8",
    ),
  );
  record = catalog.providers?.agy;
} catch {
  fail("AGY public research contract is unavailable.");
}

if (
  providerId !== "agy" ||
  !record ||
  prompt !== record.prompt
) {
  fail("AGY public research prompt is not approved.");
}
if (
  record.contract?.kind !== "search" ||
  record.contract.model !== "gemini-3.6-flash-high" ||
  record.contract.mode !== "sandboxed-plan-google" ||
  !validAgySourceRules(record.sourceRules)
) {
  fail("AGY public research contract is invalid.");
}

const workspace = resolve(process.cwd());
if (readdirSync(workspace).length !== 0) {
  fail("AGY public research workspace is not empty.");
}
const startedAt = Date.now();
const result = spawnSync(
  "agy",
  [
    "--sandbox",
    "--mode",
    "plan",
    "--model",
    record.contract.model,
    "--print-timeout",
    "2m",
    "--print",
    prompt,
  ],
  {
    cwd: workspace,
    encoding: "utf8",
    env: process.env,
    shell: false,
    timeout: 110_000,
    maxBuffer: 65_536,
  },
);

if (readdirSync(workspace).length !== 0) {
  fail("AGY public research modified its isolated workspace.");
}
if (result.status !== 0 || result.signal || result.error) {
  fail("AGY public research failed.");
}

let output;
try {
  output = JSON.parse(result.stdout.trim());
} catch {
  fail("AGY public research returned invalid JSON.");
}
if (
  !exactKeys(output, [
    "schemaVersion",
    "provider",
    "probe",
    "ok",
    "source",
  ]) ||
  output.schemaVersion !== "1" ||
  output.provider !== "agy" ||
  output.probe !== "public-sources-v1" ||
  output.ok !== true
) {
  fail("AGY public research returned an invalid observation.");
}

let verification;
try {
  verification = await verifyAgySourceObservation(
    output.source,
    record.sourceRules,
    { startedAt },
  );
} catch {
  fail("AGY public research source observation was not verified.");
}

process.stdout.write(
  `${JSON.stringify({ ...output, verification })}\n`,
);

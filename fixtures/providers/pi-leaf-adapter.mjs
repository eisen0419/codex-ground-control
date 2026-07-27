import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const profileId = process.argv[2];
const envelopeText = process.argv[3];
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const activities = new Set([
  "analysis",
  "exploration",
  "testing",
  "review",
]);

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

let catalog;
let envelope;
try {
  catalog = JSON.parse(
    readFileSync(
      join(fixtureDirectory, "public-probes-v1.json"),
      "utf8",
    ),
  );
  envelope = JSON.parse(envelopeText);
} catch {
  fail("Pi leaf input contract is invalid.");
}

const record = catalog.providers?.[profileId];
if (
  process.argv.length !== 4 ||
  !record ||
  record.contract?.kind !== "model" ||
  typeof record.contract.provider !== "string" ||
  typeof record.contract.model !== "string" ||
  !exactKeys(envelope, ["schemaVersion", "activity", "brief"]) ||
  envelope.schemaVersion !== "1" ||
  !activities.has(envelope.activity) ||
  typeof envelope.brief !== "string" ||
  envelope.brief.trim() === "" ||
  Buffer.byteLength(envelope.brief, "utf8") > 3072
) {
  fail("Pi leaf input contract is invalid.");
}

const expectedOutput = {
  schemaVersion: "1",
  profile: profileId,
  provider: record.contract.provider,
  model: record.contract.model,
  activity: envelope.activity,
  disposition: "candidate-evidence",
  completionAuthority: "codex-main",
  summary: "string",
  findings: ["string"],
  suggestedChecks: ["string"],
};
const prompt = [
  `Bounded activity: ${envelope.activity}.`,
  "Analyze only the supplied brief. Do not claim task completion.",
  "Return exactly one raw JSON object with this shape and fixed identity fields:",
  JSON.stringify(expectedOutput),
  "summary must be a string; findings and suggestedChecks must be arrays of strings.",
  `Brief: ${envelope.brief}`,
].join("\n");
const isolatedHome = join(process.cwd(), ".pi-home");
mkdirSync(isolatedHome, { mode: 0o700 });
let result;
try {
  result = spawnSync(
    "pi",
    [
      "--provider",
      record.contract.provider,
      "--model",
      record.contract.model,
      "--thinking",
      "medium",
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--system-prompt",
      "You are a bounded leaf model with no execution authority. Return exactly one raw JSON object with no Markdown or prose. Your output is candidate evidence for codex-main, never a completion decision.",
      "--mode",
      "json",
      "--print",
      prompt,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: isolatedHome,
        PI_CODING_AGENT_DIR: join(isolatedHome, "agent"),
        PI_CODING_AGENT_SESSION_DIR: join(
          isolatedHome,
          "sessions",
        ),
        PI_TELEMETRY: "0",
      },
      shell: false,
      timeout: 110000,
      maxBuffer: 65536,
    },
  );
} finally {
  rmSync(isolatedHome, { recursive: true, force: true });
}

if (result.status !== 0 || result.signal || result.error) {
  fail("Pi leaf execution failed.");
}

const events = [];
for (const line of result.stdout.split(/\r?\n/)) {
  if (!line.trim()) {
    continue;
  }
  try {
    events.push(JSON.parse(line));
  } catch {
    fail("Pi leaf returned an invalid event stream.");
  }
}
const assistantEvents = events.filter(
  (event) =>
    event?.type === "message_end" &&
    event.message?.role === "assistant",
);
if (assistantEvents.length !== 1) {
  fail("Pi leaf returned no unique assistant result.");
}
const message = assistantEvents[0].message;
if (
  message.provider !== record.contract.provider ||
  message.model !== record.contract.model
) {
  fail("Pi leaf runtime identity did not match the requested profile.");
}
const textBlocks = Array.isArray(message.content)
  ? message.content.filter((content) => content?.type === "text")
  : [];
if (
  message.stopReason !== "stop" ||
  !Array.isArray(message.content) ||
  message.content.some(
    (content) =>
      content?.type !== "text" &&
      content?.type !== "thinking",
  ) ||
  textBlocks.length !== 1 ||
  typeof textBlocks[0].text !== "string"
) {
  fail("Pi leaf returned no unique text result.");
}

let candidate;
try {
  candidate = JSON.parse(textBlocks[0].text);
} catch {
  fail("Pi leaf candidate is not valid JSON.");
}
if (
  !exactKeys(candidate, [
    "schemaVersion",
    "profile",
    "provider",
    "model",
    "activity",
    "disposition",
    "completionAuthority",
    "summary",
    "findings",
    "suggestedChecks",
  ]) ||
  candidate.schemaVersion !== "1" ||
  candidate.profile !== profileId ||
  candidate.provider !== record.contract.provider ||
  candidate.model !== record.contract.model ||
  candidate.activity !== envelope.activity ||
  candidate.disposition !== "candidate-evidence" ||
  candidate.completionAuthority !== "codex-main" ||
  typeof candidate.summary !== "string" ||
  !Array.isArray(candidate.findings) ||
  candidate.findings.some((value) => typeof value !== "string") ||
  !Array.isArray(candidate.suggestedChecks) ||
  candidate.suggestedChecks.some(
    (value) => typeof value !== "string",
  )
) {
  fail("Pi leaf candidate contract is invalid.");
}

function nonnegativeFinite(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function runtimeUsage(usage) {
  if (usage === undefined) {
    return {
      schemaVersion: "1",
      source: "pi-message-end",
      status: "unknown",
    };
  }
  if (
    !exactKeys(usage, [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "totalTokens",
      "cost",
    ]) ||
    !exactKeys(usage.cost, [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ]) ||
    ![
      usage.input,
      usage.output,
      usage.cacheRead,
      usage.cacheWrite,
      usage.totalTokens,
      usage.cost.input,
      usage.cost.output,
      usage.cost.cacheRead,
      usage.cost.cacheWrite,
      usage.cost.total,
    ].every(nonnegativeFinite) ||
    usage.totalTokens !==
      usage.input +
        usage.output +
        usage.cacheRead +
        usage.cacheWrite
  ) {
    fail("Pi leaf runtime usage contract is invalid.");
  }
  return {
    schemaVersion: "1",
    source: "pi-message-end",
    status: "reported",
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    cacheWriteTokens: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: usage.cost,
  };
}

process.stdout.write(
  `${JSON.stringify({
    schemaVersion: "1",
    candidate,
    runtimeUsage: runtimeUsage(message.usage),
  })}\n`,
);

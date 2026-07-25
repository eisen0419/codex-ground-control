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
      "text",
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
process.stdout.write(result.stdout);

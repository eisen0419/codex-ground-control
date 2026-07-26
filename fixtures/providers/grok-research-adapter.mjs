import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectFile } from "../../src/safe-files.js";

const providerId = process.argv[2];
const prompt = process.argv[3];
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const schemaPath = fileURLToPath(
  new URL(
    "../../schemas/provider/grok-live-probe-output.schema.json",
    import.meta.url,
  ),
);
const envelopeKeys = new Set([
  "text",
  "stopReason",
  "sessionId",
  "requestId",
  "thought",
  "structuredOutput",
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

function validGrokSourceRules(rules) {
  return (
    exactKeys(rules, [
      "allowedUrls",
      "allowedIdentities",
      "urlIdentityMap",
      "maxObservationAgeMilliseconds",
      "maxFutureSkewMilliseconds",
      "redirectsAllowed",
      "tools",
      "privateContextAllowed",
    ]) &&
    Array.isArray(rules.allowedUrls) &&
    rules.allowedUrls.length === 2 &&
    rules.allowedUrls[0] === "https://x.com/xai" &&
    rules.allowedUrls[1] === "https://x.com/SpaceXAI" &&
    Array.isArray(rules.allowedIdentities) &&
    rules.allowedIdentities.length === 2 &&
    rules.allowedIdentities[0] === "@xai" &&
    rules.allowedIdentities[1] === "@spacexai" &&
    exactKeys(rules.urlIdentityMap, rules.allowedUrls) &&
    rules.urlIdentityMap["https://x.com/xai"] === "@xai" &&
    rules.urlIdentityMap["https://x.com/SpaceXAI"] === "@spacexai" &&
    rules.maxObservationAgeMilliseconds === 3_600_000 &&
    rules.maxFutureSkewMilliseconds === 300_000 &&
    rules.redirectsAllowed === false &&
    Array.isArray(rules.tools) &&
    rules.tools.length === 2 &&
    rules.tools[0] === "web_search" &&
    rules.tools[1] === "web_fetch" &&
    rules.privateContextAllowed === false
  );
}

function outputMatches(value, rules, startedAt) {
  const source = value?.source;
  const observedAt = Date.parse(source?.observedAt);
  const now = Date.now();
  return (
    exactKeys(value, [
      "schemaVersion",
      "provider",
      "probe",
      "ok",
      "source",
    ]) &&
    value.schemaVersion === "1" &&
    value.provider === "grok" &&
    value.probe === "public-sources-v1" &&
    value.ok === true &&
    exactKeys(source, ["url", "identity", "observedAt"]) &&
    rules.allowedUrls.includes(source.url) &&
    rules.allowedIdentities.includes(source.identity) &&
    rules.urlIdentityMap[source.url] === source.identity &&
    Number.isFinite(observedAt) &&
    source.observedAt === new Date(observedAt).toISOString() &&
    observedAt >= startedAt - 300_000 &&
    observedAt <= now + rules.maxFutureSkewMilliseconds &&
    now - observedAt <= rules.maxObservationAgeMilliseconds
  );
}

function parseObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed !== null &&
      !Array.isArray(parsed) &&
      typeof parsed === "object"
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function extractOutput(stdout, rules, startedAt) {
  const envelope = parseObject(stdout.trim());
  if (!envelope) {
    return null;
  }
  if (outputMatches(envelope, rules, startedAt)) {
    return envelope;
  }
  if (
    Object.keys(envelope).some((key) => !envelopeKeys.has(key))
  ) {
    return null;
  }
  let output = null;
  if (Object.hasOwn(envelope, "structuredOutput")) {
    if (
      Object.hasOwn(envelope, "text") &&
      (typeof envelope.text !== "string" ||
        envelope.text.trim() !== "")
    ) {
      return null;
    }
    output =
      envelope.structuredOutput !== null &&
      !Array.isArray(envelope.structuredOutput) &&
      typeof envelope.structuredOutput === "object"
        ? envelope.structuredOutput
        : null;
  } else if (typeof envelope.text === "string") {
    output = parseObject(envelope.text.trim());
  }
  return outputMatches(output, rules, startedAt)
    ? output
    : null;
}

let record;
let schema;
try {
  const catalog = JSON.parse(
    readFileSync(
      join(fixtureDirectory, "public-probes-v1.json"),
      "utf8",
    ),
  );
  record = catalog.providers?.grok;
  schema = JSON.parse(readFileSync(schemaPath, "utf8"));
} catch {
  fail("Grok public research contract is unavailable.");
}

if (
  process.argv.length !== 4 ||
  providerId !== "grok" ||
  !record ||
  prompt !== record.prompt
) {
  fail("Grok public research prompt is not approved.");
}
if (
  record.contract?.kind !== "search" ||
  record.contract.model !== "grok-4.5" ||
  record.contract.mode !== "web-only" ||
  !validGrokSourceRules(record.sourceRules) ||
  !exactKeys(schema, [
    "$schema",
    "$id",
    "title",
    "type",
    "additionalProperties",
    "required",
    "properties",
  ])
) {
  fail("Grok public research contract is invalid.");
}

const workspace = resolve(process.cwd());
if (readdirSync(workspace).length !== 0) {
  fail("Grok public research workspace is not empty.");
}

const runtimeRoot = join(workspace, ".grok-runtime");
const isolatedHome = join(runtimeRoot, "home");
const grokHome = join(runtimeRoot, "grok-home");

let failure = null;
let output = null;
try {
  mkdirSync(runtimeRoot, { mode: 0o700 });
  mkdirSync(isolatedHome, { mode: 0o700 });
  mkdirSync(grokHome, { mode: 0o700 });
  const sourceAuth = inspectFile(
    process.env.HOME ?? "",
    ".grok/auth.json",
  );
  if (
    sourceAuth.state !== "file" ||
    sourceAuth.contents.byteLength === 0 ||
    sourceAuth.contents.byteLength > 65_536
  ) {
    throw new Error("Grok cached authentication is unsafe.");
  }
  const targetAuth = join(grokHome, "auth.json");
  writeFileSync(targetAuth, sourceAuth.contents, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(targetAuth, 0o600);
  writeFileSync(
    join(grokHome, "config.toml"),
    [
      "[cli]",
      "auto_update = false",
      "",
      "[toolset.bash]",
      "enabled_background = false",
      "auto_background_on_timeout = false",
      "",
      "[compat.cursor]",
      "skills = false",
      "rules = false",
      "agents = false",
      "mcps = false",
      "hooks = false",
      "",
      "[compat.claude]",
      "skills = false",
      "rules = false",
      "agents = false",
      "mcps = false",
      "hooks = false",
      "",
    ].join("\n"),
    { flag: "wx", mode: 0o600 },
  );

  const environment = {
    PATH: process.env.PATH,
    HOME: isolatedHome,
    GROK_HOME: grokHome,
    GROK_MEMORY: "0",
    GROK_SUBAGENTS: "0",
    GROK_TELEMETRY_ENABLED: "0",
    GROK_FEEDBACK_ENABLED: "0",
  };
  for (const name of [
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  const startedAt = Date.now();
  const result = spawnSync(
    "grok",
    [
      "--single",
      prompt,
      "--model",
      record.contract.model,
      "--reasoning-effort",
      "medium",
      "--json-schema",
      JSON.stringify(schema),
      "--tools",
      record.sourceRules.tools.join(","),
      "--disallowed-tools",
      "Agent",
      "--no-subagents",
      "--no-memory",
      "--no-plan",
      "--verbatim",
      "--no-auto-update",
      "--sandbox",
      "strict",
    ],
    {
      cwd: workspace,
      encoding: "utf8",
      env: environment,
      shell: false,
      timeout: 110_000,
      maxBuffer: 65_536,
    },
  );
  if (result.status !== 0 || result.signal || result.error) {
    throw new Error("Grok public research failed.");
  }
  output = extractOutput(
    result.stdout,
    record.sourceRules,
    startedAt,
  );
  if (!output) {
    throw new Error(
      "Grok public research returned an invalid structured envelope.",
    );
  }
} catch (error) {
  failure =
    error instanceof Error
      ? error.message
      : "Grok public research failed.";
} finally {
  rmSync(runtimeRoot, { recursive: true, force: true });
}

if (readdirSync(workspace).length !== 0) {
  fail("Grok public research modified its isolated workspace.");
}
if (failure !== null) {
  fail(failure);
}
process.stdout.write(`${JSON.stringify(output)}\n`);

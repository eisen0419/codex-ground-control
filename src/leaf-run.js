import { spawn } from "node:child_process";
import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  providerDefinitions,
  resolveCurrentProviderQualification,
  resolveProviderProjectKey,
} from "./provider-lifecycle.js";
import {
  atomicWrite,
  collectMissingDirectories,
  inspectFile,
} from "./safe-files.js";

const LEAF_RUN_ROOT = ".codex-ground-control/leaf-runs";
const INTENT_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_BRIEF_BYTES = 8 * 1024;
const INTENT_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PI_PROFILES = new Set(
  providerDefinitions
    .filter(({ family }) => family === "pi")
    .map(({ id }) => id),
);
const PI_ACTIVITIES = new Set([
  "analysis",
  "exploration",
  "testing",
  "review",
]);
const WORKER_URL = new URL("./leaf-run-worker.js", import.meta.url);

export class LeafRunError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LeafRunError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function exactKeys(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) =>
      Object.prototype.hasOwnProperty.call(value, key)
    )
  );
}

function nonnegativeFinite(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function validRuntimeUsage(value) {
  if (
    exactKeys(value, [
      "schemaVersion",
      "source",
      "status",
    ])
  ) {
    return (
      value.schemaVersion === "1" &&
      value.source === "pi-message-end" &&
      value.status === "unknown"
    );
  }
  return (
    exactKeys(value, [
      "schemaVersion",
      "source",
      "status",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "cost",
    ]) &&
    value.schemaVersion === "1" &&
    value.source === "pi-message-end" &&
    value.status === "reported" &&
    [
      value.inputTokens,
      value.outputTokens,
      value.cacheReadTokens,
      value.cacheWriteTokens,
      value.totalTokens,
    ].every(nonnegativeFinite) &&
    value.totalTokens ===
      value.inputTokens +
        value.outputTokens +
        value.cacheReadTokens +
        value.cacheWriteTokens &&
    exactKeys(value.cost, [
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
      "total",
    ]) &&
    Object.values(value.cost).every(nonnegativeFinite)
  );
}

function validReceipt(receipt) {
  if (receipt === null) {
    return true;
  }
  const prefix =
    "~/.codex-ground-control/evidence/providers/";
  if (
    typeof receipt !== "string" ||
    !receipt.startsWith(prefix) ||
    !receipt.endsWith("/evidence-index.json")
  ) {
    return false;
  }
  return receipt
    .slice(prefix.length)
    .split("/")
    .every(
      (part) =>
        part !== "" &&
        part !== "." &&
        part !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(part),
    );
}

function isoNow(now) {
  const value = now();
  if (
    !(value instanceof Date) ||
    Number.isNaN(value.valueOf())
  ) {
    throw new LeafRunError(
      "LEAF_RUN_CLOCK_INVALID",
      "LeafRun clock did not return a valid Date.",
    );
  }
  return value.toISOString();
}

function validateIntentId(intentId) {
  if (
    typeof intentId !== "string" ||
    !INTENT_ID_PATTERN.test(intentId)
  ) {
    throw new LeafRunError(
      "LEAF_RUN_INTENT_INVALID",
      "LeafRun intent ID is invalid.",
    );
  }
}

function validateProfile(profile) {
  if (!PI_PROFILES.has(profile)) {
    throw new LeafRunError(
      "LEAF_RUN_PROFILE_INVALID",
      "LeafRun requires a supported fixed Pi profile.",
    );
  }
}

function validateActivity(activity) {
  if (!PI_ACTIVITIES.has(activity)) {
    throw new LeafRunError(
      "LEAF_RUN_ACTIVITY_INVALID",
      "LeafRun requires a supported bounded activity.",
    );
  }
}

function validateBrief(brief) {
  if (
    typeof brief !== "string" ||
    brief.trim() === "" ||
    Buffer.byteLength(brief, "utf8") > MAX_BRIEF_BYTES
  ) {
    throw new LeafRunError(
      "LEAF_RUN_BRIEF_INVALID",
      `LeafRun brief must contain at most ${MAX_BRIEF_BYTES} UTF-8 bytes.`,
    );
  }
  return sha256(Buffer.from(brief, "utf8"));
}

function validateQualificationFingerprint(fingerprint) {
  if (
    typeof fingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(fingerprint)
  ) {
    throw new LeafRunError(
      "LEAF_RUN_QUALIFICATION_INVALID",
      "LeafRun requires a current qualification fingerprint.",
    );
  }
}

function validateLiveAuthorization(authorization) {
  if (
    !exactKeys(authorization, ["source"]) ||
    authorization.source !== "codex-host-permission"
  ) {
    throw new LeafRunError(
      "LEAF_RUN_AUTHORIZATION_REQUIRED",
      "LeafRun start requires a Codex host-approved app tool invocation.",
    );
  }
  return authorization;
}

function runRelativeDirectory(repositoryKey, intentId) {
  return `${LEAF_RUN_ROOT}/${repositoryKey}/${intentId}`;
}

function runRelativePath(repositoryKey, intentId, name) {
  return `${runRelativeDirectory(repositoryKey, intentId)}/${name}`;
}

function writeNewManagedFile(
  homeDirectory,
  relativePath,
  contents,
) {
  const createdDirectories = new Set();
  atomicWrite(
    homeDirectory,
    relativePath,
    contents,
    { state: "absent" },
    createdDirectories,
    {
      expectedCreatedDirectories: new Set(
        collectMissingDirectories(homeDirectory, [relativePath]),
      ),
    },
  );
}

function writeExclusiveJson(path, value) {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1
    ) {
      throw new LeafRunError(
        "LEAF_RUN_STATE_UNSAFE",
        "LeafRun state file is not a private regular file.",
      );
    }
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readJsonFile(homeDirectory, relativePath, required) {
  const inspected = inspectFile(homeDirectory, relativePath);
  if (inspected.state === "absent") {
    if (required) {
      throw new LeafRunError(
        "LEAF_RUN_NOT_FOUND",
        "LeafRun state could not be found for this repository.",
      );
    }
    return null;
  }
  try {
    return JSON.parse(inspected.contents.toString("utf8"));
  } catch {
    throw new LeafRunError(
      "LEAF_RUN_STATE_INVALID",
      "LeafRun state is not valid JSON.",
    );
  }
}

function validateIntent(intent, repositoryKey, intentId) {
  if (
    !intent ||
    intent.schemaVersion !== "1" ||
    intent.intentId !== intentId ||
    intent.repositoryKey !== repositoryKey ||
    !PI_PROFILES.has(intent.profile) ||
    !PI_ACTIVITIES.has(intent.activity) ||
    !/^[0-9a-f]{64}$/.test(intent.briefSha256) ||
    !/^[0-9a-f]{64}$/.test(
      intent.qualificationFingerprint,
    ) ||
    Number.isNaN(Date.parse(intent.preparedAt)) ||
    Number.isNaN(Date.parse(intent.expiresAt))
  ) {
    throw new LeafRunError(
      "LEAF_RUN_STATE_INVALID",
      "LeafRun intent is invalid or belongs to another repository.",
    );
  }
  return intent;
}

function validateStart(start, intent) {
  const nativeAuthorization =
    exactKeys(start?.authorization, [
      "source",
      "acceptedAt",
      "reusable",
    ]) &&
    start.authorization.source ===
      "codex-host-permission" &&
    start.authorization.acceptedAt === start.startedAt &&
    start.authorization.reusable === false;
  const legacyAuthorization =
    exactKeys(start?.authorization, [
      "source",
      "confirmedAt",
      "reusable",
    ]) &&
    start.authorization.source === "mcp-elicitation" &&
    start.authorization.confirmedAt === start.startedAt &&
    start.authorization.reusable === false;
  if (
    !exactKeys(start, [
      "schemaVersion",
      "intentId",
      "runIdentity",
      "startedAt",
      "authorization",
    ]) ||
    start.schemaVersion !== "1" ||
    start.intentId !== intent.intentId ||
    !INTENT_ID_PATTERN.test(start.runIdentity) ||
    Number.isNaN(Date.parse(start.startedAt)) ||
    (!nativeAuthorization && !legacyAuthorization)
  ) {
    throw new LeafRunError(
      "LEAF_RUN_STATE_INVALID",
      "LeafRun start state is invalid.",
    );
  }
  return start;
}

function validateResult(result, intent, start) {
  if (
    !exactKeys(result, [
      "schemaVersion",
      "intentId",
      "runIdentity",
      "terminalState",
      "finishedAt",
      "durationMs",
      "runtimeUsage",
      "receipt",
      "reason",
    ]) ||
    result.schemaVersion !== "1" ||
    result.intentId !== intent.intentId ||
    result.runIdentity !== start.runIdentity ||
    !["passed", "failed", "blocked"].includes(
      result.terminalState,
    ) ||
    Number.isNaN(Date.parse(result.finishedAt)) ||
    !nonnegativeFinite(result.durationMs) ||
    !validRuntimeUsage(result.runtimeUsage) ||
    !validReceipt(result.receipt) ||
    !(
      result.reason === null ||
      (typeof result.reason === "string" &&
        /^[A-Z0-9][A-Z0-9._-]{0,127}$/i.test(
          result.reason,
        ))
    ) ||
    (result.terminalState === "passed" &&
      (result.receipt === null || result.reason !== null))
  ) {
    throw new LeafRunError(
      "LEAF_RUN_STATE_INVALID",
      "LeafRun result state is invalid.",
    );
  }
  return result;
}

function loadIntent({
  projectRoot,
  homeDirectory,
  intentId,
}) {
  validateIntentId(intentId);
  const repositoryKey = resolveProviderProjectKey(projectRoot);
  const intent = readJsonFile(
    homeDirectory,
    runRelativePath(repositoryKey, intentId, "intent.json"),
    true,
  );
  return {
    repositoryKey,
    intent: validateIntent(
      intent,
      repositoryKey,
      intentId,
    ),
  };
}

function appendEvent(
  homeDirectory,
  repositoryKey,
  intentId,
  event,
) {
  const relativePath = runRelativePath(
    repositoryKey,
    intentId,
    "events.jsonl",
  );
  const inspected = inspectFile(homeDirectory, relativePath);
  if (inspected.state !== "file") {
    throw new LeafRunError(
      "LEAF_RUN_STATE_INVALID",
      "LeafRun event journal is missing.",
    );
  }
  const existing = inspected.contents
    .toString("utf8")
    .split("\n")
    .filter(Boolean);
  const record = {
    schemaVersion: "1",
    sequence: existing.length + 1,
    ...event,
  };
  const path = join(homeDirectory, relativePath);
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
    );
    const metadata = fstatSync(descriptor);
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1
    ) {
      throw new LeafRunError(
        "LEAF_RUN_STATE_UNSAFE",
        "LeafRun event journal is not a private regular file.",
      );
    }
    writeFileSync(
      descriptor,
      `${JSON.stringify(record)}\n`,
    );
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function publicIntent(intent, state, extras = {}) {
  const stage =
    state === "prepared"
      ? "awaiting-authorization"
      : state === "running"
        ? "provider-execution"
        : "evidence-ready";
  return {
    schemaVersion: "1",
    intentId: intent.intentId,
    repositoryKey: intent.repositoryKey,
    profile: intent.profile,
    activity: intent.activity,
    briefSha256: intent.briefSha256,
    qualificationFingerprint:
      intent.qualificationFingerprint,
    preparedAt: intent.preparedAt,
    expiresAt: intent.expiresAt,
    state,
    stage,
    ...extras,
  };
}

function currentQualificationFingerprint(options, intent) {
  const resolver =
    options.resolveQualificationFingerprint ??
    (() =>
      resolveCurrentProviderQualification({
        projectRoot: options.projectRoot,
        homeDirectory: options.homeDirectory,
        environment: options.environment,
        providerId: intent.profile,
      }).fingerprint);
  const resolved = resolver({
    projectRoot: options.projectRoot,
    profile: intent.profile,
  });
  return typeof resolved === "string"
    ? resolved
    : resolved?.fingerprint;
}

function workerEnvironment(profile, environment) {
  const definition = providerDefinitions.find(
    ({ id }) => id === profile,
  );
  const allowed = [
    "HOME",
    "LANG",
    "LC_ALL",
    "NO_COLOR",
    "PATH",
    "TERM",
    "TMPDIR",
  ];
  const result = Object.fromEntries(
    allowed
      .filter((name) => environment[name] !== undefined)
      .map((name) => [name, environment[name]]),
  );
  for (const variable of definition.credentialVariables) {
    if (environment[variable] !== undefined) {
      result[variable] = environment[variable];
    }
  }
  return result;
}

async function spawnLeafRunWorker(job, environment) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(WORKER_URL)],
    {
      cwd: job.projectRoot,
      detached: true,
      env: workerEnvironment(job.profile, environment),
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    },
  );
  await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("spawn", resolve);
  });
  child.stdin.end(`${JSON.stringify(job)}\n`);
  child.unref();
  return { pid: child.pid };
}

export function prepareLeafRun(options = {}) {
  const projectRoot = options.projectRoot;
  const homeDirectory = options.homeDirectory ?? homedir();
  const now = options.now ?? (() => new Date());
  const uuid = options.randomUUID ?? nodeRandomUUID;
  validateProfile(options.profile);
  validateActivity(options.activity);
  const briefSha256 = validateBrief(options.brief);
  validateQualificationFingerprint(
    options.qualificationFingerprint,
  );
  const repositoryKey = resolveProviderProjectKey(projectRoot);
  const intentId = uuid();
  validateIntentId(intentId);
  const preparedAt = isoNow(now);
  const expiresAt = new Date(
    Date.parse(preparedAt) + INTENT_LIFETIME_MS,
  ).toISOString();
  const intent = {
    schemaVersion: "1",
    intentId,
    repositoryKey,
    profile: options.profile,
    activity: options.activity,
    briefSha256,
    qualificationFingerprint:
      options.qualificationFingerprint,
    preparedAt,
    expiresAt,
  };
  const intentPath = runRelativePath(
    repositoryKey,
    intentId,
    "intent.json",
  );
  writeNewManagedFile(
    homeDirectory,
    intentPath,
    `${JSON.stringify(intent, null, 2)}\n`,
  );
  writeNewManagedFile(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intentId,
      "events.jsonl",
    ),
    "",
  );
  appendEvent(
    homeDirectory,
    repositoryKey,
    intentId,
    {
      type: "intent.prepared",
      at: preparedAt,
      profile: intent.profile,
      activity: intent.activity,
      briefSha256: intent.briefSha256,
      qualificationFingerprint:
        intent.qualificationFingerprint,
      expiresAt,
    },
  );
  return publicIntent(intent, "prepared");
}

export function inspectLeafRun(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir();
  const { repositoryKey, intent } = loadIntent({
    ...options,
    homeDirectory,
  });
  const start = readJsonFile(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intent.intentId,
      "start.json",
    ),
    false,
  );
  const result = readJsonFile(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intent.intentId,
      "result.json",
    ),
    false,
  );
  const validatedStart = start
    ? validateStart(start, intent)
    : null;
  if (result) {
    if (!validatedStart) {
      throw new LeafRunError(
        "LEAF_RUN_STATE_INVALID",
        "LeafRun result has no matching start state.",
      );
    }
    const validatedResult = validateResult(
      result,
      intent,
      validatedStart,
    );
    return publicIntent(intent, result.terminalState, {
      runIdentity: validatedResult.runIdentity,
      startedAt: validatedStart.startedAt,
      finishedAt: validatedResult.finishedAt,
      durationMs: validatedResult.durationMs,
      runtimeUsage: validatedResult.runtimeUsage,
      receipt: validatedResult.receipt,
      reason: validatedResult.reason,
    });
  }
  if (validatedStart) {
    return publicIntent(intent, "running", {
      runIdentity: validatedStart.runIdentity,
      startedAt: validatedStart.startedAt,
    });
  }
  return publicIntent(intent, "prepared");
}

export async function startLeafRun(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir();
  const now = options.now ?? (() => new Date());
  const uuid = options.randomUUID ?? nodeRandomUUID;
  const { repositoryKey, intent } = loadIntent({
    ...options,
    homeDirectory,
  });
  const briefSha256 = validateBrief(options.brief);
  if (briefSha256 !== intent.briefSha256) {
    throw new LeafRunError(
      "LEAF_RUN_BRIEF_MISMATCH",
      "LeafRun brief no longer matches the prepared intent.",
    );
  }
  const existing = readJsonFile(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intent.intentId,
      "start.json",
    ),
    false,
  );
  if (existing) {
    return inspectLeafRun({
      projectRoot: options.projectRoot,
      homeDirectory,
      intentId: intent.intentId,
    });
  }
  const requestedAt = isoNow(now);
  if (
    Date.parse(requestedAt) >=
    Date.parse(intent.expiresAt)
  ) {
    throw new LeafRunError(
      "LEAF_RUN_INTENT_EXPIRED",
      "LeafRun intent expired before live authorization.",
    );
  }
  const currentFingerprint =
    currentQualificationFingerprint(options, intent);
  if (
    currentFingerprint !==
    intent.qualificationFingerprint
  ) {
    throw new LeafRunError(
      "LEAF_RUN_QUALIFICATION_DRIFTED",
      "Pi qualification changed after LeafRun preparation.",
    );
  }
  validateLiveAuthorization(options.authorization);
  const runIdentity = uuid();
  validateIntentId(runIdentity);
  const start = {
    schemaVersion: "1",
    intentId: intent.intentId,
    runIdentity,
    startedAt: requestedAt,
    authorization: {
      source: "codex-host-permission",
      acceptedAt: requestedAt,
      reusable: false,
    },
  };
  const startPath = join(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intent.intentId,
      "start.json",
    ),
  );
  try {
    writeExclusiveJson(startPath, start);
  } catch (error) {
    if (error.code === "EEXIST") {
      return inspectLeafRun({
        projectRoot: options.projectRoot,
        homeDirectory,
        intentId: intent.intentId,
      });
    }
    throw error;
  }
  appendEvent(
    homeDirectory,
    repositoryKey,
    intent.intentId,
    {
      type: "authorization.accepted",
      at: requestedAt,
      source: "codex-host-permission",
    },
  );
  appendEvent(
    homeDirectory,
    repositoryKey,
    intent.intentId,
    {
      type: "run.started",
      at: requestedAt,
      runIdentity,
    },
  );
  try {
    const spawnWorker =
      options.spawnWorker ??
      ((job) =>
        spawnLeafRunWorker(
          job,
          options.environment ?? process.env,
        ));
    await spawnWorker({
      schemaVersion: "1",
      projectRoot: options.projectRoot,
      homeDirectory,
      intentId: intent.intentId,
      runIdentity,
      profile: intent.profile,
      activity: intent.activity,
      brief: options.brief,
      qualificationFingerprint:
        intent.qualificationFingerprint,
    });
  } catch (error) {
    completeLeafRun({
      projectRoot: options.projectRoot,
      homeDirectory,
      intentId: intent.intentId,
      runIdentity,
      terminalState: "blocked",
      runtimeUsage: {
        schemaVersion: "1",
        source: "pi-message-end",
        status: "unknown",
      },
      receipt: null,
      reason: "worker-launch-failed",
      now,
    });
    return inspectLeafRun({
      projectRoot: options.projectRoot,
      homeDirectory,
      intentId: intent.intentId,
    });
  }
  return inspectLeafRun({
    projectRoot: options.projectRoot,
    homeDirectory,
    intentId: intent.intentId,
  });
}

export function completeLeafRun(options = {}) {
  const homeDirectory = options.homeDirectory ?? homedir();
  const now = options.now ?? (() => new Date());
  const { repositoryKey, intent } = loadIntent({
    ...options,
    homeDirectory,
  });
  const start = readJsonFile(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intent.intentId,
      "start.json",
    ),
    true,
  );
  if (
    start.runIdentity !== options.runIdentity ||
    !["passed", "failed", "blocked"].includes(
      options.terminalState,
    )
  ) {
    throw new LeafRunError(
      "LEAF_RUN_RESULT_INVALID",
      "LeafRun completion does not match the started run.",
    );
  }
  validateStart(start, intent);
  if (
    !validRuntimeUsage(options.runtimeUsage) ||
    !validReceipt(options.receipt ?? null) ||
    !(
      options.reason === undefined ||
      options.reason === null ||
      (typeof options.reason === "string" &&
        /^[A-Z0-9][A-Z0-9._-]{0,127}$/i.test(
          options.reason,
        ))
    ) ||
    (options.terminalState === "passed" &&
      (options.receipt == null || options.reason != null))
  ) {
    throw new LeafRunError(
      "LEAF_RUN_RESULT_INVALID",
      "LeafRun result does not satisfy the public result contract.",
    );
  }
  const finishedAt = isoNow(now);
  const result = {
    schemaVersion: "1",
    intentId: intent.intentId,
    runIdentity: start.runIdentity,
    terminalState: options.terminalState,
    finishedAt,
    durationMs: Math.max(
      0,
      Date.parse(finishedAt) - Date.parse(start.startedAt),
    ),
    runtimeUsage: options.runtimeUsage,
    receipt: options.receipt,
    reason: options.reason ?? null,
  };
  const resultPath = join(
    homeDirectory,
    runRelativePath(
      repositoryKey,
      intent.intentId,
      "result.json",
    ),
  );
  try {
    writeExclusiveJson(resultPath, result);
  } catch (error) {
    if (error.code !== "EEXIST") {
      throw error;
    }
    return inspectLeafRun({
      projectRoot: options.projectRoot,
      homeDirectory,
      intentId: intent.intentId,
    });
  }
  appendEvent(
    homeDirectory,
    repositoryKey,
    intent.intentId,
    {
      type: "run.finished",
      at: finishedAt,
      runIdentity: start.runIdentity,
      terminalState: options.terminalState,
      durationMs: result.durationMs,
      runtimeUsage: options.runtimeUsage,
      receipt: options.receipt,
      reason: result.reason,
    },
  );
  return inspectLeafRun({
    projectRoot: options.projectRoot,
    homeDirectory,
    intentId: intent.intentId,
  });
}

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  delimiter,
  dirname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, inspectFile } from "./safe-files.js";

const PROBE_CATALOG_URL = new URL(
  "../fixtures/providers/public-probes-v1.json",
  import.meta.url,
);
const PROVIDER_MANIFEST_URL = new URL(
  "../fixtures/providers/capabilities-v1.json",
  import.meta.url,
);
const PROBE_SCHEMA_URL = new URL(
  "../schemas/provider/live-probe-output.schema.json",
  import.meta.url,
);
const PROBE_ADAPTER_URL = new URL(
  "../fixtures/providers/probe-adapter.mjs",
  import.meta.url,
);
const FLEET_WORKER_URL = new URL(
  "./fleet-runner-worker.js",
  import.meta.url,
);
const FLEET_RUNNER_URL = new URL(
  "./fleet-runner.js",
  import.meta.url,
);
const PROVIDER_LIFECYCLE_URL = new URL(
  "./provider-lifecycle.js",
  import.meta.url,
);

export const providerDefinitions = Object.freeze([
  {
    id: "pi",
    command: "pi",
    credentialVariables: [
      "ZAI_CODING_CN_API_KEY",
      "DEEPSEEK_API_KEY",
      "MINIMAX_API_KEY",
    ],
  },
  {
    id: "agy",
    command: "agy",
    credentialVariables: ["GOOGLE_API_KEY", "GEMINI_API_KEY"],
  },
  {
    id: "grok",
    command: "grok",
    credentialVariables: ["XAI_API_KEY", "GROK_API_KEY"],
  },
]);

export class ProviderLifecycleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderLifecycleError";
    this.code = code;
  }
}

const VERSION_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "NODE_OPTIONS",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
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

function readJsonFile(url, label) {
  let contents;
  try {
    contents = readFileSync(url);
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_CONTRACT_INVALID",
      `${label} is unavailable.`,
    );
  }
  try {
    return {
      contents,
      value: JSON.parse(contents.toString("utf8")),
    };
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_CONTRACT_INVALID",
      `${label} is not valid JSON.`,
    );
  }
}

function executableSha256(command, environment) {
  const searchPath = environment.PATH;
  if (typeof searchPath !== "string") {
    return null;
  }
  for (const directory of searchPath.split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      const canonical = realpathSync(candidate);
      const current = lstatSync(canonical);
      if (current.isFile()) {
        return sha256(readFileSync(canonical));
      }
    } catch {
      // Continue to the next PATH entry.
    }
  }
  return null;
}

function publicVersion(provider, options) {
  const environment = {};
  for (const name of VERSION_ENVIRONMENT_KEYS) {
    if (
      Object.hasOwn(options.environment, name) &&
      options.environment[name] !== undefined
    ) {
      environment[name] = options.environment[name];
    }
  }
  const result = (options.spawn ?? spawnSync)(
    provider.command,
    ["--version"],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 5_000,
    },
  );
  if (result.error?.code === "ENOENT") {
    return { state: "missing", version: null };
  }
  if (result.error || result.status !== 0 || result.signal) {
    return { state: "incompatible", version: null };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const version = output.match(
    /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9])/m,
  )?.[1];
  const executable = version
    ? executableSha256(provider.command, environment)
    : null;
  return version && executable
    ? {
        state: "detected",
        version,
        executableSha256: executable,
      }
    : {
        state: "incompatible",
        version: null,
        executableSha256: null,
      };
}

function projectKey(projectRoot) {
  return sha256(resolve(projectRoot)).slice(0, 32);
}

function statePath(key) {
  return `.codex-ground-control/providers/${key}/state.json`;
}

function defaultState(key) {
  return {
    schemaVersion: "1",
    projectKey: key,
    providers: Object.fromEntries(
      providerDefinitions.map(({ id }) => [
        id,
        {
          enabled: false,
          qualification: null,
        },
      ]),
    ),
  };
}

function validQualification(value) {
  return (
    exactKeys(value, [
      "status",
      "runIdentity",
      "fingerprint",
      "evidenceAnchor",
      "qualifiedAt",
    ]) &&
    ["passed", "failed"].includes(value.status) &&
    typeof value.runIdentity === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9-]{0,159}$/.test(value.runIdentity) &&
    typeof value.fingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(value.fingerprint) &&
    typeof value.evidenceAnchor === "string" &&
    /^[0-9a-f]{64}$/.test(value.evidenceAnchor) &&
    typeof value.qualifiedAt === "string" &&
    !Number.isNaN(Date.parse(value.qualifiedAt))
  );
}

function readState(options) {
  const key = projectKey(options.projectRoot);
  const path = statePath(key);
  let file;
  try {
    file = inspectFile(options.homeDirectory, path);
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_UNSAFE",
      "Provider state path is unsafe.",
    );
  }
  if (file.state === "absent") {
    return {
      key,
      path,
      file,
      state: defaultState(key),
    };
  }
  let state;
  try {
    state = JSON.parse(file.contents.toString("utf8"));
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_INVALID",
      "Provider state is not valid JSON.",
    );
  }
  if (
    !exactKeys(state, ["schemaVersion", "projectKey", "providers"]) ||
    state.schemaVersion !== "1" ||
    state.projectKey !== key ||
    !exactKeys(
      state.providers,
      providerDefinitions.map(({ id }) => id),
    ) ||
    providerDefinitions.some(({ id }) => {
      const provider = state.providers[id];
      return (
        !exactKeys(provider, ["enabled", "qualification"]) ||
        typeof provider.enabled !== "boolean" ||
        (provider.qualification !== null &&
          !validQualification(provider.qualification))
      );
    })
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_INVALID",
      "Provider state has an unsupported shape.",
    );
  }
  return { key, path, file, state };
}

function writeState(options, stored, state) {
  const contents = Buffer.from(
    `${JSON.stringify(state, null, 2)}\n`,
  );
  if (
    stored.file.state === "file" &&
    stored.file.sha256 === sha256(contents)
  ) {
    return false;
  }
  try {
    atomicWrite(
      options.homeDirectory,
      stored.path,
      contents,
      stored.file,
      new Set(),
      {},
    );
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_UNSAFE",
      "Provider state could not be written safely.",
    );
  }
  return true;
}

function providerContract(provider, runtime) {
  const catalogFile = readJsonFile(
    PROBE_CATALOG_URL,
    "Provider probe catalog",
  );
  const manifestFile = readJsonFile(
    PROVIDER_MANIFEST_URL,
    "Provider capability manifest",
  );
  const schemaFile = readJsonFile(
    PROBE_SCHEMA_URL,
    "Provider probe schema",
  );
  const catalog = catalogFile.value;
  const manifest = manifestFile.value;
  const record = catalog.providers?.[provider.id];
  const adapter = manifest.adapters?.[record?.adapter];
  const outputContract =
    manifest.outputContracts?.[record?.outputContract];
  if (
    catalog.schemaVersion !== "1" ||
    catalog.probe?.id !== "public-sources-v1" ||
    catalog.probe?.visibility !== "public-only" ||
    catalog.probe?.sourceRules?.privateContextAllowed !== false ||
    !record ||
    !adapter ||
    !outputContract ||
    typeof record.prompt !== "string" ||
    record.prompt.length === 0 ||
    !Number.isInteger(record.timeoutMilliseconds)
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_CONTRACT_INVALID",
      "Provider qualification contract is invalid.",
    );
  }
  const components = {
    providerCli: sha256(
      canonicalJson({
        command: provider.command,
        version: runtime.version,
        executableSha256: runtime.executableSha256,
      }),
    ),
    adapter: sha256(
      canonicalJson({
        manifest: adapter,
        sourceSha256: sha256(readFileSync(PROBE_ADAPTER_URL)),
      }),
    ),
    fleetBoundary: sha256(
      canonicalJson({
        architecture: manifest.architecture,
        coordinator: manifest.coordinator,
        runtime: manifest.runtime,
        gates: manifest.gates,
        limits: manifest.limits,
        recursiveDelegation: manifest.recursiveDelegation,
        runnerSha256: sha256(readFileSync(FLEET_RUNNER_URL)),
        workerSha256: sha256(readFileSync(FLEET_WORKER_URL)),
      }),
    ),
    modelOrSearchContract: sha256(
      canonicalJson(record.contract),
    ),
    probe: sha256(record.prompt),
    providerLifecycle: sha256(
      readFileSync(PROVIDER_LIFECYCLE_URL),
    ),
    schema: sha256(schemaFile.contents),
    sourceRules: sha256(
      canonicalJson(catalog.probe.sourceRules),
    ),
  };
  return {
    adapter: record.adapter,
    catalog,
    components,
    fingerprint: sha256(canonicalJson(components)),
    outputContract: record.outputContract,
    prompt: record.prompt,
    timeoutMilliseconds: record.timeoutMilliseconds,
  };
}

function metadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function requirePlainDirectory(path, label) {
  const current = metadata(path);
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isDirectory()
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_EVIDENCE_UNSAFE",
      `${label} must be a plain directory.`,
    );
  }
}

function ensurePrivateDirectory(parent, name) {
  requirePlainDirectory(parent, "Provider evidence parent");
  const path = join(parent, name);
  const current = metadata(path);
  if (!current) {
    mkdirSync(path, { mode: 0o700 });
  } else if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new ProviderLifecycleError(
      "PROVIDER_EVIDENCE_UNSAFE",
      "Provider evidence path is unsafe.",
    );
  }
  return path;
}

function providerRunsRoot(options, key, providerId) {
  const home = resolve(options.homeDirectory);
  requirePlainDirectory(home, "HOME");
  const control = ensurePrivateDirectory(
    home,
    ".codex-ground-control",
  );
  const evidence = ensurePrivateDirectory(control, "evidence");
  const providers = ensurePrivateDirectory(evidence, "providers");
  const project = ensurePrivateDirectory(providers, key);
  return ensurePrivateDirectory(project, providerId);
}

function providerRunDirectory(options, key, providerId, runIdentity) {
  return join(
    resolve(options.homeDirectory),
    ".codex-ground-control",
    "evidence",
    "providers",
    key,
    providerId,
    runIdentity,
  );
}

function listEvidenceFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    })) {
      const path = join(directory, entry.name);
      const current = lstatSync(path);
      if (current.isSymbolicLink()) {
        throw new ProviderLifecycleError(
          "PROVIDER_EVIDENCE_UNSAFE",
          "Provider evidence cannot contain symlinks.",
        );
      }
      if (current.isDirectory()) {
        visit(path);
      } else if (current.isFile()) {
        files.push(path);
      } else {
        throw new ProviderLifecycleError(
          "PROVIDER_EVIDENCE_UNSAFE",
          "Provider evidence contains an unsupported entry.",
        );
      }
    }
  };
  visit(root);
  return files.sort();
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function writeExclusiveJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function writeEvidenceIndex(runDirectory, runIdentity) {
  const entries = listEvidenceFiles(runDirectory).map((path) => {
    const contents = readFileSync(path);
    return {
      path: portablePath(relative(runDirectory, path)),
      bytes: statSync(path).size,
      sha256: sha256(contents),
    };
  });
  const index = {
    schemaVersion: "1",
    runIdentity,
    algorithm: "sha256",
    entryCount: entries.length,
    entries,
  };
  const indexPath = join(runDirectory, "evidence-index.json");
  writeExclusiveJson(indexPath, index);
  return sha256(readFileSync(indexPath));
}

function evidenceIsValid(options, key, providerId, qualification) {
  try {
    const runDirectory = providerRunDirectory(
      options,
      key,
      providerId,
      qualification.runIdentity,
    );
    requirePlainDirectory(runDirectory, "Provider qualification run");
    const indexFile = inspectFile(
      runDirectory,
      "evidence-index.json",
    );
    if (
      indexFile.state !== "file" ||
      indexFile.sha256 !== qualification.evidenceAnchor
    ) {
      return false;
    }
    const index = JSON.parse(indexFile.contents.toString("utf8"));
    if (
      !exactKeys(index, [
        "schemaVersion",
        "runIdentity",
        "algorithm",
        "entryCount",
        "entries",
      ]) ||
      index.schemaVersion !== "1" ||
      index.runIdentity !== qualification.runIdentity ||
      index.algorithm !== "sha256" ||
      !Array.isArray(index.entries) ||
      index.entryCount !== index.entries.length
    ) {
      return false;
    }
    const indexed = new Set();
    for (const entry of index.entries) {
      if (
        !exactKeys(entry, ["path", "bytes", "sha256"]) ||
        typeof entry.path !== "string" ||
        entry.path.split("/").some((part) =>
          part === "" || part === "." || part === ".."
        ) ||
        !Number.isInteger(entry.bytes) ||
        !/^[0-9a-f]{64}$/.test(entry.sha256) ||
        indexed.has(entry.path)
      ) {
        return false;
      }
      const file = inspectFile(runDirectory, entry.path);
      if (
        file.state !== "file" ||
        file.contents.byteLength !== entry.bytes ||
        file.sha256 !== entry.sha256
      ) {
        return false;
      }
      indexed.add(entry.path);
    }
    const actual = listEvidenceFiles(runDirectory)
      .map((path) => portablePath(relative(runDirectory, path)))
      .filter((path) => path !== "evidence-index.json");
    if (actual.some((path) => !indexed.has(path))) {
      return false;
    }
    const summaryFile = inspectFile(
      runDirectory,
      "provider-qualification.json",
    );
    const summary = JSON.parse(
      summaryFile.contents.toString("utf8"),
    );
    return (
      summary.provider === providerId &&
      summary.runIdentity === qualification.runIdentity &&
      summary.terminalState === qualification.status &&
      summary.fingerprint === qualification.fingerprint
    );
  } catch {
    return false;
  }
}

function qualificationDecision(
  provider,
  runtime,
  saved,
  options,
) {
  if (saved.qualification === null) {
    return {
      qualified: false,
      drifted: false,
      qualification: "unqualified",
    };
  }
  if (saved.qualification.status === "failed") {
    return {
      qualified: false,
      drifted: false,
      qualification: "failed",
    };
  }
  if (runtime.state !== "detected") {
    return {
      qualified: false,
      drifted: true,
      qualification: "drifted",
    };
  }
  let current;
  try {
    current = providerContract(provider, runtime);
  } catch {
    return {
      qualified: false,
      drifted: true,
      qualification: "drifted",
    };
  }
  const currentEvidence = evidenceIsValid(
    options,
    options.projectKey,
    provider.id,
    saved.qualification,
  );
  const drifted =
    current.fingerprint !== saved.qualification.fingerprint ||
    !currentEvidence;
  return {
    qualified: !drifted,
    drifted,
    qualification: drifted ? "drifted" : "current",
  };
}

function providerStatus(provider, options) {
  const runtime = publicVersion(provider, options);
  const configured = provider.credentialVariables.some(
    (name) => Object.hasOwn(options.environment, name),
  );
  const saved = options.state.providers[provider.id];
  const gate = qualificationDecision(
    provider,
    runtime,
    saved,
    options,
  );
  const enabled = saved.enabled;
  let reason = null;
  if (!enabled) {
    reason = "provider-disabled";
  } else if (runtime.state !== "detected") {
    reason = "provider-unavailable";
  } else if (gate.drifted) {
    reason = "provider-drifted";
  } else if (!gate.qualified) {
    reason =
      gate.qualification === "failed"
        ? "provider-qualification-failed"
        : "provider-unqualified";
  }
  const blocked = reason !== null;
  return {
    id: provider.id,
    detected: runtime.state === "detected",
    configured,
    enabled,
    qualified: gate.qualified,
    drifted: gate.drifted,
    disabled: !enabled,
    blocked,
    decision: blocked ? "blocked" : "allowed",
    reason,
    availability: runtime.state,
    qualification: gate.qualification,
    cliVersion: runtime.version,
  };
}

function statusOptions(options, stored, state) {
  return {
    ...options,
    environment: options.environment ?? process.env,
    projectKey: stored.key,
    state,
  };
}

function summarize(providers) {
  const executable = providers.filter(
    ({ blocked }) => !blocked,
  ).length;
  return (
    `${providers.length} optional providers; ` +
    `${executable} executable, ${providers.length - executable} blocked.`
  );
}

export function listProviderStates(options = {}) {
  const stored = readState(options);
  const providerOptions = statusOptions(
    options,
    stored,
    stored.state,
  );
  const providers = providerDefinitions.map((provider) =>
    providerStatus(provider, providerOptions)
  );
  return {
    schemaVersion: "1",
    operation: "list",
    providers,
    summary: summarize(providers),
  };
}

function parseProbeOutput(contents) {
  let candidate = contents.toString("utf8").trim();
  const fenced = candidate.match(
    /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/,
  );
  if (
    fenced &&
    (candidate.match(/```/g) ?? []).length === 2
  ) {
    candidate = fenced[1];
  }
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

function probeOutputMatches(value, providerId, contract) {
  return (
    exactKeys(value, [
      "schemaVersion",
      "provider",
      "probe",
      "ok",
      "source",
    ]) &&
    value.schemaVersion === "1" &&
    value.provider === providerId &&
    value.probe === contract.catalog.probe.id &&
    value.ok === true &&
    value.source === contract.catalog.probe.expectedSource
  );
}

function runLiveQualification(
  definition,
  options,
  stored,
) {
  const providerOptions = statusOptions(
    options,
    stored,
    stored.state,
  );
  const runtime = publicVersion(definition, providerOptions);
  if (runtime.state !== "detected") {
    throw new ProviderLifecycleError(
      "PROVIDER_UNAVAILABLE",
      "Provider CLI is unavailable or has no supported public version.",
    );
  }
  const contract = providerContract(definition, runtime);
  const runsRoot = providerRunsRoot(
    options,
    stored.key,
    definition.id,
  );
  const temporary = mkdtempSync(
    join(tmpdir(), "cgc-provider-job-"),
  );
  const jobPath = join(temporary, "job.json");
  writeExclusiveJson(jobPath, {
    schemaVersion: "1",
    adapter: contract.adapter,
    activity: "provider-qualification",
    prompt: contract.prompt,
    timeoutMilliseconds: contract.timeoutMilliseconds,
    outputContract: contract.outputContract,
  });
  let execution;
  try {
    execution = spawnSync(
      process.execPath,
      [
        fileURLToPath(FLEET_WORKER_URL),
        jobPath,
        runsRoot,
        fileURLToPath(PROVIDER_MANIFEST_URL),
      ],
      {
        cwd: temporary,
        encoding: "utf8",
        env: options.environment ?? process.env,
        maxBuffer: 1024 * 1024,
      },
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  let fleetReceipt;
  try {
    fleetReceipt = JSON.parse(execution.stdout);
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_QUALIFICATION_FAILED",
      "Provider qualification returned no valid FleetRunner receipt.",
    );
  }
  if (
    !fleetReceipt ||
    typeof fleetReceipt.runIdentity !== "string"
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_QUALIFICATION_FAILED",
      "Provider qualification failed before evidence was created.",
    );
  }
  const runDirectory = join(runsRoot, fleetReceipt.runIdentity);
  requirePlainDirectory(
    runDirectory,
    "Provider qualification run",
  );
  let payload = null;
  try {
    payload = parseProbeOutput(
      readFileSync(join(runDirectory, "stdout.txt")),
    );
  } catch {
    payload = null;
  }
  const postRunRuntime = publicVersion(
    definition,
    providerOptions,
  );
  let postRunFingerprint = null;
  if (postRunRuntime.state === "detected") {
    try {
      postRunFingerprint = providerContract(
        definition,
        postRunRuntime,
      ).fingerprint;
    } catch {
      postRunFingerprint = null;
    }
  }
  const passed =
    execution.status === 0 &&
    fleetReceipt.status === "succeeded" &&
    fleetReceipt.outputContract?.valid === true &&
    probeOutputMatches(payload, definition.id, contract) &&
    postRunFingerprint === contract.fingerprint;
  const terminalState = passed ? "passed" : "failed";
  const qualifiedAt =
    typeof fleetReceipt.finishedAt === "string"
      ? fleetReceipt.finishedAt
      : new Date().toISOString();
  writeExclusiveJson(
    join(runDirectory, "provider-qualification.json"),
    {
      schemaVersion: "1",
      provider: definition.id,
      runIdentity: fleetReceipt.runIdentity,
      terminalState,
      fingerprint: contract.fingerprint,
      components: contract.components,
      cliVersion: runtime.version,
      probe: {
        id: contract.catalog.probe.id,
        visibility: contract.catalog.probe.visibility,
        sourceRulesSha256: contract.components.sourceRules,
      },
      fleetStatus:
        fleetReceipt.status ?? fleetReceipt.error?.code ?? "failed",
      qualifiedAt,
    },
  );
  const evidenceAnchor = writeEvidenceIndex(
    runDirectory,
    fleetReceipt.runIdentity,
  );
  const next = structuredClone(stored.state);
  next.providers[definition.id].qualification = {
    status: terminalState,
    runIdentity: fleetReceipt.runIdentity,
    fingerprint: contract.fingerprint,
    evidenceAnchor,
    qualifiedAt,
  };
  writeState(options, stored, next);
  const provider = providerStatus(
    definition,
    statusOptions(options, stored, next),
  );
  const evidenceIndex =
    `~/.codex-ground-control/evidence/providers/${stored.key}/` +
    `${definition.id}/${fleetReceipt.runIdentity}/evidence-index.json`;
  return {
    blocked: !passed,
    changed: true,
    result: {
      schemaVersion: "1",
      operation: "qualify",
      provider,
      qualification: {
        terminalState,
        runIdentity: fleetReceipt.runIdentity,
        fingerprint: contract.fingerprint,
        probe: {
          id: contract.catalog.probe.id,
          network: "live",
          visibility: contract.catalog.probe.visibility,
        },
        evidence: {
          index: evidenceIndex,
          anchor: evidenceAnchor,
        },
      },
      summary:
        `${definition.id} qualification ${terminalState}; ` +
        `execution ${provider.blocked ? `blocked (${provider.reason})` : "allowed"}.`,
    },
  };
}

export function runProviderOperation(options = {}) {
  const operation = options.operation ?? "list";
  if (operation === "list") {
    return {
      changed: false,
      result: listProviderStates(options),
    };
  }
  if (operation === "qualify" && options.allowLive !== true) {
    throw new ProviderLifecycleError(
      "PROVIDER_LIVE_CONFIRMATION_REQUIRED",
      "Provider qualification requires the explicit --allow-live flag.",
    );
  }
  const definition = providerDefinitions.find(
    ({ id }) => id === options.providerId,
  );
  if (!definition) {
    throw new ProviderLifecycleError(
      "PROVIDER_ID_INVALID",
      "The requested provider ID is invalid.",
    );
  }
  const stored = readState(options);
  if (operation === "qualify") {
    if (!stored.state.providers[definition.id].enabled) {
      throw new ProviderLifecycleError(
        "PROVIDER_TRANSITION_UNSUPPORTED",
        "Enable the provider preference before live qualification.",
      );
    }
    return runLiveQualification(definition, options, stored);
  }
  if (!["enable", "disable"].includes(operation)) {
    throw new ProviderLifecycleError(
      "PROVIDER_OPERATION_INVALID",
      "The requested provider operation is invalid.",
    );
  }
  const enabled = operation === "enable";
  const next = structuredClone(stored.state);
  next.providers[definition.id].enabled = enabled;
  const changed = writeState(options, stored, next);
  const provider = providerStatus(
    definition,
    statusOptions(options, stored, next),
  );
  return {
    changed,
    result: {
      schemaVersion: "1",
      operation,
      provider,
      summary:
        `${definition.id} ${enabled ? "enabled by preference" : "disabled"}; ` +
        `execution ${provider.blocked ? `blocked (${provider.reason})` : "allowed"}.`,
    },
  };
}

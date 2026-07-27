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
  basename,
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
const AGY_PROBE_SCHEMA_URL = new URL(
  "../schemas/provider/agy-live-probe-output.schema.json",
  import.meta.url,
);
const GROK_PROBE_SCHEMA_URL = new URL(
  "../schemas/provider/grok-live-probe-output.schema.json",
  import.meta.url,
);
const PI_CANDIDATE_SCHEMA_URL = new URL(
  "../schemas/provider/pi-candidate-output.schema.json",
  import.meta.url,
);
const PROBE_ADAPTER_URL = new URL(
  "../fixtures/providers/probe-adapter.mjs",
  import.meta.url,
);
const PI_LEAF_ADAPTER_URL = new URL(
  "../fixtures/providers/pi-leaf-adapter.mjs",
  import.meta.url,
);
const AGY_RESEARCH_ADAPTER_URL = new URL(
  "../fixtures/providers/agy-research-adapter.mjs",
  import.meta.url,
);
const AGY_SOURCE_VERIFIER_URL = new URL(
  "../fixtures/providers/agy-source-verifier.mjs",
  import.meta.url,
);
const GROK_RESEARCH_ADAPTER_URL = new URL(
  "../fixtures/providers/grok-research-adapter.mjs",
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
const SAFE_FILES_URL = new URL("./safe-files.js", import.meta.url);

export const providerDefinitions = Object.freeze([
  {
    id: "pi-glm",
    command: "pi",
    family: "pi",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
    credentialVariables: ["ZAI_CODING_CN_API_KEY"],
    authentication: {
      owner: "provider-cli",
      source: "environment",
      credentialBindings: ["env:ZAI_CODING_CN_API_KEY"],
      presenceProbe: "environment-variable",
      statusAuthority: "ground-control-presence-probe",
      materialization: "allowlisted-environment",
      conflictPolicy: "profile-isolated",
    },
  },
  {
    id: "pi-deepseek",
    command: "pi",
    family: "pi",
    modelProvider: "deepseek",
    model: "deepseek-v4-pro",
    credentialVariables: ["DEEPSEEK_API_KEY"],
    authentication: {
      owner: "provider-cli",
      source: "environment",
      credentialBindings: ["env:DEEPSEEK_API_KEY"],
      presenceProbe: "environment-variable",
      statusAuthority: "ground-control-presence-probe",
      materialization: "allowlisted-environment",
      conflictPolicy: "profile-isolated",
    },
  },
  {
    id: "pi-minimax",
    command: "pi",
    family: "pi",
    modelProvider: "minimax-cn",
    model: "MiniMax-M3",
    credentialVariables: ["MINIMAX_API_KEY"],
    authentication: {
      owner: "provider-cli",
      source: "environment",
      credentialBindings: ["env:MINIMAX_API_KEY"],
      presenceProbe: "environment-variable",
      statusAuthority: "ground-control-presence-probe",
      materialization: "allowlisted-environment",
      conflictPolicy: "profile-isolated",
    },
  },
  {
    id: "agy",
    command: "agy",
    role: "research-only",
    researchSurface: "google",
    mode: "plan",
    model: "gemini-3.6-flash-high",
    minimumVersion: "1.1.7",
    credentialVariables: [],
    authentication: {
      owner: "provider-cli",
      source: "system-keyring",
      credentialBindings: ["system-keyring"],
      presenceProbe: "unavailable",
      statusAuthority: "provider-live-run",
      materialization: "provider-native",
      conflictPolicy: "ignore-unbound-environment",
    },
  },
  {
    id: "grok",
    command: "grok",
    role: "research-only",
    researchSurface: "x.com",
    mode: "web-only",
    model: "grok-4.5",
    minimumVersion: "0.2.93",
    credentialVariables: [],
    authentication: {
      owner: "provider-cli",
      source: "cached-file",
      credentialBindings: ["file:~/.grok/auth.json"],
      presenceProbe: "safe-file",
      statusAuthority: "ground-control-presence-probe",
      materialization: "isolated-run-copy",
      conflictPolicy: "ignore-unbound-environment",
    },
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

function validAgySourceRules(rules) {
  return (
    exactKeys(rules, [
      "allowedOrigins",
      "allowedPaths",
      "allowedIdentities",
      "pathIdentityMap",
      "maxObservationAgeMilliseconds",
      "maxFutureSkewMilliseconds",
      "fetch",
      "contentContains",
      "maxResponseBytes",
      "maxRedirects",
      "fetchTimeoutMilliseconds",
      "privateContextAllowed",
    ]) &&
    Array.isArray(rules.allowedOrigins) &&
    rules.allowedOrigins.length === 1 &&
    rules.allowedOrigins[0] === "https://www.python.org" &&
    Array.isArray(rules.allowedPaths) &&
    rules.allowedPaths.length === 1 &&
    rules.allowedPaths[0] === "/" &&
    Array.isArray(rules.allowedIdentities) &&
    rules.allowedIdentities.length === 1 &&
    rules.allowedIdentities[0] ===
      "Python Software Foundation official website" &&
    exactKeys(rules.pathIdentityMap, ["/"]) &&
    rules.pathIdentityMap["/"] === rules.allowedIdentities[0] &&
    rules.maxObservationAgeMilliseconds === 3_600_000 &&
    rules.maxFutureSkewMilliseconds === 300_000 &&
    rules.fetch === true &&
    Array.isArray(rules.contentContains) &&
    rules.contentContains.length === 1 &&
    rules.contentContains[0] === "Python" &&
    rules.maxResponseBytes === 1_000_000 &&
    rules.maxRedirects === 3 &&
    rules.fetchTimeoutMilliseconds === 15_000 &&
    rules.privateContextAllowed === false
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
    rules.urlIdentityMap["https://x.com/SpaceXAI"] ===
      "@spacexai" &&
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

function compareVersions(left, right) {
  const parse = (value) => {
    const match = value.match(
      /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/,
    );
    return match
      ? {
          numbers: match.slice(1, 4).map(Number),
          prerelease: match[4] ?? null,
        }
      : null;
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  if (!leftVersion || !rightVersion) {
    return -1;
  }
  for (let index = 0; index < 3; index += 1) {
    if (
      leftVersion.numbers[index] !==
      rightVersion.numbers[index]
    ) {
      return (
        leftVersion.numbers[index] -
        rightVersion.numbers[index]
      );
    }
  }
  if (leftVersion.prerelease === rightVersion.prerelease) {
    return 0;
  }
  if (leftVersion.prerelease === null) {
    return 1;
  }
  if (rightVersion.prerelease === null) {
    return -1;
  }
  return leftVersion.prerelease.localeCompare(
    rightVersion.prerelease,
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
  const compatible =
    version &&
    (!provider.minimumVersion ||
      compareVersions(version, provider.minimumVersion) >= 0);
  return version && executable && compatible
    ? {
        state: "detected",
        version,
        executableSha256: executable,
      }
    : {
        state: "incompatible",
        version: version ?? null,
        executableSha256: executable,
      };
}

function repositoryIdentityRoot(projectRoot) {
  const git = spawnSync(
    "git",
    ["rev-parse", "--git-common-dir"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 5_000,
    },
  );
  if (
    git.error ||
    git.status !== 0 ||
    git.signal ||
    typeof git.stdout !== "string" ||
    git.stdout.trim() === ""
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_UNSAFE",
      "Git common storage could not be resolved for Provider state.",
    );
  }
  let commonDirectory;
  try {
    commonDirectory = realpathSync(
      resolve(projectRoot, git.stdout.trim()),
    );
  } catch {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_UNSAFE",
      "Git common storage could not be resolved safely.",
    );
  }
  return basename(commonDirectory) === ".git"
    ? dirname(commonDirectory)
    : commonDirectory;
}

function projectKey(projectRoot) {
  return sha256(repositoryIdentityRoot(projectRoot)).slice(0, 32);
}

export function resolveProviderProjectKey(projectRoot) {
  return projectKey(projectRoot);
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

function validProviderState(value) {
  return (
    exactKeys(value, ["enabled", "qualification"]) &&
    typeof value.enabled === "boolean" &&
    (value.qualification === null ||
      validQualification(value.qualification))
  );
}

function migrateLegacyState(state) {
  if (
    !exactKeys(state.providers, ["pi", "agy", "grok"]) ||
    !["pi", "agy", "grok"].every((id) =>
      validProviderState(state.providers[id])
    )
  ) {
    return null;
  }
  const migrated = defaultState(state.projectKey);
  migrated.providers["pi-glm"].enabled =
    state.providers.pi.enabled;
  migrated.providers.agy =
    structuredClone(state.providers.agy);
  migrated.providers.grok =
    structuredClone(state.providers.grok);
  return migrated;
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
  const headerIsInvalid =
    !exactKeys(state, ["schemaVersion", "projectKey", "providers"]) ||
    state.schemaVersion !== "1" ||
    state.projectKey !== key;
  if (headerIsInvalid) {
    throw new ProviderLifecycleError(
      "PROVIDER_STATE_INVALID",
      "Provider state has an unsupported shape.",
    );
  }
  const currentIds = providerDefinitions.map(({ id }) => id);
  const currentIsValid =
    exactKeys(state.providers, currentIds) &&
    currentIds.every((id) =>
      validProviderState(state.providers[id])
    );
  if (!currentIsValid) {
    const migrated = migrateLegacyState(state);
    if (!migrated) {
      throw new ProviderLifecycleError(
        "PROVIDER_STATE_INVALID",
        "Provider state has an unsupported shape.",
      );
    }
    state = migrated;
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
    provider.id === "agy"
      ? AGY_PROBE_SCHEMA_URL
      : provider.id === "grok"
        ? GROK_PROBE_SCHEMA_URL
        : PROBE_SCHEMA_URL,
    "Provider probe schema",
  );
  const catalog = catalogFile.value;
  const manifest = manifestFile.value;
  const record = catalog.providers?.[provider.id];
  const adapter = manifest.adapters?.[record?.adapter];
  const outputContract =
    manifest.outputContracts?.[record?.outputContract];
  const candidateAdapter = provider.family === "pi"
    ? manifest.adapters?.[record?.candidateAdapter]
    : null;
  const candidateOutputContract = provider.family === "pi"
    ? manifest.outputContracts?.[record?.candidateOutputContract]
    : null;
  const candidateSchemaFile = provider.family === "pi"
    ? readJsonFile(
        PI_CANDIDATE_SCHEMA_URL,
        "Pi candidate output schema",
      )
    : null;
  const piIdentityMatches =
    provider.family !== "pi" ||
    (record?.contract?.kind === "model" &&
      record.contract.provider === provider.modelProvider &&
      record.contract.model === provider.model &&
      record.contract.mode === "no-tools" &&
      Boolean(candidateAdapter) &&
      Boolean(candidateOutputContract));
  const agySourceRules = record?.sourceRules;
  const agyContractMatches =
    provider.id !== "agy" ||
    (record.contract?.kind === "search" &&
      record.contract.model === provider.model &&
      record.contract.mode ===
        "sandboxed-plan-google" &&
      validAgySourceRules(agySourceRules));
  const grokSourceRules = record?.sourceRules;
  const grokContractMatches =
    provider.id !== "grok" ||
    (record.contract?.kind === "search" &&
      record.contract.model === provider.model &&
      record.contract.mode === "web-only" &&
      validGrokSourceRules(grokSourceRules));
  if (
    catalog.schemaVersion !== "1" ||
    catalog.probe?.id !== "public-sources-v1" ||
    catalog.probe?.visibility !== "public-only" ||
    catalog.probe?.sourceRules?.privateContextAllowed !== false ||
    !record ||
    !adapter ||
    !outputContract ||
    !piIdentityMatches ||
    !agyContractMatches ||
    !grokContractMatches ||
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
    runtimeProfile: sha256(
      canonicalJson(publicRuntimeProfile(provider)),
    ),
    adapter: sha256(
      canonicalJson(
        provider.family === "pi"
          ? {
              qualificationManifest: adapter,
              qualificationOutputContract: outputContract,
              qualificationSourceSha256: sha256(
                readFileSync(PROBE_ADAPTER_URL),
              ),
              candidateManifest: candidateAdapter,
              candidateOutputContract,
              candidateSourceSha256: sha256(
                readFileSync(PI_LEAF_ADAPTER_URL),
              ),
            }
          : {
              manifest: adapter,
              outputContract,
              sourceSha256: sha256(
                readFileSync(
                  provider.id === "agy"
                    ? AGY_RESEARCH_ADAPTER_URL
                    : provider.id === "grok"
                      ? GROK_RESEARCH_ADAPTER_URL
                      : PROBE_ADAPTER_URL,
                ),
              ),
              ...(provider.id === "agy"
                ? {
                    sourceVerifierSha256: sha256(
                      readFileSync(AGY_SOURCE_VERIFIER_URL),
                    ),
                  }
                : provider.id === "grok"
                  ? {
                      authReaderSha256: sha256(
                        readFileSync(SAFE_FILES_URL),
                      ),
                    }
                : {}),
            },
      ),
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
    schema: sha256(
      provider.family === "pi"
        ? canonicalJson({
            qualification: sha256(schemaFile.contents),
            candidate: sha256(candidateSchemaFile.contents),
          })
        : schemaFile.contents,
    ),
    sourceRules: sha256(
      canonicalJson(
        provider.role === "research-only"
          ? record.sourceRules
          : catalog.probe.sourceRules,
      ),
    ),
  };
  return {
    adapter: record.adapter,
    candidateAdapter: record.candidateAdapter ?? null,
    candidateOutputContract:
      record.candidateOutputContract ?? null,
    catalog,
    components,
    fingerprint: sha256(canonicalJson(components)),
    outputContract: record.outputContract,
    prompt: record.prompt,
    sourceRules:
      provider.role === "research-only"
        ? record.sourceRules
        : catalog.probe.sourceRules,
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
      current: false,
      drifted: false,
      qualification: "unqualified",
    };
  }
  if (saved.qualification.status === "failed") {
    return {
      qualified: false,
      current: false,
      drifted: false,
      qualification: "failed",
    };
  }
  if (runtime.state !== "detected") {
    return {
      qualified: true,
      current: false,
      drifted: true,
      qualification: "drifted",
    };
  }
  let current;
  try {
    current = providerContract(provider, runtime);
  } catch {
    return {
      qualified: true,
      current: false,
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
    qualified: true,
    current: !drifted,
    drifted,
    qualification: drifted ? "drifted" : "current",
  };
}

function publicRuntimeProfile(provider) {
  return {
    executable: provider.command,
    argv: "manifest-controlled",
    shell: false,
    environment: "manifest-allowlist",
    authentication: structuredClone(provider.authentication),
  };
}

export function inspectProviderAuthentication(
  provider,
  options = {},
) {
  const environment = options.environment ?? process.env;
  if (provider.authentication.presenceProbe === "unavailable") {
    return { status: "unknown" };
  }
  if (
    provider.authentication.presenceProbe ===
    "environment-variable"
  ) {
    const present = provider.credentialVariables.some(
      (name) =>
        typeof environment[name] === "string" &&
        environment[name].length > 0,
    );
    return { status: present ? "present" : "absent" };
  }
  if (provider.authentication.presenceProbe === "safe-file") {
    const homeDirectory = environment.HOME;
    if (
      typeof homeDirectory !== "string" ||
      homeDirectory.length === 0
    ) {
      return { status: "unknown" };
    }
    try {
      const file = inspectFile(
        homeDirectory,
        ".grok/auth.json",
      );
      if (file.state === "absent") {
        return { status: "absent" };
      }
      return {
        status:
          file.contents.byteLength > 0 &&
          file.contents.byteLength <= 65_536
            ? "present"
            : "unsafe",
      };
    } catch {
      return { status: "unsafe" };
    }
  }
  return { status: "unknown" };
}

function providerStatus(provider, options) {
  const runtime = publicVersion(provider, options);
  const authentication = inspectProviderAuthentication(
    provider,
    options,
  );
  const configured = authentication.status === "present";
  const authenticated = authentication.status === "unknown"
    ? null
    : configured;
  const saved = options.state.providers[provider.id];
  const gate = qualificationDecision(
    provider,
    runtime,
    saved,
    options,
  );
  const enabled = saved.enabled;
  const runAuthorized =
    options.allowLive === true &&
    ["qualify", "run"].includes(options.operation);
  let reason = null;
  if (!enabled) {
    reason = "provider-disabled";
  } else if (runtime.state !== "detected") {
    reason = "provider-unavailable";
  } else if (gate.drifted) {
    reason = "provider-drifted";
  } else if (!gate.current) {
    reason =
      gate.qualification === "failed"
        ? "provider-qualification-failed"
        : "provider-unqualified";
  } else if (!runAuthorized) {
    reason = "provider-live-authorization-required";
  }
  const blocked = reason !== null;
  return {
    id: provider.id,
    ...(provider.family === "pi"
      ? {
          family: provider.family,
          modelProvider: provider.modelProvider,
          model: provider.model,
        }
      : {}),
    ...(provider.role
      ? {
          role: provider.role,
          researchSurface: provider.researchSurface,
          mode: provider.mode,
          model: provider.model,
        }
      : {}),
    detected: runtime.state === "detected",
    runtimeProfile: publicRuntimeProfile(provider),
    authentication,
    authenticated,
    configured,
    enabled,
    qualified: gate.qualified,
    current: gate.current,
    runAuthorized,
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

export function resolveCurrentProviderQualification(options = {}) {
  const definition = providerDefinitions.find(
    ({ id, family }) =>
      id === options.providerId && family === "pi",
  );
  if (!definition) {
    throw new ProviderLifecycleError(
      "PROVIDER_ID_INVALID",
      "The requested Pi provider ID is invalid.",
    );
  }
  const stored = readState(options);
  const provider = providerStatus(
    definition,
    statusOptions(options, stored, stored.state),
  );
  const qualification =
    stored.state.providers[definition.id].qualification;
  if (
    !provider.enabled ||
    !provider.current ||
    provider.qualification !== "passed" ||
    !validQualification(qualification)
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_TRANSITION_UNSUPPORTED",
      "Enable and qualify the current Pi profile before preparing a LeafRun.",
    );
  }
  return {
    providerId: definition.id,
    fingerprint: qualification.fingerprint,
    qualifiedAt: qualification.qualifiedAt,
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
  const record = contract.catalog.providers[providerId];
  if (record.contract?.kind === "model") {
    return (
      exactKeys(value, [
        "schemaVersion",
        "profile",
        "provider",
        "model",
        "probe",
        "ok",
      ]) &&
      value.schemaVersion === "1" &&
      value.profile === providerId &&
      value.provider === record.contract.provider &&
      value.model === record.contract.model &&
      value.probe === contract.catalog.probe.id &&
      value.ok === true
    );
  }
  if (providerId === "agy") {
    const source = value?.source;
    const verification = value?.verification;
    const rules = contract.sourceRules;
    let observedUrl;
    try {
      observedUrl = new URL(source?.url);
    } catch {
      observedUrl = null;
    }
    const observedAt = Date.parse(source?.observedAt);
    const checkedAt = Date.parse(verification?.checkedAt);
    const now = Date.now();
    return (
      exactKeys(value, [
        "schemaVersion",
        "provider",
        "probe",
        "ok",
        "source",
        "verification",
      ]) &&
      value.schemaVersion === "1" &&
      value.provider === providerId &&
      value.probe === contract.catalog.probe.id &&
      value.ok === true &&
      exactKeys(source, ["url", "identity", "observedAt"]) &&
      observedUrl?.protocol === "https:" &&
      source.url === observedUrl.href &&
      observedUrl.username === "" &&
      observedUrl.password === "" &&
      observedUrl.search === "" &&
      observedUrl.hash === "" &&
      rules.allowedOrigins.includes(observedUrl.origin) &&
      rules.allowedPaths.includes(observedUrl.pathname) &&
      rules.allowedIdentities.includes(source.identity) &&
      rules.pathIdentityMap[observedUrl.pathname] ===
        source.identity &&
      Number.isFinite(observedAt) &&
      source.observedAt === new Date(observedAt).toISOString() &&
      now - observedAt <=
        rules.maxObservationAgeMilliseconds &&
      observedAt - now <=
        rules.maxFutureSkewMilliseconds &&
      exactKeys(verification, [
        "checkedAt",
        "finalUrl",
        "httpStatus",
        "contentMarkersMatched",
        "verified",
      ]) &&
      Number.isFinite(checkedAt) &&
      verification.checkedAt ===
        new Date(checkedAt).toISOString() &&
      checkedAt >= observedAt - 300_000 &&
      checkedAt - now <= rules.maxFutureSkewMilliseconds &&
      now - checkedAt <=
        rules.maxObservationAgeMilliseconds &&
      verification.finalUrl === observedUrl.href &&
      Number.isInteger(verification.httpStatus) &&
      verification.httpStatus >= 200 &&
      verification.httpStatus < 300 &&
      verification.contentMarkersMatched === true &&
      verification.verified === true
    );
  }
  if (providerId === "grok") {
    const source = value?.source;
    const rules = contract.sourceRules;
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
      value.provider === providerId &&
      value.probe === contract.catalog.probe.id &&
      value.ok === true &&
      exactKeys(source, ["url", "identity", "observedAt"]) &&
      rules.allowedUrls.includes(source.url) &&
      rules.allowedIdentities.includes(source.identity) &&
      rules.urlIdentityMap[source.url] === source.identity &&
      Number.isFinite(observedAt) &&
      source.observedAt === new Date(observedAt).toISOString() &&
      now - observedAt <=
        rules.maxObservationAgeMilliseconds &&
      observedAt - now <=
        rules.maxFutureSkewMilliseconds
    );
  }
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

function runFleetWorker(
  job,
  runsRoot,
  options,
  failure = {
    code: "PROVIDER_EXECUTION_FAILED",
    label: "Provider execution",
  },
) {
  const temporary = mkdtempSync(
    join(tmpdir(), "cgc-provider-job-"),
  );
  const jobPath = join(temporary, "job.json");
  writeExclusiveJson(jobPath, job);
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
      failure.code,
      `${failure.label} returned no valid FleetRunner receipt.`,
    );
  }
  if (
    !fleetReceipt ||
    typeof fleetReceipt.runIdentity !== "string"
  ) {
    throw new ProviderLifecycleError(
      failure.code,
      `${failure.label} failed before evidence was created.`,
    );
  }
  const runDirectory = join(runsRoot, fleetReceipt.runIdentity);
  requirePlainDirectory(runDirectory, "Provider execution run");
  return { execution, fleetReceipt, runDirectory };
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
  const { execution, fleetReceipt, runDirectory } =
    runFleetWorker(
      {
        schemaVersion: "1",
        adapter: contract.adapter,
        activity: "provider-qualification",
        prompt: contract.prompt,
        timeoutMilliseconds: contract.timeoutMilliseconds,
        outputContract: contract.outputContract,
      },
      runsRoot,
      options,
      {
        code: "PROVIDER_QUALIFICATION_FAILED",
        label: "Provider qualification",
      },
    );
  let payload = null;
  try {
    payload = parseProbeOutput(
      readFileSync(join(runDirectory, "stdout.txt")),
    );
  } catch {
    payload = null;
  }
  const outputMatches = probeOutputMatches(
    payload,
    definition.id,
    contract,
  );
  rmSync(join(runDirectory, "workspace"), {
    recursive: true,
    force: true,
  });
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
    outputMatches &&
    postRunFingerprint === contract.fingerprint;
  const terminalState = passed ? "passed" : "failed";
  const identity = definition.family === "pi"
    ? {
        profile: definition.id,
        provider: definition.modelProvider,
        model: definition.model,
      }
    : null;
  const sourceEvidence = definition.id === "agy"
    ? {
        sourceIdentity: {
          semanticIdentity:
            contract.sourceRules.allowedIdentities[0],
          url:
            `${contract.sourceRules.allowedOrigins[0]}` +
            contract.sourceRules.allowedPaths[0],
        },
        sourceVerification: {
          source:
            "agy-independent-allowlist-fetch-v1",
          verified: outputMatches,
          ...(outputMatches ? payload.verification : {}),
        },
        observation: outputMatches ? payload.source : null,
        authority: {
          disposition: "qualification-evidence",
          completionAuthority: "codex-main",
          reviewRequired: true,
          workspaceChangesApplied: false,
        },
      }
    : definition.id === "grok"
      ? {
          sourceIdentity: {
            semanticIdentity: "xAI official X account",
            approvedAccounts:
              contract.sourceRules.allowedUrls.map((url) => ({
                url,
                identity:
                  contract.sourceRules.urlIdentityMap[url],
              })),
          },
          sourceVerification: {
            source: "grok-exact-x-account-v1",
            redirectsAllowed: false,
            verified: outputMatches,
          },
          researchBoundary: {
            tools: [...contract.sourceRules.tools],
            workspace: "isolated-empty",
            grokHome: "isolated-disposable",
            compatibilityImports: false,
            memory: false,
            subagents: false,
            localFiles: false,
            shell: false,
            authentication: {
              policy: "isolated-run-copy-only",
              retained: false,
              recorded: false,
            },
          },
          observation: outputMatches ? payload.source : null,
          authority: {
            disposition: "qualification-evidence",
            completionAuthority: "codex-main",
            reviewRequired: true,
            workspaceChangesApplied: false,
          },
        }
      : null;
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
      ...(identity
        ? {
            identity,
            identityVerification: {
              source: "pi-json-message-end",
              verified: passed,
            },
          }
        : {}),
      ...(sourceEvidence ?? {}),
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
        fingerprints: {
          providerCli: contract.components.providerCli,
          runtimeProfile: contract.components.runtimeProfile,
          adapter: contract.components.adapter,
        },
        ...(identity
          ? {
              identity,
              identityVerification: {
                source: "pi-json-message-end",
                verified: passed,
              },
            }
          : {}),
        ...(sourceEvidence ?? {}),
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

const PI_ACTIVITIES = new Set([
  "analysis",
  "exploration",
  "testing",
  "review",
]);

function stringArray(value) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string")
  );
}

function nonnegativeFinite(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function runtimeUsageMatches(value) {
  if (
    exactKeys(value, [
      "schemaVersion",
      "source",
      "status",
    ]) &&
    value.schemaVersion === "1" &&
    value.source === "pi-message-end" &&
    value.status === "unknown"
  ) {
    return true;
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

function candidateOutputMatches(
  value,
  definition,
  activity,
) {
  if (
    !exactKeys(value, [
      "schemaVersion",
      "candidate",
      "runtimeUsage",
    ]) ||
    value.schemaVersion !== "1" ||
    !runtimeUsageMatches(value.runtimeUsage)
  ) {
    return false;
  }
  const candidate = value.candidate;
  return (
    exactKeys(candidate, [
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
    ]) &&
    candidate.schemaVersion === "1" &&
    candidate.profile === definition.id &&
    candidate.provider === definition.modelProvider &&
    candidate.model === definition.model &&
    candidate.activity === activity &&
    candidate.disposition === "candidate-evidence" &&
    candidate.completionAuthority === "codex-main" &&
    typeof candidate.summary === "string" &&
    stringArray(candidate.findings) &&
    stringArray(candidate.suggestedChecks)
  );
}

function runPiCandidate(definition, options, stored) {
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
  if (
    !contract.candidateAdapter ||
    !contract.candidateOutputContract
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_CONTRACT_INVALID",
      "Pi candidate execution contract is invalid.",
    );
  }
  const prompt = canonicalJson({
    schemaVersion: "1",
    activity: options.activity,
    brief: options.prompt,
  });
  const runsRoot = providerRunsRoot(
    options,
    stored.key,
    definition.id,
  );
  const { execution, fleetReceipt, runDirectory } =
    runFleetWorker(
      {
        schemaVersion: "1",
        adapter: contract.candidateAdapter,
        activity: options.activity,
        prompt,
        timeoutMilliseconds: contract.timeoutMilliseconds,
        outputContract: contract.candidateOutputContract,
      },
      runsRoot,
      options,
    );
  let payload = null;
  try {
    payload = parseProbeOutput(
      readFileSync(join(runDirectory, "stdout.txt")),
    );
  } catch {
    payload = null;
  }
  rmSync(join(runDirectory, "workspace"), {
    recursive: true,
    force: true,
  });
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
    candidateOutputMatches(
      payload,
      definition,
      options.activity,
    ) &&
    postRunFingerprint === contract.fingerprint;
  const terminalState = passed ? "succeeded" : "failed";
  const finishedAt =
    typeof fleetReceipt.finishedAt === "string"
      ? fleetReceipt.finishedAt
      : new Date().toISOString();
  const identity = {
    profile: definition.id,
    provider: definition.modelProvider,
    model: definition.model,
  };
  const runtimeUsage = runtimeUsageMatches(
    payload?.runtimeUsage,
  )
    ? payload.runtimeUsage
    : {
        schemaVersion: "1",
        source: "pi-message-end",
        status: "unknown",
      };
  writeExclusiveJson(
    join(runDirectory, "provider-run.json"),
    {
      schemaVersion: "1",
      profile: definition.id,
      activity: options.activity,
      identity,
      terminalState,
      fingerprint: contract.fingerprint,
      cliVersion: runtime.version,
      fleetStatus:
        fleetReceipt.status ?? fleetReceipt.error?.code ?? "failed",
      disposition: "candidate-evidence",
      completionAuthority: "codex-main",
      runtimeUsage,
      candidate: passed ? payload.candidate : null,
      finishedAt,
    },
  );
  const evidenceAnchor = writeEvidenceIndex(
    runDirectory,
    fleetReceipt.runIdentity,
  );
  const provider = providerStatus(
    definition,
    providerOptions,
  );
  const evidenceIndex =
    `~/.codex-ground-control/evidence/providers/${stored.key}/` +
    `${definition.id}/${fleetReceipt.runIdentity}/evidence-index.json`;
  return {
    blocked: !passed,
    changed: true,
    errorCode: "PROVIDER_EXECUTION_FAILED",
    errorMessage: "Pi candidate execution failed.",
    result: {
      schemaVersion: "1",
      operation: "run",
      provider,
      execution: {
        terminalState,
        runIdentity: fleetReceipt.runIdentity,
        activity: options.activity,
        identity,
        runtimeUsage,
        fingerprint: contract.fingerprint,
        fingerprints: {
          providerCli: contract.components.providerCli,
          runtimeProfile: contract.components.runtimeProfile,
          adapter: contract.components.adapter,
        },
        evidence: {
          index: evidenceIndex,
          anchor: evidenceAnchor,
        },
      },
      candidate: {
        disposition: "candidate-evidence",
        completionAuthority: "codex-main",
        reviewRequired: true,
        workspaceChangesApplied: false,
        output: passed ? payload.candidate : null,
      },
      summary:
        `${definition.id} candidate execution ${terminalState}; ` +
        "codex-main review remains required.",
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
  if (
    ["qualify", "run"].includes(operation) &&
    options.allowLive !== true
  ) {
    throw new ProviderLifecycleError(
      "PROVIDER_LIVE_CONFIRMATION_REQUIRED",
      "Provider network execution requires the explicit --allow-live flag.",
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
  if (operation === "run") {
    if (
      definition.family !== "pi" ||
      !PI_ACTIVITIES.has(options.activity) ||
      typeof options.prompt !== "string" ||
      options.prompt.trim() === ""
    ) {
      throw new ProviderLifecycleError(
        "PROVIDER_EXECUTION_INVALID",
        "Pi execution requires a supported activity and bounded prompt.",
      );
    }
    const provider = providerStatus(
      definition,
      statusOptions(options, stored, stored.state),
    );
    if (provider.blocked) {
      throw new ProviderLifecycleError(
        "PROVIDER_TRANSITION_UNSUPPORTED",
        "Enable and qualify the current Pi profile before execution.",
      );
    }
    const expectedFingerprint =
      options.expectedQualificationFingerprint;
    if (
      expectedFingerprint !== undefined &&
      (!/^[0-9a-f]{64}$/.test(expectedFingerprint) ||
        stored.state.providers[definition.id].qualification
          ?.fingerprint !== expectedFingerprint)
    ) {
      throw new ProviderLifecycleError(
        "PROVIDER_QUALIFICATION_DRIFTED",
        "Pi qualification changed after LeafRun authorization.",
      );
    }
    return runPiCandidate(definition, options, stored);
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

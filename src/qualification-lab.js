import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertQualificationDocument,
  auditQualificationReceiptValidators,
  qualificationSchemaUrls,
} from "./qualification-contract.js";
import {
  FleetRunnerError,
  validateFleetJob,
} from "./fleet-runner.js";
import { inspectNativeRuntimeBoundary } from "./doctor.js";
import { inspectFile } from "./safe-files.js";

const PACKAGE_VERSION = "0.1.0";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CAMPAIGN_URL = new URL(
  "../fixtures/qualification/offline-core-v1.json",
  import.meta.url,
);
const RECEIPT_AUDIT_URL = new URL(
  "../fixtures/qualification/public-receipt-audit-v1.json",
  import.meta.url,
);
const FLEET_MANIFEST_URL = new URL(
  "../fixtures/qualification/fleet/capabilities-v1.json",
  import.meta.url,
);
const FLEET_ADAPTER_URL = new URL(
  "../fixtures/qualification/fleet/adapter.mjs",
  import.meta.url,
);
const FLEET_WORKSPACE_URL = new URL(
  "../fixtures/qualification/fleet/workspace/fixture.txt",
  import.meta.url,
);
const FLEET_WORKER_URL = new URL(
  "./fleet-runner-worker.js",
  import.meta.url,
);

const COMPONENTS = [
  ["package", new URL("../package.json", import.meta.url)],
  ["release-lock", new URL("../release-lock.json", import.meta.url)],
  [
    "cli-entry",
    new URL("../bin/codex-ground-control.js", import.meta.url),
  ],
  ["cli", new URL("./cli.js", import.meta.url)],
  ["doctor", new URL("./doctor.js", import.meta.url)],
  ["fleet-runner", new URL("./fleet-runner.js", import.meta.url)],
  ["fleet-runner-worker", FLEET_WORKER_URL],
  ["fleet-manifest", FLEET_MANIFEST_URL],
  ["fleet-adapter", FLEET_ADAPTER_URL],
  ["fleet-workspace-fixture", FLEET_WORKSPACE_URL],
  ["global-workflow", new URL("./global-workflow.js", import.meta.url)],
  ["managed-workflow", new URL("./managed-workflow.js", import.meta.url)],
  ["project-state", new URL("./project-state.js", import.meta.url)],
  ["qualification-lab", new URL("./qualification-lab.js", import.meta.url)],
  [
    "qualification-contract",
    new URL("./qualification-contract.js", import.meta.url),
  ],
  ["safe-files", new URL("./safe-files.js", import.meta.url)],
  ["workflow-assets", new URL("./workflow-assets.js", import.meta.url)],
  ["workflow-error", new URL("./workflow-error.js", import.meta.url)],
  ["campaign", CAMPAIGN_URL],
  ["receipt-audit", RECEIPT_AUDIT_URL],
  ...Object.entries(qualificationSchemaUrls).map(([name, url]) => [
    `${name}-schema`,
    url,
  ]),
];

export class QualificationLabError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "QualificationLabError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(path) {
  return path.split(sep).join("/");
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

function parseJson(contents, label) {
  try {
    return JSON.parse(contents.toString("utf8"));
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_STRUCTURE_INVALID",
      `${label} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function readJson(url, label) {
  try {
    return parseJson(readFileSync(url), label);
  } catch (error) {
    if (error instanceof QualificationLabError) {
      throw error;
    }
    throw new QualificationLabError(
      "QUALIFICATION_STRUCTURE_INVALID",
      `${label} is unavailable.`,
    );
  }
}

function writeExclusiveJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
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

function requireDirectory(path, label) {
  const current = metadata(path);
  if (
    !current ||
    current.isSymbolicLink() ||
    !current.isDirectory()
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_UNSAFE",
      `${label} must be an existing non-symlink directory.`,
    );
  }
}

function ensurePrivateDirectory(parent, name) {
  requireDirectory(parent, "Qualification evidence parent");
  const path = join(parent, name);
  const current = metadata(path);
  if (!current) {
    mkdirSync(path, { mode: 0o700 });
  } else if (current.isSymbolicLink() || !current.isDirectory()) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_UNSAFE",
      `Qualification evidence path is unsafe: ${name}`,
    );
  }
  return path;
}

function qualificationHome(homeDirectory) {
  if (
    typeof homeDirectory !== "string" ||
    homeDirectory.length === 0
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_HOME_REQUIRED",
      "Qualification requires an explicit HOME directory.",
    );
  }
  const home = resolve(homeDirectory);
  requireDirectory(home, "HOME");
  return home;
}

function ensureQualificationRunsRoot(homeDirectory) {
  const home = qualificationHome(homeDirectory);
  const control = ensurePrivateDirectory(home, ".codex-ground-control");
  const evidence = ensurePrivateDirectory(control, "evidence");
  return ensurePrivateDirectory(evidence, "qualification");
}

function existingQualificationRunsRoot(homeDirectory) {
  const home = qualificationHome(homeDirectory);
  const control = join(home, ".codex-ground-control");
  requireDirectory(control, "Qualification state");
  const evidence = join(control, "evidence");
  requireDirectory(evidence, "Qualification evidence");
  const qualification = join(evidence, "qualification");
  requireDirectory(qualification, "Qualification runs");
  return qualification;
}

function validateCampaignSemantics(campaign) {
  const seen = new Set();
  for (const scenario of campaign.scenarios) {
    if (seen.has(scenario.id)) {
      throw new QualificationLabError(
        "QUALIFICATION_CAMPAIGN_INVALID",
        `Duplicate qualification scenario: ${scenario.id}`,
      );
    }
    seen.add(scenario.id);
    const inputKeys = Object.keys(scenario.input).sort();
    const expectedKeys = {
      uppercase: ["value"],
      "fail-closed": ["boundary"],
      "validator-audit": ["contract"],
      "fleet-runner": ["case"],
      "fleet-policy": ["case"],
    }[scenario.driver];
    if (
      !expectedKeys ||
      canonicalJson(inputKeys) !== canonicalJson(expectedKeys)
    ) {
      throw new QualificationLabError(
        "QUALIFICATION_CAMPAIGN_INVALID",
        `Scenario ${scenario.id} has an invalid driver input.`,
      );
    }
  }
}

function loadCampaign() {
  const campaign = readJson(CAMPAIGN_URL, "offline campaign");
  try {
    assertQualificationDocument("campaign", campaign);
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_CAMPAIGN_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  validateCampaignSemantics(campaign);
  return campaign;
}

function captureRuntime(homeDirectory) {
  const components = COMPONENTS.map(([id, url]) => {
    const path = fileURLToPath(url);
    const contents = readFileSync(path);
    return {
      id,
      path: portablePath(relative(PACKAGE_ROOT, path)),
      bytes: contents.byteLength,
      sha256: sha256(contents),
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const facts = {
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    packageVersion: PACKAGE_VERSION,
    nativeRuntime:
      inspectNativeRuntimeBoundary(homeDirectory),
    components,
  };
  return {
    schemaVersion: "1",
    ...facts,
    fingerprint: sha256(canonicalJson(facts)),
  };
}

function hasExactKeys(value, required) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).length === required.length
  );
}

function validNativeRuntimeBoundary(value) {
  if (
    !hasExactKeys(value, ["status", "enabledEntryPoints"]) ||
    !["blocked", "conflicted", "enabled"].includes(value.status) ||
    !Array.isArray(value.enabledEntryPoints) ||
    value.enabledEntryPoints.some(
      (entry) =>
        !["agents.enabled", "features.multi_agent"].includes(entry)
    ) ||
    new Set(value.enabledEntryPoints).size !==
      value.enabledEntryPoints.length ||
    canonicalJson([...value.enabledEntryPoints].sort()) !==
      canonicalJson(value.enabledEntryPoints)
  ) {
    return false;
  }
  return value.status === "enabled"
    ? value.enabledEntryPoints.length > 0
    : value.enabledEntryPoints.length === 0;
}

function validEvidencePath(path) {
  return (
    typeof path === "string" &&
    path.length > 0 &&
    !isAbsolute(path) &&
    path.split("/").every((part) =>
      part !== "" && part !== "." && part !== ".."
    )
  );
}

function executeFleetScenario(scenario, scenarioDirectory) {
  const fleetCases = {
    "raw-shell-env": {
      adapter: "fixture-raw",
      prompt: "literal $(touch fleet-shell-injection)",
      expectedStatus: "succeeded",
      expectedNormalization: "raw-json",
      successOutput: "succeeded:raw-json",
    },
    "fenced-normalization": {
      adapter: "fixture-fenced",
      prompt: "bounded fenced output",
      expectedStatus: "succeeded",
      expectedNormalization: "single-json-fence",
      successOutput: "succeeded:single-json-fence",
    },
    "workspace-copy": {
      adapter: "fixture-workspace-copy",
      prompt: "bounded workspace copy",
      expectedStatus: "succeeded",
      expectedNormalization: "raw-json",
      successOutput: "succeeded:workspace-copy",
    },
    "nonzero-exit": {
      adapter: "fixture-nonzero",
      prompt: "bounded nonzero exit",
      expectedStatus: "process-failed",
    },
    "invalid-json": {
      adapter: "fixture-invalid-json",
      prompt: "bounded invalid JSON",
      expectedStatus: "invalid-output",
    },
    "trailing-prose": {
      adapter: "fixture-trailing-prose",
      prompt: "bounded trailing prose",
      expectedStatus: "invalid-output",
    },
    "multiple-fences": {
      adapter: "fixture-multiple-fences",
      prompt: "bounded multiple fences",
      expectedStatus: "invalid-output",
    },
    "corrupt-payload": {
      adapter: "fixture-corrupt-payload",
      prompt: "bounded corrupt payload",
      expectedStatus: "invalid-output",
    },
    "timeout-process-group": {
      adapter: "fixture-timeout-process-group",
      prompt: "bounded timeout",
      expectedStatus: "timeout",
      timeoutMilliseconds: 100,
    },
    "stdout-limit": {
      adapter: "fixture-stdout-flood",
      prompt: "bounded stdout flood",
      expectedStatus: "stdout-limit-exceeded",
    },
    "stderr-limit": {
      adapter: "fixture-stderr-flood",
      prompt: "bounded stderr flood",
      expectedStatus: "stderr-limit-exceeded",
    },
  };
  const selectedCase = fleetCases[scenario.input.case];
  if (!selectedCase) {
    throw new QualificationLabError(
      "QUALIFICATION_CAMPAIGN_INVALID",
      `Unsupported FleetRunner case: ${scenario.input.case}`,
    );
  }
  const runsRoot = join(scenarioDirectory, "fleet-runs");
  mkdirSync(runsRoot, { mode: 0o700 });
  const jobPath = join(scenarioDirectory, "fleet-job.json");
  writeExclusiveJson(jobPath, {
    schemaVersion: "1",
    adapter: selectedCase.adapter,
    activity: "qualification",
    prompt: selectedCase.prompt,
    timeoutMilliseconds:
      selectedCase.timeoutMilliseconds ?? 1000,
    outputContract: "fixture-result-v1",
  });
  const execution = spawnSync(
    process.execPath,
    [
      fileURLToPath(FLEET_WORKER_URL),
      jobPath,
      runsRoot,
      fileURLToPath(FLEET_MANIFEST_URL),
    ],
    {
      cwd: scenarioDirectory,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );
  let receipt;
  try {
    receipt = JSON.parse(execution.stdout);
  } catch {
    return {
      terminalState: "blocked",
      output: null,
      reason: "fleet-runner-invalid-receipt",
    };
  }
  if (
    receipt === null ||
    Array.isArray(receipt) ||
    typeof receipt !== "object"
  ) {
    return {
      terminalState: "blocked",
      output: null,
      reason: "fleet-runner-invalid-receipt",
    };
  }
  if (
    receipt.status !== selectedCase.expectedStatus ||
    (selectedCase.expectedNormalization &&
      receipt.outputContract?.normalization !==
        selectedCase.expectedNormalization)
  ) {
    return {
      terminalState: "blocked",
      output: null,
      reason: receipt.status ?? receipt.error?.code ??
        "fleet-runner-failed",
    };
  }
  if (selectedCase.expectedStatus !== "succeeded") {
    if (execution.status !== 1) {
      return {
        terminalState: "blocked",
        output: null,
        reason: "fleet-runner-worker-exit-mismatch",
      };
    }
    if (selectedCase.expectedStatus === "timeout") {
      spawnSync(
        process.execPath,
        ["-e", "setTimeout(() => {}, 700)"],
        {
          cwd: scenarioDirectory,
          env: {
            NO_COLOR: "1",
            TERM: "dumb",
          },
          timeout: 1000,
        },
      );
      const descendantMarker = join(
        runsRoot,
        receipt.runIdentity,
        "workspace",
        "descendant-survived.txt",
      );
      if (metadata(descendantMarker) !== null) {
        return {
          terminalState: "blocked",
          output: null,
          reason: "timeout-descendant-survived",
        };
      }
    }
    return {
      terminalState: "blocked",
      output: null,
      reason: selectedCase.expectedStatus,
    };
  }
  if (execution.status !== 0) {
    return {
      terminalState: "blocked",
      output: null,
      reason: "fleet-runner-worker-failed",
    };
  }
  return {
    terminalState: "passed",
    output: selectedCase.successOutput,
    reason: null,
  };
}

function fleetJob(adapter = "fixture-raw") {
  return {
    schemaVersion: "1",
    adapter,
    activity: "qualification",
    prompt: "bounded qualification prompt",
    timeoutMilliseconds: 1000,
    outputContract: "fixture-result-v1",
  };
}

function fleetPolicyCheck(
  label,
  job,
  manifest,
  expectedCode,
  manifestDirectory,
) {
  try {
    validateFleetJob(job, manifest, { manifestDirectory });
    return {
      label,
      expectedCode,
      observedCode: "accepted",
      matched: false,
    };
  } catch (error) {
    const observedCode = error instanceof FleetRunnerError
      ? error.code
      : "unexpected-error";
    return {
      label,
      expectedCode,
      observedCode,
      matched: observedCode === expectedCode,
    };
  }
}

function executeFleetPolicyScenario(
  scenario,
  scenarioDirectory,
  context,
) {
  const manifest = readJson(
    FLEET_MANIFEST_URL,
    "FleetRunner capability manifest",
  );
  const manifestDirectory = dirname(
    fileURLToPath(FLEET_MANIFEST_URL),
  );
  let checks;
  let reason;
  if (scenario.input.case === "job-authority") {
    const forbiddenFields = [
      "command",
      "argv",
      "shell",
      "tools",
      "environment",
      "workingDirectory",
      "recursiveDelegation",
    ];
    checks = forbiddenFields.map((field) => {
      const job = fleetJob();
      job[field] = field === "shell" ? true : "forbidden";
      return fleetPolicyCheck(
        `forbidden-${field}`,
        job,
        manifest,
        "FLEET_CONTRACT_INVALID",
        manifestDirectory,
      );
    });
    const promptJob = fleetJob();
    promptJob.prompt = "x".repeat(
      manifest.limits.maxPromptBytes + 1,
    );
    checks.push(
      fleetPolicyCheck(
        "prompt-limit",
        promptJob,
        manifest,
        "FLEET_PROMPT_LIMIT",
        manifestDirectory,
      ),
    );
    const timeoutJob = fleetJob();
    timeoutJob.timeoutMilliseconds =
      manifest.limits.maxTimeoutMilliseconds + 1;
    checks.push(
      fleetPolicyCheck(
        "timeout-limit",
        timeoutJob,
        manifest,
        "FLEET_TIMEOUT_INVALID",
        manifestDirectory,
      ),
    );
    const activityJob = fleetJob();
    activityJob.activity = "implementation";
    checks.push(
      fleetPolicyCheck(
        "activity",
        activityJob,
        manifest,
        "FLEET_ACTIVITY_BLOCKED",
        manifestDirectory,
      ),
    );
    const contractJob = fleetJob();
    contractJob.outputContract = "arbitrary-output";
    checks.push(
      fleetPolicyCheck(
        "output-contract",
        contractJob,
        manifest,
        "FLEET_OUTPUT_CONTRACT_BLOCKED",
        manifestDirectory,
      ),
    );
    reason = "job-contract-rejected";
  } else if (scenario.input.case === "adapter-state") {
    checks = [
      ["unknown-adapter", "FLEET_ADAPTER_UNKNOWN"],
      ["fixture-disabled", "FLEET_ADAPTER_DISABLED"],
      ["fixture-stale", "FLEET_ADAPTER_STALE"],
      ["fixture-blocked-gate", "FLEET_GATE_BLOCKED"],
      ["fixture-native", "FLEET_ADAPTER_NOT_LEAF"],
    ].map(([adapter, expectedCode]) =>
      fleetPolicyCheck(
        adapter,
        fleetJob(adapter),
        manifest,
        expectedCode,
        manifestDirectory,
      )
    );
    reason = "adapter-state-rejected";
  } else if (scenario.input.case === "native-write-boundaries") {
    const ambientNative = inspectNativeRuntimeBoundary(
      context.homeDirectory,
    );
    const nativeAdapters = Object.values(manifest.adapters).filter(
      ({ kind }) => kind === "native-subagent",
    );
    const externalWriters = Object.values(manifest.adapters).filter(
      ({ writeAccess }) => writeAccess === true,
    );
    checks = [
      {
        label: "native-gate",
        expectedCode: "blocked",
        observedCode: manifest.gates.native.status,
        matched: manifest.gates.native.status === "blocked",
      },
      {
        label: "write-gate",
        expectedCode: "blocked",
        observedCode: manifest.gates.write.status,
        matched: manifest.gates.write.status === "blocked",
      },
      {
        label: "native-runtime-switches",
        expectedCode: "disabled",
        observedCode:
          manifest.runtime.nativeAgentsEnabled === false &&
            manifest.runtime.multiAgentEnabled === false
            ? "disabled"
            : "enabled",
        matched:
          manifest.runtime.nativeAgentsEnabled === false &&
          manifest.runtime.multiAgentEnabled === false,
      },
      {
        label: "ambient-native-runtime",
        expectedCode: "blocked",
        observedCode: ambientNative.status,
        matched:
          ambientNative.status === "blocked" &&
          ambientNative.enabledEntryPoints.length === 0,
      },
      {
        label: "native-workers",
        expectedCode: "disabled",
        observedCode:
          nativeAdapters.length > 0 &&
            nativeAdapters.every(({ enabled }) => enabled === false)
            ? "disabled"
            : "enabled-or-missing",
        matched:
          nativeAdapters.length > 0 &&
          nativeAdapters.every(({ enabled }) => enabled === false),
      },
      {
        label: "external-writers",
        expectedCode: "zero",
        observedCode: String(externalWriters.length),
        matched:
          manifest.limits.externalWriterCount === 0 &&
          externalWriters.length === 0,
      },
    ];
    reason = "native-write-disabled";
  } else {
    throw new QualificationLabError(
      "QUALIFICATION_CAMPAIGN_INVALID",
      `Unsupported FleetRunner policy case: ${scenario.input.case}`,
    );
  }
  writeExclusiveJson(
    join(scenarioDirectory, "policy-checks.json"),
    {
      schemaVersion: "1",
      case: scenario.input.case,
      checks,
    },
  );
  if (!checks.every(({ matched }) => matched)) {
    return {
      terminalState: "blocked",
      output: null,
      reason: "fleet-policy-mismatch",
    };
  }
  return {
    terminalState: "blocked",
    output: null,
    reason,
  };
}

function executeScenario(scenario, scenarioDirectory, context) {
  if (scenario.driver === "uppercase") {
    return {
      terminalState: "passed",
      output: scenario.input.value.toUpperCase(),
      reason: null,
    };
  }
  if (scenario.driver === "fail-closed") {
    return {
      terminalState: "blocked",
      output: null,
      reason: `${scenario.input.boundary}-disabled`,
    };
  }
  if (scenario.driver === "validator-audit") {
    auditQualificationReceiptValidators();
    return {
      terminalState: "passed",
      output: "schema-and-behavior-audited",
      reason: null,
    };
  }
  if (scenario.driver === "fleet-runner") {
    return executeFleetScenario(scenario, scenarioDirectory);
  }
  if (scenario.driver === "fleet-policy") {
    return executeFleetPolicyScenario(
      scenario,
      scenarioDirectory,
      context,
    );
  }
  throw new QualificationLabError(
    "QUALIFICATION_CAMPAIGN_INVALID",
    `Unsupported qualification driver: ${scenario.driver}`,
  );
}

function compareObservation(expected, observed) {
  const mismatches = [];
  for (const field of ["terminalState", "output", "reason"]) {
    if (expected[field] !== observed[field]) {
      mismatches.push(
        `${field}: expected ${JSON.stringify(
          expected[field],
        )}, observed ${JSON.stringify(observed[field])}`,
      );
    }
  }
  return mismatches;
}

function buildIssue(campaign, runIdentity, scenario, result) {
  const identity = sha256(
    canonicalJson({
      schemaVersion: "1",
      campaign: campaign.campaign,
      scenario: scenario.id,
      category: scenario.category,
      mismatches: result.mismatches,
    }),
  ).slice(0, 16);
  return {
    id: `qual-${identity}`,
    scenario: scenario.id,
    category: scenario.category,
    severity: scenario.severity,
    expected: result.expected,
    observed: result.observed,
    mismatches: result.mismatches,
    evidence: result.evidence,
    reproduction:
      `codex-ground-control qualify reproduce ${runIdentity} ` +
      `${scenario.id} --json`,
    nextAction: scenario.nextAction,
    status: "open",
  };
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
        throw new QualificationLabError(
          "QUALIFICATION_EVIDENCE_UNSAFE",
          "Qualification evidence cannot contain symlinks.",
        );
      }
      if (current.isDirectory()) {
        visit(path);
      } else if (current.isFile()) {
        files.push(path);
      } else {
        throw new QualificationLabError(
          "QUALIFICATION_EVIDENCE_UNSAFE",
          "Qualification evidence contains an unsupported file type.",
        );
      }
    }
  };
  visit(root);
  return files.sort();
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

function evidenceReference(runIdentity, anchor) {
  return {
    index:
      `~/.codex-ground-control/evidence/qualification/` +
      `${runIdentity}/evidence-index.json`,
    anchor,
  };
}

function readEvidenceJson(runDirectory, relativePath, label) {
  let inspected;
  try {
    inspected = inspectFile(runDirectory, relativePath);
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_UNSAFE",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (inspected.state !== "file") {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_MISSING",
      `${label} is missing.`,
    );
  }
  return parseJson(inspected.contents, label);
}

function inspectEvidenceFile(runDirectory, relativePath, label) {
  let inspected;
  try {
    inspected = inspectFile(runDirectory, relativePath);
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_UNSAFE",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (inspected.state !== "file") {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_MISSING",
      `${label} is missing.`,
    );
  }
  return inspected;
}

function validateEvidenceIndex(index, runIdentity) {
  if (
    !hasExactKeys(index, [
      "schemaVersion",
      "runIdentity",
      "algorithm",
      "entryCount",
      "entries",
    ]) ||
    index.schemaVersion !== "1" ||
    index.runIdentity !== runIdentity ||
    index.algorithm !== "sha256" ||
    !Number.isInteger(index.entryCount) ||
    !Array.isArray(index.entries) ||
    index.entryCount !== index.entries.length
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
      "Qualification evidence index has an invalid structure.",
    );
  }
  const paths = new Set();
  for (const entry of index.entries) {
    if (
      !hasExactKeys(entry, ["path", "bytes", "sha256"]) ||
      !validEvidencePath(entry.path) ||
      !Number.isInteger(entry.bytes) ||
      entry.bytes < 0 ||
      !/^[0-9a-f]{64}$/.test(entry.sha256) ||
      paths.has(entry.path)
    ) {
      throw new QualificationLabError(
        "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
        "Qualification evidence index contains an invalid entry.",
      );
    }
    paths.add(entry.path);
  }
  return paths;
}

function verifyIndexedFiles(runDirectory, index, indexedPaths) {
  for (const entry of index.entries) {
    const inspected = inspectEvidenceFile(
      runDirectory,
      entry.path,
      `Qualification evidence ${entry.path}`,
    );
    if (
      inspected.contents.byteLength !== entry.bytes ||
      inspected.sha256 !== entry.sha256
    ) {
      throw new QualificationLabError(
        "QUALIFICATION_EVIDENCE_HASH_MISMATCH",
        `Qualification evidence hash mismatch: ${entry.path}`,
      );
    }
  }

  const actualPaths = listEvidenceFiles(runDirectory)
    .map((path) => portablePath(relative(runDirectory, path)))
    .filter((path) => path !== "evidence-index.json");
  for (const path of actualPaths) {
    if (!indexedPaths.has(path)) {
      throw new QualificationLabError(
        "QUALIFICATION_EVIDENCE_UNINDEXED_FILE",
        `Qualification evidence contains an unindexed file: ${path}`,
      );
    }
  }
}

function validateEvidenceDocuments(runDirectory, runIdentity) {
  const campaign = readEvidenceJson(
    runDirectory,
    "campaign.json",
    "campaign evidence",
  );
  const results = readEvidenceJson(
    runDirectory,
    "results.json",
    "result evidence",
  );
  const issues = readEvidenceJson(
    runDirectory,
    "issues.json",
    "issue evidence",
  );
  const request = readEvidenceJson(
    runDirectory,
    "request.json",
    "request evidence",
  );
  const summary = readEvidenceJson(
    runDirectory,
    "summary.json",
    "summary evidence",
  );
  try {
    assertQualificationDocument("campaign", campaign);
    assertQualificationDocument("result", results);
    assertQualificationDocument("issues", issues);
    validateCampaignSemantics(campaign);
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  const expectedResults = campaign.scenarios.map(
    (scenario, index) => {
      const result = results.results[index];
      if (!result) {
        return null;
      }
      const mismatches = compareObservation(
        scenario.expected,
        result.observed,
      );
      return {
        scenario: scenario.id,
        category: scenario.category,
        driver: scenario.driver,
        matched: mismatches.length === 0,
        mismatches,
        expected: scenario.expected,
        observed: result.observed,
        evidence:
          `scenarios/${scenario.id}/observation.json`,
      };
    },
  );
  const expectedIssues = expectedResults
    .map((result, index) =>
      result && !result.matched
        ? buildIssue(
            campaign,
            runIdentity,
            campaign.scenarios[index],
            result,
          )
        : null
    )
    .filter(Boolean);
  if (
    results.runIdentity !== runIdentity ||
    issues.runIdentity !== runIdentity ||
    results.campaign !== campaign.campaign ||
    issues.campaign !== campaign.campaign ||
    issues.openCount !== issues.issues.length ||
    canonicalJson(results.results) !==
      canonicalJson(expectedResults) ||
    canonicalJson(issues.issues) !==
      canonicalJson(expectedIssues) ||
    results.counts.total !== results.results.length ||
    results.counts.passed !==
      results.results.filter((result) => result.matched).length ||
    results.counts.failed !==
      results.results.filter((result) => !result.matched).length ||
    results.terminalState !==
      (results.counts.failed === 0 ? "passed" : "failed") ||
    Date.parse(results.startedAt) > Date.parse(results.finishedAt) ||
    !hasExactKeys(summary, [
      "schemaVersion",
      "campaign",
      "runIdentity",
      "terminalState",
      "counts",
      "issueCount",
    ]) ||
    summary.schemaVersion !== "1" ||
    summary.campaign !== campaign.campaign ||
    summary.runIdentity !== runIdentity ||
    summary.terminalState !== results.terminalState ||
    canonicalJson(summary.counts) !== canonicalJson(results.counts) ||
    summary.issueCount !== issues.openCount ||
    !hasExactKeys(
      request,
      request.operation === "reproduce"
        ? [
            "schemaVersion",
            "operation",
            "campaign",
            "campaignScope",
            "selection",
            "sourceRun",
            "network",
          ]
        : [
            "schemaVersion",
            "operation",
            "campaign",
            "campaignScope",
            "selection",
            "network",
          ],
    ) ||
    request.schemaVersion !== "1" ||
    !["run", "reproduce"].includes(request.operation) ||
    request.campaign !== campaign.campaign ||
    request.campaignScope !== results.campaignScope ||
    request.network !== "disabled" ||
    (request.operation === "run" && request.selection !== "all") ||
    (request.operation === "reproduce" &&
      (typeof request.sourceRun !== "string" ||
        request.sourceRun === runIdentity ||
        campaign.scenarios.length !== 1 ||
        request.selection !== campaign.scenarios[0].id))
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
      "Qualification evidence documents disagree.",
    );
  }

  for (const result of results.results) {
    const observation = readEvidenceJson(
      runDirectory,
      result.evidence,
      `observation evidence for ${result.scenario}`,
    );
    if (
      !hasExactKeys(observation, [
        "schemaVersion",
        "scenario",
        "expected",
        "observed",
        "matched",
        "mismatches",
      ]) ||
      observation.schemaVersion !== "1" ||
      observation.scenario !== result.scenario ||
      canonicalJson(observation.expected) !==
        canonicalJson(result.expected) ||
      canonicalJson(observation.observed) !==
        canonicalJson(result.observed) ||
      observation.matched !== result.matched ||
      canonicalJson(observation.mismatches) !==
        canonicalJson(result.mismatches)
    ) {
      throw new QualificationLabError(
        "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
        `Qualification observation disagrees: ${result.scenario}`,
      );
    }
  }
  return { campaign, results };
}

export function verifyOfflineQualification(options = {}) {
  const { runIdentity, anchor } = options;
  if (
    typeof runIdentity !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(runIdentity) ||
    typeof anchor !== "string" ||
    !/^[0-9a-f]{64}$/.test(anchor)
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_REFERENCE_INVALID",
      "Qualification evidence reference is invalid.",
    );
  }
  const runsRoot = existingQualificationRunsRoot(
    options.homeDirectory,
  );
  const runDirectory = join(runsRoot, runIdentity);
  requireDirectory(runDirectory, "Qualification run");
  const indexFile = inspectEvidenceFile(
    runDirectory,
    "evidence-index.json",
    "Qualification evidence index",
  );
  if (indexFile.sha256 !== anchor) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_ANCHOR_MISMATCH",
      "Qualification evidence index does not match the external anchor.",
    );
  }

  const index = readEvidenceJson(
    runDirectory,
    "evidence-index.json",
    "evidence index",
  );
  const indexedPaths = validateEvidenceIndex(index, runIdentity);
  verifyIndexedFiles(runDirectory, index, indexedPaths);
  const { campaign, results } = validateEvidenceDocuments(
    runDirectory,
    runIdentity,
  );
  const runtime = readEvidenceJson(
    runDirectory,
    "runtime.json",
    "runtime evidence",
  );
  if (
    !hasExactKeys(runtime, [
      "schemaVersion",
      "node",
      "platform",
      "architecture",
      "packageVersion",
      "nativeRuntime",
      "components",
      "fingerprint",
    ]) ||
    runtime.schemaVersion !== "1" ||
    typeof runtime.node !== "string" ||
    typeof runtime.platform !== "string" ||
    typeof runtime.architecture !== "string" ||
    runtime.packageVersion !== PACKAGE_VERSION ||
    !validNativeRuntimeBoundary(runtime.nativeRuntime) ||
    !/^[0-9a-f]{64}$/.test(runtime.fingerprint) ||
    !Array.isArray(runtime.components) ||
    runtime.components.some(
      (component) =>
        !hasExactKeys(component, [
          "id",
          "path",
          "bytes",
          "sha256",
        ]) ||
        typeof component.id !== "string" ||
        !validEvidencePath(component.path) ||
        !Number.isInteger(component.bytes) ||
        component.bytes < 0 ||
        !/^[0-9a-f]{64}$/.test(component.sha256),
    ) ||
    new Set(runtime.components.map((component) => component.id))
      .size !== runtime.components.length ||
    sha256(
      canonicalJson({
        node: runtime.node,
        platform: runtime.platform,
        architecture: runtime.architecture,
        packageVersion: runtime.packageVersion,
        nativeRuntime: runtime.nativeRuntime,
        components: runtime.components,
      }),
    ) !== runtime.fingerprint ||
    results.runtimeFingerprint !== runtime.fingerprint
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
      "Qualification runtime evidence has an invalid structure.",
    );
  }
  const currentFingerprint = captureRuntime(
    options.homeDirectory,
  ).fingerprint;
  const drifted = currentFingerprint !== runtime.fingerprint;
  return {
    schemaVersion: "1",
    operation: "verify",
    campaign: campaign.campaign,
    terminalState: drifted
      ? "qualification-drifted"
      : "evidence-verified",
    campaignScope: "evidence",
    counts: results.counts,
    runIdentity,
    evidence: evidenceReference(runIdentity, anchor),
    runtimeFingerprint: runtime.fingerprint,
    network: "not-used",
  };
}

export function reproduceOfflineQualification(options = {}) {
  const { sourceRun, scenarioId } = options;
  if (
    typeof sourceRun !== "string" ||
    !/^[a-zA-Z0-9-]+$/.test(sourceRun) ||
    typeof scenarioId !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,79}$/.test(scenarioId)
  ) {
    throw new QualificationLabError(
      "QUALIFICATION_REPRODUCTION_INVALID",
      "Qualification reproduction reference is invalid.",
    );
  }
  const runsRoot = existingQualificationRunsRoot(
    options.homeDirectory,
  );
  const sourceDirectory = join(runsRoot, sourceRun);
  requireDirectory(sourceDirectory, "Source qualification run");
  const indexFile = inspectEvidenceFile(
    sourceDirectory,
    "evidence-index.json",
    "Source qualification evidence index",
  );
  verifyOfflineQualification({
    homeDirectory: options.homeDirectory,
    runIdentity: sourceRun,
    anchor: indexFile.sha256,
  });
  const sourceCampaign = readEvidenceJson(
    sourceDirectory,
    "campaign.json",
    "source campaign evidence",
  );
  const scenario = sourceCampaign.scenarios.find(
    (candidate) => candidate.id === scenarioId,
  );
  if (!scenario) {
    throw new QualificationLabError(
      "QUALIFICATION_SCENARIO_UNKNOWN",
      `Unknown qualification scenario: ${scenarioId}`,
    );
  }
  return runOfflineQualification({
    homeDirectory: options.homeDirectory,
    operation: "reproduce",
    sourceRun,
    sourceScenario: scenarioId,
    campaign: {
      ...sourceCampaign,
      scenarios: [scenario],
    },
  });
}

export function runOfflineQualification(options = {}) {
  const operation = options.operation ?? "run";
  const campaign = options.campaign ?? loadCampaign();
  try {
    assertQualificationDocument("campaign", campaign);
    validateCampaignSemantics(campaign);
  } catch (error) {
    if (error instanceof QualificationLabError) {
      throw error;
    }
    throw new QualificationLabError(
      "QUALIFICATION_CAMPAIGN_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    auditQualificationReceiptValidators();
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_VALIDATOR_DRIFT",
      error instanceof Error ? error.message : String(error),
    );
  }

  const startedAt = new Date().toISOString();
  const runIdentity =
    `${startedAt.replaceAll(/[:.]/g, "-")}-` +
    `${campaign.campaign}-${randomUUID()}`;
  const runsRoot = ensureQualificationRunsRoot(
    options.homeDirectory,
  );
  const runDirectory = join(runsRoot, runIdentity);
  mkdirSync(runDirectory, { mode: 0o700 });
  mkdirSync(join(runDirectory, "scenarios"), { mode: 0o700 });

  const runtime = captureRuntime(options.homeDirectory);
  const request = {
    schemaVersion: "1",
    operation,
    campaign: campaign.campaign,
    campaignScope:
      operation === "reproduce"
        ? "single-scenario"
        : "release-full",
    selection:
      operation === "reproduce"
        ? options.sourceScenario
        : "all",
    ...(operation === "reproduce"
      ? { sourceRun: options.sourceRun }
      : {}),
    network: "disabled",
  };
  writeExclusiveJson(join(runDirectory, "request.json"), request);
  writeExclusiveJson(join(runDirectory, "campaign.json"), campaign);
  writeExclusiveJson(join(runDirectory, "runtime.json"), runtime);

  const results = [];
  for (const scenario of campaign.scenarios) {
    const scenarioDirectory = join(
      runDirectory,
      "scenarios",
      scenario.id,
    );
    mkdirSync(scenarioDirectory, { mode: 0o700 });
    const observed = executeScenario(
      scenario,
      scenarioDirectory,
      {
        homeDirectory: options.homeDirectory,
      },
    );
    const mismatches = compareObservation(
      scenario.expected,
      observed,
    );
    const evidence =
      `scenarios/${scenario.id}/observation.json`;
    const result = {
      scenario: scenario.id,
      category: scenario.category,
      driver: scenario.driver,
      matched: mismatches.length === 0,
      mismatches,
      expected: scenario.expected,
      observed,
      evidence,
    };
    writeExclusiveJson(
      join(scenarioDirectory, "observation.json"),
      {
        schemaVersion: "1",
        scenario: scenario.id,
        expected: scenario.expected,
        observed,
        matched: result.matched,
        mismatches,
      },
    );
    results.push(result);
  }

  const passed = results.filter((result) => result.matched).length;
  const counts = {
    total: results.length,
    passed,
    failed: results.length - passed,
  };
  const finishedAt = new Date().toISOString();
  const resultsDocument = {
    schemaVersion: "1",
    campaign: campaign.campaign,
    runIdentity,
    startedAt,
    finishedAt,
    campaignScope:
      operation === "reproduce"
        ? "single-scenario"
        : "release-full",
    runtimeFingerprint: runtime.fingerprint,
    terminalState: counts.failed === 0 ? "passed" : "failed",
    counts,
    results,
  };
  try {
    assertQualificationDocument("result", resultsDocument);
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_RESULT_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  writeExclusiveJson(
    join(runDirectory, "results.json"),
    resultsDocument,
  );

  const issues = results
    .map((result) => {
      if (result.matched) {
        return null;
      }
      const scenario = campaign.scenarios.find(
        (candidate) => candidate.id === result.scenario,
      );
      return buildIssue(campaign, runIdentity, scenario, result);
    })
    .filter(Boolean);
  const issueLedger = {
    schemaVersion: "1",
    campaign: campaign.campaign,
    runIdentity,
    generatedAt: finishedAt,
    openCount: issues.length,
    issues,
  };
  try {
    assertQualificationDocument("issues", issueLedger);
  } catch (error) {
    throw new QualificationLabError(
      "QUALIFICATION_ISSUES_INVALID",
      error instanceof Error ? error.message : String(error),
    );
  }
  writeExclusiveJson(
    join(runDirectory, "issues.json"),
    issueLedger,
  );
  writeExclusiveJson(join(runDirectory, "summary.json"), {
    schemaVersion: "1",
    campaign: campaign.campaign,
    runIdentity,
    terminalState: resultsDocument.terminalState,
    counts,
    issueCount: issues.length,
  });

  const anchor = writeEvidenceIndex(runDirectory, runIdentity);
  return {
    schemaVersion: "1",
    operation,
    campaign: campaign.campaign,
    terminalState:
      operation === "reproduce"
        ? counts.failed === 0
          ? "reproduction-passed"
          : "reproduction-failed"
        : counts.failed === 0
          ? "release-passed"
          : "release-failed",
    campaignScope:
      operation === "reproduce"
        ? "single-scenario"
        : "release-full",
    counts,
    runIdentity,
    evidence: evidenceReference(runIdentity, anchor),
    runtimeFingerprint: runtime.fingerprint,
    network: "not-used",
  };
}

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  copyFileSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  unlinkSync,
  writeSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from "node:path";

const JOB_KEYS = [
  "schemaVersion",
  "adapter",
  "activity",
  "prompt",
  "timeoutMilliseconds",
  "outputContract",
];
const MANIFEST_KEYS = [
  "schemaVersion",
  "architecture",
  "coordinator",
  "runtime",
  "gates",
  "limits",
  "recursiveDelegation",
  "outputContracts",
  "adapters",
];
const RESERVED_ENVIRONMENT = new Set(["NO_COLOR", "TERM"]);
const LIMIT_CEILINGS = {
  maxPromptBytes: 256_000,
  maxTimeoutMilliseconds: 3_600_000,
  maxStdoutBytes: 1_000_000,
  maxStderrBytes: 1_000_000,
};

export class FleetRunnerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "FleetRunnerError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new FleetRunnerError(code, message);
}

function isObject(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object"
  );
}

function exactKeys(value, required, optional, label) {
  if (!isObject(value)) {
    fail("FLEET_CONTRACT_INVALID", `${label} must be an object.`);
  }
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail(
      "FLEET_CONTRACT_INVALID",
      `${label} has unexpected or missing fields.`,
    );
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    fail("FLEET_CONTRACT_INVALID", `${label} must be non-empty.`);
  }
}

function uniqueStrings(value, label) {
  if (!Array.isArray(value)) {
    fail("FLEET_CONTRACT_INVALID", `${label} must be an array.`);
  }
  const seen = new Set();
  for (const [index, item] of value.entries()) {
    nonEmptyString(item, `${label}[${index}]`);
    if (seen.has(item)) {
      fail(
        "FLEET_CONTRACT_INVALID",
        `${label} contains a duplicate value.`,
      );
    }
    seen.add(item);
  }
}

function validateManifestBoundaries(manifest) {
  exactKeys(manifest, MANIFEST_KEYS, [], "manifest");
  if (
    manifest.schemaVersion !== "1" ||
    manifest.architecture !== "single-codex-coordinator"
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "The capability manifest architecture is unsupported.",
    );
  }
  exactKeys(
    manifest.coordinator,
    ["id", "soleWriter", "soleCompletionAuthority"],
    [],
    "manifest.coordinator",
  );
  if (
    manifest.coordinator.id !== "codex-main" ||
    manifest.coordinator.soleWriter !== true ||
    manifest.coordinator.soleCompletionAuthority !== true
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "The sole Codex coordinator boundary is not active.",
    );
  }
  exactKeys(
    manifest.runtime,
    ["nativeAgentsEnabled", "multiAgentEnabled"],
    [],
    "manifest.runtime",
  );
  if (
    manifest.runtime.nativeAgentsEnabled !== false ||
    manifest.runtime.multiAgentEnabled !== false
  ) {
    fail(
      "FLEET_NATIVE_GATE_OPEN",
      "Native agent runtime entry points must remain disabled.",
    );
  }
  exactKeys(
    manifest.recursiveDelegation,
    ["allowed"],
    [],
    "manifest.recursiveDelegation",
  );
  if (manifest.recursiveDelegation.allowed !== false) {
    fail(
      "FLEET_RECURSION_ALLOWED",
      "Recursive delegation must remain disabled.",
    );
  }
  if (
    !isObject(manifest.gates) ||
    ["core", "native", "write"].some(
      (gateName) => !Object.hasOwn(manifest.gates, gateName)
    )
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "Manifest must define core, native and write gates.",
    );
  }
  for (const [gateName, gate] of Object.entries(manifest.gates)) {
    exactKeys(
      gate,
      ["status"],
      ["reason"],
      `manifest.gates.${gateName}`,
    );
    if (
      !["blocked", "passed", "pending", "unavailable"].includes(
        gate.status,
      ) ||
      (gate.reason !== undefined &&
        (typeof gate.reason !== "string" ||
          gate.reason.trim() === ""))
    ) {
      fail(
        "FLEET_MANIFEST_INVALID",
        `Manifest gate ${gateName} has an invalid state.`,
      );
    }
  }
  if (
    manifest.gates.native.status !== "blocked" ||
    manifest.gates.write.status !== "blocked"
  ) {
    fail(
      "FLEET_BOUNDARY_GATE_OPEN",
      "Native and external write gates must remain blocked.",
    );
  }
  exactKeys(
    manifest.limits,
    [
      "maxPromptBytes",
      "maxTimeoutMilliseconds",
      "maxStdoutBytes",
      "maxStderrBytes",
      "externalWriterCount",
    ],
    [],
    "manifest.limits",
  );
  for (const key of [
    "maxPromptBytes",
    "maxTimeoutMilliseconds",
    "maxStdoutBytes",
    "maxStderrBytes",
  ]) {
    if (
      !Number.isInteger(manifest.limits[key]) ||
      manifest.limits[key] < 1 ||
      manifest.limits[key] > LIMIT_CEILINGS[key]
    ) {
      fail(
        "FLEET_MANIFEST_INVALID",
        `manifest.limits.${key} must be a positive integer within the product ceiling.`,
      );
    }
  }
  if (manifest.limits.externalWriterCount !== 0) {
    fail(
      "FLEET_WRITE_GATE_OPEN",
      "External writer count must remain zero.",
    );
  }
  if (
    !isObject(manifest.outputContracts) ||
    !isObject(manifest.adapters)
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "Manifest contracts and adapters must be objects.",
    );
  }
}

function validateOutputContract(name, contract) {
  nonEmptyString(name, "job.outputContract");
  exactKeys(
    contract,
    ["type", "required", "additionalProperties"],
    [],
    `manifest.outputContracts.${name}`,
  );
  if (
    contract.type !== "object" ||
    contract.additionalProperties !== false ||
    !isObject(contract.required) ||
    Object.keys(contract.required).length === 0
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      `Output contract ${name} is not strict.`,
    );
  }
  const allowedTypes = new Set([
    "array",
    "boolean",
    "null",
    "number",
    "object",
    "string",
  ]);
  for (const [key, type] of Object.entries(contract.required)) {
    nonEmptyString(key, `manifest.outputContracts.${name}.required key`);
    if (!allowedTypes.has(type)) {
      fail(
        "FLEET_MANIFEST_INVALID",
        `Output contract ${name} contains an unsupported type.`,
      );
    }
  }
}

function resolveManifestPath(value, manifestDirectory, label) {
  const prefix = "{manifest_dir}/";
  if (
    typeof value !== "string" ||
    !value.startsWith(prefix) ||
    value.slice(prefix.length).includes("{")
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      `${label} contains an unsupported placeholder.`,
    );
  }
  const relativePath = value.slice(prefix.length);
  const resolved = resolve(manifestDirectory, relativePath);
  if (
    resolved === manifestDirectory ||
    !resolved.startsWith(`${manifestDirectory}${sep}`)
  ) {
    fail("FLEET_MANIFEST_INVALID", `${label} escapes manifest_dir.`);
  }
  let current = manifestDirectory;
  try {
    const manifestMetadata = lstatSync(current);
    if (
      manifestMetadata.isSymbolicLink() ||
      !manifestMetadata.isDirectory()
    ) {
      fail(
        "FLEET_MANIFEST_INVALID",
        "Manifest directory must be a plain directory.",
      );
    }
    for (const part of relativePath.split("/")) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) {
        fail(
          "FLEET_MANIFEST_INVALID",
          `${label} cannot contain symlinks.`,
        );
      }
    }
    const canonicalRoot = realpathSync(manifestDirectory);
    const canonicalPath = realpathSync(resolved);
    if (!canonicalPath.startsWith(`${canonicalRoot}${sep}`)) {
      fail(
        "FLEET_MANIFEST_INVALID",
        `${label} escapes the canonical manifest directory.`,
      );
    }
    return canonicalPath;
  } catch (error) {
    if (error instanceof FleetRunnerError) {
      throw error;
    }
    fail(
      "FLEET_MANIFEST_INVALID",
      `${label} is unavailable or unsafe.`,
    );
  }
}

function resolveExecutorArgument(
  argument,
  prompt,
  manifestDirectory,
) {
  if (argument === "{prompt}") {
    return prompt;
  }
  if (typeof argument === "string" && argument.includes("{")) {
    return resolveManifestPath(
      argument,
      manifestDirectory,
      "executor.args",
    );
  }
  nonEmptyString(argument, "executor.args item");
  return argument;
}

function resolveExecutorCommand(command, manifestDirectory) {
  if (command === "{node}") {
    return {
      command: process.execPath,
      commandLabel: "node",
    };
  }
  if (
    typeof command === "string" &&
    command.startsWith("{manifest_dir}/")
  ) {
    return {
      command: resolveManifestPath(
        command,
        manifestDirectory,
        "executor.command",
      ),
      commandLabel: command,
    };
  }
  if (
    typeof command !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,127}$/.test(command)
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "Executor command must be a fixed executable name or manifest path.",
    );
  }
  return {
    command,
    commandLabel: command,
  };
}

function validateExecutor(executor, prompt, manifestDirectory) {
  exactKeys(
    executor,
    [
      "command",
      "args",
      "workingDirectory",
      "environmentAllowlist",
    ],
    [],
    "adapter.executor",
  );
  const resolvedCommand = resolveExecutorCommand(
    executor.command,
    manifestDirectory,
  );
  uniqueStrings(executor.args, "adapter.executor.args");
  if (
    executor.args.filter((argument) => argument === "{prompt}")
      .length !== 1
  ) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "Executor args must contain exactly one prompt slot.",
    );
  }
  const args = executor.args.map((argument) =>
    resolveExecutorArgument(argument, prompt, manifestDirectory)
  );
  if (!isObject(executor.workingDirectory)) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "Executor working directory policy is invalid.",
    );
  }
  const workingDirectoryPolicy =
    executor.workingDirectory.policy;
  let workspaceSource = null;
  if (workingDirectoryPolicy === "isolated-empty") {
    exactKeys(
      executor.workingDirectory,
      ["policy"],
      [],
      "adapter.executor.workingDirectory",
    );
  } else if (workingDirectoryPolicy === "workspace-copy") {
    exactKeys(
      executor.workingDirectory,
      ["policy", "source"],
      [],
      "adapter.executor.workingDirectory",
    );
    workspaceSource = resolveManifestPath(
      executor.workingDirectory.source,
      manifestDirectory,
      "executor.workingDirectory.source",
    );
  } else {
    fail(
      "FLEET_MANIFEST_INVALID",
      "Executor working directory policy is unsupported.",
    );
  }
  uniqueStrings(
    executor.environmentAllowlist,
    "adapter.executor.environmentAllowlist",
  );
  for (const name of executor.environmentAllowlist) {
    if (
      !/^[A-Z][A-Z0-9_]*$/.test(name) ||
      RESERVED_ENVIRONMENT.has(name)
    ) {
      fail(
        "FLEET_MANIFEST_INVALID",
        "Executor environment allowlist contains an invalid name.",
      );
    }
  }
  return {
    ...resolvedCommand,
    args,
    workingDirectoryPolicy,
    workspaceSource,
    environmentAllowlist: executor.environmentAllowlist,
  };
}

export function validateFleetJob(
  job,
  manifest,
  options = {},
) {
  exactKeys(job, JOB_KEYS, [], "job");
  validateManifestBoundaries(manifest);
  if (job.schemaVersion !== "1") {
    fail(
      "FLEET_JOB_INVALID",
      "The FleetRunner job schema version is unsupported.",
    );
  }
  nonEmptyString(job.adapter, "job.adapter");
  nonEmptyString(job.activity, "job.activity");
  nonEmptyString(job.prompt, "job.prompt");
  if (
    Buffer.byteLength(job.prompt, "utf8") >
    manifest.limits.maxPromptBytes
  ) {
    fail(
      "FLEET_PROMPT_LIMIT",
      "The FleetRunner prompt exceeds its byte limit.",
    );
  }
  if (
    !Number.isInteger(job.timeoutMilliseconds) ||
    job.timeoutMilliseconds < 1 ||
    job.timeoutMilliseconds >
      manifest.limits.maxTimeoutMilliseconds
  ) {
    fail(
      "FLEET_TIMEOUT_INVALID",
      "The FleetRunner timeout is outside the allowed range.",
    );
  }
  const adapter = manifest.adapters[job.adapter];
  if (!adapter) {
    fail("FLEET_ADAPTER_UNKNOWN", "The requested adapter is unknown.");
  }
  exactKeys(
    adapter,
    [
      "kind",
      "enabled",
      "qualification",
      "gate",
      "mode",
      "activities",
      "outputContracts",
      "writeAccess",
      "recursiveDelegation",
    ],
    ["executor", "disabledReason"],
    `manifest.adapters.${job.adapter}`,
  );
  if (adapter.kind !== "leaf-adapter") {
    fail(
      "FLEET_ADAPTER_NOT_LEAF",
      "The requested worker is not a leaf adapter.",
    );
  }
  if (adapter.enabled !== true) {
    fail("FLEET_ADAPTER_DISABLED", "The requested adapter is disabled.");
  }
  if (adapter.qualification !== "current") {
    fail(
      "FLEET_ADAPTER_STALE",
      "The requested adapter qualification is not current.",
    );
  }
  nonEmptyString(adapter.gate, "adapter.gate");
  if (manifest.gates[adapter.gate]?.status !== "passed") {
    fail(
      "FLEET_GATE_BLOCKED",
      "The requested adapter gate is not passed.",
    );
  }
  uniqueStrings(adapter.activities, "adapter.activities");
  if (!adapter.activities.includes(job.activity)) {
    fail(
      "FLEET_ACTIVITY_BLOCKED",
      "The requested adapter activity is not allowed.",
    );
  }
  uniqueStrings(adapter.outputContracts, "adapter.outputContracts");
  if (!adapter.outputContracts.includes(job.outputContract)) {
    fail(
      "FLEET_OUTPUT_CONTRACT_BLOCKED",
      "The requested output contract is not allowed.",
    );
  }
  if (
    adapter.writeAccess !== false ||
    adapter.recursiveDelegation !== false
  ) {
    fail(
      "FLEET_ADAPTER_AUTHORITY_INVALID",
      "Leaf adapters cannot write externally or recursively delegate.",
    );
  }
  const outputContract = manifest.outputContracts[job.outputContract];
  if (!outputContract) {
    fail(
      "FLEET_OUTPUT_CONTRACT_UNKNOWN",
      "The requested output contract is unknown.",
    );
  }
  validateOutputContract(job.outputContract, outputContract);
  if (!adapter.executor) {
    fail(
      "FLEET_MANIFEST_INVALID",
      "The requested adapter has no executor.",
    );
  }
  const manifestDirectory = resolve(
    options.manifestDirectory ?? process.cwd(),
  );
  const executor = validateExecutor(
    adapter.executor,
    job.prompt,
    manifestDirectory,
  );
  return { adapter, executor, outputContract };
}

function safeRunsRoot(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) {
    fail(
      "FLEET_RUNS_ROOT_INVALID",
      "FleetRunner requires an existing runs root.",
    );
  }
  const resolved = resolve(candidate);
  const broadRootCandidates = [
    parse(resolved).root,
    resolve(homedir()),
    resolve(tmpdir()),
    resolve("/tmp"),
    resolve("/var/tmp"),
  ];
  const broadRoots = new Set();
  for (const root of broadRootCandidates) {
    broadRoots.add(root);
    try {
      broadRoots.add(realpathSync(root));
    } catch {
      // A missing platform-specific broad root needs no canonical alias.
    }
  }
  if (broadRoots.has(resolved)) {
    fail(
      "FLEET_RUNS_ROOT_UNSAFE",
      "FleetRunner runs root is too broad.",
    );
  }
  let current;
  try {
    current = lstatSync(resolved);
  } catch {
    fail(
      "FLEET_RUNS_ROOT_INVALID",
      "FleetRunner runs root must exist.",
    );
  }
  if (current.isSymbolicLink() || !current.isDirectory()) {
    fail(
      "FLEET_RUNS_ROOT_UNSAFE",
      "FleetRunner runs root must be a plain directory.",
    );
  }
  const canonical = realpathSync(resolved);
  if (broadRoots.has(canonical)) {
    fail(
      "FLEET_RUNS_ROOT_UNSAFE",
      "FleetRunner runs root is too broad.",
    );
  }
  return canonical;
}

function sanitizedEnvironment(allowlist) {
  const environment = {
    NO_COLOR: "1",
    TERM: "dumb",
  };
  for (const name of allowlist) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

function terminateProcessGroup(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      child.kill(signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if (error?.code === "ESRCH") {
      return;
    }
    if (error?.code === "EPERM") {
      try {
        if (child.kill(signal) === false) {
          return;
        }
      } catch (directError) {
        if (directError?.code === "ESRCH") {
          return;
        }
      }
    }
    throw error;
  }
}

function runChild(
  command,
  args,
  options,
  timeoutMilliseconds,
  limits,
  emitEvent,
) {
  return new Promise((resolveChild) => {
    const started = Date.now();
    const stdout = { chunks: [], bytes: 0 };
    const stderr = { chunks: [], bytes: 0 };
    let stopReason = null;
    let spawnError = null;
    let terminationError = null;
    let escalationTimer = null;
    let closed = null;

    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    emitEvent("process.started");

    const finish = () => {
      if (!closed || escalationTimer !== null) {
        return;
      }
      const effectiveStopReason =
        terminationError !== null &&
        closed.exitCode === null
          ? "process-group-termination-failed"
          : stopReason;
      const result = {
        stdout: Buffer.concat(stdout.chunks, stdout.bytes),
        stderr: Buffer.concat(stderr.chunks, stderr.bytes),
        exitCode: closed.exitCode,
        signal: closed.signal,
        stopReason: effectiveStopReason,
        spawnError: spawnError ?? terminationError,
        durationMilliseconds: Date.now() - started,
      };
      emitEvent("process.exited", {
        exitCode: result.exitCode,
        signal: result.signal,
        stopReason: result.stopReason,
        stdoutBytes: stdout.bytes,
        stderrBytes: stderr.bytes,
        durationMilliseconds: result.durationMilliseconds,
      });
      resolveChild(result);
    };

    const stop = (reason) => {
      if (stopReason === null) {
        stopReason = reason;
      }
      try {
        terminateProcessGroup(child, "SIGTERM");
      } catch (error) {
        terminationError = error;
      }
      if (escalationTimer === null) {
        escalationTimer = setTimeout(
          () => {
            try {
              terminateProcessGroup(child, "SIGKILL");
            } catch (error) {
              terminationError = error;
            } finally {
              escalationTimer = null;
              finish();
            }
          },
          100,
        );
      }
    };

    const append = (state, chunk, maximum, reason) => {
      if (stopReason !== null) {
        return;
      }
      const remaining = maximum - state.bytes;
      const accepted = Math.min(chunk.byteLength, remaining);
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          state.chunks.push(chunk.subarray(0, remaining));
          state.bytes += remaining;
        }
        if (accepted > 0) {
          emitEvent("process.output", {
            stream: state === stdout ? "stdout" : "stderr",
            chunkBytes: accepted,
            totalBytes: state.bytes,
          });
        }
        stop(reason);
        return;
      }
      state.chunks.push(chunk);
      state.bytes += chunk.byteLength;
      emitEvent("process.output", {
        stream: state === stdout ? "stdout" : "stderr",
        chunkBytes: accepted,
        totalBytes: state.bytes,
      });
    };

    child.stdout.on("data", (chunk) =>
      append(
        stdout,
        chunk,
        limits.maxStdoutBytes,
        "stdout-limit-exceeded",
      )
    );
    child.stderr.on("data", (chunk) =>
      append(
        stderr,
        chunk,
        limits.maxStderrBytes,
        "stderr-limit-exceeded",
      )
    );
    child.on("error", (error) => {
      spawnError = error;
    });

    const timeout = setTimeout(
      () => stop("timeout"),
      timeoutMilliseconds,
    );
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      closed = { exitCode, signal };
      finish();
    });
  });
}

function jsonType(value) {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function validateOutput(rawOutput, contract) {
  let candidate = rawOutput.trim();
  let normalization = "raw-json";
  const fenced = candidate.match(
    /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/,
  );
  if (
    fenced &&
    (candidate.match(/```/g) ?? []).length === 2
  ) {
    candidate = fenced[1];
    normalization = "single-json-fence";
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return {
      valid: false,
      normalization,
      reason: "invalid-json",
    };
  }
  if (!isObject(parsed)) {
    return {
      valid: false,
      normalization,
      reason: "output-not-object",
    };
  }
  const expectedKeys = Object.keys(contract.required).sort();
  const actualKeys = Object.keys(parsed).sort();
  if (
    contract.additionalProperties === false &&
    JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)
  ) {
    return {
      valid: false,
      normalization,
      reason: "output-keys-invalid",
    };
  }
  for (const [key, type] of Object.entries(contract.required)) {
    if (jsonType(parsed[key]) !== type) {
      return {
        valid: false,
        normalization,
        reason: `output-type-invalid:${key}`,
      };
    }
  }
  return {
    valid: true,
    normalization,
    reason: null,
  };
}

function writeEvidence(runDirectory, relativePath, value) {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.split("/").some((part) =>
      part === "" || part === "." || part === ".."
    )
  ) {
    fail(
      "FLEET_EVIDENCE_PATH_INVALID",
      "FleetRunner evidence path is unsafe.",
    );
  }
  const contents = Buffer.isBuffer(value)
    ? value
    : Buffer.from(value, "utf8");
  const target = join(runDirectory, relativePath);
  const temporary = join(
    runDirectory,
    `.${relativePath}.${randomUUID()}.tmp`,
  );
  let temporaryExists = false;
  try {
    writeFileSync(temporary, contents, {
      flag: "wx",
      mode: 0o600,
    });
    temporaryExists = true;
    linkSync(temporary, target);
    unlinkSync(temporary);
    temporaryExists = false;
  } finally {
    if (temporaryExists) {
      try {
        unlinkSync(temporary);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

function createEventJournal(
  runDirectory,
  runIdentity,
  eventSink,
) {
  if (
    eventSink !== undefined &&
    typeof eventSink !== "function"
  ) {
    fail(
      "FLEET_EVENT_SINK_INVALID",
      "FleetRunner event sink must be a function.",
    );
  }
  const relativePath = "events.jsonl";
  writeEvidence(runDirectory, relativePath, "");
  const descriptor = openSync(
    join(runDirectory, relativePath),
    constants.O_WRONLY |
      constants.O_APPEND |
      (constants.O_NOFOLLOW ?? 0),
  );
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile() || metadata.nlink !== 1) {
    closeSync(descriptor);
    fail(
      "FLEET_EVENT_JOURNAL_UNSAFE",
      "FleetRunner event journal is not a plain file.",
    );
  }
  let sequence = 0;
  let sinkAvailable = eventSink !== undefined;
  let outputEvents = 0;
  return {
    emit(type, fields = {}) {
      if (
        type === "process.output" &&
        outputEvents >= 128
      ) {
        return;
      }
      if (type === "process.output") {
        outputEvents += 1;
      }
      const event = {
        schemaVersion: "1",
        sequence: sequence + 1,
        runIdentity,
        type,
        at: new Date().toISOString(),
        ...fields,
      };
      const line = Buffer.from(
        `${JSON.stringify(event)}\n`,
        "utf8",
      );
      writeSync(descriptor, line);
      fsyncSync(descriptor);
      sequence += 1;
      if (sinkAvailable) {
        try {
          eventSink(structuredClone(event));
        } catch {
          sinkAvailable = false;
        }
      }
    },
    close() {
      closeSync(descriptor);
    },
    deliveryStatus() {
      if (eventSink === undefined) {
        return "not-requested";
      }
      return sinkAvailable ? "delivered" : "degraded";
    },
  };
}

function copyWorkspace(source, destination) {
  const sourceMetadata = lstatSync(source);
  if (
    sourceMetadata.isSymbolicLink() ||
    !sourceMetadata.isDirectory()
  ) {
    fail(
      "FLEET_WORKSPACE_SOURCE_UNSAFE",
      "Workspace copy source must be a plain directory.",
    );
  }
  const visit = (sourceDirectory, destinationDirectory) => {
    for (const entry of readdirSync(sourceDirectory, {
      withFileTypes: true,
    })) {
      const sourcePath = join(sourceDirectory, entry.name);
      const destinationPath = join(
        destinationDirectory,
        entry.name,
      );
      const metadata = lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) {
        fail(
          "FLEET_WORKSPACE_SOURCE_UNSAFE",
          "Workspace copy source cannot contain symlinks.",
        );
      }
      if (metadata.isDirectory()) {
        mkdirSync(destinationPath, { mode: 0o700 });
        visit(sourcePath, destinationPath);
      } else if (metadata.isFile()) {
        copyFileSync(sourcePath, destinationPath);
      } else {
        fail(
          "FLEET_WORKSPACE_SOURCE_UNSAFE",
          "Workspace copy source contains an unsupported entry.",
        );
      }
    }
  };
  visit(source, destination);
}

export async function runFleetJob(job, manifest, options = {}) {
  const plan = validateFleetJob(job, manifest, options);
  const runsRoot = safeRunsRoot(options.runsRoot);
  const runIdentity = options.runIdentityFactory
    ? options.runIdentityFactory()
    : `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-` +
      `${randomUUID()}`;
  if (
    typeof runIdentity !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,159}$/.test(runIdentity)
  ) {
    fail(
      "FLEET_RUN_IDENTITY_INVALID",
      "FleetRunner run identity is invalid.",
    );
  }
  const runDirectory = join(runsRoot, runIdentity);
  try {
    mkdirSync(runDirectory, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      fail(
        "FLEET_RUN_EXISTS",
        "FleetRunner refuses to overwrite an existing run.",
      );
    }
    throw error;
  }
  const normalizedJob = `${JSON.stringify(job, null, 2)}\n`;
  writeEvidence(runDirectory, "job.json", normalizedJob);

  const workingDirectory = join(runDirectory, "workspace");
  mkdirSync(workingDirectory, { mode: 0o700 });
  if (plan.executor.workingDirectoryPolicy === "workspace-copy") {
    copyWorkspace(plan.executor.workspaceSource, workingDirectory);
  }
  const inheritedEnvironment = plan.executor.environmentAllowlist
    .filter((name) => process.env[name] !== undefined);
  const metadata = {
    schemaVersion: "1",
    runIdentity,
    adapter: job.adapter,
    activity: job.activity,
    coordinator: manifest.coordinator.id,
    gate: plan.adapter.gate,
    mode: plan.adapter.mode,
    command: plan.executor.commandLabel,
    argumentCount: plan.executor.args.length,
    shell: false,
    workingDirectoryPolicy: plan.executor.workingDirectoryPolicy,
    workingDirectory:
      plan.executor.workingDirectoryPolicy === "workspace-copy"
        ? "copy-under-run-directory"
        : "isolated-under-run-directory",
    environmentVariableNames: [
      "NO_COLOR",
      "TERM",
      ...inheritedEnvironment,
    ].sort(),
    startedAt: new Date().toISOString(),
  };
  writeEvidence(
    runDirectory,
    "metadata.json",
    `${JSON.stringify(metadata, null, 2)}\n`,
  );

  const journal = createEventJournal(
    runDirectory,
    runIdentity,
    options.eventSink,
  );
  try {
    journal.emit("run.started", {
      adapter: job.adapter,
      activity: job.activity,
    });
    const child = await runChild(
      plan.executor.command,
      plan.executor.args,
      {
        cwd: workingDirectory,
        env: sanitizedEnvironment(
          plan.executor.environmentAllowlist,
        ),
      },
      job.timeoutMilliseconds,
      manifest.limits,
      (type, fields) => journal.emit(type, fields),
    );
    writeEvidence(runDirectory, "stdout.txt", child.stdout);
    writeEvidence(runDirectory, "stderr.txt", child.stderr);
    const outputContract = validateOutput(
      child.stdout.toString("utf8"),
      plan.outputContract,
    );
    let status = "succeeded";
    if (child.stopReason !== null) {
      status = child.stopReason;
    } else if (child.spawnError || child.exitCode !== 0) {
      status = "process-failed";
    } else if (!outputContract.valid) {
      status = "invalid-output";
    }
    journal.emit("run.finished", {
      status,
      durationMilliseconds: child.durationMilliseconds,
      outputValid: outputContract.valid,
    });
    const receipt = {
      schemaVersion: "1",
      runIdentity,
      status,
      adapter: job.adapter,
      exitCode: child.exitCode,
      signal: child.signal,
      durationMilliseconds: child.durationMilliseconds,
      outputContract,
      eventDelivery: journal.deliveryStatus(),
      evidence: {
        job: "job.json",
        metadata: "metadata.json",
        events: "events.jsonl",
        stdout: "stdout.txt",
        stderr: "stderr.txt",
        receipt: "receipt.json",
      },
      finishedAt: new Date().toISOString(),
    };
    writeEvidence(
      runDirectory,
      "receipt.json",
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return receipt;
  } finally {
    journal.close();
  }
}

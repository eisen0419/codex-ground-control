import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

const BINDING_KEYS = Object.freeze([
  "adapterId",
  "provider",
  "modelProvider",
  "model",
  "sessionId",
  "processIncarnation",
]);
const RUNTIME_BRAND = Symbol("PiRpcAdapterRuntime");
const PROBE_STATUSES = new Set([
  "ready",
  "login-required",
  "unavailable",
  "error",
]);

export const PI_RPC_ADAPTER_ERROR_CODES = Object.freeze({
  identity: "PI_RPC_ADAPTER_IDENTITY_ERROR",
  sequence: "PI_RPC_ADAPTER_SEQUENCE_ERROR",
  unavailable: "PI_RPC_ADAPTER_UNAVAILABLE",
  unexpected: "PI_RPC_ADAPTER_UNEXPECTED",
});

class PiRpcAdapterError extends Error {
  constructor(code, message, category) {
    super(message);
    this.name = "PiRpcAdapterError";
    this.code = code;
    this.category = category;
    this.retryable = false;
  }
}

function adapterError(code, message, category) {
  return new PiRpcAdapterError(code, message, category);
}

export function classifyPiRpcAdapterError(error) {
  if (error instanceof PiRpcAdapterError) {
    return Object.freeze({
      code: error.code,
      category: error.category,
      retryable: false,
    });
  }
  return Object.freeze({
    code: PI_RPC_ADAPTER_ERROR_CODES.unexpected,
    category: "unexpected",
    retryable: false,
  });
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.unexpected,
      `${label} must be a non-empty string.`,
      "unexpected",
    );
  }
  return value;
}

function requiredAbsolutePath(value, label) {
  const path = requiredString(value, label);
  if (path.length > 4_096 || !isAbsolute(path)) {
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.unexpected,
      `${label} must be a bounded absolute path.`,
      "unexpected",
    );
  }
  return path;
}

function sameBinding(left, right) {
  return (
    validBinding(left) &&
    validBinding(right) &&
    BINDING_KEYS.every((key) => left[key] === right[key])
  );
}

function validBinding(value) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === BINDING_KEYS.length &&
    BINDING_KEYS.every(
      (key) =>
        Object.hasOwn(value, key) &&
        typeof value[key] === "string" &&
        value[key].trim() !== "",
    )
  );
}

function timestampFrom(clock) {
  let value;
  try {
    value = clock();
  } catch {
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.unexpected,
      "Pi RPC adapter clock failed.",
      "unexpected",
    );
  }
  const timestamp =
    value instanceof Date ? value.toISOString() : value;
  if (
    typeof timestamp !== "string" ||
    Number.isNaN(Date.parse(timestamp))
  ) {
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.unexpected,
      "Pi RPC adapter clock returned an invalid timestamp.",
      "unexpected",
    );
  }
  return timestamp;
}

function bindingKey(taskId, binding) {
  requiredString(taskId, "taskId");
  if (!validBinding(binding)) {
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.identity,
      "Pi RPC process binding is invalid.",
      "identity",
    );
  }
  return JSON.stringify([
    taskId,
    ...BINDING_KEYS.map((key) => binding[key]),
  ]);
}

export function createNodePiRpcProcessBoundary() {
  const records = new Map();
  const stopping = new Set();

  function stopRecord(record) {
    if (record.stopPromise) {
      return record.stopPromise;
    }
    record.stopping = true;
    records.delete(record.key);
    record.stopPromise = (async () => {
      if (record.child.exitCode !== null) {
        return;
      }
      record.child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          if (record.child.exitCode === null) {
            record.child.kill("SIGKILL");
          }
          resolve();
        }, 1_000);
        timeout.unref();
        record.child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    })().finally(() => {
      stopping.delete(record.stopPromise);
    });
    stopping.add(record.stopPromise);
    return record.stopPromise;
  }

  function failOutput(record) {
    if (record.outputFailed) {
      return;
    }
    record.outputFailed = true;
    record.callbacks.onFailure();
    void stopRecord(record);
  }

  function emitLine(record) {
    let line = record.buffered;
    record.buffered = Buffer.alloc(0);
    if (line.at(-1) === 0x0d) {
      line = line.subarray(0, -1);
    }
    let decoded;
    try {
      decoded = record.decoder.decode(line);
    } catch {
      failOutput(record);
      return;
    }
    record.callbacks.onLine(decoded);
  }

  function onStdoutData(record, chunk) {
    if (record.outputFailed || record.stopping) {
      return;
    }
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.length : newline;
      const segment = chunk.subarray(offset, end);
      if (
        record.buffered.length + segment.length >
        record.maxLineBytes
      ) {
        failOutput(record);
        return;
      }
      if (segment.length > 0) {
        record.buffered =
          record.buffered.length === 0
            ? Buffer.from(segment)
            : Buffer.concat([record.buffered, segment]);
      }
      if (newline === -1) {
        return;
      }
      emitLine(record);
      if (record.outputFailed) {
        return;
      }
      offset = newline + 1;
    }
  }

  function transportFor(record) {
    const generation = record.generation;
    return Object.freeze({
      write(line) {
        if (
          generation !== record.generation ||
          record.stopping ||
          record.child.exitCode !== null ||
          !record.child.stdin.writable
        ) {
          throw adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.unavailable,
            "Pi RPC transport is unavailable.",
            "adapter-unavailable",
          );
        }
        record.child.stdin.write(line);
      },
      async stop() {
        if (generation !== record.generation) {
          return;
        }
        await stopRecord(record);
      },
    });
  }

  return Object.freeze({
    async start(options) {
      const key = bindingKey(
        options.taskId,
        options.nativeSessionBinding,
      );
      if (records.has(key)) {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.identity,
          "Pi RPC process incarnation is already active.",
          "identity",
        );
      }
      const child = spawn(options.command, options.args, {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const record = {
        key,
        binding: Object.freeze({ ...options.nativeSessionBinding }),
        child,
        callbacks: {
          onLine: options.onLine,
          onStderr: options.onStderr,
          onFailure: options.onFailure,
        },
        maxLineBytes: options.maxLineBytes,
        generation: 1,
        stopping: false,
        stopPromise: null,
        outputFailed: false,
        buffered: Buffer.alloc(0),
        decoder: new TextDecoder("utf-8", { fatal: true }),
      };
      records.set(key, record);
      child.stdout.on("data", (chunk) => onStdoutData(record, chunk));
      child.stderr.on("data", () => record.callbacks.onStderr());
      child.stdin.on("error", () => {
        if (!record.stopping) {
          record.callbacks.onFailure();
        }
      });
      child.once("error", () => {
        records.delete(key);
        if (!record.stopping) {
          record.callbacks.onFailure();
        }
      });
      child.once("exit", () => {
        records.delete(key);
        if (!record.stopping) {
          record.callbacks.onFailure();
        }
      });
      try {
        await new Promise((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
      } catch (error) {
        records.delete(key);
        throw error;
      }
      return transportFor(record);
    },
    async recover(options) {
      const key = bindingKey(
        options.taskId,
        options.nativeSessionBinding,
      );
      const record = records.get(key);
      if (
        !record ||
        record.stopping ||
        record.outputFailed ||
        record.child.exitCode !== null
      ) {
        return null;
      }
      const previousCallbacks = record.callbacks;
      record.generation += 1;
      record.callbacks = {
        onLine: options.onLine,
        onStderr: options.onStderr,
        onFailure: options.onFailure,
      };
      record.maxLineBytes = options.maxLineBytes;
      previousCallbacks.onFailure();
      return transportFor(record);
    },
    async close() {
      await Promise.all([
        ...[...records.values()].map(stopRecord),
        ...stopping,
      ]);
    },
  });
}

function normalizedSignal(value) {
  if (value?.type === "agent_start") {
    return { type: "turn.started" };
  }
  if (
    value?.type === "message_end" &&
    value.message?.role === "assistant" &&
    value.message?.stopReason === "stop"
  ) {
    return {
      type: "result.accepted",
      result: { disposition: "candidate-evidence" },
    };
  }
  if (value?.type === "agent_settled") {
    return { type: "turn.settled" };
  }
  return null;
}

export function createPiRpcAdapter({
  processBoundary = createNodePiRpcProcessBoundary(),
  idFactory = randomUUID,
  clock = () => new Date().toISOString(),
  command = "pi",
  commandArgs = [],
  sessionDirectory = null,
  environment = {},
  environmentAllowlist = [],
  requestTimeoutMs = 5_000,
  maxLineBytes = 256 * 1024,
  maxBufferedEvents = 1_000,
} = {}) {
  if (
    !processBoundary ||
    typeof processBoundary.start !== "function" ||
    typeof idFactory !== "function" ||
    !Array.isArray(commandArgs) ||
    ![null, "function"].includes(
      sessionDirectory === null ? null : typeof sessionDirectory,
    ) ||
    !Array.isArray(environmentAllowlist) ||
    environmentAllowlist.length > 64 ||
    new Set(environmentAllowlist).size !==
      environmentAllowlist.length ||
    !environmentAllowlist.every(
      (name) =>
        typeof name === "string" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name),
    ) ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs > 60_000 ||
    !Number.isSafeInteger(maxLineBytes) ||
    maxLineBytes < 1 ||
    maxLineBytes > 1024 * 1024 ||
    !Number.isSafeInteger(maxBufferedEvents) ||
    maxBufferedEvents < 1 ||
    maxBufferedEvents > 10_000
  ) {
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.unexpected,
      "Pi RPC adapter dependencies are invalid.",
      "unexpected",
    );
  }
  const processIncarnations = new Set();

  function nextProcessIncarnation() {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      let generated;
      try {
        generated = idFactory();
      } catch {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unexpected,
          "Pi RPC process incarnation generation failed.",
          "unexpected",
        );
      }
      const value = requiredString(generated, "processIncarnation");
      if (!processIncarnations.has(value)) {
        processIncarnations.add(value);
        return value;
      }
    }
    throw adapterError(
      PI_RPC_ADAPTER_ERROR_CODES.identity,
      "A unique Pi process incarnation could not be created.",
      "identity",
    );
  }

  function assertRuntime(binding, runtime) {
    if (
      runtime?.[RUNTIME_BRAND] !== true ||
      runtime.retired === true ||
      !sameBinding(binding, runtime.binding)
    ) {
      throw adapterError(
        PI_RPC_ADAPTER_ERROR_CODES.identity,
        "Pi RPC runtime does not match the exact native-session binding.",
        "identity",
      );
    }
  }

  function failRuntime(runtime, error) {
    if (runtime.failure) {
      return;
    }
    const sanitized =
      error instanceof PiRpcAdapterError
        ? error
        : adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.unavailable,
            "Pi RPC process failed.",
            "adapter-unavailable",
          );
    runtime.failure = sanitized;
    for (const pending of runtime.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(sanitized);
    }
    runtime.pending.clear();
    if (!runtime.cleanupStarted) {
      runtime.cleanupStarted = true;
      void stopTransport(runtime.transport);
    }
  }

  function handleLine(runtime, line) {
    if (runtime.failure) {
      return;
    }
    if (
      typeof line !== "string" ||
      Buffer.byteLength(line, "utf8") > maxLineBytes
    ) {
      failRuntime(
        runtime,
        adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unavailable,
          "Pi RPC emitted an oversized structured line.",
          "adapter-unavailable",
        ),
      );
      return;
    }
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      failRuntime(
        runtime,
        adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unavailable,
          "Pi RPC emitted invalid structured data.",
          "adapter-unavailable",
        ),
      );
      return;
    }
    if (value?.type === "response") {
      const pending = runtime.pending.get(value.id);
      if (!pending) {
        failRuntime(
          runtime,
          adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.identity,
            "Pi RPC response identity did not match a request.",
            "identity",
          ),
        );
        return;
      }
      runtime.pending.delete(value.id);
      clearTimeout(pending.timeout);
      if (value.success === true) {
        pending.resolve(value.data);
      } else {
        pending.reject(
          adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.unavailable,
            "Pi RPC request failed.",
            "adapter-unavailable",
          ),
        );
      }
      return;
    }
    if (
      value?.sessionId !== undefined &&
      value.sessionId !== runtime.binding.sessionId
    ) {
      failRuntime(
        runtime,
        adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.identity,
          "Pi RPC event session identity did not match.",
          "identity",
        ),
      );
      return;
    }
    const signal = normalizedSignal(value);
    if (!signal) {
      return;
    }
    let observedAt;
    try {
      observedAt = timestampFrom(clock);
    } catch (error) {
      failRuntime(runtime, error);
      return;
    }
    if (runtime.events.length >= maxBufferedEvents) {
      failRuntime(
        runtime,
        adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unavailable,
          "Pi RPC exceeded the bounded event buffer.",
          "adapter-unavailable",
        ),
      );
      return;
    }
    runtime.events.push(
      Object.freeze({
        nativeSessionBinding: runtime.binding,
        sequence: runtime.nextSequence,
        observedAt,
        signal: Object.freeze(signal),
      }),
    );
    runtime.nextSequence += 1;
  }

  function request(runtime, commandValue) {
    if (runtime.failure) {
      return Promise.reject(runtime.failure);
    }
    const id = `pi-rpc-${++runtime.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        runtime.pending.delete(id);
        reject(
          adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.unavailable,
            "Pi RPC request reached its bounded timeout.",
            "adapter-unavailable",
          ),
        );
      }, requestTimeoutMs);
      runtime.pending.set(id, { resolve, reject, timeout });
      try {
        runtime.transport.write(
          `${JSON.stringify({ ...commandValue, id })}\n`,
        );
      } catch {
        clearTimeout(timeout);
        runtime.pending.delete(id);
        reject(
          adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.unavailable,
            "Pi RPC request could not be sent.",
            "adapter-unavailable",
          ),
        );
      }
    });
  }

  async function stopTransport(transport) {
    try {
      await transport.stop?.();
    } catch {
      // Cleanup cannot replace the sanitized protocol failure.
    }
  }

  async function openRuntime(
    taskId,
    binding,
    options,
    recover = false,
    nextSequence = 2,
  ) {
    const bufferedLines = [];
    let runtime = null;
    const callbacks = {
      onLine(line) {
        if (runtime) {
          handleLine(runtime, line);
        } else {
          bufferedLines.push(line);
        }
      },
      onStderr() {},
      onFailure() {
        if (runtime) {
          failRuntime(runtime);
        }
      },
    };
    let transport;
    try {
      transport = recover
        ? await processBoundary.recover({
            taskId,
            nativeSessionBinding: binding,
            maxLineBytes,
            ...callbacks,
          })
        : await processBoundary.start({
            ...options,
            maxLineBytes,
            ...callbacks,
          });
    } catch {
      throw adapterError(
        PI_RPC_ADAPTER_ERROR_CODES.unavailable,
        "Pi RPC process boundary could not be opened.",
        "adapter-unavailable",
      );
    }
    if (!transport) {
      return null;
    }
    runtime = {
      [RUNTIME_BRAND]: true,
      binding,
      transport,
      pending: new Map(),
      events: [],
      nextSequence,
      requestSequence: 0,
      failure: null,
      cleanupStarted: false,
      retired: false,
    };
    for (const line of bufferedLines) {
      handleLine(runtime, line);
    }
    let state;
    try {
      state = await request(runtime, { type: "get_state" });
    } catch (error) {
      await stopTransport(transport);
      throw error;
    }
    if (state?.sessionId !== binding.sessionId) {
      await stopTransport(transport);
      throw adapterError(
        PI_RPC_ADAPTER_ERROR_CODES.identity,
        "Pi RPC get_state returned a mismatched session identity.",
        "identity",
      );
    }
    return runtime;
  }

  return Object.freeze({
    async probe(context) {
      if (typeof processBoundary.probe !== "function") {
        return Object.freeze({ status: "unavailable" });
      }
      try {
        const result = await processBoundary.probe(context);
        return Object.freeze({
          status: PROBE_STATUSES.has(result?.status)
            ? result.status
            : "error",
        });
      } catch {
        return Object.freeze({ status: "error" });
      }
    },
    async start(spec) {
      const binding = Object.freeze({
        adapterId: "pi-rpc",
        provider: "pi",
        modelProvider: requiredString(
          spec?.modelProvider,
          "modelProvider",
        ),
        model: requiredString(spec?.model, "model"),
        sessionId: requiredString(spec?.sessionId, "sessionId"),
        processIncarnation: nextProcessIncarnation(),
      });
      let selectedSessionDirectory = null;
      if (sessionDirectory !== null) {
        try {
          selectedSessionDirectory = requiredAbsolutePath(
            sessionDirectory(spec),
            "sessionDirectory",
          );
        } catch (error) {
          if (error instanceof PiRpcAdapterError) {
            throw error;
          }
          throw adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.unexpected,
            "Pi RPC session directory construction failed.",
            "unexpected",
          );
        }
      }
      const args = [
        ...commandArgs,
        "--mode",
        "rpc",
        "--provider",
        binding.modelProvider,
        "--model",
        binding.model,
        "--session-id",
        binding.sessionId,
        ...(selectedSessionDirectory === null
          ? []
          : ["--session-dir", selectedSessionDirectory]),
        "--thinking",
        "off",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-approve",
      ];
      let env;
      try {
        env =
          typeof environment === "function"
            ? environment(spec)
            : environment;
      } catch {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unexpected,
          "Pi RPC environment construction failed.",
          "unexpected",
        );
      }
      if (
        env === null ||
        Array.isArray(env) ||
        typeof env !== "object"
      ) {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unexpected,
          "Pi RPC environment does not satisfy the explicit allowlist contract.",
          "unexpected",
        );
      }
      const selectedEnvironment = {};
      for (const name of environmentAllowlist) {
        const descriptor = Object.getOwnPropertyDescriptor(env, name);
        if (
          descriptor &&
          Object.hasOwn(descriptor, "value") &&
          typeof descriptor.value === "string" &&
          descriptor.value !== ""
        ) {
          selectedEnvironment[name] = descriptor.value;
        }
      }
      if (selectedSessionDirectory !== null) {
        selectedEnvironment.PI_CODING_AGENT_SESSION_DIR =
          selectedSessionDirectory;
        selectedEnvironment.PI_TELEMETRY = "0";
      }
      const runtime = await openRuntime(
        requiredString(spec?.taskId, "taskId"),
        binding,
        {
          taskId: spec.taskId,
          nativeSessionBinding: binding,
          command: requiredString(command, "command"),
          args,
          cwd: requiredString(spec?.cwd, "cwd"),
          env: selectedEnvironment,
        },
      );
      if (!runtime) {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.unavailable,
          "Pi RPC process boundary returned no runtime.",
          "adapter-unavailable",
        );
      }
      return Object.freeze({
        nativeSessionBinding: binding,
        runtime,
      });
    },
    async send({ nativeSessionBinding, runtime, input }) {
      assertRuntime(nativeSessionBinding, runtime);
      await request(runtime, {
        type: "prompt",
        message: requiredString(input, "input"),
      });
    },
    async observe({
      nativeSessionBinding,
      runtime,
      afterSequence,
    }) {
      assertRuntime(nativeSessionBinding, runtime);
      if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0
      ) {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.sequence,
          "Pi RPC observation cursor is invalid.",
          "sequence",
        );
      }
      if (runtime.failure) {
        const buffered = runtime.events.filter(
          (event) => event.sequence > afterSequence,
        );
        if (buffered.length === 0) {
          throw runtime.failure;
        }
      }
      runtime.events = runtime.events.filter(
        (event) => event.sequence > afterSequence,
      );
      return runtime.events
        .map((event) => structuredClone(event));
    },
    async cancel({
      nativeSessionBinding,
      runtime,
      afterSequence,
    }) {
      assertRuntime(nativeSessionBinding, runtime);
      if (afterSequence !== undefined) {
        if (
          !Number.isSafeInteger(afterSequence) ||
          afterSequence < 0 ||
          runtime.events.some(
            (event) => event.sequence > afterSequence,
          )
        ) {
          throw adapterError(
            PI_RPC_ADAPTER_ERROR_CODES.sequence,
            "Pi RPC cancellation cursor is invalid.",
            "sequence",
          );
        }
        runtime.nextSequence = Math.max(
          runtime.nextSequence,
          afterSequence + 1,
        );
      }
      await request(runtime, { type: "abort" });
    },
    async retire({ nativeSessionBinding, runtime }) {
      assertRuntime(nativeSessionBinding, runtime);
      runtime.retired = true;
      const retired = adapterError(
        PI_RPC_ADAPTER_ERROR_CODES.unavailable,
        "Pi RPC runtime is retired.",
        "adapter-unavailable",
      );
      for (const pending of runtime.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(retired);
      }
      runtime.pending.clear();
      await stopTransport(runtime.transport);
    },
    async recover({
      taskId,
      nativeSessionBinding,
      afterSequence = 0,
    }) {
      requiredString(taskId, "taskId");
      if (!validBinding(nativeSessionBinding)) {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.identity,
          "Pi RPC recovery binding is invalid.",
          "identity",
        );
      }
      if (
        !Number.isSafeInteger(afterSequence) ||
        afterSequence < 0
      ) {
        throw adapterError(
          PI_RPC_ADAPTER_ERROR_CODES.sequence,
          "Pi RPC recovery cursor is invalid.",
          "sequence",
        );
      }
      const runtime = await openRuntime(
        taskId,
        Object.freeze({ ...nativeSessionBinding }),
        null,
        true,
        afterSequence + 1,
      );
      if (!runtime) {
        return null;
      }
      return Object.freeze({
        nativeSessionBinding: runtime.binding,
        runtime,
      });
    },
  });
}

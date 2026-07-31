import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import readline from "node:readline";

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function sameNativeSession(left, right) {
  return (
    left.adapterId === right?.adapterId &&
    left.provider === right?.provider &&
    left.modelProvider === right?.modelProvider &&
    left.model === right?.model &&
    left.sessionId === right?.sessionId &&
    left.processIncarnation === right?.processIncarnation
  );
}

function identityMismatch() {
  const error = new Error(
    "Cancellation target does not match the live Pi RPC session.",
  );
  error.code = "LEAF_SESSION_IDENTITY_MISMATCH";
  return error;
}

function processFailure(message, stderrObserved = false) {
  const suffix = stderrObserved
    ? " Provider stderr was withheld."
    : "";
  const error = new Error(`${message}${suffix}`);
  error.code = "PI_RPC_PROCESS_FAILED";
  return error;
}

class PiRpcSession {
  constructor(options) {
    this.options = options;
    this.child = null;
    this.lines = null;
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.requestSequence = 0;
    this.stderrObserved = false;
    this.stopping = false;
    this.nativeSessionRef = Object.freeze({
      adapterId: "pi-rpc",
      provider: "pi",
      modelProvider: requiredString(
        options.provider,
        "provider",
      ),
      model: requiredString(options.model, "model"),
      sessionId: requiredString(
        options.sessionId,
        "sessionId",
      ),
      processIncarnation: randomUUID(),
    });
  }

  async start() {
    const args = [
      ...(this.options.commandArgs ?? []),
      "--mode",
      "rpc",
      "--provider",
      this.nativeSessionRef.modelProvider,
      "--model",
      this.nativeSessionRef.model,
      "--session-id",
      this.nativeSessionRef.sessionId,
      ...(this.options.args ?? []),
    ];
    const child = spawn(
      requiredString(this.options.command, "command"),
      args,
      {
        cwd: requiredString(this.options.cwd, "cwd"),
        env: { ...(this.options.env ?? {}) },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {
      this.stderrObserved = true;
    });
    child.once("error", (error) => {
      this.failAll(
        processFailure(
          `Pi RPC process error: ${error.message}.`,
          this.stderrObserved,
        ),
      );
    });
    child.once("exit", (code, signal) => {
      if (this.stopping) {
        return;
      }
      this.failAll(
        processFailure(
          `Pi RPC process exited with code ${code} and signal ${signal}.`,
          this.stderrObserved,
        ),
      );
    });
    this.lines = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.lines.on("line", (line) => {
      this.handleLine(line);
    });

    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const state = await this.getState();
    if (
      state.sessionId !==
      this.nativeSessionRef.sessionId
    ) {
      await this.stop();
      throw identityMismatch();
    }
    return this;
  }

  handleLine(line) {
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      this.failAll(
        processFailure(
          "Pi RPC emitted invalid JSON.",
          this.stderrObserved,
        ),
      );
      return;
    }
    if (value?.type === "response" && value.id) {
      const pending = this.pending.get(value.id);
      if (!pending) {
        return;
      }
      this.pending.delete(value.id);
      clearTimeout(pending.timeout);
      if (value.success === true) {
        pending.resolve(value.data);
      } else {
        pending.reject(
          processFailure(
            `Pi RPC ${pending.commandType} failed.`,
            this.stderrObserved,
          ),
        );
      }
      return;
    }
    this.events.push(value);
    const waiting = [...this.waiters];
    for (const waiter of waiting) {
      if (!waiter.predicate(value)) {
        continue;
      }
      clearTimeout(waiter.timeout);
      this.waiters.splice(
        this.waiters.indexOf(waiter),
        1,
      );
      waiter.resolve(value);
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    this.waiters.length = 0;
  }

  request(command, timeoutMs = 5000) {
    if (!this.child?.stdin.writable) {
      return Promise.reject(
        processFailure(
          "Pi RPC stdin is not writable.",
          this.stderrObserved,
        ),
      );
    }
    const id = `rpc-${++this.requestSequence}`;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          processFailure(
            `Pi RPC ${command.type} timed out.`,
            this.stderrObserved,
          ),
        );
      }, timeoutMs);
      this.pending.set(id, {
        resolve,
        reject,
        timeout,
        commandType: command.type,
      });
      this.child.stdin.write(
        `${JSON.stringify({ ...command, id })}\n`,
      );
    });
  }

  async getState() {
    return this.request({ type: "get_state" });
  }

  async prompt(message) {
    await this.request({
      type: "prompt",
      message: requiredString(message, "message"),
    });
  }

  async abort(expectedNativeSessionRef) {
    if (
      !sameNativeSession(
        this.nativeSessionRef,
        expectedNativeSessionRef,
      )
    ) {
      throw identityMismatch();
    }
    await this.request({ type: "abort" });
  }

  waitForEvent(predicate, timeoutMs = 5000) {
    const existing = this.events.find(predicate);
    if (existing) {
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timeout: null,
      };
      waiter.timeout = setTimeout(() => {
        this.waiters.splice(
          this.waiters.indexOf(waiter),
          1,
        );
        reject(
          processFailure(
            "Timed out waiting for a Pi RPC event.",
            this.stderrObserved,
          ),
        );
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async stop() {
    if (!this.child) {
      return;
    }
    this.stopping = true;
    this.lines?.close();
    this.lines = null;
    const child = this.child;
    this.child = null;
    this.failAll(
      processFailure(
        "Pi RPC session stopped.",
        this.stderrObserved,
      ),
    );
    if (child.exitCode !== null) {
      return;
    }
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
        resolve();
      }, 1000);
      child.once("exit", () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }
}

export async function startPiRpcSession(options) {
  return new PiRpcSession(options).start();
}

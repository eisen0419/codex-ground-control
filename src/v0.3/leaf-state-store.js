import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import {
  validateLeafTaskRecord,
  validateNormalizedLeafEvent,
} from "./leaf-domain.js";

const COMMIT_SCHEMA_VERSION = "0.3-leaf-state-commit";
const COMMIT_NAME = /^(\d{16})\.json$/;
const TEMPORARY_NAME = /^\.commit-[a-f0-9-]+\.tmp$/;

export const LEAF_STATE_STORE_ERROR_CODES = Object.freeze({
  cursorInvalid: "LEAF_STORE_CURSOR_INVALID",
  dataCorrupt: "LEAF_STORE_DATA_CORRUPT",
  dataUnsafe: "LEAF_STORE_DATA_UNSAFE",
  duplicateConflict: "LEAF_STORE_DUPLICATE_CONFLICT",
  io: "LEAF_STORE_IO_ERROR",
  sequenceGap: "LEAF_STORE_SEQUENCE_GAP",
  sessionIdentityMismatch: "LEAF_STORE_SESSION_IDENTITY_MISMATCH",
  taskExists: "LEAF_STORE_TASK_EXISTS",
  taskIdentityMismatch: "LEAF_STORE_TASK_IDENTITY_MISMATCH",
  taskInvalid: "LEAF_STORE_TASK_INVALID",
  taskNotFound: "LEAF_STORE_TASK_NOT_FOUND",
  unexpected: "LEAF_STORE_UNEXPECTED",
});

class LeafStateStoreError extends Error {
  constructor(code, message, category) {
    super(message);
    this.name = "LeafStateStoreError";
    this.code = code;
    this.category = category;
  }
}

function storeError(code, message, category) {
  return new LeafStateStoreError(code, message, category);
}

function fail(code, message, category) {
  throw storeError(code, message, category);
}

export function classifyLeafStateStoreError(error) {
  if (error instanceof LeafStateStoreError) {
    return Object.freeze({
      code: error.code,
      category: error.category,
      retryable: false,
    });
  }
  return Object.freeze({
    code: LEAF_STATE_STORE_ERROR_CODES.unexpected,
    category: "unexpected",
    retryable: false,
  });
}

function withStoreErrors(operation) {
  try {
    return operation();
  } catch (error) {
    if (error instanceof LeafStateStoreError) {
      throw error;
    }
    throw storeError(
      LEAF_STATE_STORE_ERROR_CODES.io,
      "Leaf state store I/O failed closed.",
      "io",
    );
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalValue(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalValue);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function canonicalBytes(value) {
  return Buffer.from(JSON.stringify(canonicalValue(value)) + "\n", "utf8");
}

function hasExactKeys(value, keys) {
  return (
    value !== null &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validTaskId(taskId) {
  return typeof taskId === "string" && taskId.trim() !== "";
}

function taskDigest(taskId) {
  return sha256(Buffer.from(taskId, "utf8"));
}

function modeIsPrivate(metadata, expectedMode) {
  return (metadata.mode & 0o777) === expectedMode;
}

function assertPrivateDirectory(path, label) {
  let metadata;
  try {
    metadata = lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    !modeIsPrivate(metadata, 0o700)
  ) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
      label + " must be a private regular directory.",
      "safety",
    );
  }
  return true;
}

function createPrivateDirectory(path, label) {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") {
      assertPrivateDirectory(path, label);
      return false;
    }
    throw error;
  }
  chmodSync(path, 0o700);
  if (!assertPrivateDirectory(path, label)) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
      label + " was not created safely.",
      "safety",
    );
  }
  syncDirectory(dirname(path));
  return true;
}

function openPrivateFile(path) {
  const before = lstatSync(path);
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    !modeIsPrivate(before, 0o600)
  ) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
      "Leaf state commit must be private regular no-follow data.",
      "safety",
    );
  }
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      !modeIsPrivate(opened, 0o600)
    ) {
      fail(
        LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
        "Leaf state commit changed while opening.",
        "safety",
      );
    }
    return readFileSync(descriptor);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      fail(
        LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
        "Leaf state commit cannot be a symlink.",
        "safety",
      );
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function syncDirectory(path) {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function publishImmutable(directory, fileName, bytes) {
  const temporaryPath = join(directory, ".commit-" + randomUUID() + ".tmp");
  const targetPath = join(directory, fileName);
  let temporaryExists = false;
  try {
    const descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
      0o600,
    );
    temporaryExists = true;
    try {
      fchmodSync(descriptor, 0o600);
      writeFileSync(descriptor, bytes);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    try {
      linkSync(temporaryPath, targetPath);
    } catch (error) {
      if (error.code === "EEXIST") {
        return false;
      }
      throw error;
    }
    syncDirectory(directory);
    unlinkSync(temporaryPath);
    temporaryExists = false;
    syncDirectory(directory);
    return true;
  } finally {
    if (temporaryExists) {
      try {
        unlinkSync(temporaryPath);
        syncDirectory(directory);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

function createCommit(task, sequence, previousCommitDigest, event) {
  const payload = Object.freeze({
    taskIdDigest: taskDigest(task.taskId),
    sequence,
    previousCommitDigest,
    event,
    task,
  });
  const normalizedPayload = canonicalValue(payload);
  const digest = sha256(canonicalBytes(normalizedPayload));
  const envelope = Object.freeze({
    schemaVersion: COMMIT_SCHEMA_VERSION,
    digest,
    payload: normalizedPayload,
  });
  const bytes = canonicalBytes(envelope);
  const fileName = String(sequence).padStart(16, "0") + ".json";
  return { bytes, digest, fileName, payload: normalizedPayload };
}

function readCommit(directory, fileName, expectedTaskDigest) {
  const match = COMMIT_NAME.exec(fileName);
  if (!match) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
      "Leaf state directory contains a malformed commit name.",
      "integrity",
    );
  }
  const bytes = openPrivateFile(join(directory, fileName));
  let envelope;
  try {
    envelope = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
      "Leaf state commit is truncated or malformed.",
      "integrity",
    );
  }
  if (
    !hasExactKeys(envelope, ["digest", "payload", "schemaVersion"]) ||
    envelope.schemaVersion !== COMMIT_SCHEMA_VERSION ||
    !/^[a-f0-9]{64}$/.test(envelope.digest) ||
    !canonicalBytes(envelope).equals(bytes) ||
    sha256(canonicalBytes(envelope.payload)) !== envelope.digest ||
    !hasExactKeys(envelope.payload, [
      "event",
      "previousCommitDigest",
      "sequence",
      "task",
      "taskIdDigest",
    ]) ||
    envelope.payload.taskIdDigest !== expectedTaskDigest ||
    !Number.isSafeInteger(envelope.payload.sequence) ||
    envelope.payload.sequence < 0 ||
    Number(match[1]) !== envelope.payload.sequence ||
    !validateLeafTaskRecord(envelope.payload.task).valid ||
    taskDigest(envelope.payload.task.taskId) !== expectedTaskDigest
  ) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
      "Leaf state commit does not satisfy the durable schema.",
      "integrity",
    );
  }
  return { digest: envelope.digest, payload: envelope.payload };
}

function listCommitNames(directory) {
  const commits = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    const metadata = lstatSync(entryPath);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      fail(
        LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
        "Leaf state directory contains unsafe data.",
        "safety",
      );
    }
    if (TEMPORARY_NAME.test(entry.name)) {
      if (!modeIsPrivate(metadata, 0o600)) {
        fail(
          LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
          "Leaf state temporary data is not private.",
          "safety",
        );
      }
      continue;
    }
    if (!COMMIT_NAME.test(entry.name)) {
      fail(
        LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
        "Leaf state directory contains unrecognized data.",
        "integrity",
      );
    }
    commits.push(entry.name);
  }
  return commits.sort();
}

function valuesEqual(left, right) {
  return canonicalBytes(left).equals(canonicalBytes(right));
}

function sameTaskIdentity(left, right) {
  return [
    "taskId",
    "adapterId",
    "profile",
    "activity",
    "provider",
    "modelProvider",
    "model",
  ].every((key) => left[key] === right[key]);
}

function sameNativeSessionBinding(left, right) {
  return valuesEqual(left, right);
}

function transitionIsAllowed(previous, next) {
  const transition =
    previous.stage + "->" + next.stage + ":" + next.latestEvent.type;
  const allowed = new Set([
    "dispatch-received->session-created:session.created",
    "dispatch-received->provider-failed:turn.failed",
    "session-created->provider-running:turn.started",
    "session-created->provider-failed:turn.failed",
    "provider-running->provider-result-observed:turn.progress",
    "provider-running->provider-abort-requested:turn.cancel.requested",
    "provider-running->provider-failed:turn.failed",
    "provider-result-observed->provider-completed:turn.completed",
    "provider-result-observed->provider-abort-requested:turn.cancel.requested",
    "provider-abort-requested->provider-cancelled:turn.cancelled",
  ]).has(transition);
  if (!allowed) {
    return false;
  }

  const sessionWasCreated =
    previous.sessionCreated ||
    (!previous.sessionCreated &&
      next.sessionCreated &&
      next.latestEvent.type === "session.created");
  if (next.sessionCreated !== sessionWasCreated) {
    return false;
  }

  if (next.latestEvent.type === "turn.progress") {
    return previous.result === null && next.result !== null;
  }
  if (next.latestEvent.type === "turn.failed") {
    return next.result === null;
  }
  return valuesEqual(previous.result, next.result);
}

function loadTaskState(directory, expectedTaskId) {
  const expectedTaskDigest = taskDigest(expectedTaskId);
  const names = listCommitNames(directory);
  if (names.length === 0) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
      "Leaf state task has no durable initial commit.",
      "integrity",
    );
  }
  const commits = names.map((name) =>
    readCommit(directory, name, expectedTaskDigest),
  );
  const initial = commits[0];
  if (
    initial.payload.sequence !== 0 ||
    initial.payload.previousCommitDigest !== null ||
    initial.payload.event !== null ||
    initial.payload.task.latestEvent !== null ||
    initial.payload.task.taskId !== expectedTaskId
  ) {
    fail(
      LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
      "Leaf state initial commit is inconsistent.",
      "integrity",
    );
  }
  for (let index = 1; index < commits.length; index += 1) {
    const previous = commits[index - 1];
    const current = commits[index];
    const event = current.payload.event;
    const task = current.payload.task;
    if (
      current.payload.sequence !== index ||
      current.payload.previousCommitDigest !== previous.digest ||
      task.taskId !== expectedTaskId ||
      !validateNormalizedLeafEvent(event).valid ||
      event.sequence !== index ||
      event.taskId !== expectedTaskId ||
      !sameNativeSessionBinding(
        event.nativeSessionBinding,
        task.nativeSessionBinding,
      ) ||
      !valuesEqual(event, task.latestEvent) ||
      !sameTaskIdentity(previous.payload.task, task) ||
      !sameNativeSessionBinding(
        previous.payload.task.nativeSessionBinding,
        task.nativeSessionBinding,
      ) ||
      !transitionIsAllowed(previous.payload.task, task)
    ) {
      fail(
        LEAF_STATE_STORE_ERROR_CODES.dataCorrupt,
        "Leaf state commit chain is inconsistent.",
        "integrity",
      );
    }
  }
  return Object.freeze({
    commits,
    current: commits.at(-1).payload.task,
    events: commits.slice(1).map((commit) => commit.payload.event),
  });
}

export function createLeafStateStore({ rootDirectory } = {}) {
  return withStoreErrors(() => {
    if (
      typeof rootDirectory !== "string" ||
      rootDirectory.trim() === "" ||
      !isAbsolute(rootDirectory)
    ) {
      fail(
        LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
        "Leaf state rootDirectory must be an absolute private path.",
        "safety",
      );
    }
    const root = resolve(rootDirectory);
    if (!assertPrivateDirectory(root, "Leaf state root")) {
      createPrivateDirectory(root, "Leaf state root");
    }
    const tasksDirectory = join(root, "tasks");
    if (!assertPrivateDirectory(tasksDirectory, "Leaf state tasks directory")) {
      createPrivateDirectory(tasksDirectory, "Leaf state tasks directory");
    }

    function directoryForTask(taskId) {
      if (!validTaskId(taskId)) {
        fail(
          LEAF_STATE_STORE_ERROR_CODES.taskInvalid,
          "Leaf state taskId must be a non-empty string.",
          "validation",
        );
      }
      if (
        !assertPrivateDirectory(root, "Leaf state root") ||
        !assertPrivateDirectory(tasksDirectory, "Leaf state tasks directory")
      ) {
        fail(
          LEAF_STATE_STORE_ERROR_CODES.dataUnsafe,
          "Leaf state directory chain changed after initialization.",
          "safety",
        );
      }
      return join(tasksDirectory, taskDigest(taskId));
    }

    return Object.freeze({
      createTask(leafTaskRecord) {
        return withStoreErrors(() => {
          if (!validateLeafTaskRecord(leafTaskRecord).valid) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskInvalid,
              "createTask requires a valid V3-P01 LeafTaskRecord.",
              "validation",
            );
          }
          if (leafTaskRecord.latestEvent !== null) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskInvalid,
              "createTask requires the initial dispatch LeafTaskRecord.",
              "validation",
            );
          }
          const taskDirectory = directoryForTask(leafTaskRecord.taskId);
          if (!createPrivateDirectory(taskDirectory, "Leaf state task directory")) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskExists,
              "Leaf state task identity already exists.",
              "identity",
            );
          }
          const commit = createCommit(leafTaskRecord, 0, null, null);
          publishImmutable(taskDirectory, commit.fileName, commit.bytes);
          return structuredClone(commit.payload.task);
        });
      },
      commitTask(nextLeafTaskRecord) {
        return withStoreErrors(() => {
          if (
            !validateLeafTaskRecord(nextLeafTaskRecord).valid ||
            nextLeafTaskRecord.latestEvent === null
          ) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskInvalid,
              "commitTask requires a valid transitioned LeafTaskRecord.",
              "validation",
            );
          }
          const taskDirectory = directoryForTask(nextLeafTaskRecord.taskId);
          if (!assertPrivateDirectory(taskDirectory, "Leaf state task directory")) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskIdentityMismatch,
              "commitTask has no matching durable task identity.",
              "identity",
            );
          }
          let state = loadTaskState(taskDirectory, nextLeafTaskRecord.taskId);
          const current = state.current;
          if (!sameTaskIdentity(current, nextLeafTaskRecord)) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskIdentityMismatch,
              "Leaf task identity changed across a commit.",
              "identity",
            );
          }
          if (
            !sameNativeSessionBinding(
              current.nativeSessionBinding,
              nextLeafTaskRecord.nativeSessionBinding,
            )
          ) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.sessionIdentityMismatch,
              "Native session binding changed across a commit.",
              "identity",
            );
          }
          const sequence = nextLeafTaskRecord.latestEvent.sequence;
          if (sequence <= state.commits.length - 1) {
            const durable = state.commits[sequence]?.payload.task;
            if (durable && valuesEqual(durable, nextLeafTaskRecord)) {
              return structuredClone(durable);
            }
            fail(
              LEAF_STATE_STORE_ERROR_CODES.duplicateConflict,
              "A conflicting leaf transition already owns this sequence.",
              "sequence",
            );
          }
          if (sequence !== state.commits.length) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.sequenceGap,
              "Leaf state transition sequence contains a gap.",
              "sequence",
            );
          }
          if (!transitionIsAllowed(current, nextLeafTaskRecord)) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskInvalid,
              "Leaf state transition is not valid from the durable state.",
              "validation",
            );
          }
          const previousDigest = state.commits.at(-1).digest;
          const commit = createCommit(
            nextLeafTaskRecord,
            sequence,
            previousDigest,
            nextLeafTaskRecord.latestEvent,
          );
          if (!publishImmutable(taskDirectory, commit.fileName, commit.bytes)) {
            state = loadTaskState(taskDirectory, nextLeafTaskRecord.taskId);
            const durable = state.commits[sequence]?.payload.task;
            if (durable && valuesEqual(durable, nextLeafTaskRecord)) {
              return structuredClone(durable);
            }
            fail(
              LEAF_STATE_STORE_ERROR_CODES.duplicateConflict,
              "A conflicting leaf transition won concurrent publication.",
              "sequence",
            );
          }
          return structuredClone(commit.payload.task);
        });
      },
      readTask(taskId) {
        return withStoreErrors(() => {
          const taskDirectory = directoryForTask(taskId);
          if (!assertPrivateDirectory(taskDirectory, "Leaf state task directory")) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskNotFound,
              "Leaf state task does not exist.",
              "identity",
            );
          }
          return structuredClone(
            loadTaskState(taskDirectory, taskId).current,
          );
        });
      },
      readEvents(taskId, options = {}) {
        return withStoreErrors(() => {
          if (
            options === null ||
            Array.isArray(options) ||
            typeof options !== "object" ||
            !Object.keys(options).every((key) => key === "afterSequence") ||
            (options.afterSequence !== undefined &&
              (!Number.isSafeInteger(options.afterSequence) ||
                options.afterSequence < 0))
          ) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.cursorInvalid,
              "afterSequence must be a bounded non-negative integer.",
              "validation",
            );
          }
          const taskDirectory = directoryForTask(taskId);
          if (!assertPrivateDirectory(taskDirectory, "Leaf state task directory")) {
            fail(
              LEAF_STATE_STORE_ERROR_CODES.taskNotFound,
              "Leaf state task does not exist.",
              "identity",
            );
          }
          const afterSequence = options.afterSequence ?? 0;
          return loadTaskState(taskDirectory, taskId)
            .events.filter((event) => event.sequence > afterSequence)
            .map((event) => structuredClone(event));
        });
      },
    });
  });
}

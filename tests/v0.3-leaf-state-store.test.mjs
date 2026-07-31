import assert from "node:assert/strict";
import {
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyProviderNativeSignal,
  createLeafTaskRecord,
} from "../src/v0.3/leaf-domain.js";
import {
  classifyLeafStateStoreError,
  createLeafStateStore,
} from "../src/v0.3/leaf-state-store.js";

const nativeSessionBinding = Object.freeze({
  adapterId: "pi-rpc",
  provider: "pi",
  modelProvider: "zai-coding-cn",
  model: "glm-5.2",
  sessionId: "00000000-0000-4000-8000-000000000302",
  processIncarnation: "launch-302",
});

function createStartingTask(overrides = {}) {
  return createLeafTaskRecord({
    taskId: "leaf-302",
    profile: "pi-glm",
    activity: "testing",
    nativeSessionBinding,
    ...overrides,
  });
}

function applySignal(task, sequence, signal) {
  return applyProviderNativeSignal(task, {
    taskId: task.taskId,
    nativeSessionBinding: task.nativeSessionBinding,
    sequence,
    observedAt:
      "2026-07-31T00:00:" + String(sequence).padStart(2, "0") + ".000Z",
    signal,
  });
}

async function createStoreFixture(t) {
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "ground-control-v03-store-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const rootDirectory = join(temporaryDirectory, "store");
  return { rootDirectory, store: createLeafStateStore({ rootDirectory }) };
}

async function snapshotStoreBytes(directory) {
  const snapshot = {};
  async function visit(current, relative = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryRelative = relative ? relative + "/" + entry.name : entry.name;
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath, entryRelative);
      } else {
        snapshot[entryRelative] = (await readFile(entryPath)).toString("hex");
      }
    }
  }
  await visit(directory);
  return snapshot;
}

async function listCommittedFiles(directory) {
  const files = [];
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const entryPath = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else if (entry.name.endsWith(".json")) {
        files.push(entryPath);
      }
    }
  }
  await visit(directory);
  return files.sort();
}

test("createTask persists one private task across restart and rejects duplicate identity", async (t) => {
  const { rootDirectory, store } = await createStoreFixture(t);
  const task = createStartingTask();

  store.createTask(task);

  assert.deepEqual(store.readTask(task.taskId), task);
  const restarted = createLeafStateStore({ rootDirectory });
  assert.deepEqual(restarted.readTask(task.taskId), task);
  assert.throws(
    () => restarted.createTask(task),
    (error) =>
      classifyLeafStateStoreError(error).code === "LEAF_STORE_TASK_EXISTS",
  );
});

test("commitTask appends ordered normalized events and cursor reads survive restart", async (t) => {
  const { rootDirectory, store } = await createStoreFixture(t);
  const starting = createStartingTask();
  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  const running = applySignal(sessionCreated, 2, { type: "turn.started" });

  store.createTask(starting);
  store.commitTask(sessionCreated);
  store.commitTask(running);

  const restarted = createLeafStateStore({ rootDirectory });
  assert.deepEqual(restarted.readTask(starting.taskId), running);
  assert.deepEqual(restarted.readEvents(starting.taskId), [
    sessionCreated.latestEvent,
    running.latestEvent,
  ]);
  assert.deepEqual(
    restarted.readEvents(starting.taskId, { afterSequence: 1 }),
    [running.latestEvent],
  );
  assert.deepEqual(
    restarted.readEvents(starting.taskId, { afterSequence: 2 }),
    [],
  );
});

test("identical duplicate commits are byte-stable no-ops and conflicts fail closed", async (t) => {
  const { rootDirectory, store } = await createStoreFixture(t);
  const starting = createStartingTask();
  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  const conflictingFailure = applySignal(starting, 1, {
    type: "turn.settled",
  });

  store.createTask(starting);
  store.commitTask(sessionCreated);
  const beforeDuplicate = await snapshotStoreBytes(rootDirectory);

  assert.deepEqual(store.commitTask(sessionCreated), sessionCreated);
  assert.deepEqual(await snapshotStoreBytes(rootDirectory), beforeDuplicate);
  assert.throws(
    () => store.commitTask(conflictingFailure),
    (error) =>
      classifyLeafStateStoreError(error).code ===
      "LEAF_STORE_DUPLICATE_CONFLICT",
  );
  assert.deepEqual(await snapshotStoreBytes(rootDirectory), beforeDuplicate);
});

test("sequence gaps and cross-task or cross-session transitions fail with stable codes", async (t) => {
  const { store } = await createStoreFixture(t);
  const starting = createStartingTask();
  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  const running = applySignal(sessionCreated, 2, { type: "turn.started" });
  const gap = structuredClone(running);
  gap.latestEvent.sequence = 3;

  store.createTask(starting);
  store.commitTask(sessionCreated);

  assert.throws(
    () => store.commitTask(gap),
    (error) =>
      classifyLeafStateStoreError(error).code === "LEAF_STORE_SEQUENCE_GAP",
  );

  const crossTask = structuredClone(running);
  crossTask.taskId = "leaf-other";
  crossTask.latestEvent.taskId = "leaf-other";
  assert.throws(
    () => store.commitTask(crossTask),
    (error) =>
      classifyLeafStateStoreError(error).code ===
      "LEAF_STORE_TASK_IDENTITY_MISMATCH",
  );

  for (const changedBinding of [
    { sessionId: "session-other" },
    { processIncarnation: "stale-launch" },
  ]) {
    const mismatched = structuredClone(running);
    Object.assign(mismatched.nativeSessionBinding, changedBinding);
    Object.assign(mismatched.latestEvent.nativeSessionBinding, changedBinding);
    assert.throws(
      () => store.commitTask(mismatched),
      (error) =>
        classifyLeafStateStoreError(error).code ===
        "LEAF_STORE_SESSION_IDENTITY_MISMATCH",
    );
  }

  assert.deepEqual(store.readTask(starting.taskId), sessionCreated);
});

test("commitTask rejects records that bypass the domain reducer", async (t) => {
  const { store } = await createStoreFixture(t);
  const starting = createStartingTask();
  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  const running = applySignal(sessionCreated, 2, { type: "turn.started" });
  const fabricatedCancellation = structuredClone(running);
  fabricatedCancellation.state = "cancelling";
  fabricatedCancellation.stage = "provider-abort-requested";
  fabricatedCancellation.result = {
    disposition: "candidate-evidence",
  };
  fabricatedCancellation.latestEvent = {
    taskId: running.taskId,
    nativeSessionBinding: structuredClone(running.nativeSessionBinding),
    sequence: 3,
    type: "turn.cancel.requested",
    source: "provider-native",
    observedAt: "2026-07-31T00:00:03.000Z",
  };

  store.createTask(starting);
  store.commitTask(sessionCreated);
  store.commitTask(running);

  assert.throws(
    () => store.commitTask(fabricatedCancellation),
    (error) =>
      classifyLeafStateStoreError(error).code === "LEAF_STORE_TASK_INVALID",
  );
  assert.deepEqual(store.readTask(starting.taskId), running);
});

test("tampered, truncated, malformed, and symlinked durable data fail closed", async (t) => {
  await t.test("truncated commit", async (t) => {
    const { rootDirectory, store } = await createStoreFixture(t);
    const task = createStartingTask();
    store.createTask(task);
    const [commitPath] = await listCommittedFiles(rootDirectory);
    const bytes = await readFile(commitPath);
    await writeFile(commitPath, bytes.subarray(0, bytes.length - 7));
    assert.throws(
      () => store.readTask(task.taskId),
      (error) =>
        classifyLeafStateStoreError(error).code === "LEAF_STORE_DATA_CORRUPT",
    );
  });

  await t.test("tampered commit", async (t) => {
    const { rootDirectory, store } = await createStoreFixture(t);
    const task = createStartingTask();
    store.createTask(task);
    const [commitPath] = await listCommittedFiles(rootDirectory);
    const bytes = await readFile(commitPath, "utf8");
    await writeFile(commitPath, bytes.replace("dispatch-received", "dispatch-receiveD"));
    assert.throws(
      () => store.readTask(task.taskId),
      (error) =>
        classifyLeafStateStoreError(error).code === "LEAF_STORE_DATA_CORRUPT",
    );
  });

  await t.test("malformed committed entry", async (t) => {
    const { rootDirectory, store } = await createStoreFixture(t);
    const task = createStartingTask();
    store.createTask(task);
    const [commitPath] = await listCommittedFiles(rootDirectory);
    await writeFile(join(commitPath, "..", "unexpected.data"), "malformed", {
      mode: 0o600,
    });
    assert.throws(
      () => store.readTask(task.taskId),
      (error) =>
        classifyLeafStateStoreError(error).code === "LEAF_STORE_DATA_CORRUPT",
    );
  });

  await t.test("symlinked commit", async (t) => {
    const { rootDirectory, store } = await createStoreFixture(t);
    const task = createStartingTask();
    store.createTask(task);
    const [commitPath] = await listCommittedFiles(rootDirectory);
    const target = join(rootDirectory, "symlink-target");
    await writeFile(target, await readFile(commitPath), { mode: 0o600 });
    await unlink(commitPath);
    await symlink(target, commitPath);
    assert.throws(
      () => store.readTask(task.taskId),
      (error) =>
        classifyLeafStateStoreError(error).code === "LEAF_STORE_DATA_UNSAFE",
    );
  });

  await t.test("symlinked task directory", async (t) => {
    const { rootDirectory, store } = await createStoreFixture(t);
    const task = createStartingTask();
    store.createTask(task);
    const [commitPath] = await listCommittedFiles(rootDirectory);
    const taskDirectory = join(commitPath, "..");
    await rm(taskDirectory, { recursive: true, force: true });
    await symlink(rootDirectory, taskDirectory, "dir");
    assert.throws(
      () => store.readTask(task.taskId),
      (error) =>
        classifyLeafStateStoreError(error).code === "LEAF_STORE_DATA_UNSAFE",
    );
  });
});

test("digest-derived task storage contains traversal IDs and keeps private modes", async (t) => {
  const { rootDirectory, store } = await createStoreFixture(t);
  const traversalTask = createStartingTask({
    taskId: "../../escape/../leaf-302",
  });
  store.createTask(traversalTask);

  assert.deepEqual(store.readTask(traversalTask.taskId), traversalTask);
  const entries = [];
  async function visit(current, relative = "") {
    const metadata = await lstat(current);
    entries.push({ relative, metadata });
    if (metadata.isDirectory()) {
      for (const entry of await readdir(current)) {
        await visit(
          join(current, entry),
          relative ? relative + "/" + entry : entry,
        );
      }
    }
  }
  await visit(rootDirectory);

  assert.equal(
    entries.some(({ relative }) => relative.includes(traversalTask.taskId)),
    false,
  );
  for (const { metadata } of entries) {
    assert.equal(metadata.isSymbolicLink(), false);
    assert.equal(
      metadata.mode & 0o777,
      metadata.isDirectory() ? 0o700 : 0o600,
    );
  }
});

test("journal bytes retain the private binding but exclude forbidden Provider material", async (t) => {
  const { rootDirectory, store } = await createStoreFixture(t);
  const starting = createStartingTask();
  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  store.createTask(starting);
  store.commitTask(sessionCreated);

  const bytes = (
    await Promise.all(
      (await listCommittedFiles(rootDirectory)).map((path) => readFile(path)),
    )
  )
    .map((value) => value.toString("utf8"))
    .join("\n");

  assert.equal(bytes.includes("processIncarnation"), true);
  for (const forbidden of [
    "pid",
    "environment",
    "credential",
    "rawPrompt",
    "transcript",
    "reasoning",
    "rawProviderOutput",
    "rawProviderError",
  ]) {
    assert.equal(bytes.includes('"' + forbidden + '"'), false);
  }
});

test("incomplete temporary publication is ignored without inventing task death", async (t) => {
  const { rootDirectory, store } = await createStoreFixture(t);
  const starting = createStartingTask();
  const sessionCreated = applySignal(starting, 1, {
    type: "session.created",
  });
  store.createTask(starting);
  store.commitTask(sessionCreated);
  const commits = await listCommittedFiles(rootDirectory);
  const temporaryPath = join(
    commits[0],
    "..",
    ".commit-00000000-0000-4000-8000-000000000302.tmp",
  );
  await writeFile(temporaryPath, "{truncated", { mode: 0o600 });

  assert.deepEqual(store.readTask(starting.taskId), sessionCreated);
  assert.deepEqual(store.readEvents(starting.taskId), [
    sessionCreated.latestEvent,
  ]);
});

test("missing tasks and invalid cursors fail closed without terminal synthesis", async (t) => {
  const { store } = await createStoreFixture(t);
  const task = createStartingTask();
  store.createTask(task);

  assert.throws(
    () => store.readTask("missing-task"),
    (error) =>
      classifyLeafStateStoreError(error).code === "LEAF_STORE_TASK_NOT_FOUND",
  );
  for (const afterSequence of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => store.readEvents(task.taskId, { afterSequence }),
      (error) =>
        classifyLeafStateStoreError(error).code ===
        "LEAF_STORE_CURSOR_INVALID",
    );
  }
  assert.equal(store.readTask(task.taskId).state, "starting");
});

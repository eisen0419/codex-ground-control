import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  runFleetJob,
  validateFleetJob,
} from "../src/fleet-runner.js";

const manifestPath = fileURLToPath(
  new URL(
    "../fixtures/qualification/fleet/capabilities-v1.json",
    import.meta.url,
  ),
);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const validJob = {
  schemaVersion: "1",
  adapter: "fixture-raw",
  activity: "qualification",
  prompt: "bounded prompt",
  timeoutMilliseconds: 1000,
  outputContract: "fixture-result-v1",
};

function snapshot(directory) {
  const files = {};
  const visit = (current, prefix = "") => {
    for (const entry of readdirSync(current, {
      withFileTypes: true,
    }).sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      const path = join(current, entry.name);
      const relativePath = prefix
        ? `${prefix}/${entry.name}`
        : entry.name;
      if (entry.isDirectory()) {
        visit(path, relativePath);
      } else {
        files[relativePath] = readFileSync(path);
      }
    }
  };
  visit(directory);
  return files;
}

test("FleetRunner never overwrites an existing run identity", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "fleet-runner-atomic-"));
  const runsRoot = join(sandbox, "runs");
  mkdirSync(runsRoot);
  const runIdentity = "fixed-fleet-run";
  const options = {
    runsRoot,
    manifestDirectory: dirname(manifestPath),
    runIdentityFactory: () => runIdentity,
  };
  try {
    const first = await runFleetJob(validJob, manifest, options);
    assert.equal(first.runIdentity, runIdentity);
    const runDirectory = join(runsRoot, runIdentity);
    const before = snapshot(runDirectory);

    await assert.rejects(
      runFleetJob(validJob, manifest, options),
      (error) => error.code === "FLEET_RUN_EXISTS",
    );
    assert.deepEqual(snapshot(runDirectory), before);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("FleetRunner rejects a workspace-copy source that escapes the manifest", () => {
  const escaping = structuredClone(manifest);
  escaping.adapters["fixture-workspace-copy"].executor
    .workingDirectory.source = "{manifest_dir}/../outside";
  assert.throws(
    () =>
      validateFleetJob(
        {
          ...validJob,
          adapter: "fixture-workspace-copy",
        },
        escaping,
        { manifestDirectory: dirname(manifestPath) },
      ),
    (error) => error.code === "FLEET_MANIFEST_INVALID",
  );
});

test("FleetRunner rejects the canonical system temporary root", async () => {
  await assert.rejects(
    runFleetJob(validJob, manifest, {
      runsRoot: realpathSync(tmpdir()),
      manifestDirectory: dirname(manifestPath),
    }),
    (error) => error.code === "FLEET_RUNS_ROOT_UNSAFE",
  );
});

test("FleetRunner rejects workspace-copy sources through symlink ancestors", () => {
  const sandbox = mkdtempSync(join(tmpdir(), "fleet-workspace-link-"));
  const manifestDirectory = join(sandbox, "manifest");
  const outside = join(sandbox, "outside");
  mkdirSync(manifestDirectory);
  mkdirSync(outside);
  symlinkSync(outside, join(manifestDirectory, "linked-workspace"));
  const linked = structuredClone(manifest);
  linked.adapters["fixture-workspace-copy"].executor
    .workingDirectory.source =
    "{manifest_dir}/linked-workspace";
  try {
    assert.throws(
      () =>
        validateFleetJob(
          {
            ...validJob,
            adapter: "fixture-workspace-copy",
          },
          linked,
          { manifestDirectory },
        ),
      (error) => error.code === "FLEET_MANIFEST_INVALID",
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("FleetRunner accepts a manifest-pinned leaf command behind its own passed gate", () => {
  const providerManifest = structuredClone(manifest);
  providerManifest.gates.fixtureProvider = {
    status: "passed",
  };
  const adapter = providerManifest.adapters["fixture-raw"];
  adapter.gate = "fixtureProvider";
  adapter.executor.command = "fixture-tool";
  adapter.executor.environmentAllowlist = ["PATH"];
  const plan = validateFleetJob(validJob, providerManifest, {
    manifestDirectory: dirname(manifestPath),
  });
  assert.equal(plan.executor.command, "fixture-tool");
  assert.equal(plan.executor.commandLabel, "fixture-tool");
  assert.equal(
    plan.executor.args.at(-1),
    validJob.prompt,
  );
});

test("FleetRunner rejects manifest limits above product hard ceilings", () => {
  const unbounded = structuredClone(manifest);
  unbounded.limits.maxPromptBytes = 256001;
  assert.throws(
    () =>
      validateFleetJob(validJob, unbounded, {
        manifestDirectory: dirname(manifestPath),
      }),
    (error) => error.code === "FLEET_MANIFEST_INVALID",
  );
});

test("FleetRunner durably journals sanitized ordered LeafRun events", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "fleet-runner-events-"));
  const runsRoot = join(sandbox, "runs");
  const runIdentity = "event-journal-fixture";
  const collected = [];
  mkdirSync(runsRoot);
  try {
    const receipt = await runFleetJob(validJob, manifest, {
      runsRoot,
      manifestDirectory: dirname(manifestPath),
      runIdentityFactory: () => runIdentity,
      eventSink(event) {
        const journal = readFileSync(
          join(runsRoot, runIdentity, "events.jsonl"),
          "utf8",
        )
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.deepEqual(journal.at(-1), event);
        collected.push(event);
      },
    });

    const journal = readFileSync(
      join(runsRoot, runIdentity, "events.jsonl"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(journal, collected);
    assert.deepEqual(
      journal.map((event) => event.type),
      [
        "run.started",
        "process.started",
        "process.output",
        "process.exited",
        "run.finished",
      ],
    );
    assert.deepEqual(
      journal.map((event) => event.sequence),
      [1, 2, 3, 4, 5],
    );
    for (const event of journal) {
      assert.equal(event.schemaVersion, "1");
      assert.equal(event.runIdentity, runIdentity);
      assert.equal(
        new Date(event.at).toISOString(),
        event.at,
      );
      assert.equal(Object.hasOwn(event, "prompt"), false);
      assert.equal(Object.hasOwn(event, "text"), false);
      assert.equal(Object.hasOwn(event, "data"), false);
    }
    assert.deepEqual(
      journal[2],
      {
        schemaVersion: "1",
        sequence: 3,
        runIdentity,
        type: "process.output",
        at: journal[2].at,
        stream: "stdout",
        chunkBytes: journal[2].chunkBytes,
        totalBytes: journal[2].totalBytes,
      },
    );
    assert.equal(journal[2].chunkBytes > 0, true);
    assert.equal(
      journal[2].chunkBytes,
      journal[2].totalBytes,
    );
    assert.equal(
      JSON.stringify(journal).includes(validJob.prompt),
      false,
    );
    assert.equal(receipt.evidence.events, "events.jsonl");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

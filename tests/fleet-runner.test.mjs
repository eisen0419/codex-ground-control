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

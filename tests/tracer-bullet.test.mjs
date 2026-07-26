import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isolatedEnvironment(homeDirectory) {
  return {
    PATH: process.env.PATH,
    HOME: homeDirectory,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
  };
}

function isolatedNpmEnvironment(homeDirectory, cacheDirectory) {
  return {
    ...isolatedEnvironment(homeDirectory),
    npm_config_cache: cacheDirectory,
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
}

function snapshotFiles(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") {
        continue;
      }

      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else {
        files[relative(root, absolutePath)] = readFileSync(
          absolutePath,
          "utf8",
        );
      }
    }
  };

  visit(root);
  return files;
}

function withPackedCli(callback) {
  const sandbox = mkdtempSync(join(tmpdir(), "codex-ground-control-test-"));
  const packDirectory = join(sandbox, "pack");
  const installDirectory = join(sandbox, "install");
  const homeDirectory = join(sandbox, "home");
  const projectDirectory = join(sandbox, "project");
  const networkTrap = join(sandbox, "deny-network.mjs");
  const runtimeBin = join(sandbox, "runtime-bin");
  const codexInvocation = join(sandbox, "codex-invoked");

  mkdirSync(packDirectory);
  mkdirSync(homeDirectory);
  mkdirSync(projectDirectory);
  mkdirSync(runtimeBin);
  symlinkSync(process.execPath, join(runtimeBin, "node"));
  writeFileSync(
    join(runtimeBin, "codex"),
    `#!/bin/sh\n: > '${codexInvocation}'\n` +
      "printf 'codex-cli 0.145.0\\n'\n",
  );
  chmodSync(join(runtimeBin, "codex"), 0o755);
  writeFileSync(
    networkTrap,
    [
      'import http from "node:http";',
      'import https from "node:https";',
      'import net from "node:net";',
      'const denied = () => { throw new Error("network access denied by acceptance test"); };',
      "globalThis.fetch = denied;",
      "http.request = denied;",
      "http.get = denied;",
      "https.request = denied;",
      "https.get = denied;",
      "net.connect = denied;",
      "net.createConnection = denied;",
      "",
    ].join("\n"),
  );

  try {
    const npmEnvironment = isolatedNpmEnvironment(
      homeDirectory,
      join(sandbox, "npm-cache"),
    );
    const packOutput = execFileSync(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        packDirectory,
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: npmEnvironment,
      },
    );
    const [{ filename }] = JSON.parse(packOutput);
    const tarball = join(packDirectory, filename);
    const install = run(
      "npm",
      ["install", "--ignore-scripts", "--prefix", installDirectory, tarball],
      { env: npmEnvironment },
    );

    assert.equal(
      install.status,
      0,
      `tarball install failed\nstdout:\n${install.stdout}\nstderr:\n${install.stderr}`,
    );

    const runtimePath = `${runtimeBin}:/usr/bin:/bin`;
    execFileSync("/usr/bin/git", ["init", "-b", "main"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: {
        ...isolatedEnvironment(homeDirectory),
        PATH: runtimePath,
      },
    });

    callback({
      cli: join(
        installDirectory,
        "node_modules",
        ".bin",
        "codex-ground-control",
      ),
      codexInvocation,
      homeDirectory,
      installDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
      sandbox,
    });
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

test("package metadata and tarball contents define the public CLI contract", () => {
  const packageMetadata = JSON.parse(
    readFileSync(join(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(packageMetadata.name, "codex-ground-control");
  assert.equal(packageMetadata.version, "0.2.0");
  assert.equal(packageMetadata.type, "module");
  assert.deepEqual(packageMetadata.engines, { node: ">=22" });
  assert.deepEqual(packageMetadata.bin, {
    "codex-ground-control": "bin/codex-ground-control.js",
  });
  const releaseLock = JSON.parse(
    readFileSync(join(repositoryRoot, "release-lock.json"), "utf8"),
  );
  const [mattSkills] = releaseLock.dependencies;

  const sandbox = mkdtempSync(join(tmpdir(), "codex-ground-control-pack-"));
  const homeDirectory = join(sandbox, "home");
  mkdirSync(homeDirectory);
  try {
    const [packed] = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--json", "--dry-run", "--ignore-scripts"],
        {
          cwd: repositoryRoot,
          encoding: "utf8",
          env: isolatedNpmEnvironment(
            homeDirectory,
            join(sandbox, "npm-cache"),
          ),
        },
      ),
    );
    assert.equal(packed.filename, "codex-ground-control-0.2.0.tgz");
    const expectedFiles = [
      ...mattSkills.assets.map((asset) => asset.sourcePath),
      "vendor/mattpocock-skills/LICENSE",
      "LICENSE",
      "README.md",
      "THIRD_PARTY_NOTICES.md",
      "assets/overlays/agents-managed-block.md",
      "assets/overlays/ground-control/SKILL.md",
      "assets/overlays/ground-control/agents/openai.yaml",
      "assets/overlays/multi-agent-router/SKILL.md",
      "assets/overlays/multi-agent-router/agents/openai.yaml",
      "bin/codex-ground-control.js",
      "fixtures/qualification/fleet/adapter.mjs",
      "fixtures/qualification/fleet/capabilities-v1.json",
      "fixtures/qualification/fleet/workspace/fixture.txt",
      "fixtures/qualification/offline-core-v1.json",
      "fixtures/qualification/public-receipt-audit-v1.json",
      "fixtures/providers/agy-research-adapter.mjs",
      "fixtures/providers/agy-source-verifier.mjs",
      "fixtures/providers/capabilities-v1.json",
      "fixtures/providers/grok-research-adapter.mjs",
      "fixtures/providers/pi-leaf-adapter.mjs",
      "fixtures/providers/probe-adapter.mjs",
      "fixtures/providers/public-probes-v1.json",
      "package.json",
      "release-lock.json",
      "schemas/provider/agy-live-probe-output.schema.json",
      "schemas/provider/grok-live-probe-output.schema.json",
      "schemas/provider/live-probe-output.schema.json",
      "schemas/provider/pi-candidate-output.schema.json",
      "schemas/qualification/campaign.schema.json",
      "schemas/qualification/issue-ledger.schema.json",
      "schemas/qualification/public-receipt.schema.json",
      "schemas/qualification/result.schema.json",
      "src/cli.js",
      "src/doctor.js",
      "src/fleet-runner-worker.js",
      "src/fleet-runner.js",
      "src/global-workflow.js",
      "src/managed-workflow.js",
      "src/project-state.js",
      "src/provider-lifecycle.js",
      "src/qualification-contract.js",
      "src/qualification-lab.js",
      "src/safe-files.js",
      "src/workflow-assets.js",
      "src/workflow-error.js",
    ].sort();
    assert.deepEqual(
      packed.files.map(({ path }) => path).sort(),
      expectedFiles,
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("packed CLI exposes stable help and version output", () => {
  withPackedCli(({ cli, homeDirectory, projectDirectory, runtimePath }) => {
    const environment = {
      PATH: runtimePath,
      HOME: homeDirectory,
      TMPDIR: tmpdir(),
    };
    const help = run(cli, ["--help"], {
      cwd: projectDirectory,
      env: environment,
    });
    const version = run(cli, ["--version"], {
      cwd: projectDirectory,
      env: environment,
    });

    assert.equal(help.status, 0);
    assert.equal(
      help.stdout,
      [
        "Usage: codex-ground-control <command> [options]",
        "",
        "Commands:",
        "  init       Initialize Ground Control (project-local by default)",
        "  doctor     Diagnose the current installation",
        "  qualify    Run the deterministic offline qualification",
        "  provider   Inspect optional provider state",
        "  uninstall  Restore the managed scope to its pre-install state",
        "",
        "Qualification:",
        "  qualify",
        "  qualify verify <run-identity> <evidence-anchor>",
        "  qualify reproduce <run-identity> <scenario-id>",
        "",
        "Providers:",
        "  provider list",
        "  provider enable <pi-glm|pi-deepseek|pi-minimax|agy|grok>",
        "  provider disable <pi-glm|pi-deepseek|pi-minimax|agy|grok>",
        "  provider qualify <pi-glm|pi-deepseek|pi-minimax|agy|grok> --allow-live",
        "  provider run <pi-profile> <analysis|exploration|testing|review> <prompt> --allow-live",
        "",
        "Options:",
        "  --json     Emit exactly one JSON receipt",
        "  --dry-run  Preview init without changing files",
        "  --global   Manage the explicit user-level installation",
        "  --confirm-global Confirm a noninteractive global change",
        "  -h, --help Show this help",
        "  -v, --version Show the version",
        "",
      ].join("\n"),
    );
    assert.equal(help.stderr, "");
    assert.equal(version.status, 0);
    assert.equal(version.stdout, "0.2.0\n");
    assert.equal(version.stderr, "");
  });
});

function runJson(cli, command, context) {
  const result = run(cli, [...command, "--json"], {
    cwd: context.projectDirectory,
    env: {
      ...context.environment,
      PATH: context.runtimePath ?? process.env.PATH,
      HOME: context.homeDirectory,
      TMPDIR: tmpdir(),
      NODE_OPTIONS: `--import=${pathToFileURL(context.networkTrap).href}`,
    },
  });

  assert.equal(
    result.stderr,
    "",
    `unexpected stderr for ${command.join(" ")}: ${result.stderr}`,
  );
  assert.equal(
    result.stdout.trim().split("\n").length,
    1,
    `JSON mode emitted more than one line: ${result.stdout}`,
  );

  return {
    ...result,
    receipt: JSON.parse(result.stdout),
  };
}

test("packed CLI completes an offline reversible lifecycle", () => {
  withPackedCli(
    ({
      cli,
      codexInvocation,
      homeDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
      sandbox,
    }) => {
      writeFileSync(join(projectDirectory, "user-notes.txt"), "keep me\n");
      const before = snapshotFiles(projectDirectory);
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
        runtimePath,
      };

      const initialized = runJson(cli, ["init"], context);
      assert.equal(initialized.status, 0);
      assert.deepEqual(initialized.receipt, {
        schemaVersion: "1",
        product: "codex-ground-control",
        version: "0.2.0",
        command: "init",
        status: "ok",
        exitCode: 0,
        projectRoot: realpathSync(projectDirectory),
        changed: true,
        result: {
          installation: "created",
          manifest: ".codex-ground-control/manifest.json",
          releaseLock: {
            revision: "ed37663cc5fbef691ddfecd080dff42f7e7e350d",
            license: "MIT",
          },
        },
      });

      const manifestPath = join(
        projectDirectory,
        ".codex-ground-control",
        "manifest.json",
      );
      assert.equal(existsSync(manifestPath), true);
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      assert.equal(manifest.schemaVersion, "2");
      assert.equal(manifest.product, "codex-ground-control");
      assert.equal(manifest.version, "0.2.0");
      assert.equal(manifest.managedBlock.path, "AGENTS.md");
      assert.ok(manifest.assets.length > 50);

      const installedSnapshot = snapshotFiles(projectDirectory);
      const initializedAgain = runJson(cli, ["init"], context);
      assert.equal(initializedAgain.status, 0);
      assert.equal(initializedAgain.receipt.changed, false);
      assert.equal(initializedAgain.receipt.result.installation, "unchanged");
      assert.deepEqual(snapshotFiles(projectDirectory), installedSnapshot);

      const diagnosed = runJson(cli, ["doctor"], context);
      assert.equal(diagnosed.status, 0);
      assert.equal(diagnosed.receipt.result.schemaVersion, "1");
      assert.equal(diagnosed.receipt.result.health, "healthy");
      assert.equal(diagnosed.receipt.result.scope, "project");
      assert.equal(diagnosed.receipt.result.gates.core.status, "passed");
      assert.equal(
        diagnosed.receipt.result.gates["pi-glm"].status,
        "unavailable",
      );
      assert.equal(diagnosed.receipt.result.gates.agy.status, "unavailable");
      assert.equal(diagnosed.receipt.result.gates.grok.status, "unavailable");
      assert.equal(diagnosed.receipt.result.gates.native.status, "blocked");
      assert.equal(diagnosed.receipt.result.gates.write.status, "blocked");
      assert.equal(
        diagnosed.receipt.result.findings.find(
          ({ id }) => id === "installation.skills",
        ).observed,
        `${manifest.assets.length} managed assets verified`,
      );

      rmSync(codexInvocation, { force: true });
      const unauthorizedFleetSecret = "ticket06-fleet-secret-value";
      const qualified = runJson(cli, ["qualify"], {
        ...context,
        environment: {
          FLEETRUNNER_UNAUTHORIZED_SECRET:
            unauthorizedFleetSecret,
        },
      });
      assert.equal(qualified.status, 0);
      assert.equal(
        existsSync(codexInvocation),
        false,
        "default qualify must not invoke the Codex model CLI",
      );
      assert.equal(qualified.receipt.changed, true);
      assert.equal(qualified.receipt.result.schemaVersion, "1");
      assert.equal(
        qualified.receipt.result.campaign,
        "offline-core-v1",
      );
      assert.equal(
        qualified.receipt.result.terminalState,
        "release-passed",
      );
      assert.equal(
        qualified.receipt.result.campaignScope,
        "release-full",
      );
      assert.deepEqual(qualified.receipt.result.counts, {
        total: 17,
        passed: 17,
        failed: 0,
      });
      assert.match(
        qualified.receipt.result.runIdentity,
        /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-offline-core-v1-[0-9a-f-]{36}$/,
      );
      assert.deepEqual(qualified.receipt.result.evidence, {
        index:
          `~/.codex-ground-control/evidence/qualification/` +
          `${qualified.receipt.result.runIdentity}/evidence-index.json`,
        anchor: qualified.receipt.result.evidence.anchor,
      });
      assert.match(
        qualified.receipt.result.evidence.anchor,
        /^[0-9a-f]{64}$/,
      );
      const qualificationRun = join(
        homeDirectory,
        ".codex-ground-control",
        "evidence",
        "qualification",
        qualified.receipt.result.runIdentity,
      );
      for (const evidenceFile of [
        "campaign.json",
        "evidence-index.json",
        "issues.json",
        "request.json",
        "results.json",
        "runtime.json",
        "summary.json",
      ]) {
        assert.equal(
          existsSync(join(qualificationRun, evidenceFile)),
          true,
          `missing qualification evidence: ${evidenceFile}`,
        );
      }
      const fleetResult = JSON.parse(
        readFileSync(join(qualificationRun, "results.json"), "utf8"),
      ).results.find(
        ({ scenario }) => scenario === "fleet-raw-shell-env",
      );
      assert.deepEqual(fleetResult.observed, {
        terminalState: "passed",
        output: "succeeded:raw-json",
        reason: null,
      });
      const fleetRunsRoot = join(
        qualificationRun,
        "scenarios",
        "fleet-raw-shell-env",
        "fleet-runs",
      );
      const fleetRunIdentities = readdirSync(fleetRunsRoot);
      assert.equal(fleetRunIdentities.length, 1);
      const fleetRun = join(fleetRunsRoot, fleetRunIdentities[0]);
      for (const evidenceFile of [
        "job.json",
        "metadata.json",
        "stdout.txt",
        "stderr.txt",
        "receipt.json",
      ]) {
        assert.equal(
          existsSync(join(fleetRun, evidenceFile)),
          true,
          `missing FleetRunner evidence: ${evidenceFile}`,
        );
      }
      const fleetJob = JSON.parse(
        readFileSync(join(fleetRun, "job.json"), "utf8"),
      );
      assert.equal(
        fleetJob.prompt,
        "literal $(touch fleet-shell-injection)",
      );
      const fleetMetadata = JSON.parse(
        readFileSync(join(fleetRun, "metadata.json"), "utf8"),
      );
      assert.deepEqual(fleetMetadata.environmentVariableNames, [
        "NO_COLOR",
        "TERM",
      ]);
      assert.equal(fleetMetadata.command, "node");
      assert.equal(fleetMetadata.shell, false);
      assert.equal(
        fleetMetadata.workingDirectory,
        "isolated-under-run-directory",
      );
      const fleetOutput = JSON.parse(
        readFileSync(join(fleetRun, "stdout.txt"), "utf8"),
      );
      assert.equal(fleetOutput.secretPresent, false);
      assert.equal(
        fleetOutput.prompt,
        "literal $(touch fleet-shell-injection)",
      );
      assert.equal(
        Object.values(snapshotFiles(qualificationRun))
          .join("\n")
          .includes(unauthorizedFleetSecret),
        false,
      );
      assert.equal(
        qualified.stdout.includes(unauthorizedFleetSecret),
        false,
      );
      assert.equal(
        existsSync(join(fleetRun, "workspace", "fleet-shell-injection")),
        false,
      );
      const fleetReceipt = JSON.parse(
        readFileSync(join(fleetRun, "receipt.json"), "utf8"),
      );
      assert.equal(fleetReceipt.status, "succeeded");
      assert.equal(
        fleetReceipt.outputContract.normalization,
        "raw-json",
      );
      const qualificationResults = JSON.parse(
        readFileSync(join(qualificationRun, "results.json"), "utf8"),
      ).results;
      for (const [scenario, expected] of Object.entries({
        "fleet-job-authority": {
          terminalState: "blocked",
          output: null,
          reason: "job-contract-rejected",
        },
        "fleet-adapter-state": {
          terminalState: "blocked",
          output: null,
          reason: "adapter-state-rejected",
        },
        "fleet-native-write-boundaries": {
          terminalState: "blocked",
          output: null,
          reason: "native-write-disabled",
        },
      })) {
        assert.deepEqual(
          qualificationResults.find(
            (result) => result.scenario === scenario,
          ).observed,
          expected,
        );
        assert.equal(
          existsSync(
            join(
              qualificationRun,
              "scenarios",
              scenario,
              "policy-checks.json",
            ),
          ),
          true,
        );
      }
      const fleetExecutionExpectations = {
        "fleet-fenced-normalization": {
          observed: {
            terminalState: "passed",
            output: "succeeded:single-json-fence",
            reason: null,
          },
          status: "succeeded",
          normalization: "single-json-fence",
        },
        "fleet-workspace-copy": {
          observed: {
            terminalState: "passed",
            output: "succeeded:workspace-copy",
            reason: null,
          },
          status: "succeeded",
          normalization: "raw-json",
        },
        "fleet-nonzero-exit": {
          observed: {
            terminalState: "blocked",
            output: null,
            reason: "process-failed",
          },
          status: "process-failed",
          normalization: "raw-json",
        },
        "fleet-invalid-json": {
          observed: {
            terminalState: "blocked",
            output: null,
            reason: "invalid-output",
          },
          status: "invalid-output",
          normalization: "raw-json",
        },
        "fleet-trailing-prose": {
          observed: {
            terminalState: "blocked",
            output: null,
            reason: "invalid-output",
          },
          status: "invalid-output",
          normalization: "raw-json",
        },
        "fleet-multiple-fences": {
          observed: {
            terminalState: "blocked",
            output: null,
            reason: "invalid-output",
          },
          status: "invalid-output",
          normalization: "raw-json",
        },
        "fleet-corrupt-payload": {
          observed: {
            terminalState: "blocked",
            output: null,
            reason: "invalid-output",
          },
          status: "invalid-output",
          normalization: "raw-json",
        },
      };
      for (
        const [scenario, expectation] of Object.entries(
          fleetExecutionExpectations,
        )
      ) {
        assert.deepEqual(
          qualificationResults.find(
            (result) => result.scenario === scenario,
          ).observed,
          expectation.observed,
        );
        const scenarioRunsRoot = join(
          qualificationRun,
          "scenarios",
          scenario,
          "fleet-runs",
        );
        const [scenarioRunIdentity] = readdirSync(scenarioRunsRoot);
        const scenarioRun = join(
          scenarioRunsRoot,
          scenarioRunIdentity,
        );
        const scenarioReceipt = JSON.parse(
          readFileSync(join(scenarioRun, "receipt.json"), "utf8"),
        );
        assert.equal(scenarioReceipt.status, expectation.status);
        assert.equal(
          scenarioReceipt.outputContract.normalization,
          expectation.normalization,
        );
        if (scenario === "fleet-workspace-copy") {
          assert.equal(
            existsSync(join(scenarioRun, "workspace", "fixture.txt")),
            true,
          );
          const scenarioMetadata = JSON.parse(
            readFileSync(join(scenarioRun, "metadata.json"), "utf8"),
          );
          assert.equal(
            scenarioMetadata.workingDirectoryPolicy,
            "workspace-copy",
          );
          assert.equal(
            scenarioMetadata.workingDirectory,
            "copy-under-run-directory",
          );
        }
      }
      for (const [scenario, expectation] of Object.entries({
        "fleet-timeout-process-group": {
          reason: "timeout",
          status: "timeout",
        },
        "fleet-stdout-limit": {
          reason: "stdout-limit-exceeded",
          status: "stdout-limit-exceeded",
          evidenceFile: "stdout.txt",
        },
        "fleet-stderr-limit": {
          reason: "stderr-limit-exceeded",
          status: "stderr-limit-exceeded",
          evidenceFile: "stderr.txt",
        },
      })) {
        assert.deepEqual(
          qualificationResults.find(
            (result) => result.scenario === scenario,
          ).observed,
          {
            terminalState: "blocked",
            output: null,
            reason: expectation.reason,
          },
        );
        const scenarioRunsRoot = join(
          qualificationRun,
          "scenarios",
          scenario,
          "fleet-runs",
        );
        const [scenarioRunIdentity] = readdirSync(scenarioRunsRoot);
        const scenarioRun = join(
          scenarioRunsRoot,
          scenarioRunIdentity,
        );
        const scenarioReceipt = JSON.parse(
          readFileSync(join(scenarioRun, "receipt.json"), "utf8"),
        );
        assert.equal(scenarioReceipt.status, expectation.status);
        if (expectation.evidenceFile) {
          assert.equal(
            statSync(
              join(scenarioRun, expectation.evidenceFile),
            ).size,
            4096,
          );
        }
        if (scenario === "fleet-timeout-process-group") {
          assert.equal(
            existsSync(
              join(
                scenarioRun,
                "workspace",
                "descendant-survived.txt",
              ),
            ),
            false,
          );
        }
      }

      const providers = runJson(cli, ["provider"], context);
      assert.equal(providers.status, 0);
      assert.equal(providers.receipt.result.schemaVersion, "1");
      assert.equal(providers.receipt.result.operation, "list");
      assert.equal(providers.receipt.result.providers.length, 5);
      assert.equal(
        providers.receipt.result.providers.every(
          (provider) =>
            provider.disabled &&
            !provider.qualified &&
            provider.blocked,
        ),
        true,
      );

      const uninstalled = runJson(cli, ["uninstall"], context);
      assert.equal(uninstalled.status, 0);
      assert.equal(uninstalled.receipt.changed, true);
      assert.equal(uninstalled.receipt.result.installation, "removed");
      assert.deepEqual(snapshotFiles(projectDirectory), before);

      const uninstalledAgain = runJson(cli, ["uninstall"], context);
      assert.equal(uninstalledAgain.status, 0);
      assert.equal(uninstalledAgain.receipt.changed, false);
      assert.equal(uninstalledAgain.receipt.result.installation, "absent");
      assert.deepEqual(snapshotFiles(projectDirectory), before);

      const missingInstallation = runJson(cli, ["doctor"], context);
      assert.equal(missingInstallation.status, 2);
      assert.equal(missingInstallation.receipt.status, "blocked");
      assert.equal(missingInstallation.receipt.exitCode, 2);
      assert.equal(
        missingInstallation.receipt.error.code,
        "INSTALLATION_NOT_FOUND",
      );

      const notARepository = join(sandbox, "not-a-repository");
      mkdirSync(notARepository);
      const blockedInit = runJson(cli, ["init"], {
        ...context,
        projectDirectory: notARepository,
      });
      assert.equal(blockedInit.status, 2);
      assert.equal(blockedInit.receipt.status, "blocked");
      assert.equal(blockedInit.receipt.exitCode, 2);
      assert.equal(blockedInit.receipt.error.code, "GIT_WORKTREE_REQUIRED");
      assert.deepEqual(snapshotFiles(notARepository), {});
      assert.equal(statSync(notARepository).isDirectory(), true);
    },
  );
});

test("packed qualification fails closed when native runtime entry points are enabled", () => {
  withPackedCli(
    ({
      cli,
      codexInvocation,
      homeDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
    }) => {
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
        runtimePath,
      };
      assert.equal(runJson(cli, ["init"], context).status, 0);
      mkdirSync(join(homeDirectory, ".codex"));
      writeFileSync(
        join(homeDirectory, ".codex", "config.toml"),
        [
          "[agents]",
          "enabled = true",
          "[features]",
          "multi_agent = true",
          "",
        ].join("\n"),
      );
      rmSync(codexInvocation, { force: true });

      const qualified = runJson(cli, ["qualify"], context);
      assert.equal(qualified.status, 2);
      assert.equal(existsSync(codexInvocation), false);
      assert.equal(
        qualified.receipt.error.code,
        "OFFLINE_QUALIFICATION_MISMATCH",
      );
      assert.deepEqual(qualified.receipt.result.counts, {
        total: 17,
        passed: 16,
        failed: 1,
      });
      const runDirectory = join(
        homeDirectory,
        ".codex-ground-control",
        "evidence",
        "qualification",
        qualified.receipt.result.runIdentity,
      );
      const issues = JSON.parse(
        readFileSync(join(runDirectory, "issues.json"), "utf8"),
      );
      assert.equal(issues.openCount, 1);
      assert.equal(
        issues.issues[0].scenario,
        "fleet-native-write-boundaries",
      );
      const policy = JSON.parse(
        readFileSync(
          join(
            runDirectory,
            "scenarios",
            "fleet-native-write-boundaries",
            "policy-checks.json",
          ),
          "utf8",
        ),
      );
      assert.equal(
        policy.checks.find(
          ({ label }) => label === "ambient-native-runtime",
        ).observedCode,
        "enabled",
      );
      writeFileSync(
        join(homeDirectory, ".codex", "config.toml"),
        [
          "[agents]",
          "enabled = false",
          "[features]",
          "multi_agent = false",
          "",
        ].join("\n"),
      );
      const drifted = runJson(
        cli,
        [
          "qualify",
          "verify",
          qualified.receipt.result.runIdentity,
          qualified.receipt.result.evidence.anchor,
        ],
        context,
      );
      assert.equal(drifted.status, 2);
      assert.equal(
        drifted.receipt.error.code,
        "QUALIFICATION_DRIFTED",
      );
    },
  );
});

test("qualification mismatches create stable reproducible issues", () => {
  withPackedCli(
    ({
      cli,
      homeDirectory,
      installDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
    }) => {
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
        runtimePath,
      };
      assert.equal(runJson(cli, ["init"], context).status, 0);

      const campaignPath = join(
        installDirectory,
        "node_modules",
        "codex-ground-control",
        "fixtures",
        "qualification",
        "offline-core-v1.json",
      );
      const campaign = JSON.parse(readFileSync(campaignPath, "utf8"));
      campaign.scenarios.find(
        ({ id }) => id === "offline-uppercase",
      ).expected.output = "NOT-GROUND-CONTROL";
      writeFileSync(
        campaignPath,
        `${JSON.stringify(campaign, null, 2)}\n`,
      );
      const failed = runJson(cli, ["qualify"], context);

      assert.equal(failed.status, 2);
      assert.equal(failed.receipt.changed, true);
      assert.equal(
        failed.receipt.result.terminalState,
        "release-failed",
      );
      assert.deepEqual(failed.receipt.result.counts, {
        total: 17,
        passed: 16,
        failed: 1,
      });
      assert.equal(
        failed.receipt.error.code,
        "OFFLINE_QUALIFICATION_MISMATCH",
      );

      const issuesPath = join(
        homeDirectory,
        ".codex-ground-control",
        "evidence",
        "qualification",
        failed.receipt.result.runIdentity,
        "issues.json",
      );
      const issueLedger = JSON.parse(
        readFileSync(issuesPath, "utf8"),
      );
      assert.equal(issueLedger.schemaVersion, "1");
      assert.equal(issueLedger.openCount, 1);
      assert.equal(issueLedger.issues.length, 1);
      const [issue] = issueLedger.issues;
      assert.match(issue.id, /^qual-[0-9a-f]{16}$/);
      assert.equal(issue.scenario, "offline-uppercase");
      assert.equal(issue.category, "functional");
      assert.equal(issue.severity, "high");
      assert.deepEqual(issue.expected, {
        terminalState: "passed",
        output: "NOT-GROUND-CONTROL",
        reason: null,
      });
      assert.deepEqual(issue.observed, {
        terminalState: "passed",
        output: "GROUND-CONTROL",
        reason: null,
      });
      assert.deepEqual(issue.mismatches, [
        'output: expected "NOT-GROUND-CONTROL", observed "GROUND-CONTROL"',
      ]);
      assert.equal(
        issue.evidence,
        "scenarios/offline-uppercase/observation.json",
      );
      assert.equal(
        issue.reproduction,
        `codex-ground-control qualify reproduce ` +
          `${failed.receipt.result.runIdentity} offline-uppercase --json`,
      );
      assert.equal(
        issue.nextAction,
        "Restore the deterministic packaged fixture.",
      );
      assert.equal(issue.status, "open");

      const failedAgain = runJson(cli, ["qualify"], context);
      assert.equal(failedAgain.status, 2);
      assert.notEqual(
        failedAgain.receipt.result.runIdentity,
        failed.receipt.result.runIdentity,
      );
      const repeatedLedger = JSON.parse(
        readFileSync(
          join(
            homeDirectory,
            ".codex-ground-control",
            "evidence",
            "qualification",
            failedAgain.receipt.result.runIdentity,
            "issues.json",
          ),
          "utf8",
        ),
      );
      assert.equal(repeatedLedger.issues[0].id, issue.id);
    },
  );
});

test("packed qualification verifies evidence against the external anchor", () => {
  withPackedCli(
    ({
      cli,
      homeDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
    }) => {
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
        runtimePath,
      };
      assert.equal(runJson(cli, ["init"], context).status, 0);
      const qualificationRoot = join(
        homeDirectory,
        ".codex-ground-control",
        "evidence",
        "qualification",
      );
      assert.equal(existsSync(qualificationRoot), false);
      const missingEvidence = runJson(
        cli,
        ["qualify", "verify", "missing-run", "0".repeat(64)],
        context,
      );
      assert.equal(missingEvidence.status, 2);
      assert.equal(missingEvidence.receipt.changed, false);
      assert.equal(existsSync(qualificationRoot), false);

      const qualified = runJson(cli, ["qualify"], context);
      assert.equal(qualified.status, 0);
      const { runIdentity, evidence, counts, runtimeFingerprint } =
        qualified.receipt.result;

      const verified = runJson(
        cli,
        ["qualify", "verify", runIdentity, evidence.anchor],
        context,
      );
      assert.equal(verified.status, 0);
      assert.equal(verified.receipt.changed, false);
      assert.deepEqual(verified.receipt.result, {
        schemaVersion: "1",
        operation: "verify",
        campaign: "offline-core-v1",
        terminalState: "evidence-verified",
        campaignScope: "evidence",
        counts,
        runIdentity,
        evidence,
        runtimeFingerprint,
        network: "not-used",
      });

      const wrongAnchor = runJson(
        cli,
        ["qualify", "verify", runIdentity, "0".repeat(64)],
        context,
      );
      assert.equal(wrongAnchor.status, 2);
      assert.equal(
        wrongAnchor.receipt.error.code,
        "QUALIFICATION_EVIDENCE_ANCHOR_MISMATCH",
      );
      assert.equal(wrongAnchor.receipt.changed, false);
      assert.equal(
        Object.hasOwn(wrongAnchor.receipt, "result"),
        false,
      );

      const originalIndexPath = join(
        homeDirectory,
        ".codex-ground-control",
        "evidence",
        "qualification",
        runIdentity,
        "evidence-index.json",
      );
      const originalIndex = readFileSync(originalIndexPath);
      const reproduced = runJson(
        cli,
        [
          "qualify",
          "reproduce",
          runIdentity,
          "provider-network-fail-closed",
        ],
        context,
      );
      assert.equal(reproduced.status, 0);
      assert.equal(reproduced.receipt.changed, true);
      assert.equal(
        reproduced.receipt.result.operation,
        "reproduce",
      );
      assert.equal(
        reproduced.receipt.result.terminalState,
        "reproduction-passed",
      );
      assert.equal(
        reproduced.receipt.result.campaignScope,
        "single-scenario",
      );
      assert.deepEqual(reproduced.receipt.result.counts, {
        total: 1,
        passed: 1,
        failed: 0,
      });
      assert.notEqual(
        reproduced.receipt.result.runIdentity,
        runIdentity,
      );
      assert.deepEqual(readFileSync(originalIndexPath), originalIndex);
    },
  );
});

test("packed qualification rejects damaged, unindexed, drifted, and structurally invalid evidence", () => {
  withPackedCli(
    ({
      cli,
      homeDirectory,
      installDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
    }) => {
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
        runtimePath,
      };
      assert.equal(runJson(cli, ["init"], context).status, 0);
      const runDirectory = (runIdentity) =>
        join(
          homeDirectory,
          ".codex-ground-control",
          "evidence",
          "qualification",
          runIdentity,
        );
      const qualify = () => {
        const completed = runJson(cli, ["qualify"], context);
        assert.equal(completed.status, 0);
        return completed.receipt.result;
      };
      const verify = (result, anchor = result.evidence.anchor) =>
        runJson(
          cli,
          ["qualify", "verify", result.runIdentity, anchor],
          context,
        );

      const missing = qualify();
      rmSync(join(runDirectory(missing.runIdentity), "summary.json"));
      assert.equal(
        verify(missing).receipt.error.code,
        "QUALIFICATION_EVIDENCE_MISSING",
      );

      const modified = qualify();
      writeFileSync(
        join(runDirectory(modified.runIdentity), "summary.json"),
        '{"tampered":true}\n',
      );
      assert.equal(
        verify(modified).receipt.error.code,
        "QUALIFICATION_EVIDENCE_HASH_MISMATCH",
      );

      const unindexed = qualify();
      writeFileSync(
        join(runDirectory(unindexed.runIdentity), "not-indexed.txt"),
        "unexpected\n",
      );
      assert.equal(
        verify(unindexed).receipt.error.code,
        "QUALIFICATION_EVIDENCE_UNINDEXED_FILE",
      );

      const structureDrift = qualify();
      const structureRun = runDirectory(structureDrift.runIdentity);
      const resultsPath = join(structureRun, "results.json");
      const results = JSON.parse(readFileSync(resultsPath, "utf8"));
      results.unexpected = true;
      const resultsBytes = Buffer.from(
        `${JSON.stringify(results, null, 2)}\n`,
      );
      writeFileSync(resultsPath, resultsBytes);
      const indexPath = join(structureRun, "evidence-index.json");
      const index = JSON.parse(readFileSync(indexPath, "utf8"));
      const resultsEntry = index.entries.find(
        ({ path }) => path === "results.json",
      );
      resultsEntry.bytes = resultsBytes.byteLength;
      resultsEntry.sha256 = sha256(resultsBytes);
      const rewrittenIndex = Buffer.from(
        `${JSON.stringify(index, null, 2)}\n`,
      );
      writeFileSync(indexPath, rewrittenIndex);
      const structureFailure = verify(
        structureDrift,
        sha256(rewrittenIndex),
      );
      assert.equal(structureFailure.status, 2);
      assert.equal(
        structureFailure.receipt.error.code,
        "QUALIFICATION_EVIDENCE_STRUCTURE_INVALID",
      );

      const drifted = qualify();
      const campaignPath = join(
        installDirectory,
        "node_modules",
        "codex-ground-control",
        "fixtures",
        "qualification",
        "offline-core-v1.json",
      );
      const originalCampaign = readFileSync(campaignPath);
      writeFileSync(
        campaignPath,
        Buffer.concat([originalCampaign, Buffer.from("\n")]),
      );
      const driftReceipt = verify(drifted);
      assert.equal(driftReceipt.status, 2);
      assert.equal(
        driftReceipt.receipt.error.code,
        "QUALIFICATION_DRIFTED",
      );
      assert.equal(
        driftReceipt.receipt.result.terminalState,
        "qualification-drifted",
      );
      assert.equal(driftReceipt.receipt.changed, false);
      writeFileSync(campaignPath, originalCampaign);

      const componentDrifted = qualify();
      const safeFilesPath = join(
        installDirectory,
        "node_modules",
        "codex-ground-control",
        "src",
        "safe-files.js",
      );
      const originalSafeFiles = readFileSync(safeFilesPath);
      writeFileSync(
        safeFilesPath,
        Buffer.concat([originalSafeFiles, Buffer.from("\n")]),
      );
      const componentDriftReceipt = verify(componentDrifted);
      assert.equal(componentDriftReceipt.status, 2);
      assert.equal(
        componentDriftReceipt.receipt.error.code,
        "QUALIFICATION_DRIFTED",
      );
      assert.equal(
        componentDriftReceipt.receipt.result.terminalState,
        "qualification-drifted",
      );
      writeFileSync(safeFilesPath, originalSafeFiles);

      const secretValues = [
        "ticket05-api-key-value",
        "ticket05-token-value",
        "ticket05-password-value",
        "ticket05-unauthorized-value",
      ];
      const secretRun = runJson(cli, ["qualify"], {
        ...context,
        environment: {
          API_KEY: secretValues[0],
          ACCESS_TOKEN: secretValues[1],
          PASSWORD: secretValues[2],
          UNAUTHORIZED_FIXTURE_VALUE: secretValues[3],
        },
      });
      assert.equal(secretRun.status, 0);
      const serializedEvidence = Object.values(
        snapshotFiles(
          runDirectory(secretRun.receipt.result.runIdentity),
        ),
      ).join("\n");
      for (const secret of secretValues) {
        assert.equal(serializedEvidence.includes(secret), false);
        assert.equal(secretRun.stdout.includes(secret), false);
      }
    },
  );
});

test("packed qualification fails closed on validator and campaign schema drift", () => {
  withPackedCli(
    ({
      cli,
      homeDirectory,
      installDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
    }) => {
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
        runtimePath,
      };
      assert.equal(runJson(cli, ["init"], context).status, 0);
      const packageRoot = join(
        installDirectory,
        "node_modules",
        "codex-ground-control",
      );
      const receiptSchemaPath = join(
        packageRoot,
        "schemas",
        "qualification",
        "public-receipt.schema.json",
      );
      const originalReceiptSchema = readFileSync(receiptSchemaPath);
      const receiptSchema = JSON.parse(originalReceiptSchema);
      receiptSchema.properties.status.enum.push("complete");
      writeFileSync(
        receiptSchemaPath,
        `${JSON.stringify(receiptSchema, null, 2)}\n`,
      );
      const validatorDrift = runJson(
        cli,
        ["qualify"],
        context,
      );
      assert.equal(validatorDrift.status, 2);
      assert.equal(
        validatorDrift.receipt.error.code,
        "QUALIFICATION_VALIDATOR_DRIFT",
      );
      assert.equal(validatorDrift.receipt.changed, false);
      writeFileSync(receiptSchemaPath, originalReceiptSchema);

      const campaignPath = join(
        packageRoot,
        "fixtures",
        "qualification",
        "offline-core-v1.json",
      );
      const campaign = JSON.parse(readFileSync(campaignPath, "utf8"));
      campaign.unexpected = true;
      writeFileSync(
        campaignPath,
        `${JSON.stringify(campaign, null, 2)}\n`,
      );
      const campaignDrift = runJson(cli, ["qualify"], context);
      assert.equal(campaignDrift.status, 2);
      assert.equal(
        campaignDrift.receipt.error.code,
        "QUALIFICATION_CAMPAIGN_INVALID",
      );
      assert.equal(campaignDrift.receipt.changed, false);
    },
  );
});

test("packed CLI keeps human lifecycle output concise and stable", () => {
  withPackedCli(
    ({
      cli,
      homeDirectory,
      networkTrap,
      projectDirectory,
      runtimePath,
    }) => {
      const environment = {
        PATH: runtimePath,
        HOME: homeDirectory,
        TMPDIR: tmpdir(),
        NODE_OPTIONS: `--import=${pathToFileURL(networkTrap).href}`,
      };
      const invoke = (...args) =>
        run(cli, args, { cwd: projectDirectory, env: environment });
      const canonicalProject = realpathSync(projectDirectory);

      const initialized = invoke("init");
      assert.equal(
        initialized.status,
        0,
        `init failed\nstdout:\n${initialized.stdout}\nstderr:\n${initialized.stderr}`,
      );
      assert.equal(
        initialized.stdout,
        `Initialized Ground Control in ${canonicalProject}.\n`,
      );
      assert.equal(initialized.stderr, "");

      const diagnosed = invoke("doctor");
      assert.equal(diagnosed.status, 0);
      assert.match(
        diagnosed.stdout,
        /^Ground Control doctor: healthy \(project\)\n/,
      );
      assert.match(diagnosed.stdout, /^Core \(passed\):$/m);
      assert.match(diagnosed.stdout, /^Optional providers:$/m);
      assert.match(diagnosed.stdout, /^Fail-closed boundaries:$/m);
      assert.equal(diagnosed.stderr, "");

      const qualified = invoke("qualify");
      assert.equal(qualified.status, 0);
      assert.match(
        qualified.stdout,
        /^Offline qualification passed: offline-core-v1 \(17\/17\); run [a-zA-Z0-9-]+; evidence [0-9a-f]{64}\.\n$/,
      );
      assert.equal(qualified.stderr, "");
      const runIdentity = qualified.stdout.match(
        /; run ([a-zA-Z0-9-]+);/,
      )[1];

      const reproduced = invoke(
        "qualify",
        "reproduce",
        runIdentity,
        "provider-network-fail-closed",
      );
      assert.equal(reproduced.status, 0);
      assert.match(
        reproduced.stdout,
        /^Qualification reproduction passed: offline-core-v1 \(1\/1\); run [a-zA-Z0-9-]+; not a release qualification\.\n$/,
      );
      assert.equal(reproduced.stderr, "");

      const providers = invoke("provider", "list");
      assert.equal(providers.status, 0);
      assert.match(
        providers.stdout,
        /^Ground Control providers:\n/,
      );
      assert.match(
        providers.stdout,
        /^  pi-glm: blocked/m,
      );
      assert.equal(providers.stderr, "");

      const uninstalled = invoke("uninstall");
      assert.equal(uninstalled.status, 0);
      assert.equal(
        uninstalled.stdout,
        `Uninstalled Ground Control from ${canonicalProject}.\n`,
      );
      assert.equal(uninstalled.stderr, "");

      const blocked = invoke("doctor");
      assert.equal(blocked.status, 2);
      assert.match(
        blocked.stdout,
        /^Ground Control doctor: blocked \(project\)\n/,
      );
      assert.match(
        blocked.stdout,
        /^  MISSING installation\.manifest: installation manifest missing/m,
      );
      assert.equal(
        blocked.stderr,
        "Ground Control is not initialized in this Git worktree.\n",
      );
    },
  );
});

test("packed CLI distinguishes invalid usage in human and JSON modes", () => {
  withPackedCli(({ cli, homeDirectory, projectDirectory }) => {
    const environment = {
      PATH: process.env.PATH,
      HOME: homeDirectory,
      TMPDIR: tmpdir(),
    };
    const human = run(cli, ["unknown"], {
      cwd: projectDirectory,
      env: environment,
    });
    const machine = run(cli, ["unknown", "--json"], {
      cwd: projectDirectory,
      env: environment,
    });

    assert.equal(human.status, 64);
    assert.equal(human.stdout, "");
    assert.equal(
      human.stderr,
      "Unknown command: unknown\nRun 'codex-ground-control --help' for usage.\n",
    );

    assert.equal(machine.status, 64);
    assert.equal(machine.stderr, "");
    assert.equal(machine.stdout.trim().split("\n").length, 1);
    assert.deepEqual(JSON.parse(machine.stdout), {
      schemaVersion: "1",
      product: "codex-ground-control",
      version: "0.2.0",
      command: null,
      status: "invalid-usage",
      exitCode: 64,
      error: {
        code: "UNKNOWN_COMMAND",
        message: "Unknown command: unknown",
      },
    });
  });
});

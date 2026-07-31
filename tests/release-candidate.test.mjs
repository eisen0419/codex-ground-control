import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateNpmRegistryPackage,
} from "../src/release-name-checks.js";

const repositoryRoot = new URL("..", import.meta.url);

test("npm release name check accepts an existing package only when the target version is new", () => {
  const existing = evaluateNpmRegistryPackage(
    {
      status: 200,
      body: {
        name: "codex-ground-control",
        versions: {
          "0.1.0": {},
        },
        "dist-tags": {
          latest: "0.1.0",
        },
        maintainers: [
          {
            name: "eisen0419",
            email: "eisen0419@example.test",
          },
        ],
      },
    },
    {
      name: "codex-ground-control",
      version: "0.2.0",
    },
  );
  assert.deepEqual(existing, {
    checked: true,
    packageExists: true,
    targetVersionAvailable: true,
    httpStatus: 200,
    latest: "0.1.0",
    existingVersions: ["0.1.0"],
    maintainers: ["eisen0419"],
  });

  assert.equal(
    evaluateNpmRegistryPackage(
      {
        status: 200,
        body: {
          name: "codex-ground-control",
          versions: {
            "0.1.0": {},
            "0.2.0": {},
          },
        },
      },
      {
        name: "codex-ground-control",
        version: "0.2.0",
      },
    ).targetVersionAvailable,
    false,
  );

  assert.deepEqual(
    evaluateNpmRegistryPackage(
      {
        status: 404,
        body: null,
      },
      {
        name: "codex-ground-control",
        version: "0.2.0",
      },
    ),
    {
      checked: true,
      packageExists: false,
      targetVersionAvailable: true,
      httpStatus: 404,
      latest: null,
      existingVersions: [],
      maintainers: [],
    },
  );
});

test("public docs preserve stable v0.2 while describing the unpublished v0.3 prerelease", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const readmeZh = readFileSync(
    new URL("../docs/readme/README.zh-CN.md", import.meta.url),
    "utf8",
  );
  const architecture = JSON.parse(
    readFileSync(
      new URL(
        "../docs/architecture/ground-control.architecture.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const releasing = readFileSync(
    new URL("../docs/RELEASING.md", import.meta.url),
    "utf8",
  );
  const appNativeContract = readFileSync(
    new URL("../docs/specs/app-native-v0.2.md", import.meta.url),
    "utf8",
  );
  const appNativeV03Contract = readFileSync(
    new URL("../docs/specs/app-native-v0.3.md", import.meta.url),
    "utf8",
  );
  const groundControlSkill = readFileSync(
    new URL(
      "../assets/overlays/ground-control/SKILL.md",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(
    readme,
    /ChatGPT desktop app on macOS/,
  );
  assert.match(
    readme,
    /No standalone Codex CLI is required/,
  );
  assert.match(
    readme,
    /App—not Ground Control—owns task and\s+Worktree lifecycle/,
  );
  assert.match(
    readme,
    /codex-ground-control-0\.2\.0\.tgz/,
  );
  assert.match(
    readme,
    /latest published release: v0\.2\.0/i,
  );
  assert.match(
    readme,
    /unpublished candidate: v0\.3\.0-rc\.0/i,
  );
  assert.match(
    readme,
    /\.mcp\.v0\.3\.json[\s\S]*\.mcp\.json[\s\S]*v0\.2\.0\s+rollback/i,
  );
  assert.match(
    readme,
    /npm `latest` remains v0\.2\.0/i,
  );
  assert.match(
    readme,
    /npx --yes codex-ground-control@0\.2\.0 init --dry-run/,
  );
  assert.match(
    readmeZh,
    /不需要单独安装 Codex CLI/,
  );
  assert.match(readmeZh, /最新正式版：v0\.2\.0/);
  assert.match(
    readmeZh,
    /尚未发布的候选版：v0\.3\.0-rc\.0/,
  );
  assert.match(
    readmeZh,
    /\.mcp\.v0\.3\.json[\s\S]*\.mcp\.json[\s\S]*v0\.2\.0\s+回滚/,
  );
  assert.match(
    readmeZh,
    /npm `latest` 仍为 v0\.2\.0/,
  );
  assert.match(
    readme,
    /independent community project[\s\S]*not\s+affiliated with or endorsed by OpenAI or Matt Pocock/i,
  );
  assert.match(readme, /single Codex coordinator/i);
  assert.match(readme, /external\s+leaf adapters/i);
  assert.match(
    readme,
    /native and external write gates remain blocked/i,
  );
  for (const document of [
    readme,
    readmeZh,
    appNativeContract,
    groundControlSkill,
  ]) {
    assert.match(
      document,
      /detected[\s\S]*authenticated[\s\S]*enabled[\s\S]*qualified[\s\S]*current[\s\S]*run-authorized/i,
    );
  }
  assert.match(appNativeContract, /ProviderRuntimeProfile\/Auth/);
  assert.match(appNativeContract, /LeafRunIntent v1/);
  assert.match(appNativeContract, /LeafRunEvent v1/);
  assert.match(appNativeContract, /RuntimeUsage v1/);
  assert.match(
    appNativeContract,
    /native plugin\s+permission setting[\s\S]*Provider process/i,
  );
  assert.match(
    groundControlSkill,
    /prepare_leaf_run[\s\S]*start_leaf_run[\s\S]*get_leaf_run/i,
  );
  assert.match(
    readme,
    /qualify_app_surface[\s\S]*zero Provider starts/i,
  );
  assert.match(
    readmeZh,
    /qualify_app_surface[\s\S]*Provider 启动数为 `0`/,
  );
  assert.match(
    groundControlSkill,
    /qualify_app_surface[\s\S]*must not[\s\S]*Provider/i,
  );
  assert.match(
    appNativeContract,
    /APP-19[\s\S]*qualify_app_surface[\s\S]*zero Provider/i,
  );
  for (const document of [readme, readmeZh]) {
    assert.match(document, /MCP App/i);
    assert.match(
      document,
      /unknown[\s\S]*(?:never estimated|不估算)/i,
    );
  }
  assert.match(
    appNativeContract,
    /AGY[\s\S]*system keyring/i,
  );
  assert.match(
    appNativeContract,
    /Grok[\s\S]*~\/\.grok\/auth\.json[\s\S]*disposable `GROK_HOME`/i,
  );
  assert.deepEqual(
    architecture.connections
      .slice(0, 9)
      .map(({ from, to }) => `${from}->${to}`),
    [
      "developer->app",
      "app->task",
      "task->skill",
      "skill->mcp-app",
      "mcp-app->intent",
      "intent->gate",
      "gate->leaf-worker",
      "leaf-worker->fleet",
      "fleet->providers",
    ],
  );
  const architectureComponents = new Map(
    architecture.components.map((component) => [component.id, component]),
  );
  assert.ok(
    architectureComponents.get("runtime").pos[1] >
      architectureComponents.get("skill").pos[1],
  );
  assert.equal(
    architectureComponents.get("runtime").tag,
    "behind the skill",
  );
  assert.equal(
    architectureComponents.get("mcp-app").label,
    "MCP App Status Card",
  );
  assert.equal(
    architectureComponents.get("intent").tag,
    "10-minute expiry",
  );
  assert.equal(
    architectureComponents.get("runtime-profile").label,
    "Provider Runtime Profile",
  );
  assert.equal(
    architectureComponents.get("auth-binding").label,
    "Provider-owned Auth",
  );
  assert.match(
    releasing,
    /npm run release-candidate -- --allow-live/,
  );
  assert.match(releasing, /codex-ground-control-0\.3\.0-rc\.0\.tgz/);
  assert.match(releasing, /npm `latest` remains\s+v0\.2\.0/i);
  assert.match(releasing, /non-`latest` dist-tag/i);
  assert.match(releasing, /release-report\.json/);
  assert.match(
    appNativeV03Contract,
    /Status: local v0\.3\.0-rc\.0 candidate assembled; published production remains v0\.2\.0/,
  );
  assert.match(
    appNativeV03Contract,
    /\.mcp\.v0\.3\.json[\s\S]*\.mcp\.json[\s\S]*stable v0\.2\.0 rollback/i,
  );
  assert.match(releasing, /exit code `2`/);
  assert.match(
    releasing,
    /does not create a GitHub remote, push, publish to npm, or create a\s+release/i,
  );
});

test("release candidate is reproducible at the packed CLI seam and skipped gates stay blocked", () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), "codex-ground-control-release-test-"),
  );
  const outputDirectory = join(sandbox, "candidate");
  const runtimeBin = join(sandbox, "runtime-bin");
  const secret = "release-test-secret-must-not-leak";
  mkdirSync(runtimeBin);
  writeFileSync(
    join(runtimeBin, "codex"),
    "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n",
  );
  chmodSync(join(runtimeBin, "codex"), 0o755);

  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-candidate.mjs",
        "--output",
        outputDirectory,
        "--skip-repository-checks",
        "--skip-live",
        "--skip-name-checks",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${runtimeBin}:${process.env.PATH}`,
          RELEASE_TEST_API_KEY: secret,
        },
        timeout: 120_000,
      },
    );

    assert.equal(
      result.status,
      2,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(result.stderr, "");
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary, {
      schemaVersion: "1",
      status: "blocked",
      version: "0.3.0-rc.0",
      report: "release-report.json",
      markdownReport: "RELEASE_CANDIDATE.md",
      tarball: "codex-ground-control-0.3.0-rc.0.tgz",
    });

    const reportBytes = readFileSync(
      join(outputDirectory, "release-report.json"),
    );
    const report = JSON.parse(reportBytes);
    assert.equal(report.schemaVersion, "1");
    assert.equal(report.product, "codex-ground-control");
    assert.equal(report.version, "0.3.0-rc.0");
    assert.equal(report.status, "blocked");
    assert.deepEqual(report.publication, {
      npm: "not-published",
      github: "not-created",
      pushed: false,
      releaseCreated: false,
    });
    assert.match(report.package.sha256, /^[0-9a-f]{64}$/);
    assert.equal(report.package.reproducible, true);
    assert.deepEqual(report.package.packHashes, [
      report.package.sha256,
      report.package.sha256,
    ]);
    assert.equal(report.package.scan.status, "passed");
    assert.equal(report.package.scan.secretMatches, 0);
    assert.equal(report.package.scan.personalPathMatches, 0);
    assert.equal(report.package.scan.privateArtifactFiles, 0);
    assert.equal(report.package.scan.undeclaredThirdPartyFiles, 0);
    assert.equal(report.package.licenses.status, "passed");
    assert.equal(report.package.licenses.runtimeDependencies, 3);
    assert.equal(report.package.licenses.bundleDependencies, 3);
    assert.ok(
      report.package.licenses.bundledPackages >= 3,
    );
    assert.ok(
      report.package.licenses.bundledLicenseFiles >=
        report.package.licenses.bundledPackages,
    );
    assert.deepEqual(report.hostSurface, {
      status: "passed",
      pluginVersion: "0.3.0-rc.0",
      defaultMcpConfig: ".mcp.v0.3.json",
      rollbackMcpConfig: ".mcp.json",
      serverId: "codex-ground-control-v0.3",
      tools: [
        "delegate_leaf",
        "inspect_leaf",
        "cancel_leaf",
        "render_leaf_card",
      ],
      resourceUri:
        "ui://codex-ground-control/v0.3/leaf-session.html",
      widgetMarker: "compact-progress",
      stateRootMode: "0700",
      providerProcessStarted: false,
      providerSessionDirectoryCreated: false,
      persistedSecretMatches: 0,
    });

    assert.deepEqual(report.repositoryChecks, {
      status: "not-run",
      commands: [
        "npm run release-lock:verify",
        "npm run typecheck",
        "npm test",
      ],
    });
    assert.equal(report.lifecycle.status, "passed");
    assert.equal(report.lifecycle.init.status, "ok");
    assert.equal(report.lifecycle.idempotentInit, true);
    assert.equal(report.lifecycle.doctor.status, "ok");
    assert.equal(report.lifecycle.offlineQualification.status, "ok");
    assert.equal(
      report.lifecycle.offlineQualification.terminalState,
      "release-passed",
    );
    assert.deepEqual(
      report.lifecycle.offlineQualification.counts,
      { total: 17, passed: 17, failed: 0 },
    );
    assert.equal(report.lifecycle.evidenceVerified, true);
    assert.equal(report.lifecycle.uninstall.status, "ok");
    assert.equal(report.lifecycle.exactProjectRestoration, true);
    assert.equal(report.lifecycle.conflictPreservedUserChange, true);

    assert.equal(report.liveEvidence.status, "not-run");
    assert.deepEqual(
      report.liveEvidence.providers.map(
        ({ id, terminalState, receipt }) => ({
          id,
          terminalState,
          receipt,
        }),
      ),
      [
        "pi-glm",
        "pi-deepseek",
        "pi-minimax",
        "agy",
        "grok",
      ].map((id) => ({
        id,
        terminalState: "not-run",
        receipt: null,
      })),
    );
    assert.equal(report.nameChecks.status, "not-run");
    assert.deepEqual(report.limitations, [
      "repository-checks-not-run",
      "live-provider-campaigns-not-run",
      "name-availability-checks-not-run",
      "native-agent-execution-blocked",
      "external-workspace-write-blocked",
    ]);
    assert.deepEqual(report.blockingLimitations, [
      "repository-checks-not-run",
      "live-provider-campaigns-not-run",
      "name-availability-checks-not-run",
    ]);

    const markdown = readFileSync(
      join(outputDirectory, "RELEASE_CANDIDATE.md"),
      "utf8",
    );
    assert.match(markdown, /^# Ground Control for Codex v0\.3\.0-rc\.0 release candidate/m);
    assert.match(markdown, /Packed v0\.3 Host surface: \*\*PASSED\*\*/);
    assert.match(markdown, /Overall gate: \*\*BLOCKED\*\*/);
    assert.match(markdown, /Offline evidence: \*\*PASSED \(17\/17\)\*\*/);
    assert.match(markdown, /Live provider evidence: \*\*NOT RUN\*\*/);
    assert.match(markdown, /No npm publish, GitHub remote, push, or release was created\./);

    for (const serialized of [
      result.stdout,
      reportBytes.toString("utf8"),
      markdown,
    ]) {
      assert.equal(serialized.includes(secret), false);
      assert.equal(serialized.includes(repositoryRoot.pathname), false);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("failed live campaigns are isolated, disabled, and leave offline core evidence current", () => {
  const sandbox = mkdtempSync(
    join(tmpdir(), "codex-ground-control-release-live-test-"),
  );
  const outputDirectory = join(sandbox, "candidate");
  const runtimeBin = join(sandbox, "runtime-bin");
  const emptyHome = join(sandbox, "home");
  const victimGrokHome = join(sandbox, "victim-grok");
  const grokInvocation = join(sandbox, "grok-invoked");
  mkdirSync(runtimeBin);
  mkdirSync(emptyHome);
  mkdirSync(victimGrokHome);
  writeFileSync(
    join(victimGrokHome, "auth.json"),
    "symlinked-auth-must-not-be-copied",
  );
  symlinkSync(victimGrokHome, join(emptyHome, ".grok"));
  for (const [name, version] of [
    ["codex", "codex-cli 0.145.0"],
    ["pi", "0.81.1"],
    ["agy", "agy 1.1.7"],
    ["grok", "grok 0.2.93"],
  ]) {
    writeFileSync(
      join(runtimeBin, name),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        `  printf '${version}\\n'`,
        "  exit 0",
        "fi",
        ...(name === "grok"
          ? [`printf 'invoked\\n' > '${grokInvocation}'`]
          : []),
        "printf 'fixture live provider failure\\n' >&2",
        "exit 7",
        "",
      ].join("\n"),
    );
    chmodSync(join(runtimeBin, name), 0o755);
  }

  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/release-candidate.mjs",
        "--output",
        outputDirectory,
        "--skip-repository-checks",
        "--allow-live",
        "--skip-name-checks",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: emptyHome,
          PATH: `${runtimeBin}:${process.env.PATH}`,
        },
        timeout: 120_000,
      },
    );

    assert.equal(
      result.status,
      2,
      `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.equal(result.stderr, "");
    const report = JSON.parse(
      readFileSync(
        join(outputDirectory, "release-report.json"),
        "utf8",
      ),
    );
    assert.equal(report.lifecycle.status, "passed");
    assert.equal(report.liveEvidence.status, "partial");
    assert.equal(report.liveEvidence.coreUnaffected, true);
    assert.equal(
      report.liveEvidence.failureIsolationPassed,
      true,
    );
    assert.equal(
      report.evidenceClasses.live,
      "current-release-candidate-partial",
    );
    assert.equal(
      existsSync(grokInvocation),
      false,
      "release campaign must not follow a symlinked Grok auth parent",
    );
    for (const provider of report.liveEvidence.providers) {
      assert.equal(provider.terminalState, "failed", provider.id);
      assert.match(
        provider.receipt,
        new RegExp(`provider-${provider.id}-qualify\\.json$`),
      );
      assert.match(
        provider.disableReceipt,
        new RegExp(`provider-${provider.id}-disable\\.json$`),
      );
      assert.deepEqual(provider.finalState, {
        disabled: true,
        qualified: false,
        blocked: true,
      });
    }
    assert.ok(
      report.limitations.includes(
        "one-or-more-live-provider-campaigns-failed",
      ),
    );
    assert.deepEqual(report.blockingLimitations, [
      "repository-checks-not-run",
      "name-availability-checks-not-run",
    ]);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

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

const repositoryRoot = new URL("..", import.meta.url);

test("public and maintainer docs describe a version-pinned independent release workflow", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const releasing = readFileSync(
    new URL("../docs/RELEASING.md", import.meta.url),
    "utf8",
  );

  assert.match(
    readme,
    /macOS terminal users who already have\s+Codex CLI installed/,
  );
  assert.match(
    readme,
    /npx --yes codex-ground-control@0\.1\.0 init --dry-run/,
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
  assert.match(
    releasing,
    /npm run release-candidate -- --allow-live/,
  );
  assert.match(releasing, /release-report\.json/);
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
      version: "0.1.0",
      report: "release-report.json",
      markdownReport: "RELEASE_CANDIDATE.md",
      tarball: "codex-ground-control-0.1.0.tgz",
    });

    const reportBytes = readFileSync(
      join(outputDirectory, "release-report.json"),
    );
    const report = JSON.parse(reportBytes);
    assert.equal(report.schemaVersion, "1");
    assert.equal(report.product, "codex-ground-control");
    assert.equal(report.version, "0.1.0");
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
    assert.equal(report.package.licenses.runtimeDependencies, 0);

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

    const markdown = readFileSync(
      join(outputDirectory, "RELEASE_CANDIDATE.md"),
      "utf8",
    );
    assert.match(markdown, /^# Ground Control for Codex v0\.1\.0 release candidate/m);
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
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { diagnoseRuntime } from "../src/doctor.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let packedCli;

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
        files[relative(root, absolutePath)] = readFileSync(absolutePath);
      }
    }
  };
  visit(root);
  return files;
}

function environment(homeDirectory) {
  return {
    PATH: `${packedCli.runtimeBin}:/usr/bin:/bin`,
    HOME: homeDirectory,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    NODE_OPTIONS: `--import=${pathToFileURL(packedCli.networkTrap).href}`,
  };
}

function runJson(args, context, extraEnvironment = {}) {
  const result = spawnSync(packedCli.cli, [...args, "--json"], {
    cwd: context.projectDirectory,
    encoding: "utf8",
    env: {
      ...environment(context.homeDirectory),
      ...extraEnvironment,
    },
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return { ...result, receipt: JSON.parse(result.stdout) };
}

function runHuman(args, context, extraEnvironment = {}) {
  return spawnSync(packedCli.cli, args, {
    cwd: context.projectDirectory,
    encoding: "utf8",
    env: {
      ...environment(context.homeDirectory),
      ...extraEnvironment,
    },
  });
}

function withProject(callback) {
  const projectDirectory = mkdtempSync(
    join(packedCli.sandbox, "project-"),
  );
  const homeDirectory = mkdtempSync(join(packedCli.sandbox, "home-"));
  execFileSync("/usr/bin/git", ["init", "-b", "main"], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: environment(homeDirectory),
  });
  callback({ homeDirectory, projectDirectory });
}

before(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-doctor-"));
  const packDirectory = join(sandbox, "pack");
  const installDirectory = join(sandbox, "install");
  const packHome = join(sandbox, "pack-home");
  const runtimeBin = join(sandbox, "runtime-bin");
  const networkTrap = join(sandbox, "deny-network.mjs");
  mkdirSync(packDirectory);
  mkdirSync(packHome);
  mkdirSync(runtimeBin);
  symlinkSync(process.execPath, join(runtimeBin, "node"));
  writeFileSync(
    join(runtimeBin, "codex"),
    "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n",
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
  const npmEnvironment = {
    PATH: process.env.PATH,
    HOME: packHome,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
    npm_config_cache: join(sandbox, "npm-cache"),
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  };
  const [{ filename }] = JSON.parse(
    execFileSync(
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
    ),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--prefix",
      installDirectory,
      join(packDirectory, filename),
    ],
    {
      encoding: "utf8",
      env: npmEnvironment,
    },
  );
  packedCli = {
    cli: join(
      installDirectory,
      "node_modules",
      ".bin",
      "codex-ground-control",
    ),
    networkTrap,
    runtimeBin,
    sandbox,
  };
});

after(() => {
  rmSync(packedCli.sandbox, { recursive: true, force: true });
});

test("doctor reports a healthy core without promoting unavailable optional providers", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(["doctor"], context);

    assert.equal(diagnosed.status, 0);
    assert.equal(diagnosed.receipt.status, "ok");
    assert.equal(diagnosed.receipt.changed, false);
    assert.equal(diagnosed.receipt.result.schemaVersion, "1");
    assert.equal(diagnosed.receipt.result.health, "healthy");
    assert.equal(diagnosed.receipt.result.scope, "project");
    assert.equal(diagnosed.receipt.result.gates.core.status, "passed");
    for (const provider of ["pi", "agy", "grok"]) {
      assert.equal(
        diagnosed.receipt.result.gates[provider].status,
        "unavailable",
      );
      assert.equal(
        diagnosed.receipt.result.gates[provider].qualification,
        "unqualified",
      );
    }
    for (const gate of ["native", "write"]) {
      assert.equal(
        diagnosed.receipt.result.gates[gate].status,
        "blocked",
      );
      assert.equal(
        diagnosed.receipt.result.gates[gate].expected,
        true,
      );
    }
    const findingIds = diagnosed.receipt.result.findings.map(
      ({ id }) => id,
    );
    assert.deepEqual(
      findingIds,
      [
        "platform.macos",
        "runtime.node",
        "git.worktree",
        "codex.cli",
        "installation.manifest",
        "installation.managed-block",
        "installation.release-lock",
        "installation.skills",
        "runtime.hooks",
        "runtime.codex-config",
        "provider.pi",
        "provider.agy",
        "provider.grok",
        "gate.native",
        "gate.write",
      ],
    );
    for (const finding of diagnosed.receipt.result.findings) {
      assert.equal(typeof finding.id, "string");
      assert.equal(typeof finding.severity, "string");
      assert.equal(typeof finding.state, "string");
      assert.equal(typeof finding.scope, "string");
      assert.equal(typeof finding.observed, "string");
      assert.equal(typeof finding.action, "string");
    }
    assert.equal(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "provider.pi",
      ).state,
      "optional-unavailable",
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("doctor returns a blocker receipt when the Codex CLI is missing", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const emptyRuntimeBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-without-codex-"),
    );
    symlinkSync(process.execPath, join(emptyRuntimeBin, "node"));
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(
      ["doctor"],
      context,
      { PATH: `${emptyRuntimeBin}:/usr/bin:/bin` },
    );

    assert.equal(diagnosed.status, 2);
    assert.equal(diagnosed.receipt.status, "blocked");
    assert.equal(diagnosed.receipt.exitCode, 2);
    assert.equal(diagnosed.receipt.error.code, "DOCTOR_BLOCKED");
    assert.equal(diagnosed.receipt.result.health, "blocked");
    assert.equal(diagnosed.receipt.result.gates.core.status, "blocked");
    assert.deepEqual(
      diagnosed.receipt.result.gates.core.findingIds,
      ["codex.cli"],
    );
    assert.deepEqual(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "codex.cli",
      ),
      {
        id: "codex.cli",
        severity: "error",
        state: "missing",
        scope: "core",
        observed: "Codex CLI not found",
        action: "Install or repair the Codex CLI, then run doctor again.",
      },
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("doctor explains a missing Git boundary without attempting installation checks", () => {
  const context = {
    projectDirectory: mkdtempSync(
      join(packedCli.sandbox, "not-a-worktree-"),
    ),
    homeDirectory: mkdtempSync(join(packedCli.sandbox, "home-")),
  };
  const projectBefore = snapshotFiles(context.projectDirectory);
  const homeBefore = snapshotFiles(context.homeDirectory);

  const diagnosed = runJson(["doctor"], context);

  assert.equal(diagnosed.status, 2);
  assert.equal(diagnosed.receipt.error.code, "GIT_WORKTREE_REQUIRED");
  assert.equal(diagnosed.receipt.result.health, "blocked");
  assert.deepEqual(
    diagnosed.receipt.result.findings.find(
      ({ id }) => id === "git.worktree",
    ),
    {
      id: "git.worktree",
      severity: "error",
      state: "missing",
      scope: "core",
      observed: "no Git worktree",
      action: "Run doctor from inside the Git worktree you intend to use.",
    },
  );
  assert.equal(
    diagnosed.receipt.result.findings.find(
      ({ id }) => id === "installation.manifest",
    ).state,
    "blocked",
  );
  assert.ok(
    diagnosed.receipt.result.gates.core.findingIds.includes(
      "git.worktree",
    ),
  );
  assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
  assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
});

test("doctor classifies release-lock drift without changing the installation", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const releaseLockPath = join(
      context.projectDirectory,
      ".codex-ground-control",
      "release-lock.json",
    );
    writeFileSync(releaseLockPath, '{"drifted":true}\n');
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(["doctor"], context);

    assert.equal(diagnosed.status, 2);
    assert.equal(diagnosed.receipt.error.code, "INSTALLATION_CONFLICT");
    assert.deepEqual(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "installation.release-lock",
      ),
      {
        id: "installation.release-lock",
        severity: "error",
        state: "drifted",
        scope: "core",
        observed: "release lock drifted",
        action: "Restore the installed release metadata or reinstall safely.",
      },
    );
    assert.ok(
      diagnosed.receipt.result.gates.core.findingIds.includes(
        "installation.release-lock",
      ),
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("doctor reports hook, native, and write-boundary conflicts together", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const agentsPath = join(context.projectDirectory, "AGENTS.md");
    writeFileSync(
      agentsPath,
      readFileSync(agentsPath, "utf8").replace(
        "External models are bounded leaf adapters. They may not delegate, edit the",
        "External models are bounded leaf adapters. They may delegate and edit the",
      ),
    );
    const codexDirectory = join(context.homeDirectory, ".codex");
    mkdirSync(codexDirectory);
    writeFileSync(
      join(codexDirectory, "config.toml"),
      [
        "[agents]",
        "enabled = true",
        "[features]",
        "multi_agent = true",
        "",
      ].join("\n"),
    );
    const injectedSecret = "doctor-secret-must-not-appear";
    writeFileSync(
      join(codexDirectory, "hooks.json"),
      `${JSON.stringify({
        hooks: {
          SessionStart: [
            {
              hooks: [
                {
                  type: "command",
                  command: `example --token ${injectedSecret}`,
                },
              ],
            },
          ],
        },
      })}\n`,
    );
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(
      ["doctor"],
      context,
      { DOCTOR_FIXTURE_SECRET: injectedSecret },
    );

    assert.equal(diagnosed.status, 2);
    const findings = new Map(
      diagnosed.receipt.result.findings.map((item) => [item.id, item]),
    );
    assert.equal(findings.get("runtime.hooks").state, "conflicted");
    assert.equal(findings.get("runtime.hooks").severity, "error");
    assert.equal(
      findings.get("runtime.codex-config").severity,
      "critical",
    );
    assert.equal(
      findings.get("runtime.codex-config").observed,
      "agents.enabled and features.multi_agent enabled",
    );
    assert.equal(
      findings.get("installation.managed-block").state,
      "drifted",
    );
    assert.equal(
      findings.get("installation.managed-block").severity,
      "critical",
    );
    assert.equal(
      diagnosed.receipt.result.gates.native.expected,
      false,
    );
    assert.equal(
      diagnosed.receipt.result.gates.write.expected,
      false,
    );
    assert.deepEqual(findings.get("gate.native"), {
      id: "gate.native",
      severity: "critical",
      state: "conflicted",
      scope: "native",
      observed: "native entry point enabled; execution remains blocked",
      action: "Disable native entry points and start a fresh Codex session.",
    });
    assert.deepEqual(findings.get("gate.write"), {
      id: "gate.write",
      severity: "critical",
      state: "conflicted",
      scope: "write",
      observed: "external write boundary cannot be verified",
      action: "Restore the Ground Control managed instructions before execution.",
    });
    assert.equal(diagnosed.stdout.includes(injectedSecret), false);
    assert.equal(diagnosed.stderr.includes(injectedSecret), false);
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("doctor diagnoses an explicitly selected global installation read-only", () => {
  withProject((context) => {
    assert.equal(
      runJson(
        ["init", "--global", "--confirm-global"],
        context,
      ).status,
      0,
    );
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(["doctor", "--global"], context);

    assert.equal(diagnosed.status, 0);
    assert.equal(diagnosed.receipt.scope, "global");
    assert.equal(diagnosed.receipt.targetRoot, "~");
    assert.equal(diagnosed.receipt.projectRoot, undefined);
    assert.equal(diagnosed.receipt.result.scope, "global");
    assert.equal(diagnosed.receipt.result.health, "healthy");
    assert.equal(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "installation.manifest",
      ).state,
      "healthy",
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("global doctor classifies managed skill drift inside the selected scope", () => {
  withProject((context) => {
    assert.equal(
      runJson(
        ["init", "--global", "--confirm-global"],
        context,
      ).status,
      0,
    );
    writeFileSync(
      join(
        context.homeDirectory,
        ".agents",
        "skills",
        "implement",
        "SKILL.md",
      ),
      "user-modified global skill\n",
    );
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(["doctor", "--global"], context);

    assert.equal(diagnosed.status, 2);
    assert.equal(diagnosed.receipt.scope, "global");
    assert.equal(diagnosed.receipt.error.code, "INSTALLATION_CONFLICT");
    assert.deepEqual(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "installation.skills",
      ),
      {
        id: "installation.skills",
        severity: "error",
        state: "drifted",
        scope: "core",
        observed: "managed skills drifted",
        action: "Restore the managed skill bytes or uninstall safely before reinstalling.",
      },
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("human doctor output groups core, provider, and fail-closed boundary findings", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);

    const healthy = runHuman(["doctor"], context);

    assert.equal(healthy.status, 0);
    assert.equal(healthy.stderr, "");
    assert.match(
      healthy.stdout,
      /^Ground Control doctor: healthy \(project\)\n/,
    );
    assert.match(healthy.stdout, /^Core \(passed\):$/m);
    assert.match(healthy.stdout, /^Optional providers:$/m);
    assert.match(
      healthy.stdout,
      /^  OPTIONAL-UNAVAILABLE provider\.pi: CLI not found/m,
    );
    assert.match(healthy.stdout, /^Fail-closed boundaries:$/m);
    assert.match(
      healthy.stdout,
      /^  BLOCKED gate\.native: blocked by v0\.1 policy/m,
    );

    const emptyRuntimeBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-without-codex-"),
    );
    symlinkSync(process.execPath, join(emptyRuntimeBin, "node"));
    const blocked = runHuman(
      ["doctor"],
      context,
      { PATH: `${emptyRuntimeBin}:/usr/bin:/bin` },
    );

    assert.equal(blocked.status, 2);
    assert.match(
      blocked.stdout,
      /^Ground Control doctor: blocked \(project\)\n/,
    );
    assert.match(
      blocked.stdout,
      /^  MISSING codex\.cli: Codex CLI not found/m,
    );
    assert.equal(
      blocked.stderr,
      "Ground Control doctor found operational blockers.\n",
    );
  });
});

test("provider detection reports only public version and credential presence", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-with-pi-"),
    );
    const injectedSecret = "pi-secret-must-not-appear";
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ -n "$ZAI_CODING_CN_API_KEY" ]; then',
        "  printf 'credential leaked to version child\\n'",
        "else",
        `  printf 'pi 1.2.3 ${injectedSecret}\\n'`,
        "fi",
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const diagnosed = runJson(
      ["doctor"],
      context,
      {
        PATH: `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
        ZAI_CODING_CN_API_KEY: injectedSecret,
      },
    );

    assert.equal(diagnosed.status, 0);
    assert.deepEqual(diagnosed.receipt.result.gates.pi, {
      status: "disabled",
      availability: "detected",
      credential: "present in environment",
      qualification: "unqualified",
      enabled: false,
      findingIds: ["provider.pi"],
    });
    assert.equal(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "provider.pi",
      ).state,
      "detected",
    );
    assert.equal(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "provider.pi",
      ).observed,
      "CLI 1.2.3 detected; credentials present in environment",
    );
    assert.equal(diagnosed.stdout.includes(injectedSecret), false);
    assert.equal(diagnosed.stderr.includes(injectedSecret), false);
    assert.deepEqual(snapshotFiles(context.projectDirectory), projectBefore);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("doctor classifies an unreadable Codex public version as incompatible", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const incompatibleBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-incompatible-codex-"),
    );
    symlinkSync(process.execPath, join(incompatibleBin, "node"));
    const injectedSecret = "codex-output-secret-must-not-appear";
    writeFileSync(
      join(incompatibleBin, "codex"),
      [
        "#!/bin/sh",
        `printf 'unsupported ${injectedSecret}\\n'`,
        "",
      ].join("\n"),
    );
    chmodSync(join(incompatibleBin, "codex"), 0o755);

    const diagnosed = runJson(
      ["doctor"],
      context,
      { PATH: `${incompatibleBin}:/usr/bin:/bin` },
    );

    assert.equal(diagnosed.status, 2);
    assert.deepEqual(
      diagnosed.receipt.result.findings.find(
        ({ id }) => id === "codex.cli",
      ),
      {
        id: "codex.cli",
        severity: "error",
        state: "incompatible",
        scope: "core",
        observed: "Codex CLI version unavailable",
        action: "Install or repair the Codex CLI, then run doctor again.",
      },
    );
    assert.equal(diagnosed.stdout.includes(injectedSecret), false);
    assert.equal(diagnosed.stderr.includes(injectedSecret), false);
  });
});

test("runtime fixture classifies unsupported platform and Node.js versions independently", () => {
  const homeDirectory = mkdtempSync(join(packedCli.sandbox, "home-"));
  const result = diagnoseRuntime({
    scope: "project",
    cwd: packedCli.sandbox,
    homeDirectory,
    gitWorktree: true,
    platform: "linux",
    nodeVersion: "21.9.0",
    environment: {},
    installation: {
      releaseLock: { revision: "fixture-revision" },
      assets: { count: 3 },
    },
    spawn(command) {
      if (command === "codex") {
        return {
          status: 0,
          signal: null,
          stdout: "codex-cli 0.145.0\n",
          stderr: "",
        };
      }
      const error = new Error("missing");
      error.code = "ENOENT";
      return {
        error,
        status: null,
        signal: null,
        stdout: "",
        stderr: "",
      };
    },
  });

  assert.equal(result.health, "blocked");
  assert.deepEqual(
    result.findings.find(({ id }) => id === "platform.macos"),
    {
      id: "platform.macos",
      severity: "error",
      state: "incompatible",
      scope: "core",
      observed: "linux",
      action: "Run Ground Control v0.1 on macOS.",
    },
  );
  assert.deepEqual(
    result.findings.find(({ id }) => id === "runtime.node"),
    {
      id: "runtime.node",
      severity: "error",
      state: "incompatible",
      scope: "core",
      observed: "Node.js 21.9.0",
      action: "Install Node.js 22 or newer.",
    },
  );
  assert.deepEqual(
    result.gates.core.findingIds,
    ["platform.macos", "runtime.node"],
  );
});

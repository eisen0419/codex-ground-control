import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";
import { runCli } from "../src/cli.js";
import { initializeGlobalWorkflow } from "../src/global-workflow.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let packedCli;

function isolatedEnvironment(homeDirectory) {
  return {
    PATH: process.env.PATH,
    HOME: homeDirectory,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
  };
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
}

function snapshotFiles(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
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

before(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-global-workflow-"));
  const packDirectory = join(sandbox, "pack");
  const installDirectory = join(sandbox, "install");
  const packHome = join(sandbox, "pack-home");
  const networkTrap = join(sandbox, "deny-network.mjs");

  mkdirSync(packDirectory);
  mkdirSync(packHome);
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
    ...isolatedEnvironment(packHome),
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
    sandbox,
  };
});

after(() => {
  rmSync(packedCli.sandbox, { recursive: true, force: true });
});

function withGlobalHome(callback) {
  const homeDirectory = mkdtempSync(join(packedCli.sandbox, "home-"));
  const workingDirectory = mkdtempSync(join(packedCli.sandbox, "cwd-"));
  writeFileSync(join(homeDirectory, "sentinel.txt"), "untouched\n");
  callback({ homeDirectory, workingDirectory });
}

function runJson(command, context) {
  const result = run(packedCli.cli, [...command, "--json"], {
    cwd: context.workingDirectory,
    env: {
      ...isolatedEnvironment(context.homeDirectory),
      NODE_OPTIONS: `--import=${pathToFileURL(packedCli.networkTrap).href}`,
    },
  });

  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return {
    ...result,
    receipt: JSON.parse(result.stdout),
  };
}

test("explicit global dry-run previews user-level changes without writing HOME", () => {
  withGlobalHome((context) => {
    const before = snapshotFiles(context.homeDirectory);
    const preview = runJson(["init", "--global", "--dry-run"], context);

    assert.equal(preview.status, 0);
    assert.equal(preview.receipt.scope, "global");
    assert.equal(preview.receipt.changed, false);
    assert.equal(preview.receipt.result.installation, "preview");
    assert.ok(
      preview.receipt.result.plan.add.includes("~/.codex/AGENTS.md"),
    );
    assert.ok(
      preview.receipt.result.plan.add.includes(
        "~/.agents/skills/implement/SKILL.md",
      ),
    );
    assert.equal(
      preview.stdout.includes(context.homeDirectory),
      false,
      "the machine receipt must not reveal the private HOME path",
    );
    assert.deepEqual(snapshotFiles(context.homeDirectory), before);
  });
});

test("noninteractive global init requires a second explicit confirmation", () => {
  withGlobalHome((context) => {
    const before = snapshotFiles(context.homeDirectory);
    const blocked = runJson(["init", "--global"], context);

    assert.equal(blocked.status, 2);
    assert.equal(blocked.receipt.scope, "global");
    assert.equal(blocked.receipt.changed, false);
    assert.equal(
      blocked.receipt.error.code,
      "GLOBAL_CONFIRMATION_REQUIRED",
    );
    assert.equal(blocked.receipt.result.installation, "preview");
    assert.ok(
      blocked.receipt.result.plan.add.includes("~/.codex/AGENTS.md"),
    );
    assert.deepEqual(snapshotFiles(context.homeDirectory), before);
  });
});

test("confirmed global init creates a private restorable backup before managed files", () => {
  withGlobalHome((context) => {
    const initialized = runJson(
      ["init", "--global", "--confirm-global"],
      context,
    );

    assert.equal(initialized.status, 0);
    assert.equal(initialized.receipt.scope, "global");
    assert.equal(initialized.receipt.changed, true);
    assert.equal(initialized.receipt.result.installation, "created");
    assert.match(
      initialized.receipt.result.backupId,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    assert.equal(
      initialized.stdout.includes(context.homeDirectory),
      false,
    );

    const manifest = JSON.parse(
      readFileSync(
        join(
          context.homeDirectory,
          ".codex-ground-control",
          "global",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.schemaVersion, "3");
    assert.equal(manifest.scope, "global");
    assert.equal(
      manifest.backup.id,
      initialized.receipt.result.backupId,
    );
    assert.equal(manifest.backup.preparedBeforeMutation, true);
    assert.equal(
      manifest.backup.descriptor,
      `.codex-ground-control/backups/${manifest.backup.id}/snapshot.json`,
    );
    const backup = JSON.parse(
      readFileSync(
        join(context.homeDirectory, manifest.backup.descriptor),
        "utf8",
      ),
    );
    assert.equal(backup.backupId, manifest.backup.id);
    assert.deepEqual(backup.instructions, {
      state: "absent",
      sha256: null,
      content: null,
    });

    assert.match(
      readFileSync(
        join(context.homeDirectory, ".codex", "AGENTS.md"),
        "utf8",
      ),
      /codex-ground-control:managed:start/,
    );
    assert.match(
      readFileSync(
        join(
          context.homeDirectory,
          ".agents",
          "skills",
          "implement",
          "SKILL.md",
        ),
        "utf8",
      ),
      /name: implement/,
    );
    assert.equal(
      readFileSync(join(context.homeDirectory, "sentinel.txt"), "utf8"),
      "untouched\n",
    );
  });
});

test("repeated confirmed global init is stable and reuses the verified backup", () => {
  withGlobalHome((context) => {
    const initialized = runJson(
      ["init", "--global", "--confirm-global"],
      context,
    );
    assert.equal(initialized.status, 0);
    const installed = snapshotFiles(context.homeDirectory);

    const repeated = runJson(
      ["init", "--global", "--confirm-global"],
      context,
    );

    assert.equal(repeated.status, 0);
    assert.equal(repeated.receipt.changed, false);
    assert.equal(repeated.receipt.result.installation, "unchanged");
    assert.equal(
      repeated.receipt.result.backupId,
      initialized.receipt.result.backupId,
    );
    assert.deepEqual(snapshotFiles(context.homeDirectory), installed);
  });
});

test("global uninstall restores exact user configuration and preserves audit evidence", () => {
  withGlobalHome((context) => {
    const agentsPath = join(
      context.homeDirectory,
      ".codex",
      "AGENTS.md",
    );
    const originalAgents = Buffer.from(
      "\ufeff# User rules\r\n\r\n1. Keep exact bytes\r\n2. 保留",
      "utf8",
    );
    mkdirSync(dirname(agentsPath), { recursive: true });
    writeFileSync(agentsPath, originalAgents);
    const before = snapshotFiles(context.homeDirectory);
    const initialized = runJson(
      ["init", "--global", "--confirm-global"],
      context,
    );
    assert.equal(initialized.status, 0);

    const evidencePath = join(
      context.homeDirectory,
      ".codex-ground-control",
      "evidence",
      "run.json",
    );
    mkdirSync(dirname(evidencePath), { recursive: true });
    writeFileSync(evidencePath, '{"status":"passed"}\n');

    const uninstalled = runJson(
      ["uninstall", "--global", "--confirm-global"],
      context,
    );

    assert.equal(uninstalled.status, 0);
    assert.equal(uninstalled.receipt.changed, true);
    assert.equal(uninstalled.receipt.result.installation, "removed");
    assert.equal(
      uninstalled.receipt.result.backupId,
      initialized.receipt.result.backupId,
    );
    assert.deepEqual(readFileSync(agentsPath), originalAgents);
    assert.equal(
      readFileSync(evidencePath, "utf8"),
      '{"status":"passed"}\n',
    );
    const restored = snapshotFiles(context.homeDirectory);
    delete restored[
      relative(context.homeDirectory, evidencePath)
    ];
    assert.deepEqual(restored, before);

    const repeated = runJson(
      ["uninstall", "--global", "--confirm-global"],
      context,
    );
    assert.equal(repeated.status, 0);
    assert.equal(repeated.receipt.changed, false);
    assert.equal(repeated.receipt.result.installation, "absent");
    assert.equal(
      readFileSync(evidencePath, "utf8"),
      '{"status":"passed"}\n',
    );
  });
});

test("interactive global init shows the diff and requires terminal confirmation", () => {
  withGlobalHome((context) => {
    const output = {
      value: "",
      write(value) {
        this.value += value;
      },
    };
    const errors = {
      value: "",
      write(value) {
        this.value += value;
      },
    };
    const status = runCli(
      ["init", "--global"],
      output,
      errors,
      {
        cwd: context.workingDirectory,
        homeDirectory: context.homeDirectory,
        interactive: true,
        confirm: () => true,
      },
    );

    assert.equal(
      status,
      0,
      `stdout:\n${output.value}\nstderr:\n${errors.value}`,
    );
    assert.equal(errors.value, "");
    assert.match(output.value, /Ground Control global init preview:/);
    assert.match(output.value, /\+ ~\/\.codex\/AGENTS\.md/);
    assert.match(
      output.value,
      /Apply these global changes\? \[y\/N\]/,
    );
    assert.match(output.value, /Initialized global Ground Control\./);
    assert.match(
      readFileSync(
        join(context.homeDirectory, ".codex", "AGENTS.md"),
        "utf8",
      ),
      /codex-ground-control:managed:start/,
    );
  });
});

test("project-local init refuses to manage an entire HOME as the Git root", () => {
  withGlobalHome((context) => {
    execFileSync("git", ["init", "-b", "main"], {
      cwd: context.homeDirectory,
      encoding: "utf8",
      env: isolatedEnvironment(context.homeDirectory),
    });
    const before = snapshotFiles(context.homeDirectory);
    const result = run(packedCli.cli, ["init", "--dry-run", "--json"], {
      cwd: context.homeDirectory,
      env: {
        ...isolatedEnvironment(context.homeDirectory),
        NODE_OPTIONS:
          `--import=${pathToFileURL(packedCli.networkTrap).href}`,
      },
    });
    const receipt = JSON.parse(result.stdout);

    assert.equal(result.status, 2);
    assert.equal(receipt.error.code, "UNSAFE_PROJECT_ROOT");
    assert.deepEqual(snapshotFiles(context.homeDirectory), before);
  });
});

test("global init rejects symlinked HOME roots without touching the victim", () => {
  withGlobalHome((context) => {
    const victim = mkdtempSync(join(packedCli.sandbox, "victim-"));
    const linkedHome = join(packedCli.sandbox, "linked-home");
    writeFileSync(join(victim, "sentinel.txt"), "victim\n");
    symlinkSync(victim, linkedHome);
    const before = snapshotFiles(victim);

    const result = run(packedCli.cli, [
      "init",
      "--global",
      "--dry-run",
      "--json",
    ], {
      cwd: context.workingDirectory,
      env: {
        ...isolatedEnvironment(linkedHome),
        NODE_OPTIONS:
          `--import=${pathToFileURL(packedCli.networkTrap).href}`,
      },
    });
    const receipt = JSON.parse(result.stdout);

    assert.equal(result.status, 2);
    assert.equal(receipt.error.code, "UNSAFE_GLOBAL_ROOT");
    assert.deepEqual(snapshotFiles(victim), before);
  });
});

test("global init rejects a symlinked Codex config root", () => {
  withGlobalHome((context) => {
    const victim = mkdtempSync(join(packedCli.sandbox, "config-victim-"));
    writeFileSync(join(victim, "AGENTS.md"), "victim rules\n");
    symlinkSync(victim, join(context.homeDirectory, ".codex"));
    const before = snapshotFiles(victim);

    const blocked = runJson(
      ["init", "--global", "--dry-run"],
      context,
    );

    assert.equal(blocked.status, 2);
    assert.equal(
      blocked.receipt.error.code,
      "INSTALLATION_CONFLICT",
    );
    assert.deepEqual(snapshotFiles(victim), before);
  });
});

test("atomic global write detects a concurrent parent symlink exchange", () => {
  withGlobalHome((context) => {
    const victim = mkdtempSync(join(packedCli.sandbox, "swap-victim-"));
    const victimFile = join(victim, "AGENTS.md");
    writeFileSync(victimFile, "victim rules\n");
    mkdirSync(join(context.homeDirectory, ".codex"));
    let exchanged = false;

    assert.throws(
      () =>
        initializeGlobalWorkflow(context.homeDirectory, {
          confirmed: true,
          faultInjector(checkpoint, details) {
            if (
              !exchanged &&
              checkpoint === "before-atomic-rename" &&
              details.path === ".codex/AGENTS.md"
            ) {
              renameSync(
                join(context.homeDirectory, ".codex"),
                join(context.homeDirectory, ".codex-original"),
              );
              symlinkSync(victim, join(context.homeDirectory, ".codex"));
              exchanged = true;
            }
          },
        }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(exchanged, true);
    assert.equal(readFileSync(victimFile, "utf8"), "victim rules\n");
  });
});

test("global install rejects a directory that appears after its preview", () => {
  withGlobalHome((context) => {
    let injected = false;

    assert.throws(
      () =>
        initializeGlobalWorkflow(context.homeDirectory, {
          confirmed: true,
          faultInjector(checkpoint, details) {
            if (
              !injected &&
              checkpoint === "before-directory-create" &&
              details.path === ".codex-ground-control"
            ) {
              mkdirSync(
                join(
                  context.homeDirectory,
                  ".codex-ground-control",
                ),
              );
              injected = true;
            }
          },
        }),
      (error) => error.code === "INSTALLATION_CONFLICT",
    );
    assert.equal(injected, true);
    assert.equal(
      readdirSync(context.homeDirectory).includes(".agents"),
      false,
    );
    assert.equal(
      readdirSync(context.homeDirectory).includes(".codex"),
      false,
    );
  });
});

test("confirmed global uninstall recovers an interrupted installation", () => {
  withGlobalHome((context) => {
    const agentsPath = join(
      context.homeDirectory,
      ".codex",
      "AGENTS.md",
    );
    const originalAgents = Buffer.from("# original global rules\n");
    mkdirSync(dirname(agentsPath), { recursive: true });
    writeFileSync(agentsPath, originalAgents);
    const before = snapshotFiles(context.homeDirectory);
    let interrupted = false;

    assert.throws(
      () =>
        initializeGlobalWorkflow(context.homeDirectory, {
          confirmed: true,
          faultInjector(checkpoint) {
            if (!interrupted && checkpoint === "after-global-asset") {
              interrupted = true;
              throw new Error("simulated abrupt interruption");
            }
          },
        }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    assert.equal(interrupted, true);

    const blockedInit = runJson(
      ["init", "--global", "--confirm-global"],
      context,
    );
    assert.equal(blockedInit.status, 2);
    assert.equal(blockedInit.receipt.error.code, "RECOVERY_REQUIRED");

    const recovered = runJson(
      ["uninstall", "--global", "--confirm-global"],
      context,
    );

    assert.equal(recovered.status, 0);
    assert.equal(recovered.receipt.changed, true);
    assert.equal(recovered.receipt.result.installation, "recovered");
    assert.deepEqual(readFileSync(agentsPath), originalAgents);
    assert.deepEqual(snapshotFiles(context.homeDirectory), before);
  });
});

test("interactive global recovery reports the recovered partial installation", () => {
  withGlobalHome((context) => {
    let interrupted = false;
    assert.throws(
      () =>
        initializeGlobalWorkflow(context.homeDirectory, {
          confirmed: true,
          faultInjector(checkpoint) {
            if (!interrupted && checkpoint === "after-global-asset") {
              interrupted = true;
              throw new Error("simulated abrupt interruption");
            }
          },
        }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );
    const output = {
      value: "",
      write(value) {
        this.value += value;
      },
    };
    const errors = {
      value: "",
      write(value) {
        this.value += value;
      },
    };

    const status = runCli(
      ["uninstall", "--global"],
      output,
      errors,
      {
        cwd: context.workingDirectory,
        homeDirectory: context.homeDirectory,
        interactive: true,
        confirm: () => true,
      },
    );

    assert.equal(status, 0);
    assert.equal(errors.value, "");
    assert.match(
      output.value,
      /Recovered the interrupted global installation\./,
    );
  });
});

test("global backup is complete before the install transaction permits target mutation", () => {
  withGlobalHome((context) => {
    const agentsPath = join(
      context.homeDirectory,
      ".codex",
      "AGENTS.md",
    );
    const originalAgents = Buffer.from("private original rules\n");
    mkdirSync(dirname(agentsPath), { recursive: true });
    writeFileSync(agentsPath, originalAgents);

    assert.throws(
      () =>
        initializeGlobalWorkflow(context.homeDirectory, {
          confirmed: true,
          faultInjector(checkpoint) {
            if (checkpoint === "after-global-transaction") {
              throw new Error("stop before target mutation");
            }
          },
        }),
      (error) => error.code === "RECOVERY_REQUIRED",
    );

    const transaction = JSON.parse(
      readFileSync(
        join(
          context.homeDirectory,
          ".codex-ground-control",
          "global",
          "transaction.json",
        ),
        "utf8",
      ),
    );
    const descriptor = JSON.parse(
      readFileSync(
        join(
          context.homeDirectory,
          transaction.manifest.backup.descriptor,
        ),
        "utf8",
      ),
    );
    assert.equal(descriptor.backupId, transaction.backupId);
    assert.deepEqual(
      readFileSync(
        join(
          context.homeDirectory,
          descriptor.instructions.content,
        ),
      ),
      originalAgents,
    );
    assert.deepEqual(readFileSync(agentsPath), originalAgents);
    assert.equal(
      readdirSync(context.homeDirectory).includes(".agents"),
      false,
    );
  });
});

test("missing global backup blocks uninstall without changing remaining state", () => {
  withGlobalHome((context) => {
    const initialized = runJson(
      ["init", "--global", "--confirm-global"],
      context,
    );
    assert.equal(initialized.status, 0);
    const manifest = JSON.parse(
      readFileSync(
        join(
          context.homeDirectory,
          ".codex-ground-control",
          "global",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    unlinkSync(join(context.homeDirectory, manifest.backup.descriptor));
    const drifted = snapshotFiles(context.homeDirectory);

    const blocked = runJson(
      ["uninstall", "--global", "--confirm-global"],
      context,
    );

    assert.equal(blocked.status, 2);
    assert.equal(
      blocked.receipt.error.code,
      "INSTALLATION_CONFLICT",
    );
    assert.deepEqual(snapshotFiles(context.homeDirectory), drifted);
  });
});

test("missing managed global asset blocks both init and uninstall", () => {
  withGlobalHome((context) => {
    assert.equal(
      runJson(
        ["init", "--global", "--confirm-global"],
        context,
      ).status,
      0,
    );
    unlinkSync(
      join(
        context.homeDirectory,
        ".agents",
        "skills",
        "implement",
        "SKILL.md",
      ),
    );
    const drifted = snapshotFiles(context.homeDirectory);

    for (const command of ["init", "uninstall"]) {
      const blocked = runJson(
        [command, "--global", "--confirm-global"],
        context,
      );
      assert.equal(blocked.status, 2);
      assert.equal(
        blocked.receipt.error.code,
        "INSTALLATION_CONFLICT",
      );
      assert.deepEqual(snapshotFiles(context.homeDirectory), drifted);
    }
  });
});

test("user changes inside the global managed block cannot be forced away", () => {
  withGlobalHome((context) => {
    assert.equal(
      runJson(
        ["init", "--global", "--confirm-global"],
        context,
      ).status,
      0,
    );
    const agentsPath = join(
      context.homeDirectory,
      ".codex",
      "AGENTS.md",
    );
    writeFileSync(
      agentsPath,
      readFileSync(agentsPath, "utf8").replace(
        "only user-facing coordinator",
        "modified coordinator",
      ),
    );
    const drifted = snapshotFiles(context.homeDirectory);

    const blocked = runJson(
      ["uninstall", "--global", "--confirm-global"],
      context,
    );
    assert.equal(blocked.status, 2);
    assert.equal(
      blocked.receipt.error.code,
      "INSTALLATION_CONFLICT",
    );
    assert.deepEqual(snapshotFiles(context.homeDirectory), drifted);

    const force = runJson(
      ["uninstall", "--global", "--confirm-global", "--force"],
      context,
    );
    assert.equal(force.status, 64);
    assert.equal(force.receipt.error.code, "UNEXPECTED_ARGUMENTS");
    assert.deepEqual(snapshotFiles(context.homeDirectory), drifted);
  });
});

test("local init without --global ignores user-level Codex and skills targets", () => {
  withGlobalHome((context) => {
    execFileSync("git", ["init", "-b", "main"], {
      cwd: context.workingDirectory,
      encoding: "utf8",
      env: isolatedEnvironment(context.homeDirectory),
    });
    const victim = mkdtempSync(join(packedCli.sandbox, "local-victim-"));
    writeFileSync(join(victim, "AGENTS.md"), "victim rules\n");
    symlinkSync(victim, join(context.homeDirectory, ".codex"));
    mkdirSync(
      join(context.homeDirectory, ".agents", "skills", "personal"),
      { recursive: true },
    );
    const personalSkill = join(
      context.homeDirectory,
      ".agents",
      "skills",
      "personal",
      "SKILL.md",
    );
    writeFileSync(personalSkill, "personal\n");
    const victimBefore = snapshotFiles(victim);

    const preview = runJson(["init", "--dry-run"], context);

    assert.equal(preview.status, 0);
    assert.equal(Object.hasOwn(preview.receipt, "scope"), false);
    assert.equal(readFileSync(personalSkill, "utf8"), "personal\n");
    assert.deepEqual(snapshotFiles(victim), victimBefore);
  });
});

test("global uninstall preserves changed preexisting skills and changes outside the managed block", () => {
  withGlobalHome((context) => {
    const preexistingSkill = join(
      context.homeDirectory,
      ".agents",
      "skills",
      "tdd",
      "SKILL.md",
    );
    mkdirSync(dirname(preexistingSkill), { recursive: true });
    writeFileSync(
      preexistingSkill,
      readFileSync(
        join(
          repositoryRoot,
          "vendor",
          "mattpocock-skills",
          "skills",
          "engineering",
          "tdd",
          "SKILL.md",
        ),
      ),
    );
    assert.equal(
      runJson(
        ["init", "--global", "--confirm-global"],
        context,
      ).status,
      0,
    );

    const changedSkill =
      `${readFileSync(preexistingSkill, "utf8")}\nuser-owned change\n`;
    writeFileSync(preexistingSkill, changedSkill);
    const agentsPath = join(
      context.homeDirectory,
      ".codex",
      "AGENTS.md",
    );
    const userSuffix = "\n# user rule added after install\n";
    writeFileSync(
      agentsPath,
      `${readFileSync(agentsPath, "utf8")}${userSuffix}`,
    );

    const uninstalled = runJson(
      ["uninstall", "--global", "--confirm-global"],
      context,
    );

    assert.equal(uninstalled.status, 0);
    assert.equal(readFileSync(preexistingSkill, "utf8"), changedSkill);
    assert.equal(readFileSync(agentsPath, "utf8"), userSuffix);
  });
});

test("declining interactive global confirmation performs no writes", () => {
  withGlobalHome((context) => {
    const before = snapshotFiles(context.homeDirectory);
    const output = {
      value: "",
      write(value) {
        this.value += value;
      },
    };
    const errors = {
      value: "",
      write(value) {
        this.value += value;
      },
    };

    const status = runCli(
      ["init", "--global"],
      output,
      errors,
      {
        cwd: context.workingDirectory,
        homeDirectory: context.homeDirectory,
        interactive: true,
        confirm: () => false,
      },
    );

    assert.equal(status, 2);
    assert.match(output.value, /Ground Control global init preview:/);
    assert.match(errors.value, /Global changes were not confirmed/);
    assert.deepEqual(snapshotFiles(context.homeDirectory), before);
  });
});

test("noninteractive global uninstall requires explicit confirmation and keeps state", () => {
  withGlobalHome((context) => {
    assert.equal(
      runJson(
        ["init", "--global", "--confirm-global"],
        context,
      ).status,
      0,
    );
    const installed = snapshotFiles(context.homeDirectory);

    const blocked = runJson(["uninstall", "--global"], context);

    assert.equal(blocked.status, 2);
    assert.equal(
      blocked.receipt.error.code,
      "GLOBAL_CONFIRMATION_REQUIRED",
    );
    assert.equal(blocked.receipt.result.installation, "preview");
    assert.deepEqual(snapshotFiles(context.homeDirectory), installed);
  });
});

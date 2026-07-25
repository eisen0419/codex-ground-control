import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
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

  mkdirSync(packDirectory);
  mkdirSync(homeDirectory);
  mkdirSync(projectDirectory);
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

    execFileSync("git", ["init", "-b", "main"], {
      cwd: projectDirectory,
      encoding: "utf8",
      env: isolatedEnvironment(homeDirectory),
    });

    callback({
      cli: join(
        installDirectory,
        "node_modules",
        ".bin",
        "codex-ground-control",
      ),
      homeDirectory,
      installDirectory,
      networkTrap,
      projectDirectory,
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
  assert.equal(packageMetadata.version, "0.1.0");
  assert.equal(packageMetadata.type, "module");
  assert.deepEqual(packageMetadata.engines, { node: ">=22" });
  assert.deepEqual(packageMetadata.bin, {
    "codex-ground-control": "bin/codex-ground-control.js",
  });

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
    assert.equal(packed.filename, "codex-ground-control-0.1.0.tgz");
    assert.deepEqual(
      packed.files.map(({ path }) => path).sort(),
      [
        "LICENSE",
        "README.md",
        "bin/codex-ground-control.js",
        "fixtures/offline-uppercase.json",
        "package.json",
        "src/cli.js",
        "src/project-state.js",
      ],
    );
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("packed CLI exposes stable help and version output", () => {
  withPackedCli(({ cli, homeDirectory, projectDirectory }) => {
    const environment = {
      PATH: process.env.PATH,
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
        "  init       Initialize Ground Control in the current Git worktree",
        "  doctor     Diagnose the current installation",
        "  qualify    Run the deterministic offline qualification",
        "  provider   Inspect optional provider state",
        "  uninstall  Restore the project to its pre-install state",
        "",
        "Options:",
        "  --json     Emit exactly one JSON receipt",
        "  -h, --help Show this help",
        "  -v, --version Show the version",
        "",
      ].join("\n"),
    );
    assert.equal(help.stderr, "");
    assert.equal(version.status, 0);
    assert.equal(version.stdout, "0.1.0\n");
    assert.equal(version.stderr, "");
  });
});

function runJson(cli, command, context) {
  const result = run(cli, [...command, "--json"], {
    cwd: context.projectDirectory,
    env: {
      PATH: process.env.PATH,
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
    ({ cli, homeDirectory, networkTrap, projectDirectory, sandbox }) => {
      writeFileSync(join(projectDirectory, "user-notes.txt"), "keep me\n");
      const before = snapshotFiles(projectDirectory);
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
      };

      const initialized = runJson(cli, ["init"], context);
      assert.equal(initialized.status, 0);
      assert.deepEqual(initialized.receipt, {
        schemaVersion: "1",
        product: "codex-ground-control",
        version: "0.1.0",
        command: "init",
        status: "ok",
        exitCode: 0,
        projectRoot: realpathSync(projectDirectory),
        changed: true,
        result: {
          installation: "created",
          manifest: ".codex-ground-control/manifest.json",
        },
      });

      const manifestPath = join(
        projectDirectory,
        ".codex-ground-control",
        "manifest.json",
      );
      assert.equal(existsSync(manifestPath), true);
      assert.deepEqual(JSON.parse(readFileSync(manifestPath, "utf8")), {
        schemaVersion: "1",
        product: "codex-ground-control",
        version: "0.1.0",
        managedPaths: [".codex-ground-control/manifest.json"],
      });

      const installedSnapshot = snapshotFiles(projectDirectory);
      const initializedAgain = runJson(cli, ["init"], context);
      assert.equal(initializedAgain.status, 0);
      assert.equal(initializedAgain.receipt.changed, false);
      assert.equal(initializedAgain.receipt.result.installation, "unchanged");
      assert.deepEqual(snapshotFiles(projectDirectory), installedSnapshot);

      const diagnosed = runJson(cli, ["doctor"], context);
      assert.equal(diagnosed.status, 0);
      assert.deepEqual(diagnosed.receipt.result, {
        gitWorktree: "passed",
        installation: "passed",
      });

      const qualified = runJson(cli, ["qualify"], context);
      assert.equal(qualified.status, 0);
      assert.deepEqual(qualified.receipt.result, {
        fixture: "offline-uppercase-v1",
        observed: "GROUND-CONTROL",
        qualification: "passed",
        network: "not-used",
      });

      const providers = runJson(cli, ["provider"], context);
      assert.equal(providers.status, 0);
      assert.deepEqual(providers.receipt.result, {
        providers: [],
        summary: "No optional providers are configured.",
      });

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

test("JSON mode keeps unexpected operational failures machine-readable", () => {
  withPackedCli(
    ({
      cli,
      homeDirectory,
      installDirectory,
      networkTrap,
      projectDirectory,
    }) => {
      const context = {
        homeDirectory,
        networkTrap,
        projectDirectory,
      };
      assert.equal(runJson(cli, ["init"], context).status, 0);

      rmSync(
        join(
          installDirectory,
          "node_modules",
          "codex-ground-control",
          "fixtures",
          "offline-uppercase.json",
        ),
      );
      const failed = runJson(cli, ["qualify"], context);

      assert.equal(failed.status, 2);
      assert.deepEqual(failed.receipt, {
        schemaVersion: "1",
        product: "codex-ground-control",
        version: "0.1.0",
        command: "qualify",
        status: "blocked",
        exitCode: 2,
        projectRoot: realpathSync(projectDirectory),
        changed: false,
        error: {
          code: "OPERATION_FAILED",
          message: "qualify could not complete safely.",
        },
      });
    },
  );
});

test("packed CLI keeps human lifecycle output concise and stable", () => {
  withPackedCli(
    ({ cli, homeDirectory, networkTrap, projectDirectory }) => {
      const environment = {
        PATH: process.env.PATH,
        HOME: homeDirectory,
        TMPDIR: tmpdir(),
        NODE_OPTIONS: `--import=${pathToFileURL(networkTrap).href}`,
      };
      const invoke = (...args) =>
        run(cli, args, { cwd: projectDirectory, env: environment });
      const canonicalProject = realpathSync(projectDirectory);

      const initialized = invoke("init");
      assert.equal(initialized.status, 0);
      assert.equal(
        initialized.stdout,
        `Initialized Ground Control in ${canonicalProject}.\n`,
      );
      assert.equal(initialized.stderr, "");

      const diagnosed = invoke("doctor");
      assert.equal(diagnosed.status, 0);
      assert.equal(diagnosed.stdout, "Ground Control doctor: passed.\n");
      assert.equal(diagnosed.stderr, "");

      const qualified = invoke("qualify");
      assert.equal(qualified.status, 0);
      assert.equal(
        qualified.stdout,
        "Offline qualification passed: offline-uppercase-v1.\n",
      );
      assert.equal(qualified.stderr, "");

      const providers = invoke("provider", "list");
      assert.equal(providers.status, 0);
      assert.equal(
        providers.stdout,
        "No optional providers are configured.\n",
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
      assert.equal(blocked.stdout, "");
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
      version: "0.1.0",
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

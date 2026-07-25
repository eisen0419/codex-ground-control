import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, before, test } from "node:test";

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
  });
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

before(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-project-workflow-"));
  const packDirectory = join(sandbox, "pack");
  const installDirectory = join(sandbox, "install");
  const homeDirectory = join(sandbox, "pack-home");
  const networkTrap = join(sandbox, "deny-network.mjs");

  mkdirSync(packDirectory);
  mkdirSync(homeDirectory);
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
    ...isolatedEnvironment(homeDirectory),
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
    packageRoot: join(
      installDirectory,
      "node_modules",
      "codex-ground-control",
    ),
    sandbox,
  };
});

after(() => {
  rmSync(packedCli.sandbox, { recursive: true, force: true });
});

function withGitProject(callback) {
  const projectDirectory = mkdtempSync(
    join(packedCli.sandbox, "project-"),
  );
  const homeDirectory = mkdtempSync(join(packedCli.sandbox, "home-"));
  execFileSync("git", ["init", "-b", "main"], {
    cwd: projectDirectory,
    encoding: "utf8",
    env: isolatedEnvironment(homeDirectory),
  });

  callback({
    homeDirectory,
    projectDirectory,
  });
}

function runJson(command, context) {
  const result = run(packedCli.cli, [...command, "--json"], {
    cwd: context.projectDirectory,
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

test("init --dry-run previews an empty project without changing files", () => {
  withGitProject((context) => {
    const before = snapshotFiles(context.projectDirectory);
    const preview = runJson(["init", "--dry-run"], context);

    assert.equal(preview.status, 0);
    assert.equal(
      preview.receipt.projectRoot,
      realpathSync(context.projectDirectory),
    );
    assert.equal(preview.receipt.changed, false);
    assert.equal(preview.receipt.result.installation, "preview");
    assert.equal(preview.receipt.result.plan.update.length, 0);
    assert.equal(preview.receipt.result.plan.unchanged.length, 0);
    assert.ok(preview.receipt.result.plan.add.includes("AGENTS.md"));
    assert.ok(
      preview.receipt.result.plan.add.includes(
        ".agents/skills/implement/SKILL.md",
      ),
    );
    assert.ok(
      preview.receipt.result.plan.add.includes(
        ".agents/skills/multi-agent-router/SKILL.md",
      ),
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), before);

    const humanPreview = run(packedCli.cli, ["init", "--dry-run"], {
      cwd: context.projectDirectory,
      env: {
        ...isolatedEnvironment(context.homeDirectory),
        NODE_OPTIONS: `--import=${pathToFileURL(packedCli.networkTrap).href}`,
      },
    });
    assert.equal(humanPreview.status, 0);
    assert.equal(humanPreview.stderr, "");
    assert.match(humanPreview.stdout, /^Ground Control init preview:\n/);
    assert.match(humanPreview.stdout, /^Add:$/m);
    assert.match(humanPreview.stdout, /^  AGENTS\.md$/m);
    assert.match(
      humanPreview.stdout,
      /\n  \.agents\/skills\/implement\/SKILL\.md\n/,
    );
    assert.match(humanPreview.stdout, /\nUpdate:\n  \(none\)\n/);
    assert.match(humanPreview.stdout, /\nUnchanged:\n  \(none\)\n$/);
    assert.deepEqual(snapshotFiles(context.projectDirectory), before);
  });
});

test("init installs and restores the project-local workflow in an empty project", () => {
  withGitProject((context) => {
    const before = snapshotFiles(context.projectDirectory);
    const initialized = runJson(["init"], context);

    assert.equal(initialized.status, 0);
    assert.equal(initialized.receipt.changed, true);
    assert.equal(initialized.receipt.result.installation, "created");
    assert.equal(
      initialized.receipt.result.manifest,
      ".codex-ground-control/manifest.json",
    );
    assert.equal(
      initialized.receipt.result.releaseLock.revision,
      "ed37663cc5fbef691ddfecd080dff42f7e7e350d",
    );
    assert.equal(initialized.receipt.result.releaseLock.license, "MIT");

    const agents = readFileSync(
      join(context.projectDirectory, "AGENTS.md"),
      "utf8",
    );
    assert.match(agents, /codex-ground-control:managed:start/);
    assert.match(agents, /only user-facing coordinator/);
    assert.match(agents, /user-only must be explicitly invoked/);
    assert.match(agents, /codex-ground-control:managed:end/);

    const implementSkill = readFileSync(
      join(
        context.projectDirectory,
        ".agents",
        "skills",
        "implement",
        "SKILL.md",
      ),
      "utf8",
    );
    assert.match(implementSkill, /name: implement/);
    assert.match(implementSkill, /Use \/tdd where possible/);
    assert.match(
      readFileSync(
        join(
          context.projectDirectory,
          ".agents",
          "skills",
          "implement",
          "agents",
          "openai.yaml",
        ),
        "utf8",
      ),
      /allow_implicit_invocation: false/,
    );

    const routerSkill = readFileSync(
      join(
        context.projectDirectory,
        ".agents",
        "skills",
        "multi-agent-router",
        "SKILL.md",
      ),
      "utf8",
    );
    assert.match(routerSkill, /identify the active Matt Pocock/);
    assert.match(routerSkill, /Do not invoke, simulate, or delegate around/);

    const manifest = JSON.parse(
      readFileSync(
        join(
          context.projectDirectory,
          ".codex-ground-control",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.schemaVersion, "2");
    assert.equal(manifest.product, "codex-ground-control");
    assert.equal(manifest.version, "0.1.0");
    assert.equal(manifest.managedBlock.path, "AGENTS.md");
    assert.equal(manifest.managedBlock.preInstallSha256, null);
    assert.equal(manifest.managedBlock.backup, null);
    assert.ok(manifest.managedBlock.installedSha256);
    assert.ok(manifest.createdDirectories.includes(".agents"));
    assert.ok(
      manifest.createdDirectories.includes(".codex-ground-control"),
    );
    assert.ok(
      manifest.assets.some(
        (asset) =>
          asset.path === ".agents/skills/implement/SKILL.md" &&
          asset.ownership === "created" &&
          asset.preInstallSha256 === null &&
          asset.installedSha256,
      ),
    );
    assert.ok(
      manifest.assets.every(
        (asset) =>
          ["created", "preexisting"].includes(asset.ownership) &&
          "backup" in asset,
      ),
    );

    const installed = snapshotFiles(context.projectDirectory);
    const initializedAgain = runJson(["init"], context);
    assert.equal(initializedAgain.status, 0);
    assert.equal(initializedAgain.receipt.changed, false);
    assert.equal(initializedAgain.receipt.result.installation, "unchanged");
    assert.deepEqual(snapshotFiles(context.projectDirectory), installed);

    const diagnosed = runJson(["doctor"], context);
    assert.equal(diagnosed.status, 0);
    assert.deepEqual(diagnosed.receipt.result, {
      gitWorktree: "passed",
      installation: "passed",
      workflow: "passed",
      managedBlock: "passed",
      releaseLock: {
        status: "passed",
        repository: "https://github.com/mattpocock/skills.git",
        revision: "ed37663cc5fbef691ddfecd080dff42f7e7e350d",
        contentSha256:
          "db518afff5120358bb751eadab8a3c0ee498f35cedd4e29abd108eb28d560934",
        license: "MIT",
      },
      assets: {
        status: "passed",
        count: manifest.assets.length,
      },
    });

    const uninstalled = runJson(["uninstall"], context);
    assert.equal(uninstalled.status, 0);
    assert.equal(uninstalled.receipt.changed, true);
    assert.equal(uninstalled.receipt.result.installation, "removed");
    assert.deepEqual(snapshotFiles(context.projectDirectory), before);
  });
});

test("init preserves existing project instructions and preexisting locked bytes", () => {
  withGitProject((context) => {
    const originalAgents = Buffer.from(
      "\ufeff# Project rules\r\n\r\n1. Keep this order\r\n2. 保留这些字节",
      "utf8",
    );
    writeFileSync(
      join(context.projectDirectory, "AGENTS.md"),
      originalAgents,
    );
    writeFileSync(
      join(context.projectDirectory, "user-notes.txt"),
      "do not touch\n",
    );
    const homeSentinel = join(
      context.homeDirectory,
      ".agents",
      "skills",
      "personal",
      "SKILL.md",
    );
    mkdirSync(dirname(homeSentinel), { recursive: true });
    writeFileSync(homeSentinel, "user-level skill\n");
    const homeBefore = snapshotFiles(context.homeDirectory);

    const preexistingSkillPath = join(
      context.projectDirectory,
      ".agents",
      "skills",
      "tdd",
      "SKILL.md",
    );
    mkdirSync(dirname(preexistingSkillPath), { recursive: true });
    writeFileSync(
      preexistingSkillPath,
      readFileSync(
        join(
          packedCli.packageRoot,
          "vendor",
          "mattpocock-skills",
          "skills",
          "engineering",
          "tdd",
          "SKILL.md",
        ),
      ),
    );
    const before = snapshotFiles(context.projectDirectory);

    const preview = runJson(["init", "--dry-run"], context);
    assert.equal(preview.status, 0);
    assert.ok(preview.receipt.result.plan.update.includes("AGENTS.md"));
    assert.ok(
      preview.receipt.result.plan.add.includes(
        ".codex-ground-control/backups/AGENTS.md",
      ),
    );
    assert.ok(
      preview.receipt.result.plan.unchanged.includes(
        ".agents/skills/tdd/SKILL.md",
      ),
    );
    assert.ok(
      preview.receipt.result.plan.add.includes(
        ".agents/skills/implement/SKILL.md",
      ),
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), before);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);

    const initialized = runJson(["init"], context);
    assert.equal(initialized.status, 0);
    const installedAgents = readFileSync(
      join(context.projectDirectory, "AGENTS.md"),
    );
    assert.deepEqual(
      installedAgents.subarray(0, originalAgents.length),
      originalAgents,
    );

    const manifest = JSON.parse(
      readFileSync(
        join(
          context.projectDirectory,
          ".codex-ground-control",
          "manifest.json",
        ),
        "utf8",
      ),
    );
    const originalSha256 = createHash("sha256")
      .update(originalAgents)
      .digest("hex");
    assert.equal(
      manifest.managedBlock.preInstallSha256,
      originalSha256,
    );
    assert.deepEqual(manifest.managedBlock.backup, {
      path: ".codex-ground-control/backups/AGENTS.md",
      sha256: originalSha256,
    });
    assert.deepEqual(
      readFileSync(
        join(
          context.projectDirectory,
          ".codex-ground-control",
          "backups",
          "AGENTS.md",
        ),
      ),
      originalAgents,
    );
    assert.ok(
      manifest.assets.some(
        (asset) =>
          asset.path === ".agents/skills/tdd/SKILL.md" &&
          asset.ownership === "preexisting" &&
          asset.preInstallSha256 === asset.installedSha256,
      ),
    );

    const installed = snapshotFiles(context.projectDirectory);
    const repeated = runJson(["init"], context);
    assert.equal(repeated.status, 0);
    assert.equal(repeated.receipt.changed, false);
    assert.deepEqual(snapshotFiles(context.projectDirectory), installed);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);

    const uninstalled = runJson(["uninstall"], context);
    assert.equal(uninstalled.status, 0);
    assert.deepEqual(snapshotFiles(context.projectDirectory), before);
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("packed release lock audits the exact vendored upstream bytes and license", () => {
  const releaseLock = JSON.parse(
    readFileSync(join(packedCli.packageRoot, "release-lock.json"), "utf8"),
  );
  assert.equal(releaseLock.schemaVersion, "1");
  assert.equal(releaseLock.dependencies.length, 1);
  const [dependency] = releaseLock.dependencies;
  assert.equal(dependency.name, "mattpocock/skills");
  assert.equal(
    dependency.repository,
    "https://github.com/mattpocock/skills.git",
  );
  assert.equal(
    dependency.revision,
    "ed37663cc5fbef691ddfecd080dff42f7e7e350d",
  );
  assert.equal(dependency.license.identifier, "MIT");
  assert.equal(dependency.assets.length, 57);

  const contentHash = createHash("sha256");
  for (const asset of dependency.assets) {
    const contents = readFileSync(
      join(packedCli.packageRoot, asset.sourcePath),
    );
    assert.equal(contents.byteLength, asset.bytes);
    assert.equal(
      createHash("sha256").update(contents).digest("hex"),
      asset.sha256,
    );
    contentHash.update(`${asset.sourcePath}\0${asset.sha256}\n`);
  }
  assert.equal(contentHash.digest("hex"), dependency.contentSha256);

  const license = readFileSync(
    join(packedCli.packageRoot, dependency.license.sourcePath),
  );
  assert.equal(license.byteLength, dependency.license.bytes);
  assert.equal(
    createHash("sha256").update(license).digest("hex"),
    dependency.license.sha256,
  );
  assert.match(license.toString("utf8"), /^MIT License/);
  assert.match(
    readFileSync(
      join(packedCli.packageRoot, "THIRD_PARTY_NOTICES.md"),
      "utf8",
    ),
    /ed37663cc5fbef691ddfecd080dff42f7e7e350d/,
  );
});

test("doctor and uninstall fail closed when the manifest drifts", () => {
  withGitProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const manifestPath = join(
      context.projectDirectory,
      ".codex-ground-control",
      "manifest.json",
    );
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.managedBlock.installedSha256 = "0".repeat(64);
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const drifted = snapshotFiles(context.projectDirectory);

    const diagnosed = runJson(["doctor"], context);
    assert.equal(diagnosed.status, 2);
    assert.equal(
      diagnosed.receipt.error.code,
      "INSTALLATION_CONFLICT",
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), drifted);

    const uninstalled = runJson(["uninstall"], context);
    assert.equal(uninstalled.status, 2);
    assert.equal(
      uninstalled.receipt.error.code,
      "INSTALLATION_CONFLICT",
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), drifted);
  });
});

test("uninstall preserves a user-modified managed skill and reports conflict", () => {
  withGitProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const skillPath = join(
      context.projectDirectory,
      ".agents",
      "skills",
      "implement",
      "SKILL.md",
    );
    writeFileSync(
      skillPath,
      `${readFileSync(skillPath, "utf8")}\nuser change\n`,
    );
    const drifted = snapshotFiles(context.projectDirectory);

    const uninstalled = runJson(["uninstall"], context);
    assert.equal(uninstalled.status, 2);
    assert.equal(
      uninstalled.receipt.error.code,
      "INSTALLATION_CONFLICT",
    );
    assert.deepEqual(snapshotFiles(context.projectDirectory), drifted);
  });
});

test("uninstall leaves a modified preexisting skill outside product ownership", () => {
  withGitProject((context) => {
    const preexistingSkillPath = join(
      context.projectDirectory,
      ".agents",
      "skills",
      "tdd",
      "SKILL.md",
    );
    mkdirSync(dirname(preexistingSkillPath), { recursive: true });
    writeFileSync(
      preexistingSkillPath,
      readFileSync(
        join(
          packedCli.packageRoot,
          "vendor",
          "mattpocock-skills",
          "skills",
          "engineering",
          "tdd",
          "SKILL.md",
        ),
      ),
    );
    assert.equal(runJson(["init"], context).status, 0);

    const userModified = `${readFileSync(
      preexistingSkillPath,
      "utf8",
    )}\nuser-owned change\n`;
    writeFileSync(preexistingSkillPath, userModified);
    const uninstalled = runJson(["uninstall"], context);

    assert.equal(uninstalled.status, 0);
    assert.equal(uninstalled.receipt.result.installation, "removed");
    assert.equal(readFileSync(preexistingSkillPath, "utf8"), userModified);
    assert.equal(
      Object.hasOwn(snapshotFiles(context.projectDirectory), "AGENTS.md"),
      false,
    );
    assert.equal(
      Object.keys(snapshotFiles(context.projectDirectory)).some((path) =>
        path.startsWith(".codex-ground-control/")
      ),
      false,
    );
  });
});

test("uninstall removes only the managed block when user instruction bytes changed", () => {
  withGitProject((context) => {
    const agentsPath = join(context.projectDirectory, "AGENTS.md");
    const original = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("# original bytes", "utf8"),
    ]);
    writeFileSync(agentsPath, original);
    assert.equal(runJson(["init"], context).status, 0);

    const userSuffix = Buffer.from("\n# user added later\n", "utf8");
    writeFileSync(
      agentsPath,
      Buffer.concat([readFileSync(agentsPath), userSuffix]),
    );
    const uninstalled = runJson(["uninstall"], context);

    assert.equal(uninstalled.status, 0);
    assert.deepEqual(
      readFileSync(agentsPath),
      Buffer.concat([original, userSuffix]),
    );
  });
});

test("uninstall keeps project directories that existed before init", () => {
  withGitProject((context) => {
    const preexistingAgentsDirectory = join(
      context.projectDirectory,
      ".agents",
    );
    mkdirSync(preexistingAgentsDirectory);
    assert.equal(runJson(["init"], context).status, 0);

    const uninstalled = runJson(["uninstall"], context);

    assert.equal(uninstalled.status, 0);
    assert.equal(existsSync(preexistingAgentsDirectory), true);
    assert.deepEqual(readdirSync(preexistingAgentsDirectory), []);
  });
});

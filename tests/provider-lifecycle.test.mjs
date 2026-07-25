import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
let packedCli;

const piProfiles = [
  {
    id: "pi-glm",
    family: "pi",
    modelProvider: "zai-coding-cn",
    model: "glm-5.2",
  },
  {
    id: "pi-deepseek",
    family: "pi",
    modelProvider: "deepseek",
    model: "deepseek-v4-pro",
  },
  {
    id: "pi-minimax",
    family: "pi",
    modelProvider: "minimax-cn",
    model: "MiniMax-M3",
  },
];

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function piMessageEnd(provider, model, text) {
  return JSON.stringify({
    type: "message_end",
    message: {
      role: "assistant",
      provider,
      model,
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  });
}

function printPiMessageEnd(provider, model, text) {
  return `printf '%s\\n' ${shellQuote(
    piMessageEnd(provider, model, text),
  )}`;
}

function environment(homeDirectory, runtimeBin) {
  return {
    PATH: `${runtimeBin}:/usr/bin:/bin`,
    HOME: homeDirectory,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
  };
}

function snapshotFiles(root) {
  const files = {};
  const visit = (directory) => {
    for (const entry of readdirSync(directory, {
      withFileTypes: true,
    })) {
      if (directory === root && entry.name === ".git") {
        continue;
      }
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else {
        files[relative(root, path)] = readFileSync(path);
      }
    }
  };
  visit(root);
  return files;
}

function runJson(args, context, extraEnvironment = {}) {
  const result = spawnSync(packedCli.cli, [...args, "--json"], {
    cwd: context.projectDirectory,
    encoding: "utf8",
    env: {
      ...environment(context.homeDirectory, packedCli.runtimeBin),
      ...extraEnvironment,
    },
  });
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim().split("\n").length, 1);
  return {
    ...result,
    receipt: JSON.parse(result.stdout),
  };
}

function runHuman(args, context, extraEnvironment = {}) {
  return spawnSync(packedCli.cli, args, {
    cwd: context.projectDirectory,
    encoding: "utf8",
    env: {
      ...environment(context.homeDirectory, packedCli.runtimeBin),
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
    env: environment(homeDirectory, packedCli.runtimeBin),
  });
  callback({ homeDirectory, projectDirectory });
}

before(() => {
  const sandbox = mkdtempSync(join(tmpdir(), "cgc-provider-"));
  const packDirectory = join(sandbox, "pack");
  const installDirectory = join(sandbox, "install");
  const packHome = join(sandbox, "pack-home");
  const runtimeBin = join(sandbox, "runtime-bin");
  mkdirSync(packDirectory);
  mkdirSync(packHome);
  mkdirSync(runtimeBin);
  symlinkSync(process.execPath, join(runtimeBin, "node"));
  writeFileSync(
    join(runtimeBin, "codex"),
    "#!/bin/sh\nprintf 'codex-cli 0.145.0\\n'\n",
  );
  chmodSync(join(runtimeBin, "codex"), 0o755);
  const npmEnvironment = {
    ...environment(packHome, runtimeBin),
    PATH: process.env.PATH,
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
    packageRoot: join(
      installDirectory,
      "node_modules",
      "codex-ground-control",
    ),
    runtimeBin,
    sandbox,
  };
});

after(() => {
  if (packedCli) {
    rmSync(packedCli.sandbox, { recursive: true, force: true });
  }
});

test("provider list reports three independent Pi profiles without writing state", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const projectBefore = snapshotFiles(context.projectDirectory);
    const homeBefore = snapshotFiles(context.homeDirectory);

    const listed = runJson(["provider", "list"], context);

    assert.equal(listed.status, 0);
    assert.equal(listed.receipt.changed, false);
    assert.equal(listed.receipt.result.schemaVersion, "1");
    assert.equal(listed.receipt.result.operation, "list");
    assert.equal(
      listed.receipt.result.summary,
      "5 optional providers; 0 executable, 5 blocked.",
    );
    assert.deepEqual(
      listed.receipt.result.providers,
      [
        ...piProfiles,
        { id: "agy" },
        { id: "grok" },
      ].map((definition) => ({
        ...definition,
        detected: false,
        configured: false,
        enabled: false,
        qualified: false,
        drifted: false,
        disabled: true,
        blocked: true,
        decision: "blocked",
        reason: "provider-disabled",
        availability: "missing",
        qualification: "unqualified",
        cliVersion: null,
      })),
    );
    assert.deepEqual(
      snapshotFiles(context.projectDirectory),
      projectBefore,
    );
    assert.deepEqual(snapshotFiles(context.homeDirectory), homeBefore);
  });
});

test("legacy Pi state migrates fail-closed without expanding profile authority", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    assert.equal(
      runJson(["provider", "enable", "pi-glm"], context).status,
      0,
    );
    const [statePath] = Object.keys(
      snapshotFiles(context.homeDirectory),
    ).filter((path) => path.endsWith("/state.json"));
    assert.equal(typeof statePath, "string");
    const current = JSON.parse(
      readFileSync(join(context.homeDirectory, statePath), "utf8"),
    );
    const legacy = {
      schemaVersion: "1",
      projectKey: current.projectKey,
      providers: {
        pi: {
          enabled: true,
          qualification: null,
        },
        agy: {
          enabled: true,
          qualification: null,
        },
        grok: {
          enabled: false,
          qualification: null,
        },
      },
    };
    writeFileSync(
      join(context.homeDirectory, statePath),
      `${JSON.stringify(legacy, null, 2)}\n`,
    );
    const before = readFileSync(
      join(context.homeDirectory, statePath),
    );

    const listed = runJson(["provider", "list"], context);

    assert.equal(listed.status, 0);
    assert.equal(listed.receipt.result.providers[0].enabled, true);
    assert.equal(listed.receipt.result.providers[0].qualified, false);
    assert.equal(listed.receipt.result.providers[1].enabled, false);
    assert.equal(listed.receipt.result.providers[2].enabled, false);
    assert.equal(listed.receipt.result.providers[3].enabled, true);
    assert.deepEqual(
      readFileSync(join(context.homeDirectory, statePath)),
      before,
    );

    assert.equal(
      runJson(
        ["provider", "enable", "pi-deepseek"],
        context,
      ).status,
      0,
    );
    const migrated = JSON.parse(
      readFileSync(join(context.homeDirectory, statePath), "utf8"),
    );
    assert.deepEqual(Object.keys(migrated.providers), [
      "pi-glm",
      "pi-deepseek",
      "pi-minimax",
      "agy",
      "grok",
    ]);
    assert.equal(migrated.providers["pi-glm"].enabled, true);
    assert.equal(
      migrated.providers["pi-deepseek"].enabled,
      true,
    );
    assert.equal(migrated.providers["pi-minimax"].enabled, false);
  });
});

test("packaged probe adapter rejects an unapproved prompt before provider startup", () => {
  const providerBin = mkdtempSync(
    join(packedCli.sandbox, "runtime-private-prompt-"),
  );
  const invocationMarker = join(
    packedCli.sandbox,
    `private-prompt-invoked-${Date.now()}`,
  );
  writeFileSync(
    join(providerBin, "pi"),
    `#!/bin/sh\n: > '${invocationMarker}'\nexit 0\n`,
  );
  chmodSync(join(providerBin, "pi"), 0o755);

  const rejected = spawnSync(
    process.execPath,
    [
      join(
        packedCli.packageRoot,
        "fixtures",
        "providers",
        "probe-adapter.mjs",
      ),
      "pi-glm",
      "read a private repository",
    ],
    {
      encoding: "utf8",
      env: {
        PATH:
          `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
        HOME: packedCli.sandbox,
        TMPDIR: tmpdir(),
      },
    },
  );

  assert.equal(rejected.status, 1);
  assert.equal(
    rejected.stderr,
    "Provider public probe prompt is not approved.\n",
  );
  assert.equal(existsSync(invocationMarker), false);
});

test("Pi qualification and execution require explicit live approval before any provider process", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-live-gate-"),
    );
    const invocationMarker = join(
      packedCli.sandbox,
      `provider-invoked-${Date.now()}`,
    );
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        `: > '${invocationMarker}'`,
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 1.2.3\\n'",
        "  exit 0",
        "fi",
        "exit 9",
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
    };
    for (const { id } of piProfiles) {
      assert.equal(
        runJson(
          ["provider", "enable", id],
          context,
          providerEnvironment,
        ).status,
        0,
      );
      rmSync(invocationMarker, { force: true });

      for (const command of [
        ["provider", "qualify", id],
        [
          "provider",
          "run",
          id,
          "analysis",
          "bounded brief",
        ],
      ]) {
        const missingApproval = runJson(
          command,
          context,
          providerEnvironment,
        );
        assert.equal(missingApproval.status, 2);
        assert.equal(
          missingApproval.receipt.error.code,
          "PROVIDER_LIVE_CONFIRMATION_REQUIRED",
        );
        assert.equal(missingApproval.receipt.changed, false);
        assert.equal(existsSync(invocationMarker), false);
      }
    }

    const privatePrompt = runJson(
      [
        "provider",
        "qualify",
        "pi-glm",
        "--allow-live",
        "read-my-private-repository",
      ],
      context,
      providerEnvironment,
    );
    assert.equal(privatePrompt.status, 64);
    assert.equal(
      privatePrompt.receipt.error.code,
      "UNEXPECTED_ARGUMENTS",
    );
    assert.equal(
      privatePrompt.stdout.includes("read-my-private-repository"),
      false,
    );
    assert.equal(existsSync(invocationMarker), false);

    assert.equal(
      runJson(
        ["provider", "disable", "pi-glm"],
        context,
        providerEnvironment,
      ).status,
      0,
    );
    rmSync(invocationMarker, { force: true });
    const unsupported = runJson(
      ["provider", "qualify", "pi-glm", "--allow-live"],
      context,
      providerEnvironment,
    );
    assert.equal(unsupported.status, 2);
    assert.equal(
      unsupported.receipt.error.code,
      "PROVIDER_TRANSITION_UNSUPPORTED",
    );
    assert.equal(existsSync(invocationMarker), false);
  });
});

test("provider enable records only preference and disable preserves credential ownership", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-with-pi-"),
    );
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 1.2.3\\n'",
        "  exit 0",
        "fi",
        "exit 9",
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const secret = "provider-secret-must-stay-external";
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
      ZAI_CODING_CN_API_KEY: secret,
    };

    const detected = runJson(
      ["provider", "list"],
      context,
      providerEnvironment,
    );
    assert.deepEqual(
      detected.receipt.result.providers[0],
      {
        id: "pi-glm",
        family: "pi",
        modelProvider: "zai-coding-cn",
        model: "glm-5.2",
        detected: true,
        configured: true,
        enabled: false,
        qualified: false,
        drifted: false,
        disabled: true,
        blocked: true,
        decision: "blocked",
        reason: "provider-disabled",
        availability: "detected",
        qualification: "unqualified",
        cliVersion: "1.2.3",
      },
    );

    const enabled = runJson(
      ["provider", "enable", "pi-glm"],
      context,
      providerEnvironment,
    );
    assert.equal(enabled.status, 0);
    assert.equal(enabled.receipt.changed, true);
    assert.equal(enabled.receipt.result.operation, "enable");
    assert.equal(enabled.receipt.result.provider.enabled, true);
    assert.equal(enabled.receipt.result.provider.qualified, false);
    assert.equal(enabled.receipt.result.provider.blocked, true);
    assert.equal(
      enabled.receipt.result.provider.reason,
      "provider-unqualified",
    );

    const listed = runJson(
      ["provider", "list"],
      context,
      providerEnvironment,
    );
    assert.equal(listed.receipt.result.providers[0].enabled, true);
    assert.equal(listed.receipt.result.providers[0].blocked, true);

    const disabled = runJson(
      ["provider", "disable", "pi-glm"],
      context,
      providerEnvironment,
    );
    assert.equal(disabled.status, 0);
    assert.equal(disabled.receipt.changed, true);
    assert.equal(disabled.receipt.result.operation, "disable");
    assert.equal(disabled.receipt.result.provider.enabled, false);
    assert.equal(disabled.receipt.result.provider.disabled, true);
    assert.equal(
      disabled.receipt.result.provider.reason,
      "provider-disabled",
    );

    const home = snapshotFiles(context.homeDirectory);
    assert.equal(
      Object.values(home).some((contents) =>
        contents.toString("utf8").includes(secret)
      ),
      false,
    );
    assert.equal(
      disabled.stdout.includes(secret) || disabled.stderr.includes(secret),
      false,
    );
  });
});

test("Pi GLM qualification binds exact model identity, argv, environment, and evidence", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-qualified-pi-"),
    );
    const invocationLog = join(
      packedCli.sandbox,
      `provider-args-${Date.now()}`,
    );
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 1.2.3\\n'",
        "  exit 0",
        "fi",
        `printf '%s\\n' "$@" > '${invocationLog}'`,
        `printf 'cwd=%s\\n' "$PWD" >> '${invocationLog}'`,
        `printf 'home=%s\\n' "$HOME" >> '${invocationLog}'`,
        `printf 'zai=%s\\n' "\${ZAI_CODING_CN_API_KEY:+present}" >> '${invocationLog}'`,
        `printf 'deepseek=%s\\n' "\${DEEPSEEK_API_KEY:+present}" >> '${invocationLog}'`,
        `printf 'unrelated=%s\\n' "\${UNRELATED_SECRET:+present}" >> '${invocationLog}'`,
        printPiMessageEnd(
          "zai-coding-cn",
          "glm-5.2",
          '{"schemaVersion":"1","profile":"pi-glm","provider":"zai-coding-cn","model":"glm-5.2","probe":"public-sources-v1","ok":true}',
        ),
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const secret = "qualified-provider-secret-must-not-appear";
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
      ZAI_CODING_CN_API_KEY: secret,
      DEEPSEEK_API_KEY: "other-profile-secret",
      UNRELATED_SECRET: "unrelated-secret",
    };
    assert.equal(
      runJson(
        ["provider", "enable", "pi-glm"],
        context,
        providerEnvironment,
      ).status,
      0,
    );

    const qualified = runJson(
      ["provider", "qualify", "pi-glm", "--allow-live"],
      context,
      providerEnvironment,
    );

    assert.equal(qualified.status, 0);
    assert.equal(qualified.receipt.changed, true);
    assert.equal(qualified.receipt.result.operation, "qualify");
    assert.equal(
      qualified.receipt.result.qualification.terminalState,
      "passed",
    );
    assert.match(
      qualified.receipt.result.qualification.fingerprint,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      qualified.receipt.result.qualification.fingerprints.providerCli,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      qualified.receipt.result.qualification.fingerprints.adapter,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      qualified.receipt.result.qualification.evidence.anchor,
      /^[0-9a-f]{64}$/,
    );
    assert.equal(
      qualified.receipt.result.qualification.probe.id,
      "public-sources-v1",
    );
    assert.equal(
      qualified.receipt.result.qualification.probe.visibility,
      "public-only",
    );
    assert.deepEqual(
      qualified.receipt.result.qualification.identity,
      {
        profile: "pi-glm",
        provider: "zai-coding-cn",
        model: "glm-5.2",
      },
    );
    assert.deepEqual(
      qualified.receipt.result.qualification.identityVerification,
      {
        source: "pi-json-message-end",
        verified: true,
      },
    );
    assert.equal(qualified.receipt.result.provider.enabled, true);
    assert.equal(qualified.receipt.result.provider.qualified, true);
    assert.equal(qualified.receipt.result.provider.blocked, false);
    assert.equal(
      qualified.receipt.result.provider.decision,
      "allowed",
    );
    assert.equal(qualified.stdout.includes(secret), false);
    assert.equal(qualified.stderr.includes(secret), false);

    const invocation = readFileSync(invocationLog, "utf8");
    const invocationLines = invocation.trim().split("\n");
    assert.deepEqual(invocationLines.slice(0, 18), [
      "--provider",
      "zai-coding-cn",
      "--model",
      "glm-5.2",
      "--thinking",
      "medium",
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--system-prompt",
      "You are a fixed public qualification probe. Return exactly one raw JSON object with no Markdown or prose.",
      "--mode",
      "json",
      "--print",
    ]);
    assert.match(invocation, /www\.iana\.org\/help\/example-domains/);
    assert.equal(invocation.includes(context.projectDirectory), false);
    assert.match(invocation, /^cwd=.+\/workspace$/m);
    assert.match(invocation, /^home=.+\/workspace\/\.pi-home$/m);
    assert.match(invocation, /^zai=present$/m);
    assert.match(invocation, /^deepseek=$/m);
    assert.match(invocation, /^unrelated=$/m);

    const disabled = runJson(
      ["provider", "disable", "pi-glm"],
      context,
      providerEnvironment,
    );
    assert.equal(disabled.status, 0);
    assert.equal(disabled.receipt.result.provider.enabled, false);
    assert.equal(disabled.receipt.result.provider.qualified, true);
    assert.equal(disabled.receipt.result.provider.disabled, true);
    assert.equal(disabled.receipt.result.provider.blocked, true);
    const evidencePath =
      qualified.receipt.result.qualification.evidence.index.replace(
        "~/",
        "",
      );
    const qualificationEvidence = JSON.parse(
      readFileSync(
        join(
          context.homeDirectory,
          dirname(evidencePath),
          "provider-qualification.json",
        ),
        "utf8",
      ),
    );
    assert.deepEqual(
      Object.keys(qualificationEvidence.components).sort(),
      [
        "adapter",
        "fleetBoundary",
        "modelOrSearchContract",
        "probe",
        "providerCli",
        "providerLifecycle",
        "schema",
        "sourceRules",
      ],
    );
    assert.deepEqual(qualificationEvidence.identity, {
      profile: "pi-glm",
      provider: "zai-coding-cn",
      model: "glm-5.2",
    });
    assert.equal(
      existsSync(join(context.homeDirectory, evidencePath)),
      true,
    );
    assert.equal(
      existsSync(
        join(
          context.homeDirectory,
          dirname(evidencePath),
          "workspace",
        ),
      ),
      false,
    );
    assert.equal(
      Object.values(snapshotFiles(context.homeDirectory)).some(
        (contents) => contents.toString("utf8").includes(secret),
      ),
      false,
    );
  });
});

test("qualified Pi profile returns candidate evidence through a fixed no-tools execution", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-pi-candidate-"),
    );
    const invocationLog = join(
      packedCli.sandbox,
      `pi-candidate-args-${Date.now()}`,
    );
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 1.2.3\\n'",
        "  exit 0",
        "fi",
        `printf '%s\\n' "$@" > '${invocationLog}'`,
        `printf 'cwd=%s\\n' "$PWD" >> '${invocationLog}'`,
        `printf 'home=%s\\n' "$HOME" >> '${invocationLog}'`,
        `printf 'deepseek=%s\\n' "\${DEEPSEEK_API_KEY:+present}" >> '${invocationLog}'`,
        `printf 'zai=%s\\n' "\${ZAI_CODING_CN_API_KEY:+present}" >> '${invocationLog}'`,
        'for argument in "$@"; do prompt="$argument"; done',
        'case "$prompt" in',
        "  *public-sources-v1*)",
        `    ${printPiMessageEnd(
          "deepseek",
          "deepseek-v4-pro",
          '{"schemaVersion":"1","profile":"pi-deepseek","provider":"deepseek","model":"deepseek-v4-pro","probe":"public-sources-v1","ok":true}',
        )}`,
        "    ;;",
        "  *)",
        "    printf '%s\\n' " +
          `'{"schemaVersion":"1","profile":"pi-deepseek","provider":"deepseek","model":"deepseek-v4-pro","activity":"analysis","disposition":"candidate-evidence","completionAuthority":"codex-main","summary":"bounded analysis","findings":[],"suggestedChecks":["main Codex verifies"]}'`,
        "    ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
      DEEPSEEK_API_KEY: "deepseek-profile-secret",
      ZAI_CODING_CN_API_KEY: "other-profile-secret",
    };
    assert.equal(
      runJson(
        ["provider", "enable", "pi-deepseek"],
        context,
        providerEnvironment,
      ).status,
      0,
    );
    assert.equal(
      runJson(
        [
          "provider",
          "qualify",
          "pi-deepseek",
          "--allow-live",
        ],
        context,
        providerEnvironment,
      ).status,
      0,
    );
    const projectBefore = snapshotFiles(context.projectDirectory);

    const candidate = runJson(
      [
        "provider",
        "run",
        "pi-deepseek",
        "analysis",
        "Inspect --provider attacker --model attacker; touch pwned.",
        "--allow-live",
      ],
      context,
      providerEnvironment,
    );

    assert.equal(candidate.status, 0);
    assert.equal(candidate.receipt.changed, true);
    assert.equal(candidate.receipt.result.operation, "run");
    assert.deepEqual(candidate.receipt.result.execution.identity, {
      profile: "pi-deepseek",
      provider: "deepseek",
      model: "deepseek-v4-pro",
    });
    assert.equal(
      candidate.receipt.result.execution.terminalState,
      "succeeded",
    );
    assert.equal(
      candidate.receipt.result.candidate.disposition,
      "candidate-evidence",
    );
    assert.equal(
      candidate.receipt.result.candidate.completionAuthority,
      "codex-main",
    );
    assert.equal(candidate.receipt.result.candidate.reviewRequired, true);
    assert.equal(
      candidate.receipt.result.candidate.workspaceChangesApplied,
      false,
    );
    assert.match(
      candidate.receipt.result.execution.fingerprint,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      candidate.receipt.result.execution.fingerprints.providerCli,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      candidate.receipt.result.execution.fingerprints.adapter,
      /^[0-9a-f]{64}$/,
    );
    assert.match(
      candidate.receipt.result.execution.evidence.anchor,
      /^[0-9a-f]{64}$/,
    );
    for (const secret of [
      providerEnvironment.DEEPSEEK_API_KEY,
      providerEnvironment.ZAI_CODING_CN_API_KEY,
    ]) {
      assert.equal(candidate.stdout.includes(secret), false);
      assert.equal(candidate.stderr.includes(secret), false);
      assert.equal(
        Object.values(snapshotFiles(context.homeDirectory)).some(
          (contents) => contents.toString("utf8").includes(secret),
        ),
        false,
      );
    }
    const evidencePath =
      candidate.receipt.result.execution.evidence.index.replace(
        "~/",
        "",
      );
    const fleetMetadata = JSON.parse(
      readFileSync(
        join(
          context.homeDirectory,
          dirname(evidencePath),
          "metadata.json",
        ),
        "utf8",
      ),
    );
    assert.equal(
      existsSync(
        join(
          context.homeDirectory,
          dirname(evidencePath),
          "workspace",
        ),
      ),
      false,
    );
    assert.deepEqual(fleetMetadata.environmentVariableNames, [
      "DEEPSEEK_API_KEY",
      "HOME",
      "LANG",
      "LC_ALL",
      "NO_COLOR",
      "PATH",
      "TERM",
      "TMPDIR",
    ]);
    const invocation = readFileSync(invocationLog, "utf8");
    assert.match(invocation, /^--provider\ndeepseek$/m);
    assert.match(invocation, /^--model\ndeepseek-v4-pro$/m);
    for (const flag of [
      "--no-tools",
      "--no-session",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
    ]) {
      assert.match(invocation, new RegExp(`^${flag}$`, "m"));
    }
    assert.match(invocation, /^cwd=.+\/workspace$/m);
    assert.match(invocation, /^home=.+\/workspace\/\.pi-home$/m);
    assert.match(invocation, /^deepseek=present$/m);
    assert.match(invocation, /^zai=$/m);
    assert.equal(invocation.includes(context.projectDirectory), false);
    assert.deepEqual(
      snapshotFiles(context.projectDirectory),
      projectBefore,
    );
  });
});

test("one Pi identity failure or profile drift leaves the other profiles and offline core usable", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-pi-profile-isolation-"),
    );
    const modeFile = join(providerBin, "mode.txt");
    const invocationMarker = join(
      packedCli.sandbox,
      `pi-profile-invoked-${Date.now()}`,
    );
    writeFileSync(modeFile, "success\n");
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 1.2.3\\n'",
        "  exit 0",
        "fi",
        `printf 'pi\\n' >> '${invocationMarker}'`,
        "previous=''",
        "prompt=''",
        'for argument in "$@"; do',
        '  if [ "$previous" = "--provider" ]; then provider="$argument"; fi',
        '  if [ "$previous" = "--model" ]; then model="$argument"; fi',
        '  previous="$argument"',
        '  prompt="$argument"',
        "done",
        'case "$provider" in',
        "  zai-coding-cn) profile='pi-glm' ;;",
        "  deepseek) profile='pi-deepseek' ;;",
        "  minimax-cn) profile='pi-minimax' ;;",
        "  *) exit 8 ;;",
        "esac",
        `mode="$(cat '${modeFile}')"`,
        'case "$prompt" in',
        "  *public-sources-v1*)",
        '    observed_model="$model"',
        '    if [ "$mode" = "wrong-deepseek" ] && [ "$profile" = "pi-deepseek" ]; then observed_model="wrong-model"; fi',
        "    printf " +
          `'{"type":"message_end","message":{"role":"assistant","provider":"%s","model":"%s","content":[{"type":"text","text":"{\\\\\\"schemaVersion\\\\\\":\\\\\\"1\\\\\\",\\\\\\"profile\\\\\\":\\\\\\"%s\\\\\\",\\\\\\"provider\\\\\\":\\\\\\"%s\\\\\\",\\\\\\"model\\\\\\":\\\\\\"%s\\\\\\",\\\\\\"probe\\\\\\":\\\\\\"public-sources-v1\\\\\\",\\\\\\"ok\\\\\\":true}"}],"stopReason":"stop"}}\\n' "$provider" "$observed_model" "$profile" "$provider" "$model"`,
        "    ;;",
        "  *)",
        "    printf " +
          `'{"schemaVersion":"1","profile":"%s","provider":"%s","model":"%s","activity":"analysis","disposition":"candidate-evidence","completionAuthority":"codex-main","summary":"candidate","findings":[],"suggestedChecks":[]}\\n' "$profile" "$provider" "$model"`,
        "    ;;",
        "esac",
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
      ZAI_CODING_CN_API_KEY: "glm-secret",
      DEEPSEEK_API_KEY: "deepseek-secret",
      MINIMAX_API_KEY: "minimax-secret",
    };
    const qualificationFingerprints = new Set();
    for (const { id } of piProfiles) {
      assert.equal(
        runJson(
          ["provider", "enable", id],
          context,
          providerEnvironment,
        ).status,
        0,
      );
      const qualified = runJson(
          ["provider", "qualify", id, "--allow-live"],
          context,
          providerEnvironment,
      );
      assert.equal(qualified.status, 0);
      qualificationFingerprints.add(
        qualified.receipt.result.qualification.fingerprint,
      );
    }
    assert.equal(qualificationFingerprints.size, 3);
    const catalogPath = join(
      packedCli.packageRoot,
      "fixtures",
      "providers",
      "public-probes-v1.json",
    );
    const originalCatalog = readFileSync(catalogPath);
    try {
      const driftedCatalog = JSON.parse(
        originalCatalog.toString("utf8"),
      );
      driftedCatalog.providers["pi-deepseek"].prompt +=
        " Profile-local contract drift.";
      writeFileSync(
        catalogPath,
        `${JSON.stringify(driftedCatalog, null, 2)}\n`,
      );
      const drifted = runJson(
        ["provider", "list"],
        context,
        providerEnvironment,
      );
      assert.equal(drifted.receipt.result.providers[0].qualified, true);
      assert.equal(drifted.receipt.result.providers[0].drifted, false);
      assert.equal(drifted.receipt.result.providers[1].qualified, false);
      assert.equal(drifted.receipt.result.providers[1].drifted, true);
      assert.equal(drifted.receipt.result.providers[2].qualified, true);
      assert.equal(drifted.receipt.result.providers[2].drifted, false);
    } finally {
      writeFileSync(catalogPath, originalCatalog);
    }
    writeFileSync(modeFile, "wrong-deepseek\n");

    const failed = runJson(
      [
        "provider",
        "qualify",
        "pi-deepseek",
        "--allow-live",
      ],
      context,
      providerEnvironment,
    );

    assert.equal(failed.status, 2);
    assert.equal(
      failed.receipt.result.qualification.terminalState,
      "failed",
    );
    assert.deepEqual(
      failed.receipt.result.qualification.identity,
      {
        profile: "pi-deepseek",
        provider: "deepseek",
        model: "deepseek-v4-pro",
      },
    );
    assert.deepEqual(
      failed.receipt.result.qualification.identityVerification,
      {
        source: "pi-json-message-end",
        verified: false,
      },
    );
    const listed = runJson(
      ["provider", "list"],
      context,
      providerEnvironment,
    );
    assert.equal(listed.receipt.result.providers[0].qualified, true);
    assert.equal(listed.receipt.result.providers[0].blocked, false);
    assert.equal(
      listed.receipt.result.providers[1].qualification,
      "failed",
    );
    assert.equal(listed.receipt.result.providers[1].blocked, true);
    assert.equal(listed.receipt.result.providers[2].qualified, true);
    assert.equal(listed.receipt.result.providers[2].blocked, false);

    const candidate = runJson(
      [
        "provider",
        "run",
        "pi-glm",
        "analysis",
        "independent bounded task",
        "--allow-live",
      ],
      context,
      providerEnvironment,
    );
    assert.equal(candidate.status, 0);
    rmSync(invocationMarker, { force: true });

    const core = runJson(
      ["qualify"],
      context,
      providerEnvironment,
    );
    assert.equal(core.status, 0);
    assert.equal(
      core.receipt.result.terminalState,
      "release-passed",
    );
    assert.equal(existsSync(invocationMarker), false);
  });
});

test("Pi qualification records invalid output and nonzero exit as profile-local failures", () => {
  const cases = [
    {
      id: "pi-glm",
      body: printPiMessageEnd(
        "zai-coding-cn",
        "glm-5.2",
        "not-json",
      ),
      fleetStatus: "invalid-output",
    },
    {
      id: "pi-minimax",
      body: "printf 'fixture failure\\n' >&2\nexit 17",
      fleetStatus: "process-failed",
    },
  ];
  for (const fixture of cases) {
    withProject((context) => {
      assert.equal(runJson(["init"], context).status, 0);
      const providerBin = mkdtempSync(
        join(packedCli.sandbox, `runtime-${fixture.id}-failure-`),
      );
      writeFileSync(
        join(providerBin, "pi"),
        [
          "#!/bin/sh",
          'if [ "$1" = "--version" ]; then',
          "  printf 'pi 1.2.3\\n'",
          "  exit 0",
          "fi",
          fixture.body,
          "",
        ].join("\n"),
      );
      chmodSync(join(providerBin, "pi"), 0o755);
      const providerEnvironment = {
        PATH:
          `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
      };
      assert.equal(
        runJson(
          ["provider", "enable", fixture.id],
          context,
          providerEnvironment,
        ).status,
        0,
      );

      const failed = runJson(
        [
          "provider",
          "qualify",
          fixture.id,
          "--allow-live",
        ],
        context,
        providerEnvironment,
      );

      assert.equal(failed.status, 2);
      assert.equal(
        failed.receipt.result.qualification.terminalState,
        "failed",
      );
      const evidencePath =
        failed.receipt.result.qualification.evidence.index.replace(
          "~/",
          "",
        );
      const summary = JSON.parse(
        readFileSync(
          join(
            context.homeDirectory,
            dirname(evidencePath),
            "provider-qualification.json",
          ),
          "utf8",
        ),
      );
      assert.equal(summary.fleetStatus, fixture.fleetStatus);
    });
  }
});

test("provider CLI drift invalidates only that gate until explicit requalification", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-drifting-pi-"),
    );
    const versionFile = join(providerBin, "version.txt");
    writeFileSync(versionFile, "1.2.3\n");
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then',
        `  printf 'pi %s\\n' "$(cat '${versionFile}')"`,
        "  exit 0",
        "fi",
        printPiMessageEnd(
          "zai-coding-cn",
          "glm-5.2",
          '{"schemaVersion":"1","profile":"pi-glm","provider":"zai-coding-cn","model":"glm-5.2","probe":"public-sources-v1","ok":true}',
        ),
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
    };
    assert.equal(
      runJson(
        ["provider", "enable", "pi-glm"],
        context,
        providerEnvironment,
      ).status,
      0,
    );
    const first = runJson(
      ["provider", "qualify", "pi-glm", "--allow-live"],
      context,
      providerEnvironment,
    );
    assert.equal(first.status, 0);
    const firstIndex =
      first.receipt.result.qualification.evidence.index.replace(
        "~/",
        "",
      );
    writeFileSync(versionFile, "1.2.4\n");

    const drifted = runJson(
      ["provider", "list"],
      context,
      providerEnvironment,
    );

    const pi = drifted.receipt.result.providers[0];
    assert.equal(pi.enabled, true);
    assert.equal(pi.qualified, false);
    assert.equal(pi.drifted, true);
    assert.equal(pi.blocked, true);
    assert.equal(pi.reason, "provider-drifted");
    assert.equal(pi.cliVersion, "1.2.4");
    assert.equal(
      drifted.receipt.result.providers[1].drifted,
      false,
    );
    assert.equal(
      drifted.receipt.result.providers[2].drifted,
      false,
    );

    const requalified = runJson(
      ["provider", "qualify", "pi-glm", "--allow-live"],
      context,
      providerEnvironment,
    );
    assert.equal(requalified.status, 0);
    assert.equal(requalified.receipt.result.provider.qualified, true);
    assert.equal(requalified.receipt.result.provider.drifted, false);
    assert.notEqual(
      requalified.receipt.result.qualification.fingerprint,
      first.receipt.result.qualification.fingerprint,
    );
    assert.equal(
      existsSync(join(context.homeDirectory, firstIndex)),
      true,
    );
  });
});

test("one provider failure leaves another qualified provider and offline core usable", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const providerBin = mkdtempSync(
      join(packedCli.sandbox, "runtime-isolated-providers-"),
    );
    const invocationMarker = join(
      packedCli.sandbox,
      `provider-network-invoked-${Date.now()}`,
    );
    writeFileSync(
      join(providerBin, "pi"),
      [
        "#!/bin/sh",
        `printf 'pi\\n' >> '${invocationMarker}'`,
        'if [ "$1" = "--version" ]; then',
        "  printf 'pi 1.2.3\\n'",
        "  exit 0",
        "fi",
        printPiMessageEnd(
          "zai-coding-cn",
          "glm-5.2",
          '{"schemaVersion":"1","profile":"pi-glm","provider":"zai-coding-cn","model":"glm-5.2","probe":"public-sources-v1","ok":true}',
        ),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(providerBin, "agy"),
      [
        "#!/bin/sh",
        `printf 'agy\\n' >> '${invocationMarker}'`,
        'if [ "$1" = "--version" ]; then',
        "  printf 'agy 2.3.4\\n'",
        "  exit 0",
        "fi",
        "printf 'fixture provider failure\\n' >&2",
        "exit 7",
        "",
      ].join("\n"),
    );
    chmodSync(join(providerBin, "pi"), 0o755);
    chmodSync(join(providerBin, "agy"), 0o755);
    const providerEnvironment = {
      PATH:
        `${providerBin}:${packedCli.runtimeBin}:/usr/bin:/bin`,
      GEMINI_API_KEY: "agy-secret-must-not-appear",
    };
    for (const provider of ["pi-glm", "agy"]) {
      assert.equal(
        runJson(
          ["provider", "enable", provider],
          context,
          providerEnvironment,
        ).status,
        0,
      );
    }
    assert.equal(
      runJson(
        ["provider", "qualify", "pi-glm", "--allow-live"],
        context,
        providerEnvironment,
      ).status,
      0,
    );

    const failed = runJson(
      ["provider", "qualify", "agy", "--allow-live"],
      context,
      providerEnvironment,
    );

    assert.equal(failed.status, 2);
    assert.equal(failed.receipt.changed, true);
    assert.equal(
      failed.receipt.error.code,
      "PROVIDER_QUALIFICATION_FAILED",
    );
    assert.equal(
      failed.receipt.result.qualification.terminalState,
      "failed",
    );
    assert.equal(failed.receipt.result.provider.qualification, "failed");
    assert.equal(
      failed.receipt.result.provider.reason,
      "provider-qualification-failed",
    );
    assert.equal(
      failed.stdout.includes(providerEnvironment.GEMINI_API_KEY),
      false,
    );

    const listed = runJson(
      ["provider", "list"],
      context,
      providerEnvironment,
    );
    assert.equal(listed.receipt.result.providers[0].qualified, true);
    assert.equal(listed.receipt.result.providers[0].blocked, false);
    assert.equal(listed.receipt.result.providers[3].qualified, false);
    assert.equal(listed.receipt.result.providers[3].blocked, true);
    rmSync(invocationMarker, { force: true });

    const core = runJson(
      ["qualify"],
      context,
      providerEnvironment,
    );
    assert.equal(core.status, 0);
    assert.equal(
      core.receipt.result.terminalState,
      "release-passed",
    );
    assert.equal(existsSync(invocationMarker), false);
  });
});

test("human and JSON modes expose the same decisions and invalid requests fail stably", () => {
  withProject((context) => {
    assert.equal(runJson(["init"], context).status, 0);
    const listed = runJson(["provider", "list"], context);
    const human = runHuman(["provider", "list"], context);

    assert.equal(human.status, 0);
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /^Ground Control providers:\n/);
    for (const provider of listed.receipt.result.providers) {
      assert.match(
        human.stdout,
        new RegExp(
          `^  ${provider.id}: ${provider.decision} ` +
          `\\(${provider.reason}\\); ` +
          `detected=${provider.detected ? "yes" : "no"} ` +
          `configured=${provider.configured ? "yes" : "no"} ` +
          `enabled=${provider.enabled ? "yes" : "no"} ` +
          `qualified=${provider.qualified ? "yes" : "no"} ` +
          `drifted=${provider.drifted ? "yes" : "no"} ` +
          `disabled=${provider.disabled ? "yes" : "no"} ` +
          `blocked=${provider.blocked ? "yes" : "no"}` +
          (provider.family === "pi"
            ? ` identity=${provider.modelProvider}/${provider.model}`
            : "") +
          "$",
          "m",
        ),
      );
    }

    const invalidId = runJson(
      ["provider", "enable", "../pi"],
      context,
    );
    assert.equal(invalidId.status, 2);
    assert.equal(
      invalidId.receipt.error.code,
      "PROVIDER_ID_INVALID",
    );

    const unknownOperation = runJson(
      ["provider", "launch", "pi-glm"],
      context,
    );
    assert.equal(unknownOperation.status, 64);
    assert.equal(
      unknownOperation.receipt.error.code,
      "PROVIDER_OPERATION_INVALID",
    );
  });
});

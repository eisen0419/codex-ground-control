#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  evaluateNpmRegistryPackage,
} from "../src/release-name-checks.js";
import { inspectFile } from "../src/safe-files.js";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageMetadata = JSON.parse(
  readFileSync(join(repositoryRoot, "package.json"), "utf8"),
);
const releaseLock = JSON.parse(
  readFileSync(join(repositoryRoot, "release-lock.json"), "utf8"),
);
const providerIds = [
  "pi-glm",
  "pi-deepseek",
  "pi-minimax",
  "agy",
  "grok",
];
const nonBlockingLimitations = new Set([
  "one-or-more-live-provider-campaigns-failed",
  "native-agent-execution-blocked",
  "external-workspace-write-blocked",
]);
const repositoryCommands = [
  ["npm", ["run", "release-lock:verify"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["test"]],
];
const expectedPackageFileRoots = new Set([
  ".codex-plugin",
  ".mcp.json",
  ".mcp.v0.3.json",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "assets",
  "bin",
  "fixtures",
  "node_modules",
  "package.json",
  "release-lock.json",
  "schemas",
  "src",
  "vendor",
]);
const sensitiveName = /(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i;
const encodedSecretPatterns = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
];
const personalPathPatterns = [
  /\/Users\/[^/\s"'`]+/g,
  /\/home\/[^/\s"'`]+/g,
  /[A-Za-z]:\\Users\\[^\\\s"'`]+/g,
];
const privateArtifactPathPatterns = [
  /(?:^|\/)(?:\.codex|\.codex-ground-control|\.grok)(?:\/|$)/i,
  /(?:^|\/)evidence(?:\/|$)/i,
  /(?:^|\/)(?:auth|credentials?|tokens?)(?:\.[^/]+)?$/i,
];

function usage(message = null) {
  if (message) {
    process.stderr.write(`${message}\n`);
  }
  process.stderr.write(
    [
      "Usage: node scripts/release-candidate.mjs [options]",
      "",
      "Options:",
      "  --output <directory>          Candidate output directory",
      "  --allow-live                  Run all five live provider campaigns",
      "  --skip-live                   Record live campaigns as not run",
      "  --skip-name-checks             Skip npm and GitHub read-only checks",
      "  --skip-repository-checks       Skip release lock, typecheck, and tests",
      "  -h, --help                    Show this help",
      "",
    ].join("\n"),
  );
  process.exit(message ? 64 : 0);
}

function parseArguments(args) {
  const options = {
    allowLive: false,
    skipLive: false,
    skipNameChecks: false,
    skipRepositoryChecks: false,
    output: null,
  };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["-h", "--help"].includes(argument)) {
      usage();
    } else if (argument === "--output") {
      const output = args[index + 1];
      if (!output || output.startsWith("--")) {
        usage("--output requires a directory.");
      }
      options.output = resolve(output);
      index += 1;
    } else if (argument === "--allow-live") {
      options.allowLive = true;
    } else if (argument === "--skip-live") {
      options.skipLive = true;
    } else if (argument === "--skip-name-checks") {
      options.skipNameChecks = true;
    } else if (argument === "--skip-repository-checks") {
      options.skipRepositoryChecks = true;
    } else {
      usage(`Unknown option: ${argument}`);
    }
  }
  if (options.allowLive === options.skipLive) {
    usage("Choose exactly one of --allow-live or --skip-live.");
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  options.output ??= join(
    repositoryRoot,
    "release-candidate",
    `${packageMetadata.version}-${timestamp}`,
  );
  if (
    options.output === repositoryRoot ||
    repositoryRoot.startsWith(`${options.output}/`)
  ) {
    usage("The output directory cannot contain the repository.");
  }
  const outputInsideRepository = portablePath(
    relative(repositoryRoot, options.output),
  );
  if (
    !outputInsideRepository.startsWith("../") &&
    outputInsideRepository !== "release-candidate" &&
    !outputInsideRepository.startsWith("release-candidate/")
  ) {
    usage(
      "Repository-local output must stay under the ignored release-candidate directory.",
    );
  }
  return options;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(value) {
  return value.split("\\").join("/");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd ?? repositoryRoot,
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 8 * 1024 * 1024,
    timeout: options.timeout ?? 120_000,
  });
}

function commandStatus(command, args) {
  const result = run(command, args, { timeout: 300_000 });
  return {
    command: [command, ...args].join(" "),
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status,
  };
}

function gitValue(args, fallback = null) {
  const result = run("/usr/bin/git", args);
  return result.status === 0 ? result.stdout.trim() : fallback;
}

function isolatedEnvironment(homeDirectory, additions = {}) {
  const environment = {
    PATH: process.env.PATH,
    HOME: homeDirectory,
    TMPDIR: tmpdir(),
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of [
    "TERM",
    "NO_COLOR",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "ZAI_CODING_CN_API_KEY",
    "DEEPSEEK_API_KEY",
    "MINIMAX_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
  ]) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return { ...environment, ...additions };
}

function isolatedNpmEnvironment(homeDirectory, cacheDirectory) {
  return isolatedEnvironment(homeDirectory, {
    npm_config_cache: cacheDirectory,
    npm_config_offline: "true",
    npm_config_ignore_scripts: "true",
    npm_config_update_notifier: "false",
  });
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
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files[portablePath(relative(root, absolutePath))] =
          readFileSync(absolutePath).toString("base64");
      }
    }
  };
  visit(root);
  return files;
}

function copyGrokAuthentication(sourceHome, targetHome) {
  let source;
  try {
    source = inspectFile(sourceHome, ".grok/auth.json");
  } catch {
    return false;
  }
  if (
    source.state !== "file" ||
    source.contents.byteLength > 65_536
  ) {
    return false;
  }
  const targetDirectory = join(targetHome, ".grok");
  mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const target = join(targetDirectory, "auth.json");
  writeFileSync(target, source.contents, {
    flag: "wx",
    mode: 0o600,
  });
  chmodSync(target, 0o600);
  return true;
}

function pack(repository, destination, environment) {
  mkdirSync(destination);
  const result = run(
    "npm",
    [
      "pack",
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      destination,
    ],
    {
      cwd: repository,
      env: environment,
    },
  );
  if (result.status !== 0) {
    throw new Error("npm pack failed.");
  }
  const [metadata] = JSON.parse(result.stdout);
  const tarball = join(destination, metadata.filename);
  return {
    metadata,
    tarball,
    hash: sha256(readFileSync(tarball)),
  };
}

function installTarball(tarball, installDirectory, environment) {
  const result = run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--prefix",
      installDirectory,
      tarball,
    ],
    { env: environment },
  );
  if (result.status !== 0) {
    throw new Error("The packed tarball could not be installed.");
  }
  return join(
    installDirectory,
    "node_modules",
    packageMetadata.name,
  );
}

function countPatternMatches(contents, patterns) {
  let matches = 0;
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    matches += [...contents.matchAll(pattern)].length;
  }
  return matches;
}

function bundledPackageName(path) {
  const parts = portablePath(path).split("/");
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (
    nodeModulesIndex === -1 ||
    parts.length <= nodeModulesIndex + 1
  ) {
    return null;
  }
  const first = parts[nodeModulesIndex + 1];
  if (first.startsWith("@")) {
    return parts.length > nodeModulesIndex + 2
      ? `${first}/${parts[nodeModulesIndex + 2]}`
      : null;
  }
  return first;
}

function bundledPackageDirectory(path) {
  const parts = portablePath(path).split("/");
  const nodeModulesIndex = parts.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1) {
    return null;
  }
  const packageEnd =
    parts[nodeModulesIndex + 1]?.startsWith("@")
      ? nodeModulesIndex + 3
      : nodeModulesIndex + 2;
  if (
    parts.length !== packageEnd + 1 ||
    parts[packageEnd] !== "package.json"
  ) {
    return null;
  }
  return parts.slice(0, packageEnd).join("/");
}

function scanPackage(
  packageRoot,
  packedFiles,
  bundledPackageNames,
) {
  const sensitiveValues = Object.entries(process.env)
    .filter(
      ([name, value]) =>
        sensitiveName.test(name) &&
        typeof value === "string" &&
        value.length >= 8,
    )
    .map(([, value]) => value);
  const declaredVendorFiles = new Set(
    releaseLock.dependencies.flatMap((dependency) => [
      dependency.license.sourcePath,
      ...dependency.assets.map((asset) => asset.sourcePath),
    ]),
  );
  const declaredBundledPackages = new Set(
    bundledPackageNames,
  );
  let secretMatches = 0;
  let personalPathMatches = 0;
  let privateArtifactFiles = 0;
  let undeclaredThirdPartyFiles = 0;
  for (const { path } of packedFiles) {
    const thirdPartyRuntime = path.startsWith(
      "node_modules/",
    );
    if (
      isAbsolute(path) ||
      portablePath(path).split("/").includes("..")
    ) {
      undeclaredThirdPartyFiles += 1;
      continue;
    }
    const topLevel = path.split("/")[0];
    if (!expectedPackageFileRoots.has(topLevel)) {
      undeclaredThirdPartyFiles += 1;
    }
    if (
      thirdPartyRuntime &&
      !declaredBundledPackages.has(
        bundledPackageName(path),
      )
    ) {
      undeclaredThirdPartyFiles += 1;
    }
    if (path.startsWith("vendor/") && !declaredVendorFiles.has(path)) {
      undeclaredThirdPartyFiles += 1;
    }
    if (
      !thirdPartyRuntime &&
      privateArtifactPathPatterns.some((pattern) =>
        pattern.test(portablePath(path))
      )
    ) {
      privateArtifactFiles += 1;
    }
    const contents = readFileSync(join(packageRoot, path)).toString("utf8");
    secretMatches += sensitiveValues.filter((value) =>
      contents.includes(value)
    ).length;
    secretMatches += countPatternMatches(
      contents,
      encodedSecretPatterns,
    );
    if (!thirdPartyRuntime) {
      personalPathMatches += countPatternMatches(
        contents,
        personalPathPatterns,
      );
    }
  }
  const status =
    secretMatches === 0 &&
      personalPathMatches === 0 &&
      privateArtifactFiles === 0 &&
      undeclaredThirdPartyFiles === 0
      ? "passed"
      : "failed";
  return {
    status,
    files: packedFiles.length,
    secretMatches,
    personalPathMatches,
    privateArtifactFiles,
    undeclaredThirdPartyFiles,
  };
}

function auditLicenses(
  packageRoot,
  packedFiles,
  bundledPackageNames,
) {
  const runtimeDependencyNames = [
    ...Object.keys(packageMetadata.dependencies ?? {}),
    ...Object.keys(packageMetadata.optionalDependencies ?? {}),
    ...Object.keys(packageMetadata.peerDependencies ?? {}),
  ];
  const runtimeDependencies = runtimeDependencyNames.length;
  const declaredBundles =
    packageMetadata.bundleDependencies ??
    packageMetadata.bundledDependencies ??
    [];
  const bundledNames = new Set(bundledPackageNames);
  const packedPaths = packedFiles.map(({ path }) => path);
  const allowedRuntimeLicenses = new Set([
    "MIT",
    "ISC",
    "BSD-2-Clause",
    "BSD-3-Clause",
  ]);
  const bundledPackages = [];
  for (const packageJsonPath of packedPaths) {
    const packageDirectory =
      bundledPackageDirectory(packageJsonPath);
    if (packageDirectory === null) {
      continue;
    }
    const metadata = JSON.parse(
      readFileSync(
        join(packageRoot, packageJsonPath),
        "utf8",
      ),
    );
    const licenseFiles = packedPaths.filter((path) => {
      if (!path.startsWith(`${packageDirectory}/`)) {
        return false;
      }
      const relativePath = path.slice(
        packageDirectory.length + 1,
      );
      return (
        !relativePath.includes("/") &&
        /^(?:licen[sc]e|copying)(?:[._-].*)?$/i.test(
          relativePath,
        )
      );
    });
    bundledPackages.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license,
      licenseFiles,
    });
  }
  const bundledLicensesValid =
    bundledPackages.length >= bundledNames.size &&
    bundledPackages.every(
      ({ name, version, license, licenseFiles }) =>
        bundledNames.has(name) &&
        typeof version === "string" &&
        version !== "" &&
        allowedRuntimeLicenses.has(license) &&
        licenseFiles.length >= 1,
    ) &&
    [...bundledNames].every((name) =>
      bundledPackages.some(
        (dependency) => dependency.name === name,
      )
    );
  const bundleContractValid =
    declaredBundles.length === runtimeDependencies &&
    runtimeDependencyNames.every(
      (name) =>
        declaredBundles.includes(name) &&
        bundledNames.has(name),
    );
  let declaredLicensesValid = true;
  const notices = readFileSync(
    join(packageRoot, "THIRD_PARTY_NOTICES.md"),
    "utf8",
  );
  for (const dependency of releaseLock.dependencies) {
    const license = readFileSync(
      join(packageRoot, dependency.license.sourcePath),
    );
    if (
      license.byteLength !== dependency.license.bytes ||
      sha256(license) !== dependency.license.sha256 ||
      !notices.includes(dependency.name) ||
      !notices.includes(dependency.revision)
    ) {
      declaredLicensesValid = false;
    }
  }
  const packageLicense = readFileSync(
    join(packageRoot, "LICENSE"),
    "utf8",
  );
  const status =
    packageMetadata.license === "MIT" &&
      packageLicense.startsWith("MIT License") &&
      bundleContractValid &&
      bundledLicensesValid &&
      declaredLicensesValid
      ? "passed"
      : "failed";
  return {
    status,
    packageLicense: packageMetadata.license,
    runtimeDependencies,
    bundleDependencies: declaredBundles.length,
    bundledPackages: bundledPackages.length,
    bundledLicenseFiles: bundledPackages.reduce(
      (total, dependency) =>
        total + dependency.licenseFiles.length,
      0,
    ),
    thirdPartyDependencies:
      releaseLock.dependencies.length +
      bundledPackages.length,
    notices: "THIRD_PARTY_NOTICES.md",
  };
}

function writeReceipt(outputDirectory, name, invocation) {
  const receiptPath = join(outputDirectory, "receipts", `${name}.json`);
  writeJson(receiptPath, invocation.receipt);
  return portablePath(relative(outputDirectory, receiptPath));
}

function invokeCli(cli, args, options) {
  const result = run(cli, [...args, "--json"], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeout ?? 180_000,
  });
  let receipt = null;
  try {
    receipt = JSON.parse(result.stdout);
  } catch {
    receipt = null;
  }
  const validTransport =
    receipt !== null &&
    result.status === receipt.exitCode &&
    result.stderr === "" &&
    result.stdout === `${JSON.stringify(receipt)}\n`;
  if (!validTransport) {
    receipt = {
      schemaVersion: "1",
      product: packageMetadata.name,
      version: packageMetadata.version,
      command: args[0] ?? null,
      status: "blocked",
      exitCode: result.status,
      changed: false,
      error: {
        code: "RELEASE_CANDIDATE_INVOCATION_FAILED",
        message: "The public CLI did not return one JSON receipt.",
      },
    };
  }
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    receipt,
  };
}

function receiptSummary(invocation) {
  return {
    status: invocation.receipt.status,
    exitCode: invocation.receipt.exitCode,
  };
}

function copyQualificationEvidence(
  sourceHome,
  outputDirectory,
  kind,
  provider,
  runIdentity,
) {
  const source = provider
    ? join(
        sourceHome,
        ".codex-ground-control",
        "evidence",
        "providers",
      )
    : join(
        sourceHome,
        ".codex-ground-control",
        "evidence",
        "qualification",
        runIdentity,
      );
  let providerSource = source;
  if (provider) {
    const projectKeys = existsSync(source) ? readdirSync(source) : [];
    providerSource = projectKeys.length === 1
      ? join(source, projectKeys[0], provider, runIdentity)
      : null;
  }
  if (!providerSource || !existsSync(providerSource)) {
    return null;
  }
  const target = provider
    ? join(
        outputDirectory,
        "evidence",
        "providers",
        provider,
        runIdentity,
      )
    : join(
        outputDirectory,
        "evidence",
        kind,
        runIdentity,
      );
  mkdirSync(dirname(target), { recursive: true });
  cpSync(providerSource, target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return portablePath(relative(outputDirectory, target));
}

function runLifecycle(
  cli,
  homeDirectory,
  outputDirectory,
  networkTrap,
  allowLive,
) {
  const projectDirectory = join(homeDirectory, "project");
  mkdirSync(projectDirectory);
  const baseEnvironment = isolatedEnvironment(homeDirectory);
  const offlineEnvironment = {
    ...baseEnvironment,
    NODE_OPTIONS: `--import=${pathToFileURL(networkTrap).href}`,
  };
  const git = run(
    "/usr/bin/git",
    ["init", "-b", "main"],
    {
      cwd: projectDirectory,
      env: offlineEnvironment,
    },
  );
  if (git.status !== 0) {
    throw new Error("The release fixture Git repository could not be created.");
  }
  const before = snapshotFiles(projectDirectory);
  const init = invokeCli(cli, ["init"], {
    cwd: projectDirectory,
    env: offlineEnvironment,
  });
  const initReceipt = writeReceipt(outputDirectory, "init", init);
  const initAgain = invokeCli(cli, ["init"], {
    cwd: projectDirectory,
    env: offlineEnvironment,
  });
  writeReceipt(outputDirectory, "init-idempotent", initAgain);
  const doctor = invokeCli(cli, ["doctor"], {
    cwd: projectDirectory,
    env: offlineEnvironment,
  });
  const doctorReceipt = writeReceipt(outputDirectory, "doctor", doctor);
  const qualification = invokeCli(cli, ["qualify"], {
    cwd: projectDirectory,
    env: offlineEnvironment,
  });
  const offlineReceipt = writeReceipt(
    outputDirectory,
    "qualify-offline",
    qualification,
  );
  const offlineResult = qualification.receipt.result ?? {};
  const offlineEvidence = typeof offlineResult.runIdentity === "string"
    ? copyQualificationEvidence(
        homeDirectory,
        outputDirectory,
        "offline",
        null,
        offlineResult.runIdentity,
      )
    : null;

  const liveProviders = [];
  if (allowLive) {
    copyGrokAuthentication(process.env.HOME ?? "", homeDirectory);
    for (const providerId of providerIds) {
      const enable = invokeCli(
        cli,
        ["provider", "enable", providerId],
        {
          cwd: projectDirectory,
          env: offlineEnvironment,
        },
      );
      const enableReceipt = writeReceipt(
        outputDirectory,
        `provider-${providerId}-enable`,
        enable,
      );
      const qualified = invokeCli(
        cli,
        ["provider", "qualify", providerId, "--allow-live"],
        {
          cwd: projectDirectory,
          env: baseEnvironment,
          timeout: 180_000,
        },
      );
      const receipt = writeReceipt(
        outputDirectory,
        `provider-${providerId}-qualify`,
        qualified,
      );
      const terminalState =
        qualified.receipt.result?.qualification?.terminalState ??
        "failed";
      const runIdentity =
        qualified.receipt.result?.qualification?.runIdentity ?? null;
      const evidence = runIdentity
        ? copyQualificationEvidence(
            homeDirectory,
            outputDirectory,
            "live",
            providerId,
            runIdentity,
          )
        : null;
      liveProviders.push({
        id: providerId,
        terminalState,
        receipt,
        enableReceipt,
        disableReceipt: null,
        runIdentity,
        evidence,
      });
      if (terminalState !== "passed") {
        const disabled = invokeCli(
          cli,
          ["provider", "disable", providerId],
          {
            cwd: projectDirectory,
            env: offlineEnvironment,
          },
        );
        liveProviders.at(-1).disableReceipt = writeReceipt(
          outputDirectory,
          `provider-${providerId}-disable`,
          disabled,
        );
      }
    }
    const finalList = invokeCli(cli, ["provider", "list"], {
      cwd: projectDirectory,
      env: offlineEnvironment,
    });
    const finalListReceipt = writeReceipt(
      outputDirectory,
      "provider-final-list",
      finalList,
    );
    for (const provider of liveProviders) {
      const finalState = finalList.receipt.result?.providers?.find(
        ({ id }) => id === provider.id,
      );
      provider.finalState = finalState
        ? {
            disabled: finalState.disabled,
            qualified: finalState.qualified,
            blocked: finalState.blocked,
          }
        : null;
      provider.finalListReceipt = finalListReceipt;
    }
  } else {
    liveProviders.push(
      ...providerIds.map((id) => ({
        id,
        terminalState: "not-run",
        receipt: null,
        enableReceipt: null,
        disableReceipt: null,
        runIdentity: null,
        evidence: null,
        finalState: null,
        finalListReceipt: null,
      })),
    );
  }

  const verification =
    typeof offlineResult.runIdentity === "string" &&
      typeof offlineResult.evidence?.anchor === "string"
      ? invokeCli(
          cli,
          [
            "qualify",
            "verify",
            offlineResult.runIdentity,
            offlineResult.evidence.anchor,
          ],
          {
            cwd: projectDirectory,
            env: offlineEnvironment,
          },
        )
      : null;
  const verificationReceipt = verification
    ? writeReceipt(
        outputDirectory,
        "qualify-offline-verify",
        verification,
      )
    : null;
  const uninstall = invokeCli(cli, ["uninstall"], {
    cwd: projectDirectory,
    env: offlineEnvironment,
  });
  const uninstallReceipt = writeReceipt(
    outputDirectory,
    "uninstall",
    uninstall,
  );
  const exactProjectRestoration =
    JSON.stringify(snapshotFiles(projectDirectory)) ===
      JSON.stringify(before);

  const conflictDirectory = join(homeDirectory, "conflict-project");
  mkdirSync(conflictDirectory);
  const conflictGit = run(
    "/usr/bin/git",
    ["init", "-b", "main"],
    {
      cwd: conflictDirectory,
      env: offlineEnvironment,
    },
  );
  if (conflictGit.status !== 0) {
    throw new Error("The conflict fixture Git repository could not be created.");
  }
  const conflictInit = invokeCli(cli, ["init"], {
    cwd: conflictDirectory,
    env: offlineEnvironment,
  });
  writeReceipt(
    outputDirectory,
    "conflict-init",
    conflictInit,
  );
  const changedAsset = join(
    conflictDirectory,
    ".agents",
    "skills",
    "implement",
    "SKILL.md",
  );
  writeFileSync(
    changedAsset,
    Buffer.concat([
      readFileSync(changedAsset),
      Buffer.from("\nUser-owned release conflict marker.\n"),
    ]),
  );
  const changedBytes = readFileSync(changedAsset);
  const conflictUninstall = invokeCli(cli, ["uninstall"], {
    cwd: conflictDirectory,
    env: offlineEnvironment,
  });
  writeReceipt(
    outputDirectory,
    "conflict-uninstall",
    conflictUninstall,
  );
  const conflictPreservedUserChange =
    conflictUninstall.receipt.status === "blocked" &&
    readFileSync(changedAsset).equals(changedBytes);

  const lifecyclePassed =
    init.receipt.status === "ok" &&
    initAgain.receipt.status === "ok" &&
    initAgain.receipt.changed === false &&
    doctor.receipt.status === "ok" &&
    qualification.receipt.status === "ok" &&
    offlineResult.terminalState === "release-passed" &&
    offlineResult.counts?.failed === 0 &&
    verification?.receipt.status === "ok" &&
    uninstall.receipt.status === "ok" &&
    exactProjectRestoration &&
    conflictPreservedUserChange;
  const liveStatus = allowLive
    ? liveProviders.every(
        ({ terminalState, finalState }) =>
          terminalState === "passed" &&
          finalState?.qualified === true &&
          finalState.disabled === false &&
          finalState.blocked === false,
      )
      ? "passed"
      : "partial"
    : "not-run";
  const coreUnaffected =
    verification?.receipt.status === "ok" &&
    offlineResult.terminalState === "release-passed";
  const failureIsolationPassed =
    liveStatus === "partial"
      ? coreUnaffected &&
        liveProviders.every(({ terminalState, finalState }) =>
          terminalState === "passed"
            ? finalState?.qualified === true &&
              finalState.disabled === false &&
              finalState.blocked === false
            : finalState?.qualified === false &&
              finalState.disabled === true &&
              finalState.blocked === true,
        )
      : null;
  return {
    lifecycle: {
      status: lifecyclePassed ? "passed" : "failed",
      init: {
        ...receiptSummary(init),
        receipt: initReceipt,
      },
      idempotentInit:
        initAgain.receipt.status === "ok" &&
        initAgain.receipt.changed === false,
      doctor: {
        ...receiptSummary(doctor),
        receipt: doctorReceipt,
      },
      offlineQualification: {
        ...receiptSummary(qualification),
        terminalState: offlineResult.terminalState ?? null,
        counts: offlineResult.counts ?? null,
        runIdentity: offlineResult.runIdentity ?? null,
        evidenceAnchor: offlineResult.evidence?.anchor ?? null,
        receipt: offlineReceipt,
        evidence: offlineEvidence,
      },
      evidenceVerified: verification?.receipt.status === "ok",
      verificationReceipt,
      uninstall: {
        ...receiptSummary(uninstall),
        receipt: uninstallReceipt,
      },
      exactProjectRestoration,
      conflictPreservedUserChange,
    },
    liveEvidence: {
      status: liveStatus,
      providers: liveProviders,
      coreUnaffected,
      failureIsolationPassed,
    },
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      accept: "application/json",
      "user-agent": `${packageMetadata.name}/${packageMetadata.version}`,
    },
  });
  const body = await response.text();
  return {
    status: response.status,
    body: body === "" ? null : JSON.parse(body),
  };
}

async function checkNames() {
  const packageName = encodeURIComponent(packageMetadata.name);
  let npm;
  try {
    const response = await fetchJson(
      `https://registry.npmjs.org/${packageName}`,
    );
    npm = evaluateNpmRegistryPackage(
      response,
      packageMetadata,
    );
  } catch {
    npm = {
      checked: false,
      packageExists: null,
      targetVersionAvailable: null,
      httpStatus: null,
      latest: null,
      existingVersions: [],
      maintainers: [],
    };
  }
  let github;
  try {
    const query = encodeURIComponent(
      `${packageMetadata.name} in:name`,
    );
    const response = await fetchJson(
      `https://api.github.com/search/repositories?q=${query}&per_page=100`,
    );
    const exactMatches = (response.body?.items ?? [])
      .filter(({ name }) => name === packageMetadata.name)
      .map(({ full_name: fullName, html_url: url }) => ({
        fullName,
        url,
      }));
    github = {
      checked: response.status === 200,
      exactPublicMatches: exactMatches,
      availabilityScope:
        "Repository names are owner-scoped; select the target owner before creation.",
    };
  } catch {
    github = {
      checked: false,
      exactPublicMatches: [],
      availabilityScope:
        "Repository names are owner-scoped; select the target owner before creation.",
    };
  }
  return {
    status:
      npm.checked && github.checked ? "checked" : "incomplete",
    npm,
    github,
  };
}

function markdownReport(report) {
  const liveLabel =
    report.liveEvidence.status === "passed"
      ? "PASSED"
      : report.liveEvidence.status === "not-run"
        ? "NOT RUN"
        : "PARTIAL / PROVIDERS BLOCKED";
  const offlineCounts =
    report.lifecycle.offlineQualification.counts ??
      { passed: 0, total: 0 };
  return [
    `# Ground Control for Codex v${report.version} release candidate`,
    "",
    `Overall gate: **${report.status.toUpperCase()}**`,
    "",
    `- Package SHA-256: \`${report.package.sha256}\``,
    `- Reproducible pack: **${report.package.reproducible ? "YES" : "NO"}**`,
    `- Package scan: **${report.package.scan.status.toUpperCase()}**`,
    `- Offline evidence: **${report.lifecycle.status === "passed" ? `PASSED (${offlineCounts.passed}/${offlineCounts.total})` : "FAILED"}**`,
    `- Live provider evidence: **${liveLabel}**`,
    `- Name checks: **${report.nameChecks.status.toUpperCase()}**`,
    "",
    "## Live provider receipts",
    "",
    ...report.liveEvidence.providers.map(
      ({ id, terminalState, receipt }) =>
        `- ${id}: ${terminalState}` +
        (receipt ? ` (\`${receipt}\`)` : ""),
    ),
    "",
    "## Release blockers",
    "",
    ...(report.blockingLimitations.length === 0
      ? ["- none"]
      : report.blockingLimitations.map(
          (limitation) => `- ${limitation}`,
        )),
    "",
    "## Recovery",
    "",
    "Project-local uninstall removes only unchanged Ground Control-owned assets and restores the exact pre-install instructions. If a managed asset changed, uninstall fails closed and preserves the user change for manual resolution. Explicit global recovery requires `uninstall --global --confirm-global`; there is no force path.",
    "",
    "## Remaining limitations",
    "",
    ...report.limitations.map((limitation) => `- ${limitation}`),
    "",
    "No npm publish, GitHub remote, push, or release was created.",
    "",
  ].join("\n");
}

function reportLimitations(
  options,
  repositoryChecks,
  packageReport,
  lifecycle,
  liveEvidence,
  nameChecks,
) {
  const limitations = [];
  if (process.platform !== "darwin") {
    limitations.push("unsupported-release-platform");
  }
  if (Number(process.versions.node.split(".")[0]) < 22) {
    limitations.push("unsupported-release-node-version");
  }
  if (repositoryChecks.status !== "passed") {
    limitations.push(
      options.skipRepositoryChecks
        ? "repository-checks-not-run"
        : "repository-checks-failed",
    );
  }
  if (!packageReport.reproducible) {
    limitations.push("npm-pack-not-reproducible");
  }
  if (
    packageReport.scan.status !== "passed" ||
    packageReport.licenses.status !== "passed"
  ) {
    limitations.push("package-audit-failed");
  }
  if (lifecycle.status !== "passed") {
    limitations.push("packed-cli-lifecycle-failed");
  }
  if (liveEvidence.status !== "passed") {
    limitations.push(
      liveEvidence.status === "not-run"
        ? "live-provider-campaigns-not-run"
        : liveEvidence.failureIsolationPassed
          ? "one-or-more-live-provider-campaigns-failed"
          : "live-provider-failure-isolation-failed",
    );
  }
  if (nameChecks.status !== "checked") {
    limitations.push(
      options.skipNameChecks
        ? "name-availability-checks-not-run"
        : "name-availability-checks-incomplete",
    );
  } else if (
    nameChecks.npm.targetVersionAvailable !== true
  ) {
    limitations.push(
      "npm-package-version-already-published",
    );
  }
  limitations.push(
    "native-agent-execution-blocked",
    "external-workspace-write-blocked",
  );
  return limitations;
}

function releaseBlockingLimitations(limitations) {
  return limitations.filter(
    (limitation) => !nonBlockingLimitations.has(limitation),
  );
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (existsSync(options.output)) {
    usage("The output directory already exists; release runs are non-overwriting.");
  }
  mkdirSync(options.output, { recursive: true, mode: 0o700 });
  mkdirSync(join(options.output, "receipts"), { mode: 0o700 });
  const sandbox = mkdtempSync(
    join(tmpdir(), "codex-ground-control-release-"),
  );

  try {
    const source = {
      commit: gitValue(["rev-parse", "HEAD"]),
      branch: gitValue(["branch", "--show-current"]),
      clean: gitValue(["status", "--porcelain"], "") === "",
      remoteCount: gitValue(["remote"], "")
        .split("\n")
        .filter(Boolean).length,
    };
    const repositoryChecks = options.skipRepositoryChecks
      ? {
          status: "not-run",
          commands: repositoryCommands.map(
            ([command, args]) => [command, ...args].join(" "),
          ),
        }
      : (() => {
          const results = repositoryCommands.map(([command, args]) =>
            commandStatus(command, args)
          );
          const clean = gitValue(["status", "--porcelain"], "") === "";
          return {
            status:
              results.every(({ status }) => status === "passed") &&
                clean
                ? "passed"
                : "failed",
            commands: results,
            cleanWorktree: clean,
          };
        })();
    const packHome = join(sandbox, "pack-home");
    const npmCache = join(sandbox, "npm-cache");
    mkdirSync(packHome);
    const npmEnvironment = isolatedNpmEnvironment(
      packHome,
      npmCache,
    );
    const firstPack = pack(
      repositoryRoot,
      join(sandbox, "pack-a"),
      npmEnvironment,
    );
    const secondPack = pack(
      repositoryRoot,
      join(sandbox, "pack-b"),
      npmEnvironment,
    );
    const candidateTarball = join(
      options.output,
      firstPack.metadata.filename,
    );
    copyFileSync(firstPack.tarball, candidateTarball);
    const installDirectory = join(sandbox, "install");
    const packageRoot = installTarball(
      candidateTarball,
      installDirectory,
      npmEnvironment,
    );
    const packageScan = scanPackage(
      packageRoot,
      firstPack.metadata.files,
      firstPack.metadata.bundled,
    );
    const licenses = auditLicenses(
      packageRoot,
      firstPack.metadata.files,
      firstPack.metadata.bundled,
    );
    const packageReport = {
      filename: firstPack.metadata.filename,
      bytes: statSync(candidateTarball).size,
      sha256: firstPack.hash,
      reproducible:
        firstPack.hash === secondPack.hash &&
        firstPack.metadata.filename === secondPack.metadata.filename,
      packHashes: [firstPack.hash, secondPack.hash],
      fileCount: firstPack.metadata.files.length,
      scan: packageScan,
      licenses,
    };
    const networkTrap = join(sandbox, "deny-network.mjs");
    writeFileSync(
      networkTrap,
      [
        'import http from "node:http";',
        'import https from "node:https";',
        'import net from "node:net";',
        'const denied = () => { throw new Error("network access denied by release campaign"); };',
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
    const lifecycleHome = join(sandbox, "lifecycle-home");
    mkdirSync(lifecycleHome);
    const cli = join(
      installDirectory,
      "node_modules",
      ".bin",
      "codex-ground-control",
    );
    const { lifecycle, liveEvidence } = runLifecycle(
      cli,
      lifecycleHome,
      options.output,
      networkTrap,
      options.allowLive,
    );
    const nameChecks = options.skipNameChecks
      ? { status: "not-run" }
      : await checkNames();
    const limitations = reportLimitations(
      options,
      repositoryChecks,
      packageReport,
      lifecycle,
      liveEvidence,
      nameChecks,
    );
    const blockingLimitations =
      releaseBlockingLimitations(limitations);
    const status =
      blockingLimitations.length === 0 ? "ready" : "blocked";
    const report = {
      schemaVersion: "1",
      product: packageMetadata.name,
      version: packageMetadata.version,
      candidateId: `${packageMetadata.version}-${randomUUID()}`,
      createdAt: new Date().toISOString(),
      status,
      source,
      environment: {
        platform: process.platform,
        architecture: process.arch,
        node: process.version,
      },
      publication: {
        npm: "not-published",
        github: "not-created",
        pushed: false,
        releaseCreated: false,
      },
      repositoryChecks,
      package: packageReport,
      lifecycle,
      liveEvidence,
      nameChecks,
      evidenceClasses: {
        offline: "current-release-candidate",
        live: !options.allowLive
          ? "not-run"
          : liveEvidence.status === "passed"
            ? "current-release-candidate"
            : "current-release-candidate-partial",
        historicalPrivate: "not-imported",
      },
      limitations,
      blockingLimitations,
      recovery: {
        project:
          "Run codex-ground-control uninstall. User-modified managed assets are preserved and reported as conflicts.",
        global:
          "Run codex-ground-control uninstall --global --confirm-global. Missing or modified recovery assets fail closed; no force path exists.",
      },
    };
    writeJson(
      join(options.output, "release-report.json"),
      report,
    );
    writeFileSync(
      join(options.output, "RELEASE_CANDIDATE.md"),
      markdownReport(report),
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      `${JSON.stringify({
        schemaVersion: "1",
        status,
        version: packageMetadata.version,
        report: "release-report.json",
        markdownReport: "RELEASE_CANDIDATE.md",
        tarball: firstPack.metadata.filename,
      })}\n`,
    );
    process.exitCode = status === "ready" ? 0 : 2;
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

await main();

import { randomUUID } from "node:crypto";
import { isAbsolute, parse } from "node:path";
import {
  ancestorDirectories,
  atomicWrite,
  collectMissingDirectories,
  inspectDirectory,
  inspectFile,
  optionalMetadata,
  removeCreatedDirectories,
  removeVerifiedFile,
  sha256,
  validateRelativePath,
} from "./safe-files.js";
import { ManagedWorkflowError } from "./workflow-error.js";
import {
  packagedManagedBlock,
  packagedRelease,
  packagedWorkflowAssets,
} from "./workflow-assets.js";

const START_MARKER = "<!-- codex-ground-control:managed:start -->";
const END_MARKER = "<!-- codex-ground-control:managed:end -->";
const GLOBAL_STATE_DIRECTORY = ".codex-ground-control/global";
const GLOBAL_MANIFEST_PATH = `${GLOBAL_STATE_DIRECTORY}/manifest.json`;
const GLOBAL_TRANSACTION_PATH =
  `${GLOBAL_STATE_DIRECTORY}/transaction.json`;
const GLOBAL_AGENTS_PATH = ".codex/AGENTS.md";
const GLOBAL_BACKUPS_DIRECTORY = ".codex-ground-control/backups";
const GLOBAL_BACKUP_PREVIEW =
  `${GLOBAL_BACKUPS_DIRECTORY}/<backup-id>/snapshot.json`;

function conflict(message) {
  throw new ManagedWorkflowError("INSTALLATION_CONFLICT", message);
}

function unsafeRoot(message) {
  throw new ManagedWorkflowError("UNSAFE_GLOBAL_ROOT", message);
}

function invokeFault(options, checkpoint, details) {
  options.faultInjector?.(checkpoint, details);
}

function validateHomeRoot(homeRoot) {
  if (
    typeof homeRoot !== "string" ||
    !isAbsolute(homeRoot) ||
    homeRoot === parse(homeRoot).root
  ) {
    unsafeRoot("Global installation requires a bounded absolute HOME.");
  }
  const metadata = optionalMetadata(homeRoot);
  if (
    !metadata ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  ) {
    unsafeRoot(
      "Global installation requires HOME to be a real directory.",
    );
  }
  return metadata;
}

function globalAssetPath(path) {
  if (path.startsWith(".agents/skills/")) {
    return path;
  }
  if (path.startsWith(".codex-ground-control/")) {
    return path.replace(
      ".codex-ground-control/",
      `${GLOBAL_STATE_DIRECTORY}/`,
    );
  }
  conflict(`Packaged asset has no global target: ${path}`);
}

function displayPath(path) {
  return `~/${path}`;
}

function countOccurrences(value, search) {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = value.indexOf(search, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + search.length;
  }
}

function installedAgentsContents(original, block) {
  if (original.length === 0) {
    return Buffer.from(block);
  }
  const separator = original.toString("utf8").endsWith("\n") ? "\n" : "\n\n";
  return Buffer.concat([original, Buffer.from(separator), block]);
}

function managedBlockIsIntact(contents, block) {
  const text = contents.toString("utf8");
  const blockText = block.toString("utf8");
  return (
    countOccurrences(text, START_MARKER) === 1 &&
    countOccurrences(text, END_MARKER) === 1 &&
    countOccurrences(text, blockText) === 1
  );
}

function releaseSummary() {
  const release = packagedRelease();
  return {
    repository: release.repository,
    revision: release.revision,
    contentSha256: release.contentSha256,
    license: release.license,
  };
}

function mapGlobalAssets(homeRoot) {
  return packagedWorkflowAssets().map((asset) => {
    const path = globalAssetPath(asset.path);
    const current = inspectFile(homeRoot, path);
    if (current.state === "file" && current.sha256 !== asset.sha256) {
      conflict(`Existing global workflow asset differs: ~/${path}`);
    }
    return {
      ...asset,
      path,
      current,
      record: {
        path,
        ownership: current.state === "absent" ? "created" : "preexisting",
        preInstallSha256:
          current.state === "absent" ? null : current.sha256,
        installedSha256: asset.sha256,
        backup: null,
        source: asset.source,
      },
    };
  });
}

function planNewGlobalInstallation(homeRoot) {
  validateHomeRoot(homeRoot);
  const assets = mapGlobalAssets(homeRoot);
  const block = packagedManagedBlock();
  const agents = inspectFile(homeRoot, GLOBAL_AGENTS_PATH);
  if (agents.state === "file") {
    const text = agents.contents.toString("utf8");
    if (
      countOccurrences(text, START_MARKER) > 0 ||
      countOccurrences(text, END_MARKER) > 0
    ) {
      conflict(
        "Global AGENTS.md already contains Ground Control managed markers.",
      );
    }
  }
  const installedAgents = installedAgentsContents(
    agents.state === "file" ? agents.contents : Buffer.alloc(0),
    block,
  );
  const plan = {
    add: [
      displayPath(GLOBAL_MANIFEST_PATH),
      displayPath(GLOBAL_BACKUP_PREVIEW),
    ],
    update: [],
    unchanged: [],
  };
  for (const asset of assets) {
    plan[
      asset.current.state === "absent" ? "add" : "unchanged"
    ].push(displayPath(asset.path));
  }
  plan[agents.state === "absent" ? "add" : "update"].push(
    displayPath(GLOBAL_AGENTS_PATH),
  );
  for (const paths of Object.values(plan)) {
    paths.sort();
  }

  return {
    agents,
    assets,
    block,
    installedAgents,
    plan,
  };
}

function backupPaths(backupId, hasInstructions) {
  const directory = `${GLOBAL_BACKUPS_DIRECTORY}/${backupId}`;
  return {
    directory,
    descriptor: `${directory}/snapshot.json`,
    instructions: hasInstructions ? `${directory}/AGENTS.md` : null,
  };
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function prepareGlobalBackup(
  homeRoot,
  backupId,
  planned,
  createdDirectories,
  options,
) {
  const paths = backupPaths(
    backupId,
    planned.agents.state === "file",
  );
  const instructions = planned.agents.state === "file"
    ? {
        state: "file",
        sha256: planned.agents.sha256,
        content: paths.instructions,
      }
    : {
        state: "absent",
        sha256: null,
        content: null,
      };
  if (paths.instructions) {
    atomicWrite(
      homeRoot,
      paths.instructions,
      planned.agents.contents,
      { state: "absent" },
      createdDirectories,
      options,
    );
  }
  const descriptor = {
    schemaVersion: "1",
    product: "codex-ground-control",
    scope: "global",
    backupId,
    instructions,
  };
  atomicWrite(
    homeRoot,
    paths.descriptor,
    jsonBytes(descriptor),
    { state: "absent" },
    createdDirectories,
    options,
  );
  return { descriptor, paths };
}

function createGlobalManifest(
  backupId,
  backup,
  planned,
  createdDirectories,
) {
  const release = packagedRelease();
  return {
    schemaVersion: "3",
    product: "codex-ground-control",
    version: "0.1.0",
    scope: "global",
    releaseLock: {
      path: `${GLOBAL_STATE_DIRECTORY}/release-lock.json`,
      sha256: release.lockSha256,
      ...releaseSummary(),
    },
    backup: {
      id: backupId,
      descriptor: backup.paths.descriptor,
      sha256: sha256(jsonBytes(backup.descriptor)),
      preparedBeforeMutation: true,
    },
    managedBlock: {
      path: GLOBAL_AGENTS_PATH,
      ownership: "managed-block",
      preInstallSha256:
        planned.agents.state === "file" ? planned.agents.sha256 : null,
      installedSha256: sha256(planned.installedAgents),
      blockSha256: sha256(planned.block),
      backup: backup.paths.instructions
        ? {
            path: backup.paths.instructions,
            sha256: planned.agents.sha256,
          }
        : null,
    },
    createdDirectories,
    assets: planned.assets.map(({ record }) => record),
  };
}

function parseJsonFile(file, description) {
  try {
    return JSON.parse(file.contents.toString("utf8"));
  } catch {
    conflict(`${description} is not valid JSON.`);
  }
}

function readGlobalInstallation(homeRoot) {
  validateHomeRoot(homeRoot);
  const transactionFile = inspectFile(
    homeRoot,
    GLOBAL_TRANSACTION_PATH,
  );
  if (transactionFile.state === "file") {
    const transaction = parseJsonFile(
      transactionFile,
      "The global installation transaction",
    );
    if (
      transaction.schemaVersion !== "1" ||
      transaction.product !== "codex-ground-control" ||
      transaction.scope !== "global" ||
      transaction.operation !== "install" ||
      typeof transaction.backupId !== "string" ||
      !transaction.manifest
    ) {
      conflict("The global installation transaction has an unsupported shape.");
    }
    return {
      state: "partial",
      transaction,
      transactionFile,
    };
  }

  const manifestFile = inspectFile(homeRoot, GLOBAL_MANIFEST_PATH);
  if (manifestFile.state === "absent") {
    return { state: "absent" };
  }
  const manifest = parseJsonFile(
    manifestFile,
    "The global installation manifest",
  );
  if (
    manifest.schemaVersion !== "3" ||
    manifest.product !== "codex-ground-control" ||
    manifest.version !== "0.1.0" ||
    manifest.scope !== "global" ||
    !Array.isArray(manifest.assets) ||
    !Array.isArray(manifest.createdDirectories) ||
    !manifest.managedBlock ||
    !manifest.releaseLock ||
    !manifest.backup
  ) {
    conflict("The global installation manifest has an unsupported shape.");
  }
  return { state: "installed", manifest };
}

function manifestHasSupportedShape(manifest) {
  return (
    manifest?.schemaVersion === "3" &&
    manifest.product === "codex-ground-control" &&
    manifest.version === "0.1.0" &&
    manifest.scope === "global" &&
    Array.isArray(manifest.assets) &&
    Array.isArray(manifest.createdDirectories) &&
    manifest.managedBlock &&
    manifest.releaseLock &&
    manifest.backup
  );
}

function validateGlobalBackup(homeRoot, manifest) {
  const expectedDescriptor =
    `${GLOBAL_BACKUPS_DIRECTORY}/${manifest.backup.id}/snapshot.json`;
  if (
    typeof manifest.backup.id !== "string" ||
    manifest.backup.descriptor !== expectedDescriptor ||
    manifest.backup.preparedBeforeMutation !== true ||
    typeof manifest.backup.sha256 !== "string"
  ) {
    conflict("The global backup association has drifted.");
  }
  const descriptorFile = inspectFile(
    homeRoot,
    manifest.backup.descriptor,
  );
  if (
    descriptorFile.state !== "file" ||
    descriptorFile.sha256 !== manifest.backup.sha256
  ) {
    conflict("The global recovery backup is missing or modified.");
  }
  const descriptor = parseJsonFile(
    descriptorFile,
    "The global backup descriptor",
  );
  if (
    descriptor.schemaVersion !== "1" ||
    descriptor.product !== "codex-ground-control" ||
    descriptor.scope !== "global" ||
    descriptor.backupId !== manifest.backup.id ||
    !descriptor.instructions
  ) {
    conflict("The global backup descriptor has an unsupported shape.");
  }
  return descriptor;
}

function validateGlobalAssetRecords(
  homeRoot,
  manifest,
  options,
) {
  const expectedAssets = packagedWorkflowAssets().map((asset) => ({
    ...asset,
    path: globalAssetPath(asset.path),
  }));
  const expectedByPath = new Map(
    expectedAssets.map((asset) => [asset.path, asset]),
  );
  const manifestPaths = manifest.assets.map(({ path }) => path).sort();
  const expectedPaths = expectedAssets.map(({ path }) => path).sort();
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expectedPaths)) {
    conflict(`${options.label} asset inventory has drifted.`);
  }

  for (const record of manifest.assets) {
    const expected = expectedByPath.get(record.path);
    if (
      !expected ||
      !["created", "preexisting"].includes(record.ownership) ||
      record.installedSha256 !== expected.sha256 ||
      JSON.stringify(record.source) !== JSON.stringify(expected.source) ||
      record.backup !== null ||
      (record.ownership === "created" &&
        record.preInstallSha256 !== null) ||
      (record.ownership === "preexisting" &&
        record.preInstallSha256 !== expected.sha256)
    ) {
      conflict(`${options.label} record has drifted: ~/${record.path}`);
    }
    const current = inspectFile(homeRoot, record.path);
    if (options.partial) {
      if (
        record.ownership === "created" &&
        current.state === "file" &&
        current.sha256 !== record.installedSha256
      ) {
        conflict(`A partial global asset has user changes: ~/${record.path}`);
      }
      continue;
    }
    if (
      current.state !== "file" ||
      current.sha256 !== record.installedSha256
    ) {
      if (
        options.allowPreexistingDrift &&
        record.ownership === "preexisting"
      ) {
        continue;
      }
      conflict(`A global workflow asset has been modified: ~/${record.path}`);
    }
  }
}

function validateGlobalReleaseLock(manifest, label) {
  const release = packagedRelease();
  if (
    manifest.releaseLock.path !==
      `${GLOBAL_STATE_DIRECTORY}/release-lock.json` ||
    manifest.releaseLock.sha256 !== release.lockSha256 ||
    manifest.releaseLock.repository !== release.repository ||
    manifest.releaseLock.revision !== release.revision ||
    manifest.releaseLock.contentSha256 !== release.contentSha256 ||
    manifest.releaseLock.license !== release.license
  ) {
    conflict(`${label} release-lock record has drifted.`);
  }
}

function readOriginalGlobalInstructions(
  homeRoot,
  manifest,
  descriptor,
  label,
) {
  let originalAgents = Buffer.alloc(0);
  if (manifest.managedBlock.backup) {
    if (
      descriptor.instructions.state !== "file" ||
      descriptor.instructions.content !==
        manifest.managedBlock.backup.path ||
      descriptor.instructions.sha256 !==
        manifest.managedBlock.preInstallSha256 ||
      manifest.managedBlock.backup.sha256 !==
        manifest.managedBlock.preInstallSha256
    ) {
      conflict(`${label} instructions backup association has drifted.`);
    }
    const backupFile = inspectFile(
      homeRoot,
      manifest.managedBlock.backup.path,
    );
    if (
      backupFile.state !== "file" ||
      backupFile.sha256 !== manifest.managedBlock.backup.sha256
    ) {
      conflict(`${label} instructions backup is missing or modified.`);
    }
    originalAgents = backupFile.contents;
  } else if (
    manifest.managedBlock.preInstallSha256 !== null ||
    descriptor.instructions.state !== "absent" ||
    descriptor.instructions.sha256 !== null ||
    descriptor.instructions.content !== null
  ) {
    conflict(`${label} instructions absence backup has drifted.`);
  }
  return originalAgents;
}

function validateGlobalCreatedDirectories(
  homeRoot,
  manifest,
  options,
) {
  const createdDirectories = new Set(manifest.createdDirectories);
  const ownedPaths = [
    GLOBAL_MANIFEST_PATH,
    manifest.backup.descriptor,
    ...(manifest.managedBlock.backup
      ? [manifest.managedBlock.backup.path]
      : []),
    ...(manifest.managedBlock.preInstallSha256 === null
      ? [GLOBAL_AGENTS_PATH]
      : []),
    ...manifest.assets
      .filter(({ ownership }) => ownership === "created")
      .map(({ path }) => path),
  ];
  const allowedDirectories = ancestorDirectories(ownedPaths);
  if (createdDirectories.size !== manifest.createdDirectories.length) {
    conflict(`${options.label} created-directory inventory has drifted.`);
  }
  for (const directory of createdDirectories) {
    validateRelativePath(directory);
    if (!allowedDirectories.has(directory)) {
      conflict(`${options.label} created directory is unsafe: ~/${directory}`);
    }
    const current = inspectDirectory(homeRoot, directory);
    if (!options.allowAbsent && current.state !== "directory") {
      conflict(`${options.label} created directory is missing: ~/${directory}`);
    }
  }
}

function validateGlobalManifestFoundation(
  homeRoot,
  manifest,
  options,
) {
  if (!manifestHasSupportedShape(manifest)) {
    conflict(`${options.label} manifest has an unsupported shape.`);
  }
  validateGlobalAssetRecords(homeRoot, manifest, options);
  validateGlobalReleaseLock(manifest, options.label);
  const descriptor = validateGlobalBackup(homeRoot, manifest);
  const block = packagedManagedBlock();
  const originalAgents = readOriginalGlobalInstructions(
    homeRoot,
    manifest,
    descriptor,
    options.label,
  );
  const installedAgents = installedAgentsContents(
    originalAgents,
    block,
  );
  if (
    manifest.managedBlock.path !== GLOBAL_AGENTS_PATH ||
    manifest.managedBlock.ownership !== "managed-block" ||
    manifest.managedBlock.blockSha256 !== sha256(block) ||
    manifest.managedBlock.installedSha256 !== sha256(installedAgents)
  ) {
    conflict(`${options.label} managed block record has drifted.`);
  }
  validateGlobalCreatedDirectories(homeRoot, manifest, options);
  return {
    block,
    descriptor,
    installedAgents,
    manifest,
    originalAgents,
  };
}

function validateGlobalInstallation(homeRoot, installation, options = {}) {
  const validated = validateGlobalManifestFoundation(
    homeRoot,
    installation.manifest,
    {
      allowAbsent: false,
      allowPreexistingDrift: options.allowPreexistingDrift,
      label: "The global manifest",
      partial: false,
    },
  );
  const agents = inspectFile(homeRoot, GLOBAL_AGENTS_PATH);
  if (
    agents.state !== "file" ||
    !managedBlockIsIntact(agents.contents, validated.block)
  ) {
    conflict("The global Ground Control managed block has been modified.");
  }
  return { ...validated, agents };
}

function validatePartialGlobalInstallation(homeRoot, installation) {
  const manifest = installation.transaction.manifest;
  if (
    installation.transaction.backupId !== manifest?.backup?.id
  ) {
    conflict("The partial global transaction backup association has drifted.");
  }
  const validated = validateGlobalManifestFoundation(
    homeRoot,
    manifest,
    {
      allowAbsent: true,
      allowPreexistingDrift: true,
      label: "The partial global",
      partial: true,
    },
  );
  const agents = inspectFile(homeRoot, GLOBAL_AGENTS_PATH);
  if (agents.state === "file") {
    const isOriginal =
      manifest.managedBlock.preInstallSha256 !== null &&
      agents.sha256 === manifest.managedBlock.preInstallSha256;
    if (
      !isOriginal &&
      !managedBlockIsIntact(agents.contents, validated.block)
    ) {
      conflict("Global AGENTS.md changed during interrupted installation.");
    }
  } else if (manifest.managedBlock.preInstallSha256 !== null) {
    conflict("Global AGENTS.md is missing during interrupted installation.");
  }

  const finalManifestFile = inspectFile(
    homeRoot,
    GLOBAL_MANIFEST_PATH,
  );
  const expectedManifestSha256 = sha256(jsonBytes(manifest));
  if (
    finalManifestFile.state === "file" &&
    finalManifestFile.sha256 !== expectedManifestSha256
  ) {
    conflict("The partial final manifest has drifted.");
  }

  return {
    ...validated,
    agents,
    finalManifestFile,
    transactionFile: installation.transactionFile,
  };
}

function installedGlobalPlan(manifest) {
  const unchanged = [
    GLOBAL_AGENTS_PATH,
    GLOBAL_MANIFEST_PATH,
    manifest.backup.descriptor,
    ...(manifest.managedBlock.backup
      ? [manifest.managedBlock.backup.path]
      : []),
    ...manifest.assets.map(({ path }) => path),
  ].map(displayPath).sort();
  return {
    add: [],
    update: [],
    unchanged,
  };
}

function globalUninstallPlan(manifest) {
  return {
    remove: [
      GLOBAL_MANIFEST_PATH,
      manifest.backup.descriptor,
      ...(manifest.managedBlock.backup
        ? [manifest.managedBlock.backup.path]
        : []),
      ...manifest.assets
        .filter(({ ownership }) => ownership === "created")
        .map(({ path }) => path),
      ...(manifest.managedBlock.preInstallSha256 === null
        ? [GLOBAL_AGENTS_PATH]
        : []),
    ].map(displayPath).sort(),
    restore:
      manifest.managedBlock.preInstallSha256 === null
        ? []
        : [displayPath(GLOBAL_AGENTS_PATH)],
    preserve: [
      "~/.codex-ground-control/evidence/**",
      ...manifest.assets
        .filter(({ ownership }) => ownership === "preexisting")
        .map(({ path }) => displayPath(path)),
    ].sort(),
  };
}

function restoreGlobalAgents(
  homeRoot,
  validated,
  createdDirectories,
  options,
) {
  const { managedBlock } = validated.manifest;
  const current = validated.agents;
  const expectedInstalled = installedAgentsContents(
    validated.originalAgents,
    validated.block,
  );
  let restored;

  if (current.sha256 === managedBlock.installedSha256) {
    restored = validated.originalAgents;
  } else {
    const addition = expectedInstalled.subarray(
      validated.originalAgents.length,
    );
    const additionOffset = current.contents.indexOf(addition);
    if (
      additionOffset === -1 ||
      current.contents.indexOf(
        addition,
        additionOffset + addition.length,
      ) !== -1
    ) {
      conflict(
        "Global AGENTS.md cannot be restored without losing user changes.",
      );
    }
    restored = Buffer.concat([
      current.contents.subarray(0, additionOffset),
      current.contents.subarray(additionOffset + addition.length),
    ]);
  }

  if (!managedBlock.backup && restored.length === 0) {
    removeVerifiedFile(
      homeRoot,
      GLOBAL_AGENTS_PATH,
      current.sha256,
      options,
    );
    return;
  }
  atomicWrite(
    homeRoot,
    GLOBAL_AGENTS_PATH,
    restored,
    { state: "file", sha256: current.sha256 },
    createdDirectories,
    options,
  );
}

function applyGlobalUninstall(homeRoot, validated, options) {
  const createdDirectories = new Set();
  const manifestFile = inspectFile(homeRoot, GLOBAL_MANIFEST_PATH);
  restoreGlobalAgents(
    homeRoot,
    validated,
    createdDirectories,
    options,
  );
  for (const record of [...validated.manifest.assets].reverse()) {
    if (record.ownership === "created") {
      removeVerifiedFile(
        homeRoot,
        record.path,
        record.installedSha256,
        options,
      );
    }
  }
  if (validated.manifest.managedBlock.backup) {
    removeVerifiedFile(
      homeRoot,
      validated.manifest.managedBlock.backup.path,
      validated.manifest.managedBlock.backup.sha256,
      options,
    );
  }
  removeVerifiedFile(
    homeRoot,
    validated.manifest.backup.descriptor,
    validated.manifest.backup.sha256,
    options,
  );
  removeVerifiedFile(
    homeRoot,
    GLOBAL_MANIFEST_PATH,
    manifestFile.sha256,
    options,
  );
  removeCreatedDirectories(
    homeRoot,
    validated.manifest.createdDirectories,
    options,
  );
}

function applyPartialGlobalRecovery(homeRoot, validated, options) {
  const createdDirectories = new Set();
  const currentAgents = validated.agents;
  const originalSha256 =
    validated.manifest.managedBlock.preInstallSha256;
  if (
    currentAgents.state === "file" &&
    currentAgents.sha256 !== originalSha256
  ) {
    restoreGlobalAgents(
      homeRoot,
      validated,
      createdDirectories,
      options,
    );
  }
  for (const record of [...validated.manifest.assets].reverse()) {
    if (record.ownership !== "created") {
      continue;
    }
    const current = inspectFile(homeRoot, record.path);
    if (current.state === "file") {
      removeVerifiedFile(
        homeRoot,
        record.path,
        record.installedSha256,
        options,
      );
    }
  }
  if (validated.finalManifestFile.state === "file") {
    removeVerifiedFile(
      homeRoot,
      GLOBAL_MANIFEST_PATH,
      validated.finalManifestFile.sha256,
      options,
    );
  }
  removeVerifiedFile(
    homeRoot,
    GLOBAL_TRANSACTION_PATH,
    validated.transactionFile.sha256,
    options,
  );
  if (validated.manifest.managedBlock.backup) {
    removeVerifiedFile(
      homeRoot,
      validated.manifest.managedBlock.backup.path,
      validated.manifest.managedBlock.backup.sha256,
      options,
    );
  }
  removeVerifiedFile(
    homeRoot,
    validated.manifest.backup.descriptor,
    validated.manifest.backup.sha256,
    options,
  );
  removeCreatedDirectories(
    homeRoot,
    validated.manifest.createdDirectories,
    options,
  );
}

function applyNewGlobalInstallation(homeRoot, planned, options) {
  const backupId = randomUUID();
  const backup = backupPaths(
    backupId,
    planned.agents.state === "file",
  );
  const managedPaths = [
    GLOBAL_MANIFEST_PATH,
    GLOBAL_TRANSACTION_PATH,
    backup.descriptor,
    ...(backup.instructions ? [backup.instructions] : []),
    GLOBAL_AGENTS_PATH,
    ...planned.assets
      .filter(({ record }) => record.ownership === "created")
      .map(({ path }) => path),
  ];
  const expectedCreatedDirectories = collectMissingDirectories(
    homeRoot,
    managedPaths,
  );
  const expectedCreatedDirectorySet = new Set(
    expectedCreatedDirectories,
  );
  const operationOptions = {
    ...options,
    expectedCreatedDirectories: expectedCreatedDirectorySet,
  };
  const createdDirectories = new Set();
  let transactionWritten = false;
  let preparedBackup;

  try {
    preparedBackup = prepareGlobalBackup(
      homeRoot,
      backupId,
      planned,
      createdDirectories,
      operationOptions,
    );
    const manifest = createGlobalManifest(
      backupId,
      preparedBackup,
      planned,
      expectedCreatedDirectories,
    );
    const transaction = {
      schemaVersion: "1",
      product: "codex-ground-control",
      scope: "global",
      operation: "install",
      backupId,
      manifest,
    };
    const transactionBytes = jsonBytes(transaction);
    atomicWrite(
      homeRoot,
      GLOBAL_TRANSACTION_PATH,
      transactionBytes,
      { state: "absent" },
      createdDirectories,
      operationOptions,
    );
    transactionWritten = true;
    invokeFault(operationOptions, "after-global-transaction", { backupId });

    for (const asset of planned.assets) {
      if (asset.record.ownership !== "created") {
        continue;
      }
      atomicWrite(
        homeRoot,
        asset.path,
        asset.contents,
        { state: "absent" },
        createdDirectories,
        operationOptions,
      );
      invokeFault(operationOptions, "after-global-asset", {
        path: asset.path,
      });
    }
    atomicWrite(
      homeRoot,
      GLOBAL_AGENTS_PATH,
      planned.installedAgents,
      planned.agents.state === "file"
        ? { state: "file", sha256: planned.agents.sha256 }
        : { state: "absent" },
      createdDirectories,
      operationOptions,
    );
    invokeFault(operationOptions, "after-global-instructions", {
      path: GLOBAL_AGENTS_PATH,
    });
    if (
      createdDirectories.size !== expectedCreatedDirectorySet.size ||
      [...createdDirectories].some(
        (directory) => !expectedCreatedDirectorySet.has(directory),
      )
    ) {
      conflict("Global created directories no longer match the preview.");
    }
    const manifestBytes = jsonBytes(manifest);
    atomicWrite(
      homeRoot,
      GLOBAL_MANIFEST_PATH,
      manifestBytes,
      { state: "absent" },
      createdDirectories,
      operationOptions,
    );
    removeVerifiedFile(
      homeRoot,
      GLOBAL_TRANSACTION_PATH,
      sha256(transactionBytes),
      operationOptions,
    );

    return { backupId, manifest };
  } catch (error) {
    if (!transactionWritten) {
      throw error;
    }
    const recovery = new ManagedWorkflowError(
      "RECOVERY_REQUIRED",
      "Global installation was interrupted; run confirmed global uninstall to restore the backup.",
    );
    recovery.result = {
      installation: "partial",
      backupId,
      plan: planned.plan,
    };
    recovery.cause = error;
    throw recovery;
  }
}

export function initializeGlobalWorkflow(homeRoot, options = {}) {
  const installation = readGlobalInstallation(homeRoot);
  if (installation.state === "partial") {
    const validated = validatePartialGlobalInstallation(
      homeRoot,
      installation,
    );
    const error = new ManagedWorkflowError(
      "RECOVERY_REQUIRED",
      "A partial global installation requires confirmed global uninstall recovery.",
    );
    error.result = {
      installation: "partial",
      backupId: installation.transaction.backupId,
      plan: globalUninstallPlan(validated.manifest),
    };
    throw error;
  }
  if (installation.state === "installed") {
    const validated = validateGlobalInstallation(
      homeRoot,
      installation,
    );
    if (options.dryRun) {
      return {
        changed: false,
        result: {
          installation: "preview",
          plan: installedGlobalPlan(validated.manifest),
        },
      };
    }
    return {
      changed: false,
      result: {
        installation: "unchanged",
        backupId: validated.manifest.backup.id,
        manifest: displayPath(GLOBAL_MANIFEST_PATH),
        plan: installedGlobalPlan(validated.manifest),
        releaseLock: {
          revision: validated.manifest.releaseLock.revision,
          license: validated.manifest.releaseLock.license,
        },
      },
    };
  }

  const planned = planNewGlobalInstallation(homeRoot);
  if (options.dryRun) {
    return {
      changed: false,
      result: {
        installation: "preview",
        plan: planned.plan,
      },
    };
  }
  if (!options.confirmed) {
    const error = new ManagedWorkflowError(
      "GLOBAL_CONFIRMATION_REQUIRED",
      "Global installation requires interactive confirmation or --confirm-global.",
    );
    error.result = {
      installation: "preview",
      plan: planned.plan,
    };
    throw error;
  }

  const applied = applyNewGlobalInstallation(
    homeRoot,
    planned,
    options,
  );
  return {
    changed: true,
    result: {
      installation: "created",
      backupId: applied.backupId,
      manifest: displayPath(GLOBAL_MANIFEST_PATH),
      plan: planned.plan,
      releaseLock: {
        revision: applied.manifest.releaseLock.revision,
        license: applied.manifest.releaseLock.license,
      },
    },
  };
}

export function uninstallGlobalWorkflow(homeRoot, options = {}) {
  const installation = readGlobalInstallation(homeRoot);
  if (installation.state === "absent") {
    return {
      changed: false,
      result: {
        installation: "absent",
        plan: {
          remove: [],
          restore: [],
          preserve: ["~/.codex-ground-control/evidence/**"],
        },
      },
    };
  }
  if (installation.state === "partial") {
    const validated = validatePartialGlobalInstallation(
      homeRoot,
      installation,
    );
    const plan = globalUninstallPlan(validated.manifest);
    if (options.dryRun) {
      return {
        changed: false,
        result: {
          installation: "preview",
          recovery: "partial-install",
          plan,
        },
      };
    }
    if (!options.confirmed) {
      const error = new ManagedWorkflowError(
        "GLOBAL_CONFIRMATION_REQUIRED",
        "Global recovery requires interactive confirmation or --confirm-global.",
      );
      error.result = {
        installation: "preview",
        recovery: "partial-install",
        plan,
      };
      throw error;
    }
    applyPartialGlobalRecovery(homeRoot, validated, options);
    return {
      changed: true,
      result: {
        installation: "recovered",
        backupId: validated.manifest.backup.id,
        plan,
        evidence: "preserved",
      },
    };
  }
  const validated = validateGlobalInstallation(
    homeRoot,
    installation,
    { allowPreexistingDrift: true },
  );
  const plan = globalUninstallPlan(validated.manifest);
  if (options.dryRun) {
    return {
      changed: false,
      result: {
        installation: "preview",
        plan,
      },
    };
  }
  if (!options.confirmed) {
    const error = new ManagedWorkflowError(
      "GLOBAL_CONFIRMATION_REQUIRED",
      "Global uninstall requires interactive confirmation or --confirm-global.",
    );
    error.result = {
      installation: "preview",
      plan,
    };
    throw error;
  }

  applyGlobalUninstall(homeRoot, validated, options);
  return {
    changed: true,
    result: {
      installation: "removed",
      backupId: validated.manifest.backup.id,
      plan,
      evidence: "preserved",
    },
  };
}

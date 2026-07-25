import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import {
  packagedManagedBlock,
  packagedRelease,
  packagedWorkflowAssets,
} from "./workflow-assets.js";
import { ManagedWorkflowError } from "./workflow-error.js";

const MANAGED_DIRECTORY = ".codex-ground-control";
const MANIFEST_PATH = `${MANAGED_DIRECTORY}/manifest.json`;
const AGENTS_PATH = "AGENTS.md";
const AGENTS_BACKUP_PATH = `${MANAGED_DIRECTORY}/backups/AGENTS.md`;
const START_MARKER = "<!-- codex-ground-control:managed:start -->";
const END_MARKER = "<!-- codex-ground-control:managed:end -->";

export { ManagedWorkflowError } from "./workflow-error.js";

function conflict(message) {
  throw new ManagedWorkflowError("INSTALLATION_CONFLICT", message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function validateRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "..")
  ) {
    conflict(`Unsafe managed path: ${String(path)}`);
  }
}

function optionalMetadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function inspectFile(projectRoot, managedPath) {
  validateRelativePath(managedPath);
  const parts = managedPath.split("/");
  let current = projectRoot;

  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = optionalMetadata(current);
    if (!metadata) {
      return {
        state: "absent",
        path: current,
      };
    }
    if (metadata.isSymbolicLink()) {
      conflict(`Managed path is a symlink: ${managedPath}`);
    }
    if (index < parts.length - 1 && !metadata.isDirectory()) {
      conflict(`Managed path has a non-directory ancestor: ${managedPath}`);
    }
    if (index === parts.length - 1 && !metadata.isFile()) {
      conflict(`Managed path is not a regular file: ${managedPath}`);
    }
  }

  const contents = readFileSync(current);
  return {
    state: "file",
    path: current,
    contents,
    sha256: sha256(contents),
  };
}

function inspectDirectory(projectRoot, managedPath) {
  validateRelativePath(managedPath);
  const absolutePath = join(projectRoot, managedPath);
  const metadata = optionalMetadata(absolutePath);
  if (!metadata) {
    return { state: "absent", path: absolutePath };
  }
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    conflict(`Managed directory is unsafe: ${managedPath}`);
  }
  return { state: "directory", path: absolutePath };
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

function managedBlockIsIntact(contents, block) {
  const text = contents.toString("utf8");
  const blockText = block.toString("utf8");
  return (
    countOccurrences(text, START_MARKER) === 1 &&
    countOccurrences(text, END_MARKER) === 1 &&
    countOccurrences(text, blockText) === 1
  );
}

function installedAgentsContents(original, block) {
  if (original.length === 0) {
    return Buffer.from(block);
  }
  const separator = original.toString("utf8").endsWith("\n") ? "\n" : "\n\n";
  return Buffer.concat([original, Buffer.from(separator), block]);
}

function readManifest(projectRoot) {
  const manifestFile = inspectFile(projectRoot, MANIFEST_PATH);
  if (manifestFile.state === "absent") {
    if (inspectDirectory(projectRoot, MANAGED_DIRECTORY).state !== "absent") {
      conflict(
        "The managed directory exists without a valid installation manifest.",
      );
    }
    return { state: "absent" };
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestFile.contents.toString("utf8"));
  } catch {
    conflict("The installation manifest is not valid JSON.");
  }

  if (
    manifest.schemaVersion !== "2" ||
    manifest.product !== "codex-ground-control" ||
    manifest.version !== "0.1.0" ||
    !Array.isArray(manifest.assets) ||
    !Array.isArray(manifest.createdDirectories) ||
    !manifest.managedBlock ||
    !manifest.releaseLock
  ) {
    conflict("The installation manifest has an unsupported shape.");
  }

  return {
    state: "installed",
    manifest,
  };
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

function validateInstalled(projectRoot, installed, options = {}) {
  const { manifest } = installed;
  const assets = packagedWorkflowAssets();
  const expectedByPath = new Map(assets.map((asset) => [asset.path, asset]));
  const manifestPaths = manifest.assets.map((asset) => asset.path).sort();
  const expectedPaths = assets.map((asset) => asset.path).sort();
  if (JSON.stringify(manifestPaths) !== JSON.stringify(expectedPaths)) {
    conflict("The installation manifest asset inventory has drifted.");
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
      conflict(`The manifest record has drifted: ${record.path}`);
    }
    const current = inspectFile(projectRoot, record.path);
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
      conflict(`A workflow asset has been modified: ${record.path}`);
    }
  }

  const release = packagedRelease();
  if (
    manifest.releaseLock.path !==
      ".codex-ground-control/release-lock.json" ||
    manifest.releaseLock.sha256 !== release.lockSha256 ||
    manifest.releaseLock.repository !== release.repository ||
    manifest.releaseLock.revision !== release.revision ||
    manifest.releaseLock.contentSha256 !== release.contentSha256 ||
    manifest.releaseLock.license !== release.license
  ) {
    conflict("The manifest release-lock record has drifted.");
  }

  const createdDirectories = new Set(manifest.createdDirectories);
  if (
    createdDirectories.size !== manifest.createdDirectories.length ||
    !createdDirectories.has(MANAGED_DIRECTORY)
  ) {
    conflict("The created-directory inventory has drifted.");
  }
  for (const directory of createdDirectories) {
    validateRelativePath(directory);
    if (inspectDirectory(projectRoot, directory).state !== "directory") {
      conflict(`A created directory is missing: ${directory}`);
    }
  }

  const block = packagedManagedBlock();
  const agents = inspectFile(projectRoot, AGENTS_PATH);
  if (
    agents.state !== "file" ||
    !managedBlockIsIntact(agents.contents, block) ||
    manifest.managedBlock.path !== AGENTS_PATH ||
    manifest.managedBlock.blockSha256 !== sha256(block)
  ) {
    conflict("The Ground Control managed block has been modified.");
  }

  let originalAgents = Buffer.alloc(0);
  if (manifest.managedBlock.backup) {
    if (
      manifest.managedBlock.backup.path !== AGENTS_BACKUP_PATH ||
      manifest.managedBlock.preInstallSha256 === null
    ) {
      conflict("The managed block backup association has drifted.");
    }
    const backup = inspectFile(
      projectRoot,
      manifest.managedBlock.backup.path,
    );
    if (
      backup.state !== "file" ||
      backup.sha256 !== manifest.managedBlock.backup.sha256 ||
      backup.sha256 !== manifest.managedBlock.preInstallSha256
    ) {
      conflict("The AGENTS.md backup has been modified or is missing.");
    }
    originalAgents = backup.contents;
  } else if (manifest.managedBlock.preInstallSha256 !== null) {
    conflict("The managed block is missing its backup association.");
  }
  const expectedInstalledAgents = installedAgentsContents(
    originalAgents,
    block,
  );
  if (
    manifest.managedBlock.ownership !== "managed-block" ||
    manifest.managedBlock.installedSha256 !==
      sha256(expectedInstalledAgents)
  ) {
    conflict("The managed block manifest record has drifted.");
  }

  return {
    manifest,
    assets,
    agents,
    block,
  };
}

function installedPlan(manifest) {
  const unchanged = [
    AGENTS_PATH,
    MANIFEST_PATH,
    ...manifest.assets.map((asset) => asset.path),
    ...(manifest.managedBlock.backup
      ? [manifest.managedBlock.backup.path]
      : []),
  ].sort();
  return {
    add: [],
    update: [],
    unchanged,
  };
}

function planNewInstallation(projectRoot) {
  const assets = packagedWorkflowAssets();
  const records = [];
  const plan = {
    add: [MANIFEST_PATH],
    update: [],
    unchanged: [],
  };

  for (const asset of assets) {
    const current = inspectFile(projectRoot, asset.path);
    if (current.state === "absent") {
      plan.add.push(asset.path);
      records.push({
        path: asset.path,
        ownership: "created",
        preInstallSha256: null,
        installedSha256: asset.sha256,
        backup: null,
        source: asset.source,
      });
    } else if (current.sha256 === asset.sha256) {
      plan.unchanged.push(asset.path);
      records.push({
        path: asset.path,
        ownership: "preexisting",
        preInstallSha256: current.sha256,
        installedSha256: asset.sha256,
        backup: null,
        source: asset.source,
      });
    } else {
      conflict(`Existing workflow asset differs: ${asset.path}`);
    }
  }

  const block = packagedManagedBlock();
  const agents = inspectFile(projectRoot, AGENTS_PATH);
  if (agents.state === "absent") {
    plan.add.push(AGENTS_PATH);
  } else {
    if (
      countOccurrences(agents.contents.toString("utf8"), START_MARKER) > 0 ||
      countOccurrences(agents.contents.toString("utf8"), END_MARKER) > 0
    ) {
      conflict("AGENTS.md already contains Ground Control managed markers.");
    }
    plan.update.push(AGENTS_PATH);
    plan.add.push(AGENTS_BACKUP_PATH);
  }

  for (const paths of Object.values(plan)) {
    paths.sort();
  }

  return {
    plan,
    assets,
    records,
    agents,
    block,
  };
}

function ensureDirectory(projectRoot, managedDirectory, createdDirectories) {
  if (managedDirectory === "." || managedDirectory === "") {
    return;
  }
  const parts = portablePath(managedDirectory).split("/");
  let current = projectRoot;
  let currentRelative = "";

  for (const part of parts) {
    current = join(current, part);
    currentRelative = currentRelative ? `${currentRelative}/${part}` : part;
    const metadata = optionalMetadata(current);
    if (metadata) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        conflict(`Managed directory is unsafe: ${currentRelative}`);
      }
      continue;
    }
    mkdirSync(current, {
      mode: currentRelative.startsWith(MANAGED_DIRECTORY) ? 0o700 : 0o755,
    });
    createdDirectories.add(currentRelative);
  }
}

function atomicWrite(
  projectRoot,
  managedPath,
  contents,
  createdDirectories,
) {
  validateRelativePath(managedPath);
  const absolutePath = join(projectRoot, managedPath);
  ensureDirectory(
    projectRoot,
    portablePath(relative(projectRoot, dirname(absolutePath))),
    createdDirectories,
  );
  const temporaryPath = join(
    dirname(absolutePath),
    `.${relative(dirname(absolutePath), absolutePath)}.${randomUUID()}.tmp`,
  );
  writeFileSync(temporaryPath, contents, {
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporaryPath, absolutePath);
}

function removeCreatedDirectories(projectRoot, directories) {
  for (const directory of [...directories].sort(
    (left, right) => right.length - left.length,
  )) {
    try {
      rmdirSync(join(projectRoot, directory));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) {
        throw error;
      }
    }
  }
}

function applyNewInstallation(projectRoot, planned) {
  const createdDirectories = new Set();
  const createdFiles = [];
  const originalAgents =
    planned.agents.state === "file" ? planned.agents.contents : null;
  const installedAgents = installedAgentsContents(
    originalAgents ?? Buffer.alloc(0),
    planned.block,
  );
  const backup =
    originalAgents === null
      ? null
      : {
          path: AGENTS_BACKUP_PATH,
          sha256: sha256(originalAgents),
        };
  const release = packagedRelease();
  const manifest = {
    schemaVersion: "2",
    product: "codex-ground-control",
    version: "0.1.0",
    releaseLock: {
      path: ".codex-ground-control/release-lock.json",
      sha256: release.lockSha256,
      ...releaseSummary(),
    },
    managedBlock: {
      path: AGENTS_PATH,
      ownership: "managed-block",
      preInstallSha256:
        originalAgents === null ? null : sha256(originalAgents),
      installedSha256: sha256(installedAgents),
      blockSha256: sha256(planned.block),
      backup,
    },
    createdDirectories: [],
    assets: planned.records,
  };

  let agentsWritten = false;
  try {
    if (backup) {
      atomicWrite(
        projectRoot,
        backup.path,
        originalAgents,
        createdDirectories,
      );
      createdFiles.push(backup.path);
    }

    for (const [index, asset] of planned.assets.entries()) {
      if (planned.records[index].ownership !== "created") {
        continue;
      }
      atomicWrite(
        projectRoot,
        asset.path,
        asset.contents,
        createdDirectories,
      );
      createdFiles.push(asset.path);
    }

    atomicWrite(
      projectRoot,
      AGENTS_PATH,
      installedAgents,
      createdDirectories,
    );
    agentsWritten = true;
    manifest.createdDirectories = [...createdDirectories].sort();
    atomicWrite(
      projectRoot,
      MANIFEST_PATH,
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      createdDirectories,
    );
    createdFiles.push(MANIFEST_PATH);
  } catch (error) {
    for (const path of createdFiles.reverse()) {
      try {
        unlinkSync(join(projectRoot, path));
      } catch (unlinkError) {
        if (unlinkError.code !== "ENOENT") {
          throw unlinkError;
        }
      }
    }
    if (agentsWritten) {
      if (originalAgents === null) {
        unlinkSync(join(projectRoot, AGENTS_PATH));
      } else {
        atomicWrite(
          projectRoot,
          AGENTS_PATH,
          originalAgents,
          createdDirectories,
        );
      }
    }
    removeCreatedDirectories(projectRoot, createdDirectories);
    throw error;
  }

  return manifest;
}

export function initializeManagedWorkflow(projectRoot, options = {}) {
  const installation = readManifest(projectRoot);
  if (installation.state === "installed") {
    const validated = validateInstalled(projectRoot, installation);
    if (options.dryRun) {
      return {
        changed: false,
        result: {
          installation: "preview",
          plan: installedPlan(validated.manifest),
        },
      };
    }
    return {
      changed: false,
      result: {
        installation: "unchanged",
        manifest: MANIFEST_PATH,
        releaseLock: {
          revision: validated.manifest.releaseLock.revision,
          license: validated.manifest.releaseLock.license,
        },
      },
    };
  }

  const planned = planNewInstallation(projectRoot);
  if (options.dryRun) {
    return {
      changed: false,
      result: {
        installation: "preview",
        plan: planned.plan,
      },
    };
  }

  const manifest = applyNewInstallation(projectRoot, planned);
  return {
    changed: true,
    result: {
      installation: "created",
      manifest: MANIFEST_PATH,
      releaseLock: {
        revision: manifest.releaseLock.revision,
        license: manifest.releaseLock.license,
      },
    },
  };
}

export function diagnoseManagedWorkflow(projectRoot) {
  const installation = readManifest(projectRoot);
  if (installation.state === "absent") {
    throw new ManagedWorkflowError(
      "INSTALLATION_NOT_FOUND",
      "Ground Control is not initialized in this Git worktree.",
    );
  }
  const validated = validateInstalled(projectRoot, installation);

  return {
    gitWorktree: "passed",
    installation: "passed",
    workflow: "passed",
    managedBlock: "passed",
    releaseLock: {
      status: "passed",
      ...releaseSummary(),
    },
    assets: {
      status: "passed",
      count: validated.manifest.assets.length,
    },
  };
}

function restoreAgents(projectRoot, validated, createdDirectories) {
  const { managedBlock } = validated.manifest;
  if (validated.agents.sha256 === managedBlock.installedSha256) {
    if (!managedBlock.backup) {
      unlinkSync(join(projectRoot, AGENTS_PATH));
      return;
    }
    const backup = inspectFile(projectRoot, managedBlock.backup.path);
    atomicWrite(
      projectRoot,
      AGENTS_PATH,
      backup.contents,
      createdDirectories,
    );
    return;
  }

  const current = validated.agents.contents;
  const original = managedBlock.backup
    ? inspectFile(projectRoot, managedBlock.backup.path).contents
    : Buffer.alloc(0);
  const installed = installedAgentsContents(original, validated.block);
  const addition = installed.subarray(original.length);
  const additionOffset = current.indexOf(addition);
  if (
    additionOffset === -1 ||
    current.indexOf(addition, additionOffset + addition.length) !== -1
  ) {
    conflict("AGENTS.md cannot be restored without losing user changes.");
  }
  const restored = Buffer.concat([
    current.subarray(0, additionOffset),
    current.subarray(additionOffset + addition.length),
  ]);
  if (!managedBlock.backup && restored.length === 0) {
    unlinkSync(join(projectRoot, AGENTS_PATH));
  } else {
    atomicWrite(
      projectRoot,
      AGENTS_PATH,
      restored,
      createdDirectories,
    );
  }
}

export function uninstallManagedWorkflow(projectRoot) {
  const installation = readManifest(projectRoot);
  if (installation.state === "absent") {
    return {
      changed: false,
      result: {
        installation: "absent",
      },
    };
  }
  const validated = validateInstalled(projectRoot, installation, {
    allowPreexistingDrift: true,
  });
  const createdDirectories = new Set();

  restoreAgents(projectRoot, validated, createdDirectories);
  for (const record of [...validated.manifest.assets].reverse()) {
    if (record.ownership === "created") {
      unlinkSync(join(projectRoot, record.path));
    }
  }
  if (validated.manifest.managedBlock.backup) {
    unlinkSync(
      join(
        projectRoot,
        validated.manifest.managedBlock.backup.path,
      ),
    );
  }
  unlinkSync(join(projectRoot, MANIFEST_PATH));
  removeCreatedDirectories(
    projectRoot,
    validated.manifest.createdDirectories,
  );

  return {
    changed: true,
    result: {
      installation: "removed",
    },
  };
}

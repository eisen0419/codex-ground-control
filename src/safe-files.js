import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  sep,
} from "node:path";
import { ManagedWorkflowError } from "./workflow-error.js";

function conflict(message) {
  throw new ManagedWorkflowError("INSTALLATION_CONFLICT", message);
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function portablePath(path) {
  return path.split(sep).join("/");
}

export function validateRelativePath(path) {
  if (
    typeof path !== "string" ||
    path.length === 0 ||
    isAbsolute(path) ||
    path.split("/").some((part) =>
      part === "" || part === "." || part === ".."
    )
  ) {
    conflict(`Unsafe managed path: ${String(path)}`);
  }
}

export function optionalMetadata(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function metadataIdentity(metadata) {
  return {
    dev: metadata.dev,
    ino: metadata.ino,
    mode: metadata.mode,
  };
}

function identitiesMatch(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode
  );
}

function captureExistingChain(
  root,
  relativePath,
  finalKind = "file",
) {
  validateRelativePath(relativePath);
  const rootMetadata = lstatSync(root);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    conflict("The managed root changed during operation.");
  }
  const chain = [
    {
      path: root,
      identity: metadataIdentity(rootMetadata),
    },
  ];
  let current = root;
  const parts = relativePath.split("/");

  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const metadata = optionalMetadata(current);
    if (!metadata) {
      return { chain, missingAt: index };
    }
    if (metadata.isSymbolicLink()) {
      conflict(`Managed path is a symlink: ~/${relativePath}`);
    }
    const final = index === parts.length - 1;
    if (!final && !metadata.isDirectory()) {
      conflict(
        `Managed path has a non-directory ancestor: ~/${relativePath}`,
      );
    }
    chain.push({
      path: current,
      identity: metadataIdentity(metadata),
    });
    if (
      final &&
      ((finalKind === "file" && !metadata.isFile()) ||
        (finalKind === "directory" && !metadata.isDirectory()))
    ) {
      conflict(`Managed path has the wrong type: ~/${relativePath}`);
    }
  }

  return { chain, missingAt: null };
}

function assertChainUnchanged(chain, managedPath) {
  for (const entry of chain) {
    const current = optionalMetadata(entry.path);
    if (
      !current ||
      current.isSymbolicLink() ||
      !identitiesMatch(entry.identity, metadataIdentity(current))
    ) {
      conflict(`Managed path changed during operation: ~/${managedPath}`);
    }
  }
}

export function inspectFile(root, relativePath) {
  const captured = captureExistingChain(root, relativePath);
  if (captured.missingAt !== null) {
    assertChainUnchanged(captured.chain, relativePath);
    return { state: "absent" };
  }
  const absolutePath = join(root, relativePath);
  const expected = captured.chain.at(-1).identity;
  let descriptor;
  try {
    descriptor = openSync(
      absolutePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const opened = fstatSync(descriptor);
    if (
      !opened.isFile() ||
      !identitiesMatch(expected, metadataIdentity(opened))
    ) {
      conflict(`Managed file changed while opening: ~/${relativePath}`);
    }
    const contents = readFileSync(descriptor);
    assertChainUnchanged(captured.chain, relativePath);
    return {
      state: "file",
      contents,
      sha256: sha256(contents),
    };
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error.code)) {
      conflict(`Managed path is a symlink: ~/${relativePath}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

export function inspectDirectory(root, relativePath) {
  validateRelativePath(relativePath);
  const captured = captureExistingChain(
    root,
    relativePath,
    "directory",
  );
  if (captured.missingAt !== null) {
    assertChainUnchanged(captured.chain, relativePath);
    return { state: "absent" };
  }
  assertChainUnchanged(captured.chain, relativePath);
  return { state: "directory" };
}

function assertExpectedFile(root, relativePath, expected) {
  const current = inspectFile(root, relativePath);
  if (expected.state === "absent") {
    if (current.state !== "absent") {
      conflict(
        `Managed path no longer matches its preview: ~/${relativePath}`,
      );
    }
    return;
  }
  if (
    current.state !== "file" ||
    current.sha256 !== expected.sha256
  ) {
    conflict(
      `Managed path no longer matches its preview: ~/${relativePath}`,
    );
  }
}

function invokeFault(options, checkpoint, details) {
  options.faultInjector?.(checkpoint, details);
}

function ensureDirectory(
  root,
  relativeDirectory,
  createdDirectories,
  options,
) {
  if (!relativeDirectory || relativeDirectory === ".") {
    return;
  }
  validateRelativePath(relativeDirectory);
  const parts = relativeDirectory.split("/");
  let currentRelative = "";

  for (const part of parts) {
    currentRelative = currentRelative
      ? `${currentRelative}/${part}`
      : part;
    const absolutePath = join(root, currentRelative);
    const metadata = optionalMetadata(absolutePath);
    const expectedCreated =
      options.expectedCreatedDirectories?.has(currentRelative);
    if (metadata) {
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        conflict(`Managed directory is unsafe: ~/${currentRelative}`);
      }
      if (
        expectedCreated &&
        !createdDirectories.has(currentRelative)
      ) {
        conflict(
          `Managed directory appeared after preview: ~/${currentRelative}`,
        );
      }
      continue;
    }
    if (
      options.expectedCreatedDirectories &&
      !expectedCreated
    ) {
      conflict(
        `Managed directory disappeared after preview: ~/${currentRelative}`,
      );
    }

    const parentPath = portablePath(dirname(currentRelative));
    const parent = parentPath === "."
      ? {
          chain: captureExistingChain(root, currentRelative).chain,
          missingAt: null,
        }
      : captureExistingChain(root, parentPath, "directory");
    if (parent.missingAt !== null) {
      conflict(`Managed directory parent is missing: ~/${currentRelative}`);
    }
    invokeFault(options, "before-directory-create", {
      path: currentRelative,
    });
    assertChainUnchanged(parent.chain, currentRelative);
    if (optionalMetadata(absolutePath)) {
      conflict(
        `Managed directory appeared during operation: ~/${currentRelative}`,
      );
    }
    mkdirSync(absolutePath, {
      mode: currentRelative.startsWith(".codex-ground-control")
        ? 0o700
        : 0o755,
    });
    const created = optionalMetadata(absolutePath);
    if (
      !created ||
      created.isSymbolicLink() ||
      !created.isDirectory()
    ) {
      conflict(`Managed directory was not created safely: ~/${currentRelative}`);
    }
    createdDirectories.add(currentRelative);
  }
}

export function atomicWrite(
  root,
  relativePath,
  contents,
  expected,
  createdDirectories,
  options,
) {
  validateRelativePath(relativePath);
  const parentPath = portablePath(dirname(relativePath));
  ensureDirectory(root, parentPath, createdDirectories, options);
  assertExpectedFile(root, relativePath, expected);
  const parent = captureExistingChain(
    root,
    parentPath,
    "directory",
  );
  if (parent.missingAt !== null) {
    conflict(`Managed parent is missing: ~/${parentPath}`);
  }
  const absolutePath = join(root, relativePath);
  const temporaryPath = join(
    dirname(absolutePath),
    `.${basename(relativePath)}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    writeFileSync(temporaryPath, contents, {
      flag: "wx",
      mode: 0o600,
    });
    temporaryCreated = true;
    invokeFault(options, "before-atomic-rename", {
      path: relativePath,
    });
    assertChainUnchanged(parent.chain, relativePath);
    assertExpectedFile(root, relativePath, expected);
    renameSync(temporaryPath, absolutePath);
    temporaryCreated = false;
    const installed = inspectFile(root, relativePath);
    if (
      installed.state !== "file" ||
      installed.sha256 !== sha256(contents)
    ) {
      conflict(`Managed write could not be verified: ~/${relativePath}`);
    }
  } finally {
    if (temporaryCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch (error) {
        if (error.code !== "ENOENT") {
          throw error;
        }
      }
    }
  }
}

export function removeVerifiedFile(
  root,
  relativePath,
  expectedSha256,
  options,
) {
  const current = inspectFile(root, relativePath);
  if (
    current.state !== "file" ||
    current.sha256 !== expectedSha256
  ) {
    conflict(`Managed file cannot be removed safely: ~/${relativePath}`);
  }
  const parentPath = portablePath(dirname(relativePath));
  const parent = captureExistingChain(
    root,
    parentPath,
    "directory",
  );
  if (parent.missingAt !== null) {
    conflict(`Managed parent is missing: ~/${parentPath}`);
  }
  invokeFault(options, "before-verified-unlink", {
    path: relativePath,
  });
  assertChainUnchanged(parent.chain, relativePath);
  assertExpectedFile(root, relativePath, {
    state: "file",
    sha256: expectedSha256,
  });
  unlinkSync(join(root, relativePath));
}

export function removeCreatedDirectories(
  root,
  directories,
  options,
) {
  for (const directory of [...directories].sort(
    (left, right) =>
      right.split("/").length - left.split("/").length ||
      right.localeCompare(left),
  )) {
    const current = inspectDirectory(root, directory);
    if (current.state === "absent") {
      continue;
    }
    const captured = captureExistingChain(
      root,
      directory,
      "directory",
    );
    invokeFault(options, "before-directory-remove", {
      path: directory,
    });
    assertChainUnchanged(captured.chain, directory);
    try {
      rmdirSync(join(root, directory));
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) {
        throw error;
      }
    }
  }
}

export function collectMissingDirectories(root, paths) {
  const directories = new Set();
  for (const relativePath of paths) {
    let current = portablePath(dirname(relativePath));
    const lineage = [];
    while (current !== ".") {
      lineage.push(current);
      current = portablePath(dirname(current));
    }
    for (const directory of lineage.reverse()) {
      const metadata = optionalMetadata(join(root, directory));
      if (!metadata) {
        directories.add(directory);
      } else if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        conflict(`Managed directory is unsafe: ~/${directory}`);
      }
    }
  }
  return [...directories].sort();
}

export function ancestorDirectories(paths) {
  const directories = new Set();
  for (const relativePath of paths) {
    let current = portablePath(dirname(relativePath));
    while (current !== ".") {
      directories.add(current);
      current = portablePath(dirname(current));
    }
  }
  return directories;
}

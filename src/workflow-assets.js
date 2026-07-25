import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      }
    }
  };
  visit(root);
  return files.sort();
}

function releaseLockAssets() {
  const releaseLock = JSON.parse(
    readFileSync(join(packageRoot, "release-lock.json"), "utf8"),
  );
  const [dependency] = releaseLock.dependencies;

  return dependency.assets.map((asset) => {
    const contents = readFileSync(join(packageRoot, asset.sourcePath));
    if (
      contents.byteLength !== asset.bytes ||
      sha256(contents) !== asset.sha256
    ) {
      throw new Error(`Vendored upstream asset drifted: ${asset.sourcePath}`);
    }

    return {
      path: asset.installPath,
      contents,
      sha256: asset.sha256,
      source: {
        kind: "vendored-upstream",
        path: asset.sourcePath,
        upstreamPath: asset.upstreamPath,
      },
    };
  });
}

function overlayAssets() {
  const overlayRoot = join(
    packageRoot,
    "assets",
    "overlays",
    "multi-agent-router",
  );

  return listFiles(overlayRoot).map((absolutePath) => {
    const contents = readFileSync(absolutePath);
    return {
      path: `.agents/skills/multi-agent-router/${portablePath(
        relative(overlayRoot, absolutePath),
      )}`,
      contents,
      sha256: sha256(contents),
      source: {
        kind: "ground-control-overlay",
        path: portablePath(relative(packageRoot, absolutePath)),
      },
    };
  });
}

function metadataAssets() {
  return [
    {
      path: ".codex-ground-control/release-lock.json",
      sourcePath: "release-lock.json",
    },
    {
      path: ".codex-ground-control/THIRD_PARTY_NOTICES.md",
      sourcePath: "THIRD_PARTY_NOTICES.md",
    },
  ].map((asset) => {
    const contents = readFileSync(join(packageRoot, asset.sourcePath));
    return {
      path: asset.path,
      contents,
      sha256: sha256(contents),
      source: {
        kind: "release-metadata",
        path: asset.sourcePath,
      },
    };
  });
}

export function packagedWorkflowAssets() {
  return [
    ...releaseLockAssets(),
    ...overlayAssets(),
    ...metadataAssets(),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

export function packagedManagedBlock() {
  return readFileSync(
    join(packageRoot, "assets", "overlays", "agents-managed-block.md"),
  );
}

export function packagedRelease() {
  const bytes = readFileSync(join(packageRoot, "release-lock.json"));
  const releaseLock = JSON.parse(bytes.toString("utf8"));
  const [dependency] = releaseLock.dependencies;
  const contentSha256 = sha256(
    dependency.assets
      .map(({ sourcePath, sha256: assetSha256 }) =>
        `${sourcePath}\0${assetSha256}\n`
      )
      .join(""),
  );
  const licenseBytes = readFileSync(
    join(packageRoot, dependency.license.sourcePath),
  );
  if (
    contentSha256 !== dependency.contentSha256 ||
    licenseBytes.byteLength !== dependency.license.bytes ||
    sha256(licenseBytes) !== dependency.license.sha256
  ) {
    throw new Error("The packaged release lock does not match its contents.");
  }

  return {
    lock: releaseLock,
    lockSha256: sha256(bytes),
    repository: dependency.repository,
    revision: dependency.revision,
    contentSha256,
    license: dependency.license.identifier,
  };
}

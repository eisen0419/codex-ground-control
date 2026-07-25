import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const vendorRoot = join(repositoryRoot, "vendor", "mattpocock-skills");
const releaseLockPath = join(repositoryRoot, "release-lock.json");
const revision = "ed37663cc5fbef691ddfecd080dff42f7e7e350d";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function portablePath(path) {
  return path.split(sep).join("/");
}

function listSkillDirectories() {
  const categories = ["engineering", "productivity"];
  const directories = [];

  for (const category of categories) {
    const categoryRoot = join(vendorRoot, "skills", category);
    for (const entry of readdirSync(categoryRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        throw new Error(`Unexpected vendored entry: ${entry.name}`);
      }
      directories.push({
        category,
        name: entry.name,
        path: join(categoryRoot, entry.name),
      });
    }
  }

  return directories.sort((left, right) =>
    `${left.category}/${left.name}`.localeCompare(
      `${right.category}/${right.name}`,
    ),
  );
}

function listFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = join(directory, entry.name);
      const metadata = lstatSync(absolutePath);
      if (metadata.isSymbolicLink()) {
        throw new Error(`Vendored symlinks are not allowed: ${absolutePath}`);
      }
      if (entry.isDirectory()) {
        visit(absolutePath);
      } else if (entry.isFile()) {
        files.push(absolutePath);
      } else {
        throw new Error(`Unsupported vendored entry: ${absolutePath}`);
      }
    }
  };

  visit(root);
  return files.sort();
}

const assets = [];
for (const skill of listSkillDirectories()) {
  for (const absolutePath of listFiles(skill.path)) {
    const contents = readFileSync(absolutePath);
    const relativeToSkill = portablePath(relative(skill.path, absolutePath));
    assets.push({
      sourcePath: portablePath(relative(repositoryRoot, absolutePath)),
      upstreamPath: `skills/${skill.category}/${skill.name}/${relativeToSkill}`,
      installPath: `.agents/skills/${skill.name}/${relativeToSkill}`,
      bytes: contents.byteLength,
      sha256: sha256(contents),
    });
  }
}

assets.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath));
const licensePath = join(vendorRoot, "LICENSE");
const licenseContents = readFileSync(licensePath);
const contentSha256 = sha256(
  assets
    .map(
      ({ sourcePath, sha256: assetSha256 }) =>
        `${sourcePath}\0${assetSha256}\n`,
    )
    .join(""),
);
const releaseLock = {
  schemaVersion: "1",
  dependencies: [
    {
      name: "mattpocock/skills",
      repository: "https://github.com/mattpocock/skills.git",
      revision,
      contentSha256,
      license: {
        identifier: "MIT",
        sourcePath: "vendor/mattpocock-skills/LICENSE",
        sourceUrl: `https://github.com/mattpocock/skills/blob/${revision}/LICENSE`,
        bytes: licenseContents.byteLength,
        sha256: sha256(licenseContents),
      },
      assets,
    },
  ],
};
const serialized = `${JSON.stringify(releaseLock, null, 2)}\n`;

if (process.argv.includes("--write")) {
  writeFileSync(releaseLockPath, serialized, "utf8");
} else {
  assert.equal(
    readFileSync(releaseLockPath, "utf8"),
    serialized,
    "release-lock.json does not match the vendored upstream bytes",
  );
}

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_SUCCESS = 0;
const EXIT_BLOCKED = 2;
const MANAGED_DIRECTORY = ".codex-ground-control";
const MANIFEST_NAME = "manifest.json";
const MANIFEST_PATH = `${MANAGED_DIRECTORY}/${MANIFEST_NAME}`;
const MANIFEST = {
  schemaVersion: "1",
  product: "codex-ground-control",
  version: "0.1.0",
  managedPaths: [MANIFEST_PATH],
};

function success(projectRoot, changed, result) {
  return {
    status: "ok",
    exitCode: EXIT_SUCCESS,
    projectRoot,
    changed,
    result,
  };
}

function blocked(projectRoot, code, message) {
  return {
    status: "blocked",
    exitCode: EXIT_BLOCKED,
    projectRoot,
    changed: false,
    error: { code, message },
  };
}

function findGitRoot(startDirectory) {
  const git = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: startDirectory,
    encoding: "utf8",
    env: process.env,
  });

  if (git.status !== 0) {
    return null;
  }

  return resolve(git.stdout.trim());
}

function resolveProject(startDirectory) {
  const requestedDirectory = resolve(startDirectory);
  const projectRoot = findGitRoot(requestedDirectory);

  if (!projectRoot) {
    return {
      error: blocked(
        requestedDirectory,
        "GIT_WORKTREE_REQUIRED",
        "Ground Control requires an existing Git worktree.",
      ),
    };
  }

  if (projectRoot === parse(projectRoot).root) {
    return {
      error: blocked(
        projectRoot,
        "UNSAFE_PROJECT_ROOT",
        "Ground Control refuses to manage a filesystem root.",
      ),
    };
  }

  return {
    projectRoot,
    managedDirectory: join(projectRoot, MANAGED_DIRECTORY),
    manifestPath: join(projectRoot, MANIFEST_PATH),
  };
}

function readManifest(project) {
  if (!existsSync(project.manifestPath)) {
    return { state: "absent" };
  }

  try {
    const manifest = JSON.parse(readFileSync(project.manifestPath, "utf8"));
    if (JSON.stringify(manifest) !== JSON.stringify(MANIFEST)) {
      return { state: "conflict" };
    }
    return { state: "installed" };
  } catch {
    return { state: "conflict" };
  }
}

function requireInstalled(startDirectory) {
  const project = resolveProject(startDirectory);
  if (project.error) {
    return project;
  }

  const manifest = readManifest(project);
  if (manifest.state === "absent") {
    return {
      error: blocked(
        project.projectRoot,
        "INSTALLATION_NOT_FOUND",
        "Ground Control is not initialized in this Git worktree.",
      ),
    };
  }
  if (manifest.state === "conflict") {
    return {
      error: blocked(
        project.projectRoot,
        "INSTALLATION_CONFLICT",
        "The Ground Control manifest is invalid or has been modified.",
      ),
    };
  }

  return project;
}

export function initializeProject(startDirectory) {
  const project = resolveProject(startDirectory);
  if (project.error) {
    return project.error;
  }

  const manifest = readManifest(project);
  if (manifest.state === "installed") {
    return success(project.projectRoot, false, {
      installation: "unchanged",
      manifest: MANIFEST_PATH,
    });
  }
  if (manifest.state === "conflict") {
    return blocked(
      project.projectRoot,
      "INSTALLATION_CONFLICT",
      "The Ground Control manifest is invalid or has been modified.",
    );
  }

  if (existsSync(project.managedDirectory)) {
    return blocked(
      project.projectRoot,
      "INSTALLATION_CONFLICT",
      "The managed directory already exists without a valid manifest.",
    );
  }

  mkdirSync(project.managedDirectory, { mode: 0o700 });
  writeFileSync(
    project.manifestPath,
    `${JSON.stringify(MANIFEST, null, 2)}\n`,
    {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    },
  );

  return success(project.projectRoot, true, {
    installation: "created",
    manifest: MANIFEST_PATH,
  });
}

export function diagnoseProject(startDirectory) {
  const project = requireInstalled(startDirectory);
  if (project.error) {
    return project.error;
  }

  return success(project.projectRoot, false, {
    gitWorktree: "passed",
    installation: "passed",
  });
}

export function qualifyProject(startDirectory) {
  const project = requireInstalled(startDirectory);
  if (project.error) {
    return project.error;
  }

  const fixturePath = fileURLToPath(
    new URL("../fixtures/offline-uppercase.json", import.meta.url),
  );
  const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
  const observed = fixture.input.toUpperCase();

  if (observed !== fixture.expected) {
    return blocked(
      project.projectRoot,
      "OFFLINE_QUALIFICATION_FAILED",
      "The deterministic offline fixture did not produce the expected result.",
    );
  }

  return success(project.projectRoot, false, {
    fixture: fixture.id,
    observed,
    qualification: "passed",
    network: "not-used",
  });
}

export function inspectProviders(startDirectory) {
  const project = requireInstalled(startDirectory);
  if (project.error) {
    return project.error;
  }

  return success(project.projectRoot, false, {
    providers: [],
    summary: "No optional providers are configured.",
  });
}

export function uninstallProject(startDirectory) {
  const project = resolveProject(startDirectory);
  if (project.error) {
    return project.error;
  }

  const manifest = readManifest(project);
  if (manifest.state === "absent" && !existsSync(project.managedDirectory)) {
    return success(project.projectRoot, false, {
      installation: "absent",
    });
  }
  if (manifest.state !== "installed") {
    return blocked(
      project.projectRoot,
      "INSTALLATION_CONFLICT",
      "The managed state is missing, invalid, or has been modified.",
    );
  }

  const entries = readdirSync(project.managedDirectory);
  if (entries.length !== 1 || entries[0] !== MANIFEST_NAME) {
    return blocked(
      project.projectRoot,
      "INSTALLATION_CONFLICT",
      "The managed directory contains files that Ground Control does not own.",
    );
  }

  unlinkSync(project.manifestPath);
  rmdirSync(project.managedDirectory);

  return success(project.projectRoot, true, {
    installation: "removed",
  });
}

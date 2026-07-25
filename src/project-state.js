import { spawnSync } from "node:child_process";
import {
  readFileSync,
} from "node:fs";
import { parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diagnoseManagedWorkflow,
  initializeManagedWorkflow,
  ManagedWorkflowError,
  uninstallManagedWorkflow,
} from "./managed-workflow.js";

const EXIT_SUCCESS = 0;
const EXIT_BLOCKED = 2;
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
  };
}

function requireInstalled(startDirectory) {
  const project = resolveProject(startDirectory);
  if (project.error) {
    return project;
  }

  try {
    diagnoseManagedWorkflow(project.projectRoot);
  } catch (error) {
    if (!(error instanceof ManagedWorkflowError)) {
      throw error;
    }
    return {
      error: blocked(
        project.projectRoot,
        error.code,
        error.message,
      ),
    };
  }

  return project;
}

export function initializeProject(startDirectory, options = {}) {
  const project = resolveProject(startDirectory);
  if (project.error) {
    return project.error;
  }

  try {
    const outcome = initializeManagedWorkflow(project.projectRoot, options);
    return success(project.projectRoot, outcome.changed, outcome.result);
  } catch (error) {
    if (!(error instanceof ManagedWorkflowError)) {
      throw error;
    }
    return blocked(project.projectRoot, error.code, error.message);
  }
}

export function diagnoseProject(startDirectory) {
  const project = resolveProject(startDirectory);
  if (project.error) {
    return project.error;
  }

  try {
    return success(
      project.projectRoot,
      false,
      diagnoseManagedWorkflow(project.projectRoot),
    );
  } catch (error) {
    if (!(error instanceof ManagedWorkflowError)) {
      throw error;
    }
    return blocked(project.projectRoot, error.code, error.message);
  }
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

  try {
    const outcome = uninstallManagedWorkflow(project.projectRoot);
    return success(project.projectRoot, outcome.changed, outcome.result);
  } catch (error) {
    if (!(error instanceof ManagedWorkflowError)) {
      throw error;
    }
    return blocked(project.projectRoot, error.code, error.message);
  }
}

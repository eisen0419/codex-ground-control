import { spawnSync } from "node:child_process";
import {
  realpathSync,
  readFileSync,
} from "node:fs";
import { parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  diagnoseManagedWorkflow,
  initializeManagedWorkflow,
  uninstallManagedWorkflow,
} from "./managed-workflow.js";
import { ManagedWorkflowError } from "./workflow-error.js";
import {
  initializeGlobalWorkflow,
  uninstallGlobalWorkflow,
} from "./global-workflow.js";

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

function globalSuccess(changed, result) {
  return {
    status: "ok",
    exitCode: EXIT_SUCCESS,
    scope: "global",
    targetRoot: "~",
    changed,
    result,
  };
}

function globalBlocked(code, message, result) {
  return {
    status: "blocked",
    exitCode: EXIT_BLOCKED,
    scope: "global",
    targetRoot: "~",
    changed: false,
    ...(result ? { result } : {}),
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

function resolveProject(
  startDirectory,
  homeDirectory = process.env.HOME,
) {
  const requestedDirectory = resolve(startDirectory);
  const projectRoot = findGitRoot(requestedDirectory);
  let resolvedHome = null;
  if (typeof homeDirectory === "string") {
    try {
      resolvedHome = realpathSync(homeDirectory);
    } catch {
      resolvedHome = resolve(homeDirectory);
    }
  }

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
  if (resolvedHome && projectRoot === resolvedHome) {
    return {
      error: blocked(
        projectRoot,
        "UNSAFE_PROJECT_ROOT",
        "Ground Control refuses to manage the entire user home as a project.",
      ),
    };
  }

  return {
    projectRoot,
  };
}

function requireInstalled(startDirectory, options = {}) {
  const project = resolveProject(
    startDirectory,
    options.homeDirectory,
  );
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
  if (options.global) {
    try {
      const outcome = initializeGlobalWorkflow(
        options.homeDirectory,
        options,
      );
      return globalSuccess(outcome.changed, outcome.result);
    } catch (error) {
      if (!(error instanceof ManagedWorkflowError)) {
        throw error;
      }
      return globalBlocked(error.code, error.message, error.result);
    }
  }

  const project = resolveProject(
    startDirectory,
    options.homeDirectory,
  );
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

export function diagnoseProject(startDirectory, options = {}) {
  const project = resolveProject(
    startDirectory,
    options.homeDirectory,
  );
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

export function qualifyProject(startDirectory, options = {}) {
  const project = requireInstalled(startDirectory, options);
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

export function inspectProviders(startDirectory, options = {}) {
  const project = requireInstalled(startDirectory, options);
  if (project.error) {
    return project.error;
  }

  return success(project.projectRoot, false, {
    providers: [],
    summary: "No optional providers are configured.",
  });
}

export function uninstallProject(startDirectory, options = {}) {
  if (options.global) {
    try {
      const outcome = uninstallGlobalWorkflow(
        options.homeDirectory,
        options,
      );
      return globalSuccess(outcome.changed, outcome.result);
    } catch (error) {
      if (!(error instanceof ManagedWorkflowError)) {
        throw error;
      }
      return globalBlocked(error.code, error.message, error.result);
    }
  }

  const project = resolveProject(
    startDirectory,
    options.homeDirectory,
  );
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

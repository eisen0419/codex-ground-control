import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { parse, resolve } from "node:path";
import {
  diagnoseManagedWorkflow,
  initializeManagedWorkflow,
  uninstallManagedWorkflow,
} from "./managed-workflow.js";
import { ManagedWorkflowError } from "./workflow-error.js";
import {
  diagnoseGlobalWorkflow,
  initializeGlobalWorkflow,
  uninstallGlobalWorkflow,
} from "./global-workflow.js";
import { diagnoseRuntime } from "./doctor.js";
import {
  QualificationLabError,
  reproduceOfflineQualification,
  runOfflineQualification,
  verifyOfflineQualification,
} from "./qualification-lab.js";
import {
  ProviderLifecycleError,
  runProviderOperation,
} from "./provider-lifecycle.js";

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

function doctorOutcome(projectRoot, options, diagnosis, error) {
  const isBlocked = Boolean(error) || diagnosis.health === "blocked";
  if (!isBlocked) {
    return options.global
      ? globalSuccess(false, diagnosis)
      : success(projectRoot, false, diagnosis);
  }
  const code = error?.code ?? "DOCTOR_BLOCKED";
  const message =
    error?.message ??
    "Ground Control doctor found operational blockers.";
  if (options.global) {
    return globalBlocked(code, message, diagnosis);
  }
  return {
    ...blocked(projectRoot, code, message),
    result: diagnosis,
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
    if (project.error.error.code !== "GIT_WORKTREE_REQUIRED") {
      return project.error;
    }
    const diagnosis = diagnoseRuntime({
      scope: options.global ? "global" : "project",
      cwd: resolve(startDirectory),
      homeDirectory: options.homeDirectory,
      gitWorktree: false,
    });
    return doctorOutcome(
      project.error.projectRoot,
      options,
      diagnosis,
      project.error.error,
    );
  }

  try {
    const installation = options.global
      ? diagnoseGlobalWorkflow(options.homeDirectory)
      : diagnoseManagedWorkflow(project.projectRoot);
    const diagnosis = diagnoseRuntime({
      scope: options.global ? "global" : "project",
      projectRoot: project.projectRoot,
      cwd: project.projectRoot,
      homeDirectory: options.homeDirectory,
      gitWorktree: true,
      installation,
    });
    return doctorOutcome(
      project.projectRoot,
      options,
      diagnosis,
    );
  } catch (error) {
    if (!(error instanceof ManagedWorkflowError)) {
      throw error;
    }
    const diagnosis = diagnoseRuntime({
      scope: options.global ? "global" : "project",
      projectRoot: project.projectRoot,
      cwd: project.projectRoot,
      homeDirectory: options.homeDirectory,
      gitWorktree: true,
      installationError: error,
    });
    return doctorOutcome(
      project.projectRoot,
      options,
      diagnosis,
      error,
    );
  }
}

export function qualifyProject(startDirectory, options = {}) {
  const project = requireInstalled(startDirectory, options);
  if (project.error) {
    return project.error;
  }

  let result;
  try {
    switch (options.qualification?.operation ?? "run") {
      case "verify":
        result = verifyOfflineQualification({
          homeDirectory: options.homeDirectory,
          runIdentity: options.qualification.runIdentity,
          anchor: options.qualification.anchor,
        });
        break;
      case "reproduce":
        result = reproduceOfflineQualification({
          homeDirectory: options.homeDirectory,
          sourceRun: options.qualification.sourceRun,
          scenarioId: options.qualification.scenarioId,
        });
        break;
      case "run":
        result = runOfflineQualification({
          homeDirectory: options.homeDirectory,
        });
        break;
      default:
        throw new QualificationLabError(
          "QUALIFICATION_OPERATION_INVALID",
          "Qualification operation is invalid.",
        );
    }
  } catch (error) {
    if (!(error instanceof QualificationLabError)) {
      throw error;
    }
    return blocked(project.projectRoot, error.code, error.message);
  }

  if (result.terminalState === "release-passed") {
    return success(project.projectRoot, true, result);
  }
  if (result.terminalState === "evidence-verified") {
    return success(project.projectRoot, false, result);
  }
  if (result.terminalState === "reproduction-passed") {
    return success(project.projectRoot, true, result);
  }
  if (result.terminalState === "qualification-drifted") {
    return {
      status: "blocked",
      exitCode: EXIT_BLOCKED,
      projectRoot: project.projectRoot,
      changed: false,
      result,
      error: {
        code: "QUALIFICATION_DRIFTED",
        message:
          "Qualification evidence is intact but its runtime fingerprint is stale.",
      },
    };
  }
  const reproduction =
    result.terminalState === "reproduction-failed";
  return {
    status: "blocked",
    exitCode: EXIT_BLOCKED,
    projectRoot: project.projectRoot,
    changed: true,
    result,
    error: {
      code: reproduction
        ? "QUALIFICATION_REPRODUCTION_MISMATCH"
        : "OFFLINE_QUALIFICATION_MISMATCH",
      message:
        reproduction
          ? "Qualification reproduction observed an unexpected result."
          : "Offline qualification observed unexpected scenario results.",
    },
  };
}

export function inspectProviders(startDirectory, options = {}) {
  const project = requireInstalled(startDirectory, options);
  if (project.error) {
    return project.error;
  }

  let outcome;
  try {
    outcome = runProviderOperation({
      cwd: project.projectRoot,
      projectRoot: project.projectRoot,
      homeDirectory: options.homeDirectory,
      environment: options.environment ?? process.env,
      ...options.provider,
    });
  } catch (error) {
    if (!(error instanceof ProviderLifecycleError)) {
      throw error;
    }
    return blocked(project.projectRoot, error.code, error.message);
  }
  if (outcome.blocked) {
    return {
      status: "blocked",
      exitCode: EXIT_BLOCKED,
      projectRoot: project.projectRoot,
      changed: outcome.changed,
      result: outcome.result,
      error: {
        code: "PROVIDER_QUALIFICATION_FAILED",
        message: "Provider live qualification failed.",
      },
    };
  }
  return success(
    project.projectRoot,
    outcome.changed,
    outcome.result,
  );
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

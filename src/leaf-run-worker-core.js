import { completeLeafRun } from "./leaf-run.js";
import {
  resolveCurrentProviderQualification,
  runProviderOperation,
} from "./provider-lifecycle.js";

function unknownUsage() {
  return {
    schemaVersion: "1",
    source: "pi-message-end",
    status: "unknown",
  };
}

function driftError() {
  const error = new Error(
    "Pi qualification changed before the LeafRun worker started.",
  );
  error.code = "LEAF_RUN_QUALIFICATION_DRIFTED";
  return error;
}

export async function executeLeafRunJob(
  job,
  overrides = {},
) {
  const operations = {
    completeLeafRun,
    resolveCurrentProviderQualification,
    runProviderOperation,
    ...overrides,
  };
  let completion;
  try {
    const qualification =
      operations.resolveCurrentProviderQualification({
        projectRoot: job.projectRoot,
        homeDirectory: job.homeDirectory,
        environment: process.env,
        providerId: job.profile,
      });
    if (
      qualification.fingerprint !==
      job.qualificationFingerprint
    ) {
      throw driftError();
    }
    const execution = operations.runProviderOperation({
      operation: "run",
      projectRoot: job.projectRoot,
      homeDirectory: job.homeDirectory,
      environment: process.env,
      providerId: job.profile,
      activity: job.activity,
      prompt: job.brief,
      allowLive: true,
      expectedQualificationFingerprint:
        job.qualificationFingerprint,
    });
    const result = execution.result;
    const terminalState =
      result.execution.terminalState === "succeeded"
        ? "passed"
        : "failed";
    completion = {
      projectRoot: job.projectRoot,
      homeDirectory: job.homeDirectory,
      intentId: job.intentId,
      runIdentity: job.runIdentity,
      terminalState,
      runtimeUsage:
        result.execution.runtimeUsage ?? unknownUsage(),
      receipt: result.execution.evidence?.index ?? null,
      reason:
        terminalState === "passed"
          ? null
          : execution.errorCode ??
            "provider-execution-failed",
    };
  } catch (error) {
    completion = {
      projectRoot: job.projectRoot,
      homeDirectory: job.homeDirectory,
      intentId: job.intentId,
      runIdentity: job.runIdentity,
      terminalState: "blocked",
      runtimeUsage: unknownUsage(),
      receipt: null,
      reason:
        typeof error?.code === "string"
          ? error.code
          : "provider-execution-blocked",
    };
  }
  return operations.completeLeafRun(completion);
}

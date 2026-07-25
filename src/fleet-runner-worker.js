#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  FleetRunnerError,
  runFleetJob,
} from "./fleet-runner.js";

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new FleetRunnerError(
      "FLEET_INPUT_INVALID",
      `${label} is not valid JSON.`,
    );
  }
}

async function main() {
  const [jobArgument, runsRootArgument, manifestArgument] =
    process.argv.slice(2);
  if (!jobArgument || !runsRootArgument || !manifestArgument) {
    throw new FleetRunnerError(
      "FLEET_USAGE_INVALID",
      "FleetRunner worker requires job, runs root and manifest paths.",
    );
  }
  const jobPath = resolve(jobArgument);
  const manifestPath = resolve(manifestArgument);
  const receipt = await runFleetJob(
    readJson(jobPath, "FleetRunner job"),
    readJson(manifestPath, "FleetRunner manifest"),
    {
      runsRoot: resolve(runsRootArgument),
      manifestDirectory: dirname(manifestPath),
    },
  );
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.status !== "succeeded") {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  const known = error instanceof FleetRunnerError;
  process.stdout.write(
    `${JSON.stringify({
      error: {
        code: known ? error.code : "FLEET_OPERATION_FAILED",
        message: known
          ? error.message
          : "FleetRunner could not complete safely.",
      },
    })}\n`,
  );
  process.exitCode = 1;
});

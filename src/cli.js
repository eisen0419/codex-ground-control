import {
  diagnoseProject,
  initializeProject,
  inspectProviders,
  qualifyProject,
  uninstallProject,
} from "./project-state.js";
import { resolve } from "node:path";

export const VERSION = "0.1.0";
export const EXIT_SUCCESS = 0;
export const EXIT_BLOCKED = 2;
export const EXIT_USAGE = 64;

export const HELP_TEXT = [
  "Usage: codex-ground-control <command> [options]",
  "",
  "Commands:",
  "  init       Initialize Ground Control in the current Git worktree",
  "  doctor     Diagnose the current installation",
  "  qualify    Run the deterministic offline qualification",
  "  provider   Inspect optional provider state",
  "  uninstall  Restore the project to its pre-install state",
  "",
  "Options:",
  "  --json     Emit exactly one JSON receipt",
  "  -h, --help Show this help",
  "  -v, --version Show the version",
  "",
].join("\n");

const COMMANDS = new Map([
  ["init", initializeProject],
  ["doctor", diagnoseProject],
  ["qualify", qualifyProject],
  ["provider", inspectProviders],
  ["uninstall", uninstallProject],
]);

function baseReceipt(command, status, exitCode) {
  return {
    schemaVersion: "1",
    product: "codex-ground-control",
    version: VERSION,
    command,
    status,
    exitCode,
  };
}

function writeJson(output, value) {
  output.write(`${JSON.stringify(value)}\n`);
}

function invalidUsage(commandArgs, json, output, errors) {
  const unknownCommand = commandArgs[0];
  const knownCommand = COMMANDS.has(unknownCommand);
  const message = knownCommand
    ? `Unexpected arguments for command: ${unknownCommand}`
    : `Unknown command: ${unknownCommand}`;
  const code = knownCommand ? "UNEXPECTED_ARGUMENTS" : "UNKNOWN_COMMAND";

  if (json) {
    writeJson(output, {
      ...baseReceipt(null, "invalid-usage", EXIT_USAGE),
      error: { code, message },
    });
    return EXIT_USAGE;
  }

  errors.write(
    `${message}\nRun 'codex-ground-control --help' for usage.\n`,
  );
  return EXIT_USAGE;
}

function renderHuman(result, output, errors) {
  if (result.exitCode !== EXIT_SUCCESS) {
    errors.write(`${result.error.message}\n`);
    return;
  }

  const messages = {
    init:
      result.result.installation === "created"
        ? `Initialized Ground Control in ${result.projectRoot}.`
        : `Ground Control is already initialized in ${result.projectRoot}.`,
    doctor: "Ground Control doctor: passed.",
    qualify: `Offline qualification passed: ${result.result.fixture}.`,
    provider: result.result.summary,
    uninstall:
      result.result.installation === "removed"
        ? `Uninstalled Ground Control from ${result.projectRoot}.`
        : `Ground Control is not installed in ${result.projectRoot}.`,
  };

  output.write(`${messages[result.command]}\n`);
}

function commandArgumentsAreValid(commandArgs) {
  return (
    commandArgs.length === 1 ||
    (commandArgs[0] === "provider" &&
      commandArgs.length === 2 &&
      commandArgs[1] === "list")
  );
}

export function runCli(args, output = process.stdout, errors = process.stderr) {
  const json = args.includes("--json");
  const commandArgs = args.filter((argument) => argument !== "--json");

  if (
    commandArgs.length === 1 &&
    ["-v", "--version"].includes(commandArgs[0])
  ) {
    output.write(`${VERSION}\n`);
    return EXIT_SUCCESS;
  }

  if (
    commandArgs.length === 0 ||
    (commandArgs.length === 1 && ["-h", "--help"].includes(commandArgs[0]))
  ) {
    output.write(HELP_TEXT);
    return EXIT_SUCCESS;
  }

  const command = commandArgs[0];
  const handler = COMMANDS.get(command);
  if (!handler || !commandArgumentsAreValid(commandArgs)) {
    return invalidUsage(commandArgs, json, output, errors);
  }

  let outcome;
  try {
    outcome = handler(process.cwd());
  } catch {
    outcome = {
      status: "blocked",
      exitCode: EXIT_BLOCKED,
      projectRoot: resolve(process.cwd()),
      changed: false,
      error: {
        code: "OPERATION_FAILED",
        message: `${command} could not complete safely.`,
      },
    };
  }
  const receipt = {
    ...baseReceipt(command, outcome.status, outcome.exitCode),
    projectRoot: outcome.projectRoot,
    changed: outcome.changed,
    ...(outcome.result ? { result: outcome.result } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };

  if (json) {
    writeJson(output, receipt);
  } else {
    renderHuman(receipt, output, errors);
  }

  return outcome.exitCode;
}

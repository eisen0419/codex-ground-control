import {
  diagnoseProject,
  initializeProject,
  inspectProviders,
  qualifyProject,
  uninstallProject,
} from "./project-state.js";
import { readSync } from "node:fs";
import { resolve } from "node:path";

export const VERSION = "0.1.0";
export const EXIT_SUCCESS = 0;
export const EXIT_BLOCKED = 2;
export const EXIT_USAGE = 64;

export const HELP_TEXT = [
  "Usage: codex-ground-control <command> [options]",
  "",
  "Commands:",
  "  init       Initialize Ground Control (project-local by default)",
  "  doctor     Diagnose the current installation",
  "  qualify    Run the deterministic offline qualification",
  "  provider   Inspect optional provider state",
  "  uninstall  Restore the managed scope to its pre-install state",
  "",
  "Options:",
  "  --json     Emit exactly one JSON receipt",
  "  --dry-run  Preview init without changing files",
  "  --global   Manage the explicit user-level installation",
  "  --confirm-global Confirm a noninteractive global change",
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

function renderInit(result) {
  if (result.result.installation === "preview") {
    if (result.scope === "global") {
      return renderGlobalPlan(result);
    }
    const { add, update, unchanged } = result.result.plan;
    const group = (label, paths) =>
      [
        `${label}:`,
        ...(paths.length > 0
          ? paths.map((path) => `  ${path}`)
          : ["  (none)"]),
      ].join("\n");
    return [
      "Ground Control init preview:",
      group("Add", add),
      group("Update", update),
      group("Unchanged", unchanged),
    ].join("\n");
  }
  if (result.scope === "global") {
    return result.result.installation === "created"
      ? "Initialized global Ground Control."
      : "Global Ground Control is already initialized.";
  }
  return result.result.installation === "created"
    ? `Initialized Ground Control in ${result.projectRoot}.`
    : `Ground Control is already initialized in ${result.projectRoot}.`;
}

function renderGlobalPlan(result) {
  const plan = result.result.plan;
  const rows = result.command === "uninstall"
    ? [
        ["-", plan.remove],
        ["~", plan.restore],
        ["=", plan.preserve],
      ]
    : [
        ["+", plan.add],
        ["~", plan.update],
        ["=", plan.unchanged],
      ];
  return [
    `Ground Control global ${result.command} preview:`,
    ...rows.flatMap(([prefix, paths]) =>
      paths.length > 0
        ? paths.map((path) => `${prefix} ${path}`)
        : [`${prefix} (none)`]
    ),
  ].join("\n");
}

function renderHuman(result, output, errors) {
  if (result.exitCode !== EXIT_SUCCESS) {
    if (
      result.scope === "global" &&
      result.result?.installation === "preview"
    ) {
      output.write(`${renderGlobalPlan(result)}\n`);
    }
    errors.write(`${result.error.message}\n`);
    return;
  }

  const messages = {
    init: renderInit(result),
    doctor: "Ground Control doctor: passed.",
    qualify: `Offline qualification passed: ${result.result.fixture}.`,
    provider: result.result.summary,
    uninstall:
      result.scope === "global"
        ? result.result.installation === "removed"
          ? "Uninstalled global Ground Control."
          : result.result.installation === "recovered"
            ? "Recovered the interrupted global installation."
            : "Global Ground Control is not installed."
        : result.result.installation === "removed"
          ? `Uninstalled Ground Control from ${result.projectRoot}.`
          : `Ground Control is not installed in ${result.projectRoot}.`,
  };

  output.write(`${messages[result.command]}\n`);
}

function commandArgumentsAreValid(commandArgs) {
  return (
    commandArgs.length === 1 ||
    (commandArgs[0] === "init" &&
      commandArgs.slice(1).every((argument) =>
        ["--dry-run", "--global", "--confirm-global"].includes(argument)
      ) &&
      new Set(commandArgs.slice(1)).size === commandArgs.length - 1 &&
      (!commandArgs.includes("--confirm-global") ||
        commandArgs.includes("--global"))) ||
    (commandArgs[0] === "uninstall" &&
      commandArgs.slice(1).every((argument) =>
        ["--global", "--confirm-global"].includes(argument)
      ) &&
      new Set(commandArgs.slice(1)).size === commandArgs.length - 1 &&
      (!commandArgs.includes("--confirm-global") ||
        commandArgs.includes("--global"))) ||
    (commandArgs[0] === "provider" &&
      commandArgs.length === 2 &&
      commandArgs[1] === "list")
  );
}

function planChanges(command, outcome) {
  const plan = outcome.result?.plan;
  if (!plan) {
    return false;
  }
  return command === "uninstall"
    ? plan.remove.length > 0 || plan.restore.length > 0
    : plan.add.length > 0 || plan.update.length > 0;
}

function defaultConfirmation() {
  const buffer = Buffer.alloc(1024);
  const bytes = readSync(process.stdin.fd, buffer, 0, buffer.length, null);
  return /^(?:y|yes)$/i.test(
    buffer.subarray(0, bytes).toString("utf8").trim(),
  );
}

export function runCli(
  args,
  output = process.stdout,
  errors = process.stderr,
  runtime = {},
) {
  const json = args.includes("--json");
  const commandArgs = args.filter((argument) => argument !== "--json");
  const cwd = runtime.cwd ?? process.cwd();
  const homeDirectory = runtime.homeDirectory ?? process.env.HOME;

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
  let previewRendered = false;
  try {
    const options = {
      dryRun: commandArgs.includes("--dry-run"),
      global: commandArgs.includes("--global"),
      confirmed: commandArgs.includes("--confirm-global"),
      homeDirectory,
    };
    const needsInteractiveGlobalConfirmation =
      options.global &&
      ["init", "uninstall"].includes(command) &&
      !options.dryRun &&
      !options.confirmed;
    if (needsInteractiveGlobalConfirmation) {
      const preview = handler(cwd, {
        ...options,
        dryRun: true,
      });
      const interactive =
        runtime.interactive ??
        Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (
        preview.exitCode === EXIT_SUCCESS &&
        planChanges(command, preview) &&
        !json &&
        interactive
      ) {
        const previewReceipt = {
          ...baseReceipt(command, preview.status, preview.exitCode),
          scope: preview.scope,
          targetRoot: preview.targetRoot,
          changed: false,
          result: preview.result,
        };
        output.write(`${renderGlobalPlan(previewReceipt)}\n`);
        output.write("Apply these global changes? [y/N] ");
        const confirmed = (runtime.confirm ?? defaultConfirmation)();
        output.write("\n");
        previewRendered = true;
        if (!confirmed) {
          outcome = {
            status: "blocked",
            exitCode: EXIT_BLOCKED,
            scope: "global",
            targetRoot: "~",
            changed: false,
            result: preview.result,
            error: {
              code: "GLOBAL_CONFIRMATION_DECLINED",
              message: "Global changes were not confirmed.",
            },
          };
        } else {
          outcome = handler(cwd, {
            ...options,
            confirmed: true,
          });
        }
      } else if (
        preview.exitCode === EXIT_SUCCESS &&
        !planChanges(command, preview)
      ) {
        outcome = handler(cwd, options);
      } else {
        outcome = handler(cwd, options);
      }
    } else {
      outcome = handler(cwd, options);
    }
  } catch {
    const global = commandArgs.includes("--global");
    outcome = {
      status: "blocked",
      exitCode: EXIT_BLOCKED,
      ...(global
        ? { scope: "global", targetRoot: "~" }
        : { projectRoot: resolve(cwd) }),
      changed: false,
      error: {
        code: "OPERATION_FAILED",
        message: `${command} could not complete safely.`,
      },
    };
  }
  const receipt = {
    ...baseReceipt(command, outcome.status, outcome.exitCode),
    ...(outcome.scope ? { scope: outcome.scope } : {}),
    ...(outcome.projectRoot
      ? { projectRoot: outcome.projectRoot }
      : {}),
    ...(outcome.targetRoot ? { targetRoot: outcome.targetRoot } : {}),
    changed: outcome.changed,
    ...(outcome.result ? { result: outcome.result } : {}),
    ...(outcome.error ? { error: outcome.error } : {}),
  };

  if (json) {
    writeJson(output, receipt);
  } else if (
    !previewRendered ||
    outcome.exitCode === EXIT_SUCCESS
  ) {
    renderHuman(receipt, output, errors);
  } else {
    errors.write(`${receipt.error.message}\n`);
  }

  return outcome.exitCode;
}

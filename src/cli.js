import {
  diagnoseProject,
  initializeProject,
  inspectProviders,
  qualifyProject,
  uninstallProject,
} from "./project-state.js";
import { readSync } from "node:fs";
import { resolve } from "node:path";
import {
  validateQualificationDocument,
  validateQualificationReceiptBehavior,
} from "./qualification-contract.js";
import { PACKAGE_VERSION } from "./package-metadata.js";

export const VERSION = PACKAGE_VERSION;
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
  "Qualification:",
  "  qualify",
  "  qualify verify <run-identity> <evidence-anchor>",
  "  qualify reproduce <run-identity> <scenario-id>",
  "",
  "Providers:",
  "  provider list",
  "  provider enable <pi-glm|pi-deepseek|pi-minimax|agy|grok>",
  "  provider disable <pi-glm|pi-deepseek|pi-minimax|agy|grok>",
  "  provider qualify <pi-glm|pi-deepseek|pi-minimax|agy|grok> --allow-live",
  "  provider run <pi-profile> <analysis|exploration|testing|review> <prompt> --allow-live",
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
  const unknownProviderOperation =
    unknownCommand === "provider" &&
    commandArgs.length > 1 &&
    !["list", "enable", "disable", "qualify", "run"].includes(
      commandArgs[1],
    );
  const message = unknownProviderOperation
    ? `Unknown provider operation: ${commandArgs[1]}`
    : knownCommand
      ? `Unexpected arguments for command: ${unknownCommand}`
      : `Unknown command: ${unknownCommand}`;
  const code = unknownProviderOperation
    ? "PROVIDER_OPERATION_INVALID"
    : knownCommand
      ? "UNEXPECTED_ARGUMENTS"
      : "UNKNOWN_COMMAND";

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

function renderDoctor(result) {
  const findings = result.result.findings;
  const groups = [
    [
      `Core (${result.result.gates.core.status}):`,
      findings.filter(
        ({ scope, id }) =>
          scope === "core" && !id.startsWith("provider."),
      ),
    ],
    [
      "Host compatibility:",
      findings.filter(({ scope }) => scope === "host"),
    ],
    [
      "Optional providers:",
      findings.filter(({ id }) => id.startsWith("provider.")),
    ],
    [
      "Fail-closed boundaries:",
      findings.filter(
        ({ scope, id }) =>
          ["native", "write"].includes(scope) ||
          id.startsWith("gate."),
      ),
    ],
  ];
  return [
    `Ground Control doctor: ${result.result.health} (${result.result.scope})`,
    ...groups.flatMap(([heading, entries]) => [
      heading,
      ...entries.map(
        ({ state, id, observed, action }) =>
          `  ${state.toUpperCase()} ${id}: ${observed}` +
          (state === "healthy" || state === "blocked"
            ? ""
            : `; next: ${action}`),
      ),
    ]),
  ].join("\n");
}

function renderQualification(result) {
  if (result.result.operation === "verify") {
    return `Qualification evidence verified: ${result.result.runIdentity}.`;
  }
  if (result.result.operation === "reproduce") {
    return (
      `Qualification reproduction passed: ${result.result.campaign} ` +
      `(${result.result.counts.passed}/${result.result.counts.total}); ` +
      `run ${result.result.runIdentity}; not a release qualification.`
    );
  }
  return (
    `Offline qualification passed: ${result.result.campaign} ` +
    `(${result.result.counts.passed}/${result.result.counts.total}); ` +
    `run ${result.result.runIdentity}; ` +
    `evidence ${result.result.evidence.anchor}.`
  );
}

function renderProvider(result) {
  const providers = result.result.providers ??
    [result.result.provider];
  const yesNo = (value) => value ? "yes" : "no";
  const yesNoUnknown = (value) =>
    value === null ? "unknown" : yesNo(value);
  return [
    "Ground Control providers:",
    ...providers.map(
      (provider) =>
        `  ${provider.id}: ${provider.decision} ` +
        `(${provider.reason ?? "qualification-current"}); ` +
        `detected=${yesNo(provider.detected)} ` +
        `authenticated=${yesNoUnknown(provider.authenticated)} ` +
        `configured=${yesNo(provider.configured)} ` +
        `enabled=${yesNo(provider.enabled)} ` +
        `qualified=${yesNo(provider.qualified)} ` +
        `current=${yesNo(provider.current)} ` +
        `run-authorized=${yesNo(provider.runAuthorized)} ` +
        `drifted=${yesNo(provider.drifted)} ` +
        `disabled=${yesNo(provider.disabled)} ` +
        `blocked=${yesNo(provider.blocked)}` +
        (provider.family === "pi"
          ? ` identity=${provider.modelProvider}/${provider.model}`
          : "") +
        (provider.role === "research-only"
          ? ` role=${provider.role} surface=${provider.researchSurface}` +
            ` mode=${provider.mode} model=${provider.model}`
          : ""),
    ),
    ...(result.result.operation === "run" &&
    result.result.candidate?.output
      ? [
          "Candidate evidence: " +
            JSON.stringify(result.result.candidate.output.summary),
          ...result.result.candidate.output.findings.map(
            (finding) => `  finding: ${JSON.stringify(finding)}`,
          ),
          ...result.result.candidate.output.suggestedChecks.map(
            (check) =>
              `  suggested check: ${JSON.stringify(check)}`,
          ),
          "Authority: codex-main review required; no workspace changes applied.",
        ]
      : []),
    `Decision: ${result.result.summary}`,
  ].join("\n");
}

function renderHuman(result, output, errors) {
  if (result.command === "doctor" && result.result?.findings) {
    output.write(`${renderDoctor(result)}\n`);
    if (result.exitCode !== EXIT_SUCCESS) {
      errors.write(`${result.error.message}\n`);
    }
    return;
  }
  if (
    result.command === "provider" &&
    (result.result?.providers || result.result?.provider)
  ) {
    output.write(`${renderProvider(result)}\n`);
    if (result.exitCode !== EXIT_SUCCESS) {
      errors.write(`${result.error.message}\n`);
    }
    return;
  }
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
    qualify:
      result.command === "qualify"
        ? renderQualification(result)
        : null,
    provider:
      result.command === "provider"
        ? renderProvider(result)
        : null,
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

function qualificationArguments(commandArgs) {
  if (commandArgs.length === 1) {
    return { operation: "run" };
  }
  if (
    commandArgs.length === 4 &&
    commandArgs[1] === "verify" &&
    /^[a-zA-Z0-9-]+$/.test(commandArgs[2]) &&
    /^[0-9a-f]{64}$/.test(commandArgs[3])
  ) {
    return {
      operation: "verify",
      runIdentity: commandArgs[2],
      anchor: commandArgs[3],
    };
  }
  if (
    commandArgs.length === 4 &&
    commandArgs[1] === "reproduce" &&
    /^[a-zA-Z0-9-]+$/.test(commandArgs[2]) &&
    /^[a-z0-9][a-z0-9-]{0,79}$/.test(commandArgs[3])
  ) {
    return {
      operation: "reproduce",
      sourceRun: commandArgs[2],
      scenarioId: commandArgs[3],
    };
  }
  return null;
}

function providerArguments(commandArgs) {
  if (
    commandArgs.length === 1 ||
    (commandArgs.length === 2 && commandArgs[1] === "list")
  ) {
    return { operation: "list" };
  }
  if (
    commandArgs.length === 3 &&
    ["enable", "disable"].includes(commandArgs[1])
  ) {
    return {
      operation: commandArgs[1],
      providerId: commandArgs[2],
    };
  }
  if (
    (commandArgs.length === 3 ||
      (commandArgs.length === 4 &&
        commandArgs[3] === "--allow-live")) &&
    commandArgs[1] === "qualify"
  ) {
    return {
      operation: "qualify",
      providerId: commandArgs[2],
      allowLive: commandArgs.includes("--allow-live"),
    };
  }
  if (
    (commandArgs.length === 5 ||
      (commandArgs.length === 6 &&
        commandArgs[5] === "--allow-live")) &&
    commandArgs[1] === "run" &&
    commandArgs[4] !== "--allow-live"
  ) {
    return {
      operation: "run",
      providerId: commandArgs[2],
      activity: commandArgs[3],
      prompt: commandArgs[4],
      allowLive: commandArgs.includes("--allow-live"),
    };
  }
  return null;
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
    (commandArgs[0] === "doctor" &&
      commandArgs.length === 2 &&
      commandArgs[1] === "--global") ||
    (commandArgs[0] === "provider" &&
      providerArguments(commandArgs) !== null) ||
    (commandArgs[0] === "qualify" &&
      qualificationArguments(commandArgs) !== null)
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
      qualification:
        command === "qualify"
          ? qualificationArguments(commandArgs)
          : undefined,
      provider:
        command === "provider"
          ? providerArguments(commandArgs)
          : undefined,
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
  let receipt = {
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
  if (command === "qualify") {
    let receiptValid = false;
    try {
      const schema = validateQualificationDocument(
        "receipt",
        receipt,
      );
      const behavior =
        validateQualificationReceiptBehavior(receipt);
      receiptValid = schema.valid && behavior.valid;
    } catch {
      receiptValid = false;
    }
    if (!receiptValid) {
      receipt = {
        ...baseReceipt("qualify", "blocked", EXIT_BLOCKED),
        projectRoot: resolve(cwd),
        changed: false,
        error: {
          code: "QUALIFICATION_RECEIPT_INVALID",
          message:
            "Qualification could not produce a valid public receipt.",
        },
      };
    }
  }

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

  return receipt.exitCode;
}

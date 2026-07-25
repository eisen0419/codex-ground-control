import { spawnSync } from "node:child_process";
import { inspectFile } from "./safe-files.js";
import { providerDefinitions } from "./provider-lifecycle.js";

const VERSION_ENVIRONMENT_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "TERM",
  "NO_COLOR",
  "NODE_OPTIONS",
];

function finding(
  id,
  severity,
  state,
  scope,
  observed,
  action,
) {
  return {
    id,
    severity,
    state,
    scope,
    observed,
    action,
  };
}

function publicVersion(command, options) {
  const environment = {};
  for (const name of VERSION_ENVIRONMENT_KEYS) {
    if (
      Object.hasOwn(options.environment, name) &&
      options.environment[name] !== undefined
    ) {
      environment[name] = options.environment[name];
    }
  }
  const result = (options.spawn ?? spawnSync)(
    command,
    ["--version"],
    {
      cwd: options.cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: 64 * 1024,
      shell: false,
      timeout: 5_000,
    },
  );
  if (result.error?.code === "ENOENT") {
    return { state: "missing" };
  }
  if (
    result.error ||
    result.status !== 0 ||
    result.signal
  ) {
    return { state: "incompatible" };
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const version = output.match(
    /(?:^|[^0-9])v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9])/m,
  )?.[1];
  return version
    ? { state: "healthy", version }
    : { state: "incompatible" };
}

function hookCount(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const hooks =
    value.hooks && typeof value.hooks === "object"
      ? value.hooks
      : value;
  let count = 0;
  for (const entries of Object.values(hooks)) {
    if (Array.isArray(entries)) {
      count += entries.length;
    }
  }
  return count;
}

function inspectHooks(homeDirectory) {
  try {
    const file = inspectFile(homeDirectory, ".codex/hooks.json");
    if (file.state === "absent") {
      return finding(
        "runtime.hooks",
        "info",
        "healthy",
        "core",
        "no hooks file",
        "No action required.",
      );
    }
    let parsed;
    try {
      parsed = JSON.parse(file.contents.toString("utf8"));
    } catch {
      return finding(
        "runtime.hooks",
        "error",
        "conflicted",
        "core",
        "hooks file is invalid",
        "Repair or remove ~/.codex/hooks.json, then run doctor again.",
      );
    }
    const count = hookCount(parsed);
    if (count === null) {
      return finding(
        "runtime.hooks",
        "error",
        "conflicted",
        "core",
        "hooks file has an unsupported shape",
        "Review ~/.codex/hooks.json and remove unexpected hook configuration.",
      );
    }
    if (count > 0) {
      return finding(
        "runtime.hooks",
        "error",
        "conflicted",
        "core",
        `${count} ambient hook group${count === 1 ? "" : "s"} configured`,
        "Disable unrelated hooks while qualifying Ground Control.",
      );
    }
    return finding(
      "runtime.hooks",
      "info",
      "healthy",
      "core",
      "no ambient hooks configured",
      "No action required.",
    );
  } catch {
    return finding(
      "runtime.hooks",
      "error",
      "conflicted",
      "core",
      "hooks path is unsafe",
      "Replace symlinked or unsafe ~/.codex hook paths, then run doctor again.",
    );
  }
}

function stripTomlComment(line) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\" && quote === '"') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "#") {
      return line.slice(0, index);
    }
  }
  return line;
}

function enabledRuntimeEntries(contents) {
  let section = "";
  const enabled = new Set();
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const sectionMatch = line.match(/^\[([A-Za-z0-9_.-]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }
    const assignment = line.match(
      /^([A-Za-z0-9_.-]+)\s*=\s*(true|false)\s*$/,
    );
    if (!assignment || assignment[2] !== "true") {
      continue;
    }
    const key = assignment[1].includes(".")
      ? assignment[1]
      : `${section}.${assignment[1]}`.replace(/^\./, "");
    if (
      key === "agents.enabled" ||
      key === "features.multi_agent"
    ) {
      enabled.add(key);
    }
  }
  return [...enabled].sort();
}

export function inspectNativeRuntimeBoundary(homeDirectory) {
  try {
    const file = inspectFile(homeDirectory, ".codex/config.toml");
    if (file.state === "absent") {
      return {
        status: "blocked",
        enabledEntryPoints: [],
      };
    }
    const enabledEntryPoints = enabledRuntimeEntries(
      file.contents.toString("utf8"),
    );
    return {
      status:
        enabledEntryPoints.length === 0 ? "blocked" : "enabled",
      enabledEntryPoints,
    };
  } catch {
    return {
      status: "conflicted",
      enabledEntryPoints: [],
    };
  }
}

function inspectCodexConfig(homeDirectory) {
  const boundary = inspectNativeRuntimeBoundary(homeDirectory);
  if (boundary.status === "enabled") {
    return finding(
      "runtime.codex-config",
      "critical",
      "conflicted",
      "native",
      `${boundary.enabledEntryPoints.join(" and ")} enabled`,
      "Set agents.enabled and features.multi_agent to false, then start a fresh Codex session.",
    );
  }
  if (boundary.status === "conflicted") {
    return finding(
      "runtime.codex-config",
      "critical",
      "conflicted",
      "native",
      "Codex config path is unsafe",
      "Replace symlinked or unsafe ~/.codex config paths, then run doctor again.",
    );
  }
  return finding(
    "runtime.codex-config",
    "info",
    "healthy",
    "core",
    "native entry points are not enabled",
    "No action required.",
  );
}

function providerFinding(provider, version, credentialState) {
  if (version.state === "missing") {
    return finding(
      `provider.${provider.id}`,
      "info",
      "optional-unavailable",
      provider.id,
      "CLI not found",
      `Install ${provider.command} only if this optional provider is needed.`,
    );
  }
  if (version.state === "incompatible") {
    return finding(
      `provider.${provider.id}`,
      "warning",
      "incompatible",
      provider.id,
      "public version unavailable",
      `Repair or upgrade ${provider.command}; detection does not authorize execution.`,
    );
  }
  return finding(
    `provider.${provider.id}`,
    "info",
    "detected",
    provider.id,
    `CLI ${version.version} detected; credentials ${credentialState}`,
    "Run explicit live qualification before enabling this provider.",
  );
}

const INSTALLATION_CHECKS = [
  {
    id: "installation.manifest",
    label: "installation manifest",
    action: "Run codex-ground-control init, then run doctor again.",
  },
  {
    id: "installation.managed-block",
    label: "managed instructions",
    action: "Restore the managed instructions or uninstall safely before reinstalling.",
  },
  {
    id: "installation.release-lock",
    label: "release lock",
    action: "Restore the installed release metadata or reinstall safely.",
  },
  {
    id: "installation.skills",
    label: "managed skills",
    action: "Restore the managed skill bytes or uninstall safely before reinstalling.",
  },
];

function installationIssueId(error) {
  const message = error?.message ?? "";
  if (/managed block|AGENTS\.md|instructions/i.test(message)) {
    return "installation.managed-block";
  }
  if (/release-lock|release lock|license/i.test(message)) {
    return "installation.release-lock";
  }
  if (/workflow asset|global workflow asset|skill/i.test(message)) {
    return "installation.skills";
  }
  return "installation.manifest";
}

function installationIssueState(error) {
  if (error?.code === "INSTALLATION_NOT_FOUND") {
    return "missing";
  }
  if (/drifted|modified|missing/i.test(error?.message ?? "")) {
    return "drifted";
  }
  return "conflicted";
}

function unavailableInstallationFindings(error) {
  const issueId = error ? installationIssueId(error) : null;
  const issueState = error ? installationIssueState(error) : "blocked";
  return INSTALLATION_CHECKS.map((check) => {
    const state = check.id === issueId ? issueState : "blocked";
    const managedBoundaryFailed =
      check.id === "installation.managed-block" &&
      state !== "blocked";
    return finding(
      check.id,
      state === "blocked"
        ? "warning"
        : managedBoundaryFailed
          ? "critical"
          : "error",
      state,
      "core",
      state === "blocked"
        ? `${check.label} not checked`
        : `${check.label} ${state}`,
      state === "blocked"
        ? "Resolve earlier core blockers, then run doctor again."
        : check.action,
    );
  });
}

function installationFindings(installation, error) {
  if (!installation) {
    return unavailableInstallationFindings(error);
  }
  return [
    finding(
      "installation.manifest",
      "info",
      "healthy",
      "core",
      "manifest verified",
      "No action required.",
    ),
    finding(
      "installation.managed-block",
      "info",
      "healthy",
      "core",
      "managed instructions verified",
      "No action required.",
    ),
    finding(
      "installation.release-lock",
      "info",
      "healthy",
      "core",
      `release ${installation.releaseLock.revision} verified`,
      "No action required.",
    ),
    finding(
      "installation.skills",
      "info",
      "healthy",
      "core",
      `${installation.assets.count} managed assets verified`,
      "No action required.",
    ),
  ];
}

export function diagnoseRuntime(options) {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0], 10);
  const codex = publicVersion("codex", {
    ...options,
    environment,
  });
  const findings = [
    platform === "darwin"
      ? finding(
          "platform.macos",
          "info",
          "healthy",
          "core",
          "macOS",
          "No action required.",
        )
      : finding(
          "platform.macos",
          "error",
          "incompatible",
          "core",
          platform,
          "Run Ground Control v0.1 on macOS.",
        ),
    Number.isInteger(nodeMajor) && nodeMajor >= 22
      ? finding(
          "runtime.node",
          "info",
          "healthy",
          "core",
          `Node.js ${nodeVersion}`,
          "No action required.",
        )
      : finding(
          "runtime.node",
          "error",
          "incompatible",
          "core",
          `Node.js ${nodeVersion}`,
          "Install Node.js 22 or newer.",
        ),
    options.gitWorktree === false
      ? finding(
          "git.worktree",
          "error",
          "missing",
          "core",
          "no Git worktree",
          "Run doctor from inside the Git worktree you intend to use.",
        )
      : finding(
          "git.worktree",
          "info",
          "healthy",
          "core",
          "Git worktree detected",
          "No action required.",
        ),
    codex.state === "healthy"
      ? finding(
          "codex.cli",
          "info",
          "healthy",
          "core",
          `Codex CLI ${codex.version}`,
          "No action required.",
        )
      : finding(
          "codex.cli",
          "error",
          codex.state,
          "core",
          codex.state === "missing"
            ? "Codex CLI not found"
            : "Codex CLI version unavailable",
          "Install or repair the Codex CLI, then run doctor again.",
        ),
    ...installationFindings(
      options.installation,
      options.installationError,
    ),
    inspectHooks(options.homeDirectory),
    inspectCodexConfig(options.homeDirectory),
  ];
  const gates = {};
  for (const provider of providerDefinitions) {
    const version = publicVersion(provider.command, {
      ...options,
      environment,
    });
    const credentialState = provider.credentialVariables.some(
      (name) => Object.hasOwn(environment, name),
    )
      ? "present in environment"
      : "not observed";
    findings.push(
      providerFinding(provider, version, credentialState),
    );
    gates[provider.id] = {
      status:
        version.state === "healthy" ? "disabled" : "unavailable",
      availability:
        version.state === "healthy" ? "detected" : version.state,
      credential: credentialState,
      qualification: "unqualified",
      enabled: false,
      findingIds: [`provider.${provider.id}`],
    };
  }
  const nativeEntryConflict = findings.some(
    ({ scope, state }) =>
      scope === "native" && state !== "healthy",
  );
  const writeBoundaryConflict = findings.some(
    ({ id, state }) =>
      id === "installation.managed-block" &&
      state !== "healthy",
  );
  findings.push(
    nativeEntryConflict
      ? finding(
          "gate.native",
          "critical",
          "conflicted",
          "native",
          "native entry point enabled; execution remains blocked",
          "Disable native entry points and start a fresh Codex session.",
        )
      : finding(
          "gate.native",
          "info",
          "blocked",
          "native",
          "blocked by v0.1 policy",
          "Keep native subagents disabled.",
        ),
    writeBoundaryConflict
      ? finding(
          "gate.write",
          "critical",
          "conflicted",
          "write",
          "external write boundary cannot be verified",
          "Restore the Ground Control managed instructions before execution.",
        )
      : finding(
          "gate.write",
          "info",
          "blocked",
          "write",
          "zero external writers",
          "Keep external workspace writes disabled.",
        ),
  );

  const coreFindingIds = findings
    .filter(({ scope }) => scope === "core")
    .filter(({ state }) => state !== "healthy")
    .map(({ id }) => id);
  const nativeConflictIds = findings
    .filter(
      ({ scope, state }) =>
        scope === "native" && state !== "blocked",
    )
    .map(({ id }) => id);
  const writeConflictIds = findings
    .filter(
      ({ id, scope, state }) =>
        (id === "installation.managed-block" ||
          scope === "write") &&
        state !== "healthy" &&
        state !== "blocked",
    )
    .map(({ id }) => id);
  const blockingFindingIds = [
    ...coreFindingIds,
    ...nativeConflictIds,
  ];
  gates.core = {
    status: blockingFindingIds.length === 0 ? "passed" : "blocked",
    findingIds: blockingFindingIds,
  };
  gates.native = {
    status: "blocked",
    expected: nativeConflictIds.length === 0,
    findingIds:
      nativeConflictIds.length > 0
        ? nativeConflictIds
        : ["gate.native"],
  };
  gates.write = {
    status: "blocked",
    expected: writeConflictIds.length === 0,
    findingIds:
      writeConflictIds.length > 0
        ? writeConflictIds
        : ["gate.write"],
  };

  return {
    schemaVersion: "1",
    health:
      blockingFindingIds.length === 0 ? "healthy" : "blocked",
    scope: options.scope,
    findings,
    gates: {
      core: gates.core,
      pi: gates.pi,
      agy: gates.agy,
      grok: gates.grok,
      native: gates.native,
      write: gates.write,
    },
  };
}

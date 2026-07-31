import { join } from "node:path";

const commonEnvironmentNames = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
]);
const liveProfileEnvironmentNames = Object.freeze([
  "PI_CODING_AGENT_DIR",
  "ZAI_CODING_CN_API_KEY",
]);

function requiredString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value;
}

function selectEnvironment(source, names) {
  const selected = {};
  for (const name of names) {
    if (
      typeof source?.[name] === "string" &&
      source[name] !== ""
    ) {
      selected[name] = source[name];
    }
  }
  return selected;
}

export function createPiInvocation(options) {
  const root = requiredString(options?.root, "root");
  requiredString(options?.sessionId, "sessionId");
  const allowLive = options?.allowLive === true;
  const inheritedEnvironment =
    options?.environment ?? process.env;
  const sessionDirectory = join(root, "sessions");
  const environment = selectEnvironment(
    inheritedEnvironment,
    allowLive
      ? [
          ...commonEnvironmentNames,
          ...liveProfileEnvironmentNames,
        ]
      : commonEnvironmentNames,
  );
  if (allowLive) {
    requiredString(
      environment.HOME,
      "environment.HOME",
    );
  }

  return {
    sessionDirectory,
    env: {
      ...environment,
      PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      PI_TELEMETRY: "0",
      ...(allowLive
        ? {}
        : {
            HOME: root,
            PI_CODING_AGENT_DIR: join(root, "agent"),
            PI_OFFLINE: "1",
          }),
    },
    args: [
      "--thinking",
      "off",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-approve",
      "--session-dir",
      sessionDirectory,
      ...(allowLive ? [] : ["--offline"]),
    ],
  };
}

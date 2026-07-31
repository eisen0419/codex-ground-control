#!/usr/bin/env node

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createLeafProductionMcpAppServer,
} from "./mcp-app-server.js";

const PROFILE_ENVIRONMENT_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "PI_CODING_AGENT_DIR",
  "ZAI_CODING_CN_API_KEY",
]);
const SESSION_ID_REGEXP =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function selectedEnvironment(environment) {
  const selected = {};
  for (const name of PROFILE_ENVIRONMENT_ALLOWLIST) {
    const descriptor = Object.getOwnPropertyDescriptor(
      environment,
      name,
    );
    if (
      descriptor &&
      Object.hasOwn(descriptor, "value") &&
      typeof descriptor.value === "string" &&
      descriptor.value !== ""
    ) {
      selected[name] = descriptor.value;
    }
  }
  return selected;
}

function ensurePrivateStateParent(rootDirectory) {
  const parent = dirname(rootDirectory);
  try {
    mkdirSync(parent, { mode: 0o700 });
    chmodSync(parent, 0o700);
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new TypeError(
        "v0.3 production state parent could not be created safely.",
      );
    }
  }
  let metadata;
  try {
    metadata = lstatSync(parent);
  } catch {
    throw new TypeError(
      "v0.3 production state parent could not be inspected safely.",
    );
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory()
  ) {
    throw new TypeError(
      "v0.3 production state parent must be a regular directory.",
    );
  }
}

export function createLeafProductionEntryOptions(
  environment = process.env,
) {
  if (
    environment === null ||
    Array.isArray(environment) ||
    typeof environment !== "object"
  ) {
    throw new TypeError(
      "v0.3 production entry environment must be an object.",
    );
  }
  const inherited = selectedEnvironment(environment);
  if (
    typeof inherited.HOME !== "string" ||
    !isAbsolute(inherited.HOME)
  ) {
    throw new TypeError(
      "v0.3 production entry requires an absolute HOME.",
    );
  }
  const homeDirectory = resolve(inherited.HOME);
  if (dirname(homeDirectory) === homeDirectory) {
    throw new TypeError(
      "v0.3 production entry requires a bounded HOME.",
    );
  }
  inherited.HOME = homeDirectory;
  const rootDirectory = join(
    homeDirectory,
    ".codex-ground-control",
    "v0.3",
  );
  return Object.freeze({
    rootDirectory,
    command: "pi",
    profiles: Object.freeze({
      "pi-glm": Object.freeze({
        adapterId: "pi-rpc",
        modelProvider: "zai-coding-cn",
        model: "glm-5.2",
        environment: Object.freeze(inherited),
        environmentAllowlist: PROFILE_ENVIRONMENT_ALLOWLIST,
      }),
    }),
    sessionDirectoryFromSessionId(sessionId) {
      if (
        typeof sessionId !== "string" ||
        !SESSION_ID_REGEXP.test(sessionId)
      ) {
        throw new TypeError(
          "v0.3 production entry session identity is invalid.",
        );
      }
      return join(rootDirectory, "pi-sessions", sessionId);
    },
  });
}

export async function runLeafProductionMcpAppServer({
  environment = process.env,
} = {}) {
  const productionOptions =
    createLeafProductionEntryOptions(environment);
  ensurePrivateStateParent(productionOptions.rootDirectory);
  const server =
    createLeafProductionMcpAppServer(productionOptions);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

function isMainModule(
  moduleUrl,
  scriptArgument = process.argv[1],
) {
  if (!scriptArgument) {
    return false;
  }
  try {
    return (
      realpathSync(fileURLToPath(moduleUrl)) ===
      realpathSync(scriptArgument)
    );
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url)) {
  runLeafProductionMcpAppServer().catch((error) => {
    console.error(
      error instanceof Error ? error.message : String(error),
    );
    process.exitCode = 1;
  });
}

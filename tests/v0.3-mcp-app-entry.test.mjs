import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { GROUND_CONTROL_V03_WIDGET_URI } from "../src/v0.3/mcp-app-server.js";
import {
  createLeafProductionEntryOptions,
} from "../src/v0.3/mcp-app-entry.js";

async function allFileText(directory) {
  const chunks = [];
  async function visit(current) {
    for (const entry of await readdir(current, {
      withFileTypes: true,
    })) {
      const target = join(current, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile()) {
        chunks.push(await readFile(target, "utf8"));
      }
    }
  }
  await visit(directory);
  return chunks.join("\n");
}

test("v0.3 production entry derives only the bounded Pi profile and private state paths", async (t) => {
  const sandbox = await mkdtemp(
    join(tmpdir(), "ground-control-v03-entry-options-"),
  );
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const options = createLeafProductionEntryOptions(
    {
      HOME: sandbox,
      PATH: "/safe/bin",
      LANG: "zh_CN.UTF-8",
      ZAI_CODING_CN_API_KEY: "provider-owned-secret",
      AMBIENT_CREDENTIAL: "must-not-cross",
    },
    sandbox,
  );

  assert.equal(
    options.rootDirectory,
    join(sandbox, ".codex-ground-control", "v0.3"),
  );
  assert.equal(options.command, "pi");
  assert.equal(
    options.hostWorkingDirectory,
    sandbox,
  );
  assert.deepEqual(
    options.profiles["pi-glm"],
    {
      adapterId: "pi-rpc",
      modelProvider: "zai-coding-cn",
      model: "glm-5.2",
      environment: {
        PATH: "/safe/bin",
        HOME: sandbox,
        LANG: "zh_CN.UTF-8",
        ZAI_CODING_CN_API_KEY: "provider-owned-secret",
      },
      environmentAllowlist: [
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
      ],
    },
  );
  assert.equal(
    options.sessionDirectoryFromSessionId(
      "00000000-0000-4000-8000-000000000306",
    ),
    join(
      sandbox,
      ".codex-ground-control",
      "v0.3",
      "pi-sessions",
      "00000000-0000-4000-8000-000000000306",
    ),
  );
  assert.equal(
    JSON.stringify(options).includes("AMBIENT_CREDENTIAL"),
    false,
  );
  assert.throws(
    () => createLeafProductionEntryOptions({ HOME: "relative" }),
    /HOME/,
  );
  assert.throws(
    () => createLeafProductionEntryOptions({ HOME: "/" }),
    /HOME/,
  );
  assert.throws(
    () => createLeafProductionEntryOptions({ HOME: "/tmp/.." }),
    /HOME/,
  );
});

test("opt-in v0.3 stdio entry lists tools and reads the production widget without starting Pi", async (t) => {
  const sandbox = await mkdtemp(
    join(tmpdir(), "ground-control-v03-stdio-"),
  );
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const legacyStateParent = join(
    sandbox,
    ".codex-ground-control",
  );
  await mkdir(legacyStateParent, { mode: 0o755 });
  await chmod(legacyStateParent, 0o755);
  const defaultConfig = JSON.parse(
    await readFile(new URL("../.mcp.json", import.meta.url), "utf8"),
  );
  const optInConfig = JSON.parse(
    await readFile(
      new URL("../.mcp.v0.3.json", import.meta.url),
      "utf8",
    ),
  );
  assert.deepEqual(
    defaultConfig.mcpServers["codex-ground-control"].args,
    ["src/mcp-app-server.js"],
  );
  assert.deepEqual(
    optInConfig.mcpServers["codex-ground-control-v0.3"].args,
    ["src/v0.3/mcp-app-entry.js"],
  );

  const inheritedPath = process.env.PATH;
  assert.ok(inheritedPath);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["src/v0.3/mcp-app-entry.js"],
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env: {
      HOME: sandbox,
      PATH: inheritedPath,
      TMPDIR: tmpdir(),
      LANG: "C.UTF-8",
      ZAI_CODING_CN_API_KEY: "must-not-persist",
    },
    stderr: "pipe",
  });
  const client = new Client({
    name: "ground-control-v0.3-entry-test",
    version: "0.3.0",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  t.after(() => client.close());
  await client.connect(transport);

  const tools = await client.listTools();
  assert.deepEqual(
    tools.tools.map(({ name }) => name),
    [
      "delegate_leaf",
      "inspect_leaf",
      "cancel_leaf",
      "render_leaf_card",
    ],
  );
  const resource = await client.readResource({
    uri: GROUND_CONTROL_V03_WIDGET_URI,
  });
  assert.match(
    resource.contents[0].text,
    /data-ground-control-layout="compact-progress"/,
  );
  await client.close();

  const stateRoot = join(
    sandbox,
    ".codex-ground-control",
    "v0.3",
  );
  assert.equal((await stat(stateRoot)).mode & 0o777, 0o700);
  assert.equal(
    (await readdir(stateRoot)).includes("pi-sessions"),
    false,
  );
  assert.equal(
    (await allFileText(stateRoot)).includes("must-not-persist"),
    false,
  );
  assert.equal(stderr, "");
});

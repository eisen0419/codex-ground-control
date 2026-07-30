#!/usr/bin/env node

import assert from "node:assert/strict";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  PROTOTYPE_WIDGET_URI,
  createPrototypeMcpServer,
  readPrototypeSnapshot,
  readPrototypeWidget,
} from "./server.mjs";
import {
  findCompletedMcpToolCall,
  requireExclusiveMcpToolCall,
} from "./host-evidence.mjs";

const pluginManifest = JSON.parse(
  readFileSync(new URL("./.mcp.json", import.meta.url), "utf8"),
);
assert.deepEqual(
  pluginManifest.mcpServers["ground-control-v0-3-host-spike"],
  {
    command: "node",
    args: ["standalone-server.mjs"],
    cwd: ".",
  },
);

const expectedHostToolCall = {
  method: "item/completed",
  params: {
    threadId: "thread-301",
    turnId: "turn-301",
    item: {
      type: "mcpToolCall",
      server: "ground-control-v0-3-host-spike",
      tool: "render_leaf_card_prototype",
      status: "completed",
    },
  },
};
assert.equal(
  findCompletedMcpToolCall(
    [
      {
        method: "turn/completed",
        params: {
          threadId: "thread-301",
          turn: { id: "turn-301", status: "completed" },
        },
      },
      expectedHostToolCall,
    ],
    {
      threadId: "thread-301",
      turnId: "turn-301",
      server: "ground-control-v0-3-host-spike",
      tool: "render_leaf_card_prototype",
    },
  ),
  expectedHostToolCall,
);
assert.equal(
  requireExclusiveMcpToolCall(
    [
      {
        method: "item/completed",
        params: {
          threadId: "thread-301",
          turnId: "turn-301",
          item: {
            type: "agentMessage",
          },
        },
      },
      expectedHostToolCall,
    ],
    {
      threadId: "thread-301",
      turnId: "turn-301",
      server: "ground-control-v0-3-host-spike",
      tool: "render_leaf_card_prototype",
    },
  ),
  expectedHostToolCall,
);
assert.equal(
  findCompletedMcpToolCall(
    [
      {
        ...expectedHostToolCall,
        params: {
          ...expectedHostToolCall.params,
          item: {
            ...expectedHostToolCall.params.item,
            tool: "inspect_leaf_prototype",
          },
        },
      },
    ],
    {
      threadId: "thread-301",
      turnId: "turn-301",
      server: "ground-control-v0-3-host-spike",
      tool: "render_leaf_card_prototype",
    },
  ),
  null,
);
assert.throws(
  () =>
    requireExclusiveMcpToolCall(
      [
        {
          method: "turn/completed",
          params: {
            threadId: "thread-301",
            turn: { id: "turn-301", status: "completed" },
          },
        },
      ],
      {
        threadId: "thread-301",
        turnId: "turn-301",
        server: "ground-control-v0-3-host-spike",
        tool: "render_leaf_card_prototype",
      },
    ),
  /Host turn did not complete the required target tool/,
);
assert.throws(
  () =>
    requireExclusiveMcpToolCall(
      [
        expectedHostToolCall,
        {
          method: "item/completed",
          params: {
            threadId: "thread-301",
            turnId: "turn-301",
            item: {
              type: "commandExecution",
              status: "completed",
            },
          },
        },
      ],
      {
        threadId: "thread-301",
        turnId: "turn-301",
        server: "ground-control-v0-3-host-spike",
        tool: "render_leaf_card_prototype",
      },
    ),
  /Host turn used another action besides the target tool/,
);

const server = createPrototypeMcpServer();
const client = new Client(
  {
    name: "ground-control-v0-3-host-validator",
    version: "0.3.0-alpha.1",
  },
  {
    capabilities: {},
  },
);
const [clientTransport, serverTransport] =
  InMemoryTransport.createLinkedPair();

try {
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  const listed = await client.listTools();
  assert.deepEqual(
    listed.tools.map(({ name }) => name).sort(),
    [
      "inspect_leaf_prototype",
      "render_leaf_card_prototype",
    ],
  );

  const inspectDefinition = listed.tools.find(
    ({ name }) => name === "inspect_leaf_prototype",
  );
  const renderDefinition = listed.tools.find(
    ({ name }) => name === "render_leaf_card_prototype",
  );
  for (const definition of listed.tools) {
    assert.equal(definition.annotations.readOnlyHint, true);
    assert.equal(definition.annotations.destructiveHint, false);
    assert.equal(definition.annotations.openWorldHint, false);
    assert.equal(definition.annotations.idempotentHint, true);
  }
  assert.equal(
    inspectDefinition._meta?.ui?.resourceUri,
    undefined,
  );
  assert.equal(
    renderDefinition._meta.ui.resourceUri,
    PROTOTYPE_WIDGET_URI,
  );

  const resource = await client.readResource({
    uri: PROTOTYPE_WIDGET_URI,
  });
  assert.equal(resource.contents.length, 1);
  assert.equal(
    resource.contents[0].mimeType,
    "text/html;profile=mcp-app",
  );
  assert.equal(
    resource.contents[0]._meta.ui.csp.connectDomains.length,
    0,
  );
  assert.equal(
    resource.contents[0]._meta.ui.csp.resourceDomains.length,
    0,
  );

  const inspectResult = await client.callTool({
    name: "inspect_leaf_prototype",
    arguments: {},
  });
  const renderResult = await client.callTool({
    name: "render_leaf_card_prototype",
    arguments: {},
  });
  assert.deepEqual(
    inspectResult.structuredContent,
    renderResult.structuredContent,
  );
  assert.deepEqual(
    inspectResult.structuredContent,
    readPrototypeSnapshot(),
  );
  assert.equal(
    inspectResult.structuredContent.card.state,
    "cancelled",
  );
  assert.equal(
    inspectResult.structuredContent.card.latestEvent.type,
    "turn.cancelled",
  );
  assert.equal(
    inspectResult.structuredContent.proof
      .sourceEvidenceSha256,
    "d9082b32dcd83d7b0c4e72f761e8d4c5bbc2a4912f2517dd69c3b236c38b3064",
  );

  const serialized =
    JSON.stringify(inspectResult.structuredContent).toLowerCase();
  for (const forbidden of [
    "processincarnation",
    "\"pid\"",
    "sessionpath",
    "rawprompt",
    "rawtranscript",
    "reasoning",
    "api_key",
    "apikey",
    "authorization",
    "cookie",
    "/users/",
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `structured App state leaked forbidden marker: ${forbidden}`,
    );
  }

  const widget = readPrototypeWidget();
  assert.match(widget, /ui\/notifications\/tool-result/);
  assert.match(widget, /ui\/notifications\/size-changed/);
  assert.match(widget, /Provider-native session/);
  assert.equal(/<script[^>]+src=/i.test(widget), false);

  const isolatedPluginRoot = mkdtempSync(
    join(tmpdir(), "cgc-v0-3-host-plugin-"),
  );
  cpSync(
    fileURLToPath(new URL(".", import.meta.url)),
    isolatedPluginRoot,
    { recursive: true },
  );
  const isolatedClient = new Client(
    {
      name: "ground-control-v0-3-isolated-plugin-validator",
      version: "0.3.0-alpha.1",
    },
    {
      capabilities: {},
    },
  );
  const isolatedTransport = new StdioClientTransport({
    command:
      pluginManifest.mcpServers[
        "ground-control-v0-3-host-spike"
      ].command,
    args:
      pluginManifest.mcpServers[
        "ground-control-v0-3-host-spike"
      ].args,
    cwd: isolatedPluginRoot,
    env: {
      PATH: process.env.PATH ?? "",
    },
    stderr: "pipe",
  });
  let isolatedStderr = "";
  isolatedTransport.stderr?.on("data", (chunk) => {
    isolatedStderr += chunk.toString("utf8");
  });

  try {
    await isolatedClient.connect(isolatedTransport);
    const isolatedTools = await isolatedClient.listTools();
    assert.deepEqual(
      isolatedTools.tools,
      listed.tools,
    );
    const [inMemoryResources, isolatedResources] =
      await Promise.all([
        client.listResources(),
        isolatedClient.listResources(),
      ]);
    assert.deepEqual(
      isolatedResources.resources,
      inMemoryResources.resources,
    );
    const isolatedResult = await isolatedClient.callTool({
      name: "render_leaf_card_prototype",
      arguments: {},
    });
    assert.deepEqual(
      isolatedResult.structuredContent,
      readPrototypeSnapshot(),
    );
    const isolatedResource =
      await isolatedClient.readResource({
        uri: PROTOTYPE_WIDGET_URI,
      });
    assert.equal(
      isolatedResource.contents[0].mimeType,
      "text/html;profile=mcp-app",
    );
    assert.deepEqual(isolatedResource, resource);
  } finally {
    await isolatedClient.close();
    rmSync(isolatedPluginRoot, {
      recursive: true,
      force: true,
    });
  }
  assert.equal(isolatedStderr, "");

  console.log(
    JSON.stringify(
      {
        state: "passed",
        tools: listed.tools.map(({ name }) => name).sort(),
        resourceUri: PROTOTYPE_WIDGET_URI,
        structuredStateShared: true,
        pluginManifestPaths: "plugin-relative",
        isolatedPluginCache: "passed",
        hostTurnEvidenceGate:
          "exclusive-completed-target-tool",
        forbiddenFieldScan: "passed",
        runtimeStarts: 0,
        networkRequests: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await server.close();
}

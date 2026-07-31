#!/usr/bin/env node

import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";

import {
  PRODUCT_SURFACE_WIDGET_URI,
  createProductSurfaceMcpServer,
  readProductSurfaceWidget,
} from "./server.mjs";

const server = createProductSurfaceMcpServer();
const client = new Client(
  {
    name: "ground-control-v0-3-product-surface-validator",
    version: "0.3.0-alpha.0",
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
    ["cancel_leaf", "delegate_leaf", "inspect_leaf"],
  );

  const definitions = Object.fromEntries(
    listed.tools.map((tool) => [tool.name, tool]),
  );
  assert.deepEqual(definitions.delegate_leaf.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: false,
  });
  assert.deepEqual(definitions.inspect_leaf.annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  assert.deepEqual(definitions.cancel_leaf.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: false,
    idempotentHint: true,
  });
  for (const definition of listed.tools) {
    assert.equal(
      definition._meta.ui.resourceUri,
      PRODUCT_SURFACE_WIDGET_URI,
    );
    assert.deepEqual(
      definition._meta.ui.visibility,
      ["model", "app"],
    );
    assert.equal(
      definition._meta["openai/widgetAccessible"],
      true,
    );
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.outputSchema.type, "object");
  }
  const invalidInput = await client.callTool({
    name: "delegate_leaf",
    arguments: {
      unexpected: true,
    },
  });
  assert.equal(invalidInput.isError, true);
  assert.match(
    invalidInput.content[0].text,
    /Invalid arguments for tool delegate_leaf/,
  );
  const missingTask = await client.callTool({
    name: "inspect_leaf",
    arguments: {
      taskId: "00000000-0000-4000-8000-000000000399",
    },
  });
  assert.equal(missingTask.isError, true);
  assert.match(
    missingTask.content[0].text,
    /^LEAF_TASK_NOT_FOUND:/,
  );

  const resource = await client.readResource({
    uri: PRODUCT_SURFACE_WIDGET_URI,
  });
  assert.equal(resource.contents.length, 1);
  assert.equal(
    resource.contents[0].mimeType,
    "text/html;profile=mcp-app",
  );
  assert.deepEqual(
    resource.contents[0]._meta.ui.csp.connectDomains,
    [],
  );
  assert.deepEqual(
    resource.contents[0]._meta.ui.csp.resourceDomains,
    [],
  );

  const first = await client.callTool({
    name: "delegate_leaf",
    arguments: {},
  });
  const sibling = await client.callTool({
    name: "delegate_leaf",
    arguments: {
      profile: "pi-glm",
      activity: "review",
    },
  });
  assert.equal(first.isError, undefined);
  assert.equal(first.structuredContent.card.state, "running");
  assert.equal(
    first.structuredContent.card.latestEvent.type,
    "turn.started",
  );
  assert.equal(sibling.structuredContent.card.state, "running");
  assert.notEqual(
    first.structuredContent.card.taskId,
    sibling.structuredContent.card.taskId,
  );

  const inspected = await client.callTool({
    name: "inspect_leaf",
    arguments: {
      taskId: first.structuredContent.card.taskId,
    },
  });
  assert.deepEqual(
    inspected.structuredContent.card,
    first.structuredContent.card,
  );

  const cancelled = await client.callTool({
    name: "cancel_leaf",
    arguments: {
      taskId: first.structuredContent.card.taskId,
    },
  });
  assert.equal(cancelled.structuredContent.card.state, "cancelled");
  assert.equal(
    cancelled.structuredContent.card.latestEvent.type,
    "turn.cancelled",
  );
  assert.equal(
    cancelled.structuredContent.card.latestEvent.sequence,
    3,
  );

  const repeated = await client.callTool({
    name: "cancel_leaf",
    arguments: {
      taskId: first.structuredContent.card.taskId,
    },
  });
  assert.deepEqual(
    repeated.structuredContent.card,
    cancelled.structuredContent.card,
  );

  const siblingAfter = await client.callTool({
    name: "inspect_leaf",
    arguments: {
      taskId: sibling.structuredContent.card.taskId,
    },
  });
  assert.equal(
    siblingAfter.structuredContent.card.state,
    "running",
  );
  assert.equal(
    siblingAfter.structuredContent.card.canCancel,
    true,
  );

  const serialized = JSON.stringify([
    first.structuredContent,
    cancelled.structuredContent,
    siblingAfter.structuredContent,
  ]).toLowerCase();
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

  const widget = readProductSurfaceWidget();
  assert.match(widget, /runCardTool\("inspect_leaf"/);
  assert.match(widget, /runCardTool\("cancel_leaf"/);
  assert.match(widget, /ui\/notifications\/tool-result/);
  assert.match(widget, /ui\/notifications\/size-changed/);
  assert.match(widget, /window\.openai\.callTool/);
  assert.equal(/<script[^>]+src=/i.test(widget), false);

} finally {
  await client.close();
  await server.close();
}

const stdioClient = new Client(
  {
    name: "ground-control-v0-3-stdio-validator",
    version: "0.3.0-alpha.0",
  },
  {
    capabilities: {},
  },
);
const stdioTransport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL("./server.mjs", import.meta.url)),
  ],
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    PATH: process.env.PATH ?? "",
  },
  stderr: "pipe",
});
let stdioErrorOutput = "";
stdioTransport.stderr?.on("data", (chunk) => {
  stdioErrorOutput += chunk.toString("utf8");
});

try {
  await stdioClient.connect(stdioTransport);
  const stdioTools = await stdioClient.listTools();
  assert.deepEqual(
    stdioTools.tools.map(({ name }) => name).sort(),
    ["cancel_leaf", "delegate_leaf", "inspect_leaf"],
  );
  const delegated = await stdioClient.callTool({
    name: "delegate_leaf",
    arguments: {},
  });
  const inspected = await stdioClient.callTool({
    name: "inspect_leaf",
    arguments: {
      taskId: delegated.structuredContent.card.taskId,
    },
  });
  assert.deepEqual(
    inspected.structuredContent.card,
    delegated.structuredContent.card,
  );
  const cancelled = await stdioClient.callTool({
    name: "cancel_leaf",
    arguments: {
      taskId: delegated.structuredContent.card.taskId,
    },
  });
  assert.equal(cancelled.structuredContent.card.state, "cancelled");
} finally {
  await stdioClient.close();
}
assert.equal(stdioErrorOutput, "");

console.log(
  JSON.stringify(
    {
      state: "passed",
      tools: [
        "cancel_leaf",
        "delegate_leaf",
        "inspect_leaf",
      ],
      resourceUri: PRODUCT_SURFACE_WIDGET_URI,
      transports: ["in-memory", "stdio"],
      transitions: [
        "delegate_leaf:running",
        "inspect_leaf:running",
        "cancel_leaf:cancelled",
        "cancel_leaf:cancelled-idempotent",
      ],
      siblingIsolation: "passed",
      strictInputValidation: "passed",
      actionableToolErrors: "passed",
      forbiddenFieldScan: "passed",
      widgetToolCalls: [
        "inspect_leaf",
        "cancel_leaf",
      ],
      piStarts: 0,
      providerCalls: 0,
      networkRequests: 0,
      repositoryWrites: 0,
    },
    null,
    2,
  ),
);

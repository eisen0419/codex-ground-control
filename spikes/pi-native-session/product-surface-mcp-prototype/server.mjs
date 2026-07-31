#!/usr/bin/env node

// THROWAWAY PROTOTYPE
//
// Question: Can one local MCP App expose only delegate_leaf, inspect_leaf,
// and cancel_leaf while sharing one in-memory state projection with its card?
//
// This server is synthetic and closed-world. It never starts Pi, calls a
// Provider, reads credentials, writes the repository, or accesses the network.

import {
  readFileSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createProductSurfacePrototype,
} from "../product-surface-prototype.mjs";

export const PRODUCT_SURFACE_WIDGET_URI =
  "ui://codex-ground-control/v0.3-spike/product-surface.html";

const WIDGET_URL = new URL("./widget.html", import.meta.url);
const ACTIVITY_SCHEMA = z.enum([
  "analysis",
  "exploration",
  "testing",
  "review",
]);
const DELEGATE_INPUT_SCHEMA = z
  .object({
    profile: z
      .literal("pi-glm")
      .default("pi-glm")
      .describe(
        "Synthetic profile identity shown on the prototype card.",
      ),
    activity: ACTIVITY_SCHEMA.default("testing").describe(
      "Bounded activity label shown on the prototype card.",
    ),
  })
  .strict();
const TASK_INPUT_SCHEMA = z
  .object({
    taskId: z
      .uuid()
      .describe(
        "Ground Control task ID returned by delegate_leaf.",
      ),
  })
  .strict();
const EVENT_SCHEMA = z
  .object({
    sequence: z.number().int().positive(),
    type: z.enum([
      "turn.started",
      "turn.progress",
      "turn.completed",
      "turn.cancel.requested",
      "turn.cancelled",
      "turn.failed",
    ]),
    source: z.literal("provider-native"),
    observedAt: z.string().min(1),
  })
  .strict();
const CARD_SCHEMA = z
  .object({
    schemaVersion: z.literal("0.3"),
    taskId: z.uuid(),
    adapterId: z.literal("pi-rpc"),
    profile: z.literal("pi-glm"),
    activity: ACTIVITY_SCHEMA,
    provider: z.literal("pi"),
    modelProvider: z.literal("zai-coding-cn"),
    model: z.literal("glm-5.2"),
    nativeSession: z
      .object({
        id: z.uuid(),
        inspectable: z.literal(true),
      })
      .strict(),
    state: z.enum([
      "starting",
      "running",
      "completed",
      "failed",
      "cancelling",
      "cancelled",
    ]),
    stage: z.string().min(1),
    latestEvent: EVENT_SCHEMA.nullable(),
    canCancel: z.boolean(),
    result: z
      .object({
        disposition: z.literal("candidate-evidence"),
      })
      .strict()
      .nullable(),
  })
  .strict();
const OUTPUT_SCHEMA = z
  .object({
    schemaVersion: z.literal("0.3-mcp-prototype"),
    kind: z.literal("synthetic-leaf-task-state"),
    operation: z.enum([
      "delegate_leaf",
      "inspect_leaf",
      "cancel_leaf",
    ]),
    synthetic: z.literal(true),
    card: CARD_SCHEMA,
    isolation: z
      .object({
        piStarts: z.literal(0),
        providerCalls: z.literal(0),
        networkRequests: z.literal(0),
        repositoryWrites: z.literal(0),
      })
      .strict(),
  })
  .strict();

const MUTATING_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
});
const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
const IDEMPOTENT_MUTATION_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});

function appMeta(invoking, invoked) {
  return {
    ui: {
      resourceUri: PRODUCT_SURFACE_WIDGET_URI,
      visibility: ["model", "app"],
    },
    "openai/outputTemplate": PRODUCT_SURFACE_WIDGET_URI,
    "openai/widgetAccessible": true,
    "openai/toolInvocation/invoking": invoking,
    "openai/toolInvocation/invoked": invoked,
  };
}

export function productSurfaceToolDefinitions() {
  return [
    {
      name: "delegate_leaf",
      title: "委派合成叶任务",
      description:
        "创建一个纯内存合成叶任务，并返回 running 状态卡。不启动 Pi、Provider 或网络。",
      inputSchema: DELEGATE_INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      annotations: MUTATING_ANNOTATIONS,
      meta: appMeta("正在创建合成叶任务…", "合成叶任务已创建"),
    },
    {
      name: "inspect_leaf",
      title: "检查合成叶任务",
      description:
        "按 Ground Control task ID 只读返回当前脱敏内存状态。",
      inputSchema: TASK_INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      meta: appMeta("正在读取叶任务状态…", "叶任务状态已读取"),
    },
    {
      name: "cancel_leaf",
      title: "取消合成叶任务",
      description:
        "精确取消与 task ID 私有绑定的合成运行时；重复取消同一已取消任务返回相同终态。",
      inputSchema: TASK_INPUT_SCHEMA,
      outputSchema: OUTPUT_SCHEMA,
      annotations: IDEMPOTENT_MUTATION_ANNOTATIONS,
      meta: appMeta("正在精确取消叶任务…", "叶任务取消已落定"),
    },
  ];
}

export function readProductSurfaceWidget() {
  return readFileSync(WIDGET_URL, "utf8");
}

function toolResult(operation, card) {
  const structuredContent = {
    schemaVersion: "0.3-mcp-prototype",
    kind: "synthetic-leaf-task-state",
    operation,
    synthetic: true,
    card,
    isolation: {
      piStarts: 0,
      providerCalls: 0,
      networkRequests: 0,
      repositoryWrites: 0,
    },
  };
  return {
    content: [
      {
        type: "text",
        text:
          `Synthetic leaf ${card.taskId} is ${card.state}. ` +
          "No Pi, Provider, network, or repository write was used.",
      },
    ],
    structuredContent,
  };
}

function toolError(error) {
  const code =
    typeof error?.code === "string"
      ? error.code
      : "PRODUCT_SURFACE_PROTOTYPE_ERROR";
  const message =
    error instanceof Error
      ? error.message
      : "Synthetic leaf operation failed.";
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `${code}: ${message}`,
      },
    ],
  };
}

export function createProductSurfaceMcpServer(options = {}) {
  const server = new McpServer(
    {
      name: "codex-ground-control-mcp-server",
      version: "0.3.0-alpha.0",
    },
    {
      instructions:
        "Exercise one synthetic, in-memory Ground Control v0.3 product surface. This prototype never starts Pi or a Provider, performs network access, reads credentials, or writes a repository.",
    },
  );
  const service =
    options.service ??
    createProductSurfacePrototype(options.serviceOptions);

  registerAppResource(
    server,
    "Ground Control v0.3 合成叶任务状态卡",
    PRODUCT_SURFACE_WIDGET_URI,
    {
      description:
        "显示三操作 MCP prototype 的共享内存状态。",
      _meta: {
        ui: {
          prefersBorder: true,
          csp: {
            connectDomains: [],
            resourceDomains: [],
          },
        },
      },
    },
    async () => ({
      contents: [
        {
          uri: PRODUCT_SURFACE_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readProductSurfaceWidget(),
          _meta: {
            "openai/widgetDescription":
              "Ground Control v0.3 三操作合成叶任务状态卡。",
            ui: {
              prefersBorder: true,
              csp: {
                connectDomains: [],
                resourceDomains: [],
              },
            },
          },
        },
      ],
    }),
  );

  const definitions = productSurfaceToolDefinitions();
  const delegateDefinition = definitions[0];
  registerAppTool(
    server,
    delegateDefinition.name,
    {
      title: delegateDefinition.title,
      description: delegateDefinition.description,
      inputSchema: delegateDefinition.inputSchema,
      outputSchema: delegateDefinition.outputSchema,
      annotations: delegateDefinition.annotations,
      _meta: delegateDefinition.meta,
    },
    async (input) => {
      try {
        const starting = service.delegateLeaf({
          profile: input.profile,
          activity: input.activity,
          permissionGranted: true,
        });
        const running =
          service.prototype.acceptProviderEvent({
            taskId: starting.taskId,
            event: { type: "agent_start" },
          });
        return toolResult("delegate_leaf", running);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const inspectDefinition = definitions[1];
  registerAppTool(
    server,
    inspectDefinition.name,
    {
      title: inspectDefinition.title,
      description: inspectDefinition.description,
      inputSchema: inspectDefinition.inputSchema,
      outputSchema: inspectDefinition.outputSchema,
      annotations: inspectDefinition.annotations,
      _meta: inspectDefinition.meta,
    },
    async (input) => {
      try {
        return toolResult(
          "inspect_leaf",
          service.inspectLeaf({ taskId: input.taskId }),
        );
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const cancelDefinition = definitions[2];
  registerAppTool(
    server,
    cancelDefinition.name,
    {
      title: cancelDefinition.title,
      description: cancelDefinition.description,
      inputSchema: cancelDefinition.inputSchema,
      outputSchema: cancelDefinition.outputSchema,
      annotations: cancelDefinition.annotations,
      _meta: cancelDefinition.meta,
    },
    async (input) => {
      try {
        const current = service.inspectLeaf({
          taskId: input.taskId,
        });
        if (current.state === "cancelled") {
          return toolResult("cancel_leaf", current);
        }
        const cancelling = service.cancelLeaf({
          taskId: input.taskId,
        });
        const cancelled =
          service.prototype.acceptProviderEvent({
            taskId: cancelling.taskId,
            event: { type: "agent_settled" },
          });
        return toolResult("cancel_leaf", cancelled);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export async function runProductSurfaceMcpServer() {
  const server = createProductSurfaceMcpServer();
  await server.connect(new StdioServerTransport());
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
  runProductSurfaceMcpServer().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );
    process.exitCode = 1;
  });
}

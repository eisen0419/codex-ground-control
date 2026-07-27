#!/usr/bin/env node

import {
  readFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
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
  inspectLeafRun,
  prepareLeafRun,
  startLeafRun,
} from "./leaf-run.js";
import {
  resolveCurrentProviderQualification,
} from "./provider-lifecycle.js";

export const GROUND_CONTROL_WIDGET_URI =
  "ui://codex-ground-control/v0.2/leaf-run.html";
const WIDGET_URL = new URL(
  "../assets/apps/ground-control/leaf-run.html",
  import.meta.url,
);

const PROJECT_ROOT_SCHEMA = z
  .string()
  .min(1)
  .max(4096);
const INTENT_ID_SCHEMA = z.uuid();
const PROFILE_SCHEMA = z.enum([
  "pi-glm",
  "pi-deepseek",
  "pi-minimax",
]);
const ACTIVITY_SCHEMA = z.enum([
  "analysis",
  "exploration",
  "testing",
  "review",
]);
const BRIEF_SCHEMA = z.string().min(1).max(8192);
const UI_LOCALE_SCHEMA = z
  .string()
  .min(2)
  .max(35)
  .optional()
  .describe(
    "Optional BCP 47 locale for user-visible App surface copy.",
  );
const APP_SURFACE_STAGE_SCHEMA = z.enum([
  "host-elicitation-accepted",
  "host-elicitation-declined",
  "host-elicitation-cancelled",
  "host-confirmation-not-affirmed",
  "host-elicitation-unavailable",
  "host-elicitation-error",
]);
const APP_SURFACE_REASON_SCHEMA = APP_SURFACE_STAGE_SCHEMA.nullable();
const APP_SURFACE_ACTION_SCHEMA = z.enum([
  "accept",
  "decline",
  "cancel",
  "unavailable",
  "error",
]);
const APP_SURFACE_OUTPUT_SCHEMA = {
  schemaVersion: z.literal("1"),
  kind: z.literal("app-surface-self-test"),
  state: z.enum(["passed", "blocked"]),
  stage: APP_SURFACE_STAGE_SCHEMA,
  reason: APP_SURFACE_REASON_SCHEMA,
  hostElicitation: z.object({
    supported: z.boolean(),
    action: APP_SURFACE_ACTION_SCHEMA,
    confirmed: z.boolean(),
  }),
  isolation: z.object({
    providerStarts: z.literal(0),
    workerStarts: z.literal(0),
    networkRequests: z.literal(0),
    productionIntentCreated: z.literal(false),
    liveAuthorizationGranted: z.literal(false),
  }),
  widget: z.object({
    resourceUri: z.literal(GROUND_CONTROL_WIDGET_URI),
    mimeType: z.literal(RESOURCE_MIME_TYPE),
  }),
};

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: true,
});
const PREPARE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
  idempotentHint: false,
});
const START_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
  idempotentHint: true,
});

const UI_COPY = Object.freeze({
  en: Object.freeze({
    tools: Object.freeze({
      prepare: Object.freeze({
        title: "Prepare Pi Leaf",
        description:
          "Prepare a bounded Pi LeafRun status card without starting the provider.",
        invoking: "Preparing Pi Leaf…",
        invoked: "Pi Leaf prepared",
      }),
      start: Object.freeze({
        title: "Start Pi Leaf",
        description:
          "Idempotently start one live Pi LeafRun after the Codex host permission policy allows this app-only tool call.",
        invoking: "Applying Codex permissions…",
        invoked: "Pi Leaf start resolved",
      }),
      inspect: Object.freeze({
        title: "Get Pi Leaf",
        description:
          "Read the current sanitized state of a prepared Pi LeafRun.",
        invoking: "Checking Pi Leaf…",
        invoked: "Pi Leaf checked",
      }),
      selfTest: Object.freeze({
        title: "Qualify App Surface",
        description:
          "Exercise the real Ground Control widget and host elicitation without preparing a LeafRun, authorizing live access, or starting any provider.",
        invoking: "Checking isolated App surface…",
        invoked: "App surface check resolved",
      }),
    }),
    resource: Object.freeze({
      title: "Ground Control Pi Leaf status",
      description:
        "Local, in-task Pi LeafRun permission and status card.",
      widgetDescription:
        "Ground Control App surface qualification and bounded Pi LeafRun status card.",
    }),
    selfTest: Object.freeze({
      elicitationMessage:
        "Run the isolated Ground Control App surface self-test? " +
        "It exercises this real widget and host elicitation, " +
        "never starts Pi or any Provider, never grants --allow-live, " +
        "creates no production LeafRun, and performs no network request.",
      confirmTitle: "Exercise the isolated App surface",
      confirmDescription:
        "This confirms only the offline UI path. It cannot authorize or start live execution.",
      passed:
        "Ground Control App surface self-test passed. ",
      blocked:
        "Ground Control App surface self-test blocked. ",
      isolation:
        "Pi, Provider, worker, and network starts remain zero; " +
        "this result is not live authorization.",
    }),
  }),
  zh: Object.freeze({
    tools: Object.freeze({
      prepare: Object.freeze({
        title: "准备 Pi 叶节点",
        description:
          "准备一个受限的 Pi LeafRun 状态卡，不启动 Provider。",
        invoking: "正在准备 Pi 叶节点…",
        invoked: "Pi 叶节点已准备",
      }),
      start: Object.freeze({
        title: "启动 Pi 叶节点",
        description:
          "Codex Host 权限策略允许此 app-only 工具调用后，以幂等方式启动一次 live Pi LeafRun。",
        invoking: "正在应用 Codex 权限…",
        invoked: "Pi 叶节点启动请求已处理",
      }),
      inspect: Object.freeze({
        title: "查看 Pi 叶节点",
        description:
          "读取已准备 Pi LeafRun 的当前脱敏状态。",
        invoking: "正在检查 Pi 叶节点…",
        invoked: "Pi 叶节点已检查",
      }),
      selfTest: Object.freeze({
        title: "验证 App 界面",
        description:
          "验证真实 Ground Control widget 与 Host 输入确认，不准备 LeafRun、不授予 live 权限，也不启动任何 Provider。",
        invoking: "正在检查隔离 App 界面…",
        invoked: "App 界面检查已处理",
      }),
    }),
    resource: Object.freeze({
      title: "Ground Control Pi 叶节点状态",
      description:
        "当前任务内的本地 Pi LeafRun 权限与状态卡。",
      widgetDescription:
        "Ground Control App 界面资格验证与受限 Pi LeafRun 状态卡。",
    }),
    selfTest: Object.freeze({
      elicitationMessage:
        "是否运行 Ground Control App 界面隔离自检？" +
        "这会验证真实 widget 与 Host 输入确认，" +
        "不会启动 Pi 或任何 Provider，不会授予 --allow-live，" +
        "不会创建生产 LeafRun，也不会发起网络请求。",
      confirmTitle: "运行隔离 App 界面自检",
      confirmDescription:
        "仅确认离线 UI 链路，不能授权或启动 live 执行。",
      passed:
        "Ground Control App 界面隔离自检已通过。",
      blocked:
        "Ground Control App 界面隔离自检已阻止。",
      isolation:
        "Pi、Provider、worker 和网络启动均为 0；" +
        "此结果不代表 live 授权。",
    }),
  }),
});

function normalizeUiLocale(locale) {
  return typeof locale === "string" &&
    /^zh(?:[-_]|$)/i.test(locale)
    ? "zh-CN"
    : "en-US";
}

function uiCopy(locale) {
  return normalizeUiLocale(locale) === "zh-CN"
    ? UI_COPY.zh
    : UI_COPY.en;
}

function requestUiLocale(input, extra, defaultLocale) {
  return normalizeUiLocale(
    input?.locale ??
      extra?._meta?.["openai/locale"] ??
      extra?._meta?.locale ??
      defaultLocale,
  );
}

export function groundControlToolDefinitions(
  locale = "zh-CN",
) {
  const copy = uiCopy(locale);
  return [
    {
      name: "prepare_leaf_run",
      title: copy.tools.prepare.title,
      description: copy.tools.prepare.description,
      inputSchema: {
        projectRoot: PROJECT_ROOT_SCHEMA,
        profile: PROFILE_SCHEMA,
        activity: ACTIVITY_SCHEMA,
        brief: BRIEF_SCHEMA,
      },
      annotations: PREPARE_ANNOTATIONS,
      meta: {
        ui: {
          resourceUri: GROUND_CONTROL_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking":
          copy.tools.prepare.invoking,
        "openai/toolInvocation/invoked":
          copy.tools.prepare.invoked,
      },
    },
    {
      name: "start_leaf_run",
      title: copy.tools.start.title,
      description: copy.tools.start.description,
      inputSchema: {
        projectRoot: PROJECT_ROOT_SCHEMA,
        intentId: INTENT_ID_SCHEMA,
        brief: BRIEF_SCHEMA,
      },
      annotations: START_ANNOTATIONS,
      meta: {
        ui: {
          resourceUri: GROUND_CONTROL_WIDGET_URI,
          visibility: ["app"],
        },
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking":
          copy.tools.start.invoking,
        "openai/toolInvocation/invoked":
          copy.tools.start.invoked,
      },
    },
    {
      name: "get_leaf_run",
      title: copy.tools.inspect.title,
      description: copy.tools.inspect.description,
      inputSchema: {
        projectRoot: PROJECT_ROOT_SCHEMA,
        intentId: INTENT_ID_SCHEMA,
      },
      annotations: READ_ONLY_ANNOTATIONS,
      meta: {
        ui: {
          resourceUri: GROUND_CONTROL_WIDGET_URI,
          visibility: ["app"],
        },
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking":
          copy.tools.inspect.invoking,
        "openai/toolInvocation/invoked":
          copy.tools.inspect.invoked,
      },
    },
    {
      name: "qualify_app_surface",
      title: copy.tools.selfTest.title,
      description: copy.tools.selfTest.description,
      inputSchema: {
        locale: UI_LOCALE_SCHEMA,
      },
      outputSchema: APP_SURFACE_OUTPUT_SCHEMA,
      annotations: READ_ONLY_ANNOTATIONS,
      meta: {
        ui: {
          resourceUri: GROUND_CONTROL_WIDGET_URI,
          visibility: ["model", "app"],
        },
        "openai/widgetAccessible": true,
        "openai/toolInvocation/invoking":
          copy.tools.selfTest.invoking,
        "openai/toolInvocation/invoked":
          copy.tools.selfTest.invoked,
      },
    },
  ];
}

export function readGroundControlWidget() {
  return readFileSync(WIDGET_URL, "utf8");
}

function toolResult(state, privateState) {
  return {
    content: [
      {
        type: "text",
        text:
          `Pi Leaf ${state.intentId} is ${state.state}. ` +
          "The status card contains the authoritative runtime details.",
      },
    ],
    structuredContent: state,
    ...(privateState
      ? {
          _meta: {
            leafRun: privateState,
          },
        }
      : {}),
  };
}

function toolError(error) {
  const code =
    typeof error?.code === "string"
      ? error.code
      : "GROUND_CONTROL_APP_ERROR";
  const message =
    error instanceof Error
      ? error.message
      : "Ground Control App operation failed.";
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

function appSurfaceToolResult(decision, locale = "zh-CN") {
  const copy = uiCopy(locale);
  const confirmed =
    decision.action === "accept" &&
    decision.confirmed === true;
  const stage = confirmed
    ? "host-elicitation-accepted"
    : decision.action === "accept"
      ? "host-confirmation-not-affirmed"
      : decision.action === "decline"
        ? "host-elicitation-declined"
        : decision.action === "cancel"
          ? "host-elicitation-cancelled"
          : decision.action === "unavailable"
            ? "host-elicitation-unavailable"
            : "host-elicitation-error";
  const state = confirmed ? "passed" : "blocked";
  const surfaceState = {
    schemaVersion: "1",
    kind: "app-surface-self-test",
    state,
    stage,
    reason: confirmed ? null : stage,
    hostElicitation: {
      supported: decision.supported,
      action: decision.action,
      confirmed,
    },
    isolation: {
      providerStarts: 0,
      workerStarts: 0,
      networkRequests: 0,
      productionIntentCreated: false,
      liveAuthorizationGranted: false,
    },
    widget: {
      resourceUri: GROUND_CONTROL_WIDGET_URI,
      mimeType: RESOURCE_MIME_TYPE,
    },
  };
  return {
    content: [
      {
        type: "text",
        text:
          (confirmed
            ? copy.selfTest.passed
            : copy.selfTest.blocked) +
          (normalizeUiLocale(locale) === "zh-CN"
            ? ""
            : " ") +
          copy.selfTest.isolation,
      },
    ],
    structuredContent: surfaceState,
  };
}

async function elicitAppSurfaceSelfTest(
  server,
  locale = "zh-CN",
) {
  const copy = uiCopy(locale);
  const capabilities =
    server.server.getClientCapabilities();
  if (!capabilities?.elicitation) {
    return {
      supported: false,
      action: "unavailable",
      confirmed: false,
    };
  }
  try {
    const result = await server.server.elicitInput(
      {
        mode: "form",
        message: copy.selfTest.elicitationMessage,
        requestedSchema: {
          type: "object",
          properties: {
            confirm: {
              type: "boolean",
              title: copy.selfTest.confirmTitle,
              description: copy.selfTest.confirmDescription,
              default: false,
            },
          },
          required: ["confirm"],
        },
      },
      { timeout: 120_000 },
    );
    return {
      supported: true,
      action: result.action,
      confirmed:
        result.action === "accept" &&
        result.content?.confirm === true,
    };
  } catch {
    return {
      supported: true,
      action: "error",
      confirmed: false,
    };
  }
}

export function createGroundControlMcpServer(options = {}) {
  const server = new McpServer(
    {
      name: "codex-ground-control",
      version: "0.2.0",
    },
    {
      instructions:
        "Prepare visible Pi LeafRuns. Codex native app permissions govern live starts; Codex remains the only writer and completion authority.",
    },
  );
  const homeDirectory =
    options.homeDirectory ?? homedir();
  const environment =
    options.environment ?? process.env;
  const defaultLocale = normalizeUiLocale(
    options.locale ??
      environment.GROUND_CONTROL_UI_LOCALE ??
      "zh-CN",
  );
  const copy = uiCopy(defaultLocale);
  const operations = {
    inspectLeafRun,
    prepareLeafRun,
    resolveCurrentProviderQualification,
    startLeafRun,
    ...options.operations,
  };
  const definitions =
    groundControlToolDefinitions(defaultLocale);

  registerAppResource(
    server,
    copy.resource.title,
    GROUND_CONTROL_WIDGET_URI,
    {
      description:
        copy.resource.description,
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
          uri: GROUND_CONTROL_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readGroundControlWidget(),
          _meta: {
            "openai/widgetDescription":
              copy.resource.widgetDescription,
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

  const prepareDefinition = definitions[0];
  registerAppTool(
    server,
    prepareDefinition.name,
    {
      title: prepareDefinition.title,
      description: prepareDefinition.description,
      inputSchema: prepareDefinition.inputSchema,
      annotations: prepareDefinition.annotations,
      _meta: prepareDefinition.meta,
    },
    async (input) => {
      try {
        const qualification =
          operations.resolveCurrentProviderQualification({
            projectRoot: input.projectRoot,
            homeDirectory,
            environment,
            providerId: input.profile,
          });
        const state = operations.prepareLeafRun({
          projectRoot: input.projectRoot,
          homeDirectory,
          profile: input.profile,
          activity: input.activity,
          brief: input.brief,
          qualificationFingerprint:
            qualification.fingerprint,
        });
        return toolResult(state, {
          projectRoot: input.projectRoot,
          intentId: state.intentId,
          brief: input.brief,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const startDefinition = definitions[1];
  registerAppTool(
    server,
    startDefinition.name,
    {
      title: startDefinition.title,
      description: startDefinition.description,
      inputSchema: startDefinition.inputSchema,
      annotations: startDefinition.annotations,
      _meta: startDefinition.meta,
    },
    async (input) => {
      try {
        const state = await operations.startLeafRun({
          projectRoot: input.projectRoot,
          homeDirectory,
          environment,
          intentId: input.intentId,
          brief: input.brief,
          authorization: {
            source: "codex-host-permission",
          },
        });
        return toolResult(state, {
          projectRoot: input.projectRoot,
          intentId: input.intentId,
          brief: input.brief,
        });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const inspectDefinition = definitions[2];
  registerAppTool(
    server,
    inspectDefinition.name,
    {
      title: inspectDefinition.title,
      description: inspectDefinition.description,
      inputSchema: inspectDefinition.inputSchema,
      annotations: inspectDefinition.annotations,
      _meta: inspectDefinition.meta,
    },
    async (input) => {
      try {
        const state = operations.inspectLeafRun({
          projectRoot: input.projectRoot,
          homeDirectory,
          intentId: input.intentId,
        });
        return toolResult(state);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  const selfTestDefinition = definitions[3];
  registerAppTool(
    server,
    selfTestDefinition.name,
    {
      title: selfTestDefinition.title,
      description: selfTestDefinition.description,
      inputSchema: selfTestDefinition.inputSchema,
      outputSchema: selfTestDefinition.outputSchema,
      annotations: selfTestDefinition.annotations,
      _meta: selfTestDefinition.meta,
    },
    async (input, extra) => {
      const locale = requestUiLocale(
        input,
        extra,
        defaultLocale,
      );
      return appSurfaceToolResult(
        await elicitAppSurfaceSelfTest(server, locale),
        locale,
      );
    },
  );

  return server;
}

export async function runGroundControlMcpServer() {
  const server = createGroundControlMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export function isMainModule(
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
  runGroundControlMcpServer().catch((error) => {
    console.error(
      error instanceof Error
        ? error.message
        : String(error),
    );
    process.exitCode = 1;
  });
}

import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import {
  RESOURCE_MIME_TYPE,
  registerAppResource,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  createLeafProductionComposition,
  registerLeafMcpHostRenderTool,
  registerLeafMcpTools,
} from "./leaf-mcp-composition.js";

export const GROUND_CONTROL_V03_WIDGET_URI =
  "ui://codex-ground-control/v0.3/leaf-session.html";

const WIDGET_URL = new URL(
  "../../assets/apps/ground-control/v0.3-leaf-session.html",
  import.meta.url,
);

const TOOL_VISIBILITY = Object.freeze({
  delegate_leaf: Object.freeze(["model"]),
  inspect_leaf: Object.freeze(["app"]),
  cancel_leaf: Object.freeze(["app"]),
  render_leaf_card: Object.freeze(["model"]),
});

export function readLeafSessionWidget() {
  return readFileSync(WIDGET_URL, "utf8");
}

function toolMetadata() {
  return Object.fromEntries(
    Object.entries(TOOL_VISIBILITY).map(
      ([name, visibility]) => [
        name,
        Object.freeze({
          ui: Object.freeze({
            resourceUri: GROUND_CONTROL_V03_WIDGET_URI,
            visibility,
          }),
          "ui/resourceUri": GROUND_CONTROL_V03_WIDGET_URI,
          "openai/widgetAccessible": visibility.includes("app"),
        }),
      ],
    ),
  );
}

function selectedCheckoutFromPath(value, label) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    !isAbsolute(value)
  ) {
    throw new TypeError(
      `${label} must be an absolute path.`,
    );
  }
  let selectedCheckout;
  let metadata;
  try {
    selectedCheckout = realpathSync(value);
    metadata = lstatSync(selectedCheckout);
  } catch {
    throw new TypeError(
      `${label} must exist.`,
    );
  }
  if (
    !metadata.isDirectory() ||
    dirname(selectedCheckout) === selectedCheckout
  ) {
    throw new TypeError(
      `${label} must be a bounded directory.`,
    );
  }
  return Object.freeze({ selectedCheckout });
}

function selectedCheckoutFromRoots(result) {
  if (
    !result ||
    !Array.isArray(result.roots) ||
    result.roots.length !== 1 ||
    typeof result.roots[0]?.uri !== "string"
  ) {
    throw new TypeError(
      "The Codex Host must expose exactly one selected checkout root.",
    );
  }
  const root = new URL(result.roots[0].uri);
  if (
    root.protocol !== "file:" ||
    root.search !== "" ||
    root.hash !== ""
  ) {
    throw new TypeError(
      "The Codex Host selected checkout must be a local file root.",
    );
  }
  return selectedCheckoutFromPath(
    fileURLToPath(root),
    "The Codex Host selected checkout",
  );
}

function selectedCheckoutFromWorkingDirectory(workingDirectory) {
  if (workingDirectory === undefined) {
    return null;
  }
  return selectedCheckoutFromPath(
    workingDirectory,
    "The Host stdio working directory",
  );
}

export function createLeafMcpAppServer({
  composition,
} = {}) {
  if (
    !composition ||
    typeof composition.close !== "function"
  ) {
    throw new TypeError(
      "v0.3 MCP App requires an owned leaf composition lifecycle.",
    );
  }
  const server = new McpServer(
    {
      name: "codex-ground-control-v0.3",
      version: "0.3.0",
    },
    {
      instructions:
        "Delegate, inspect, and exactly cancel one external Provider-native leaf session. Codex remains the only completion authority.",
    },
  );

  registerAppResource(
    server,
    "Ground Control v0.3 leaf session",
    GROUND_CONTROL_V03_WIDGET_URI,
    {
      description:
        "Sanitized state and exact cancellation controls for one Provider-native leaf session.",
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
          uri: GROUND_CONTROL_V03_WIDGET_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: readLeafSessionWidget(),
          _meta: {
            "openai/widgetDescription":
              "Ground Control v0.3 Provider-native leaf session status card.",
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

  const metadata = toolMetadata();
  registerLeafMcpTools({
    server,
    composition,
    toolMetadata: metadata,
  });
  registerLeafMcpHostRenderTool({
    server,
    composition,
    toolMetadata: metadata.render_leaf_card,
  });

  const closeServer = server.close.bind(server);
  let compositionClosing = null;
  function closeComposition() {
    if (!compositionClosing) {
      compositionClosing = Promise.resolve().then(() =>
        composition.close(),
      );
    }
    return compositionClosing;
  }
  const previousOnClose = server.server.onclose;
  server.server.onclose = () => {
    previousOnClose?.();
    void closeComposition().catch(() => {});
  };
  Object.defineProperty(server, "close", {
    configurable: false,
    writable: false,
    value() {
      return closeServer().finally(closeComposition);
    },
  });

  return server;
}

export function createLeafProductionMcpAppServer(
  productionOptions = {},
) {
  const {
    hostWorkingDirectory,
    ...compositionOptions
  } = productionOptions;
  const configuredCheckout =
    selectedCheckoutFromWorkingDirectory(hostWorkingDirectory);
  let server = null;
  const composition = createLeafProductionComposition({
    ...compositionOptions,
    async hostDispatchFromCall(callContext) {
      if (!server || callContext?.requestId === undefined) {
        throw new TypeError(
          "The v0.3 MCP App Host lifecycle is not connected.",
        );
      }
      if (server.server.getClientCapabilities()?.roots) {
        const roots = await server.server.listRoots(undefined, {
          signal: callContext.signal,
          relatedRequestId: callContext.requestId,
        });
        return selectedCheckoutFromRoots(roots);
      }
      if (configuredCheckout) {
        return configuredCheckout;
      }
      throw new TypeError(
        "The Codex Host exposed no trusted checkout capability.",
      );
    },
  });
  server = createLeafMcpAppServer({ composition });
  return server;
}

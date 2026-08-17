import { ChromeBridge, callTool, tools as chromeTools } from "../browser/server.mjs";

const DEFAULT_PORT = 37842;
const DEFAULT_TOKEN_FILE = `${process.env.HOME ?? "~"}/.pi/agent/chrome-bridge-token`;

let bridge = null;
let bridgeStart = null;

function bridgeOptions() {
  return {
    port: Number(process.env.PI_CHROME_PORT ?? DEFAULT_PORT),
    tokenFile: process.env.PI_CHROME_TOKEN_FILE || DEFAULT_TOKEN_FILE,
  };
}

async function ensureBridge() {
  if (bridge?.wss) return bridge;
  if (!bridgeStart) {
    bridgeStart = (async () => {
      const next = await new ChromeBridge(bridgeOptions()).start();
      bridge = next;
      return next;
    })().catch(error => {
      bridgeStart = null;
      throw error;
    });
  }
  return await bridgeStart;
}

async function stopBridge() {
  const current = bridge;
  bridge = null;
  bridgeStart = null;
  if (current) await current.stop();
}

function piToolName(originalName) {
  return `pi_chrome_${originalName}`;
}

function extensionResult(mcpResult) {
  return {
    content: mcpResult.content ?? [{ type: "text", text: "Pi Chrome completed" }],
    details: mcpResult.structuredContent ?? {},
    ...(mcpResult.isError ? { isError: true } : {}),
  };
}

export default function piChromeExtension(pi) {
  for (const definition of chromeTools) {
    pi.registerTool({
      name: piToolName(definition.name),
      label: `Chrome: ${definition.name}`,
      description: definition.description,
      // The browser MCP server already publishes a JSON Schema. Pi's tool
      // registry accepts the same TSchema shape at runtime; keeping one schema
      // source prevents the MCP and Pi surfaces from drifting.
      parameters: definition.inputSchema,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const current = await ensureBridge();
          await current.waitForExtension(definition.name === "status" ? 5_000 : 3_000);
          return extensionResult(await callTool(current, definition.name, params ?? {}));
        } catch (error) {
          const message = error?.message ?? String(error);
          if (ctx.hasUI) ctx.ui.notify(`Pi Chrome: ${message}`, "error");
          return {
            content: [{ type: "text", text: message }],
            details: { ok: false, error: { code: error?.code ?? "PI_CHROME_ERROR", message } },
            isError: true,
          };
        }
      },
    });
  }

  pi.registerCommand("chrome-status", {
    description: "Show Pi Chrome bridge and extension status",
    handler: async (_args, ctx) => {
      try {
        const current = await ensureBridge();
        await current.waitForExtension(5_000);
        const result = await callTool(current, "status", {});
        const status = result.structuredContent?.result;
        ctx.ui.notify(status?.connected ? "Pi Chrome extension connected" : "Pi Chrome bridge is listening; extension is not connected", status?.connected ? "info" : "warning");
      } catch (error) {
        ctx.ui.notify(`Pi Chrome: ${error?.message ?? String(error)}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    try {
      const current = await ensureBridge();
      await current.waitForExtension(10_000);
      if (ctx.hasUI) ctx.ui.setStatus("pi-chrome", current.isExtensionConnected() ? "Chrome connected" : "Chrome bridge listening");
    } catch (error) {
      if (ctx.hasUI) ctx.ui.notify(`Pi Chrome bridge unavailable: ${error?.message ?? String(error)}`, "warning");
    }
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await stopBridge();
    if (ctx.hasUI) ctx.ui.setStatus("pi-chrome", "");
  });
}

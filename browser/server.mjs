#!/usr/bin/env node
/**
 * Pi Chrome bridge MCP server.
 *
 * The MCP side speaks stdio to Pi. The browser side speaks a small authenticated
 * WebSocket protocol to the locally installed MV3 extension. Browser actions are
 * executed inside Chrome through extension APIs, not macOS global mouse events.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import readline from "node:readline";
import { WebSocket, WebSocketServer } from "ws";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PORT = 37842;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".pi", "agent", "chrome-bridge-token");
const SERVER_VERSION = "0.1.0";
const COMMAND_TIMEOUT_MS = 30_000;

class BridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "BridgeError";
    this.code = code;
    this.details = details;
  }
}

function log(message) {
  process.stderr.write(`[pi-chrome] ${message}\n`);
}

function requestId() {
  return `pc_${crypto.randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function ensureToken(tokenFile) {
  try {
    const existing = (await fs.readFile(tokenFile, "utf8")).trim();
    if (existing.length >= 32) return existing;
  } catch {
    // Generate below.
  }

  const token = crypto.randomBytes(32).toString("hex");
  await fs.mkdir(path.dirname(tokenFile), { recursive: true, mode: 0o700 });
  await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });
  try {
    await fs.chmod(tokenFile, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
  return token;
}

function numericId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function toolSchema(properties = {}, required = []) {
  const schema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

const targetProperties = {
  node_id: { type: "string", description: "Node id from chrome_get_state" },
  state_version: { type: "integer", description: "State version associated with node_id" },
  selector: { type: "string", description: "CSS selector when a DOM node id is unavailable" },
  text: { type: "string", description: "Visible text to match" },
  role: { type: "string", description: "ARIA or inferred role" },
  name: { type: "string", description: "Accessible name" },
  exact: { type: "boolean", description: "Require exact text/name matching" },
};

export const tools = [
  {
    name: "status",
    description: "Show whether the Pi Chrome extension is connected and ready.",
    inputSchema: toolSchema(),
  },
  {
    name: "list_tabs",
    description: "List tabs in the user's existing Chrome profile.",
    inputSchema: toolSchema(),
  },
  {
    name: "new_tab",
    description: "Create a new tab in the user's existing Chrome profile. It is claimed by Pi and is inactive by default unless active=true.",
    inputSchema: toolSchema({
      url: { type: "string", description: "Initial URL; defaults to about:blank" },
      active: { type: "boolean", description: "Bring the new tab to the front" },
    }),
  },
  {
    name: "claim_tab",
    description: "Claim an existing Chrome tab before changing it. Use the exact tab id from chrome_list_tabs.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, expected_title: { type: "string" }, expected_url: { type: "string" } }, ["tab_id"]),
  },
  {
    name: "release_tab",
    description: "Release a claimed tab without closing it.",
    inputSchema: toolSchema({ tab_id: { type: "integer" } }, ["tab_id"]),
  },
  {
    name: "close_tab",
    description: "Close a Pi-owned or explicitly claimed Chrome tab.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, force: { type: "boolean" } }, ["tab_id"]),
  },
  {
    name: "navigate",
    description: "Navigate a claimed Chrome tab without using the macOS mouse.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, url: { type: "string" } }, ["tab_id", "url"]),
  },
  {
    name: "get_state",
    description: "Return a structured visible DOM/accessibility snapshot for a claimed tab, with stable node ids and optional screenshot.",
    inputSchema: toolSchema({
      tab_id: { type: "integer" },
      screenshot: { type: "boolean" },
      max_nodes: { type: "integer" },
      max_chars: { type: "integer" },
    }, ["tab_id"]),
  },
  {
    name: "screenshot",
    description: "Capture a screenshot of a claimed Chrome tab through the browser bridge.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, full_page: { type: "boolean" } }, ["tab_id"]),
  },
  {
    name: "click",
    description: "Click a unique DOM target in a claimed tab. Prefer node_id from chrome_get_state; selector/text/name are fallbacks.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, ...targetProperties }, ["tab_id"]),
  },
  {
    name: "fill",
    description: "Fill a unique input, textarea, select, or contenteditable element in a claimed tab.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, value: { type: "string" }, ...targetProperties }, ["tab_id", "value"]),
  },
  {
    name: "press_key",
    description: "Send a browser key event to a claimed tab without using the macOS global keyboard.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, key: { type: "string" }, ...targetProperties }, ["tab_id", "key"]),
  },
  {
    name: "wait_for",
    description: "Wait for visible text or a selector to appear in a claimed tab.",
    inputSchema: toolSchema({ tab_id: { type: "integer" }, text: { type: "string" }, selector: { type: "string" }, timeout_ms: { type: "integer" } }, ["tab_id"]),
  },
];

function extensionInstallPath() {
  return path.join(os.homedir(), ".pi", "agent", "chrome-extension");
}

function statusPayload({ port, tokenFile, extensionSocket, extensionInfo }) {
  return {
    connected: Boolean(extensionSocket && extensionSocket.readyState === WebSocket.OPEN),
    server: "pi-chrome",
    version: SERVER_VERSION,
    host: "127.0.0.1",
    port,
    extension: extensionInfo ?? null,
    extensionPath: extensionInstallPath(),
    tokenFile,
    installHint: "Run scripts/install-chrome.sh, then load the printed extension directory at chrome://extensions.",
    capabilities: ["tabs", "domSnapshot", "playwrightLikeActions", "screenshots", "browserViewportInput"],
  };
}

function summarize(toolName, result) {
  if (typeof result?.message === "string") return result.message;
  if (toolName === "status") return result.connected ? "Pi Chrome extension connected" : "Pi Chrome extension is not connected";
  if (toolName === "list_tabs") return `Found ${Array.isArray(result?.tabs) ? result.tabs.length : 0} Chrome tabs`;
  if (toolName === "get_state") return `Captured Chrome state for tab ${result.tab?.id ?? "?"}`;
  if (toolName === "screenshot") return "Captured Chrome screenshot";
  return `Chrome ${toolName.replace(/^chrome_/, "")} completed`;
}

function sanitizeForStructured(result, additionalContent) {
  if (result == null || typeof result !== "object") return result;
  if (Array.isArray(result)) return result.map(item => sanitizeForStructured(item, additionalContent));
  const output = {};
  for (const [key, value] of Object.entries(result)) {
    if (key === "data" && typeof value === "string" && result.mimeType?.startsWith("image/")) {
      const contentRef = `image_${crypto.randomUUID()}`;
      additionalContent.push({ type: "image", data: value, mimeType: result.mimeType });
      output.contentRef = contentRef;
      continue;
    }
    if (key === "screenshot" && value && typeof value === "object" && typeof value.data === "string") {
      const copy = { ...value };
      const contentRef = `image_${crypto.randomUUID()}`;
      additionalContent.push({ type: "image", data: copy.data, mimeType: copy.mimeType ?? "image/png" });
      delete copy.data;
      copy.contentRef = contentRef;
      output[key] = copy;
      continue;
    }
    output[key] = value;
  }
  return output;
}

function mcpSuccess(toolName, result) {
  const additionalContent = [];
  const structuredResult = sanitizeForStructured(result, additionalContent);
  const envelope = {
    ok: true,
    requestId: requestId(),
    tool: toolName,
    result: structuredResult,
  };
  return {
    content: [{ type: "text", text: summarize(toolName, result) }, ...additionalContent],
    structuredContent: envelope,
  };
}

function mcpError(error) {
  const code = error?.code ?? "CHROME_BRIDGE_ERROR";
  const message = error?.message ?? String(error);
  return {
    content: [{ type: "text", text: message }],
    structuredContent: {
      ok: false,
      requestId: requestId(),
      error: {
        code,
        message,
        retryable: code !== "INVALID_PARAMS",
        details: error?.details ?? {},
      },
    },
    isError: true,
  };
}

export class ChromeBridge {
  constructor({ port = Number(process.env.PI_CHROME_PORT || DEFAULT_PORT), tokenFile = process.env.PI_CHROME_TOKEN_FILE || DEFAULT_TOKEN_FILE } = {}) {
    this.requestedPort = port;
    this.port = port;
    this.tokenFile = tokenFile;
    this.token = null;
    this.wss = null;
    this.extensionSocket = null;
    this.extensionInfo = null;
    this.pending = new Map();
    this.sessionId = crypto.randomUUID();
  }

  async start() {
    this.token = await ensureToken(this.tokenFile);
    this.wss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.requestedPort,
      path: "/ws",
      verifyClient: ({ req }, done) => {
        const url = new URL(req.url, "ws://127.0.0.1");
        const supplied = url.searchParams.get("token");
        if (safeEqual(supplied, this.token)) {
          done(true);
        } else {
          done(false, 401, "Unauthorized");
        }
      },
    });
    this.wss.on("connection", socket => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      this.wss.once("listening", resolve);
      this.wss.once("error", reject);
    });
    const address = this.wss.address();
    if (address && typeof address === "object") this.port = address.port;
    log(`bridge listening on 127.0.0.1:${this.port}`);
    return this;
  }

  handleConnection(socket) {
    if (this.extensionSocket && this.extensionSocket.readyState === WebSocket.OPEN) {
      this.rejectPending(new BridgeError("EXTENSION_RECONNECTED", "Chrome extension reconnected; retry the command"));
      this.extensionSocket.close(1000, "replaced by newer extension connection");
    }
    this.extensionSocket = socket;
    this.extensionInfo = null;
    socket.on("message", data => this.handleMessage(data));
    socket.on("close", () => {
      if (this.extensionSocket === socket) {
        this.extensionSocket = null;
        this.extensionInfo = null;
        this.rejectPending(new BridgeError("EXTENSION_DISCONNECTED", "Chrome extension disconnected"));
      }
    });
    socket.on("error", error => log(`extension socket error: ${error.message}`));
  }

  handleMessage(data) {
    let message;
    try {
      message = JSON.parse(data.toString());
    } catch {
      log("ignored malformed extension message");
      return;
    }
    if (message?.type === "ping") {
      this.extensionSocket?.send(JSON.stringify({ type: "pong" }));
      return;
    }
    if (message?.type === "hello") {
      if (message.client !== "pi-chrome-extension") {
        this.extensionSocket?.close(1008, "unsupported client");
        return;
      }
      this.extensionInfo = {
        client: message.client ?? "unknown",
        version: message.version ?? "unknown",
        extensionId: message.extensionId ?? null,
        connectedAt: new Date().toISOString(),
      };
      this.extensionSocket?.send(JSON.stringify({
        type: "hello_ack",
        sessionId: this.sessionId,
        server: "pi-chrome",
        version: SERVER_VERSION,
      }));
      log(`Chrome extension connected${this.extensionInfo.extensionId ? ` (${this.extensionInfo.extensionId})` : ""}`);
      return;
    }
    if (message?.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false || message.error) {
      pending.reject(new BridgeError(message.error?.code ?? "EXTENSION_ERROR", message.error?.message ?? "Chrome extension command failed", message.error?.details ?? {}));
    } else {
      pending.resolve(message.result ?? {});
    }
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async command(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    if (!this.extensionSocket || this.extensionSocket.readyState !== WebSocket.OPEN || !this.extensionInfo) {
      throw new BridgeError("EXTENSION_NOT_CONNECTED", "Pi Chrome extension is not connected. Load the installed extension and keep the pi-chrome MCP server running.", {
        extensionPath: extensionInstallPath(),
        tokenFile: this.tokenFile,
        port: this.port,
      });
    }
    const id = crypto.randomUUID();
    const payload = JSON.stringify({ type: "command", id, method, params });
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeError("CHROME_COMMAND_TIMEOUT", `Chrome command '${method}' timed out after ${timeoutMs}ms`, { method, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.extensionSocket.send(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new BridgeError("EXTENSION_SEND_FAILED", error.message));
      }
    });
  }

  async stop() {
    this.rejectPending(new BridgeError("BRIDGE_STOPPED", "Pi Chrome bridge stopped"));
    if (this.extensionSocket) this.extensionSocket.close(1000, "bridge stopping");
    await new Promise(resolve => this.wss?.close(() => resolve()));
    this.wss = null;
  }
}

function requiredInteger(args, name) {
  const value = numericId(args?.[name]);
  if (value == null) throw new BridgeError("INVALID_PARAMS", `${name} must be a positive integer`);
  return value;
}

function allowedBrowserUrl(value) {
  if (typeof value !== "string" || value.length === 0) throw new BridgeError("INVALID_URL", "url is required");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new BridgeError("INVALID_URL", `Invalid URL: ${value}`);
  }
  if (!["http:", "https:", "about:"].includes(parsed.protocol)) throw new BridgeError("INVALID_URL", "Only http, https, and about URLs are allowed");
  return parsed.toString();
}

export async function callTool(bridge, name, args) {
  const canonicalName = name.startsWith("chrome_") ? name.slice("chrome_".length) : name;
  if (canonicalName === "status") {
    return mcpSuccess(name, statusPayload(bridge));
  }
  switch (canonicalName) {
    case "list_tabs":
      return mcpSuccess(name, await bridge.command("list_tabs"));
    case "new_tab":
      return mcpSuccess(name, await bridge.command("new_tab", {
        url: allowedBrowserUrl(args?.url || "about:blank"),
        active: args?.active === true,
      }));
    case "claim_tab":
      return mcpSuccess(name, await bridge.command("claim_tab", {
        tabId: requiredInteger(args, "tab_id"),
        expectedTitle: args?.expected_title,
        expectedUrl: args?.expected_url,
      }));
    case "release_tab":
      return mcpSuccess(name, await bridge.command("release_tab", { tabId: requiredInteger(args, "tab_id") }));
    case "close_tab":
      return mcpSuccess(name, await bridge.command("close_tab", { tabId: requiredInteger(args, "tab_id"), force: args?.force === true }));
    case "navigate":
      return mcpSuccess(name, await bridge.command("navigate", { tabId: requiredInteger(args, "tab_id"), url: allowedBrowserUrl(args?.url) }));
    case "get_state":
      return mcpSuccess(name, await bridge.command("get_state", {
        tabId: requiredInteger(args, "tab_id"),
        screenshot: args?.screenshot === true,
        maxNodes: Number.isInteger(args?.max_nodes) ? args.max_nodes : 300,
        maxChars: Number.isInteger(args?.max_chars) ? args.max_chars : 24_000,
      }));
    case "screenshot":
      return mcpSuccess(name, await bridge.command("screenshot", { tabId: requiredInteger(args, "tab_id"), fullPage: args?.full_page === true }));
    case "click":
      return mcpSuccess(name, await bridge.command("click", { tabId: requiredInteger(args, "tab_id"), target: targetFromArgs(args) }));
    case "fill":
      if (typeof args?.value !== "string") throw new BridgeError("INVALID_PARAMS", "value is required");
      return mcpSuccess(name, await bridge.command("fill", { tabId: requiredInteger(args, "tab_id"), value: args.value, target: targetFromArgs(args) }));
    case "press_key":
      if (typeof args?.key !== "string" || args.key.length === 0) throw new BridgeError("INVALID_PARAMS", "key is required");
      return mcpSuccess(name, await bridge.command("press_key", { tabId: requiredInteger(args, "tab_id"), key: args.key, target: targetFromArgs(args) }));
    case "wait_for":
      if (typeof args?.text !== "string" && typeof args?.selector !== "string") throw new BridgeError("INVALID_PARAMS", "text or selector is required");
      return mcpSuccess(name, await bridge.command("wait_for", { tabId: requiredInteger(args, "tab_id"), text: args.text, selector: args.selector, timeoutMs: Number.isInteger(args?.timeout_ms) ? args.timeout_ms : 10_000 }));
    default:
      throw new BridgeError("INVALID_PARAMS", `unknown tool: ${name}`);
  }
}

function targetFromArgs(args = {}) {
  const target = {};
  for (const key of ["node_id", "state_version", "selector", "text", "role", "name", "exact"]) {
    if (args[key] !== undefined) target[key] = args[key];
  }
  return target;
}

export async function startServer(options = {}) {
  const bridge = await new ChromeBridge(options).start();
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let closed = false;

  const writeResponse = value => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  };

  const handleLine = async line => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const id = message.id;
    const method = message.method;
    if (method === "notifications/initialized") return;
    if (method === "ping") {
      writeResponse({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "initialize") {
      writeResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "pi-chrome", version: SERVER_VERSION },
        },
      });
      return;
    }
    if (method === "tools/list") {
      writeResponse({ jsonrpc: "2.0", id, result: { tools } });
      return;
    }
    if (method === "tools/call") {
      try {
        const params = message.params ?? {};
        const result = await callTool(bridge, params.name, params.arguments ?? {});
        writeResponse({ jsonrpc: "2.0", id, result });
      } catch (error) {
        writeResponse({ jsonrpc: "2.0", id, result: mcpError(error) });
      }
      return;
    }
    if (id !== undefined) {
      writeResponse({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  };

  rl.on("line", line => {
    void handleLine(line);
  });
  const shutdown = async () => {
    if (closed) return;
    closed = true;
    rl.close();
    await bridge.stop();
  };
  process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  process.once("exit", () => bridge.rejectPending(new BridgeError("BRIDGE_STOPPED", "Pi Chrome bridge stopped")));
  return bridge;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  startServer().catch(error => {
    log(error.stack ?? error.message ?? String(error));
    process.exitCode = 1;
  });
}

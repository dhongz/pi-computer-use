#!/usr/bin/env node
/**
 * Shared per-user Pi Chrome daemon.
 *
 * It owns the single browser-extension WebSocket and multiplexes command clients
 * from multiple Pi sessions and standalone MCP processes over a second local
 * control WebSocket.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { ChromeBridge } from "./server.mjs";

const DEFAULT_BROWSER_PORT = 37842;
const DEFAULT_CONTROL_PORT = 37843;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".pi", "agent", "chrome-bridge-token");

function log(message) {
  process.stderr.write(`[pi-chrome-daemon] ${message}\n`);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ""));
  const b = Buffer.from(String(right ?? ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readToken(tokenFile) {
  const token = (await fs.readFile(tokenFile, "utf8")).trim();
  if (token.length < 32) throw new Error(`invalid Pi Chrome token at ${tokenFile}`);
  return token;
}

function id(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

class DaemonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export class ChromeDaemon {
  constructor({ browserPort = Number(process.env.PI_CHROME_PORT ?? DEFAULT_BROWSER_PORT), controlPort = Number(process.env.PI_CHROME_CONTROL_PORT ?? DEFAULT_CONTROL_PORT), tokenFile = process.env.PI_CHROME_TOKEN_FILE || DEFAULT_TOKEN_FILE } = {}) {
    this.browserPort = browserPort;
    this.controlPort = controlPort;
    this.tokenFile = tokenFile;
    this.bridge = null;
    this.controlWss = null;
    this.clients = new Map();
    this.ownerByTab = new Map();
    this.daemonId = crypto.randomUUID();
  }

  async start() {
    this.bridge = await new ChromeBridge({ port: this.browserPort, tokenFile: this.tokenFile }).start();
    const token = await readToken(this.tokenFile);
    this.controlWss = new WebSocketServer({
      host: "127.0.0.1",
      port: this.controlPort,
      path: "/control",
      verifyClient: ({ req }, done) => {
        const url = new URL(req.url, "ws://127.0.0.1");
        done(safeEqual(url.searchParams.get("token"), token), 401, "Unauthorized");
      },
    });
    this.controlWss.on("connection", socket => this.handleClient(socket));
    await new Promise((resolve, reject) => {
      this.controlWss.once("listening", resolve);
      this.controlWss.once("error", reject);
    });
    const address = this.controlWss.address();
    if (address && typeof address === "object") this.controlPort = address.port;
    log(`listening browser=${this.browserPort} control=${this.controlPort}`);
    return this;
  }

  handleClient(socket) {
    const client = { socket, sessionId: null };
    this.clients.set(socket, client);
    socket.on("message", data => void this.handleClientMessage(client, data));
    socket.on("close", () => {
      void this.releaseSession(client).finally(() => this.clients.delete(socket));
    });
    socket.on("error", error => log(`client socket error: ${error.message}`));
  }

  send(client, message) {
    if (client.socket.readyState === WebSocket.OPEN) client.socket.send(JSON.stringify(message));
  }

  async handleClientMessage(client, data) {
    let message;
    try { message = JSON.parse(data.toString()); } catch { return; }
    if (message.type === "ping") {
      this.send(client, { type: "pong" });
      return;
    }
    if (message.type === "client_hello") {
      if (message.client !== "pi-chrome-client" || typeof message.sessionId !== "string" || message.sessionId.length < 8) {
        client.socket.close(1008, "invalid Pi Chrome client");
        return;
      }
      client.sessionId = message.sessionId;
      this.send(client, {
        type: "hello_ack",
        daemonId: this.daemonId,
        browserPort: this.browserPort,
        controlPort: this.controlPort,
        extensionConnected: this.bridge.isExtensionConnected(),
      });
      return;
    }
    if (message.type !== "command" || typeof message.id !== "string") return;
    if (!client.sessionId) {
      this.send(client, { type: "response", id: message.id, ok: false, error: { code: "CLIENT_NOT_INITIALIZED", message: "Send client_hello before commands" } });
      return;
    }
    try {
      const result = await this.command(client, message.method, message.params ?? {});
      this.send(client, { type: "response", id: message.id, ok: true, result });
    } catch (error) {
      this.send(client, { type: "response", id: message.id, ok: false, error: { code: error.code ?? "DAEMON_COMMAND_FAILED", message: error.message ?? String(error), details: error.details ?? {} } });
    }
  }

  owner(tabId) {
    return this.ownerByTab.get(tabId);
  }

  requireOwner(client, tabId) {
    const tab = id(tabId);
    if (tab === null) throw new DaemonError("INVALID_TAB", "tab_id must be a positive integer");
    const owner = this.owner(tab);
    if (!owner || owner.sessionId !== client.sessionId) throw new DaemonError("TAB_NOT_OWNED", `Chrome tab ${tab} is not owned by this Pi session`, { tabId: tab });
    return tab;
  }

  async command(client, method, params) {
    if (method === "status") {
      return {
        connected: this.bridge.isExtensionConnected(),
        daemonId: this.daemonId,
        browserPort: this.browserPort,
        controlPort: this.controlPort,
        extension: this.bridge.extensionInfo ?? null,
        sessions: this.clients.size,
        ownedTabs: [...this.ownerByTab.entries()].map(([tabId, owner]) => ({ tabId, sessionId: owner.sessionId, agentOwned: owner.agentOwned })),
      };
    }

    if (method === "list_tabs") {
      const result = await this.bridge.command(method, params);
      return {
        ...result,
        tabs: (result.tabs ?? []).map(tab => ({
          ...tab,
          ownerSessionId: this.owner(tab.id)?.sessionId ?? null,
          ownerAgentOwned: this.owner(tab.id)?.agentOwned ?? false,
        })),
      };
    }

    if (method === "new_tab") {
      const result = await this.bridge.command(method, params);
      const tabId = id(result.tab?.id);
      if (tabId === null) throw new DaemonError("TAB_CREATE_FAILED", "Chrome did not return a tab id");
      this.ownerByTab.set(tabId, { sessionId: client.sessionId, agentOwned: true });
      return result;
    }

    if (method === "claim_tab") {
      const tabId = id(params.tabId);
      if (tabId === null) throw new DaemonError("INVALID_TAB", "tab_id must be a positive integer");
      const owner = this.owner(tabId);
      if (owner && owner.sessionId !== client.sessionId) throw new DaemonError("TAB_OWNED", `Chrome tab ${tabId} is owned by another Pi session`, { tabId });
      const result = await this.bridge.command(method, params);
      this.ownerByTab.set(tabId, { sessionId: client.sessionId, agentOwned: false });
      return result;
    }

    if (method === "release_tab") {
      const tabId = this.requireOwner(client, params.tabId);
      const result = await this.bridge.command(method, params);
      this.ownerByTab.delete(tabId);
      return result;
    }

    if (method === "close_tab") {
      const tabId = id(params.tabId);
      if (tabId === null) throw new DaemonError("INVALID_TAB", "tab_id must be a positive integer");
      const owner = this.owner(tabId);
      if (owner && owner.sessionId !== client.sessionId) throw new DaemonError("TAB_OWNED", `Chrome tab ${tabId} is owned by another Pi session`, { tabId });
      if (!owner && params.force !== true) throw new DaemonError("TAB_NOT_OWNED", `Chrome tab ${tabId} is not owned by this Pi session; pass force=true to close it`);
      const result = await this.bridge.command(method, params);
      this.ownerByTab.delete(tabId);
      return result;
    }

    if (["navigate", "get_state", "screenshot", "click", "fill", "press_key", "wait_for"].includes(method)) {
      this.requireOwner(client, params.tabId);
    }
    return await this.bridge.command(method, params);
  }

  async releaseSession(client) {
    if (!client.sessionId) return;
    const tabs = [...this.ownerByTab.entries()].filter(([, owner]) => owner.sessionId === client.sessionId).map(([tabId]) => tabId);
    for (const tabId of tabs) {
      try { await this.bridge.command("release_tab", { tabId }); } catch { /* tab may have closed */ }
      this.ownerByTab.delete(tabId);
    }
  }

  async stop() {
    for (const client of this.clients.values()) client.socket.close(1000, "daemon stopping");
    this.clients.clear();
    if (this.controlWss) await new Promise(resolve => this.controlWss.close(() => resolve()));
    if (this.bridge) await this.bridge.stop();
  }
}

if (import.meta.url === new URL(process.argv[1] ?? "", "file:").href) {
  const daemon = new ChromeDaemon();
  daemon.start().catch(error => {
    log(error.stack ?? error.message ?? String(error));
    process.exitCode = 1;
  });
  const shutdown = () => void daemon.stop().finally(() => process.exit(0));
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

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
import { commandTimeout } from "./client.mjs";

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
    this.taskGroups = new Map();
    this.daemonId = crypto.randomUUID();
  }

  async start() {
    this.bridge = await new ChromeBridge({ port: this.browserPort, tokenFile: this.tokenFile }).start();
    this.browserPort = this.bridge.port;
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
    const client = { socket, sessionId: null, requests: new Map() };
    this.clients.set(socket, client);
    socket.on("message", data => void this.handleClientMessage(client, data));
    socket.on("close", () => {
      for (const controller of client.requests.values()) controller.abort();
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
    if (message.type === "cancel") {
      client.requests.get(message.id)?.abort();
      return;
    }
    if (message.type !== "command" || typeof message.id !== "string") return;
    if (!client.sessionId) {
      this.send(client, { type: "response", id: message.id, ok: false, error: { code: "CLIENT_NOT_INITIALIZED", message: "Send client_hello before commands" } });
      return;
    }
    const controller = new AbortController();
    client.requests.set(message.id, controller);
    try {
      const timeoutMs = message.timeoutMs ?? commandTimeout(message.method, message.params);
      if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 125_000) throw new DaemonError("INVALID_PARAMS", "Invalid command timeout");
      const result = await this.command(client, message.method, message.params ?? {}, timeoutMs, controller.signal);
      this.send(client, { type: "response", id: message.id, ok: true, result });
    } catch (error) {
      this.send(client, { type: "response", id: message.id, ok: false, error: { code: controller.signal.aborted ? "ABORTED" : error.code ?? "DAEMON_COMMAND_FAILED", message: error.message ?? String(error), details: error.details ?? {} } });
    } finally {
      client.requests.delete(message.id);
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
    if (owner.claiming) throw new DaemonError("TAB_CLAIM_PENDING", `Chrome tab ${tab} is still being claimed`);
    return tab;
  }

  async command(client, method, params = {}, timeoutMs = commandTimeout(method, params), signal) {
    signal?.throwIfAborted();
    const forward = (name, args) => {
      signal?.throwIfAborted();
      return this.bridge.command(name, args, timeoutMs, signal);
    };
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
      const result = await forward(method, params);
      return {
        ...result,
        tabs: (result.tabs ?? []).map(tab => ({
          ...tab,
          ownerSessionId: this.owner(tab.id)?.sessionId ?? null,
          ownerAgentOwned: this.owner(tab.id)?.agentOwned ?? false,
        })),
      };
    }

    if (method === "new_tab" || method === "close_group") {
      const task = this.taskGroups.get(client.sessionId) ?? { groupId: null, pending: Promise.resolve() };
      this.taskGroups.set(client.sessionId, task);
      // Serialize creation and cleanup so parallel tool calls share one group.
      task.pending = task.pending.catch(() => {}).then(async () => {
        if (method === "new_tab") {
          const result = await forward(method, { ...params, groupId: task.groupId });
          const tabId = id(result.tab?.id);
          if (tabId === null) throw new DaemonError("TAB_CREATE_FAILED", "Chrome did not return a tab id");
          if (!Number.isInteger(result.tab.groupId) || result.tab.groupId < 0) {
            await forward("close_tab", { tabId });
            throw new DaemonError("GROUP_UNAVAILABLE", "Chrome bridge did not group the new tab; reload the Chrome extension", { tabId });
          }
          task.groupId = result.tab.groupId;
          this.ownerByTab.set(tabId, { sessionId: client.sessionId, agentOwned: true });
          return result;
        }
        if (task.groupId === null) return { closedTabIds: [], preservedTabIds: [], message: "No task group to close" };
        const tabIds = [...this.ownerByTab.entries()]
          .filter(([, owner]) => owner.sessionId === client.sessionId && owner.agentOwned)
          .map(([tabId]) => tabId);
        const result = await forward(method, { groupId: task.groupId, tabIds });
        for (const tabId of result.closedTabIds ?? []) this.ownerByTab.delete(tabId);
        task.groupId = null;
        return result;
      });
      return await task.pending;
    }

    if (method === "claim_tab") {
      const tabId = id(params.tabId);
      if (tabId === null) throw new DaemonError("INVALID_TAB", "tab_id must be a positive integer");
      const owner = this.owner(tabId);
      if (owner && owner.sessionId !== client.sessionId) throw new DaemonError("TAB_OWNED", `Chrome tab ${tabId} is owned by another Pi session`, { tabId });
      if (owner?.claiming) throw new DaemonError("TAB_CLAIM_PENDING", `Chrome tab ${tabId} is still being claimed`);
      const reservation = { sessionId: client.sessionId, agentOwned: owner?.agentOwned ?? false, claiming: true };
      this.ownerByTab.set(tabId, reservation);
      try {
        const result = await forward(method, params);
        signal?.throwIfAborted();
        reservation.claiming = false;
        return result;
      } catch (error) {
        if (this.owner(tabId) === reservation) {
          if (owner) this.ownerByTab.set(tabId, owner);
          else this.ownerByTab.delete(tabId);
        }
        throw error;
      }
    }

    if (method === "release_tab") {
      const tabId = this.requireOwner(client, params.tabId);
      const result = await forward(method, params);
      this.ownerByTab.delete(tabId);
      return result;
    }

    if (method === "close_tab") {
      const tabId = id(params.tabId);
      if (tabId === null) throw new DaemonError("INVALID_TAB", "tab_id must be a positive integer");
      const owner = this.owner(tabId);
      if (owner && owner.sessionId !== client.sessionId) throw new DaemonError("TAB_OWNED", `Chrome tab ${tabId} is owned by another Pi session`, { tabId });
      if (!owner && params.force !== true) throw new DaemonError("TAB_NOT_OWNED", `Chrome tab ${tabId} is not owned by this Pi session; pass force=true to close it`);
      if (owner?.claiming) throw new DaemonError("TAB_CLAIM_PENDING", `Chrome tab ${tabId} is still being claimed`);
      const result = await forward(method, params);
      this.ownerByTab.delete(tabId);
      return result;
    }

    if (["navigate", "get_state", "screenshot", "click", "fill", "press_key", "wait_for"].includes(method)) {
      this.requireOwner(client, params.tabId);
    }
    return await forward(method, params);
  }

  async releaseSession(client) {
    if (!client.sessionId) return;
    await this.taskGroups.get(client.sessionId)?.pending.catch(() => {});
    this.taskGroups.delete(client.sessionId);
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

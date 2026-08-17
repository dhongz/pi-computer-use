#!/usr/bin/env node
/**
 * Shared-client control plane for the Pi Chrome daemon.
 *
 * One daemon owns the browser-extension WebSocket. Pi sessions and standalone
 * MCP processes connect to the daemon here, so multiple Pi threads can share
 * one Chrome profile without competing for the browser port.
 */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { WebSocket } from "ws";

const DEFAULT_BROWSER_PORT = 37842;
const DEFAULT_CONTROL_PORT = 37843;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".pi", "agent", "chrome-bridge-token");
const DAEMON_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

export class ChromeDaemonError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ChromeDaemonError";
    this.code = code;
    this.details = details;
  }
}

async function readToken(tokenFile) {
  try {
    const token = (await fs.readFile(tokenFile, "utf8")).trim();
    if (token.length >= 32) return token;
  } catch {
    // The daemon will create the token if installation has not done so yet.
  }
  throw new ChromeDaemonError("TOKEN_NOT_FOUND", `Pi Chrome token was not found at ${tokenFile}; run scripts/install-chrome.sh first`, { tokenFile });
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class ChromeDaemonClient {
  constructor({ browserPort = Number(process.env.PI_CHROME_PORT ?? DEFAULT_BROWSER_PORT), controlPort = Number(process.env.PI_CHROME_CONTROL_PORT ?? DEFAULT_CONTROL_PORT), tokenFile = process.env.PI_CHROME_TOKEN_FILE || DEFAULT_TOKEN_FILE, sessionId = crypto.randomUUID() } = {}) {
    this.browserPort = browserPort;
    this.controlPort = controlPort;
    this.tokenFile = tokenFile;
    this.sessionId = sessionId;
    this.token = null;
    this.socket = null;
    this.pending = new Map();
    this.daemonInfo = null;
  }

  static async connect(options = {}) {
    const client = new ChromeDaemonClient(options);
    try {
      await client.connectOnce();
      return client;
    } catch (firstError) {
      await client.startDaemon();
      let lastError = firstError;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        try {
          await wait(200);
          await client.connectOnce();
          return client;
        } catch (error) {
          lastError = error;
        }
      }
      throw new ChromeDaemonError("DAEMON_UNAVAILABLE", `Pi Chrome daemon did not become available: ${lastError.message}`, { controlPort: client.controlPort });
    }
  }

  async startDaemon() {
    const env = {
      ...process.env,
      PI_CHROME_PORT: String(this.browserPort),
      PI_CHROME_CONTROL_PORT: String(this.controlPort),
      PI_CHROME_TOKEN_FILE: this.tokenFile,
    };
    const child = spawn(process.execPath, [DAEMON_SCRIPT], { env, detached: true, stdio: "ignore" });
    child.unref();
  }

  async connectOnce() {
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    this.token = await readToken(this.tokenFile);
    const url = `ws://127.0.0.1:${this.controlPort}/control?token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new ChromeDaemonError("DAEMON_CONNECT_TIMEOUT", `Timed out connecting to Pi Chrome daemon on port ${this.controlPort}`)), 5_000);
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        error ? reject(error) : resolve(value);
      };
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "client_hello", client: "pi-chrome-client", version: "0.2.0", sessionId: this.sessionId }));
      });
      socket.on("message", data => {
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.type === "hello_ack") {
          this.daemonInfo = message;
          finish(null, message);
          return;
        }
        this.handleMessage(message);
      });
      socket.once("error", error => finish(new ChromeDaemonError("DAEMON_CONNECT_FAILED", error.message, { controlPort: this.controlPort })));
      socket.once("close", () => {
        if (!settled) finish(new ChromeDaemonError("DAEMON_DISCONNECTED", "Pi Chrome daemon closed the control connection"));
        this.rejectPending(new ChromeDaemonError("DAEMON_DISCONNECTED", "Pi Chrome daemon disconnected"));
        this.socket = null;
      });
    });
    return this;
  }

  handleMessage(message) {
    if (message.type === "pong") return;
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.ok === false || message.error) pending.reject(new ChromeDaemonError(message.error?.code ?? "DAEMON_COMMAND_FAILED", message.error?.message ?? "Pi Chrome daemon command failed", message.error?.details ?? {}));
    else pending.resolve(message.result ?? {});
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  async command(method, params = {}, timeoutMs = 30_000) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) await this.connectOnce();
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ChromeDaemonError("DAEMON_COMMAND_TIMEOUT", `Pi Chrome daemon command '${method}' timed out after ${timeoutMs}ms`, { method, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ type: "command", id, sessionId: this.sessionId, method, params }));
    });
  }

  async waitForExtension(timeoutMs = 10_000) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      try {
        const status = await this.command("status", {}, Math.min(2_000, Math.max(500, deadline - Date.now())));
        if (status.connected) return true;
      } catch {
        // The daemon may still be starting; retry until the deadline.
      }
      await wait(200);
    }
    return false;
  }

  async close() {
    this.rejectPending(new ChromeDaemonError("CLIENT_CLOSED", "Pi Chrome daemon client closed"));
    if (this.socket) this.socket.close(1000, "client closing");
    this.socket = null;
  }
}

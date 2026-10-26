#!/usr/bin/env node
/** Shared control client for the per-profile Pi Chrome daemon. */

import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as wait } from "node:timers/promises";
import { WebSocket } from "ws";

const DEFAULT_BROWSER_PORT = 37842;
const DEFAULT_CONTROL_PORT = 37843;
const DEFAULT_TOKEN_FILE = path.join(os.homedir(), ".pi", "agent", "chrome-bridge-token");
const DAEMON_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "daemon.mjs");

export function commandTimeout(method, params = {}) {
  const waitMs = Number.isInteger(params.timeoutMs) ? params.timeoutMs : 10_000;
  return method === "wait_for" ? Math.max(30_000, Math.min(120_000, Math.max(0, waitMs)) + 5_000) : 30_000;
}

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
    // The daemon creates the token on first startup.
  }
  throw new ChromeDaemonError("TOKEN_NOT_FOUND", `Pi Chrome token was not found at ${tokenFile}; run scripts/install-chrome.sh first`, { tokenFile });
}

export class ChromeDaemonClient {
  constructor({ browserPort = Number(process.env.PI_CHROME_PORT ?? DEFAULT_BROWSER_PORT), controlPort = Number(process.env.PI_CHROME_CONTROL_PORT ?? DEFAULT_CONTROL_PORT), tokenFile = process.env.PI_CHROME_TOKEN_FILE || DEFAULT_TOKEN_FILE, sessionId = crypto.randomUUID() } = {}) {
    this.browserPort = browserPort;
    this.controlPort = controlPort;
    this.tokenFile = tokenFile;
    this.sessionId = sessionId;
    this.token = null;
    this.socket = null;
    this.connecting = null;
    this.closed = false;
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
      await client.close();
      throw new ChromeDaemonError("DAEMON_UNAVAILABLE", `Pi Chrome daemon did not become available: ${lastError.message}`, { controlPort: client.controlPort });
    }
  }

  async startDaemon() {
    const env = { ...process.env, PI_CHROME_PORT: String(this.browserPort), PI_CHROME_CONTROL_PORT: String(this.controlPort), PI_CHROME_TOKEN_FILE: this.tokenFile };
    const child = spawn(process.execPath, [DAEMON_SCRIPT], { env, detached: true, stdio: "ignore" });
    await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
    child.unref();
  }

  async connectOnce() {
    if (this.closed) throw new ChromeDaemonError("CLIENT_CLOSED", "Pi Chrome daemon client closed");
    if (this.connecting) return await this.connecting;
    if (this.socket?.readyState === WebSocket.OPEN) return this;
    this.connecting = this.openConnection();
    try {
      return await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async openConnection() {
    this.token = await readToken(this.tokenFile);
    if (this.closed) throw new ChromeDaemonError("CLIENT_CLOSED", "Pi Chrome daemon client closed");
    const socket = new WebSocket(`ws://127.0.0.1:${this.controlPort}/control?token=${encodeURIComponent(this.token)}`);
    this.socket = socket;
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => finish(new ChromeDaemonError("DAEMON_CONNECT_TIMEOUT", `Timed out connecting to Pi Chrome daemon on port ${this.controlPort}`)), 5_000);
      const finish = error => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) {
          if (this.socket === socket) this.socket = null;
          socket.terminate();
          reject(error);
        } else resolve();
      };
      socket.once("open", () => {
        socket.send(JSON.stringify({ type: "client_hello", client: "pi-chrome-client", version: "0.2.0", sessionId: this.sessionId }));
      });
      socket.on("message", data => {
        if (this.socket !== socket) return;
        let message;
        try { message = JSON.parse(data.toString()); } catch { return; }
        if (message.type === "hello_ack") {
          this.daemonInfo = message;
          finish();
        } else this.handleMessage(message);
      });
      socket.on("error", error => finish(new ChromeDaemonError("DAEMON_CONNECT_FAILED", error.message, { controlPort: this.controlPort })));
      socket.once("close", () => {
        if (!settled) finish(new ChromeDaemonError("DAEMON_DISCONNECTED", "Pi Chrome daemon closed the control connection"));
        if (this.socket !== socket) return;
        this.socket = null;
        this.rejectPending(new ChromeDaemonError("DAEMON_DISCONNECTED", "Pi Chrome daemon disconnected"));
      });
    });
    return this;
  }

  handleMessage(message) {
    if (message.type !== "response" || typeof message.id !== "string") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.ok === false || message.error) pending.reject(new ChromeDaemonError(message.error?.code ?? "DAEMON_COMMAND_FAILED", message.error?.message ?? "Pi Chrome daemon command failed", message.error?.details ?? {}));
    else pending.resolve(message.result ?? {});
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
  }

  async command(method, params = {}, timeoutMs = commandTimeout(method, params), signal) {
    signal?.throwIfAborted();
    await this.connectOnce();
    signal?.throwIfAborted();
    const socket = this.socket;
    const id = crypto.randomUUID();
    return await new Promise((resolve, reject) => {
      let timer;
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        this.pending.delete(id);
        error ? reject(error) : resolve(value);
      };
      const cancel = () => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel", id }));
      };
      const abort = () => { cancel(); finish(signal.reason || new DOMException("Operation aborted", "AbortError")); };
      timer = setTimeout(() => {
        cancel();
        finish(new ChromeDaemonError("DAEMON_COMMAND_TIMEOUT", `Pi Chrome daemon command '${method}' timed out after ${timeoutMs}ms`, { method, timeoutMs }));
      }, timeoutMs);
      this.pending.set(id, { resolve: value => finish(null, value), reject: error => finish(error) });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      try {
        socket.send(JSON.stringify({ type: "command", id, sessionId: this.sessionId, method, params, timeoutMs }));
      } catch (error) { finish(error); }
    });
  }

  async waitForExtension(timeoutMs = 10_000, signal) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      try {
        const status = await this.command("status", {}, Math.min(2_000, Math.max(1, deadline - Date.now())), signal);
        if (status.connected) return true;
      } catch {
        signal?.throwIfAborted();
      }
      await wait(Math.min(200, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
    return false;
  }

  async close() {
    this.closed = true;
    this.rejectPending(new ChromeDaemonError("CLIENT_CLOSED", "Pi Chrome daemon client closed"));
    const socket = this.socket;
    this.socket = null;
    if (socket?.readyState === WebSocket.OPEN) socket.close(1000, "client closing");
    else socket?.terminate();
  }
}

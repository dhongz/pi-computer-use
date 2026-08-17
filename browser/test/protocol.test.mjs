import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { WebSocket } from "ws";

const root = path.resolve(new URL("..", import.meta.url).pathname);
const serverPath = path.join(root, "server.mjs");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chrome-test-"));
const tokenFile = path.join(tempDir, "token");
await fs.writeFile(tokenFile, "test-token-012345678901234567890123456789\n", { mode: 0o600 });

const child = spawn(process.execPath, [serverPath], {
  cwd: root,
  env: { ...process.env, PI_CHROME_PORT: "0", PI_CHROME_TOKEN_FILE: tokenFile },
  stdio: ["pipe", "pipe", "pipe"],
});

const stderr = readline.createInterface({ input: child.stderr });
let port;
const serverReady = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for bridge")), 10_000);
  stderr.on("line", line => {
    const match = line.match(/bridge listening on 127\.0\.0\.1:(\d+)/);
    if (match) {
      port = Number(match[1]);
      clearTimeout(timer);
      resolve();
    }
  });
  child.once("exit", code => {
    if (port == null) reject(new Error(`bridge exited before ready (${code})`));
  });
});

const stdout = readline.createInterface({ input: child.stdout });
const responses = new Map();
stdout.on("line", line => {
  const message = JSON.parse(line);
  const waiter = responses.get(message.id);
  if (waiter) {
    responses.delete(message.id);
    waiter(message);
  }
});

function mcpRequest(id, method, params = {}) {
  return new Promise(resolve => {
    responses.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
}

await serverReady;
const initialize = await mcpRequest(1, "initialize");
assert.equal(initialize.result.serverInfo.name, "pi-chrome");
const listed = await mcpRequest(2, "tools/list");
assert.ok(listed.result.tools.some(tool => tool.name === "chrome_new_tab"));
const disconnected = await mcpRequest(3, "tools/call", { name: "chrome_status", arguments: {} });
assert.equal(disconnected.result.structuredContent.result.connected, false);

const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?token=test-token-012345678901234567890123456789`);
const commandWaiters = new Map();
socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.type === "command") {
    const waiter = commandWaiters.get(message.id);
    if (waiter) {
      commandWaiters.delete(message.id);
      waiter(message);
    }
  }
});
await new Promise((resolve, reject) => {
  socket.once("open", resolve);
  socket.once("error", reject);
});
socket.send(JSON.stringify({ type: "hello", client: "pi-chrome-extension", version: "test" }));
await new Promise(resolve => setTimeout(resolve, 50));
const connected = await mcpRequest(4, "tools/call", { name: "chrome_status", arguments: {} });
assert.equal(connected.result.structuredContent.result.connected, true);

const newTabRequest = mcpRequest(5, "tools/call", { name: "chrome_new_tab", arguments: { url: "about:blank" } });
const command = await new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), 2_000);
  const check = message => {
    clearTimeout(timer);
    resolve(message);
  };
  // The socket message handler above dispatches through this map.
  commandWaiters.set("next", check);
  const original = socket.listeners("message");
  socket.removeAllListeners("message");
  socket.on("message", data => {
    const message = JSON.parse(data.toString());
    if (message.type === "command") {
      commandWaiters.delete("next");
      check(message);
    }
    for (const listener of original) listener(data);
  });
});
assert.ok(command?.id, "bridge should forward an MCP call to the extension");
socket.send(JSON.stringify({
  type: "response",
  id: command.id,
  ok: true,
  result: { tab: { id: 123, url: "about:blank" }, message: "Created test tab" },
}));
const newTab = await newTabRequest;
assert.equal(newTab.result.structuredContent.result.tab.id, 123);

socket.close();
child.kill("SIGTERM");
await new Promise(resolve => child.once("exit", resolve));
await fs.rm(tempDir, { recursive: true, force: true });
console.log("PASS: pi-chrome MCP bridge protocol");

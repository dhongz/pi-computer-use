import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { once, getEventListeners } from "node:events";
import { WebSocketServer } from "ws";
import { ChromeDaemonClient, commandTimeout } from "../client.mjs";
import { ChromeBridge, callTool } from "../server.mjs";

const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chrome-client-test-"));
const tokenFile = path.join(temp, "token");
await fs.writeFile(tokenFile, "audit-test-token-012345678901234567890\n", { mode: 0o600 });
const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
let onCommand;
let onCancel;
server.on("connection", socket => {
  socket.on("message", raw => {
    const message = JSON.parse(raw);
    if (message.type === "client_hello") socket.send(JSON.stringify({ type: "hello_ack" }));
    if (message.type === "cancel") onCancel?.(message);
    if (message.type !== "command") return;
    if (message.method === "wait_for") onCommand?.(message);
    else socket.send(JSON.stringify({ type: "response", id: message.id, result: { connected: true } }));
  });
});
const client = new ChromeDaemonClient({ controlPort: server.address().port, tokenFile });
try {
  await client.connectOnce();
  const oldSocket = client.socket;
  const closed = once(oldSocket, "close");
  oldSocket.close();
  await closed;
  await Promise.all([client.command("status"), client.command("status"), client.command("status")]);
  assert.equal(server.clients.size, 1, "parallel reconnects must share one socket");
  assert.equal(client.socket.readyState, 1);
  assert.equal(client.pending.size, 0);

  const abort = new AbortController();
  const received = new Promise(resolve => { onCommand = resolve; });
  const cancelled = new Promise(resolve => { onCancel = resolve; });
  const pending = client.command("wait_for", { timeoutMs: 60000 }, undefined, abort.signal);
  const rejection = assert.rejects(pending, { name: "AbortError" });
  const request = await received;
  assert.equal(request.timeoutMs, 65000);
  abort.abort();
  await rejection;
  assert.equal((await cancelled).id, request.id);
  assert.equal(client.pending.size, 0);
  assert.equal(getEventListeners(abort.signal, "abort").length, 0);
  await assert.rejects(() => client.command("status", {}, undefined, abort.signal), { name: "AbortError" });

  const timedOut = new Promise(resolve => { onCommand = resolve; });
  const timeoutCancel = new Promise(resolve => { onCancel = resolve; });
  const timeout = client.command("wait_for", {}, 20);
  const timeoutRejection = assert.rejects(timeout, error => error.code === "DAEMON_COMMAND_TIMEOUT");
  const timeoutRequest = await timedOut;
  await timeoutRejection;
  assert.equal((await timeoutCancel).id, timeoutRequest.id);
  assert.equal(client.pending.size, 0);
  console.log("PASS: single-flight reconnects, cancellation, timeouts, and listener cleanup");
} finally {
  await client.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}

const bridge = new ChromeBridge();
const sent = [];
bridge.extensionInfo = {};
bridge.extensionSocket = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
const abort = new AbortController();
const pending = bridge.command("wait_for", { timeoutMs: 60000 }, undefined, abort.signal);
const rejected = assert.rejects(pending, { name: "AbortError" });
abort.abort();
await rejected;
assert.equal(sent[1].type, "cancel");
assert.equal(sent[1].id, sent[0].id);
assert.equal(bridge.pending.size, 0);
assert.equal(getEventListeners(abort.signal, "abort").length, 0);
assert.equal(commandTimeout("wait_for", { timeoutMs: 120000 }), 125000);

const originalTimeout = globalThis.setTimeout;
let observedDeadline;
globalThis.setTimeout = (callback, delay, ...args) => {
  observedDeadline = delay;
  return originalTimeout(callback, delay, ...args);
};
bridge.extensionSocket.send = raw => {
  const command = JSON.parse(raw);
  queueMicrotask(() => bridge.handleMessage(JSON.stringify({ type: "response", id: command.id, result: { found: true } })));
};
try {
  await callTool(bridge, "wait_for", { tab_id: 123, text: "ready", timeout_ms: 60000 });
  assert.equal(observedDeadline, 65000, "the browser-facing bridge must also honor long waits");
} finally { globalThis.setTimeout = originalTimeout; }
console.log("PASS: browser transport propagates cancellation and uses the requested wait deadline");

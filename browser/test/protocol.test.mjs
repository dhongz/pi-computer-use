import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { WebSocket } from "ws";
import { ChromeDaemonClient } from "../client.mjs";

const root = path.resolve(new URL("../..", import.meta.url).pathname);
const daemonPath = path.join(root, "browser", "daemon.mjs");
const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chrome-daemon-test-"));
const tokenFile = path.join(tempDir, "token");
const token = "test-token-012345678901234567890123456789";
await fs.writeFile(tokenFile, `${token}\n`, { mode: 0o600 });

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

const browserPort = await freePort();
const controlPort = await freePort();
const daemon = spawn(process.execPath, [daemonPath], {
  cwd: root,
  env: {
    ...process.env,
    PI_CHROME_PORT: String(browserPort),
    PI_CHROME_CONTROL_PORT: String(controlPort),
    PI_CHROME_TOKEN_FILE: tokenFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const daemonStderr = readline.createInterface({ input: daemon.stderr });
let daemonReady = false;
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("timed out waiting for shared daemon")), 10_000);
  daemonStderr.on("line", line => {
    if (line.includes(`browser=${browserPort}`) && line.includes(`control=${controlPort}`)) {
      daemonReady = true;
      clearTimeout(timer);
      resolve();
    }
  });
  daemon.once("exit", code => {
    if (!daemonReady) reject(new Error(`daemon exited before ready (${code})`));
  });
});

await ready;
const browserSocket = new WebSocket(`ws://127.0.0.1:${browserPort}/ws?token=${token}`);
const commandQueue = [];
const commandWaiters = [];
browserSocket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (message.type !== "command") return;
  const waiter = commandWaiters.shift();
  if (waiter) waiter(message);
  else commandQueue.push(message);
});
function nextCommand() {
  if (commandQueue.length > 0) return Promise.resolve(commandQueue.shift());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for browser command")), 5_000);
    commandWaiters.push(message => {
      clearTimeout(timer);
      resolve(message);
    });
  });
}
function respond(command, result) {
  browserSocket.send(JSON.stringify({ type: "response", id: command.id, ok: true, result }));
}

let clientOne;
let clientTwo;
try {
  await ready;
  await new Promise((resolve, reject) => {
    browserSocket.once("open", resolve);
    browserSocket.once("error", reject);
  });
  browserSocket.send(JSON.stringify({ type: "hello", client: "pi-chrome-extension", version: "test" }));
  await new Promise(resolve => setTimeout(resolve, 50));

  clientOne = new ChromeDaemonClient({ browserPort, controlPort, tokenFile, sessionId: "test-session-one" });
  await clientOne.connectOnce();
  const status = await clientOne.command("status");
  assert.equal(status.connected, true);
  assert.equal(status.sessions, 1);

  const newTabPromise = clientOne.command("new_tab", { url: "https://example.com", active: false });
  const newTabCommand = await nextCommand();
  assert.equal(newTabCommand.method, "new_tab");
  respond(newTabCommand, { tab: { id: 123, url: "https://example.com/" }, message: "Created test tab" });
  const newTab = await newTabPromise;
  assert.equal(newTab.tab.id, 123);

  clientTwo = new ChromeDaemonClient({ browserPort, controlPort, tokenFile, sessionId: "test-session-two" });
  await clientTwo.connectOnce();
  const sharedStatus = await clientTwo.command("status");
  assert.equal(sharedStatus.sessions, 2);
  await assert.rejects(() => clientTwo.command("get_state", { tabId: 123 }), error => error.code === "TAB_NOT_OWNED");

  await clientOne.close();
  const releaseCommand = await nextCommand();
  assert.equal(releaseCommand.method, "release_tab");
  respond(releaseCommand, { tab: { id: 123, url: "https://example.com/" }, message: "Released test tab" });
  await new Promise(resolve => setTimeout(resolve, 100));
  const claimPromise = clientTwo.command("claim_tab", { tabId: 123, expectedUrl: "https://example.com/" });
  const claimCommand = await nextCommand();
  assert.equal(claimCommand.method, "claim_tab");
  respond(claimCommand, { tab: { id: 123, url: "https://example.com/" }, message: "Claimed test tab" });
  const claim = await claimPromise;
  assert.equal(claim.tab.id, 123);

  console.log("PASS: shared Pi Chrome daemon multiplexes sessions and enforces tab ownership");
} finally {
  await clientOne?.close();
  if (clientTwo?.socket?.readyState === 1) {
    const closePromise = clientTwo.close();
    try {
      const releaseCommand = await nextCommand();
      if (releaseCommand.method === "release_tab") respond(releaseCommand, { tab: { id: 123, url: "https://example.com/" }, message: "Released test tab" });
    } catch {
      // The daemon may already be shutting down after a failed assertion.
    }
    await closePromise;
  }
  browserSocket.close();
  daemon.kill("SIGTERM");
  await new Promise(resolve => daemon.once("exit", resolve));
  await fs.rm(tempDir, { recursive: true, force: true });
}

import assert from "node:assert/strict";
import extension from "../../extensions/pi-chrome.js";
import { callTool } from "../server.mjs";
import { ChromeDaemonClient } from "../client.mjs";

const tools = [];
const commands = [];
const events = [];
extension({
  registerTool(tool) { tools.push(tool); },
  registerCommand(name, definition) { commands.push({ name, definition }); },
  on(name, handler) { events.push({ name, handler }); },
});

assert.ok(tools.length >= 10, `expected browser tools, got ${tools.length}`);
assert.ok(tools.some(tool => tool.name === "pi_chrome_status"));
assert.ok(tools.some(tool => tool.name === "pi_chrome_new_tab"));
assert.ok(tools.some(tool => tool.name === "pi_chrome_get_state"));
assert.ok(tools.some(tool => tool.name === "pi_chrome_close_group"));
assert.ok(commands.some(command => command.name === "chrome-status"));
assert.ok(events.some(event => event.name === "session_start"));
assert.ok(events.some(event => event.name === "session_shutdown"));

await assert.rejects(() => callTool({}, "new_tab", { group_title: " " }), /group_title/);
const forwarded = [];
await callTool({ async command(...args) { forwarded.push(args); return {}; } }, "new_tab", { group_title: "  Signup check  " });
assert.equal(forwarded[0][1].groupTitle, "Signup check");
await callTool({ async command(...args) { forwarded.push(args); return {}; } }, "close_group", {});
assert.equal(forwarded[1][0], "close_group");

const image = { data: "test-image-base64", mimeType: "image/png" };
for (const [name, args, result] of [
  ["status", {}, { connected: true }],
  ["list_tabs", {}, { tabs: [{ id: 123, title: "Test page" }] }],
  ["get_state", { tab_id: 123 }, { tab: { id: 123 }, stateVersion: 2, dom: { nodes: [{ node_id: "n1", name: "Test input" }] }, screenshot: image }],
  ["screenshot", { tab_id: 123 }, image],
]) {
  const response = await callTool({ async command() { return result; } }, name, args);
  const json = response.content.find(block => block.type === "text" && block.text.startsWith("{"));
  assert.ok(json, `${name} must expose structured results in model-visible text`);
  assert.deepEqual(JSON.parse(json.text), response.structuredContent);
  assert.ok(!json.text.includes(image.data), "image bytes must stay out of text");
  if (name === "get_state" || name === "screenshot") {
    assert.ok(response.content.some(block => block.type === "image" && block.data === image.data));
  }
}

await assert.rejects(() => callTool({}, "wait_for", { text: "ready", timeout_ms: 120001 }), /timeout_ms/);
const timeoutCalls = [];
await callTool({ async command(...args) { timeoutCalls.push(args); return {}; } }, "wait_for", { tab_id: 123, text: "ready", timeout_ms: 60000 });
assert.equal(timeoutCalls[0][2], 65000, "the transport deadline must allow the requested wait to finish");

const originalConnect = ChromeDaemonClient.connect;
let connects = 0;
let abortDuringWait;
const browserCommands = [];
const fake = {
  socket: { readyState: 1 },
  async waitForExtension() { abortDuringWait?.abort(); return true; },
  async command(...args) { browserCommands.push(args); return { message: "Dispatched" }; },
  async close() {},
};
ChromeDaemonClient.connect = async () => { connects += 1; fake.socket = { readyState: 1 }; return fake; };
const click = tools.find(tool => tool.name === "pi_chrome_click");
const ctx = { hasUI: false };
try {
  const abort = new AbortController();
  abort.abort();
  const result = await click.execute("cancelled", { tab_id: 123, selector: "button" }, abort.signal, undefined, ctx);
  assert.equal(result.details.error.code, "ABORTED");
  assert.equal(connects, 0, "pre-cancelled calls must not start a connection");
  abortDuringWait = new AbortController();
  await click.execute("cancelled-while-waiting", { tab_id: 123, selector: "button" }, abortDuringWait.signal, undefined, ctx);
  assert.equal(browserCommands.length, 0, "cancellation during startup must prevent dispatch");
  abortDuringWait = undefined;
  const signal = new AbortController().signal;
  await click.execute("click", { tab_id: 123, selector: "button" }, signal, undefined, ctx);
  assert.equal(browserCommands[0][3], signal);
  fake.socket.readyState = 3;
  await click.execute("reconnect", { tab_id: 123, selector: "button" }, signal, undefined, ctx);
  assert.equal(connects, 2, "a disconnected adapter must reconnect instead of reusing its resolved startup promise");
} finally {
  await events.find(event => event.name === "session_shutdown").handler({}, ctx);
  ChromeDaemonClient.connect = originalConnect;
}
console.log(`PASS: ${tools.length} Pi tools expose results, honor cancellation and deadlines, and recover connections`);

import assert from "node:assert/strict";
import extension from "../../extensions/pi-chrome.js";
import { callTool } from "../server.mjs";

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

console.log(`PASS: Pi Chrome extension registered ${tools.length} tools, exposes session lifecycle handlers, and returns model-visible results`);

import assert from "node:assert/strict";
import extension from "../../extensions/pi-chrome.js";

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
assert.ok(commands.some(command => command.name === "chrome-status"));
assert.ok(events.some(event => event.name === "session_start"));
assert.ok(events.some(event => event.name === "session_shutdown"));

console.log(`PASS: Pi Chrome extension registered ${tools.length} tools and exposes session lifecycle handlers`);

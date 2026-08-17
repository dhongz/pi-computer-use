import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chrome-extension-test-"));
process.env.PI_CHROME_PORT = "0";
process.env.PI_CHROME_TOKEN_FILE = path.join(tempDir, "token");
const sessionStart = events.find(event => event.name === "session_start").handler;
const sessionShutdown = events.find(event => event.name === "session_shutdown").handler;
const ctx = { hasUI: false };
await sessionStart({}, ctx);
await sessionShutdown({}, ctx);
await fs.rm(tempDir, { recursive: true, force: true });
console.log(`PASS: Pi Chrome extension registered ${tools.length} tools and owns session lifecycle`);

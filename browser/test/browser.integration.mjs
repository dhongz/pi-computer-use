// Real MV3 integration test: isolated Chrome for Testing, local fixture, real bridge.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { setTimeout as wait } from "node:timers/promises";
import { ChromeDaemon } from "../daemon.mjs";
import { ChromeDaemonClient } from "../client.mjs";
import { callTool } from "../server.mjs";

assert.ok(process.env.CHROME_BIN, "Set CHROME_BIN to a Chrome for Testing or Chromium executable (not your daily profile)");
const root = fileURLToPath(new URL("../..", import.meta.url));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-chrome-integration-"));
const tokenFile = path.join(temp, "token");
const html = `<!doctype html><meta charset="utf-8"><title>Pi Chrome safety fixture</title>
<style>body{font:16px sans-serif;padding:20px;min-height:3200px}input,select,button{margin:6px;padding:6px}#overlay{display:none;position:fixed;inset:0;background:white;z-index:99}</style>
<h1>Pi Chrome safety fixture</h1>
<label>Editable <input id="editable" value="alpha"></label>
<label>Disabled <input id="disabled" disabled value="unchanged"></label>
<label>Readonly <input id="readonly" readonly value="locked"></label>
<fieldset disabled><label>Fieldset input <input id="fieldset-input" value="locked"></label></fieldset>
<div aria-disabled="true"><button id="aria-disabled">Aria disabled</button></div>
<label>Choice <select id="choice"><option value="a">A</option><option value="b">B</option><option value="c" disabled>C</option></select></label>
<button id="disabled-button" disabled onclick="document.getElementById('clicked').textContent='Disabled button ran'">Disabled button</button>
<button id="schedule" onclick="setTimeout(()=>{const rows=document.getElementById('rows');rows.prepend(rows.lastElementChild);document.getElementById('status').textContent='Rows reordered'},600)">Schedule reorder</button>
<section id="rows"><div>Row A <button onclick="document.getElementById('clicked').textContent='Clicked row A'">Select row</button></div><div>Row B <button onclick="document.getElementById('clicked').textContent='Clicked row B'">Select row</button></div></section>
<div id="clicked">No click yet</div><div id="status">Rows unchanged</div>
<button id="show-overlay" onclick="document.getElementById('overlay').style.display='block'">Show overlay</button><div id="overlay">Overlay</div>
<div style="margin-top:2700px">Bottom marker</div>`;
const server = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const daemon = new ChromeDaemon({ browserPort: 0, controlPort: 0, tokenFile });
let browser;
let browserExited;
let stderr = "";
let one;
let two;
const run = async (client, name, args = {}, options) => (await callTool(client, name, args, options)).structuredContent.result;
const rejectCode = (action, code) => assert.rejects(action, error => error.code === code);
try {
  await daemon.start();
  const extensionDir = path.join(temp, "extension");
  await promisify(execFile)(process.execPath, ["browser/install.mjs", "--no-configure-pi", "--extension-dir", extensionDir, "--token-file", tokenFile, "--port", String(daemon.bridge.port), "--control-port", String(daemon.controlPort)], { cwd: root });
  browser = spawn(process.env.CHROME_BIN, [
    "--headless=new", `--user-data-dir=${path.join(temp, "profile")}`, "--no-first-run", "--no-default-browser-check",
    "--disable-gpu", "--disable-background-networking", "--window-size=1280,900", `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`,
    ...(process.env.CI && process.platform === "linux" ? ["--no-sandbox"] : []), "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  browserExited = once(browser, "exit");
  browser.stderr.on("data", data => { stderr = (stderr + data).slice(-12000); });
  const options = { browserPort: daemon.bridge.port, controlPort: daemon.controlPort, tokenFile };
  one = new ChromeDaemonClient(options);
  two = new ChromeDaemonClient(options);
  await Promise.all([one.connectOnce(), two.connectOnce()]);
  assert.ok(await one.waitForExtension(20000), `Chrome extension did not connect:\n${stderr}`);

  const first = (await run(one, "new_tab", { url, group_title: "Safety test" })).tab;
  const second = (await run(one, "new_tab", { url, group_title: "Safety test" })).tab;
  const other = (await run(two, "new_tab", { url, group_title: "Other session" })).tab;
  assert.ok(first.groupId >= 0);
  assert.equal(second.groupId, first.groupId);
  assert.notEqual(other.groupId, first.groupId);
  await rejectCode(() => run(two, "claim_tab", { tab_id: first.id }), "TAB_OWNED");
  await run(one, "wait_for", { tab_id: first.id, text: "Rows unchanged" });
  await run(one, "wait_for", { tab_id: first.id, text: "Rows unchanged", timeout_ms: 0 });
  await rejectCode(() => run(one, "wait_for", { tab_id: first.id, text: "Not present", timeout_ms: 0 }), "WAIT_TIMEOUT");
  const state = () => run(one, "get_state", { tab_id: first.id });
  const node = (snapshot, selector) => {
    const found = snapshot.dom.nodes.find(item => item.selector === selector);
    assert.ok(found, `Missing fixture node ${selector}`);
    return found;
  };
  const target = (snapshot, item) => ({ tab_id: first.id, node_id: item.node_id, state_version: snapshot.stateVersion });
  let snapshot = await state();
  await run(one, "fill", { ...target(snapshot, node(snapshot, "#editable")), value: "changed" });
  snapshot = await state();
  assert.equal(node(snapshot, "#editable").value, "changed");
  for (const [selector, code] of [["#disabled", "ELEMENT_DISABLED"], ["#readonly", "ELEMENT_READONLY"], ["#fieldset-input", "ELEMENT_DISABLED"]]) {
    await rejectCode(() => run(one, "fill", { tab_id: first.id, selector, value: "must not change" }), code);
  }
  for (const selector of ["#disabled-button", "#aria-disabled"]) await rejectCode(() => run(one, "click", { tab_id: first.id, selector }), "ELEMENT_DISABLED");
  for (const value of ["missing", "c"]) await rejectCode(() => run(one, "fill", { tab_id: first.id, selector: "#choice", value }), "INVALID_OPTION");
  snapshot = await state();
  assert.equal(node(snapshot, "#disabled").value, "unchanged");
  assert.equal(node(snapshot, "#readonly").value, "locked");
  assert.equal(node(snapshot, "#choice").value, "a");
  await run(one, "fill", { tab_id: first.id, selector: "#choice", value: "b" });
  assert.equal(node(await state(), "#choice").value, "b");
  console.log("PASS: real controls reject disabled/read-only actions and invalid options without changing values");

  await run(one, "click", { tab_id: first.id, selector: "#schedule" });
  snapshot = await state();
  const rowA = snapshot.dom.nodes.find(item => item.role === "button" && item.name === "Select row");
  await run(one, "wait_for", { tab_id: first.id, text: "Rows reordered", timeout_ms: 5000 });
  await rejectCode(() => run(one, "click", target(snapshot, rowA)), "STALE_STATE");
  assert.ok((await state()).dom.text.includes("No click yet"));
  console.log("PASS: asynchronous row reordering rejects old references instead of clicking the wrong row");

  const abort = new AbortController();
  const waiting = run(one, "wait_for", { tab_id: first.id, text: "Never appears", timeout_ms: 60000 }, { signal: abort.signal });
  const cancelled = assert.rejects(waiting, { name: "AbortError" });
  await wait(50);
  abort.abort();
  await cancelled;
  await run(one, "press_key", { tab_id: first.id, selector: "#editable", key: "End" });
  await run(one, "press_key", { tab_id: first.id, key: "!" });
  assert.equal(node(await state(), "#editable").value, "changed!");

  const viewport = await callTool(one, "screenshot", { tab_id: first.id });
  const full = await callTool(one, "screenshot", { tab_id: first.id, full_page: true });
  const height = response => Buffer.from(response.content.find(item => item.type === "image").data, "base64").readUInt32BE(20);
  assert.ok(height(full) > height(viewport));
  await run(one, "click", { tab_id: first.id, selector: "#show-overlay" });
  await rejectCode(() => run(one, "click", { tab_id: first.id, selector: "#schedule" }), "ELEMENT_OBSCURED");
  console.log("PASS: real cancellation, keyboard input, full-page screenshots, and overlay protection");

  await run(one, "claim_tab", { tab_id: first.id, expected_url: url });
  const cleanup = await run(one, "close_group");
  assert.deepEqual(cleanup.closedTabIds.sort(), [first.id, second.id].sort());
  const remaining = (await run(two, "list_tabs")).tabs;
  assert.ok(remaining.some(tab => tab.id === other.id));
  assert.ok(!remaining.some(tab => tab.id === first.id || tab.id === second.id));
  await run(two, "close_group");
  console.log("PASS: real grouped tabs are reused per session and cleanup preserves the other session");
} finally {
  await one?.close();
  await two?.close();
  if (browser && browser.exitCode === null) {
    browser.kill("SIGTERM");
    const exited = await Promise.race([browserExited.then(() => true), wait(5000, false, { ref: false })]);
    if (!exited) { browser.kill("SIGKILL"); await browserExited; }
  }
  await daemon.stop();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
}

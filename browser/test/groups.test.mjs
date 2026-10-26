import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { ChromeDaemon } from "../daemon.mjs";

// Exercise the MV3 code with Chrome APIs mocked; no real user tabs are touched.
const tabs = new Map();
const groups = new Map();
const removedListeners = [];
let nextTabId = 100;
let nextGroupId = 1;
let groupingFails = false;
let moveOnGet;
const noopEvent = { addListener() {} };
const chrome = {
  storage: { session: { async get() { return {}; }, async set() {} } },
  runtime: { onInstalled: noopEvent, onStartup: noopEvent },
  alarms: { onAlarm: noopEvent },
  tabs: {
    onRemoved: { addListener(listener) { removedListeners.push(listener); } },
    onUpdated: noopEvent,
    async create(params) {
      const tab = { id: nextTabId++, windowId: params.windowId ?? 1, groupId: -1, ...params };
      tabs.set(tab.id, tab);
      return tab;
    },
    async get(tabId) {
      if (moveOnGet === tabId) { tabs.get(tabId).groupId = -1; moveOnGet = undefined; }
      if (!tabs.has(tabId)) throw new Error("Tab not found");
      return tabs.get(tabId);
    },
    async group({ tabIds, groupId }) {
      if (groupingFails) throw new Error("Grouping failed");
      if (groupId === undefined) {
        groupId = nextGroupId++;
        groups.set(groupId, { id: groupId, windowId: tabs.get(tabIds[0]).windowId });
      }
      for (const tabId of tabIds) tabs.get(tabId).groupId = groupId;
      return groupId;
    },
    async query({ groupId }) { return [...tabs.values()].filter(tab => tab.groupId === groupId); },
    async remove(tabId) {
      const tab = await this.get(tabId);
      tabs.delete(tabId);
      if (![...tabs.values()].some(other => other.groupId === tab.groupId)) groups.delete(tab.groupId);
      for (const listener of removedListeners) listener(tabId);
    },
  },
  tabGroups: {
    async get(groupId) {
      if (!groups.has(groupId)) throw new Error("Group not found");
      return groups.get(groupId);
    },
    async update(groupId, params) { Object.assign(groups.get(groupId), params); },
  },
};
const context = vm.createContext({ chrome, importScripts() {}, console, AbortController, WebSocket: { OPEN: 1 }, setTimeout, clearTimeout });
const source = await fs.readFile(new URL("../extension/background.js", import.meta.url), "utf8");
vm.runInContext(`${source}\nglobalThis.testAPI = { newTab, closeGroup, claimTab, releaseTab, handleBridgeMessage, commands, domOperation };`, context);
const api = context.testAPI;
const first = await api.newTab({ groupTitle: "Signup check" });
const groupId = first.tab.groupId;
assert.equal(groups.get(groupId).title, "Pi · Signup check");
assert.equal(first.tab.active, false);
assert.equal(first.tab.agentOwned, true);
groups.get(groupId).windowId = 2;
const second = await api.newTab({ groupId, groupTitle: "Ignored on reuse" });
assert.equal(second.tab.groupId, groupId);
assert.equal(second.tab.windowId, 2);
assert.equal(groups.get(groupId).title, "Pi · Signup check");

// Dragging a user tab or a different session's tab into this group must not
// give cleanup permission to close it.
const userTab = await chrome.tabs.create({ url: "https://example.com/" });
await chrome.tabs.group({ tabIds: [userTab.id], groupId });
await api.claimTab({ tabId: userTab.id });
const otherSession = await api.newTab({ groupId });
const movedOutside = await api.newTab({ groupId });
tabs.get(movedOutside.tab.id).groupId = -1;
const released = await api.newTab({ groupId });
await api.releaseTab({ tabId: released.tab.id });
const cleanup = await api.closeGroup({
  groupId,
  tabIds: [first.tab.id, second.tab.id, userTab.id, movedOutside.tab.id, released.tab.id],
});
assert.deepEqual(Array.from(cleanup.closedTabIds), [first.tab.id, second.tab.id]);
for (const tabId of [userTab.id, otherSession.tab.id, movedOutside.tab.id, released.tab.id]) assert.ok(tabs.has(tabId));
assert.equal(cleanup.preservedTabIds.length, 3);
assert.equal((await api.closeGroup({ groupId, tabIds: [] })).closedTabIds.length, 0);
const recreated = await api.newTab({ groupId: 999, groupTitle: "New task" });
assert.notEqual(recreated.tab.groupId, 999);
assert.equal(groups.get(recreated.tab.groupId).title, "Pi · New task");
const movedDuringCleanup = await api.newTab({ groupId });
moveOnGet = movedDuringCleanup.tab.id;
const concurrentCleanup = await api.closeGroup({ groupId, tabIds: [movedDuringCleanup.tab.id] });
assert.equal(concurrentCleanup.closedTabIds.length, 0);
assert.ok(concurrentCleanup.preservedTabIds.includes(movedDuringCleanup.tab.id));
assert.ok(tabs.has(movedDuringCleanup.tab.id), "a tab moved out during cleanup must survive");

groupingFails = true;
const before = tabs.size;
await assert.rejects(() => api.newTab({}), error => error.code === "GROUP_CREATE_FAILED");
assert.equal(tabs.size, before, "failed grouping must not leave an untracked tab");
const originalCreate = chrome.tabs.create;
let createdTab;
let resumeCreate;
const tabCreated = new Promise(resolve => { createdTab = resolve; });
const createGate = new Promise(resolve => { resumeCreate = resolve; });
chrome.tabs.create = async params => {
  const tab = await originalCreate(params);
  createdTab();
  await createGate;
  return tab;
};
const abortCreation = new AbortController();
const countBeforeAbort = tabs.size;
const creating = api.newTab({ signal: abortCreation.signal });
await tabCreated;
abortCreation.abort();
resumeCreate();
await assert.rejects(creating, { name: "AbortError" });
assert.equal(tabs.size, countBeforeAbort, "cancellation during creation must remove the disposable tab");
chrome.tabs.create = originalCreate;

let polls = 0;
let polled;
const firstPoll = new Promise(resolve => { polled = resolve; });
chrome.scripting = { async executeScript() { polls += 1; polled(); return [{ result: { found: false } }]; } };
const polling = api.handleBridgeMessage(JSON.stringify({ type: "command", id: "cancel-wait", method: "wait_for", params: { tabId: otherSession.tab.id, text: "not there", timeoutMs: 60000 } }));
await firstPoll;
await api.handleBridgeMessage(JSON.stringify({ type: "cancel", id: "cancel-wait" }));
await polling;
assert.equal(polls, 1, "cancelled browser waits must stop polling");
assert.equal(api.commands.size, 0);
let pendingMutation = true;
context.__piChromeSnapshot = { token: "snapshot", dirty: false, elements: [{ isConnected: true }], observer: { takeRecords() { const records = pendingMutation ? [{}] : []; pendingMutation = false; return records; } } };
for (let attempt = 0; attempt < 2; attempt += 1) {
  assert.equal(api.domOperation({ operation: "click", target: { snapshotToken: "snapshot", nodeIndex: 0 } }).code, "STALE_STATE", "draining mutation records must not revive a stale reference");
}
console.log("PASS: Chrome groups preserve unrelated/moved tabs and cancellation stops creation and polling");

// Exercise the daemon's session boundary and concurrent group creation.
const daemon = new ChromeDaemon();
const calls = [];
let nextId = 1000;
let nextGroup = 10;
daemon.bridge = {
  async command(method, params) {
    calls.push({ method, params });
    await Promise.resolve();
    if (method === "new_tab") return { tab: { id: nextId++, groupId: params.groupId ?? nextGroup++ } };
    if (method === "close_group") return { closedTabIds: params.tabIds };
    return { tab: { id: params.tabId } };
  },
};
const one = { sessionId: "session-one" };
const two = { sessionId: "session-two" };
const [oneA, oneB, twoA] = await Promise.all([
  daemon.command(one, "new_tab", { groupTitle: "Same label" }),
  daemon.command(one, "new_tab", { groupTitle: "Same label", groupId: 999 }),
  daemon.command(two, "new_tab", { groupTitle: "Same label" }),
]);
assert.equal(oneA.tab.groupId, oneB.tab.groupId, "parallel calls must share the session group");
assert.notEqual(oneA.tab.groupId, twoA.tab.groupId, "identical labels must not combine sessions");
await daemon.command(one, "claim_tab", { tabId: 5000 });
await assert.rejects(() => daemon.command(two, "claim_tab", { tabId: oneA.tab.id }), error => error.code === "TAB_OWNED");
await daemon.command(one, "close_group", { groupId: twoA.tab.groupId, tabIds: [twoA.tab.id, 5000] });
const close = calls.find(call => call.method === "close_group");
assert.equal(close.params.groupId, oneA.tab.groupId);
assert.deepEqual(close.params.tabIds.sort(), [oneA.tab.id, oneB.tab.id].sort());
assert.ok(daemon.owner(twoA.tab.id));
assert.ok(daemon.owner(5000), "claimed user tabs must survive group cleanup");
assert.equal(daemon.owner(oneA.tab.id), undefined);
const afterCleanup = await daemon.command(one, "new_tab", {});
assert.notEqual(afterCleanup.tab.groupId, oneA.tab.groupId);
await daemon.releaseSession(one);
assert.equal(daemon.taskGroups.has(one.sessionId), false);
console.log("PASS: concurrent creation and cleanup respect session ownership, not caller-supplied group IDs");

let finishClaim;
daemon.bridge.command = async (_method, params) => {
  await new Promise(resolve => { finishClaim = resolve; });
  return { tab: { id: params.tabId } };
};
const firstClaim = daemon.command(one, "claim_tab", { tabId: 6000 });
await assert.rejects(() => daemon.command(two, "claim_tab", { tabId: 6000 }), error => error.code === "TAB_OWNED");
await assert.rejects(() => daemon.command(one, "get_state", { tabId: 6000 }), error => error.code === "TAB_CLAIM_PENDING");
finishClaim();
await firstClaim;
assert.equal(daemon.owner(6000).sessionId, one.sessionId);
daemon.bridge.command = async () => { throw new Error("Claim failed"); };
await assert.rejects(() => daemon.command(one, "claim_tab", { tabId: 6001 }), /Claim failed/);
assert.equal(daemon.owner(6001), undefined, "failed claims must release their reservation");
daemon.bridge.command = async (_method, params) => ({ tab: { id: params.tabId } });
await daemon.command(two, "claim_tab", { tabId: twoA.tab.id });
assert.equal(daemon.owner(twoA.tab.id).agentOwned, true, "reclaiming your task tab must retain cleanup rights");

const abort = new AbortController();
const task = daemon.taskGroups.get(two.sessionId);
let unblock;
task.pending = new Promise(resolve => { unblock = resolve; });
const cancelled = daemon.command(two, "new_tab", {}, undefined, abort.signal);
abort.abort();
unblock();
await assert.rejects(cancelled, { name: "AbortError" });
console.log("PASS: tab claims reserve ownership, roll back failures, and queued creation honors cancellation");

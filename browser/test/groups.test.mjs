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
const context = vm.createContext({ chrome, importScripts() {}, console });
const source = await fs.readFile(new URL("../extension/background.js", import.meta.url), "utf8");
vm.runInContext(`${source}\nglobalThis.testAPI = { newTab, closeGroup, claimTab, releaseTab };`, context);
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
groupingFails = true;
const before = tabs.size;
await assert.rejects(() => api.newTab({}), error => error.code === "GROUP_CREATE_FAILED");
assert.equal(tabs.size, before, "failed grouping must not leave an untracked tab");
console.log("PASS: Chrome task groups are labeled, reused, recreated, and cleaned without closing unrelated tabs");

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

/* global chrome */

importScripts("./bridge-config.js");

const CONFIG = globalThis.PI_CHROME_CONFIG ?? {};
const PORT = Number(CONFIG.port || 37842);
const TOKEN = String(CONFIG.token || "");
const CLIENT_VERSION = "0.1.0";
const RECONNECT_MS = 1_500;
const COMMAND_TIMEOUT_MS = 30_000;

let socket = null;
let reconnectTimer = null;
let reconnecting = false;
let bridgeSessionId = null;
let heartbeatTimer = null;
const claimedTabs = new Set();
const ownedTabs = new Set();
const snapshots = new Map();
const snapshotVersions = new Map();
let persistedSessionId = null;

function ownershipStorage() {
  return chrome.storage.session ?? chrome.storage.local;
}

const ownershipReady = (async () => {
  try {
    const stored = await ownershipStorage().get([
      "piChromeBridgeSessionId",
      "piChromeClaimedTabs",
      "piChromeOwnedTabs",
      "piChromeSnapshotVersions",
    ]);
    persistedSessionId = typeof stored.piChromeBridgeSessionId === "string" ? stored.piChromeBridgeSessionId : null;
    for (const tabId of stored.piChromeClaimedTabs ?? []) claimedTabs.add(Number(tabId));
    for (const tabId of stored.piChromeOwnedTabs ?? []) ownedTabs.add(Number(tabId));
    for (const [tabId, version] of Object.entries(stored.piChromeSnapshotVersions ?? {})) snapshotVersions.set(Number(tabId), Number(version));
  } catch {
    // A fresh profile or an older Chrome may not expose session storage yet.
  }
})();

async function persistOwnership() {
  await ownershipReady;
  const versions = Object.fromEntries(snapshotVersions.entries());
  await ownershipStorage().set({
    piChromeBridgeSessionId: persistedSessionId,
    piChromeClaimedTabs: [...claimedTabs],
    piChromeOwnedTabs: [...ownedTabs],
    piChromeSnapshotVersions: versions,
  });
}

class ChromeBridgeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ChromeBridgeError";
    this.code = code;
    this.details = details;
  }
}

function scheduleReconnect(delay = RECONNECT_MS) {
  if (reconnectTimer !== null) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function connect() {
  if (!TOKEN || reconnecting || (socket && socket.readyState === WebSocket.OPEN)) return;
  reconnecting = true;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
    socket.onopen = () => {
      reconnecting = false;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => send({ type: "ping" }), 15_000);
      socket.send(JSON.stringify({
        type: "hello",
        client: "pi-chrome-extension",
        version: CLIENT_VERSION,
        extensionId: chrome.runtime.id,
      }));
    };
    socket.onmessage = event => {
      void handleBridgeMessage(event.data);
    };
    socket.onerror = () => {
      // onclose schedules the retry; do not log page data or the token.
    };
    socket.onclose = () => {
      reconnecting = false;
      socket = null;
      bridgeSessionId = null;
      if (heartbeatTimer !== null) clearInterval(heartbeatTimer);
      heartbeatTimer = null;
      scheduleReconnect();
    };
  } catch {
    reconnecting = false;
    scheduleReconnect();
  }
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function handleBridgeMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (message?.type === "hello_ack") {
    await ownershipReady;
    const nextSessionId = message.sessionId ?? null;
    if (persistedSessionId && nextSessionId && persistedSessionId !== nextSessionId) {
      claimedTabs.clear();
      ownedTabs.clear();
      snapshots.clear();
    }
    bridgeSessionId = nextSessionId;
    persistedSessionId = nextSessionId;
    await persistOwnership();
    return;
  }
  if (message?.type === "pong") return;
  if (message?.type !== "command" || typeof message.id !== "string") return;

  try {
    await ownershipReady;
    const result = await dispatch(message.method, message.params ?? {});
    send({ type: "response", id: message.id, ok: true, result });
  } catch (error) {
    send({
      type: "response",
      id: message.id,
      ok: false,
      error: {
        code: error?.code ?? "EXTENSION_ERROR",
        message: error?.message ?? String(error),
        details: error?.details ?? {},
      },
    });
  }
}

function normalizeTabId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function tabInfo(tab) {
  const id = tab.id;
  return {
    id,
    windowId: tab.windowId,
    groupId: tab.groupId,
    title: tab.title ?? "",
    url: tab.url ?? "",
    status: tab.status ?? "",
    active: Boolean(tab.active),
    incognito: Boolean(tab.incognito),
    claimed: claimedTabs.has(id),
    agentOwned: ownedTabs.has(id),
  };
}

async function getTab(tabId) {
  const id = normalizeTabId(tabId);
  if (id === null) throw new ChromeBridgeError("INVALID_TAB", "tab_id must be a positive integer");
  try {
    return await chrome.tabs.get(id);
  } catch {
    throw new ChromeBridgeError("TAB_NOT_FOUND", `Chrome tab ${id} was not found`, { tabId: id });
  }
}

async function requireClaimed(tabId) {
  const id = normalizeTabId(tabId);
  if (id === null) throw new ChromeBridgeError("INVALID_TAB", "tab_id must be a positive integer");
  if (!claimedTabs.has(id)) {
    throw new ChromeBridgeError("TAB_NOT_CLAIMED", `Chrome tab ${id} is not claimed by Pi; call chrome_claim_tab first`, { tabId: id });
  }
  return await getTab(id);
}

function invalidateSnapshot(tabId) {
  snapshots.delete(normalizeTabId(tabId));
}

function waitForTabComplete(tabId, timeoutMs = COMMAND_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      error ? reject(error) : resolve(value);
    };
    const listener = (updatedId, changeInfo, tab) => {
      if (updatedId === tabId && changeInfo.status === "complete") finish(null, tab);
    };
    const timer = setTimeout(() => finish(new ChromeBridgeError("NAVIGATION_TIMEOUT", `Chrome tab ${tabId} did not finish loading in time`, { tabId, timeoutMs })), timeoutMs);
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") finish(null, tab);
    }).catch(error => finish(new ChromeBridgeError("TAB_NOT_FOUND", String(error), { tabId })));
  });
}

async function executeInTab(tabId, func, args = []) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func,
      args,
    });
    return results?.[0]?.result;
  } catch (error) {
    throw new ChromeBridgeError("TAB_NOT_SCRIPTABLE", `Chrome could not access tab ${tabId}. Chrome internal pages and extension pages are not scriptable.`, { tabId, cause: String(error) });
  }
}

function visibleElement(element) {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
}

function inferRole(element) {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === "a" && element.hasAttribute("href")) return "link";
  if (tag === "button") return "button";
  if (tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  if (tag === "input") {
    const type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (type === "submit" || type === "button") return "button";
    return "textbox";
  }
  if (element.isContentEditable) return "textbox";
  return null;
}

function elementName(element) {
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const value = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || "").join(" ").trim();
    if (value) return value;
  }
  for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
    const value = element.getAttribute(attr)?.trim();
    if (value) return value;
  }
  if (element.labels?.length) {
    const value = Array.from(element.labels).map(label => label.innerText).join(" ").trim();
    if (value) return value;
  }
  if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") return "";
  return (element.innerText || element.value || "").trim().replace(/\s+/g, " ").slice(0, 240);
}

function directText(element) {
  return Array.from(element.childNodes)
    .filter(node => node.nodeType === Node.TEXT_NODE)
    .map(node => node.textContent || "")
    .join(" ")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function cssPath(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const parts = [];
  let current = element;
  while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
    let part = current.tagName.toLowerCase();
    const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
    if (classes.length) part += classes.map(value => `.${CSS.escape(value)}`).join("");
    const parent = current.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter(child => child.tagName === current.tagName);
      if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
    }
    parts.unshift(part);
    current = parent;
  }
  return parts.join(" > ") || "body";
}

function buildSnapshot({ maxNodes = 300, maxChars = 24_000 } = {}) {
  const root = document.body || document.documentElement;
  const nodes = [];
  const elements = root ? [root, ...root.querySelectorAll("*")] : [];
  for (const element of elements) {
    if (nodes.length >= Math.max(1, Math.min(maxNodes, 2_000))) break;
    if (!(element instanceof HTMLElement) || !visibleElement(element)) continue;
    const role = inferRole(element);
    const text = directText(element);
    const name = elementName(element);
    const isInteractive = Boolean(role) || element.hasAttribute("tabindex") || element.hasAttribute("contenteditable");
    if (!isInteractive && !text) continue;
    const rect = element.getBoundingClientRect();
    nodes.push({
      tag: element.tagName.toLowerCase(),
      role,
      name,
      text,
      value: element instanceof HTMLInputElement && element.type.toLowerCase() === "password"
        ? undefined
        : typeof element.value === "string" ? element.value.slice(0, 500) : undefined,
      selector: cssPath(element),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }
  const lines = nodes.map((node, index) => {
    const role = node.role ? ` ${node.role}` : "";
    const name = node.name ? ` \"${node.name.replaceAll('"', "\\\"")}\"` : "";
    const text = node.text && node.text !== node.name ? ` — ${node.text}` : "";
    return `@n${index + 1}${role}${name}${text}`;
  });
  return {
    url: location.href,
    title: document.title,
    nodes,
    text: lines.join("\n").slice(0, Math.max(1_000, Math.min(maxChars, 100_000))),
    viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
  };
}

function matchesText(value, query, exact) {
  if (!query) return true;
  const left = String(value || "").trim();
  const right = String(query).trim();
  return exact ? left.toLocaleLowerCase() === right.toLocaleLowerCase() : left.toLocaleLowerCase().includes(right.toLocaleLowerCase());
}

function findUniqueTarget(target = {}) {
  const selector = typeof target.selector === "string" && target.selector ? target.selector : null;
  let candidates = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll("body *"));
  candidates = candidates.filter(element => element instanceof HTMLElement && visibleElement(element));
  if (target.role) candidates = candidates.filter(element => inferRole(element)?.toLocaleLowerCase() === String(target.role).toLocaleLowerCase());
  if (target.name) candidates = candidates.filter(element => matchesText(elementName(element), target.name, target.exact === true));
  if (target.text) candidates = candidates.filter(element => matchesText(element.innerText || directText(element), target.text, target.exact === true));
  if (candidates.length !== 1) {
    return { ok: false, code: candidates.length === 0 ? "ELEMENT_NOT_FOUND" : "AMBIGUOUS_TARGET", message: candidates.length === 0 ? "No visible DOM element matched the target" : `Target matched ${candidates.length} visible DOM elements`, count: candidates.length };
  }
  const element = candidates[0];
  return { ok: true, element, metadata: { tag: element.tagName.toLowerCase(), role: inferRole(element), name: elementName(element), selector: cssPath(element) } };
}

function clickInPage(target) {
  const match = findUniqueTarget(target);
  if (!match.ok) return match;
  const { element } = match;
  element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
  element.click();
  return { ok: true, target: match.metadata };
}

function fillInPage(target, value) {
  const match = findUniqueTarget(target);
  if (!match.ok) return match;
  const { element } = match;
  element.focus({ preventScroll: true });
  if (element instanceof HTMLSelectElement) {
    element.value = value;
  } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
  } else if (element.isContentEditable) {
    element.textContent = value;
  } else {
    return { ok: false, code: "ACTION_UNAVAILABLE", message: "Target is not an input, textarea, select, or contenteditable element" };
  }
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  return { ok: true, target: match.metadata, valueLength: value.length };
}

function focusInPage(target) {
  if (!target || Object.keys(target).length === 0) return { ok: true };
  const match = findUniqueTarget(target);
  if (!match.ok) return match;
  match.element.focus({ preventScroll: true });
  return { ok: true, target: match.metadata };
}

function findForWait({ text, selector, exact = false } = {}) {
  if (selector) {
    const nodes = Array.from(document.querySelectorAll(selector)).filter(element => element instanceof HTMLElement && visibleElement(element));
    return nodes.length > 0 ? { found: true, count: nodes.length } : { found: false, count: 0 };
  }
  const nodes = Array.from(document.querySelectorAll("body *")).filter(element => element instanceof HTMLElement && visibleElement(element) && matchesText(element.innerText || directText(element), text, exact));
  return nodes.length > 0 ? { found: true, count: nodes.length } : { found: false, count: 0 };
}

// chrome.scripting serializes only the function body. Keep the DOM helpers
// inside one injected function so snapshot/action calls do not depend on
// service-worker lexical scope.
function domOperation(input = {}) {
  const {
    operation,
    target = {},
    value,
    maxNodes = 300,
    maxChars = 24_000,
  } = input;

  function visible(element) {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0;
  }

  function roleOf(element) {
    const explicit = element.getAttribute("role");
    if (explicit) return explicit;
    const tag = element.tagName.toLowerCase();
    if (tag === "a" && element.hasAttribute("href")) return "link";
    if (tag === "button") return "button";
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    if (tag === "input") {
      const type = (element.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (element.isContentEditable) return "textbox";
    return null;
  }

  function nameOf(element) {
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const labelled = labelledBy.split(/\s+/).map(id => document.getElementById(id)?.innerText || "").join(" ").trim();
      if (labelled) return labelled;
    }
    for (const attr of ["aria-label", "title", "placeholder", "alt"]) {
      const candidate = element.getAttribute(attr)?.trim();
      if (candidate) return candidate;
    }
    if (element.labels?.length) {
      const labelled = Array.from(element.labels).map(label => label.innerText).join(" ").trim();
      if (labelled) return labelled;
    }
    if (element instanceof HTMLInputElement && element.type.toLowerCase() === "password") return "";
    return (element.innerText || element.value || "").trim().replace(/\s+/g, " ").slice(0, 240);
  }

  function directTextOf(element) {
    return Array.from(element.childNodes).filter(node => node.nodeType === Node.TEXT_NODE).map(node => node.textContent || "").join(" ").trim().replace(/\s+/g, " ").slice(0, 240);
  }

  function selectorOf(element) {
    if (element.id) return `#${CSS.escape(element.id)}`;
    const parts = [];
    let current = element;
    while (current && current.nodeType === Node.ELEMENT_NODE && current !== document.body) {
      let part = current.tagName.toLowerCase();
      const classes = Array.from(current.classList || []).filter(Boolean).slice(0, 2);
      if (classes.length) part += classes.map(className => `.${CSS.escape(className)}`).join("");
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(child => child.tagName === current.tagName);
        if (sameTag.length > 1) part += `:nth-of-type(${sameTag.indexOf(current) + 1})`;
      }
      parts.unshift(part);
      current = parent;
    }
    return parts.join(" > ") || "body";
  }

  function matches(valueToMatch, query, exact) {
    if (!query) return true;
    const left = String(valueToMatch || "").trim().toLocaleLowerCase();
    const right = String(query).trim().toLocaleLowerCase();
    return exact ? left === right : left.includes(right);
  }

  function findUnique() {
    const selector = typeof target.selector === "string" && target.selector ? target.selector : null;
    let candidates = selector ? Array.from(document.querySelectorAll(selector)) : Array.from(document.querySelectorAll("body *"));
    candidates = candidates.filter(element => element instanceof HTMLElement && visible(element));
    if (target.expected) {
      candidates = candidates.filter(element => {
        const expected = target.expected;
        const sameTag = !expected.tag || element.tagName.toLowerCase() === String(expected.tag).toLowerCase();
        const sameRole = !expected.role || roleOf(element)?.toLocaleLowerCase() === String(expected.role).toLocaleLowerCase();
        const sameName = !expected.name || matches(nameOf(element), expected.name, true);
        return sameTag && sameRole && sameName;
      });
    }
    if (target.role) candidates = candidates.filter(element => roleOf(element)?.toLocaleLowerCase() === String(target.role).toLocaleLowerCase());
    if (target.name) candidates = candidates.filter(element => matches(nameOf(element), target.name, target.exact === true));
    if (target.text) candidates = candidates.filter(element => matches(element.innerText || directTextOf(element), target.text, target.exact === true));
    if (candidates.length !== 1) return { ok: false, code: candidates.length === 0 ? "ELEMENT_NOT_FOUND" : "AMBIGUOUS_TARGET", message: candidates.length === 0 ? "No visible DOM element matched the target" : `Target matched ${candidates.length} visible DOM elements`, count: candidates.length };
    const element = candidates[0];
    return { ok: true, element, metadata: { tag: element.tagName.toLowerCase(), role: roleOf(element), name: nameOf(element), selector: selectorOf(element) } };
  }

  if (operation === "snapshot") {
    const root = document.body || document.documentElement;
    const nodes = [];
    const elements = root ? [root, ...root.querySelectorAll("*")] : [];
    for (const element of elements) {
      if (nodes.length >= Math.max(1, Math.min(maxNodes, 2_000))) break;
      if (!(element instanceof HTMLElement) || !visible(element)) continue;
      const role = roleOf(element);
      const text = directTextOf(element);
      const name = nameOf(element);
      const interactive = Boolean(role) || element.hasAttribute("tabindex") || element.hasAttribute("contenteditable");
      if (!interactive && !text) continue;
      const rect = element.getBoundingClientRect();
      nodes.push({
        tag: element.tagName.toLowerCase(),
        role,
        name,
        text,
        value: element instanceof HTMLInputElement && element.type.toLowerCase() === "password"
          ? undefined
          : typeof element.value === "string" ? element.value.slice(0, 500) : undefined,
        selector: selectorOf(element),
        disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
    const lines = nodes.map((node, index) => {
      const role = node.role ? ` ${node.role}` : "";
      const name = node.name ? ` \\"${node.name.replaceAll('\\"', "\\\\\\\"")}\\"` : "";
      const text = node.text && node.text !== node.name ? ` — ${node.text}` : "";
      return `@n${index + 1}${role}${name}${text}`;
    });
    return {
      url: location.href,
      title: document.title,
      nodes,
      text: lines.join("\\n").slice(0, Math.max(1_000, Math.min(maxChars, 100_000))),
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
    };
  }

  if (operation === "wait") {
    let candidates = target.selector ? Array.from(document.querySelectorAll(target.selector)) : Array.from(document.querySelectorAll("body *"));
    candidates = candidates.filter(element => element instanceof HTMLElement && visible(element));
    if (target.text) candidates = candidates.filter(element => matches(element.innerText || directTextOf(element), target.text, target.exact === true));
    return candidates.length > 0 ? { found: true, count: candidates.length } : { found: false, count: 0 };
  }

  const match = findUnique();
  if (!match.ok) return match;
  const element = match.element;
  if (operation === "click") {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    element.click();
    return { ok: true, target: match.metadata };
  }
  if (operation === "focus") {
    element.focus({ preventScroll: true });
    return { ok: true, target: match.metadata };
  }
  if (operation === "fill") {
    element.focus({ preventScroll: true });
    if (element instanceof HTMLSelectElement) {
      element.value = value;
    } else if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      const prototype = Object.getPrototypeOf(element);
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
      if (descriptor?.set) descriptor.set.call(element, value);
      else element.value = value;
    } else if (element.isContentEditable) {
      element.textContent = value;
    } else {
      return { ok: false, code: "ACTION_UNAVAILABLE", message: "Target is not an input, textarea, select, or contenteditable element" };
    }
    element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    return { ok: true, target: match.metadata, valueLength: value.length };
  }
  return { ok: false, code: "UNKNOWN_DOM_OPERATION", message: `Unknown DOM operation: ${operation}` };
}

async function debuggerCommand(tabId, method, params = {}) {
  const target = { tabId };
  try {
    await chrome.debugger.attach(target, "1.3");
  } catch (error) {
    throw new ChromeBridgeError("DEBUGGER_ATTACH_FAILED", `Could not attach Chrome debugger to tab ${tabId}`, { tabId, cause: String(error) });
  }
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // The tab may have closed while the command was running.
    }
  }
}

function keyInfo(input) {
  const raw = String(input);
  const parts = raw.split("+").map(part => part.trim()).filter(Boolean);
  const key = parts.pop() || raw;
  const aliases = {
    enter: "Enter", return: "Return", tab: "Tab", escape: "Escape", esc: "Esc",
    backspace: "Backspace", delete: "Delete", arrowup: "ArrowUp", arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft", arrowright: "ArrowRight", home: "Home", end: "End",
    pageup: "PageUp", pagedown: "PageDown", space: "Space",
  };
  const normalizedKey = key.length === 1 ? key : (aliases[key.toLowerCase()] ?? (key[0].toUpperCase() + key.slice(1)));
  let modifiers = 0;
  for (const modifier of parts) {
    switch (modifier.toLowerCase()) {
      case "alt":
      case "option": modifiers |= 1; break;
      case "ctrl":
      case "control": modifiers |= 2; break;
      case "cmd":
      case "command":
      case "meta": modifiers |= 4; break;
      case "shift": modifiers |= 8; break;
      default: break;
    }
  }
  const named = {
    Enter: ["Enter", "Enter", 13, "\r"],
    Return: ["Enter", "Enter", 13, "\r"],
    Tab: ["Tab", "Tab", 9, "\t"],
    Escape: ["Escape", "Escape", 27, ""],
    Esc: ["Escape", "Escape", 27, ""],
    Backspace: ["Backspace", "Backspace", 8, ""],
    Delete: ["Delete", "Delete", 46, ""],
    ArrowUp: ["ArrowUp", "ArrowUp", 38, ""],
    ArrowDown: ["ArrowDown", "ArrowDown", 40, ""],
    ArrowLeft: ["ArrowLeft", "ArrowLeft", 37, ""],
    ArrowRight: ["ArrowRight", "ArrowRight", 39, ""],
    Home: ["Home", "Home", 36, ""],
    End: ["End", "End", 35, ""],
    PageUp: ["PageUp", "PageUp", 33, ""],
    PageDown: ["PageDown", "PageDown", 34, ""],
    Space: [" ", "Space", 32, " "],
  };
  if (named[normalizedKey]) {
    const [resolvedKey, code, virtualKey, text] = named[normalizedKey];
    return { key: resolvedKey, code, virtualKey, text, modifiers };
  }
  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code = /[A-Z]/.test(upper) ? `Key${upper}` : /[0-9]/.test(key) ? `Digit${key}` : "";
    return { key, code, virtualKey: key.toUpperCase().charCodeAt(0), text: key, modifiers };
  }
  return { key: normalizedKey, code: normalizedKey, virtualKey: 0, text: "", modifiers };
}

async function sendKey(tabId, key) {
  const info = keyInfo(key);
  const target = { tabId };
  const base = {
    key: info.key,
    code: info.code,
    windowsVirtualKeyCode: info.virtualKey,
    nativeVirtualKeyCode: info.virtualKey,
    modifiers: info.modifiers,
  };
  try {
    await chrome.debugger.attach(target, "1.3");
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyDown", ...base, text: info.text, unmodifiedText: info.text });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
  } catch (error) {
    throw new ChromeBridgeError("KEY_INPUT_FAILED", `Could not press ${info.key} in Chrome tab ${tabId}`, { tabId, cause: String(error) });
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      // The tab may have closed while the key was being sent.
    }
  }
  return { key: info.key };
}

async function captureScreenshot(tabId, fullPage = false) {
  const result = await debuggerCommand(tabId, "Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: fullPage,
    fromSurface: true,
  });
  return { data: result.data, mimeType: "image/png", fullPage };
}

async function listTabs() {
  const tabs = await chrome.tabs.query({});
  return { tabs: tabs.filter(tab => tab.id != null).map(tabInfo), sessionId: bridgeSessionId };
}

async function newTab({ url = "about:blank", active = false } = {}) {
  const tab = await chrome.tabs.create({ url, active: Boolean(active) });
  if (tab.id == null) throw new ChromeBridgeError("TAB_CREATE_FAILED", "Chrome did not return an id for the new tab");
  claimedTabs.add(tab.id);
  ownedTabs.add(tab.id);
  invalidateSnapshot(tab.id);
  await persistOwnership();
  return { tab: tabInfo(tab), message: `Created and claimed Chrome tab ${tab.id}` };
}

async function claimTab({ tabId, expectedTitle, expectedUrl } = {}) {
  const tab = await getTab(tabId);
  if (expectedTitle !== undefined && tab.title !== expectedTitle) throw new ChromeBridgeError("TAB_CHANGED", "Tab title changed before it could be claimed", { expectedTitle, actualTitle: tab.title });
  if (expectedUrl !== undefined && tab.url !== expectedUrl) throw new ChromeBridgeError("TAB_CHANGED", "Tab URL changed before it could be claimed", { expectedUrl, actualUrl: tab.url });
  claimedTabs.add(tab.id);
  await persistOwnership();
  return { tab: tabInfo(tab), message: `Claimed Chrome tab ${tab.id}` };
}

async function releaseTab({ tabId }) {
  const id = normalizeTabId(tabId);
  claimedTabs.delete(id);
  ownedTabs.delete(id);
  invalidateSnapshot(id);
  const tab = await getTab(id);
  await persistOwnership();
  return { tab: tabInfo(tab), message: `Released Chrome tab ${id}` };
}

async function closeTab({ tabId, force = false }) {
  const id = normalizeTabId(tabId);
  if (!force && !ownedTabs.has(id)) throw new ChromeBridgeError("TAB_NOT_OWNED", `Tab ${id} was not created by Pi; pass force=true to close it`);
  await getTab(id);
  await chrome.tabs.remove(id);
  claimedTabs.delete(id);
  ownedTabs.delete(id);
  invalidateSnapshot(id);
  await persistOwnership();
  return { tabId: id, message: `Closed Chrome tab ${id}` };
}

async function navigate({ tabId, url }) {
  const tab = await requireClaimed(tabId);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ChromeBridgeError("INVALID_URL", `Invalid URL: ${url}`);
  }
  if (!["http:", "https:", "about:"].includes(parsed.protocol)) throw new ChromeBridgeError("INVALID_URL", "Only http, https, and about URLs are allowed");
  await chrome.tabs.update(tab.id, { url: parsed.toString() });
  const updated = await waitForTabComplete(tab.id);
  invalidateSnapshot(tab.id);
  return { tab: tabInfo(updated), message: `Navigated Chrome tab ${tab.id}` };
}

async function getState({ tabId, screenshot = false, maxNodes = 300, maxChars = 24_000 }) {
  const tab = await requireClaimed(tabId);
  const raw = await executeInTab(tab.id, domOperation, [{ operation: "snapshot", maxNodes, maxChars }]);
  const version = (snapshotVersions.get(tab.id) ?? 0) + 1;
  snapshotVersions.set(tab.id, version);
  await persistOwnership();
  const nodesById = new Map();
  const nodes = (raw?.nodes ?? []).map((node, index) => {
    const nodeId = `tab${tab.id}-v${version}-n${index + 1}`;
    const enriched = { node_id: nodeId, ...node };
    nodesById.set(nodeId, {
      selector: node.selector,
      version,
      fingerprint: { tag: node.tag, role: node.role, name: node.name },
    });
    return enriched;
  });
  snapshots.set(tab.id, { version, nodesById });
  const result = {
    stateVersion: version,
    capturedAt: new Date().toISOString(),
    tab: tabInfo(tab),
    dom: { format: "visible-dom", refsVersion: version, text: raw?.text ?? "", nodes },
    page: { url: raw?.url ?? tab.url ?? "", title: raw?.title ?? tab.title ?? "", viewport: raw?.viewport ?? null },
  };
  if (screenshot) result.screenshot = await captureScreenshot(tab.id);
  return result;
}

function targetForSnapshot(tabId, target = {}) {
  if (target.node_id) {
    const snapshot = snapshots.get(tabId);
    if (!snapshot || target.state_version !== snapshot.version) {
      throw new ChromeBridgeError("STALE_STATE", `DOM node ${target.node_id} is stale; call chrome_get_state again`, { tabId, expectedStateVersion: target.state_version, currentStateVersion: snapshot?.version ?? null });
    }
    const node = snapshot.nodesById.get(target.node_id);
    if (!node) throw new ChromeBridgeError("STALE_STATE", `DOM node ${target.node_id} is unknown; call chrome_get_state again`, { tabId });
    return { selector: node.selector, exact: true, expected: node.fingerprint };
  }
  const clean = {};
  for (const key of ["selector", "text", "role", "name", "exact"]) if (target[key] !== undefined) clean[key] = target[key];
  if (Object.keys(clean).length === 0) throw new ChromeBridgeError("INVALID_TARGET", "Provide node_id from chrome_get_state or a selector/text/name target");
  return clean;
}

async function click({ tabId, target }) {
  await requireClaimed(tabId);
  const resolved = targetForSnapshot(tabId, target);
  const result = await executeInTab(tabId, domOperation, [{ operation: "click", target: resolved }]);
  if (!result?.ok) throw new ChromeBridgeError(result?.code ?? "ACTION_FAILED", result?.message ?? "Click failed", { count: result?.count ?? 0 });
  invalidateSnapshot(tabId);
  return { action: { kind: "click", method: "DOMClick", target: result.target, stateChanged: true }, message: `Clicked ${result.target.name || result.target.role || result.target.tag}` };
}

async function fill({ tabId, target, value }) {
  await requireClaimed(tabId);
  const resolved = targetForSnapshot(tabId, target);
  const result = await executeInTab(tabId, domOperation, [{ operation: "fill", target: resolved, value }]);
  if (!result?.ok) throw new ChromeBridgeError(result?.code ?? "ACTION_FAILED", result?.message ?? "Fill failed", { count: result?.count ?? 0 });
  invalidateSnapshot(tabId);
  return { action: { kind: "fill", method: "DOMValue", target: result.target, stateChanged: true }, message: `Filled ${result.target.name || result.target.role || result.target.tag}` };
}

async function pressKey({ tabId, target, key }) {
  await requireClaimed(tabId);
  if (target && Object.keys(target).length > 0) {
    const resolved = targetForSnapshot(tabId, target);
    const focused = await executeInTab(tabId, domOperation, [{ operation: "focus", target: resolved }]);
    if (!focused?.ok) throw new ChromeBridgeError(focused?.code ?? "ACTION_FAILED", focused?.message ?? "Could not focus key target");
  }
  const result = await sendKey(tabId, key);
  invalidateSnapshot(tabId);
  return { action: { kind: "press_key", method: "CDPInput", key: result.key, stateChanged: true }, message: `Pressed ${result.key}` };
}

async function waitFor({ tabId, text, selector, timeoutMs = 10_000 }) {
  await requireClaimed(tabId);
  const started = Date.now();
  while (Date.now() - started < Math.max(0, Math.min(timeoutMs, 120_000))) {
    const result = await executeInTab(tabId, domOperation, [{ operation: "wait", target: { text, selector } }]);
    if (result?.found) return { found: true, elapsedMs: Date.now() - started, count: result.count, message: "Chrome target appeared" };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new ChromeBridgeError("WAIT_TIMEOUT", `Timed out waiting for Chrome ${selector ? `selector ${selector}` : `text ${text}`}`, { timeoutMs });
}

async function dispatch(method, params) {
  switch (method) {
    case "list_tabs": return await listTabs();
    case "new_tab": return await newTab(params);
    case "claim_tab": return await claimTab(params);
    case "release_tab": return await releaseTab(params);
    case "close_tab": return await closeTab(params);
    case "navigate": return await navigate(params);
    case "get_state": return await getState(params);
    case "screenshot": {
      await requireClaimed(params.tabId);
      return await captureScreenshot(params.tabId, params.fullPage === true);
    }
    case "click": return await click(params);
    case "fill": return await fill(params);
    case "press_key": return await pressKey(params);
    case "wait_for": return await waitFor(params);
    default: throw new ChromeBridgeError("UNKNOWN_COMMAND", `Unknown extension command: ${method}`);
  }
}

chrome.tabs.onRemoved.addListener(tabId => {
  claimedTabs.delete(tabId);
  ownedTabs.delete(tabId);
  snapshots.delete(tabId);
  snapshotVersions.delete(tabId);
  void persistOwnership();
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create("pi-chrome-reconnect", { periodInMinutes: 0.5 });
  connect();
});
chrome.runtime.onStartup.addListener(() => connect());
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === "pi-chrome-reconnect") connect();
});

connect();

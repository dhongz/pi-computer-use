//
//  Tools.swift
//  PiComputerUse / PiComputerUseMac
//
//  MCP tool implementations and the tool registry. Each `t_*` function takes
//  a decoded `arguments` dictionary and returns an MCP content envelope.
//

import Foundation
import ApplicationServices
import AppKit

enum ToolError: Error { case bad(String) }

public func toolResult(_ text: String) -> [String: Any] {
    return ["content": [["type": "text", "text": text]]]
}

public func toolError(_ msg: String) -> [String: Any] {
    return ["content": [["type": "text", "text": msg]], "isError": true]
}

// MARK: - Tool implementations

public func t_listApps() -> [String: Any] {
    return toolResult(listApps())
}

public func t_axTree(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required") }
    if let e = checkAxPermission() { return toolError(e) }
    let maxDepth = (args["max_depth"] as? Int) ?? 12
    let scope = (args["scope"] as? String) ?? "window"
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    Thread.sleep(forTimeInterval: 0.2)
    let target = scope == "app" ? axApp : focusedWindow(of: axApp)
    refMap.removeAll()
    var counter = 0
    var out = ""
    walkText(target, maxDepth: maxDepth, counter: &counter, out: &out)
    return toolResult(out)
}

public func t_axTreeJson(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required") }
    if let e = checkAxPermission() { return toolError(e) }
    let maxDepth = (args["max_depth"] as? Int) ?? 12
    let scope = (args["scope"] as? String) ?? "window"
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    Thread.sleep(forTimeInterval: 0.2)
    let target = scope == "app" ? axApp : focusedWindow(of: axApp)
    refMap.removeAll()
    var counter = 0
    let root = walkJson(target, maxDepth: maxDepth, counter: &counter)
    if let data = try? JSONSerialization.data(withJSONObject: root, options: [.sortedKeys]),
       let s = String(data: data, encoding: .utf8) {
        return toolResult(s)
    }
    return toolError("JSON serialization failed")
}

public func t_findElement(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let q = args["query"] as? String else {
        return toolError("bundle_id and query required")
    }
    if let e = checkAxPermission() { return toolError(e) }
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    Thread.sleep(forTimeInterval: 0.2)
    guard let hit = find(axApp, q) else { return toolError("not found: \(q)") }
    var info = "role=\((axAttr(hit, kAXRoleAttribute as String) as? String) ?? "?")"
    if let d = axString(hit, kAXDescriptionAttribute as String) { info += " desc=\(d)" }
    if let t = axString(hit, kAXTitleAttribute as String) { info += " title=\(t)" }
    if let c = elementCenter(hit) { info += " center=(\(c.x),\(c.y))" }
    var actions: CFArray?
    AXUIElementCopyActionNames(hit, &actions)
    if let arr = actions as? [String] { info += " actions=\(arr)" }
    return toolResult(info)
}

public func t_clickElement(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let q = args["query"] as? String else {
        return toolError("bundle_id and query required")
    }
    if let e = checkAxPermission() { return toolError(e) }
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    Thread.sleep(forTimeInterval: 0.2)
    guard let hit = find(axApp, q) else { return toolError("not found: \(q)") }
    var actions: CFArray?
    AXUIElementCopyActionNames(hit, &actions)
    if let arr = actions as? [String], arr.contains(kAXPressAction as String) {
        let err = AXUIElementPerformAction(hit, kAXPressAction as CFString)
        return toolResult(err == .success ? "AXPress ok" : "AXPress failed: \(err.rawValue)")
    }
    guard let pt = elementCenter(hit) else { return toolError("no action, no geometry") }
    sendClick(pt)
    return toolResult("clicked at (\(pt.x),\(pt.y))")
}

public func t_clickRef(_ args: [String: Any]) -> [String: Any] {
    guard let ref = args["ref"] as? Int else { return toolError("ref (int) required") }
    guard let e = refMap[ref] else { return toolError("ref @e\(ref) not in map. call get_ax_tree first") }
    var actions: CFArray?
    AXUIElementCopyActionNames(e, &actions)
    if let arr = actions as? [String], arr.contains(kAXPressAction as String) {
        let err = AXUIElementPerformAction(e, kAXPressAction as CFString)
        return toolResult(err == .success ? "AXPress @e\(ref) ok" : "AXPress @e\(ref) failed: \(err.rawValue)")
    }
    guard let pt = elementCenter(e) else { return toolError("@e\(ref): no action and no geometry") }
    sendClick(pt)
    return toolResult("clicked @e\(ref) at (\(pt.x),\(pt.y))")
}

public func t_typeText(_ args: [String: Any]) -> [String: Any] {
    guard let text = args["text"] as? String else { return toolError("text required") }
    sendType(text)
    return toolResult("typed \(text.count) chars")
}

public func t_keyPress(_ args: [String: Any]) -> [String: Any] {
    guard let key = args["key"] as? String else { return toolError("key required") }
    let mods = (args["modifiers"] as? [String]) ?? []
    let ok = sendKey(key, flags: parseFlags(mods))
    return ok ? toolResult("key \(key) sent") : toolError("unknown key: \(key)")
}

public func t_activate(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required") }
    return activateApp(bid) ? toolResult("activated \(bid)") : toolError("not running: \(bid)")
}

public func t_wait(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let q = args["query"] as? String else {
        return toolError("bundle_id and query required")
    }
    if let e = checkAxPermission() { return toolError(e) }
    let timeout = (args["timeout"] as? Double) ?? 10.0
    let interval = 0.3
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    let start = Date()
    while Date().timeIntervalSince(start) < timeout {
        if find(axApp, q) != nil {
            let elapsed = Date().timeIntervalSince(start)
            return toolResult(String(format: "found after %.2fs", elapsed))
        }
        Thread.sleep(forTimeInterval: interval)
    }
    return toolError("timeout after \(timeout)s waiting for: \(q)")
}

public func t_scroll(_ args: [String: Any]) -> [String: Any] {
    let dx = Int32((args["dx"] as? Int) ?? 0)
    let dy = Int32((args["dy"] as? Int) ?? 0)
    if dx == 0 && dy == 0 { return toolError("dx and/or dy required (non-zero)") }
    if let bid = args["bundle_id"] as? String, let q = args["query"] as? String {
        if let e = checkAxPermission() { return toolError(e) }
        guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
        let axApp = AXUIElementCreateApplication(app.processIdentifier)
        enableEnhanced(axApp)
        guard let hit = find(axApp, q), let pt = elementCenter(hit) else {
            return toolError("not found: \(q)")
        }
        sendScroll(dx: dx, dy: dy, at: pt)
        return toolResult("scrolled dx=\(dx) dy=\(dy) over (\(pt.x),\(pt.y))")
    }
    sendScroll(dx: dx, dy: dy)
    return toolResult("scrolled dx=\(dx) dy=\(dy) at cursor")
}

public func t_rightClick(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let q = args["query"] as? String else {
        return toolError("bundle_id and query required")
    }
    if let e = checkAxPermission() { return toolError(e) }
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    guard let hit = find(axApp, q), let pt = elementCenter(hit) else {
        return toolError("not found: \(q)")
    }
    sendRightClick(pt)
    return toolResult("right-clicked at (\(pt.x),\(pt.y))")
}

public func t_clipGet(_ args: [String: Any]) -> [String: Any] {
    let pb = NSPasteboard.general
    if let s = pb.string(forType: .string) { return toolResult(s) }
    return toolError("clipboard empty or not text")
}

public func t_clipSet(_ args: [String: Any]) -> [String: Any] {
    guard let text = args["text"] as? String else { return toolError("text required") }
    let pb = NSPasteboard.general
    pb.clearContents()
    pb.setString(text, forType: .string)
    return toolResult("set clipboard: \(text.count) chars")
}

public func t_menu(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let path = args["path"] as? String else {
        return toolError("bundle_id and path required (e.g. 'File/Open')")
    }
    if let e = checkAxPermission() { return toolError(e) }
    guard let app = findApp(bid) else { return toolError("not running: \(bid)") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    guard let menuBarRef = axAttr(axApp, kAXMenuBarAttribute as String) else {
        return toolError("no menu bar for \(bid)")
    }
    let parts = path.split(separator: "/").map { String($0) }
    if parts.isEmpty { return toolError("empty path") }
    var current = menuBarRef as! AXUIElement
    for (i, part) in parts.enumerated() {
        guard let children = axAttr(current, kAXChildrenAttribute as String) as? [AXUIElement] else {
            return toolError("no children at depth \(i): \(part)")
        }
        guard let next = children.first(where: { (axString($0, kAXTitleAttribute as String) ?? "") == part }) else {
            let titles = children.compactMap { axString($0, kAXTitleAttribute as String) }
            return toolError("menu item not found: '\(part)' (available: \(titles.joined(separator: ", ")))")
        }
        if i == parts.count - 1 {
            let err = AXUIElementPerformAction(next, kAXPressAction as CFString)
            return err == .success ? toolResult("pressed menu: \(path)") : toolError("AXPress failed: \(err.rawValue)")
        }
        if let submenu = (axAttr(next, kAXChildrenAttribute as String) as? [AXUIElement])?.first {
            current = submenu
        } else {
            return toolError("no submenu under: \(part)")
        }
    }
    return toolError("unreachable")
}

public func t_screenshot(_ args: [String: Any]) -> [String: Any] {
    let bid = args["bundle_id"] as? String
    do {
        let (path, data) = try captureScreenshot(bundleId: bid)
        if (args["return"] as? String) == "base64" {
            return ["content": [["type": "image", "data": data.base64EncodedString(), "mimeType": "image/png"]]]
        }
        return toolResult(path)
    } catch let ScreenshotError.captureFailed(msg) {
        return toolError(msg)
    } catch let ScreenshotError.missingData(msg) {
        return toolError(msg)
    } catch {
        return toolError("screenshot failed: \(error)")
    }
}

// MARK: - Tool registry

public let toolsList: [[String: Any]] = [
    [
        "name": "list_apps",
        "description": "List running macOS GUI applications with bundle IDs and PIDs",
        "inputSchema": ["type": "object", "properties": [:]]
    ],
    [
        "name": "get_ax_tree",
        "description": "Get the accessibility tree of a running app's focused window (or whole app). Returns numbered text tree. Use this to understand what UI is visible before clicking anything.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string", "description": "e.g. com.google.Chrome"],
                "max_depth": ["type": "integer", "default": 12],
                "scope": ["type": "string", "enum": ["window", "app"], "default": "window"]
            ],
            "required": ["bundle_id"]
        ]
    ],
    [
        "name": "ax_tree_json",
        "description": "Like get_ax_tree but returns JSON tree (ref/role/title/description/value/help/children)",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "max_depth": ["type": "integer", "default": 12],
                "scope": ["type": "string", "enum": ["window", "app"], "default": "window"]
            ],
            "required": ["bundle_id"]
        ]
    ],
    [
        "name": "find_element",
        "description": "Find first AX element in app matching query (substring in description/title/value/help). Returns role, geometry, available actions.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "query": ["type": "string"]
            ],
            "required": ["bundle_id", "query"]
        ]
    ],
    [
        "name": "click_element",
        "description": "Find element by query and click it (AXPress if available, else CGEvent click at center)",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "query": ["type": "string"]
            ],
            "required": ["bundle_id", "query"]
        ]
    ],
    [
        "name": "click_ref",
        "description": "Click an element by its @e ref number from the last get_ax_tree call. Refs are invalidated when get_ax_tree is called again.",
        "inputSchema": [
            "type": "object",
            "properties": ["ref": ["type": "integer", "description": "the N in @eN"]],
            "required": ["ref"]
        ]
    ],
    [
        "name": "type_text",
        "description": "Type Unicode text into the currently focused field (uses CGEvent)",
        "inputSchema": [
            "type": "object",
            "properties": ["text": ["type": "string"]],
            "required": ["text"]
        ]
    ],
    [
        "name": "key_press",
        "description": "Send a single key, optionally with modifiers. Example: key=t modifiers=[cmd] for Cmd+T",
        "inputSchema": [
            "type": "object",
            "properties": [
                "key": ["type": "string", "description": "return/tab/space/escape/letter/digit/arrow"],
                "modifiers": ["type": "array", "items": ["type": "string"]]
            ],
            "required": ["key"]
        ]
    ],
    [
        "name": "activate",
        "description": "Bring an app to foreground. Crucial before sending keystrokes — call this first to avoid leaking input into other apps.",
        "inputSchema": [
            "type": "object",
            "properties": ["bundle_id": ["type": "string"]],
            "required": ["bundle_id"]
        ]
    ],
    [
        "name": "wait_for",
        "description": "Poll for an AX element matching query until it appears or timeout (default 10s). Use to bridge async loads.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "query": ["type": "string"],
                "timeout": ["type": "number", "default": 10]
            ],
            "required": ["bundle_id", "query"]
        ]
    ],
    [
        "name": "scroll",
        "description": "Send scroll wheel event. With bundle_id+query, scrolls over that element; otherwise at current cursor position.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "query": ["type": "string"],
                "dx": ["type": "integer", "default": 0],
                "dy": ["type": "integer", "default": 0, "description": "Negative = scroll down in content"]
            ]
        ]
    ],
    [
        "name": "right_click",
        "description": "Right-click an element matching query (opens context menu)",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "query": ["type": "string"]
            ],
            "required": ["bundle_id", "query"]
        ]
    ],
    [
        "name": "screenshot",
        "description": "Capture a screenshot. If bundle_id is given, captures that app's main window; otherwise full screen. Returns file path by default, or base64 image when return=base64.",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "return": ["type": "string", "enum": ["path", "base64"], "default": "path"]
            ]
        ]
    ],
    [
        "name": "menu",
        "description": "Press a menubar item by path (e.g. 'File/Open Recent/Project.txt')",
        "inputSchema": [
            "type": "object",
            "properties": [
                "bundle_id": ["type": "string"],
                "path": ["type": "string", "description": "Slash-separated menu path"]
            ],
            "required": ["bundle_id", "path"]
        ]
    ],
    [
        "name": "clip_get",
        "description": "Read clipboard text",
        "inputSchema": ["type": "object", "properties": [:]]
    ],
    [
        "name": "clip_set",
        "description": "Write clipboard text (replaces current content)",
        "inputSchema": [
            "type": "object",
            "properties": ["text": ["type": "string"]],
            "required": ["text"]
        ]
    ]
]

public func handleTool(_ name: String, _ args: [String: Any]) -> [String: Any] {
    switch name {
    case "list_apps":     return t_listApps()
    case "get_ax_tree":   return t_axTree(args)
    case "ax_tree_json":  return t_axTreeJson(args)
    case "find_element":  return t_findElement(args)
    case "click_element": return t_clickElement(args)
    case "click_ref":     return t_clickRef(args)
    case "type_text":     return t_typeText(args)
    case "key_press":     return t_keyPress(args)
    case "activate":      return t_activate(args)
    case "wait_for":      return t_wait(args)
    case "scroll":        return t_scroll(args)
    case "right_click":   return t_rightClick(args)
    case "screenshot":    return t_screenshot(args)
    case "menu":          return t_menu(args)
    case "clip_get":      return t_clipGet(args)
    case "clip_set":      return t_clipSet(args)
    default:              return toolError("unknown tool: \(name)")
    }
}

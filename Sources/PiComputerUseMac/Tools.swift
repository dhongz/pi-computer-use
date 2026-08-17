//
//  Tools.swift
//  MCP tool facade. The facade is stateful through ComputerUseSession while
//  retaining the v0.1 diagnostic tool names for compatibility.
//

import Foundation
import ApplicationServices
import AppKit
import CoreGraphics

public func toolResult(_ text: String, structured: [String: Any]? = nil, additionalContent: [[String: Any]] = []) -> [String: Any] {
    var content: [[String: Any]] = [["type": "text", "text": text]]
    content.append(contentsOf: additionalContent)
    var result: [String: Any] = ["content": content]
    if let structured { result["structuredContent"] = structured }
    return result
}

public func toolError(_ msg: String, code: String = "INTERNAL_ERROR", details: [String: Any] = [:], requestId: String = requestID()) -> [String: Any] {
    var error: [String: Any] = ["code": code, "message": msg, "retryable": code != "ACTION_FAILED", "requiresStateRefresh": code == "STALE_REF"]
    if !details.isEmpty { error["details"] = details }
    let envelope: [String: Any] = ["ok": false, "requestId": requestId, "warnings": [], "action": NSNull(), "state": NSNull(), "error": error]
    return [
        "content": [["type": "text", "text": msg]],
        "structuredContent": envelope,
        "isError": true
    ]
}

private func success(_ text: String, requestId: String = requestID(), action: [String: Any]? = nil, state: [String: Any]? = nil, warnings: [String] = [], additionalContent: [[String: Any]] = []) -> [String: Any] {
    var envelope: [String: Any] = ["ok": true, "requestId": requestId, "warnings": warnings]
    envelope["action"] = action ?? NSNull()
    envelope["state"] = state ?? NSNull()
    return toolResult(text, structured: envelope, additionalContent: additionalContent)
}

private func appContext(_ bundleID: String, scope: String = "window") -> (NSRunningApplication, AXUIElement, AXUIElement, CGWindowID?)? {
    guard let app = findApp(bundleID) else { return nil }
    let axApp = AXUIElementCreateApplication(app.processIdentifier)
    enableEnhanced(axApp)
    let target = scope == "app" ? axApp : focusedWindow(of: axApp)
    return (app, axApp, target, windowIdFor(pid: app.processIdentifier))
}

private func prepareTree(bundleID: String, maxDepth: Int, scope: String) -> (app: NSRunningApplication, axApp: AXUIElement, target: AXUIElement, root: [String: Any], text: String, windowID: CGWindowID?)? {
    guard let context = appContext(bundleID, scope: scope) else { return nil }
    computerUseSession.beginTree(appBundleID: bundleID, pid: context.0.processIdentifier, windowID: context.3)
    refMap.removeAll(keepingCapacity: true)
    treePartial = false
    var counter = 0
    var text = ""
    walkText(context.2, maxDepth: maxDepth, counter: &counter, out: &text)
    // walkText and walkJson must use identical refs; build the structured tree
    // from the same state by walking again without replacing the session refs.
    // The second walk intentionally gets local ref numbers only.
    var jsonCounter = 0
    registerSessionRefs = false
    let root = walkJson(context.2, maxDepth: maxDepth, counter: &jsonCounter)
    registerSessionRefs = true
    return (context.0, context.1, context.2, root, text, context.3)
}

private func appState(bundleID: String, app: NSRunningApplication, root: [String: Any], text: String, windowID: CGWindowID?, screenshot: [String: Any]? = nil, ocr: [String: Any]? = nil, partial: Bool = false) -> [String: Any] {
    var window: [String: Any] = ["focused": NSWorkspace.shared.frontmostApplication?.processIdentifier == app.processIdentifier]
    if let title = axString(focusedWindow(of: AXUIElementCreateApplication(app.processIdentifier)), kAXTitleAttribute as String) { window["title"] = title }
    if let windowID { window["id"] = windowID }
    let accessibility: [String: Any] = [
        "format": "tree", "text": text, "tree": root,
        "refsVersion": computerUseSession.refsVersion, "partial": partial
    ]
    var state: [String: Any] = [
        "stateVersion": computerUseSession.stateVersion,
        "capturedAt": isoNow(),
        "app": [
            "bundleId": app.bundleIdentifier ?? "", "displayName": app.localizedName ?? "?",
            "pid": app.processIdentifier, "isFrontmost": window["focused"] as? Bool ?? false
        ],
        "window": window,
        "accessibility": accessibility
    ]
    state["screenshot"] = screenshot ?? ["available": false]
    state["ocr"] = ocr ?? ["status": "not_requested"]
    return state
}

private func actionReceipt(kind: String, target: [String: Any]? = nil, method: String, started: Date, settled: Bool = true, stateChanged: Bool = true) -> [String: Any] {
    var receipt: [String: Any] = [
        "id": actionID(), "kind": kind, "method": method,
        "startedAt": ISO8601DateFormatter().string(from: started),
        "durationMs": Int(Date().timeIntervalSince(started) * 1000),
        "settled": settled, "stateChanged": stateChanged,
        "stateVersion": computerUseSession.stateVersion
    ]
    if let target { receipt["target"] = target }
    computerUseSession.saveAction(receipt)
    return receipt
}

private func intRef(_ value: Any?) -> Int? {
    if let number = value as? Int { return number }
    if let string = value as? String { return Int(string.trimmingCharacters(in: CharacterSet(charactersIn: "e@"))) }
    return nil
}

private func targetDescription(_ element: AXUIElement, source: String, ref: Int? = nil) -> [String: Any] {
    var target: [String: Any] = ["source": source, "role": axRole(element)]
    if let label = axLabel(element) { target["label"] = short(label) }
    if let identifier = axString(element, kAXIdentifierAttribute as String) { target["identifier"] = identifier }
    if let bounds = jsonRect(axBounds(element)) { target["bounds"] = bounds }
    if let ref { target["ref"] = "e\(ref)"; target["refsVersion"] = computerUseSession.refsVersion }
    return target
}

private func candidates(_ root: AXUIElement, query: String, role: String?, exact: Bool, depth: Int = 0, output: inout [AXUIElement]) {
    if depth > 40 { return }
    let roleMatches = role == nil || axRole(root).caseInsensitiveCompare(role!) == .orderedSame || (axAttr(root, kAXRoleDescriptionAttribute as String) as? String)?.caseInsensitiveCompare(role!) == .orderedSame
    let values = [kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute, kAXHelpAttribute, kAXIdentifierAttribute].compactMap { axAttr(root, $0 as String) as? String }
    let matches = values.contains { exact ? $0.caseInsensitiveCompare(query) == .orderedSame : $0.localizedCaseInsensitiveContains(query) }
    if roleMatches && matches { output.append(root) }
    if let children = axAttr(root, kAXChildrenAttribute as String) as? [AXUIElement] {
        for child in children { candidates(child, query: query, role: role, exact: exact, depth: depth + 1, output: &output) }
    }
}

private func normalizedRegion(_ args: [String: Any]) -> CGRect? {
    guard let values = args["region"] as? [String: Any],
          let x = (values["x"] as? NSNumber)?.doubleValue,
          let y = (values["y"] as? NSNumber)?.doubleValue,
          let width = (values["width"] as? NSNumber)?.doubleValue,
          let height = (values["height"] as? NSNumber)?.doubleValue else { return nil }
    return CGRect(x: x, y: y, width: width, height: height).intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
}

/// Last-resort visual targeting. It deliberately rejects duplicate or weak OCR
/// matches and reports the source in the action receipt.
private func ocrCoordinateTarget(_ args: [String: Any], bundleID: String, query: String) -> (CGPoint, [String: Any])? {
    guard let app = findApp(bundleID) else { return nil }
    do {
        let (_, data) = try captureScreenshot(bundleId: bundleID)
        guard let image = cgImageFromPNG(data) else { return nil }
        let provider = configuredOCRProvider(args["ocr_provider"] as? String)
        let level = OCRRecognitionLevel(rawValue: (args["recognition_level"] as? String) ?? "accurate") ?? .accurate
        let tokens = try provider.recognize(OCRRequest(image: image, region: normalizedRegion(args), languages: (args["languages"] as? [String]) ?? [], recognitionLevel: level))
        let hits = tokens.filter { $0.confidence >= 0.75 && $0.text.localizedCaseInsensitiveContains(query) }
        guard hits.count == 1, let hit = hits.first else { return nil }
        let window = windowBoundsFor(pid: app.processIdentifier) ?? NSScreen.main?.frame ?? .zero
        let bounds = CGRect(x: window.minX + hit.normalizedBounds.midX * window.width,
                            y: window.minY + hit.normalizedBounds.midY * window.height,
                            width: hit.normalizedBounds.width * window.width,
                            height: hit.normalizedBounds.height * window.height)
        return (CGPoint(x: bounds.midX, y: bounds.midY), ["source": "ocr", "text": hit.text, "confidence": hit.confidence, "screenBounds": jsonRect(bounds)!, "provider": provider.identifier])
    } catch { return nil }
}

private func resolveTarget(_ args: [String: Any], requiredBundle: Bool = true) -> (element: AXUIElement, target: [String: Any])? {
    let bundleID = (args["bundle_id"] as? String) ?? computerUseSession.activeBundleID
    if requiredBundle && bundleID == nil { return nil }
    // A supplied ref is exclusive: never silently fall back to focus if it is
    // stale, belongs to another app/window, or has the wrong version.
    if let ref = intRef(args["ref"]) {
        guard let info = computerUseSession.ref(ref, expectedVersion: args["refs_version"] as? Int, bundleID: bundleID) else { return nil }
        return (info.element, targetDescription(info.element, source: "ref", ref: ref))
    }
    guard let bundleID, let context = appContext(bundleID) else { return nil }
    if let query = args["query"] as? String {
        var hits: [AXUIElement] = []
        candidates(context.2, query: query, role: args["role"] as? String, exact: (args["exact"] as? Bool) ?? false, output: &hits)
        guard hits.count == 1, let hit = hits.first else { return nil }
        return (hit, targetDescription(hit, source: (args["exact"] as? Bool) == true ? "ax-exact" : "query"))
    }
    if let focused = focusedElement(context.1) { return (focused, targetDescription(focused, source: "focus")) }
    return nil
}

private func focusedElement(_ axApp: AXUIElement) -> AXUIElement? {
    var value: AnyObject?
    guard AXUIElementCopyAttributeValue(axApp, kAXFocusedUIElementAttribute as CFString, &value) == .success,
          let value, CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}

private func focusVerified(_ bundleID: String, axApp: AXUIElement) -> Bool {
    guard NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { return false }
    return focusedElement(axApp) != nil
}

private func staleRefErrorIfPresent(_ args: [String: Any]) -> [String: Any]? {
    guard let ref = intRef(args["ref"]) else { return nil }
    let expected = args["refs_version"] as? Int
    let bundleID = args["bundle_id"] as? String
    let currentVersion = computerUseSession.version(bundleID: bundleID)
    if let expected, expected != currentVersion {
        return toolError("ref @e\(ref) belongs to refsVersion \(expected); current state is \(currentVersion)", code: "STALE_REF", details: ["expectedRefsVersion": expected, "currentRefsVersion": currentVersion])
    }
    guard computerUseSession.ref(ref, expectedVersion: expected, bundleID: bundleID) != nil else { return toolError("ref @e\(ref) is stale or unknown; refresh app state", code: "STALE_REF") }
    return nil
}

private func permissionOrNil() -> [String: Any]? {
    if let message = checkAxPermission() { return toolError(message, code: "ACCESSIBILITY_PERMISSION_REQUIRED") }
    return nil
}

// MARK: Observation

public func t_listApps() -> [String: Any] {
    let request = requestID()
    var apps: [[String: Any]] = []
    for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
        apps.append(["displayName": app.localizedName ?? "?", "bundleId": app.bundleIdentifier ?? "", "pid": app.processIdentifier, "isRunning": true])
    }
    return success(listApps(), requestId: request, state: ["apps": apps])
}

public func t_axTree(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required", code: "INVALID_PARAMS") }
    if let error = permissionOrNil() { return error }
    guard let result = prepareTree(bundleID: bid, maxDepth: (args["max_depth"] as? Int) ?? 12, scope: (args["scope"] as? String) ?? "window") else { return toolError("not running: \(bid)", code: "APP_NOT_FOUND") }
    let state = appState(bundleID: bid, app: result.app, root: result.root, text: result.text, windowID: result.windowID, partial: treePartial)
    computerUseSession.saveState(state)
    return success(result.text, state: state)
}

public func t_axTreeJson(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required", code: "INVALID_PARAMS") }
    if let error = permissionOrNil() { return error }
    guard let result = prepareTree(bundleID: bid, maxDepth: (args["max_depth"] as? Int) ?? 12, scope: (args["scope"] as? String) ?? "window") else { return toolError("not running: \(bid)", code: "APP_NOT_FOUND") }
    let state = appState(bundleID: bid, app: result.app, root: result.root, text: result.text, windowID: result.windowID, partial: treePartial)
    computerUseSession.saveState(state)
    return success((try? String(data: JSONSerialization.data(withJSONObject: result.root, options: [.sortedKeys]), encoding: .utf8)) ?? "{}", state: state)
}

public func t_getAppState(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required", code: "INVALID_PARAMS") }
    if let error = permissionOrNil() { return error }
    guard let result = prepareTree(bundleID: bid, maxDepth: (args["max_depth"] as? Int) ?? 12, scope: (args["scope"] as? String) ?? "window") else { return toolError("not running: \(bid)", code: "APP_NOT_FOUND") }
    let wantsScreenshot = (args["screenshot"] as? Bool) ?? ((args["visual"] as? Bool) ?? false)
    let wantsOCR = (args["ocr"] as? Bool) ?? false
    var screenshot: [String: Any]?
    var screenshotPath: String?
    var ocr: [String: Any]?
    var imageContent: [[String: Any]] = []
    if wantsScreenshot || wantsOCR {
        do {
            let (path, data) = try captureScreenshot(bundleId: bid)
            var meta: [String: Any] = ["available": true, "mimeType": "image/png", "contentRef": "image_\(UUID().uuidString)", "byteCount": data.count]
            if let image = cgImageFromPNG(data) { meta["width"] = image.width; meta["height"] = image.height }
            screenshotPath = path
            screenshot = meta
            imageContent.append(["type": "image", "data": data.base64EncodedString(), "mimeType": "image/png"])
            if wantsOCR {
                let provider = configuredOCRProvider(args["ocr_provider"] as? String)
                if let image = cgImageFromPNG(data) {
                    do {
                        let ocrStarted = Date()
                        let tokens = try provider.recognize(OCRRequest(image: image, region: normalizedRegion(args), languages: (args["languages"] as? [String]) ?? [], recognitionLevel: OCRRecognitionLevel(rawValue: (args["recognition_level"] as? String) ?? "fast") ?? .fast))
                        ocr = ["status": "complete", "provider": provider.identifier, "remote": provider.isRemote, "latencyMs": Int(Date().timeIntervalSince(ocrStarted) * 1000), "tokens": tokens.map { $0.json }]
                    } catch { ocr = ["status": "error", "provider": provider.identifier, "remote": provider.isRemote, "message": String(describing: error)] }
                } else { ocr = ["status": "error", "message": "could not decode screenshot"] }
            }
            _ = path
        } catch { return toolError("screenshot failed: \(error)", code: "SCREEN_RECORDING_PERMISSION_REQUIRED") }
    } else { ocr = ["status": "not_requested"] }
    if wantsScreenshot || wantsOCR {
        computerUseSession.markStateCaptured()
        if let screenshotPath { try? FileManager.default.removeItem(atPath: screenshotPath) }
    }
    let state = appState(bundleID: bid, app: result.app, root: result.root, text: result.text, windowID: result.windowID, screenshot: screenshot, ocr: ocr, partial: treePartial)
    computerUseSession.saveState(state)
    return success(result.text, state: state, additionalContent: imageContent)
}

public func t_findElement(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let query = args["query"] as? String else { return toolError("bundle_id and query required", code: "INVALID_PARAMS") }
    if let error = permissionOrNil() { return error }
    guard let context = appContext(bid) else { return toolError("not running: \(bid)", code: "APP_NOT_FOUND") }
    var hits: [AXUIElement] = []; candidates(context.2, query: query, role: args["role"] as? String, exact: (args["exact"] as? Bool) ?? false, output: &hits)
    guard hits.count == 1, let hit = hits.first else { return toolError(hits.isEmpty ? "not found: \(query)" : "ambiguous target '\(query)' (\(hits.count) matches)", code: hits.isEmpty ? "ELEMENT_NOT_FOUND" : "AMBIGUOUS_TARGET") }
    return success("found \(axRole(hit))", state: ["target": targetDescription(hit, source: "ax-exact")])
}

// MARK: Actions

public func t_activate(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String else { return toolError("bundle_id required", code: "INVALID_PARAMS") }
    guard activateApp(bid), NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bid else { return toolError("could not activate: \(bid)", code: "APP_NOT_FRONTMOST") }
    return success("activated \(bid)", state: ["app": ["bundleId": bid, "isFrontmost": true]])
}

public func t_clickElement(_ args: [String: Any]) -> [String: Any] {
    if args["query"] == nil, args["ref"] != nil { return t_clickRef(args) }
    var mutable = args
    guard mutable["query"] != nil else { return toolError("query or ref required", code: "INVALID_PARAMS") }
    return performClick(&mutable, kind: "click")
}

private func performClick(_ args: inout [String: Any], kind: String) -> [String: Any] {
    if let error = permissionOrNil() { return error }
    if let stale = staleRefErrorIfPresent(args) { return stale }
    let started = Date()
    let bundleID = (args["bundle_id"] as? String) ?? computerUseSession.activeBundleID
    guard let bundleID else { return toolError("bundle_id required", code: "INVALID_PARAMS") }
    guard let app = findApp(bundleID) else { return toolError("not running: \(bundleID)", code: "APP_NOT_FOUND") }
    guard activateApp(bundleID), NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { return toolError("could not activate \(bundleID) before input", code: "APP_NOT_FRONTMOST") }
    if let target = resolveTarget(args) {
        var actions: CFArray?; AXUIElementCopyActionNames(target.element, &actions)
        if kind == "click", let names = actions as? [String], names.contains(kAXPressAction as String) {
            let result = AXUIElementPerformAction(target.element, kAXPressAction as CFString)
            guard result == .success else { return toolError("AXPress failed: \(result.rawValue)", code: "ACTION_FAILED") }
            return success("AXPress ok", action: actionReceipt(kind: kind, target: target.target, method: "AXPress", started: started), state: ["app": ["bundleId": bundleID, "pid": app.processIdentifier]])
        }
        guard let point = elementCenter(target.element) else { return toolError("target has no action or geometry", code: "ACTION_UNAVAILABLE") }
        if kind == "right_click" { sendRightClick(point) } else { sendClick(point) }
        return success("\(kind) at (\(point.x),\(point.y))", action: actionReceipt(kind: kind, target: target.target, method: kind == "right_click" ? "CGEventRightClick" : "CGEvent", started: started), state: ["app": ["bundleId": bundleID]])
    }
    if kind == "click", let query = args["query"] as? String, let (point, ocrTarget) = ocrCoordinateTarget(args, bundleID: bundleID, query: query) {
        sendClick(point)
        return success("OCR click at (\(point.x),\(point.y))", action: actionReceipt(kind: kind, target: ocrTarget, method: "OCRCoordinate", started: started), state: ["app": ["bundleId": bundleID]])
    }
    return toolError("target not found or ambiguous", code: "ELEMENT_NOT_FOUND")
}

public func t_clickRef(_ args: [String: Any]) -> [String: Any] {
    guard let ref = intRef(args["ref"]) else { return toolError("ref (eN or integer) required", code: "INVALID_PARAMS") }
    let expected = args["refs_version"] as? Int
    let currentVersion = computerUseSession.version(bundleID: args["bundle_id"] as? String)
    if let expected, expected != currentVersion { return toolError("ref @e\(ref) belongs to refsVersion \(expected); current state is \(currentVersion)", code: "STALE_REF", details: ["expectedRefsVersion": expected, "currentRefsVersion": currentVersion]) }
    guard computerUseSession.ref(ref, expectedVersion: expected, bundleID: args["bundle_id"] as? String) != nil else { return toolError("ref @e\(ref) is stale or unknown; call get_app_state first", code: "STALE_REF") }
    var argsWithRef = args; argsWithRef["ref"] = ref
    return performClick(&argsWithRef, kind: "click")
}

public func t_typeText(_ args: [String: Any]) -> [String: Any] {
    guard let text = args["text"] as? String else { return toolError("text required", code: "INVALID_PARAMS") }
    guard let bid = (args["bundle_id"] as? String) ?? computerUseSession.activeBundleID,
          let context = appContext(bid) else { return toolError("bundle_id required or app not found", code: "APP_NOT_FOUND") }
    _ = activateApp(bid)
    guard focusVerified(bid, axApp: context.1) else { return toolError("focused field could not be verified in \(bid)", code: "FOCUS_NOT_VERIFIED") }
    let started = Date(); sendType(text)
    return success("typed \(text.count) chars", action: actionReceipt(kind: "type_text", method: "CGEvent", started: started), state: ["app": ["bundleId": bid]])
}

public func t_keyPress(_ args: [String: Any]) -> [String: Any] {
    guard let key = args["key"] as? String else { return toolError("key required", code: "INVALID_PARAMS") }
    guard let bid = (args["bundle_id"] as? String) ?? computerUseSession.activeBundleID,
          let context = appContext(bid) else { return toolError("bundle_id required or app not found", code: "APP_NOT_FOUND") }
    _ = activateApp(bid)
    guard focusVerified(bid, axApp: context.1) else { return toolError("focused element could not be verified in \(bid)", code: "FOCUS_NOT_VERIFIED") }
    let started = Date()
    let ok = sendKey(key, flags: parseFlags((args["modifiers"] as? [String]) ?? []))
    guard ok else { return toolError("unknown key: \(key)", code: "INVALID_PARAMS") }
    return success("key \(key) sent", action: actionReceipt(kind: "press_key", method: "CGEvent", started: started), state: ["app": ["bundleId": bid]])
}

public func t_setValue(_ args: [String: Any]) -> [String: Any] {
    if let error = permissionOrNil() { return error }
    if let stale = staleRefErrorIfPresent(args) { return stale }
    guard let value = args["value"] as? String else { return toolError("value required", code: "INVALID_PARAMS") }
    guard let target = resolveTarget(args) else { return toolError("target not found or ambiguous", code: "ELEMENT_NOT_FOUND") }
    let started = Date()
    let result = AXUIElementSetAttributeValue(target.element, kAXValueAttribute as CFString, value as CFTypeRef)
    if result == .success {
        return success("value set", action: actionReceipt(kind: "set_value", target: target.target, method: "AXSetValue", started: started))
    }
    // Safe fallback only for an AX text control with verified activation.
    let role = axRole(target.element).lowercased()
    guard role.contains("textfield") || role.contains("textarea") || role.contains("combobox"),
          let bundleID = (args["bundle_id"] as? String) ?? computerUseSession.activeBundleID,
          let context = appContext(bundleID), activateApp(bundleID), focusVerified(bundleID, axApp: context.1),
          let point = elementCenter(target.element) else { return toolError("AXSetValue failed: \(result.rawValue)", code: "ACTION_FAILED") }
    sendClick(point)
    _ = sendKey("a", flags: [.maskCommand])
    sendType(value)
    return success("value set using focused text fallback", action: actionReceipt(kind: "set_value", target: target.target, method: "CGEvent", started: started))
}

public func t_selectText(_ args: [String: Any]) -> [String: Any] {
    if let stale = staleRefErrorIfPresent(args) { return stale }
    guard let target = resolveTarget(args), let text = args["text"] as? String else { return toolError("target and text required", code: "INVALID_PARAMS") }
    guard let current = axAttr(target.element, kAXValueAttribute as String) as? String else { return toolError("target is not editable text", code: "ACTION_UNAVAILABLE") }
    let ns = current as NSString; let search = text as NSString
    var range = ns.range(of: text, options: .caseInsensitive)
    guard range.location != NSNotFound else { return toolError("text not found in editable value", code: "ELEMENT_NOT_FOUND") }
    let mode = (args["selection_type"] as? String) ?? "text"
    if mode == "cursor_before" { range = NSRange(location: range.location, length: 0) }
    if mode == "cursor_after" { range = NSRange(location: range.location + search.length, length: 0) }
    var cfRange = CFRange(location: range.location, length: range.length)
    guard let axRange = AXValueCreate(.cfRange, &cfRange) else { return toolError("could not create selection range", code: "ACTION_FAILED") }
    let started = Date()
    let result = AXUIElementSetAttributeValue(target.element, kAXSelectedTextRangeAttribute as CFString, axRange)
    guard result == .success else { return toolError("selection failed: \(result.rawValue)", code: "ACTION_FAILED") }
    return success("selected text", action: actionReceipt(kind: "select_text", target: target.target, method: "AXSetValue", started: started))
}

public func t_secondaryAction(_ args: [String: Any]) -> [String: Any] {
    if let stale = staleRefErrorIfPresent(args) { return stale }
    guard let action = args["action"] as? String, let target = resolveTarget(args) else { return toolError("target and advertised action required", code: "INVALID_PARAMS") }
    var names: CFArray?; AXUIElementCopyActionNames(target.element, &names)
    guard let available = names as? [String], available.contains(action) else { return toolError("action '\(action)' is not advertised by target", code: "ACTION_UNAVAILABLE", details: ["availableActions": (names as? [String]) ?? []]) }
    let result = AXUIElementPerformAction(target.element, action as CFString)
    guard result == .success else { return toolError("secondary action failed: \(result.rawValue)", code: "ACTION_FAILED") }
    return success("performed \(action)", action: actionReceipt(kind: "perform_secondary_action", target: target.target, method: "AXSecondaryAction", started: Date()))
}

public func t_drag(_ args: [String: Any]) -> [String: Any] {
    if let error = permissionOrNil() { return error }
    guard let bundleID = args["bundle_id"] as? String, activateApp(bundleID), NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bundleID else { return toolError("bundle_id and activated app required for drag", code: "APP_NOT_FRONTMOST") }
    var from: CGPoint?
    if let x = args["from_x"] as? Double, let y = args["from_y"] as? Double {
        from = CGPoint(x: x, y: y)
    } else if let source = resolveTarget(args) {
        from = elementCenter(source.element)
    }
    var to: CGPoint?
    if let x = args["to_x"] as? Double, let y = args["to_y"] as? Double {
        to = CGPoint(x: x, y: y)
    } else if let query = args["to_query"] as? String, let bid = args["bundle_id" ] as? String, let context = appContext(bid) {
        var hits: [AXUIElement] = []
        candidates(context.2, query: query, role: nil, exact: true, output: &hits)
        if hits.count == 1 { to = elementCenter(hits[0]) }
    }
    guard let from, let to else { return toolError("from and to coordinates or targets required", code: "INVALID_PARAMS") }
    let started = Date()
    sendDrag(from: from, to: to)
    return success("dragged", action: actionReceipt(kind: "drag", method: "CGEvent", started: started), state: ["from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]])
}

public func t_wait(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let query = args["query"] as? String else { return toolError("bundle_id and query required", code: "INVALID_PARAMS") }
    if let error = permissionOrNil() { return error }
    guard let context = appContext(bid) else { return toolError("not running: \(bid)", code: "APP_NOT_FOUND") }
    let timeout = (args["timeout"] as? Double) ?? 10; let start = Date()
    while Date().timeIntervalSince(start) < timeout {
        var hits: [AXUIElement] = []; candidates(context.2, query: query, role: args["role"] as? String, exact: (args["exact"] as? Bool) ?? false, output: &hits)
        if !hits.isEmpty { return success(String(format: "found after %.2fs", Date().timeIntervalSince(start)), state: ["target": targetDescription(hits[0], source: "query")]) }
        Thread.sleep(forTimeInterval: 0.2)
    }
    return toolError("timeout after \(timeout)s waiting for: \(query)", code: "SETTLE_TIMEOUT")
}

public func t_scroll(_ args: [String: Any]) -> [String: Any] {
    let dx = Int32((args["dx"] as? Int) ?? 0), dy = Int32((args["dy"] as? Int) ?? 0)
    guard dx != 0 || dy != 0 else { return toolError("dx and/or dy required (non-zero)", code: "INVALID_PARAMS") }
    let started = Date()
    if let bid = args["bundle_id"] as? String, let query = args["query"] as? String, let context = appContext(bid) {
        guard activateApp(bid), NSWorkspace.shared.frontmostApplication?.bundleIdentifier == bid else { return toolError("could not activate \(bid) before scrolling", code: "APP_NOT_FRONTMOST") }
        var hits: [AXUIElement] = []; candidates(context.2, query: query, role: nil, exact: false, output: &hits)
        guard hits.count == 1, let point = elementCenter(hits[0]) else { return toolError("scroll target not found or ambiguous", code: "ELEMENT_NOT_FOUND") }
        sendScroll(dx: dx, dy: dy, at: point)
    } else { sendScroll(dx: dx, dy: dy) }
    return success("scrolled dx=\(dx) dy=\(dy)", action: actionReceipt(kind: "scroll", method: "CGEvent", started: started))
}

public func t_rightClick(_ args: [String: Any]) -> [String: Any] { var args = args; return performClick(&args, kind: "right_click") }

// MARK: Clipboard, menus, screenshots, OCR

public func t_clipGet(_ args: [String: Any]) -> [String: Any] {
    guard let text = NSPasteboard.general.string(forType: .string) else { return toolError("clipboard empty or not text", code: "ELEMENT_NOT_FOUND") }
    return success(text, state: ["clipboard": ["type": "text", "characterCount": text.count]])
}

public func t_clipSet(_ args: [String: Any]) -> [String: Any] {
    guard let text = args["text"] as? String else { return toolError("text required", code: "INVALID_PARAMS") }
    NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
    return success("set clipboard: \(text.count) chars", state: ["clipboard": ["type": "text", "characterCount": text.count]])
}

public func t_menu(_ args: [String: Any]) -> [String: Any] {
    guard let bid = args["bundle_id"] as? String, let path = args["path"] as? String else { return toolError("bundle_id and path required", code: "INVALID_PARAMS") }
    if let error = permissionOrNil() { return error }
    guard let app = findApp(bid) else { return toolError("not running: \(bid)", code: "APP_NOT_FOUND") }
    let axApp = AXUIElementCreateApplication(app.processIdentifier); enableEnhanced(axApp)
    guard let menuObject = axAttr(axApp, kAXMenuBarAttribute as String) else { return toolError("no menu bar", code: "ACTION_UNAVAILABLE") }
    let menu = menuObject as! AXUIElement
    let parts = path.split(separator: "/").map(String.init); var current = menu
    for (index, part) in parts.enumerated() {
        guard let children = axAttr(current, kAXChildrenAttribute as String) as? [AXUIElement], let next = children.first(where: { axString($0, kAXTitleAttribute as String) == part }) else { return toolError("menu item not found: \(part)", code: "ELEMENT_NOT_FOUND") }
        if index == parts.count - 1 {
            let result = AXUIElementPerformAction(next, kAXPressAction as CFString); guard result == .success else { return toolError("menu press failed", code: "ACTION_FAILED") }
            return success("pressed menu: \(path)", action: actionReceipt(kind: "menu", method: "AXPress", started: Date()))
        }
        guard let submenu = (axAttr(next, kAXChildrenAttribute as String) as? [AXUIElement])?.first else { return toolError("no submenu under: \(part)", code: "ACTION_UNAVAILABLE") }; current = submenu
    }
    return toolError("empty menu path", code: "INVALID_PARAMS")
}

public func t_screenshot(_ args: [String: Any]) -> [String: Any] {
    do {
        let (path, data) = try captureScreenshot(bundleId: args["bundle_id"] as? String)
        let wantsBase64 = (args["return"] as? String) == "base64" || (args["return"] as? String) == "image"
        let image = cgImageFromPNG(data)
        var metadata: [String: Any] = ["available": true, "mimeType": "image/png", "contentRef": "image_\(UUID().uuidString)", "byteCount": data.count]
        if let image { metadata["width"] = image.width; metadata["height"] = image.height }
        computerUseSession.markStateCaptured()
        if wantsBase64 {
            try? FileManager.default.removeItem(atPath: path)
            return success("screenshot captured", state: ["screenshot": metadata], additionalContent: [["type": "image", "data": data.base64EncodedString(), "mimeType": "image/png"]])
        }
        return success(path, state: ["screenshot": metadata])
    } catch { return toolError("screenshot failed: \(error)", code: "SCREEN_RECORDING_PERMISSION_REQUIRED") }
}

public func t_ocr(_ args: [String: Any]) -> [String: Any] {
    do {
        let (path, data) = try captureScreenshot(bundleId: args["bundle_id"] as? String)
        defer { try? FileManager.default.removeItem(atPath: path) }
        guard let image = cgImageFromPNG(data) else { return toolError("could not decode screenshot", code: "OCR_UNAVAILABLE") }
        let provider = configuredOCRProvider(args["provider"] as? String ?? args["ocr_provider"] as? String)
        let level = OCRRecognitionLevel(rawValue: (args["recognition_level"] as? String) ?? "fast") ?? .fast
        let languages = (args["languages"] as? [String]) ?? []
        let ocrStarted = Date()
        let tokens = try provider.recognize(OCRRequest(image: image, region: normalizedRegion(args), languages: languages, recognitionLevel: level))
        return success("recognized \(tokens.count) OCR tokens", state: ["ocr": ["status": "complete", "provider": provider.identifier, "remote": provider.isRemote, "latencyMs": Int(Date().timeIntervalSince(ocrStarted) * 1000), "tokens": tokens.map { $0.json }]])
    } catch let error as OCRProviderError { return toolError(error.description, code: "OCR_UNAVAILABLE") }
    catch { return toolError("OCR failed: \(error)", code: "OCR_UNAVAILABLE") }
}

// MARK: Registry

private func inputSchema(_ properties: [String: Any], required: [String] = []) -> [String: Any] {
    var schema: [String: Any] = ["type": "object", "properties": properties]
    if !required.isEmpty { schema["required"] = required }
    return schema
}

private func toolDefinition(_ name: String, _ description: String, _ schema: [String: Any]) -> [String: Any] {
    ["name": name, "description": description, "inputSchema": schema]
}

private let commonTargetProperties: [String: Any] = [
    "bundle_id": ["type": "string"], "ref": ["type": "integer"], "refs_version": ["type": "integer"],
    "query": ["type": "string"], "role": ["type": "string"], "exact": ["type": "boolean"]
]

public let toolsList: [[String: Any]] = [
    toolDefinition("list_apps", "List running macOS GUI applications", inputSchema([:])),
    toolDefinition("get_app_state", "Return coherent accessibility state, stable refs, optional screenshot, and optional local OCR", inputSchema(["bundle_id": ["type": "string"], "max_depth": ["type": "integer"], "scope": ["type": "string"], "visual": ["type": "boolean"], "screenshot": ["type": "boolean"], "ocr": ["type": "boolean"], "ocr_provider": ["type": "string"], "region": ["type": "object"], "languages": ["type": "array"], "recognition_level": ["type": "string"]], required: ["bundle_id"])),
    toolDefinition("get_ax_tree", "Get numbered accessibility tree (legacy alias)", inputSchema(["bundle_id": ["type": "string"], "max_depth": ["type": "integer"], "scope": ["type": "string"]], required: ["bundle_id"])),
    toolDefinition("ax_tree_json", "Get structured accessibility tree (legacy alias)", inputSchema(["bundle_id": ["type": "string"], "max_depth": ["type": "integer"], "scope": ["type": "string"]], required: ["bundle_id"])),
    toolDefinition("find_element", "Find a unique accessibility element using exact/role-aware matching", inputSchema(commonTargetProperties, required: ["bundle_id", "query"])),
    toolDefinition("click", "Click a ref or unique accessibility target", inputSchema(commonTargetProperties)),
    toolDefinition("click_element", "Legacy query click alias", inputSchema(commonTargetProperties, required: ["bundle_id", "query"])),
    toolDefinition("click_ref", "Click a ref from the current app state", inputSchema(["ref": ["type": "string", "description": "e42 (integer e42 is also accepted)"], "refs_version": ["type": "integer"]], required: ["ref"])),
    toolDefinition("activate", "Activate and verify an app before input", inputSchema(["bundle_id": ["type": "string"]], required: ["bundle_id"])),
    toolDefinition("type_text", "Type into a verified focused field", inputSchema(["bundle_id": ["type": "string"], "text": ["type": "string"]], required: ["text"])),
    toolDefinition("set_value", "Set an accessibility value directly", inputSchema(["bundle_id": ["type": "string"], "ref": ["type": "integer"], "query": ["type": "string"], "value": ["type": "string"]], required: ["value"])),
    toolDefinition("select_text", "Select text in an editable accessibility value", inputSchema(["bundle_id": ["type": "string"], "ref": ["type": "integer"], "query": ["type": "string"], "text": ["type": "string"], "selection_type": ["type": "string"]], required: ["text"])),
    toolDefinition("press_key", "Send a key to a verified active app", inputSchema(["bundle_id": ["type": "string"], "key": ["type": "string"], "modifiers": ["type": "array"]], required: ["key"])),
    toolDefinition("key_press", "Legacy key alias", inputSchema(["bundle_id": ["type": "string"], "key": ["type": "string"], "modifiers": ["type": "array"]], required: ["key"])),
    toolDefinition("perform_secondary_action", "Invoke an action advertised by an AX element", inputSchema(["bundle_id": ["type": "string"], "ref": ["type": "integer"], "query": ["type": "string"], "action": ["type": "string"]], required: ["action"])),
    toolDefinition("drag", "Drag between screen points or element centers", inputSchema(["from_x": ["type": "number"], "from_y": ["type": "number"], "to_x": ["type": "number"], "to_y": ["type": "number"], "bundle_id": ["type": "string"], "query": ["type": "string"], "to_query": ["type": "string"]])),
    toolDefinition("scroll", "Scroll over an optional target", inputSchema(["bundle_id": ["type": "string"], "query": ["type": "string"], "dx": ["type": "integer"], "dy": ["type": "integer"]])),
    toolDefinition("wait_for", "Wait for a unique accessibility target", inputSchema(["bundle_id": ["type": "string"], "query": ["type": "string"], "timeout": ["type": "number"]], required: ["bundle_id", "query"])),
    toolDefinition("screenshot", "Capture a PNG as an MCP image or diagnostic path", inputSchema(["bundle_id": ["type": "string"], "return": ["type": "string"]])),
    toolDefinition("ocr", "Explicit OCR; Vision is local default, remote providers are opt-in and currently unconfigured", inputSchema(["bundle_id": ["type": "string"], "provider": ["type": "string"], "region": ["type": "object"], "languages": ["type": "array"], "recognition_level": ["type": "string"]])),
    toolDefinition("right_click", "Context click a target", inputSchema(commonTargetProperties)),
    toolDefinition("menu", "Press a menubar path", inputSchema(["bundle_id": ["type": "string"], "path": ["type": "string"]], required: ["bundle_id", "path"])),
    toolDefinition("clip_get", "Read clipboard text", inputSchema([:] as [String: Any])),
    toolDefinition("clip_set", "Write clipboard text", inputSchema(["text": ["type": "string"]], required: ["text"]))
]

public func handleTool(_ name: String, _ args: [String: Any]) -> [String: Any] {
    switch name {
    case "list_apps": return t_listApps()
    case "get_app_state": return t_getAppState(args)
    case "get_ax_tree": return t_axTree(args)
    case "ax_tree_json": return t_axTreeJson(args)
    case "find_element": return t_findElement(args)
    case "click", "click_element": return t_clickElement(args)
    case "click_ref": return t_clickRef(args)
    case "activate": return t_activate(args)
    case "type_text": return t_typeText(args)
    case "set_value": return t_setValue(args)
    case "select_text": return t_selectText(args)
    case "press_key", "key_press": return t_keyPress(args)
    case "perform_secondary_action": return t_secondaryAction(args)
    case "drag": return t_drag(args)
    case "wait_for": return t_wait(args)
    case "scroll": return t_scroll(args)
    case "right_click": return t_rightClick(args)
    case "screenshot": return t_screenshot(args)
    case "ocr": return t_ocr(args)
    case "menu": return t_menu(args)
    case "clip_get": return t_clipGet(args)
    case "clip_set": return t_clipSet(args)
    default: return toolError("unknown tool: \(name)", code: "INVALID_PARAMS")
    }
}

//
//  Accessibility.swift
//  PiComputerUse / PiComputerUseMac
//
//  AXUIElement helpers: attribute access, tree walking, element search,
//  element references, and permission checks.
//

import Foundation
import ApplicationServices
import AppKit

public func pcuLog(_ s: String) {
    FileHandle.standardError.write("[pi-computer-use] \(s)\n".data(using: .utf8)!)
}

// MARK: - AX attribute helpers

func axAttr(_ e: AXUIElement, _ n: String) -> AnyObject? {
    var v: AnyObject?
    return AXUIElementCopyAttributeValue(e, n as CFString, &v) == .success ? v : nil
}

func axRole(_ e: AXUIElement) -> String {
    // Use the stable AX role in structured responses. The localized role
    // description is still available to substring matching through matches().
    return (axAttr(e, kAXRoleAttribute as String) as? String)
        ?? (axAttr(e, kAXRoleDescriptionAttribute as String) as? String) ?? "?"
}

func axString(_ e: AXUIElement, _ k: String) -> String? {
    if let s = axAttr(e, k) as? String, !s.isEmpty { return s }
    return nil
}

func enableEnhanced(_ axApp: AXUIElement) {
    AXUIElementSetAttributeValue(axApp, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue!)
    AXUIElementSetAttributeValue(axApp, "AXManualAccessibility" as CFString, kCFBooleanTrue!)
}

/// Resolve by bundle ID, display name, or application path. Bundle IDs are
/// preferred; name/path matching is case-insensitive and only regular apps
/// are considered.
public func findApp(_ identifier: String) -> NSRunningApplication? {
    let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
    if let exact = apps.first(where: { $0.bundleIdentifier == identifier }) { return exact }
    let normalized = identifier.lowercased()
    return apps.first {
        ($0.localizedName ?? "").lowercased() == normalized ||
        ($0.bundleURL?.path.lowercased() == normalized)
    }
}

func focusedWindow(of axApp: AXUIElement) -> AXUIElement {
    if let f = axAttr(axApp, kAXFocusedWindowAttribute as String), CFGetTypeID(f) == AXUIElementGetTypeID() {
        return f as! AXUIElement
    }
    if let m = axAttr(axApp, kAXMainWindowAttribute as String), CFGetTypeID(m) == AXUIElementGetTypeID() {
        return m as! AXUIElement
    }
    return axApp
}

func describe(_ e: AXUIElement) -> String {
    var parts = [axRole(e)]
    if let s = axString(e, kAXTitleAttribute as String) { parts.append("\"\(short(s))\"") }
    if let s = axString(e, kAXDescriptionAttribute as String) { parts.append("Description: \(short(s))") }
    if let v = axAttr(e, kAXValueAttribute as String) {
        let s = (v as? String) ?? (v as? NSNumber).map { $0.stringValue } ?? ""
        if !s.isEmpty { parts.append("Value: \(short(s))") }
    }
    if let s = axString(e, kAXHelpAttribute as String) { parts.append("Help: \(short(s))") }
    return parts.joined(separator: " ")
}

func short(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    return t.count > 120 ? String(t.prefix(120)) + "..." : t
}

// MARK: - Element references

/// In-process map of `@eN` refs → AX elements. Populated by tree dumps,
/// invalidated on the next dump for the same process.
var refMap: [Int: AXUIElement] = [:]
var registerSessionRefs = true
var treePartial = false

func walkText(_ e: AXUIElement, maxDepth: Int, depth: Int = 0, counter: inout Int, out: inout String) {
    counter += 1
    refMap[counter] = e
    if registerSessionRefs, let bundleID = computerUseSession.activeBundleID {
        _ = computerUseSession.register(e, appBundleID: bundleID, windowID: computerUseSession.activeWindowID)
    }
    out += String(repeating: "  ", count: depth) + "@e\(counter) \(describe(e))\n"
    if depth >= maxDepth {
        treePartial = true
        return
    }
    if let cs = axAttr(e, kAXChildrenAttribute as String) as? [AXUIElement] {
        for c in cs { walkText(c, maxDepth: maxDepth, depth: depth + 1, counter: &counter, out: &out) }
    }
}

func walkJson(_ e: AXUIElement, maxDepth: Int, depth: Int = 0, counter: inout Int) -> [String: Any] {
    counter += 1
    let myRef = counter
    refMap[myRef] = e
    if registerSessionRefs, let bundleID = computerUseSession.activeBundleID {
        _ = computerUseSession.register(e, appBundleID: bundleID, windowID: computerUseSession.activeWindowID)
    }
    var node: [String: Any] = [
        "kind": "ref",
        "ref": "e\(myRef)",
        "legacyRef": myRef,
        "refsVersion": computerUseSession.refsVersion,
        "role": axRole(e)
    ]
    if let s = axString(e, kAXTitleAttribute as String) { node["title"] = s }
    if let s = axString(e, kAXDescriptionAttribute as String) { node["description"] = s }
    if let v = axAttr(e, kAXValueAttribute as String) {
        if let s = v as? String { node["value"] = s }
        else if let n = v as? NSNumber { node["value"] = n.stringValue }
    }
    if let s = axString(e, kAXHelpAttribute as String) { node["help"] = s }
    if depth < maxDepth, let cs = axAttr(e, kAXChildrenAttribute as String) as? [AXUIElement] {
        var arr: [[String: Any]] = []
        for c in cs {
            arr.append(walkJson(c, maxDepth: maxDepth, depth: depth + 1, counter: &counter))
        }
        if !arr.isEmpty { node["children"] = arr }
    }
    return node
}

// MARK: - Element search

func matches(_ e: AXUIElement, _ q: String) -> Bool {
    for k in [kAXDescriptionAttribute, kAXTitleAttribute, kAXValueAttribute, kAXHelpAttribute,
              kAXRoleDescriptionAttribute, kAXRoleAttribute, kAXIdentifierAttribute] {
        if let s = axAttr(e, k as String) as? String, s.localizedCaseInsensitiveContains(q) { return true }
    }
    return false
}

func find(_ e: AXUIElement, _ q: String, depth: Int = 0) -> AXUIElement? {
    if depth > 30 { return nil }
    if matches(e, q) { return e }
    if let cs = axAttr(e, kAXChildrenAttribute as String) as? [AXUIElement] {
        for c in cs { if let h = find(c, q, depth: depth + 1) { return h } }
    }
    return nil
}

func elementCenter(_ e: AXUIElement) -> CGPoint? {
    guard let bounds = axBounds(e) else { return nil }
    return CGPoint(x: bounds.midX, y: bounds.midY)
}

// MARK: - Permissions

/// Returns nil if Accessibility permission OK, otherwise an error message.
func checkAxPermission() -> String? {
    if !AXIsProcessTrusted() {
        return """
        Accessibility permission not granted.
        Open System Settings → Privacy & Security → Accessibility and enable the parent process \
        (Terminal/Ghostty/Pi — whichever launches pi-computer-use).
        """
    }
    return nil
}

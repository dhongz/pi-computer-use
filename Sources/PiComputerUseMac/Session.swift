//
//  Session.swift
//  Persistent state owned by the MCP process.
//

import Foundation
import ApplicationServices
import CoreGraphics

/// A single long-lived Computer Use session. Refs are retained independently
/// for each app/window context; capturing a new state only invalidates that
/// context's refs.
public final class ComputerUseSession {
    public struct RefInfo {
        public let element: AXUIElement
        public let appBundleID: String
        public let windowID: CGWindowID?
        public let version: Int
        public let role: String
        public let label: String?
        public let bounds: CGRect?
    }

    public private(set) var refsVersion: Int = 0
    public private(set) var stateVersion: Int = 0
    public private(set) var activeBundleID: String?
    public private(set) var activePID: pid_t?
    public private(set) var activeWindowID: CGWindowID?
    public private(set) var lastState: [String: Any]?
    public private(set) var lastAction: [String: Any]?
    private var refs: [Int: RefInfo] = [:]
    private var refsByContext: [String: [Int: RefInfo]] = [:]
    private var versionsByContext: [String: Int] = [:]
    private var activeContext: String?
    private var nextRef = 0

    public init() {}

    private func contextKey(bundleID: String, windowID: CGWindowID?) -> String {
        "\(bundleID)|\(windowID.map(String.init) ?? "none")"
    }

    public func beginTree(appBundleID: String, pid: pid_t, windowID: CGWindowID?) {
        let key = contextKey(bundleID: appBundleID, windowID: windowID)
        let version = (versionsByContext[key] ?? 0) + 1
        versionsByContext[key] = version
        refsByContext[key] = [:]
        refs.removeAll(keepingCapacity: true)
        refsVersion = version
        stateVersion += 1
        nextRef = 0
        activeContext = key
        activeBundleID = appBundleID
        activePID = pid
        activeWindowID = windowID
    }

    @discardableResult
    public func register(_ element: AXUIElement, appBundleID: String, windowID: CGWindowID?) -> Int {
        nextRef += 1
        let key = contextKey(bundleID: appBundleID, windowID: windowID)
        let version = versionsByContext[key] ?? refsVersion
        let info = RefInfo(
            element: element, appBundleID: appBundleID, windowID: windowID,
            version: version, role: axRole(element), label: axLabel(element), bounds: axBounds(element)
        )
        refs[nextRef] = info
        refsByContext[key, default: [:]][nextRef] = info
        return nextRef
    }

    public func ref(_ number: Int, expectedVersion: Int? = nil, bundleID: String? = nil, windowID: CGWindowID? = nil) -> RefInfo? {
        let key: String
        if let bundleID {
            if let windowID { key = contextKey(bundleID: bundleID, windowID: windowID) }
            else { key = refsByContext.keys.first(where: { $0.hasPrefix("\(bundleID)|") }) ?? contextKey(bundleID: bundleID, windowID: nil) }
        } else { key = activeContext ?? "" }
        let version = versionsByContext[key] ?? refsVersion
        guard expectedVersion == nil || expectedVersion == version else { return nil }
        if key == activeContext { return refs[number] }
        return refsByContext[key]?[number]
    }

    public func version(bundleID: String? = nil, windowID: CGWindowID? = nil) -> Int {
        guard let bundleID else { return refsVersion }
        let key = if let windowID { contextKey(bundleID: bundleID, windowID: windowID) } else { refsByContext.keys.first(where: { $0.hasPrefix("\(bundleID)|") }) ?? contextKey(bundleID: bundleID, windowID: nil) }
        return versionsByContext[key] ?? 0
    }

    public func hasRefs(for bundleID: String, windowID: CGWindowID?) -> Bool {
        !refsByContext[contextKey(bundleID: bundleID, windowID: windowID), default: [:]].isEmpty
    }

    public func markStateCaptured() { stateVersion += 1 }
    public func saveState(_ state: [String: Any]) { lastState = state }
    public func saveAction(_ action: [String: Any]) { lastAction = action }
}

public let computerUseSession = ComputerUseSession()

func axLabel(_ e: AXUIElement) -> String? {
    for key in [kAXTitleAttribute, kAXDescriptionAttribute, kAXValueAttribute, kAXHelpAttribute] {
        if let value = axAttr(e, key as String) as? String, !value.isEmpty { return value }
    }
    return nil
}

func axBounds(_ e: AXUIElement) -> CGRect? {
    guard let posObject = axAttr(e, kAXPositionAttribute as String),
          let sizeObject = axAttr(e, kAXSizeAttribute as String),
          CFGetTypeID(posObject) == AXValueGetTypeID(), CFGetTypeID(sizeObject) == AXValueGetTypeID() else { return nil }
    let pos = posObject as! AXValue
    let size = sizeObject as! AXValue
    var point = CGPoint.zero
    var dimensions = CGSize.zero
    guard AXValueGetValue(pos, .cgPoint, &point), AXValueGetValue(size, .cgSize, &dimensions) else { return nil }
    return CGRect(origin: point, size: dimensions)
}

func jsonRect(_ rect: CGRect?) -> [String: Any]? {
    guard let rect else { return nil }
    return ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}

func isoNow() -> String { ISO8601DateFormatter().string(from: Date()) }
public func requestID() -> String { "cu_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20) }
public func actionID() -> String { "act_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(20) }

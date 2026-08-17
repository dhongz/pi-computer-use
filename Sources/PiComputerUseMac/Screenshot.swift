//
//  Screenshot.swift
//  PiComputerUse / PiComputerUseMac
//
//  Screenshot capture via /usr/sbin/screencapture, including per-app window
//  capture through CGWindowListCopyWindowInfo.
//

import Foundation
import ApplicationServices
import AppKit

public enum ScreenshotError: Error {
    case captureFailed(String)
    case missingData(String)
}

public func windowIdFor(pid: pid_t) -> CGWindowID? {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in info {
        if let p = w[kCGWindowOwnerPID as String] as? pid_t, p == pid,
           let layer = w[kCGWindowLayer as String] as? Int, layer == 0,
           let id = w[kCGWindowNumber as String] as? CGWindowID {
            return id
        }
    }
    return nil
}

/// Return the window's screen-space bounds. Used to map normalized OCR
/// geometry back to safe coordinate targets without assuming Retina scale.
public func windowBoundsFor(pid: pid_t) -> CGRect? {
    let info = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for window in info {
        guard let ownerPID = window[kCGWindowOwnerPID as String] as? pid_t, ownerPID == pid,
              let layer = window[kCGWindowLayer as String] as? Int, layer == 0,
              let bounds = window[kCGWindowBounds as String] as? [String: Any] else { continue }
        func number(_ key: String) -> CGFloat { CGFloat((bounds[key] as? NSNumber)?.doubleValue ?? 0) }
        return CGRect(x: number("X"), y: number("Y"), width: number("Width"), height: number("Height"))
    }
    return nil
}

/// Capture a screenshot and return the temp file path plus PNG data.
///
/// - Parameter bundleId: If non-nil, capture that app's main window; otherwise
///   capture the full screen.
/// - Throws: `ScreenshotError` on capture or read failure.
public func captureScreenshot(bundleId: String?) throws -> (path: String, data: Data) {
    let dir = NSTemporaryDirectory()
    let path = "\(dir)pi-computer-use-\(Int(Date().timeIntervalSince1970 * 1000)).png"
    var procArgs = ["-x"]
    if let bid = bundleId, let app = findApp(bid) {
        procArgs.append(contentsOf: ["-l", "\(windowIdFor(pid: app.processIdentifier) ?? 0)"])
    }
    procArgs.append(path)

    let p = Process()
    p.launchPath = "/usr/sbin/screencapture"
    p.arguments = procArgs
    do {
        try p.run()
        p.waitUntilExit()
    } catch {
        throw ScreenshotError.captureFailed("screencapture failed: \(error)")
    }
    if p.terminationStatus != 0 { throw ScreenshotError.captureFailed("screencapture exit=\(p.terminationStatus)") }
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
        throw ScreenshotError.missingData("could not read screenshot at \(path)")
    }
    return (path, data)
}

//
//  AppRegistry.swift
//  PiComputerUse / PiComputerUseMac
//
//  Running-application discovery and activation.
//

import Foundation
import AppKit

/// List running GUI applications as tab-separated lines:
/// `Name\tbundle.id\tPID=n`
func listApps() -> String {
    let apps = NSWorkspace.shared.runningApplications.compactMap { app -> String? in
        guard app.activationPolicy == .regular, let bid = app.bundleIdentifier else { return nil }
        return "\(app.localizedName ?? "?")\t\(bid)\tPID=\(app.processIdentifier)"
    }
    return apps.joined(separator: "\n")
}

/// Bring an app to the foreground. Returns false if the app is not running.
func activateApp(_ bundleId: String) -> Bool {
    guard let app = findApp(bundleId) else { return false }
    let ok = app.activate(options: [.activateIgnoringOtherApps])
    Thread.sleep(forTimeInterval: 0.3)
    return ok
}

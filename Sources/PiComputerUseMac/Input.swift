//
//  Input.swift
//  PiComputerUse / PiComputerUseMac
//
//  CGEvent synthesis: mouse clicks, scroll, Unicode typing, and key presses.
//

import Foundation
import CoreGraphics

let evtSrc = CGEventSource(stateID: .hidSystemState)

func sendClick(_ pt: CGPoint) {
    CGEvent(mouseEventSource: evtSrc, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: evtSrc, mouseType: .leftMouseDown, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: evtSrc, mouseType: .leftMouseUp, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func sendRightClick(_ pt: CGPoint) {
    CGEvent(mouseEventSource: evtSrc, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .right)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: evtSrc, mouseType: .rightMouseDown, mouseCursorPosition: pt, mouseButton: .right)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: evtSrc, mouseType: .rightMouseUp, mouseCursorPosition: pt, mouseButton: .right)?.post(tap: .cghidEventTap)
}

func sendDrag(from: CGPoint, to: CGPoint) {
    CGEvent(mouseEventSource: evtSrc, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    CGEvent(mouseEventSource: evtSrc, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left)?.post(tap: .cghidEventTap)
    let steps = 12
    for step in 1...steps {
        let progress = CGFloat(step) / CGFloat(steps)
        let point = CGPoint(x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress)
        CGEvent(mouseEventSource: evtSrc, mouseType: .leftMouseDragged, mouseCursorPosition: point, mouseButton: .left)?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.01)
    }
    CGEvent(mouseEventSource: evtSrc, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left)?.post(tap: .cghidEventTap)
}

func sendScroll(dx: Int32, dy: Int32, at: CGPoint? = nil) {
    if let pt = at {
        CGEvent(mouseEventSource: evtSrc, mouseType: .mouseMoved, mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
    }
    if let evt = CGEvent(scrollWheelEvent2Source: evtSrc, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0) {
        evt.post(tap: .cghidEventTap)
    }
}

func sendType(_ text: String) {
    for ch in text.unicodeScalars {
        var u = UniChar(ch.value)
        let d = CGEvent(keyboardEventSource: evtSrc, virtualKey: 0, keyDown: true)
        d?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        d?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: evtSrc, virtualKey: 0, keyDown: false)
        up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
        up?.post(tap: .cghidEventTap)
        Thread.sleep(forTimeInterval: 0.015)
    }
}

let keyMap: [String: CGKeyCode] = [
    "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53,
    "left": 123, "right": 124, "down": 125, "up": 126,
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
    "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38,
    "k": 40, "n": 45, "m": 46
]

func sendKey(_ name: String, flags: CGEventFlags) -> Bool {
    guard let code = keyMap[name.lowercased()] else { return false }
    let d = CGEvent(keyboardEventSource: evtSrc, virtualKey: code, keyDown: true); d?.flags = flags; d?.post(tap: .cghidEventTap)
    let u = CGEvent(keyboardEventSource: evtSrc, virtualKey: code, keyDown: false); u?.flags = flags; u?.post(tap: .cghidEventTap)
    return true
}

func parseFlags(_ mods: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in mods {
        switch m.lowercased() {
        case "cmd", "command": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt", "option": f.insert(.maskAlternate)
        case "ctrl", "control": f.insert(.maskControl)
        default: break
        }
    }
    return f
}

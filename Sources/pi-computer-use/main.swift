//
//  main.swift
//  pi-computer-use
//
//  Entry point. Acts as either:
//    * an MCP stdio server (no args, or `pi-computer-use serve`), or
//    * a regular CLI (`pi-computer-use <subcommand>`).
//
//  macOS computer use via:
//    * Accessibility API (AXUIElement)  — read UI tree, press actions
//    * CoreGraphics events (CGEvent)    — synthesize mouse / keyboard
//    * screencapture(1)                  — screenshots
//

import Foundation
import ApplicationServices
import PiComputerUseCore
import PiComputerUseMac

// ====================== CLI mode ======================

func cliExtractText(_ result: [String: Any]) -> String {
    if let content = result["content"] as? [[String: Any]] {
        return content.compactMap { $0["text"] as? String }.joined(separator: "\n")
    }
    return ""
}

func cliIsError(_ result: [String: Any]) -> Bool {
    return (result["isError"] as? Bool) ?? false
}

func cliParseArgs(_ args: [String]) -> (positional: [String], opts: [String: String], flags: Set<String>) {
    let parsed = parseCLIArgs(args)
    return (parsed.positional, parsed.opts, parsed.flags)
}

func cliPrintHelp() {
    let help = """
    pi-computer-use v\(PiComputerUse.version) — macOS computer use
    via Accessibility + CGEvent. https://github.com/dhongz/pi-computer-use

    USAGE:
      pi-computer-use <subcommand> [options]
      pi-computer-use serve                              # MCP stdio server mode
      pi-computer-use --version                          # Print version

    SUBCOMMANDS:
      apps                                   List running GUI apps (name, bundle_id, pid)
      activate --bundle-id <id>              Bring app to foreground (call this first!)
      tree   --bundle-id <id> [--depth N] [--scope window|app]
                                             Dump numbered AX tree (text or --json)
      find   --bundle-id <id> --query <q>    Locate first AX element matching query
      wait   --bundle-id <id> --query <q> [--timeout SEC]
                                             Poll until element appears (default 10s)
      click  --bundle-id <id> --query <q>    Left-click first element matching query
      rclick --bundle-id <id> --query <q>    Right-click first element matching query
      type   --text <s>                      Type text into focused field
      key    --key <name> [--mods cmd,shift,alt,ctrl]
                                             Send a single key (optionally with modifiers)
      scroll [--bundle-id <id> --query <q>] [--dx N] [--dy N]
                                             Send scroll wheel (over element or cursor)
      menu   --bundle-id <id> --path <p>     Press menubar item by path (e.g. 'File/Open')
      shot   [--bundle-id <id>] [--out <path>]
                                             Capture screenshot (default: /tmp/...png)
      clip get                               Read clipboard text
      clip set --text <s>                    Write clipboard text

    GLOBAL FLAGS:
      --json                                 Emit JSON output instead of plain text
      --help, -h                             Show this help

    EXAMPLES:
      pi-computer-use activate --bundle-id com.google.Chrome
      pi-computer-use key --key l --mods cmd                                 # Cmd+L → focus URL bar
      pi-computer-use type --text "https://example.com"
      pi-computer-use key --key return
      pi-computer-use wait --bundle-id com.google.Chrome --query "Example Domain" --timeout 5
      pi-computer-use tree --bundle-id com.google.Chrome --depth 8 --json | jq .
      pi-computer-use scroll --dy -300
      pi-computer-use menu --bundle-id com.google.Chrome --path "File/New Tab"
      pi-computer-use clip set --text "hello"
      pi-computer-use clip get
    """
    print(help)
}

/// Emit a tool result to the CLI. `--json` → JSON, otherwise text. Errors exit(1).
func cliEmit(_ result: [String: Any], json: Bool) -> Never {
    let isError = cliIsError(result)
    if json {
        var out: [String: Any] = ["ok": !isError]
        out["text"] = cliExtractText(result)
        if isError { out["error"] = cliExtractText(result) }
        if let data = try? JSONSerialization.data(withJSONObject: out, options: [.sortedKeys]),
           let s = String(data: data, encoding: .utf8) {
            print(s)
        }
    } else {
        let text = cliExtractText(result)
        if isError {
            FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
        } else {
            print(text)
        }
    }
    exit(isError ? 1 : 0)
}

func cliMain(_ argv: [String]) -> Never {
    guard let sub = argv.first else { cliPrintHelp(); exit(0) }
    if sub == "--help" || sub == "-h" || sub == "help" { cliPrintHelp(); exit(0) }
    if sub == "--version" || sub == "-v" || sub == "version" {
        print("pi-computer-use \(PiComputerUse.version)")
        exit(0)
    }

    let (positional, opts, flags) = cliParseArgs(Array(argv.dropFirst()))
    let json = flags.contains("json")

    var toolArgs: [String: Any] = [:]
    if let v = opts["bundle-id"] { toolArgs["bundle_id"] = v }
    if let v = opts["query"]     { toolArgs["query"] = v }
    if let v = opts["text"]      { toolArgs["text"] = v }
    if let v = opts["key"]       { toolArgs["key"] = v }
    if let v = opts["scope"]     { toolArgs["scope"] = v }
    if let v = opts["path"]      { toolArgs["path"] = v }
    if let v = opts["depth"], let n = Int(v) { toolArgs["max_depth"] = n }
    if let v = opts["ref"], let n = Int(v) { toolArgs["ref"] = n }
    if let v = opts["dx"], let n = Int(v) { toolArgs["dx"] = n }
    if let v = opts["dy"], let n = Int(v) { toolArgs["dy"] = n }
    if let v = opts["timeout"], let d = Double(v) { toolArgs["timeout"] = d }
    if let v = opts["mods"] {
        toolArgs["modifiers"] = v.split(separator: ",").map { String($0) }
    }

    switch sub {
    case "apps":
        cliEmit(t_listApps(), json: json)
    case "activate":
        cliEmit(t_activate(toolArgs), json: json)
    case "tree":
        if json {
            cliEmit(t_axTreeJson(toolArgs), json: false) // already JSON in body
        } else {
            cliEmit(t_axTree(toolArgs), json: false)
        }
    case "find":
        cliEmit(t_findElement(toolArgs), json: json)
    case "wait":
        cliEmit(t_wait(toolArgs), json: json)
    case "click":
        cliEmit(t_clickElement(toolArgs), json: json)
    case "rclick":
        cliEmit(t_rightClick(toolArgs), json: json)
    case "type":
        cliEmit(t_typeText(toolArgs), json: json)
    case "key":
        cliEmit(t_keyPress(toolArgs), json: json)
    case "scroll":
        cliEmit(t_scroll(toolArgs), json: json)
    case "menu":
        cliEmit(t_menu(toolArgs), json: json)
    case "clip":
        let action = positional.first ?? ""
        switch action {
        case "get": cliEmit(t_clipGet([:]), json: json)
        case "set": cliEmit(t_clipSet(toolArgs), json: json)
        default:
            FileHandle.standardError.write("clip needs 'get' or 'set'\n".data(using: .utf8)!)
            exit(2)
        }
    case "shot":
        if let outPath = opts["out"] {
            // --out specified: call screencapture directly.
            var procArgs = ["-x"]
            if let bid = opts["bundle-id"], let app = findApp(bid),
               let wid = windowIdFor(pid: app.processIdentifier) {
                procArgs.append(contentsOf: ["-l", "\(wid)"])
            }
            procArgs.append(outPath)
            let p = Process()
            p.launchPath = "/usr/sbin/screencapture"
            p.arguments = procArgs
            do { try p.run(); p.waitUntilExit() } catch {
                cliEmit(toolError("screencapture failed: \(error)"), json: json)
            }
            if p.terminationStatus == 0 {
                cliEmit(toolResult(outPath), json: json)
            } else {
                cliEmit(toolError("screencapture exit=\(p.terminationStatus)"), json: json)
            }
        } else {
            cliEmit(t_screenshot(toolArgs), json: json)
        }
    default:
        FileHandle.standardError.write("unknown subcommand: \(sub)\n".data(using: .utf8)!)
        cliPrintHelp()
        exit(2)
    }
}

// ====================== JSON-RPC loop ======================

func respond(_ id: Any?, result: Any? = nil, error: [String: Any]? = nil) {
    let obj = JSONRPC.response(id: id, result: result, error: error)
    let data = try! JSONRPC.encode(obj)
    FileHandle.standardOutput.write(data)
}

// Entry point: args present (and not `serve`) → CLI mode, otherwise MCP mode.
let cliArgs = Array(CommandLine.arguments.dropFirst())
if let first = cliArgs.first, first != "serve" {
    cliMain(cliArgs)
}

let promptOpts: NSDictionary = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true]
if !AXIsProcessTrustedWithOptions(promptOpts) {
    pcuLog("Accessibility permission required")
}

pcuLog("pi-computer-use MCP server started (stdio) v\(PiComputerUse.version)")

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        continue
    }
    let method = msg["method"] as? String ?? ""
    let id = msg["id"]
    let params = msg["params"] as? [String: Any] ?? [:]

    switch method {
    case "initialize":
        respond(id, result: [
            "protocolVersion": "2024-11-05",
            "capabilities": ["tools": [String: Any]()],
            "serverInfo": [
                "name": PiComputerUse.serverName,
                "version": PiComputerUse.version
            ]
        ])
    case "notifications/initialized":
        continue
    case "tools/list":
        respond(id, result: ["tools": toolsList])
    case "tools/call":
        let name = params["name"] as? String ?? ""
        let args = params["arguments"] as? [String: Any] ?? [:]
        respond(id, result: handleTool(name, args))
    case "ping":
        respond(id, result: [String: Any]())
    default:
        if id != nil {
            respond(id, error: ["code": JSONRPC.ErrorCode.methodNotFound, "message": "method not found: \(method)"])
        }
    }
}

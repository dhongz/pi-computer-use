# Architecture

pi-computer-use is a single Swift executable that can run in two modes:

| Mode | Invocation | stdout |
|---|---|---|
| **MCP server** | no args, or `pi-computer-use serve` | JSON-RPC lines only |
| **CLI** | `pi-computer-use <subcommand> …` | human text or `--json` |

Logging always goes to **stderr** (`[pi-computer-use] …`) so MCP framing on stdout stays intact.

## Module split

```
Package.swift
├── PiComputerUseCore          (library, no AppKit / AX — CI-testable)
│   ├── Version.swift
│   ├── CLIArgs.swift
│   └── JSONRPC.swift
├── PiComputerUseMac           (library — all macOS-specific code)
│   ├── Accessibility.swift    AX tree walk, find, refs, permissions
│   ├── Input.swift            CGEvent click/type/key/scroll
│   ├── Screenshot.swift       screencapture + window id
│   ├── AppRegistry.swift      list/activate apps
│   └── Tools.swift            tool implementations + registry
└── pi-computer-use            (executable)
    └── main.swift             MCP loop + CLI dispatch
```

Permission-sensitive code lives only in `Sources/PiComputerUseMac`. Pure helpers
belong in `PiComputerUseCore` with matching tests under `Tests/PiComputerUseCoreTests/`.

## Control flow (MCP)

```mermaid
sequenceDiagram
    participant Agent as MCP client
    participant PCU as pi-computer-use
    participant AX as AXUIElement
    participant CG as CGEvent

    Agent->>PCU: initialize
    PCU-->>Agent: capabilities + serverInfo
    Agent->>PCU: tools/list
    PCU-->>Agent: tool schemas
    Agent->>PCU: tools/call (e.g. get_ax_tree)
    PCU->>AX: copy attribute tree
    AX-->>PCU: roles, titles, children
    PCU-->>Agent: numbered text tree + ref map
    Agent->>PCU: tools/call (click_ref)
    PCU->>AX: AXPress or CGEvent click
    PCU-->>Agent: result text
```

## Element references (`@eN`)

`get_ax_tree` and `ax_tree_json` populate an in-process `refMap: [Int: AXUIElement]`.
Refs are **invalidated** on the next tree dump for the same process. Agents should
either:

- re-fetch the tree before `click_ref`, or
- use `click_element` / `find_element` with a stable substring query.

## Input synthesis

| Action | Primary path | Fallback |
|---|---|---|
| Click | `AXPress` on element | `CGEvent` left click at element center |
| Right click | — | `CGEvent` right button at center |
| Type | `CGEvent` Unicode keystrokes | — |
| Key combo | `CGEvent` virtual key + flags | — |
| Scroll | `CGEvent` scroll wheel | optional focus point from element center |

## Screenshots

`screenshot` shells out to `/usr/sbin/screencapture`. When `bundle_id` is set,
the tool resolves the app's main window via `CGWindowListCopyWindowInfo` and
captures that window. This requires **Screen Recording** permission in addition
to Accessibility for some macOS versions.

## Why not CDP / Playwright?

CDP attaches to a browser process and sees the DOM. `pi-computer-use` never enters the
browser — it sees the same AX tree as VoiceOver and sends the same events a
human would. That is why a normal, logged-in Chrome session works without
exporting cookies or launching a second profile.

Trade-offs:

- Slower and noisier than DOM selectors for web-only tasks
- Substring search can match the wrong element when labels repeat
- macOS-only; no Linux/Windows support planned

## CI vs local dev

GitHub Actions runs `swift build` and `swift test` on `macos-14` and `macos-15`.
Tests cover `PiComputerUseCore` only. Integration tests that require Accessibility are not
run in CI; use `./scripts/smoke-test.sh` locally after granting permissions.

# pi-computer-use

**Computer use for Pi on macOS** — control native apps through the Accessibility
API and control claimed tabs in your existing Chrome profile through a local MV3
extension. Both surfaces are exposed as MCP stdio servers; the native backend
also includes a diagnostic CLI.

Forked from [nogu66/open-computer-use](https://github.com/nogu66/open-computer-use)
(MIT License) and re-architected for the [Pi](https://pi.dev) coding agent.

| | Playwright / CDP | **pi-computer-use** |
|---|---|---|
| Uses your logged-in Chrome profile | Usually no (separate profile) | **Yes** — operates the real app |
| Cookie / SSO / extensions | Often lost | **Preserved** |
| `navigator.webdriver` | May be set | **Not applicable** (not in the browser) |
| Platform | Cross-platform | **macOS 13+ only** |

## Install

Install the latest **release binary** to `~/.local/bin/pi-computer-use`:

```bash
curl -fsSL https://raw.githubusercontent.com/dhongz/pi-computer-use/main/scripts/install.sh | bash
```

From a checkout:

```bash
./scripts/install.sh              # latest GitHub Release (falls back to source build)
./scripts/install.sh --version v0.1.0
./scripts/install.sh --from-source  # SwiftPM build only
```

Ensure `~/.local/bin` is on your `PATH`, then wire the native MCP server:

```bash
pi mcp add pi-computer-use -- "$(which pi-computer-use)"
```

To add browser-level control for your existing Chrome profile, use the checkout
installer after cloning the repository:

```bash
./scripts/install-chrome.sh
```

It stages the Pi Chrome extension, configures the `pi-chrome` MCP server, and
prints the directory to load once from `chrome://extensions`. Full instructions
are in [`docs/chrome-browser.md`](docs/chrome-browser.md).

## Pi integration

Add the MCP server to Pi's config (`~/.pi/agent/mcp.json`):

```json
{
  "mcpServers": {
    "pi-computer-use": {
      "command": "/Users/<you>/.local/bin/pi-computer-use",
      "args": []
    }
  }
}
```

See [`integrations/pi/mcp.json`](integrations/pi/mcp.json) for a ready-to-use
example, and [`skills/computer-use/SKILL.md`](skills/computer-use/SKILL.md)
for the agent skill.

## Quick start (manual build)

### Requirements

- macOS 13 (Ventura) or later
- Swift 5.9+ (Xcode 15+) only if building from source
- **Accessibility** permission for the process that launches `pi-computer-use`
  (Terminal, Ghostty, Pi, …)

### Build from source

```bash
git clone https://github.com/dhongz/pi-computer-use.git
cd pi-computer-use
swift build
swift test
```

### CLI smoke test

```bash
pi-computer-use apps
pi-computer-use activate --bundle-id com.google.Chrome
pi-computer-use tree --bundle-id com.google.Chrome --depth 6
pi-computer-use click --bundle-id com.google.Chrome --query "Search"
```

Run the MCP protocol smoke test (no UI permissions required for `list_apps`):

```bash
./scripts/smoke-test.sh
```

## Permissions

| Permission | Required for | Where to enable |
|---|---|---|
| **Accessibility** | AX tree, clicks, keys, menus | System Settings → Privacy & Security → Accessibility |
| **Screen Recording** | `screenshot` (window capture via `screencapture`) | System Settings → Privacy & Security → Screen Recording |

Grant access to the **parent app** that spawns `pi-computer-use` (e.g. Pi), not
only the binary. Details: [docs/permissions.md](docs/permissions.md).

## MCP tools

| Tool | Summary |
|---|---|
| `list_apps` | Running GUI apps (name, bundle ID, PID) |
| `get_ax_tree` | Numbered AX tree text for an app/window |
| `ax_tree_json` | Same tree as JSON (`ref`, `role`, `children`, …) |
| `find_element` | Locate first element matching a substring |
| `click_element` / `click_ref` | Click by query or `@eN` ref from last tree |
| `activate` | Bring app to foreground (call before typing) |
| `type_text` / `key_press` | Unicode typing and key combos |
| `wait_for` | Poll until an element appears |
| `scroll` / `right_click` | Wheel and context menu |
| `screenshot` | PNG path or base64 |
| `menu` | Menubar path, e.g. `File/Open` |
| `clip_get` / `clip_set` | Clipboard text |

Full native schemas and agent tips: [docs/tools.md](docs/tools.md). Browser
schemas and the extension bridge are documented in
[`docs/chrome-browser.md`](docs/chrome-browser.md).

## Browser vs. desktop workflow

Use the `pi-chrome_*` tools for websites and local web apps. They operate inside
Chrome through DOM/browser APIs and do not move the macOS pointer. Use the native
`pi-computer-use_*` tools for Finder, Slack desktop, native settings, and other
applications that are not browser pages. The native backend remains the fallback
for canvas and opaque browser regions.

## Recommended agent workflow

The MCP server is persistent: refs, the latest state, active app metadata, and
action receipts live across sequential `tools/call` requests.

1. `list_apps` — find `bundle_id` (e.g. `com.google.Chrome`)
2. `activate` — focus the app so keystrokes do not leak elsewhere
3. `get_app_state` — inspect the coherent AX tree; set `screenshot: true` when visual verification is needed
4. Use `click`/`click_ref`, `set_value`, `select_text`, `type_text`, `press_key`, `drag`, or `perform_secondary_action`
5. `wait_for` — bridge async page loads; fetch `get_app_state` again after state changes
6. `ocr` or `get_app_state` with `ocr: true` — use local Apple Vision only when AX is incomplete

The compatibility aliases (`get_ax_tree`, `ax_tree_json`, `click_element`, and
`key_press`) remain available for diagnostics and older clients. Every successful
call includes `structuredContent` with a request ID, state metadata, and (for
mutations) an action receipt. Stale refs return `STALE_REF` rather than silently
clicking another element.

## Architecture

```
Your agent (Pi / Claude / Codex / Cursor / …)
        │  MCP JSON-RPC over stdio
        ├──────────────────────────────┐
        ▼                              ▼
   pi-computer-use (Swift)        pi-chrome (Node)
   ├── AXUIElement                 └── authenticated WebSocket
   ├── CGEvent                          │
   └── screencapture                    ▼
        │                         Pi Chrome MV3 extension
        ▼                              │
   Native macOS apps            Existing Chrome profile/tabs
```

Source layout:

```
Sources/
  PiComputerUseCore/        # platform-free: Version, CLIArgs, JSONRPC
  PiComputerUseMac/         # macOS-specific library
    Accessibility.swift     # AX tree walk, find, refs, permissions
    Input.swift              # CGEvent click/type/key/scroll
    Screenshot.swift         # screencapture + window id
    AppRegistry.swift        # list/activate apps
    Tools.swift              # tool implementations + registry
  pi-computer-use/          # executable: MCP loop + CLI dispatch
```

More detail: [docs/architecture.md](docs/architecture.md) and
[docs/chrome-browser.md](docs/chrome-browser.md).

## v0.2 implementation notes

- The native backend now exposes a persistent `ComputerUseSession` over MCP.
- Apple Vision is the default, local OCR provider. Select it explicitly with
  `ocr_provider: "vision"` or `PCU_OCR_PROVIDER=vision`.
- A remote/third-party provider seam is advertised as `http` but intentionally
  remains unconfigured and disabled. Selecting it fails safely without uploading
  screenshots; a future provider can implement `OCRProvider` without changing
  MCP contracts.
- OCR fallback targets require a unique match with confidence >= 0.75 and report
  `source: "ocr"`; AX targeting remains the default.
- Browser pages use the optional `pi-chrome` MCP server and local Chrome extension;
  DOM actions stay inside Chrome rather than using global macOS input.

See the design and acceptance requirements in:

- [Stateful Computer Use v0.2 plan](docs/stateful-computer-use-plan.md)
- [Computer Use API contract](docs/api-contract.md)
- [OCR strategy](docs/ocr-strategy.md)

## Attribution

This project is a fork of
[nogu66/open-computer-use](https://github.com/nogu66/open-computer-use),
Copyright (c) 2026 Yuta Noguchi, used under the MIT License. See
[LICENSE](LICENSE).

## License

MIT — see [LICENSE](LICENSE).

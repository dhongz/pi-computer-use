# Pi Chrome browser bridge

Pi Computer Use has two browser surfaces:

- `pi-computer-use_*` controls the real macOS desktop through Accessibility and
  CGEvent. It is the fallback for native apps and opaque/canvas UI.
- `pi-chrome_*` controls claimed tabs in the user's existing Chrome profile
  through a local MV3 extension. Browser actions stay inside Chrome and do not
  post global macOS mouse events.

The Chrome bridge is deliberately separate from the Swift desktop backend:

```text
Pi MCP client
    │ stdio JSON-RPC
    ▼
pi-chrome MCP server (Node)
    │ authenticated WebSocket on 127.0.0.1
    ▼
Pi Chrome Bridge extension (MV3)
    │ chrome.tabs / chrome.scripting / chrome.debugger
    ▼
User's existing Chrome profile and tabs
```

## Install

From this checkout:

```bash
./scripts/install-chrome.sh
```

The installer:

1. Creates a random local bridge token at
   `~/.pi/agent/chrome-bridge-token` with owner-only permissions.
2. Stages the unpacked extension at `~/.pi/agent/chrome-extension`.
3. Adds the `pi-chrome` MCP server to `~/.pi/agent/mcp.json`.
4. Prints the extension directory that must be loaded once in Chrome.

Chrome requires a user gesture to load an unpacked extension. In Chrome, open
`chrome://extensions`, turn on **Developer mode**, choose **Load unpacked**, and
select the printed directory. The extension asks for access to tabs, page DOM,
and the Chrome debugger because those permissions are required for tab control,
DOM snapshots, keyboard input, and background screenshots.

Then reload Pi's MCP configuration or restart Pi. The `pi-chrome_status` tool
should report `connected: true`.

Use `--open-extensions` if you want the installer to open the extensions page:

```bash
./scripts/install-chrome.sh --open-extensions
```

The bridge binds only to `127.0.0.1`. The WebSocket handshake requires the
random token, and the token is never printed by the installer or MCP server.

## Browser workflow

1. Call `pi-chrome_status`.
2. Call `pi-chrome_new_tab` for a new tab, or `pi-chrome_list_tabs` followed by
   `pi-chrome_claim_tab` for an existing tab.
3. Call `pi-chrome_get_state` to obtain a visible DOM snapshot and versioned
   `node_id` values.
4. Use `pi-chrome_click`, `pi-chrome_fill`, or `pi-chrome_press_key` with a
   `node_id` and its `state_version`.
5. Capture a new state after actions. A stale node returns `STALE_STATE` instead
   of silently acting on a different element.
6. Use `pi-chrome_wait_for` for navigation and asynchronous UI changes.
7. Call `pi-chrome_release_tab` when the agent should leave a user tab alone.

New tabs are claimed by Pi automatically and are inactive by default. Pass
`active: true` only when the user wants the tab brought to the front.

Existing tabs are not changed until explicitly claimed. Claiming can include an
expected title and URL so a reused tab id fails closed if the tab changed.

## Tool surface

| Tool | Purpose |
| --- | --- |
| `pi-chrome_status` | Bridge and extension health, install hint, capabilities |
| `pi-chrome_list_tabs` | List tabs, ownership, active state, URL, title |
| `pi-chrome_new_tab` | Create and claim a tab in the existing profile |
| `pi-chrome_claim_tab` | Claim an exact existing tab |
| `pi-chrome_release_tab` | Release a claimed tab without closing it |
| `pi-chrome_close_tab` | Close Pi-owned tabs; `force` is required for other tabs |
| `pi-chrome_navigate` | Navigate a claimed tab |
| `pi-chrome_get_state` | Visible DOM snapshot, roles, names, selectors, bounds, version |
| `pi-chrome_screenshot` | Browser-level screenshot, including background tabs |
| `pi-chrome_click` | DOM click without moving the macOS pointer |
| `pi-chrome_fill` | Fill an input/select/contenteditable element |
| `pi-chrome_press_key` | CDP keyboard input within the claimed tab |
| `pi-chrome_wait_for` | Wait for visible text or a selector |

## Security and privacy

The extension can read and modify pages in the Chrome profile where it is
installed. That includes logged-in sites, cookies exposed through page state,
private messages, and internal tools. Only load this extension into a Chrome
profile that Pi is explicitly allowed to use.

The bridge has several boundaries:

- It only accepts WebSocket connections from loopback with the generated token.
- It requires an existing tab to be explicitly claimed before mutation.
- It rejects ambiguous DOM targets.
- It versions DOM snapshots and rejects stale node ids.
- It keeps screenshots in MCP responses rather than writing them to a shared
  permanent directory.
- It uses browser-level input, not global macOS CGEvents, for ordinary tab work.

Web pages remain untrusted content. Page text cannot grant permission to send,
submit, upload, delete, purchase, or disclose sensitive information.

## Limitations

- Chrome internal pages such as `chrome://extensions` are not scriptable.
- The extension must be loaded once manually because Chrome protects unpacked
  extension installation behind Developer mode.
- The current bridge uses one fixed loopback port per user profile. Run one
  `pi-chrome` bridge at a time, or set a different `PI_CHROME_PORT` and reinstall
  the extension for another profile/session.
- The bridge is intentionally not a replacement for the native macOS backend.
  Use `pi-computer-use_*` for Finder, Slack desktop, native settings, and other
  non-browser applications.

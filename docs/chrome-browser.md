# Pi Chrome browser bridge

Pi Computer Use has two browser surfaces:

- `pi-computer-use_*` controls the real macOS desktop through Accessibility and
  CGEvent. It is the fallback for native apps and opaque/canvas UI.
- `pi-chrome_*` controls claimed tabs in the user's existing Chrome profile
  through a local MV3 extension. Browser actions stay inside Chrome and do not
  post global macOS mouse events.

The Chrome bridge is deliberately separate from the Swift desktop backend:

```text
Pi MCP/Pi adapter clients
    │ authenticated control WebSocket on 127.0.0.1
    ▼
shared pi-chrome daemon (one per Chrome profile)
    │ authenticated browser WebSocket on 127.0.0.1
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

### Pi extension mode

The standalone MCP server works with any MCP client. For a first-class Pi
installation, install the repository as a Pi package instead:

```bash
./scripts/install-pi-extension.sh
```

This registers direct `pi_chrome_*` tools, connects to the shared daemon from
Pi's session lifecycle, adds `/chrome-status`, and disables the standalone
`pi-chrome` MCP entry in Pi's local config to avoid duplicate Pi-side tools. The
daemon remains shared across Pi sessions and owns the browser port.
The Chrome MV3 extension is still required. Run `/reload` after installation.

Use `--open-extensions` if you want the installer to open the extensions page:

```bash
./scripts/install-chrome.sh --open-extensions
```

The daemon binds both control and browser sockets only to `127.0.0.1`. The
WebSocket handshakes require the random token, and the token is never printed by
the installer or MCP server. Multiple Pi sessions connect to the same daemon;
they do not each bind the browser port.

## Browser workflow

1. Call `pi-chrome_status`.
2. Call `pi-chrome_new_tab` with a short `group_title` for a new task tab.
   The bridge creates a blue `Pi · <title>` group and reuses it for later tabs in
   this session. If the group was closed, it creates a replacement. Existing
   user tabs can be listed and claimed without moving them into the task group.
3. Call `pi-chrome_get_state` to obtain a visible DOM snapshot and versioned
   `node_id` values.
4. Use `pi-chrome_click`, `pi-chrome_fill`, or `pi-chrome_press_key` with a
   `node_id` and its `state_version`.
5. Capture a new state after actions. A stale node returns `STALE_STATE` instead
   of silently acting on a different element.
6. Use `pi-chrome_wait_for` for navigation and asynchronous UI changes.
7. After saving the result and checking for unsaved work, call
   `pi-chrome_close_group` to finish the task. Release any claimed user tabs with
   `pi-chrome_release_tab`; don't close them.

New tabs are claimed by Pi automatically and are inactive by default. Pass
`active: true` only when the user wants the tab brought to the front. The default
group label is `Pi · Browser task`; pass `group_title` to name the task.
Sessions never share a group based on its title.

Group cleanup closes only tabs created by this session that are still in its
task group. User tabs dragged into the group, other sessions' tabs, and task tabs
moved outside the group are preserved. Cleanup reports `closedTabIds` and
`preservedTabIds` for tabs in the group. It is explicit: a disconnect releases
ownership without closing tabs. The package includes a `pi-chrome` skill that
instructs the agent to clean up when finished.

Updating an existing installation requires re-staging the Chrome extension and
reloading it at `chrome://extensions` to grant the `tabGroups` permission. Restart
the shared daemon when no sessions own tabs, then run `/reload` in Pi to load the
new tool and skill. For Pi extension mode, stage with
`./scripts/install-chrome.sh --no-configure-pi` so the update doesn't re-enable
duplicate standalone MCP tools. Reload the Chrome extension after staging;
updating files alone doesn't update a running service worker.

Existing tabs are not changed until explicitly claimed. Claiming can include an
expected title and URL so a reused tab id fails closed if the tab changed.

## Action safety and cancellation

Snapshot references point to actual elements in Chrome's isolated extension
world, not a CSS position in a list. A DOM mutation invalidates the snapshot;
refresh it on `STALE_STATE`. This is deliberately conservative on pages that
update often. Selector and role/name fallbacks still resolve against the current
page and must uniquely identify the intended target.

Clicks reject disabled, inert, or covered controls. Filling rejects read-only
controls and dropdown options that are missing or disabled. The bridge checks
that a filled value was retained synchronously. A click or key receipt confirms
dispatch, not that the application saved data; inspect fresh state afterward.

Pi cancellation is checked before dispatch and forwarded through the daemon to
browser commands. It stops queued commands and polling waits, but it cannot
undo a click, navigation, or tab removal already handed to Chrome. Refresh state
before retrying an interrupted operation. `wait_for.timeout_ms` accepts 0 through
120000; both transports allow five seconds beyond longer polling deadlines.

## Tests

```bash
npm ci --prefix browser
npm test --prefix browser
CHROME_BIN=/path/to/chrome-for-testing npm run test:browser --prefix browser
```

The Node tests cover connection recovery, cancellation, session ownership,
cleanup races, and release packaging. The integration test starts an isolated
headless Chrome for Testing or Chromium with a temporary profile and its own
bridge ports. It uses only local fixture pages and deletes the temporary profile
afterward; it does not attach to your existing browser. CI runs both suites in a
separate Linux job alongside the Swift jobs. No additional test framework or
compiler is required.

Release archives preserve the checkout's `scripts/`, `browser/`, `extensions/`,
and `skills/` layout. Run `scripts/install-chrome.sh` from the extracted archive;
`--help` works without installing dependencies. Installed `node_modules` and
local bridge token configuration are excluded from the archive.

## Tool surface

| Tool | Purpose |
| --- | --- |
| `pi-chrome_status` | Bridge and extension health, install hint, capabilities |
| `pi-chrome_list_tabs` | List tabs, ownership, active state, URL, title |
| `pi-chrome_new_tab` | Create and claim a tab in this session's labeled task group |
| `pi-chrome_close_group` | Close this session's task tabs without closing unrelated tabs |
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
- DOM inspection and targeting currently cover the top-level document, not
  iframe contents or shadow roots.
- Chrome can reject debugger attachment when another extension has a frame in
  the page. Keyboard input and screenshots then fail while DOM actions may
  still work. Don't bypass browser security settings to work around this.
- The extension must be loaded once manually because Chrome protects unpacked
  extension installation behind Developer mode.
- The current daemon uses one browser/control port pair per Chrome profile.
  Multiple Pi sessions share it. Use a different `PI_CHROME_PORT` and
  `PI_CHROME_CONTROL_PORT` pair for a second Chrome profile.
- The bridge is intentionally not a replacement for the native macOS backend.
  Use `pi-computer-use_*` for Finder, Slack desktop, native settings, and other
  non-browser applications.

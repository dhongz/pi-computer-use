---
name: pi-computer-use
description: Control local macOS apps through Computer Use for tasks that require reading or operating app UI. Use whenever the user wants to click buttons, read on-screen content, type into open windows, or operate their logged-in browser or native Mac apps. Prefer purpose-built connectors, APIs, or CLIs when available.
---

# pi-computer-use

macOS Accessibility API + CGEvent + `screencapture`, packaged as one CLI/MCP
binary (`pi-computer-use`). Model-agnostic: works from any agent that can call
Bash or MCP.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/dhongz/pi-computer-use/main/scripts/install.sh | bash
export PATH="$HOME/.local/bin:$PATH"
pi-computer-use --version
```

From a checkout:

```bash
./scripts/install.sh --from-source
```

## Binary resolution

When installed as a plugin, prefer the bundled wrapper:

```bash
PCU="${CLAUDE_PLUGIN_ROOT}/scripts/pcu-cli.sh"
# Pi / Codex / Cursor project checkout:
# PCU="$(git rev-parse --show-toplevel)/scripts/pcu-cli.sh"
```

After install:

```bash
PCU="$(command -v pi-computer-use)"
```

Wrappers auto-install the latest release to `~/.local/bin/pi-computer-use` on
first use unless `PCU_SKIP_AUTO_INSTALL=1`.

## When to use

- Logged-in Chrome, Gmail, Notion, Slack, banking sites
- Native Mac apps without APIs (Notes, System Settings, etc.)
- Reading what is actually on screen
- Avoiding bot detection (no CDP, no new browser profile)

## When not to use

- Fresh-profile scraping only → Playwright
- Public HTML fetch only → WebFetch / curl
- Service has a stable API → use the API

## Core workflow

```bash
$PCU apps
$PCU activate --bundle-id com.google.Chrome
$PCU tree --bundle-id com.google.Chrome --depth 8
$PCU click --bundle-id com.google.Chrome --query "Address and search bar"
$PCU type --text "https://example.com"
$PCU key --key return
$PCU shot --bundle-id com.google.Chrome --out /tmp/after.png
```

## Subcommands

| Command | Purpose |
|---|---|
| `apps` | List GUI apps (bundle ID + PID) |
| `activate --bundle-id <id>` | Bring app to front (**call first**) |
| `tree --bundle-id <id> [--depth N]` | AX tree; add `--json` for structured output |
| `find --bundle-id <id> --query <q>` | Substring match on AX labels |
| `wait --bundle-id <id> --query <q> [--timeout SEC]` | Poll until element appears |
| `click` / `rclick` | Left / right click by `--query` |
| `type --text <s>` | Type into focused field |
| `key --key <name> [--mods cmd,shift,alt,ctrl]` | Key press |
| `scroll` | Scroll at element or cursor |
| `menu --bundle-id <id> --path <p>` | Menubar path, e.g. `"File/New Tab"` |
| `shot [--bundle-id <id>] [--out <path>]` | Screenshot PNG |
| `clip get` / `clip set --text <s>` | Clipboard |

## MCP vs CLI

Same binary. Plugin install exposes MCP tools (`list_apps`, `get_ax_tree`,
`click_element`, …). Bash agents use the CLI subcommands above.

Direct MCP (no wrapper):

```bash
pi mcp add pi-computer-use -- "$(command -v pi-computer-use)"
```

## Pitfalls

- Always `activate` first — otherwise `type`/`key` leak to the terminal
- Prefer `menu` over `Cmd+T` when Chrome is playing video (keys may be captured)
- `find`/`click` return the first match — narrow queries or inspect `tree` first
- CLI mode has no `@eN` refs — use `--query` (MCP `click_ref` uses refs from last tree)
- Grant **Accessibility** (and **Screen Recording** for screenshots) to the parent app (Pi, Claude Code, Cursor, Codex, Terminal)

Repository: https://github.com/dhongz/pi-computer-use

# Plugin install guide

Install **pi-computer-use** as a plugin for Claude Code, Codex, or Cursor. Each path bundles:

- MCP server (`scripts/mcp-server.sh` → `pi-computer-use` stdio)
- Agent skill (`skills/pi-computer-use/SKILL.md`)

## 1. Install the binary (do this first)

Default: download the **latest GitHub Release** to `~/.local/bin/pi-computer-use`.

```bash
curl -fsSL https://raw.githubusercontent.com/dhongz/pi-computer-use/main/scripts/install.sh | bash
```

From a checkout:

```bash
./scripts/install.sh
./scripts/install.sh --version v0.1.0
./scripts/install.sh --from-source   # SwiftPM only
```

Add to PATH if needed:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

## 2. Binary resolution (MCP wrappers)

`scripts/mcp-server.sh` and `scripts/pcu-cli.sh` resolve `pi-computer-use` in this order:

1. `pi-computer-use` on `PATH`
2. `$PCU_BIN` if set
3. `~/.local/bin/pi-computer-use`
4. `.build/release/pi-computer-use` in the plugin checkout (dev)
5. Auto-run `scripts/install.sh` (latest release) unless `PCU_SKIP_AUTO_INSTALL=1`
6. Source build if `PCU_FROM_SOURCE=1` and Swift is available

## Claude Code

From Claude Code:

```text
/plugin marketplace add dhongz/pi-computer-use
/plugin install pi-computer-use@pi-computer-use
/reload-plugins
```

Or add a local checkout:

```text
/plugin marketplace add /path/to/pi-computer-use
/plugin install pi-computer-use@pi-computer-use
```

Manifest: [`.claude-plugin/plugin.json`](../.claude-plugin/plugin.json)  
MCP config: [`.mcp.json`](../.mcp.json)

After install, MCP tools appear as `mcp__pi-computer-use__*`.

## Codex

Add the GitHub marketplace:

```bash
codex plugin marketplace add dhongz/pi-computer-use
```

Then open the Codex plugin directory, select the **pi-computer-use** marketplace, and install the plugin.

For a local checkout during development:

```bash
codex plugin marketplace add /path/to/pi-computer-use
```

Manifest: [`.codex-plugin/plugin.json`](../.codex-plugin/plugin.json)  
Repo marketplace (Codex): [`.agents/plugins/marketplace.json`](../.agents/plugins/marketplace.json)

## Cursor

**Option A — open this repo in Cursor**

Project files are already wired:

- [`.cursor/mcp.json`](../.cursor/mcp.json)
- [`.cursor/skills/pi-computer-use/SKILL.md`](../.cursor/skills/pi-computer-use/SKILL.md)

Restart Cursor or reload MCP.

**Option B — use from any project**

1. Install binary: `curl -fsSL …/scripts/install.sh | bash`
2. Add to user MCP config (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "pi-computer-use": {
      "command": "/Users/YOU/.local/bin/pi-computer-use",
      "args": []
    }
  }
}
```

Or keep the wrapper for auto-install on first connect:

```json
{
  "mcpServers": {
    "pi-computer-use": {
      "command": "/Users/YOU/pi-computer-use/scripts/mcp-server.sh",
      "args": []
    }
  }
}
```

3. Copy the skill: `cp -R ~/pi-computer-use/skills/pi-computer-use ~/.cursor/skills/`

## Permissions (all clients)

Grant **Accessibility** to the app running the agent (Claude Code, Cursor, Codex, Terminal).  
Grant **Screen Recording** if you use `screenshot`.

See [docs/permissions.md](../docs/permissions.md).

## Verify

```bash
pi-computer-use --version
./scripts/smoke-test.sh
```

Or ask the agent to call `list_apps` via MCP.

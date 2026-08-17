# Claude Code

## Plugin (recommended)

```text
/plugin marketplace add dhongz/pi-computer-use
/plugin install pi-computer-use@pi-computer-use
/reload-plugins
```

See [plugin-install.md](plugin-install.md).

## Installed binary

```bash
curl -fsSL https://raw.githubusercontent.com/dhongz/pi-computer-use/main/scripts/install.sh | bash
claude mcp add pi-computer-use -- $(which pi-computer-use)
```

## Dev checkout (wrapper auto-installs latest release)

```bash
claude mcp add pi-computer-use -- \
  /path/to/pi-computer-use/scripts/mcp-server.sh
```

Restart Claude Code. Tools appear as `mcp__pi-computer-use__<tool_name>`.

## Verify

Ask the agent to call `list_apps`, or run locally:

```bash
./scripts/smoke-test.sh
```

## Permissions

Grant **Accessibility** to Claude Code in System Settings. See
[../docs/permissions.md](../docs/permissions.md).

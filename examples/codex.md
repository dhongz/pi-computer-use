# Codex CLI

## Plugin (recommended)

```bash
codex plugin marketplace add dhongz/pi-computer-use
```

Then install **pi-computer-use** from the Codex plugin directory.

See [plugin-install.md](plugin-install.md).

## Installed binary

```bash
curl -fsSL https://raw.githubusercontent.com/dhongz/pi-computer-use/main/scripts/install.sh | bash
codex mcp add pi-computer-use $(which pi-computer-use)
```

## Dev checkout

```bash
codex mcp add pi-computer-use \
  /path/to/pi-computer-use/scripts/mcp-server.sh
```

The wrapper resolves `~/.local/bin/pi-computer-use` or auto-installs the latest release on first use.

## Verify

```bash
./scripts/smoke-test.sh
```

## Note on Codex Computer Use

OpenAI ships a separate bundled **Codex Computer Use** app (`SkyComputerUseClient`).
`pi-computer-use` is an independent open-source implementation with a similar technique (AX +
CGEvent) but not affiliated with OpenAI.

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Stateful v0.2 Computer Use API with structured app state, versioned refs,
  action receipts, semantic Accessibility actions, local Vision OCR, and safer
  focus/target validation.
- Optional `pi-chrome` MCP server, shared per-profile Chrome daemon, Pi Chrome
  Bridge MV3 extension, and Pi package adapter for browser-level control of
  claimed tabs in an existing Chrome profile without macOS global mouse events.

### Fixed

- Chrome node references now retain element identity and reject snapshots after
  DOM mutations, rather than resolving old references to a different list row.
- Browser actions reject disabled, read-only, inert, or covered controls and
  invalid dropdown options instead of reporting a successful no-op.
- Pi and MCP cancellation now reaches queued commands and browser polling.
  Long waits use matching transport deadlines.
- Concurrent tab claims reserve ownership before accessing Chrome. Group cleanup
  rechecks membership before removal and preserves tabs moved out during cleanup.
- Concurrent reconnects share one socket; disconnected Pi adapters can start a
  fresh connection instead of retaining a completed startup promise.
- Release archives preserve browser script paths and omit installed dependencies
  and local bridge credentials. CI runs safety tests and real headless Chrome
  integration tests without an added test framework.

### Removed

- Unused duplicate DOM helpers and an unused status formatter.

## [0.1.0] - 2026-05-22

### Added

- `ocu` executable: MCP stdio server and CLI in one binary.
- MCP tools: `list_apps`, `get_ax_tree`, `ax_tree_json`, `find_element`,
  `click_element`, `click_ref`, `activate`, `type_text`, `key_press`,
  `wait_for`, `scroll`, `right_click`, `screenshot`, `menu`, `clip_get`,
  `clip_set`.
- CLI subcommands mirroring common tool operations (`apps`, `tree`, `click`, …).
- `OCUCore` library: version metadata, CLI argument parsing, JSON-RPC helpers.
- XCTest suite for `OCUCore` (runs in CI without Accessibility grants).
- GitHub Actions: CI on macOS 14/15, release workflow for universal binaries.
- Claude Code, Codex, and Cursor plugin manifests (`.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `.cursor/`).
- Bundled agent skill and MCP wrapper scripts (`skills/`, `scripts/mcp-server.sh`).
- `scripts/lib/github-release.sh` and release-first `scripts/install.sh` (default: latest GitHub Release).
- Documentation, examples, and install/smoke-test scripts.

### Changed

- User-facing docs and examples use the `open-computer-use` name and GitHub URL consistently.
- MCP wrappers auto-install the latest release to `~/.local/bin/ocu` when the binary is missing.
- Release tarballs include `install.sh`.

[Unreleased]: https://github.com/nogu66/open-computer-use/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/nogu66/open-computer-use/releases/tag/v0.1.0

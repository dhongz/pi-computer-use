#!/usr/bin/env bash
# MCP stdio entrypoint for plugin installs (Pi, Claude Code, Codex, Cursor).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=resolve-pcu.sh
source "${ROOT}/scripts/resolve-pcu.sh"

PCU="$(resolve_pcu "${ROOT}")"
exec "${PCU}"

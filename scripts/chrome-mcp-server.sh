#!/usr/bin/env bash
# Pi Chrome MCP server. The extension must be staged and loaded once in Chrome.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: Node.js >=20 is required for pi-chrome" >&2
  exit 1
fi

if [[ ! -d "${ROOT}/browser/node_modules/ws" ]]; then
  echo "error: pi-chrome dependencies are missing; run: npm --prefix '${ROOT}/browser' ci" >&2
  exit 1
fi

exec "${NODE_BIN}" "${ROOT}/browser/server.mjs"

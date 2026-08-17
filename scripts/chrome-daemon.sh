#!/usr/bin/env bash
# Shared Pi Chrome daemon. One instance owns the browser extension connection.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: Node.js >=20 is required for the Pi Chrome daemon" >&2
  exit 1
fi

if [[ ! -d "${ROOT}/browser/node_modules/ws" && ! -d "${ROOT}/node_modules/ws" ]]; then
  echo "error: pi-chrome dependencies are missing; run scripts/install-chrome.sh or npm ci" >&2
  exit 1
fi

exec "${NODE_BIN}" "${ROOT}/browser/daemon.mjs"

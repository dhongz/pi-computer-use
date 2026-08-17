#!/usr/bin/env bash
# Install the Pi-native browser adapter package from this checkout.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: Node.js >=20 is required for the Pi Chrome Pi extension" >&2
  exit 1
fi

exec "${NODE_BIN}" "${ROOT}/browser/install-pi-extension.mjs" "$@"

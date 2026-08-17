#!/usr/bin/env bash
# Stage and configure the Pi Chrome Bridge extension.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"

if [[ -z "${NODE_BIN}" ]]; then
  echo "error: Node.js >=20 is required for the Pi Chrome Bridge" >&2
  exit 1
fi

if [[ ! -d "${ROOT}/browser/node_modules/ws" ]]; then
  NPM_BIN="${NPM_BIN:-$(command -v npm || true)}"
  if [[ -z "${NPM_BIN}" ]]; then
    echo "error: npm is required to install Pi Chrome Bridge dependencies" >&2
    exit 1
  fi
  "${NPM_BIN}" --prefix "${ROOT}/browser" ci
fi

exec "${NODE_BIN}" "${ROOT}/browser/install.mjs" "$@"

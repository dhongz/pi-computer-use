#!/usr/bin/env bash
# CLI wrapper for skills and docs (same binary resolution as mcp-server.sh).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=resolve-pcu.sh
source "${ROOT}/scripts/resolve-pcu.sh"

PCU="$(resolve_pcu "${ROOT}")"
exec "${PCU}" "$@"

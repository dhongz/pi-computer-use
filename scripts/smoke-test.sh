#!/usr/bin/env bash
# MCP stdio smoke test: initialize → tools/list → list_apps
# Does not require Accessibility (list_apps uses NSWorkspace only).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [[ -x "$ROOT/.build/release/pi-computer-use" ]]; then
  PCU="$ROOT/.build/release/pi-computer-use"
elif [[ -x "$ROOT/.build/debug/pi-computer-use" ]]; then
  PCU="$ROOT/.build/debug/pi-computer-use"
else
  echo "==> Building debug binary first"
  swift build
  PCU="$ROOT/.build/debug/pi-computer-use"
fi

echo "==> Using: $PCU"
"$PCU" --version

TMP="$(mktemp)"
trap 'rm -f "$TMP" "$TMP.stderr" "$TMP.stdout"' EXIT

{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"click_ref","arguments":{"ref":999}}}'
} | "$PCU" 2>"$TMP.stderr" | tee "$TMP.stdout" >/dev/null

fail() {
  echo "FAIL: $1" >&2
  echo "--- stderr ---" >&2
  cat "$TMP.stderr" >&2 || true
  echo "--- stdout ---" >&2
  cat "$TMP.stdout" >&2 || true
  exit 1
}

grep -q '"protocolVersion"' "$TMP.stdout" || fail 'initialize response missing protocolVersion'
grep -q '"tools"' "$TMP.stdout" || fail 'tools/list response missing tools array'
grep -q 'list_apps' "$TMP.stdout" || fail 'tools/list missing list_apps'
grep -q 'get_app_state' "$TMP.stdout" || fail 'tools/list missing state tool'
grep -q '"computerUse"' "$TMP.stdout" || fail 'initialize missing Computer Use capabilities'
grep -q 'structuredContent' "$TMP.stdout" || fail 'tools/call missing structuredContent'
grep -q 'STALE_REF' "$TMP.stdout" || fail 'stale ref response missing structured error'
grep -q '"result"' "$TMP.stdout" || fail 'tools/call missing result'

echo "PASS: MCP smoke test (initialize, tools/list, list_apps)"
if [[ -s "$TMP.stderr" ]]; then
  echo "--- pi-computer-use stderr (informational) ---"
  cat "$TMP.stderr"
fi

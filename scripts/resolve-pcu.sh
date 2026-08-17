#!/usr/bin/env bash
# Resolve the pi-computer-use binary for MCP/CLI wrappers.
set -euo pipefail

resolve_pcu() {
  local root="${1:?repo root required}"
  local candidate

  if command -v pi-computer-use >/dev/null 2>&1; then
    command -v pi-computer-use
    return 0
  fi

  if [[ -n "${PCU_BIN:-}" && -x "${PCU_BIN}" ]]; then
    printf '%s\n' "${PCU_BIN}"
    return 0
  fi

  candidate="${HOME}/.local/bin/pi-computer-use"
  if [[ -x "$candidate" ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi

  local release_bin="${root}/.build/release/pi-computer-use"
  if [[ -x "$release_bin" ]]; then
    printf '%s\n' "$release_bin"
    return 0
  fi

  if [[ "${PCU_SKIP_AUTO_INSTALL:-}" != "1" && -x "${root}/scripts/install.sh" ]]; then
    PCU_QUIET=1 "${root}/scripts/install.sh" || true
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  if [[ "${PCU_FROM_SOURCE:-}" == "1" ]] && command -v swift >/dev/null 2>&1; then
    # shellcheck source=lib/github-release.sh
    source "${root}/scripts/lib/github-release.sh"
    pcu_install_from_source "$root" "${INSTALL_DIR:-$HOME/.local/bin}" >/dev/null
    if [[ -x "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return 0
    fi
  fi

  echo "error: pi-computer-use not found. Run: curl -fsSL https://raw.githubusercontent.com/dhongz/pi-computer-use/main/scripts/install.sh | bash" >&2
  return 1
}

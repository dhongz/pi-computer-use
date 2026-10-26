#!/usr/bin/env bash
# Keep the browser scripts in the same layout used by checkout installations.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="${1:?usage: package-release.sh <version> <binary> <output-dir>}"
BINARY="${2:?binary path required}"
OUTPUT="${3:?output directory required}"
[[ "$VERSION" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([.-][a-zA-Z0-9.-]+)?$ ]] || { echo "Invalid release version" >&2; exit 1; }
[[ -f "$BINARY" ]] || { echo "Binary not found: $BINARY" >&2; exit 1; }
mkdir -p "$OUTPUT"
OUTPUT="$(cd "$OUTPUT" && pwd)"
NAME="pi-computer-use-$VERSION-macos-universal"
DEST="$OUTPUT/$NAME"
[[ ! -e "$DEST" ]] || { echo "Package directory already exists: $DEST" >&2; exit 1; }
mkdir "$DEST"
cp "$BINARY" "$DEST/pi-computer-use"
cd "$ROOT"
cp LICENSE README.md "$DEST/"
cp scripts/install.sh "$DEST/install.sh"
tar --exclude=node_modules --exclude=bridge-config.js -cf - scripts browser extensions skills docs package.json package-lock.json | tar -xf - -C "$DEST"
chmod +x "$DEST/pi-computer-use" "$DEST/install.sh" "$DEST"/scripts/*.sh
(cd "$OUTPUT" && tar -czf "$NAME.tar.gz" "$NAME")
shasum -a 256 "$OUTPUT/$NAME.tar.gz" | awk -v name="$NAME.tar.gz" '{print $1 "  " name}' > "$OUTPUT/$NAME.tar.gz.sha256"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  printf 'tarball=%s/%s.tar.gz\nsha=%s/%s.tar.gz.sha256\n' "$OUTPUT" "$NAME" "$OUTPUT" "$NAME" >> "$GITHUB_OUTPUT"
fi

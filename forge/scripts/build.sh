#!/usr/bin/env bash
# build.sh — assemble _dist/ for static deployment
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
export FORGE_DIR="${FORGE_DIR:-${DIAGRAMS_DIR:-$HOME/.roxabi/forge}}"
DIST="$FORGE_DIR/_dist"

echo "▸ Regenerating manifest.json…"
python3 "$SCRIPT_DIR/gen-manifest.py"

echo "▸ Generating dependency tab from roadmap-deps.json…"
python3 "$SCRIPT_DIR/gen-deps.py"

echo "▸ Generating image gallery manifests…"
python3 "$SCRIPT_DIR/gen-image-manifests.py"

echo "▸ Syncing to _dist/…"
mkdir -p "$DIST"
# -L dereferences symlinks as real files so deployed _dist/ ships actual
# content rather than dangling symlinks. Required for galleries that
# symlink into external directories (e.g. ai-toolkit training output).
rsync -aL --delete --delete-excluded --ignore-errors \
  --exclude='_dist/' \
  --exclude='*.py' \
  --exclude='__pycache__/' \
  --exclude='.git/' \
  --exclude='.stversions/' \
  --exclude='lyra/brand/prompts/' \
  "$FORGE_DIR/" "$DIST/" || {
    RC=$?
    # exit code 23 = partial transfer (e.g. dangling symlinks) — non-fatal
    [ $RC -eq 23 ] && echo "  ⚠ rsync: skipped some files (broken symlinks?) — continuing" || exit $RC
  }

# Copy gallery UI from canonical forge location into _dist
cp "$FORGE_DIR/index.html" "$DIST/index.html"

FILE_COUNT=$(find "$DIST" -type f | wc -l)
SIZE=$(du -sh "$DIST" | cut -f1)
echo "▸ Build ready: $FILE_COUNT files, $SIZE → $DIST"

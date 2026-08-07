#!/usr/bin/env bash
# Shared trufflehog scan — lefthook pre-commit + pre-push.
# Uses SSoT exclude list: scripts/trufflehog-exclude-paths.txt (same file as CI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXCLUDE_SRC="${ROOT}/scripts/trufflehog-exclude-paths.txt"

excl=$(mktemp)
trap 'rm -f "$excl"' EXIT

# Build exclude file: strip comments/blank lines from SSoT (trufflehog expects pure regexes).
if [ -f "$EXCLUDE_SRC" ]; then
  grep -vE '^\s*(#|$)' "$EXCLUDE_SRC" > "$excl" || true
else
  echo 'node_modules' > "$excl"
  echo >&2 "WARN: ${EXCLUDE_SRC} missing — using node_modules only"
fi

if ! command -v trufflehog >/dev/null 2>&1; then
  echo >&2 "ERROR: trufflehog not installed"
  echo >&2 "  brew install trufflehog  |  https://github.com/trufflesecurity/trufflehog/releases"
  exit 1
fi

# Worktree (.git is a file) → filesystem scan; plain clone → git history scan.
# Always pass the same exclude list (local ≡ CI policy).
if [ -f .git ] && grep -q '^gitdir:' .git; then
  trufflehog filesystem . --only-verified --fail --exclude-paths="$excl"
else
  trufflehog git file://. --only-verified --fail --exclude-paths="$excl"
fi

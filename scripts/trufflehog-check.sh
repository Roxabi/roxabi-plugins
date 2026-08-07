#!/usr/bin/env bash
# Primary secret gate (before GitHub): lefthook pre-commit + pre-push.
# CI re-runs as secondary filet (see .github/workflows/secret-scan.yml).
#
# Scope (not full history):
#   1) Commits not yet on origin base (origin/staging|main|master) — pre-push
#   2) Staged files — pre-commit (and pre-push if anything still staged)
#
# Exclude SSoT: scripts/trufflehog-exclude-paths.txt (same policy as CI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

EXCLUDE_SRC="${ROOT}/scripts/trufflehog-exclude-paths.txt"
excl=$(mktemp)
staged_list=$(mktemp)
trap 'rm -f "$excl" "$staged_list"' EXIT

if [ -f "$EXCLUDE_SRC" ]; then
  grep -vE '^\s*(#|$)' "$EXCLUDE_SRC" > "$excl" || true
else
  printf '%s\n' 'node_modules' '\.venv' > "$excl"
  echo >&2 "WARN: ${EXCLUDE_SRC} missing — minimal excludes only"
fi

if ! command -v trufflehog >/dev/null 2>&1; then
  echo >&2 "ERROR: trufflehog not installed"
  echo >&2 "  brew install trufflehog  |  https://github.com/trufflesecurity/trufflehog/releases"
  exit 1
fi

# First existing remote/local base (prefer remote tracking).
detect_base_ref() {
  local c
  for c in origin/staging origin/main origin/master staging main master; do
    if git rev-parse --verify --quiet "$c" >/dev/null 2>&1; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

failed=0
scanned=0

# ── 1) Unpushed / unmerged commits vs base ──────────────────────────────────
if base_ref="$(detect_base_ref)"; then
  base_sha="$(git rev-parse "$base_ref")"
  head_sha="$(git rev-parse HEAD)"
  if [ "$base_sha" != "$head_sha" ]; then
    since_sha="$(git merge-base HEAD "$base_ref" 2>/dev/null || printf '%s' "$base_sha")"
    ahead="$(git rev-list --count "${since_sha}..HEAD" 2>/dev/null || echo 0)"
    if [ "${ahead:-0}" -gt 0 ]; then
      echo "trufflehog: scanning ${ahead} commit(s) after ${base_ref} (${since_sha:0:7}..HEAD)"
      scanned=1
      if ! trufflehog git "file://${ROOT}" \
        --since-commit="$since_sha" \
        --only-verified \
        --fail \
        --exclude-paths="$excl"; then
        failed=1
      fi
    fi
  fi
else
  echo >&2 "trufflehog: no base ref (origin/main|staging|…) — skip commit-range scan"
fi

# ── 2) Staged files (about to be committed) ─────────────────────────────────
git diff --cached --name-only --diff-filter=ACMR -z 2>/dev/null \
  | tr '\0' '\n' \
  | while IFS= read -r f; do
      [ -n "$f" ] && [ -f "$f" ] && printf '%s\n' "$f"
    done > "$staged_list" || true

if [ -s "$staged_list" ]; then
  # bash 3.2-compatible (macOS /bin/bash) — avoid mapfile
  staged_files=()
  while IFS= read -r f; do
    [ -n "$f" ] && staged_files+=("$f")
  done < "$staged_list"
  echo "trufflehog: scanning ${#staged_files[@]} staged file(s)"
  scanned=1
  if ! trufflehog filesystem \
    --only-verified \
    --fail \
    --exclude-paths="$excl" \
    "${staged_files[@]}"; then
    failed=1
  fi
fi

if [ "$scanned" -eq 0 ]; then
  echo "trufflehog: nothing in range (on base, no staged files) — ok"
  exit 0
fi

if [ "$failed" -ne 0 ]; then
  echo >&2 "trufflehog: verified secret(s) found — fix before commit/push (CI is too late)"
  exit 183
fi

exit 0

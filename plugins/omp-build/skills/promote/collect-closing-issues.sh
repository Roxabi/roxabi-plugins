#!/usr/bin/env bash
# collect-closing-issues.sh — list issue numbers to re-emit as Closes #N on a promote PR.
#
# Sources (union):
#   1. Closing keywords in commit messages origin/BASE..origin/HEAD
#   2. Bodies of PRs merged into HEAD whose merge commit is in that range
#      (via `gh pr list` — works for squash/rebase, not only "Merge pull request #N")
#
# Extract/format SSOT: lib/closing-issues.ts via closing-issues-cli.ts (bun).
# Open-issue filter: when `gh` works, drop numbers that are already closed.
#
# Usage:
#   bash collect-closing-issues.sh [BASE] [HEAD]
#   bash collect-closing-issues.sh --section
#   bash collect-closing-issues.sh main staging --section
#   bash collect-closing-issues.sh main staging --json
#
# Exit 0 when git works (empty list is success). Exit 1 on git ref failure.
# Exit 2 on unknown flags. WARN on stderr when gh degrades (partial harvest).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="main"
HEAD="staging"
MODE="list" # list | section | json
ARGS=()
for a in "$@"; do
  case "$a" in
    --section) MODE=section ;;
    --json) MODE=json ;;
    --list) MODE=list ;;
    -*)
      echo "error: unknown flag: $a" >&2
      exit 2
      ;;
    *) ARGS+=("$a") ;;
  esac
done
BASE="${ARGS[0]:-$BASE}"
HEAD="${ARGS[1]:-$HEAD}"

ref() {
  local b="$1"
  if git rev-parse --verify "origin/$b" >/dev/null 2>&1; then
    echo "origin/$b"
  else
    echo "$b"
  fi
}

BASE_REF="$(ref "$BASE")"
HEAD_REF="$(ref "$HEAD")"

if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "error: unknown base ref $BASE_REF" >&2
  exit 1
fi
if ! git rev-parse --verify "$HEAD_REF" >/dev/null 2>&1; then
  echo "error: unknown head ref $HEAD_REF" >&2
  exit 1
fi

RANGE="${BASE_REF}..${HEAD_REF}"
TEXTS_FILE="$(mktemp)"
RANGE_SHAS="$(mktemp)"
trap 'rm -f "$TEXTS_FILE" "$RANGE_SHAS"' EXIT

git rev-list "$RANGE" 2>/dev/null >"$RANGE_SHAS" || true

# 1) Commit messages in range
if ! git log "$RANGE" --format='%B%n---' >>"$TEXTS_FILE" 2>/dev/null; then
  echo "warn: git log $RANGE failed — commit texts skipped" >&2
fi

GH_DEGRADED=0
PR_BODY_HITS=0

in_range() {
  local oid="$1"
  [ -n "$oid" ] && grep -qxF "$oid" "$RANGE_SHAS" 2>/dev/null
}

append_pr_body() {
  local pr="$1"
  local body
  body="$(gh pr view "$pr" --json body --jq '.body // empty' 2>/dev/null)" || {
    GH_DEGRADED=1
    echo "warn: gh pr view #$pr failed" >&2
    return 0
  }
  if [ -n "$body" ]; then
    printf '%s\n---\n' "$body" >>"$TEXTS_FILE"
    PR_BODY_HITS=$((PR_BODY_HITS + 1))
  fi
}

# 2) PR bodies via API (squash-safe)
if command -v gh >/dev/null 2>&1; then
  PR_META="$(gh pr list --base "$HEAD" --state merged --limit 200 \
    --json number,mergeCommit 2>/dev/null)" || PR_META=""
  if [ -z "$PR_META" ]; then
    GH_DEGRADED=1
    echo "warn: gh pr list failed — trying merge-commit subject fallback" >&2
  else
    PR_COUNT=$(printf '%s' "$PR_META" | jq 'length' 2>/dev/null || echo 0)
    if [ "$PR_COUNT" = "200" ]; then
      echo "warn: gh pr list hit --limit 200 — may under-harvest; paginate if needed" >&2
      GH_DEGRADED=1
    fi
    while IFS=$'\t' read -r pr oid; do
      [ -z "$pr" ] && continue
      in_range "$oid" || continue
      append_pr_body "$pr"
    done < <(printf '%s' "$PR_META" | jq -r '
      .[]
      | select(.mergeCommit != null and .mergeCommit.oid != null)
      | "\(.number)\t\(.mergeCommit.oid)"
      ' 2>/dev/null || true)
  fi

  # Fallback: classic merge subjects
  if [ "$PR_BODY_HITS" -eq 0 ]; then
    PR_NUMS=$(
      git log "$RANGE" --merges --pretty=format:'%s' 2>/dev/null \
        | sed -n 's/^Merge pull request #\([0-9][0-9]*\).*/\1/p' \
        | sort -n -u \
        || true
    )
    if [ -n "$PR_NUMS" ]; then
      while IFS= read -r pr; do
        [ -z "$pr" ] && continue
        append_pr_body "$pr"
      done <<<"$PR_NUMS"
    fi
  fi
else
  GH_DEGRADED=1
  echo "warn: gh not installed — PR bodies not harvested (commit messages only)" >&2
fi

CLI="$SCRIPT_DIR/lib/closing-issues-cli.ts"
if ! command -v bun >/dev/null 2>&1; then
  echo "error: bun required to run closing-issues-cli.ts (SSOT extract)" >&2
  exit 1
fi

RAW_ISSUES="$(bun run "$CLI" --list <"$TEXTS_FILE")"

# Keep only OPEN issues when gh can resolve state (skip already closed)
ISSUES=""
if [ -n "$RAW_ISSUES" ] && command -v gh >/dev/null 2>&1; then
  while IFS= read -r n; do
    [ -z "$n" ] && continue
    st="$(gh issue view "$n" --json state --jq '.state' 2>/dev/null || echo "")"
    if [ -z "$st" ]; then
      echo "warn: could not resolve issue #$n state — keeping for re-emit" >&2
      ISSUES="${ISSUES}${n}"$'\n'
      GH_DEGRADED=1
    elif [ "$st" = "OPEN" ]; then
      ISSUES="${ISSUES}${n}"$'\n'
    fi
  done <<<"$RAW_ISSUES"
  ISSUES="$(printf '%s' "$ISSUES" | sed '/^$/d')"
else
  ISSUES="$RAW_ISSUES"
fi

if [ "$GH_DEGRADED" -eq 1 ]; then
  echo "warn: partial harvest (gh degraded) — review Closes list before merge" >&2
  echo "warn: exit 3 (degraded) — agents must not ignore stderr" >&2
fi

case "$MODE" in
  json)
    if [ -z "$ISSUES" ]; then
      echo '{"issues":[]}'
    else
      printf '%s\n' "$ISSUES" | awk '{print "Closes #" $1}' | bun run "$CLI" --json
    fi
    ;;
  section)
    if [ -z "$ISSUES" ]; then
      [ "$GH_DEGRADED" -eq 1 ] && exit 3
      exit 0
    fi
    if [ "$GH_DEGRADED" -eq 1 ]; then
      echo "<!-- promote-closes:degraded -->"
    fi
    printf '%s\n' "$ISSUES" | awk '{print "Closes #" $1}' | bun run "$CLI" --section
    ;;
  list|*)
    if [ -n "$ISSUES" ]; then
      printf '%s\n' "$ISSUES"
    fi
    ;;
esac

# Non-zero when harvest integrity is partial so $(...) callers can detect degrade.
[ "$GH_DEGRADED" -eq 1 ] && exit 3
exit 0

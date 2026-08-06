#!/usr/bin/env bash
# collect-closing-issues.sh — list issue numbers to re-emit as Closes #N on a promote PR.
#
# Sources (union):
#   1. Closing keywords in commit messages origin/BASE..origin/HEAD
#   2. Closing keywords in bodies of PRs whose merge commits appear in that range
#
# Usage:
#   bash collect-closing-issues.sh [BASE] [HEAD]
#   bash collect-closing-issues.sh main staging --section   # markdown section
#   bash collect-closing-issues.sh main staging --json      # {"issues":[...]}
#
# Exit 0 always when git works (empty list is success). Exit 1 on git failure.
set -euo pipefail

BASE="${1:-main}"
HEAD="${2:-staging}"
MODE="list" # list | section | json
for a in "${@:3}"; do
  case "$a" in
    --section) MODE=section ;;
    --json) MODE=json ;;
    --list) MODE=list ;;
  esac
done

# Prefer origin/ when present (promote runs after fetch).
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

# Pure keyword extract (mirrors lib/closing-issues.ts)
extract_kw() {
  # shellcheck disable=SC2001
  grep -oE '\b([Cc]lose[sd]?|[Ff]ix(e[sd])?|[Rr]esolve[sd]?)\s+#[0-9]+' \
    | grep -oE '#[0-9]+' \
    | tr -d '#' \
    || true
}

TEXTS_FILE="$(mktemp)"
trap 'rm -f "$TEXTS_FILE"' EXIT

# 1) Commit messages in range
git log "$RANGE" --format='%B%n---' 2>/dev/null >>"$TEXTS_FILE" || true

# 2) Bodies of merge PRs in range
PR_NUMS=$(
  git log "$RANGE" --merges --pretty=format:'%s' 2>/dev/null \
    | sed -n 's/^Merge pull request #\([0-9][0-9]*\).*/\1/p' \
    | sort -n -u \
    || true
)

if [ -n "$PR_NUMS" ] && command -v gh >/dev/null 2>&1; then
  while IFS= read -r pr; do
    [ -z "$pr" ] && continue
    body="$(gh pr view "$pr" --json body --jq '.body // empty' 2>/dev/null || true)"
    if [ -n "$body" ]; then
      printf '%s\n---\n' "$body" >>"$TEXTS_FILE"
    fi
  done <<<"$PR_NUMS"
fi

ISSUES=$(
  extract_kw <"$TEXTS_FILE" \
    | sort -n -u \
    | grep -E '^[1-9][0-9]*$' \
    || true
)

case "$MODE" in
  json)
    # Build JSON array without jq dependency for empty case
    if [ -z "$ISSUES" ]; then
      echo '{"issues":[]}'
    else
      arr=$(echo "$ISSUES" | paste -sd, -)
      echo "{\"issues\":[$arr]}"
    fi
    ;;
  section)
    if [ -z "$ISSUES" ]; then
      exit 0
    fi
    echo "## Issues closed by this promote"
    echo ""
    echo "Re-emitted from feature PR / commit closing keywords. GitHub auto-closes"
    echo "these when this PR merges into the default branch (\`main\`):"
    echo ""
    while IFS= read -r n; do
      [ -n "$n" ] && echo "Closes #$n"
    done <<<"$ISSUES"
    echo ""
    ;;
  list|*)
    echo "$ISSUES"
    ;;
esac

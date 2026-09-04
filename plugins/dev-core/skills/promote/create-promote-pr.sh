#!/usr/bin/env bash
# create-promote-pr.sh — forced promote PR path for /R-promote Step 7.
#
# Always harvests closing issues and injects them into the PR body.
# Cannot be skipped by forgetting CLOSES_SECTION in free-form `gh pr create`.
#
# Usage:
#   bash create-promote-pr.sh \
#     --title "chore: promote staging to main (v1.2.3)" \
#     --body-file /tmp/promote-body.md \
#     [--base main] [--head staging] \
#     [--allow-degraded] [--dry-run]
#
# --body-file: markdown WITHOUT the Closes section (wrapper appends it).
# Exit 0 + prints PR URL. Exit 1 REFUSE (degraded without flag, missing args, gh fail).
# Exit 2 bad flags.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="main"
HEAD="staging"
TITLE=""
BODY_FILE=""
ALLOW_DEGRADED=0
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
    --allow-degraded) ALLOW_DEGRADED=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    -*)
      echo "error: unknown flag: $1" >&2
      exit 2
      ;;
    *)
      echo "error: unexpected arg: $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$TITLE" ]; then
  echo "REFUSE: --title required" >&2
  exit 1
fi
if [ -z "$BODY_FILE" ] || [ ! -f "$BODY_FILE" ]; then
  echo "REFUSE: --body-file required and must exist" >&2
  exit 1
fi
if ! command -v gh >/dev/null 2>&1; then
  echo "REFUSE: gh CLI required" >&2
  exit 1
fi

COLLECT="$SCRIPT_DIR/collect-closing-issues.sh"
if [ ! -x "$COLLECT" ] && [ ! -f "$COLLECT" ]; then
  echo "REFUSE: collect-closing-issues.sh missing at $COLLECT" >&2
  exit 1
fi

ERR_FILE="$(mktemp)"
OUT_BODY=""
trap 'rm -f "$ERR_FILE"; [ -n "$OUT_BODY" ] && rm -f "$OUT_BODY"' EXIT

# Harvest Closes (exit 3 = degraded)
set +e
CLOSES_SECTION="$(bash "$COLLECT" "$BASE" "$HEAD" --section 2>"$ERR_FILE")"
RC=$?
set -e
if [ -s "$ERR_FILE" ]; then
  cat "$ERR_FILE" >&2
fi

if [ "$RC" -eq 3 ]; then
  if [ "$ALLOW_DEGRADED" -ne 1 ]; then
    echo "REFUSE: closing-issues harvest degraded (exit 3)." >&2
    echo "  Review stderr WARNs, then re-run with --allow-degraded if the list is still OK." >&2
    exit 1
  fi
  echo "WARN: proceeding with --allow-degraded after partial harvest" >&2
elif [ "$RC" -ne 0 ]; then
  echo "REFUSE: collect-closing-issues.sh failed (rc=$RC)" >&2
  exit 1
fi

BASE_BODY="$(cat "$BODY_FILE")"
# Strip trailing whitespace-only lines for clean join
BASE_BODY="$(printf '%s' "$BASE_BODY" | sed -e :a -e '/^\n*$/{$d;N;ba' -e '}')"

if [ -n "$CLOSES_SECTION" ]; then
  FULL_BODY="$(printf '%s\n\n%s' "$BASE_BODY" "$CLOSES_SECTION")"
else
  FULL_BODY="$BASE_BODY"
  echo "info: no open closing-keyword issues in $BASE..$HEAD — body without Closes section" >&2
fi

OUT_BODY="$(mktemp)"
printf '%s\n' "$FULL_BODY" >"$OUT_BODY"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: would create/update PR $HEAD → $BASE"
  echo "title: $TITLE"
  echo "--- body ---"
  cat "$OUT_BODY"
  echo "--- end ---"
  exit 0
fi

EXISTING="$(gh pr list --base "$BASE" --head "$HEAD" --state open \
  --json number --jq '.[0].number // empty' 2>/dev/null || true)"

if [ -n "$EXISTING" ]; then
  gh pr edit "$EXISTING" --title "$TITLE" --body-file "$OUT_BODY" >/dev/null
  URL="$(gh pr view "$EXISTING" --json url --jq .url)"
  echo "updated existing promote PR #$EXISTING" >&2
else
  URL="$(gh pr create --base "$BASE" --head "$HEAD" --title "$TITLE" --body-file "$OUT_BODY")"
fi

printf '%s\n' "$URL"

#!/usr/bin/env bash
# create-promote-pr.sh — forced promote PR path for /promote Step 7.
#
# Publishes the summary body after replacing a closing keyword that is
# followed by an issue or pull reference with `References`.
# Does not harvest issues and does not append a closing keyword.
# A remaining #N is text, not a workflow binding.
#
# Usage:
#   bash create-promote-pr.sh \
#     --title "chore: promote staging to main (v1.2.3)" \
#     --body-file /tmp/promote-body.md \
#     [--base main] [--head staging] \
#     [--dry-run]
#
# --body-file: promotion summary. The wrapper replaces that keyword only.
# Exit 0 + prints PR URL. Exit 1 REFUSE (missing args, renderer, or gh fail).
# Exit 2 bad flags. --dry-run prints the rendered body and does not call gh.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="$SCRIPT_DIR/../feature/generated-pr-body.js"
BASE="main"
HEAD="staging"
TITLE=""
BODY_FILE=""
DRY_RUN=0

while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --head) HEAD="${2:-}"; shift 2 ;;
    --title) TITLE="${2:-}"; shift 2 ;;
    --body-file) BODY_FILE="${2:-}"; shift 2 ;;
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
if [ ! -f "$RENDER" ]; then
  echo "REFUSE: generated body renderer missing at $RENDER" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1; then
  echo "REFUSE: bun required to render the promotion body" >&2
  exit 1
fi

OUT_BODY="$(mktemp)"
trap 'rm -f "$OUT_BODY"' EXIT
bun "$RENDER" "$BODY_FILE" >"$OUT_BODY"

if [ "$DRY_RUN" -eq 1 ]; then
  echo "DRY-RUN: would create/update PR $HEAD → $BASE"
  echo "title: $TITLE"
  echo "--- body ---"
  cat "$OUT_BODY"
  echo "--- end ---"
  exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "REFUSE: gh CLI required" >&2
  exit 1
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

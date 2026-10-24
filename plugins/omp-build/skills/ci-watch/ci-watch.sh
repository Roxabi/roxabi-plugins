#!/usr/bin/env bash
EXIT_FAIL=1
EXIT_CANCELLED=2
EXIT_OTHER=3
EXIT_UNMERGED=4
EXIT_DEADLINE=5
EXIT_EVALUATE_ONLY=6
EXIT_BEHIND=7
EXIT_INTERNAL=70
set -Eeuo pipefail
trap 'exit "$EXIT_INTERNAL"' ERR
REQUIRED=""
SCRIPT_SOURCE="${BASH_SOURCE[0]}"
if [[ "$SCRIPT_SOURCE" == */* ]]; then SCRIPT_DIR="${SCRIPT_SOURCE%/*}"; else SCRIPT_DIR=.; fi
SCRIPT_DIR="$(cd -P "$SCRIPT_DIR" && pwd -P)"
while [[ -L "$SCRIPT_SOURCE" ]]; do
  SCRIPT_SOURCE="$(readlink "$SCRIPT_SOURCE")"
  [[ "$SCRIPT_SOURCE" == /* ]] || SCRIPT_SOURCE="$SCRIPT_DIR/$SCRIPT_SOURCE"
  if [[ "$SCRIPT_SOURCE" == */* ]]; then SCRIPT_DIR="${SCRIPT_SOURCE%/*}"; else SCRIPT_DIR=.; fi
  SCRIPT_DIR="$(cd -P "$SCRIPT_DIR" && pwd -P)"
done
# These helpers are internal and must be sourced through this real executable path.
. "$SCRIPT_DIR/ci-watch-input.sh"
. "$SCRIPT_DIR/ci-watch-poll.sh"
if [[ "${1:-}" == --checks-of ]]; then checks_of "$(cat)"; exit 0; fi
if [[ "${1:-}" == --classify-merge-state ]]; then shift; classify_merge_state "$@"; exit 0; fi
if [[ "${1:-}" == --classify-checks ]]; then classify_checks; exit 0; fi
for cmd in gh jq bun; do command -v "$cmd" >/dev/null 2>&1 || { echo "Error: '$cmd' is required but not found on PATH." >&2; exit "$EXIT_INTERNAL"; }; done
parse_watch_arguments "$@"
resolve_landing
START=$SECONDS
watch_checks
watch_merge

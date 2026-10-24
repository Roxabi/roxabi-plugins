#!/usr/bin/env bash

is_behind() { [[ "$1" == OPEN && "$2" == BEHIND ]]; }
classify_merge_state() {
  local state="$1" status="$2" mode="$3" eligible="$4" elapsed="$5" timeout="$6"
  if [[ "$state" == MERGED ]]; then echo 0; return; fi
  if [[ "$state" == CLOSED ]]; then echo "$EXIT_UNMERGED"; return; fi
  if is_behind "$state" "$status"; then echo "$EXIT_BEHIND"; return; fi
  if (( elapsed >= timeout )); then echo "$EXIT_DEADLINE"; return; fi
  if [[ "$mode" == merge-on-green && "$eligible" != true ]]; then echo "$EXIT_UNMERGED"; return; fi
  if [[ "$mode" == native && "$eligible" != true ]]; then echo 0; return; fi
  case "$status" in DIRTY) echo "$EXIT_UNMERGED" ;; *) echo WATCH ;; esac
}
classify_checks() {
  jq -r 'def norm: ascii_downcase; def conc: (.conclusion // "" | norm); def passing: conc == "success" or conc == "skipped" or conc == "neutral"; def failing: conc == "failure" or conc == "timed_out" or conc == "startup_failure"; if length == 0 then "PENDING" elif any(failing) then "FAIL" elif any(conc == "cancelled") then "CANCEL" elif any((.status // "" | norm) != "completed") then "PENDING" elif all(passing) then "GREEN" else "OTHER" end'
}
normalise_rollup() {
  jq 'def started: (.startedAt // .started_at // ""); [.statusCheckRollup[]? | if .status != null then {name:(.name // .context // "unknown"),workflow:(.workflowName // ""),status:.status,conclusion:(.conclusion // ""),started:started} else (.state // "" | ascii_downcase) as $s | {name:(.name // .context // "unknown"),workflow:(.workflowName // ""),status:(if ($s == "pending" or $s == "expected") then "in_progress" else "completed" end),conclusion:(if $s == "success" then "success" elif ($s == "pending" or $s == "expected") then "" elif ($s == "failure" or $s == "error") then "failure" else (.state // "") end),started:started} end] | group_by([.workflow,.name]) | map(sort_by([(if ((.status // "") | ascii_downcase) == "completed" then 0 else 1 end),.started]) | last | {name,status,conclusion})'
}
filter_required() {
  if [[ -z "$REQUIRED" ]]; then cat; return; fi
  jq --arg names "$REQUIRED" '($names | split("\n") | map(select(length > 0))) as $want | if ($want | length) == 0 then . else map(select(.name as $n | $want | index($n))) end'
}
checks_of() { echo "$1" | normalise_rollup | filter_required; }
parse_duration() {
  local raw="$1"
  if [[ "$raw" =~ ^([0-9]+)s$ ]]; then
    echo $((10#${BASH_REMATCH[1]}))
  elif [[ "$raw" =~ ^([0-9]+)m$ ]]; then
    echo $((10#${BASH_REMATCH[1]} * 60))
  elif [[ "$raw" =~ ^([0-9]+)$ ]]; then
    echo $((10#${BASH_REMATCH[1]}))
  else
    echo "Error: --timeout '$raw' is not <n>s, <n>m, or seconds." >&2
    exit "$EXIT_INTERNAL"
  fi
}
need_value() { [[ $# -ge 2 ]] || { echo "Error: $1 needs a value" >&2; exit "$EXIT_INTERNAL"; }; }
parse_watch_arguments() {
  PR=""; REPO=""; TIMEOUT_RAW=30m; INTERVAL=15; MERGE_MODE=""; BASE_REF=""; SINCE=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --timeout) need_value "$@"; TIMEOUT_RAW="$2"; shift 2 ;;
      --interval) need_value "$@"; INTERVAL="$2"; shift 2 ;;
      --merge-mode) need_value "$@"; MERGE_MODE="$2"; shift 2 ;;
      --base) need_value "$@"; BASE_REF="$2"; shift 2 ;;
      --repo) need_value "$@"; REPO="$2"; shift 2 ;;
      --since) need_value "$@"; SINCE="$2"; shift 2 ;;
      --) shift; break ;;
      -*) echo "Error: unknown flag $1" >&2; exit "$EXIT_INTERNAL" ;;
      *) PR="$1"; shift ;;
    esac
  done
  [[ -n "$PR" ]] || { echo "Usage: ci-watch.sh <pr> [--timeout 30m] [--merge-mode merge-on-green|native] [--base <branch>] [--since <UTC time>] [--repo owner/repo]" >&2; exit "$EXIT_INTERNAL"; }
  [[ -z "$SINCE" || "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] || { echo "Error: --since '$SINCE' is not a UTC time, YYYY-MM-DDTHH:MM:SSZ" >&2; exit "$EXIT_INTERNAL"; }
}
resolve_landing() {
  [[ -n "$REPO" ]] || REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
  TIMEOUT=$(parse_duration "$TIMEOUT_RAW")
  LANDING_JS="$SCRIPT_DIR/../feature/workflow-readiness.js"
  [[ -f "$LANDING_JS" ]] || { echo "ci-watch: run this script from its real path (realpath skill://ci-watch/ci-watch.sh) — cannot find ../feature/workflow-readiness.js" >&2; exit "$EXIT_INTERNAL"; }
  [[ -n "$BASE_REF" ]] || BASE_REF=$(gh pr view "$PR" --repo "$REPO" --json baseRefName --jq .baseRefName)
  [[ -n "$BASE_REF" && "$BASE_REF" != null ]] || { echo "Error: could not read baseRefName for PR $PR (pass --base <branch>)" >&2; exit "$EXIT_INTERNAL"; }
  LANDING=$(bun -e 'const { readLanding } = await import(process.argv[1]); try { const landing = readLanding(process.cwd(), { base: process.argv[2] }); console.log([landing.mode, ...landing.required_checks].join("\n")) } catch (error) { console.error(`Error: ${error instanceof Error ? error.message : error}`); process.exit(1) }' "$LANDING_JS" "$BASE_REF")
  [[ -n "$MERGE_MODE" ]] || MERGE_MODE="${LANDING%%$'\n'*}"
  [[ "$MERGE_MODE" == merge-on-green || "$MERGE_MODE" == native ]] || { echo "Error: --merge-mode must be merge-on-green or native, got $MERGE_MODE" >&2; exit "$EXIT_INTERNAL"; }
  REQUIRED=""
  if [[ "$LANDING" == *$'\n'* ]]; then
    REQUIRED="${LANDING#*$'\n'}"
  fi
}

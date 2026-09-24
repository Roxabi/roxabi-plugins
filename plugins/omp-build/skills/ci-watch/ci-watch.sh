#!/usr/bin/env bash
# ci-watch.sh — watch every check on a PR head, then the merge.
# Deadline is owned here. Invoke from OMP with async: true and timeout: 0.
#
# Exit codes:
#   0  merged, or nothing to watch
#   1  a check failed (failed-job logs printed)
#   2  cancelled
#   3  another conclusion (including a skipped required check)
#   4  green but unmerged (label revoked, closed, dirty)
#   5  deadline — undetermined, re-run to resume
set -euo pipefail

EXIT_FAIL=1
EXIT_CANCELLED=2
EXIT_OTHER=3
EXIT_UNMERGED=4
EXIT_DEADLINE=5

# Pure. (state, mergeStateStatus, mode, eligible, elapsed, timeout) → exit code or WATCH.
# eligible=true means the PR is in the merge path: reviewed label (merge-on-green)
# or autoMergeRequest set (native).
classify_merge_state() {
  local state="$1" mss="$2" mode="$3" eligible="$4" elapsed="$5" timeout="$6"
  if [[ "$state" == "MERGED" ]]; then
    echo 0
    return 0
  fi
  if [[ "$state" == "CLOSED" ]]; then
    echo "$EXIT_UNMERGED"
    return 0
  fi
  if (( elapsed >= timeout )); then
    echo "$EXIT_DEADLINE"
    return 0
  fi
  if [[ "$mode" == "merge-on-green" && "$eligible" != "true" ]]; then
    echo "$EXIT_UNMERGED"
    return 0
  fi
  if [[ "$mode" == "native" && "$eligible" != "true" ]]; then
    echo 0
    return 0
  fi
  case "$mss" in
    DIRTY) echo "$EXIT_UNMERGED" ;;
    BEHIND | BLOCKED | UNSTABLE | "") echo WATCH ;;
    *) echo WATCH ;;
  esac
}

# Pure. JSON array of {name,status,conclusion} on stdin → GREEN|FAIL|CANCEL|SKIP|PENDING|OTHER.
classify_checks() {
  jq -r '
    if length == 0 then "PENDING"
    elif any(.conclusion == "failure" or .conclusion == "timed_out" or .conclusion == "startup_failure") then "FAIL"
    elif any(.conclusion == "cancelled") then "CANCEL"
    elif any(.conclusion == "skipped") then "SKIP"
    elif any(.status != "completed") then "PENDING"
    elif all(.conclusion == "success") then "GREEN"
    else "OTHER"
    end
  '
}

if [[ "${1:-}" == "--classify-merge-state" ]]; then
  shift
  classify_merge_state "$@"
  exit 0
fi

if [[ "${1:-}" == "--classify-checks" ]]; then
  classify_checks
  exit 0
fi

for cmd in gh jq bun; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Error: '$cmd' is required but not found on PATH." >&2
    exit "$EXIT_FAIL"
  fi
done

parse_duration() {
  local raw="$1"
  if [[ "$raw" =~ ^([0-9]+)s$ ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ "$raw" =~ ^([0-9]+)m$ ]]; then
    echo $((${BASH_REMATCH[1]} * 60))
  elif [[ "$raw" =~ ^([0-9]+)$ ]]; then
    echo "$raw"
  else
    echo "Error: --timeout '$raw' is not <n>s, <n>m, or seconds." >&2
    exit "$EXIT_FAIL"
  fi
}

PR=""
REPO=""
TIMEOUT_RAW="30m"
INTERVAL=15
MERGE_MODE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --timeout)
      TIMEOUT_RAW="$2"
      shift 2
      ;;
    --interval)
      INTERVAL="$2"
      shift 2
      ;;
    --merge-mode)
      MERGE_MODE="$2"
      shift 2
      ;;
    --repo)
      REPO="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Error: unknown flag $1" >&2
      exit "$EXIT_FAIL"
      ;;
    *)
      PR="$1"
      shift
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Usage: ci-watch.sh <pr> [--timeout 30m] [--merge-mode merge-on-green|native] [--repo owner/repo]" >&2
  exit "$EXIT_FAIL"
fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

TIMEOUT=$(parse_duration "$TIMEOUT_RAW")

if [[ -z "$MERGE_MODE" && -f .dev/stack.yml ]]; then
  MERGE_MODE=$(bun -e 'const t=await Bun.file(".dev/stack.yml").text(); const d=Bun.YAML.parse(t); console.log(d?.landing?.mode ?? "")')
fi
if [[ -z "$MERGE_MODE" ]]; then
  MERGE_MODE="native"
fi
if [[ "$MERGE_MODE" != "merge-on-green" && "$MERGE_MODE" != "native" ]]; then
  echo "Error: --merge-mode must be merge-on-green or native, got $MERGE_MODE" >&2
  exit "$EXIT_FAIL"
fi

REQUIRED=""
if [[ -f .dev/stack.yml ]]; then
  REQUIRED=$(bun -e 'const t=await Bun.file(".dev/stack.yml").text(); const d=Bun.YAML.parse(t); const c=d?.landing?.required_checks; if (Array.isArray(c)) console.log(c.join("\n"))')
fi

filter_required() {
  if [[ -z "$REQUIRED" ]]; then
    cat
    return 0
  fi
  jq --arg names "$REQUIRED" '
    ($names | split("\n") | map(select(length > 0))) as $want |
    if ($want | length) == 0 then . else map(select(.name as $n | $want | index($n))) end
  '
}

pr_json() {
  gh pr view "$PR" --repo "$REPO" --json state,mergeStateStatus,autoMergeRequest,labels,headRefOid,statusCheckRollup
}

eligible_of() {
  local mode="$1" json="$2"
  if [[ "$mode" == "merge-on-green" ]]; then
    echo "$json" | jq -r 'any(.labels[]?; .name == "reviewed")'
  else
    echo "$json" | jq -r '.autoMergeRequest != null'
  fi
}

checks_of() {
  echo "$1" | jq '
    [.statusCheckRollup[]? | {
      name: (.name // .context // "unknown"),
      status: (.status // "completed"),
      conclusion: (.conclusion // "")
    }]
  ' | filter_required
}

dump_failed_logs() {
  local sha="$1"
  gh run list --repo "$REPO" --commit "$sha" --json databaseId,conclusion --jq '.[] | select(.conclusion=="failure") | .databaseId' |
    while read -r id; do
      [[ -z "$id" ]] && continue
      echo "----- failed run $id -----"
      gh run view "$id" --repo "$REPO" --log-failed || true
    done
}

START=$SECONDS
CONFIRMED_GREEN=0

while true; do
  elapsed=$((SECONDS - START))
  if (( elapsed >= TIMEOUT )); then
    echo "undetermined, re-run to resume" >&2
    exit "$EXIT_DEADLINE"
  fi
  snapshot=$(pr_json)
  state=$(echo "$snapshot" | jq -r .state)
  if [[ "$state" == "MERGED" ]]; then
    echo "merged"
    exit 0
  fi
  checks=$(checks_of "$snapshot")
  verdict=$(echo "$checks" | classify_checks)
  case "$verdict" in
    FAIL)
      dump_failed_logs "$(echo "$snapshot" | jq -r .headRefOid)"
      exit "$EXIT_FAIL"
      ;;
    CANCEL) exit "$EXIT_CANCELLED" ;;
    SKIP | OTHER) exit "$EXIT_OTHER" ;;
    PENDING)
      CONFIRMED_GREEN=0
      sleep "$INTERVAL"
      ;;
    GREEN)
      if [[ "$CONFIRMED_GREEN" -eq 0 ]]; then
        CONFIRMED_GREEN=1
        sleep "$INTERVAL"
        continue
      fi
      break
      ;;
  esac
done

while true; do
  elapsed=$((SECONDS - START))
  snapshot=$(pr_json)
  state=$(echo "$snapshot" | jq -r .state)
  mss=$(echo "$snapshot" | jq -r .mergeStateStatus)
  eligible=$(eligible_of "$MERGE_MODE" "$snapshot")
  code=$(classify_merge_state "$state" "$mss" "$MERGE_MODE" "$eligible" "$elapsed" "$TIMEOUT")
  if [[ "$code" == "WATCH" ]]; then
    sleep "$INTERVAL"
    continue
  fi
  if [[ "$code" == "$EXIT_DEADLINE" ]]; then
    echo "undetermined, re-run to resume" >&2
  fi
  exit "$code"
done

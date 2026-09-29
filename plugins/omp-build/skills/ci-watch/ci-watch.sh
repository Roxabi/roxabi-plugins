#!/usr/bin/env bash
# ci-watch.sh — watch every check on a PR head, then the merge.
# Deadline is owned here. Invoke from OMP with async: true and timeout: 0.
#
# Exit codes:
#   0  merged, or nothing to watch
#   1  a check failed (failed-job logs printed) — only the FAIL verdict
#   2  cancelled
#   3  another conclusion (skipped and neutral are passing, declared list or not)
#   4  green but unmerged (label revoked, closed, dirty)
#   5  deadline — undetermined, re-run to resume
#   6  evaluate-only — merge-on-green: the newest merge-on-green run (since --since, or the latest without it) says kit-ci is not configured
#   70 not a check verdict (usage, missing tool, gh/jq failure) — do not disarm
EXIT_FAIL=1
EXIT_CANCELLED=2
EXIT_OTHER=3
EXIT_UNMERGED=4
EXIT_DEADLINE=5
EXIT_EVALUATE_ONLY=6
EXIT_INTERNAL=70
set -Eeuo pipefail
trap 'exit "$EXIT_INTERNAL"' ERR

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

# Pure. JSON array of {name,status,conclusion} on stdin → GREEN|FAIL|CANCEL|PENDING|OTHER.
# skipped and neutral are passing, whether or not landing.required_checks names them.
classify_checks() {
  jq -r '
    def norm: ascii_downcase;
    def conc: (.conclusion // "" | norm);
    def passing: conc == "success" or conc == "skipped" or conc == "neutral";
    def failing: conc == "failure" or conc == "timed_out" or conc == "startup_failure";
    if length == 0 then "PENDING"
    elif any(failing) then "FAIL"
    elif any(conc == "cancelled") then "CANCEL"
    elif any((.status // "" | norm) != "completed") then "PENDING"
    elif all(passing) then "GREEN"
    else "OTHER"
    end
  '
}

# StatusContext entries carry .state and .context, not .status/.conclusion.
# Check-run entries are left unchanged. An unmapped state keeps that state as
# its conclusion so an exit 3 never prints an empty conclusion for a status.
normalise_rollup() {
  jq '
    [.statusCheckRollup[]? |
      if .status != null then
        {
          name: (.name // .context // "unknown"),
          status: .status,
          conclusion: (.conclusion // "")
        }
      else
        (.state // "" | ascii_downcase) as $s |
        {
          name: (.name // .context // "unknown"),
          status: (if ($s == "pending" or $s == "expected") then "in_progress" else "completed" end),
          conclusion: (
            if $s == "success" then "success"
            elif ($s == "pending" or $s == "expected") then ""
            elif ($s == "failure" or $s == "error") then "failure"
            else (.state // "")
            end
          )
        }
      end
    ]
  '
}

REQUIRED=""

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

checks_of() {
  echo "$1" | normalise_rollup | filter_required
}

if [[ "${1:-}" == "--checks-of" ]]; then
  checks_of "$(cat)"
  exit 0
fi

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
    exit "$EXIT_INTERNAL"
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
    exit "$EXIT_INTERNAL"
  fi
}

PR=""
REPO=""
TIMEOUT_RAW="30m"
INTERVAL=15
MERGE_MODE=""
SINCE=""

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
    --since)
      if [[ $# -lt 2 ]]; then
        echo "Error: --since needs a UTC time, YYYY-MM-DDTHH:MM:SSZ" >&2
        exit "$EXIT_INTERNAL"
      fi
      SINCE="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*)
      echo "Error: unknown flag $1" >&2
      exit "$EXIT_INTERNAL"
      ;;
    *)
      PR="$1"
      shift
      ;;
  esac
done

if [[ -z "$PR" ]]; then
  echo "Usage: ci-watch.sh <pr> [--timeout 30m] [--merge-mode merge-on-green|native] [--since <UTC time>] [--repo owner/repo]" >&2
  exit "$EXIT_INTERNAL"
fi

if [[ -n "$SINCE" && ! "$SINCE" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]]; then
  echo "Error: --since '$SINCE' is not a UTC time, YYYY-MM-DDTHH:MM:SSZ" >&2
  exit "$EXIT_INTERNAL"
fi

if [[ -z "$REPO" ]]; then
  REPO=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
fi

TIMEOUT=$(parse_duration "$TIMEOUT_RAW")

# One landing resolver: feature/workflow.js readLanding, also used by landPr —
# `landing.mode` in .dev/stack.yml, else merge-on-green when
# .github/workflows/merge-on-green.yml exists, else native. Prints the mode, then
# one required check per line. An invalid .dev/stack.yml exits 70.
# Needs this script's real path so `$0` finds the sibling (not a pipe or copy).
LANDING_JS="$(dirname "$(readlink -f "$0")")/../feature/workflow.js"
if [[ ! -f "$LANDING_JS" ]]; then
  echo "ci-watch: run this script from its real path (realpath skill://ci-watch/ci-watch.sh) — cannot find ../feature/workflow.js" >&2
  exit "$EXIT_INTERNAL"
fi
LANDING=$(bun -e '
const { readLanding } = await import(process.argv[1])
try {
  const landing = readLanding(process.cwd())
  console.log([landing.mode, ...landing.required_checks].join("\n"))
} catch (e) {
  console.error(`Error: ${e instanceof Error ? e.message : e}`)
  process.exit(1)
}' "$LANDING_JS")
if [[ -z "$MERGE_MODE" ]]; then
  MERGE_MODE="${LANDING%%$'\n'*}"
fi
if [[ "$MERGE_MODE" != "merge-on-green" && "$MERGE_MODE" != "native" ]]; then
  echo "Error: --merge-mode must be merge-on-green or native, got $MERGE_MODE" >&2
  exit "$EXIT_INTERNAL"
fi

REQUIRED=""
if [[ "$LANDING" == *$'\n'* ]]; then
  REQUIRED="${LANDING#*$'\n'}"
fi


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


dump_failed_logs() {
  local sha="$1"
  gh run list --repo "$REPO" --commit "$sha" --json databaseId,conclusion --jq '.[] | select((.conclusion | ascii_downcase) == "failure") | .databaseId' |
    while read -r id; do
      [[ -z "$id" ]] && continue
      echo "----- failed run $id -----"
      gh run view "$id" --repo "$REPO" --log-failed || true
    done
}

# Offending checks for a terminal verdict, one `name=conclusion` per line on stderr.
print_offending() {
  local kind="$1"
  jq -r --arg kind "$kind" '
    def norm: ascii_downcase;
    def conc: (.conclusion // "" | norm);
    def passing: conc == "success" or conc == "skipped" or conc == "neutral";
    def failing: conc == "failure" or conc == "timed_out" or conc == "startup_failure";
    .[] | select(
      if $kind == "FAIL" then failing
      elif $kind == "CANCEL" then conc == "cancelled"
      else (passing | not) and (failing | not) and (conc != "cancelled")
      end
    ) | "\(.name)=\(.conclusion // "")"
  ' >&2
}

require_snapshot() {
  if [[ -z "$1" ]]; then
    echo "empty gh pr view" >&2
    exit "$EXIT_INTERNAL"
  fi
}

# What the kit's merge-on-green workflow resolved for this landing: the newest
# non-skipped `merge-on-green` check run on the commit, started at or after
# --since. A completed run with a `kit-ci not configured` annotation (the notice
# the workflow emits when it runs evaluate-only) → unconfigured; completed
# without it → configured; no such run yet, or not completed → pending.
# Called in an assignment, never an `if`, so a gh/jq failure still exits 70.
kit_ci_of() {
  local sha="$1" run id status count
  run=$(gh api --paginate "repos/$REPO/commits/$sha/check-runs?check_name=merge-on-green&filter=all" |
    jq -rs --arg since "$SINCE" '
      [.[] | .check_runs[]?
        | select(.name == "merge-on-green")
        | select((.conclusion // "" | ascii_downcase) != "skipped")
        | select($since == "" or (.started_at // "") >= $since)]
      | sort_by([(.started_at // ""), .id]) | last
      | if . == null then "" else "\(.id) \(.status // "" | ascii_downcase)" end')
  if [[ -z "$run" ]]; then
    echo pending
    return 0
  fi
  read -r id status <<<"$run"
  if [[ "$status" != "completed" ]]; then
    echo pending
    return 0
  fi
  count=$(gh api --paginate "repos/$REPO/check-runs/$id/annotations" |
    jq -s '[.[][]? | select(.title == "kit-ci not configured")] | length')
  if (( count > 0 )); then
    echo unconfigured
  else
    echo configured
  fi
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
  require_snapshot "$snapshot"
  state=$(echo "$snapshot" | jq -r .state)
  if [[ "$state" == "MERGED" ]]; then
    echo "merged"
    exit 0
  fi
  checks=$(checks_of "$snapshot")
  verdict=$(echo "$checks" | classify_checks)
  case "$verdict" in
    FAIL)
      echo "$checks" | print_offending FAIL
      dump_failed_logs "$(echo "$snapshot" | jq -r .headRefOid)" || echo "failed-run logs unavailable" >&2
      exit "$EXIT_FAIL"
      ;;
    CANCEL)
      echo "$checks" | print_offending CANCEL
      exit "$EXIT_CANCELLED"
      ;;
    OTHER)
      echo "$checks" | print_offending OTHER
      exit "$EXIT_OTHER"
      ;;
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
    *)
      echo "unexpected verdict: ${verdict}" >&2
      exit "$EXIT_INTERNAL"
      ;;
  esac
done

# merge-on-green only: probe the kit-ci resolution on every merge-phase poll that
# would keep watching, until the run of this landing has completed.
KIT_CI=off
if [[ "$MERGE_MODE" == "merge-on-green" ]]; then
  KIT_CI=pending
fi

while true; do
  elapsed=$((SECONDS - START))
  snapshot=$(pr_json)
  require_snapshot "$snapshot"
  state=$(echo "$snapshot" | jq -r .state)
  mss=$(echo "$snapshot" | jq -r .mergeStateStatus)
  eligible=$(eligible_of "$MERGE_MODE" "$snapshot")
  code=$(classify_merge_state "$state" "$mss" "$MERGE_MODE" "$eligible" "$elapsed" "$TIMEOUT")
  if [[ "$code" == "WATCH" && "$KIT_CI" == "pending" ]]; then
    head_sha=$(echo "$snapshot" | jq -r .headRefOid)
    KIT_CI=$(kit_ci_of "$head_sha")
    if [[ "$KIT_CI" == "unconfigured" ]]; then
      if [[ -n "$SINCE" ]]; then
        echo "evaluate-only: kit-ci App not configured — manual merge required (docs/kit/ci-app-setup.md)" >&2
      else
        echo "evaluate-only: the latest merge-on-green run was evaluate-only — configure kit-ci (docs/kit/ci-app-setup.md), then re-label reviewed" >&2
      fi
      exit "$EXIT_EVALUATE_ONLY"
    fi
  fi
  if [[ "$code" == "WATCH" ]]; then
    sleep "$INTERVAL"
    continue
  fi
  if [[ "$code" == "$EXIT_DEADLINE" ]]; then
    echo "undetermined, re-run to resume" >&2
  fi
  exit "$code"
done

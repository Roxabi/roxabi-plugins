#!/usr/bin/env bash
set -euo pipefail

# ci-watch.sh — Watch a GitHub Actions CI run with incremental status updates.
# Polls every N seconds, outputs state changes as single lines, dumps failed logs on failure.

# ── Dependency check ──────────────────────────────────────────────────────────
for cmd in gh jq; do
  if ! command -v "$cmd" &>/dev/null; then
    echo "Error: '$cmd' is required but not found on PATH." >&2
    exit 1
  fi
done

# ── Argument parsing ──────────────────────────────────────────────────────────
REPO=""
RUN_ID=""
PR_NUMBER=""
BRANCH=""
WORKFLOW=""
INTERVAL=10

while [[ $# -gt 0 ]]; do
  case "$1" in
    --repo)     REPO="$2";       shift 2 ;;
    --run)      RUN_ID="$2";     shift 2 ;;
    --pr)       PR_NUMBER="$2";  shift 2 ;;
    --branch)   BRANCH="$2";     shift 2 ;;
    --workflow) WORKFLOW="$2";   shift 2 ;;
    --interval) INTERVAL="$2";   shift 2 ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: ci-watch.sh --repo OWNER/REPO [--run ID | --pr NUMBER | --branch NAME] [--workflow NAME] [--interval SECONDS]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$REPO" ]]; then
  echo "Error: --repo OWNER/REPO is required." >&2
  exit 1
fi

# ── Run ID resolution ─────────────────────────────────────────────────────────
resolve_run_for_branch() {
  local branch="$1"
  local wf_flag=()
  if [[ -n "$WORKFLOW" ]]; then
    wf_flag=(--workflow "$WORKFLOW")
  fi
  # Fetch recent runs and prefer: in_progress > queued > non-skipped completed > any
  gh run list --repo "$REPO" --branch "$branch" "${wf_flag[@]}" --limit 20 \
    --json databaseId,status,conclusion -q '
      ([ .[] | select(.status == "in_progress") ] | first // null)
      // ([ .[] | select(.status == "queued" or .status == "waiting") ] | first // null)
      // ([ .[] | select(.status == "completed" and .conclusion != "skipped") ] | first // null)
      // .[0]
      | .databaseId
    ' 2>/dev/null || true
}

# Auto-detect workflow: try ci.yml if no --workflow given and no --run
if [[ -z "$WORKFLOW" && -z "$RUN_ID" ]]; then
  if gh workflow view ci.yml --repo "$REPO" &>/dev/null; then
    WORKFLOW="ci.yml"
  fi
fi

if [[ -n "$RUN_ID" ]]; then
  : # use directly
elif [[ -n "$PR_NUMBER" ]]; then
  BRANCH=$(gh pr view "$PR_NUMBER" --repo "$REPO" --json headRefName -q '.headRefName')
  if [[ -z "$BRANCH" ]]; then
    echo "Error: could not determine head branch for PR #${PR_NUMBER}." >&2
    exit 1
  fi
  RUN_ID=$(resolve_run_for_branch "$BRANCH")
elif [[ -n "$BRANCH" ]]; then
  RUN_ID=$(resolve_run_for_branch "$BRANCH")
else
  BRANCH=$(git branch --show-current 2>/dev/null || true)
  if [[ -z "$BRANCH" ]]; then
    echo "Error: not in a git repo and no --run/--pr/--branch given." >&2
    exit 1
  fi
  RUN_ID=$(resolve_run_for_branch "$BRANCH")
fi

if [[ -z "$RUN_ID" ]]; then
  echo "Error: no CI run found. Pass --run ID to specify one explicitly." >&2
  exit 1
fi

# Fetch branch name from the run if we don't already have it
if [[ -z "$BRANCH" ]]; then
  BRANCH=$(gh run view "$RUN_ID" --repo "$REPO" --json headBranch -q '.headBranch' 2>/dev/null || echo "unknown")
fi

# ── Helper: format elapsed seconds ───────────────────────────────────────────
format_elapsed() {
  local secs="$1"
  if (( secs >= 60 )); then
    printf "%dm %ds" $(( secs / 60 )) $(( secs % 60 ))
  else
    printf "%ds" "$secs"
  fi
}

# ── Helper: status+conclusion → emoji ────────────────────────────────────────
status_emoji() {
  local status="$1"
  local conclusion="$2"
  if [[ "$status" == "completed" ]]; then
    case "$conclusion" in
      success)   echo "✅" ;;
      failure)   echo "❌" ;;
      skipped)   echo "⬛" ;;
      cancelled) echo "🚫" ;;
      *)         echo "❓" ;;
    esac
  else
    case "$status" in
      in_progress)        echo "⏳" ;;
      queued|waiting|pending) echo "⬜" ;;
      *)                  echo "⬜" ;;
    esac
  fi
}

# ── Auto-merge watch ─────────────────────────────────────────────────────────
watch_automerge() {
  local pr="$1"

  # Require: auto-merge enabled AND "reviewed" label present
  local pr_data
  pr_data=$(gh pr view "$pr" --repo "$REPO" --json autoMergeRequest,labels,state 2>/dev/null) || return 0

  local has_automerge
  has_automerge=$(echo "$pr_data" | jq -r 'if .autoMergeRequest != null then "true" else "false" end')

  local has_reviewed
  has_reviewed=$(echo "$pr_data" | jq -r '[.labels[].name] | contains(["reviewed"]) | tostring')

  if [[ "$has_automerge" != "true" || "$has_reviewed" != "true" ]]; then
    return 0
  fi

  echo "🔀 Auto-merge enabled + 'reviewed' label — watching for merge..."

  local merge_start=$SECONDS

  while true; do
    pr_data=$(gh pr view "$pr" --repo "$REPO" --json state 2>/dev/null) || break

    local state
    state=$(echo "$pr_data" | jq -r '.state')

    if [[ "$state" == "MERGED" ]]; then
      local merge_elapsed=$(( SECONDS - merge_start ))
      echo "✅ PR #${pr} merged! ($(format_elapsed "$merge_elapsed"))"
      return 0
    elif [[ "$state" == "CLOSED" ]]; then
      echo "🚫 PR #${pr} closed without merging."
      return 0
    fi

    sleep "$INTERVAL"
  done
}

# ── Main watch loop ───────────────────────────────────────────────────────────
START_SECONDS=$SECONDS

# State tracking for incremental output
declare -A PREV_JOB_STATES
PREV_RUN_STATE=""

# Initial output
echo "🔄 run #${RUN_ID} ${BRANCH}"

while true; do
  # Fetch run data
  RUN_JSON=$(gh run view "$RUN_ID" --repo "$REPO" --json status,conclusion,jobs 2>&1) || {
    echo "Error fetching run data: $RUN_JSON" >&2
    exit 1
  }

  RUN_STATUS=$(echo "$RUN_JSON"    | jq -r '.status')
  RUN_CONCLUSION=$(echo "$RUN_JSON" | jq -r '.conclusion // ""')

  ELAPSED=$(( SECONDS - START_SECONDS ))
  ELAPSED_FMT=$(format_elapsed "$ELAPSED")

  # Track run-level changes
  RUN_STATE="${RUN_STATUS}:${RUN_CONCLUSION}"
  if [[ "$RUN_STATE" != "${PREV_RUN_STATE:-}" ]]; then
    if [[ "$RUN_STATUS" == "completed" ]]; then
      RUN_EMOJI=$(status_emoji "$RUN_STATUS" "$RUN_CONCLUSION")
      echo "${RUN_EMOJI} run #${RUN_ID} ${RUN_CONCLUSION} (${ELAPSED_FMT})"
    fi
    PREV_RUN_STATE="$RUN_STATE"
  fi

  # Track job/step changes
  JOB_COUNT=$(echo "$RUN_JSON" | jq '.jobs | length')
  for (( i=0; i<JOB_COUNT; i++ )); do
    JOB=$(echo "$RUN_JSON" | jq ".jobs[$i]")
    JOB_NAME=$(echo "$JOB"       | jq -r '.name')
    JOB_STATUS=$(echo "$JOB"     | jq -r '.status')
    JOB_CONCLUSION=$(echo "$JOB" | jq -r '.conclusion // ""')
    JOB_EMOJI=$(status_emoji "$JOB_STATUS" "$JOB_CONCLUSION")

    JOB_STATE="${JOB_STATUS}:${JOB_CONCLUSION}"
    JOB_KEY="job:${JOB_NAME}"

    if [[ "${PREV_JOB_STATES[$JOB_KEY]:-}" != "$JOB_STATE" ]]; then
      echo "  ${JOB_EMOJI} ${JOB_NAME}"
      PREV_JOB_STATES[$JOB_KEY]="$JOB_STATE"
    fi

  done

  # Check completion
  if [[ "$RUN_STATUS" == "completed" ]]; then
    case "$RUN_CONCLUSION" in
      success)
        echo "✅ PASSED (${ELAPSED_FMT})"
        if [[ -n "$PR_NUMBER" ]]; then
          watch_automerge "$PR_NUMBER"
        fi
        exit 0
        ;;
      failure)
        echo "❌ FAILED (${ELAPSED_FMT})"
        gh run view "$RUN_ID" --repo "$REPO" --log-failed 2>&1 | tail -60
        exit 1
        ;;
      cancelled)
        echo "🚫 CANCELLED (${ELAPSED_FMT})"
        exit 2
        ;;
      *)
        echo "❓ ${RUN_CONCLUSION} (${ELAPSED_FMT})"
        exit 3
        ;;
    esac
  fi

  sleep "$INTERVAL"
done

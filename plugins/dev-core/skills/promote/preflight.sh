#!/usr/bin/env bash
# Usage: preflight.sh
# Fetches latest, reports commits ahead, open PRs on staging, and CI status.
set -euo pipefail

# Branch names are intentionally hardcoded: promote always operates on the fixed
# staging→main pair, so detect_base_branch (single-base detection) does not apply here.
# Each git op emits a machine-readable status= key before exiting non-zero so the
# /promote skill sees a reason rather than a bare set -e abort.
git fetch origin staging main 2>&1 || { echo "status=fetch_failed"; exit 1; }
git checkout staging 2>&1 || { echo "status=checkout_failed"; exit 1; }
git pull origin staging 2>&1 || { echo "status=pull_failed"; exit 1; }

# `|| true` keeps a git-log failure from aborting under `set -e` so the guard
# below can report a structured status instead of a bare non-zero exit.
COMMITS=$(git log main..staging --oneline 2>/dev/null | wc -l | tr -d '[:space:]' || true)
COMMITS=${COMMITS:-0}
echo "commits_ahead=$COMMITS"
if ! [ "$COMMITS" -eq "$COMMITS" ] 2>/dev/null; then
  echo "status=error_counting_commits"
elif [ "$COMMITS" -eq 0 ]; then
  echo "status=nothing_to_promote"
else
  echo "status=ok"
fi

echo "---commits---"
git log main..staging --oneline 2>/dev/null || echo "none"

echo "---stat---"
git diff main...staging --stat 2>/dev/null || echo "none"

echo "---open_prs_on_staging---"
gh pr list --base staging --state open --json number,title,headRefName 2>/dev/null || echo "none"

echo "---ci---"
gh api repos/:owner/:repo/commits/staging/check-runs \
  --jq '[.check_runs[] | {name, conclusion}] | group_by(.conclusion) | map({conclusion: .[0].conclusion, count: length})' \
  2>/dev/null || echo "ci=unknown"

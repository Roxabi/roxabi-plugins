#!/usr/bin/env bash
# Usage: preflight.sh
# Fetches latest, reports commits ahead, open PRs on staging, and CI status.
git fetch origin staging main 2>&1
git checkout staging && git pull origin staging 2>&1

COMMITS=$(git log main..staging --oneline | wc -l | xargs)
echo "commits_ahead=$COMMITS"
[ "$COMMITS" -eq 0 ] && echo "status=nothing_to_promote" || echo "status=ok"

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

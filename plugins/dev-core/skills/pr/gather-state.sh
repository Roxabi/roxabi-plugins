#!/usr/bin/env bash
# Usage: gather-state.sh
# Outputs current branch, base, commits ahead, diff stat, existing PR, and lifecycle artifacts.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../shared/lib.sh
. "$SCRIPT_DIR/../shared/lib.sh"

BRANCH=$(git branch --show-current 2>/dev/null || true)
# Refresh remote-tracking refs so base detection + the diffs below reflect the
# current remote (e.g. a staging branch created since the last fetch).
git fetch --prune origin 2>/dev/null || true
BASE=$(detect_base_branch)
echo "branch=$BRANCH"
echo "base=$BASE"

echo "---commits---"
git log "origin/${BASE}..HEAD" --oneline 2>/dev/null || echo "none"

echo "---stat---"
git diff "origin/${BASE}...HEAD" --stat 2>/dev/null || echo "none"

echo "---pr---"
gh pr list --head "$BRANCH" --json number,title,url,state 2>/dev/null || echo "none"

# lifecycle artifacts
ISSUE_NUM=$(echo "$BRANCH" | sed -n 's/^feat\/\([0-9]*\)-.*/\1/p')
if [ -n "$ISSUE_NUM" ]; then
  echo "issue=$ISSUE_NUM"
  ANALYSIS=$(ls "artifacts/analyses/${ISSUE_NUM}-"*.md "artifacts/analyses/${ISSUE_NUM}-"*.mdx 2>/dev/null | head -1 || true)
  [ -n "$ANALYSIS" ] && echo "analysis=$ANALYSIS" || echo "analysis=false"
  SPEC=$(ls "artifacts/specs/${ISSUE_NUM}-"*.md "artifacts/specs/${ISSUE_NUM}-"*.mdx 2>/dev/null | head -1 || true)
  [ -n "$SPEC" ] && echo "spec=$SPEC" || echo "spec=false"
  gh issue view "$ISSUE_NUM" --json title,state,labels 2>/dev/null || echo "issue_data=false"
  # grep -c exits 1 on zero matches; under pipefail that fails the assignment, so
  # `|| true` keeps it empty and `${TEST_FILES:-0}` substitutes 0. (Do NOT rewrite as
  # `grep -c … || echo 0` — grep already prints "0", so that doubles the output.)
  TEST_FILES=$(git diff "origin/${BASE}...HEAD" --name-only 2>/dev/null | grep -c '\.test\.\|\.spec\.' || true)
  echo "test_files=${TEST_FILES:-0}"
else
  echo "issue=none"
fi

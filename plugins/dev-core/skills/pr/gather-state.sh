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
# Any conventional prefix (feat|fix|chore|docs|refactor|…), not feat-only —
# otherwise fix/# and chore/# branches report issue=none while /dev still finds α.
ISSUE_NUM=$(echo "$BRANCH" | sed -n 's/^[a-z][a-z0-9]*\/\([0-9][0-9]*\)-.*/\1/p')
if [ -n "$ISSUE_NUM" ]; then
  echo "issue=$ISSUE_NUM"
  # Same resolver as /dev, via the shared helper — ¬a second implementation. The
  # candidate set must match too: the previous inline glob `{N}-*` anchored at the
  # filename start with no slug fallback, so /dev could report an analysis that /pr
  # reported as absent (e.g. `epic-42-drift-analysis.md`, or a slug-only name).
  SLUG=$(echo "$BRANCH" | sed -n 's/^[a-z][a-z0-9]*\/[0-9][0-9]*-\(.*\)$/\1/p')
  ANALYSIS=$(resolve_analysis "artifacts/analyses" "$ISSUE_NUM" "$SLUG")
  [ -n "$ANALYSIS" ] && ANALYSIS="artifacts/analyses/$ANALYSIS"
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

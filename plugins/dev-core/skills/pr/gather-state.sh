#!/usr/bin/env bash
# Usage: gather-state.sh
# Outputs current branch, base, commits ahead, diff stat, existing PR, and lifecycle artifacts.
BRANCH=$(git branch --show-current 2>/dev/null)
BASE=$(git branch -r 2>/dev/null | grep -q 'origin/staging' && echo staging || echo main)
echo "branch=$BRANCH"
echo "base=$BASE"

echo "---commits---"
git log "${BASE}..HEAD" --oneline 2>/dev/null || echo "none"

echo "---stat---"
git diff "${BASE}...HEAD" --stat 2>/dev/null || echo "none"

echo "---pr---"
gh pr list --head "$BRANCH" --json number,title,url,state 2>/dev/null || echo "none"

# lifecycle artifacts
ISSUE_NUM=$(echo "$BRANCH" | grep -oP '(?<=/)\d+' | head -1)
if [ -n "$ISSUE_NUM" ]; then
  echo "issue=$ISSUE_NUM"
  ANALYSIS=$(ls "artifacts/analyses/${ISSUE_NUM}-"*.mdx 2>/dev/null | head -1)
  [ -n "$ANALYSIS" ] && echo "analysis=$ANALYSIS" || echo "analysis=false"
  SPEC=$(ls "artifacts/specs/${ISSUE_NUM}-"*.mdx 2>/dev/null | head -1)
  [ -n "$SPEC" ] && echo "spec=$SPEC" || echo "spec=false"
  gh issue view "$ISSUE_NUM" --json title,state,labels 2>/dev/null || echo "issue_data=false"
  TEST_FILES=$(git diff "${BASE}...HEAD" --name-only 2>/dev/null | grep -c '\.test\.\|\.spec\.' || echo 0)
  echo "test_files=$TEST_FILES"
else
  echo "issue=none"
fi

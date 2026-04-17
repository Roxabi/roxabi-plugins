#!/usr/bin/env bash
# Usage: scan-state.sh <N> <slug>
# Outputs explicit key=value for each pipeline state check.
N=$1
SLUG=$2

REPO=$(gh repo view --json name --jq '.name' 2>/dev/null || echo "")

# triage
gh issue view "$N" --json state 2>/dev/null \
  && echo "triage=true" || echo "triage=false"

# frame (handles both {N}-{slug}.mdx and {slug}.mdx patterns)
FRAME=$(ls artifacts/frames/ 2>/dev/null | grep -iE "^${N}-${SLUG}|^${SLUG}" | head -1)
[ -n "$FRAME" ] && echo "frame=$FRAME" || echo "frame=false"

# analyze
ANALYZE=$(ls artifacts/analyses/ 2>/dev/null | grep -E "^${N}-|${SLUG}" | head -1)
[ -n "$ANALYZE" ] && echo "analyze=$ANALYZE" || echo "analyze=false"

# spec
SPEC=$(ls artifacts/specs/ 2>/dev/null | grep "^${N}-" | head -1)
[ -n "$SPEC" ] && echo "spec=$SPEC" || echo "spec=false"

# plan
PLAN=$(ls artifacts/plans/ 2>/dev/null | grep "^${N}-" | head -1)
[ -n "$PLAN" ] && echo "plan=$PLAN" || echo "plan=false"

# worktree (.claude/worktrees/ and legacy parent-dir)
WORKTREE=$(git worktree list 2>/dev/null | grep -E "${REPO}-${N}|worktrees/${N}-" | head -1)
[ -n "$WORKTREE" ] && echo "worktree=$WORKTREE" || echo "worktree=false"

# branch
BRANCH=$(git branch -a 2>/dev/null | grep "${N}-${SLUG}" | head -1 | xargs)
[ -n "$BRANCH" ] && echo "branch=$BRANCH" || echo "branch=false"

# pr
PR_JSON=$(gh pr list --search "#${N}" --json number,state,reviewDecision,merged --jq '.[]' 2>/dev/null)
if [ -n "$PR_JSON" ]; then
  echo "pr=$PR_JSON"
  PR_NUM=$(gh pr list --search "#${N}" --json number --jq '.[0].number' 2>/dev/null)
  gh pr view "$PR_NUM" --json comments --jq '.comments[].body' 2>/dev/null \
    | grep -q "^## Code Review" && echo "review_comment=true" || echo "review_comment=false"
  gh pr view "$PR_NUM" --json comments --jq '.comments[].body' 2>/dev/null \
    | grep -q "^## Review Fixes Applied" && echo "fix_comment=true" || echo "fix_comment=false"
else
  echo "pr=false"
  echo "review_comment=false"
  echo "fix_comment=false"
fi

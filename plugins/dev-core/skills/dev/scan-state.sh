#!/usr/bin/env bash
# Usage: scan-state.sh <N> <slug>
# Outputs explicit key=value for each pipeline state check.
N=$1
SLUG=$2

REPO=$(gh repo view --json name --jq '.name' 2>/dev/null || echo "")
BASE=$(git branch -r 2>/dev/null | grep -q 'origin/staging' && echo staging || echo main)

# worktree (.claude/worktrees/ and legacy parent-dir)
WORKTREE=$(git worktree list 2>/dev/null | grep -E "${REPO}-${N}|worktrees/${N}-" | head -1)
[ -n "$WORKTREE" ] && echo "worktree=$WORKTREE" || echo "worktree=false"

# Helper: look for artifacts in worktree if not found in current directory
wt_artifact() {
  local dir=$1
  local pattern=$2
  if [ -n "$WORKTREE" ]; then
    WT_PATH=$(echo "$WORKTREE" | awk '{print $1}')
    ls "${WT_PATH}/${dir}/" 2>/dev/null | grep -iE "$pattern" | head -1
  fi
}

# triage
gh issue view "$N" --json state 2>/dev/null \
  && echo "triage=true" || echo "triage=false"

# frame (handles both {N}-{slug}.mdx and {slug}.mdx patterns)
FRAME=$(ls artifacts/frames/ 2>/dev/null | grep -iE "^${N}-${SLUG}|^${SLUG}" | head -1)
[ -z "$FRAME" ] && FRAME=$(wt_artifact "artifacts/frames" "^${N}-${SLUG}|^${SLUG}")
[ -n "$FRAME" ] && echo "frame=$FRAME" || echo "frame=false"

# recheck (session-only state — no on-disk artifact, /dev tracks via Σ_s)
# Value is always `null` (sentinel); /dev never parses it for truthiness — recheck always
# runs via Σ_s (see Step 1 — Scan State in dev/SKILL.md). Line exists for parser uniformity.
echo "recheck=null"

# analyze
ANALYZE=$(ls artifacts/analyses/ 2>/dev/null | grep -E "^${N}-|${SLUG}" | head -1)
[ -z "$ANALYZE" ] && ANALYZE=$(wt_artifact "artifacts/analyses" "^${N}-|${SLUG}")
[ -n "$ANALYZE" ] && echo "analyze=$ANALYZE" || echo "analyze=false"

# spec
SPEC=$(ls artifacts/specs/ 2>/dev/null | grep "^${N}-" | head -1)
[ -z "$SPEC" ] && SPEC=$(wt_artifact "artifacts/specs" "^${N}-")
[ -n "$SPEC" ] && echo "spec=$SPEC" || echo "spec=false"

# plan
PLAN=$(ls artifacts/plans/ 2>/dev/null | grep "^${N}-" | head -1)
[ -z "$PLAN" ] && PLAN=$(wt_artifact "artifacts/plans" "^${N}-")
[ -n "$PLAN" ] && echo "plan=$PLAN" || echo "plan=false"

# branch
BRANCH=$(git branch -a 2>/dev/null | grep "${N}-${SLUG}" | head -1 | xargs)
[ -n "$BRANCH" ] && echo "branch=$BRANCH" || echo "branch=false"

# implement — worktree has code changes (files outside artifacts/)
if [ -n "$WORKTREE" ]; then
  WT_PATH=$(echo "$WORKTREE" | awk '{print $1}')
  HAS_CODE=$(git -C "$WT_PATH" diff --name-only "origin/${BASE}..HEAD" 2>/dev/null | grep -v '^artifacts/' | head -1)
  [ -n "$HAS_CODE" ] && echo "implement=true" || echo "implement=false"
else
  echo "implement=false"
fi

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

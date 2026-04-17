#!/usr/bin/env bash
# Usage: setup-preflight.sh <N> <slug>
# Detects base branch, existing branches/worktrees, and fetches base.
N=$1
SLUG=$2

REPO=$(gh repo view --json name --jq '.name' 2>/dev/null || echo "unknown")
BASE=$(git branch -r 2>/dev/null | grep -q 'origin/staging' && echo staging || echo main)
echo "repo=$REPO"
echo "base=$BASE"

# existing feature branch
EXISTING_BRANCH=$(git branch --list "feat/${N}-*" | head -1 | xargs)
[ -n "$EXISTING_BRANCH" ] && echo "branch_exists=$EXISTING_BRANCH" || echo "branch_exists=false"

# legacy parent-dir worktree
ls -d "../${REPO}-${N}" 2>/dev/null && echo "legacy_worktree=true" || echo "legacy_worktree=false"

# .claude/worktrees/ worktree
WORKTREE=$(git worktree list 2>/dev/null | grep "worktrees/${N}-" | head -1)
[ -n "$WORKTREE" ] && echo "worktree=$WORKTREE" || echo "worktree=false"

# dirty state (if worktree exists)
if [ -n "$WORKTREE" ]; then
  DIRTY=$(git status --porcelain 2>/dev/null)
  [ -n "$DIRTY" ] && echo "dirty=true" || echo "dirty=false"
fi

# fetch base
git fetch origin "$BASE" 2>&1 && echo "fetch=ok" || echo "fetch=failed"

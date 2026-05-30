#!/usr/bin/env bash
# Usage: setup-preflight.sh <N> <slug>
# Detects base branch, existing branches/worktrees, and fetches base.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../shared/lib.sh
. "$SCRIPT_DIR/../shared/lib.sh"

N="${1:-}"
SLUG="${2:-}"

REPO=$(gh repo view --json name --jq '.name' 2>/dev/null || echo "unknown")
BASE=$(detect_base_branch)
echo "repo=$REPO"
echo "base=$BASE"

# existing feature branch
EXISTING_BRANCH=$(git branch -a --list "feat/${N}-*" | head -1 | xargs || true)
[ -n "$EXISTING_BRANCH" ] && echo "branch_exists=$EXISTING_BRANCH" || echo "branch_exists=false"

# legacy parent-dir worktree ([ -d ] test, not `ls -d` — SC2012)
[ -d "../${REPO}-${N}" ] && echo "legacy_worktree=true" || echo "legacy_worktree=false"

# .claude/worktrees/ worktree — porcelain path is space-safe
WT_PATH=$(git worktree list --porcelain 2>/dev/null \
  | sed -n 's/^worktree //p' \
  | grep -F "worktrees/${N}-" \
  | head -1 || true)
[ -n "$WT_PATH" ] && echo "worktree=$WT_PATH" || echo "worktree=false"

# dirty state (inside worktree if it exists)
if [ -n "$WT_PATH" ]; then
  DIRTY=$(git -C "$WT_PATH" status --porcelain 2>/dev/null || true)
  [ -n "$DIRTY" ] && echo "dirty=true" || echo "dirty=false"
fi

# fetch base
git fetch origin "$BASE" 2>&1 && echo "fetch=ok" || echo "fetch=failed"

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

# Principal freeze
PRINCIPAL=$(principal_worktree_path)
PRINCIPAL_BRANCH=$(principal_branch)
[ -n "$PRINCIPAL" ] && echo "principal=$PRINCIPAL" || echo "principal=false"
echo "principal_branch=${PRINCIPAL_BRANCH:-false}"
if is_base_branch "$PRINCIPAL_BRANCH"; then
  echo "principal_ok=true"
else
  echo "principal_ok=false"
fi

# existing feature branch (local or remote-tracking name)
EXISTING_BRANCH=$(git branch -a --list "feat/${N}-*" | head -1 | xargs || true)
[ -n "$EXISTING_BRANCH" ] && echo "branch_exists=$EXISTING_BRANCH" || echo "branch_exists=false"

# legacy parent-dir worktree ([ -d ] test, not `ls -d` — SC2012)
[ -d "../${REPO}-${N}" ] && echo "legacy_worktree=true" || echo "legacy_worktree=false"

# Feature worktree — branch-first via find_feature_worktree (excludes principal)
WT_PATH=$(find_feature_worktree "$N" "$SLUG")
[ -n "$WT_PATH" ] && echo "worktree=$WT_PATH" || echo "worktree=false"
if [ -n "$WT_PATH" ]; then
  WT_BRANCH=$(git -C "$WT_PATH" rev-parse --abbrev-ref HEAD 2>/dev/null || true)
  echo "worktree_branch=${WT_BRANCH:-false}"
  DIRTY=$(git -C "$WT_PATH" status --porcelain 2>/dev/null || true)
  [ -n "$DIRTY" ] && echo "dirty=true" || echo "dirty=false"
fi

# fetch base
git fetch origin "$BASE" 2>&1 && echo "fetch=ok" || echo "fetch=failed"

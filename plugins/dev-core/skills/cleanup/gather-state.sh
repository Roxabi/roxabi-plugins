#!/usr/bin/env bash
# Usage: gather-state.sh
# Outputs current branch, all branches with tracking info, worktrees, and open PRs.
echo "---current---"
git branch --show-current 2>/dev/null || echo "current=unknown"

echo "---branches---"
git branch -vv 2>/dev/null || echo "branches=none"

echo "---worktrees---"
git worktree list 2>/dev/null || echo "worktrees=none"

echo "---open-prs---"
gh pr list --state open 2>/dev/null || echo "open_prs=none"

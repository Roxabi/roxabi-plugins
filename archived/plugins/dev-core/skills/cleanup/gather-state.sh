#!/usr/bin/env bash
# Usage: gather-state.sh
# Outputs current branch, all branches with tracking info, worktrees, open PRs,
# closed PRs with stuck pipeline labels, and queued/stuck CI runs.
set -euo pipefail

echo "---current---"
git branch --show-current 2>/dev/null || echo "current=unknown"

echo "---branches---"
git branch -vv 2>/dev/null || echo "branches=none"

echo "---worktrees---"
git worktree list 2>/dev/null || echo "worktrees=none"

echo "---orphan-worktree-shells---"
# Leftovers that `git worktree list` misses (empty Grok parents, unregistered
# dirs under ~/.grok/worktrees/<slug>/ or .claude/worktrees/, stale worktrees.db).
# Analyze-only — lines: path|kind|detail. See scan-orphan-worktree-shells.sh.
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ -x "$_script_dir/scan-orphan-worktree-shells.sh" ]; then
  bash "$_script_dir/scan-orphan-worktree-shells.sh" || echo "orphan_shells=error"
else
  echo "orphan_shells=none"
fi

echo "---open-prs---"
gh pr list --state open 2>/dev/null || echo "open_prs=none"

echo "---closed-prs-with-labels---"
# Bounded: at most 20 closed PRs. Lists number, title, and labels.
# The caller filters by the pipeline label list defined in SKILL.md.
gh pr list \
  --state closed \
  --limit 20 \
  --json number,title,labels \
  --jq '.[] | select((.labels | length) > 0) | {number, title, labels: [.labels[].name]}' \
  2>/dev/null || echo "closed_prs=none"

echo "---queued-runs---"
# Bounded: at most 30 runs, queued or in_progress only.
# Caller applies age threshold: queued ≥ 30 min, in_progress ≥ 60 min.
gh run list \
  --limit 30 \
  --json databaseId,name,workflowName,headBranch,status,createdAt \
  --jq '.[] | select(.status == "queued" or .status == "in_progress")' \
  2>/dev/null || echo "queued_runs=none"

#!/usr/bin/env bash
# Usage: scan-state.sh <N> <slug>
# Outputs explicit key=value for each pipeline state check.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../shared/lib.sh
. "$SCRIPT_DIR/../shared/lib.sh"

N="${1:-}"
SLUG="${2:-}"

REPO=$(gh repo view --json name --jq '.name' 2>/dev/null || echo "")
BASE=$(detect_base_branch)

# Anchored issue-number match — requires the char before N to be start-of-line
# or non-digit, and the char immediately after N to be the artifact/branch
# naming separator '-' ({N}-{slug} convention). Prevents #1 from matching
# #14's frame/analyze/spec/plan/branch (bare "${N}-" substring search would:
# "14-foo" contains "4-foo", so N=4 wrongly matched N=14's artifacts).
N_ANCHOR="(^|[^0-9])${N}-"

# worktree path (.claude/worktrees/ and legacy parent-dir).
# Porcelain `worktree <path>` lines are space-safe — no column splitting on the
# path, unlike `git worktree list | awk '{print $1}'` which breaks on spaces.
# Legacy `../${REPO}-{N}` has no trailing slug (N can be the last path token),
# so its right boundary is "non-digit or end" rather than a literal '-'; the
# left boundary is already safe (always preceded by the literal "${REPO}-").
[ -n "$REPO" ] && WT_PATTERN="${REPO}-${N}([^0-9]|\$)|worktrees/${N}-" || WT_PATTERN="worktrees/${N}-"
WT_PATH=$(git worktree list --porcelain 2>/dev/null \
  | sed -n 's/^worktree //p' \
  | grep -E "$WT_PATTERN" \
  | head -1 || true)
[ -n "$WT_PATH" ] && echo "worktree=$WT_PATH" || echo "worktree=false"

# Helper: list artifacts in worktree if not found in current directory
# (filtering is the caller's job — keeps the anchor consistent across
# cwd and worktree lookups instead of baking a pattern into this helper).
wt_list() {
  local dir=$1
  if [ -n "$WT_PATH" ]; then
    ls "${WT_PATH}/${dir}/" 2>/dev/null || true
  fi
}

# frame (handles both {N}-{slug}.md and {slug}.md patterns; legacy .mdx ok)
FRAME=$(ls artifacts/frames/ 2>/dev/null | grep -iE "$N_ANCHOR" | grep -iF -- "${SLUG}" | head -1 || true)
[ -z "$FRAME" ] && FRAME=$(ls artifacts/frames/ 2>/dev/null | grep -iF -- "${SLUG}" | head -1 || true)
[ -z "$FRAME" ] && FRAME=$(wt_list "artifacts/frames" | grep -iE "$N_ANCHOR" | grep -iF -- "${SLUG}" | head -1 || true)
[ -z "$FRAME" ] && FRAME=$(wt_list "artifacts/frames" | grep -iF -- "${SLUG}" | head -1 || true)
[ -n "$FRAME" ] && echo "frame=$FRAME" || echo "frame=false"

# recheck (session-only state — no on-disk artifact, /dev tracks via Σ_s)
# Value is always `null` (sentinel); /dev never parses it for truthiness — recheck always
# runs via Σ_s (see Step 1 — Scan State in dev/SKILL.md). Line exists for parser uniformity.
echo "recheck=null"

# analyze
ANALYZE=$(ls artifacts/analyses/ 2>/dev/null | grep -E "$N_ANCHOR" | head -1 || true)
[ -z "$ANALYZE" ] && ANALYZE=$(ls artifacts/analyses/ 2>/dev/null | grep -iF -- "${SLUG}" | head -1 || true)
[ -z "$ANALYZE" ] && ANALYZE=$(wt_list "artifacts/analyses" | grep -E "$N_ANCHOR" | head -1 || true)
[ -z "$ANALYZE" ] && ANALYZE=$(wt_list "artifacts/analyses" | grep -iF -- "${SLUG}" | head -1 || true)
[ -n "$ANALYZE" ] && echo "analyze=$ANALYZE" || echo "analyze=false"

# spec
SPEC=$(ls artifacts/specs/ 2>/dev/null | grep -E "$N_ANCHOR" | head -1 || true)
[ -z "$SPEC" ] && SPEC=$(wt_list "artifacts/specs" | grep -E "$N_ANCHOR" | head -1 || true)
[ -n "$SPEC" ] && echo "spec=$SPEC" || echo "spec=false"

# plan
PLAN=$(ls artifacts/plans/ 2>/dev/null | grep -E "$N_ANCHOR" | head -1 || true)
[ -z "$PLAN" ] && PLAN=$(wt_list "artifacts/plans" | grep -E "$N_ANCHOR" | head -1 || true)
[ -n "$PLAN" ] && echo "plan=$PLAN" || echo "plan=false"

# stale — worktree or local/remote branch still lingering for this issue.
# Consumed by /dev's cleanup skip logic (Σ.cleanup = ¬stale; should_skip
# cleanup ∧ ¬stale — dev/SKILL.md). Anchored on N (same $N_ANCHOR as above)
# to avoid cross-issue collisions; slug-independent by design (a branch
# survives issue-title edits that would change the slug).
STALE_BRANCH=$(git branch -a 2>/dev/null | grep -E "$N_ANCHOR" | head -1 || true)
if [ -n "$WT_PATH" ] || [ -n "$STALE_BRANCH" ]; then
  echo "stale=true"
else
  echo "stale=false"
fi

# implement — worktree has code changes (files outside artifacts/)
if [ -n "$WT_PATH" ]; then
  HAS_CODE=$(git -C "$WT_PATH" diff --name-only "origin/${BASE}..HEAD" 2>/dev/null | grep -v '^artifacts/' | head -1 || true)
  [ -n "$HAS_CODE" ] && echo "implement=true" || echo "implement=false"
else
  echo "implement=false"
fi

# pr
PR_JSON=$(gh pr list --search "#${N}" --json number,state,reviewDecision,merged --jq '.[]' 2>/dev/null || true)
if [ -n "$PR_JSON" ]; then
  echo "pr=$PR_JSON"
  PR_NUM=$(gh pr list --search "#${N}" --json number --jq '.[0].number' 2>/dev/null || true)
  gh pr view "$PR_NUM" --json comments --jq '.comments[].body' 2>/dev/null \
    | grep -q "^## Code Review" && echo "review_comment=true" || echo "review_comment=false"
  gh pr view "$PR_NUM" --json comments --jq '.comments[].body' 2>/dev/null \
    | grep -q "^## Review Fixes Applied" && echo "fix_comment=true" || echo "fix_comment=false"
else
  echo "pr=false"
  echo "review_comment=false"
  echo "fix_comment=false"
fi

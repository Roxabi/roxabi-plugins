#!/usr/bin/env bash
# Usage: analyze-branches.sh [--json] [--no-fetch] [--scope <#N>]
# Analyzes local and remote branches for /cleanup merge-status verification.
# Analyze-only — never deletes branches, worktrees, or remotes. There is no
# deletion path in this file at all: it emits `action` labels and a `safe_*` list.
# /cleanup types every deletion there is in exactly three places, and this is the
# complete list:
#   Step 5        `git worktree remove` / `git branch -d` / `git branch -D`
#   Step 5b-exec  `rmdir` / `rm -rf` on an orphan worktree shell
#   Step 6e       `git push origin --delete`
# Only the first is backstopped by git: `branch -d` refuses an unmerged branch,
# and the remote copy survives the mistake. Step 6e has no such refusal and no
# second copy — it is the one deletion that ends the work — and Step 5b-exec runs
# `rm -rf` outside git entirely. So `safe_delete` here means *proven* merged
# (see branch_merged): a grep hit produces `probably_merged`, which is never
# pre-selected and never enters `safe_remote`. A branch that is protected
# (main/master/staging, or deploy/*) or checked out here can never reach
# `safe_delete`, `safe_local`, `safe_remote`, `probably_local`, or
# `probably_remote` — see is_protected. deploy/* is protected because a CD
# production branch is an ancestor of the base by construction, so it always
# looks merged.
#
# One caveat, stated because "never deletes" must be exactly true: unless
# --no-fetch is passed, this runs `git fetch --prune origin`, which drops
# refs/remotes/* entries whose upstream branch is already gone. That is a cache
# sync — no local branch, no remote branch, and nothing on the server is removed
# — and it is load-bearing: BASE detection below reads refs/remotes/origin/*, so
# a stale mirror would make a deleted base look alive. --no-fetch skips it.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The helpers live in this plugin, one level up: plugins/omp-build/skills/shared/lib.sh
# (ADR-020 §3 — omp-build resolves nothing into a sibling plugin at runtime).
# shellcheck source=../shared/lib.sh
. "${SCRIPT_DIR}/../shared/lib.sh"
OUTPUT_JSON=false
NO_FETCH=false
SCOPE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) OUTPUT_JSON=true; shift ;;
    --no-fetch) NO_FETCH=true; shift ;;
    --scope)
      SCOPE="${2#\#}"
      shift 2
      ;;
    --scope=*)
      SCOPE="${1#--scope=}"
      SCOPE="${SCOPE#\#}"
      shift
      ;;
    -h | --help)
      echo "Usage: analyze-branches.sh [--json] [--no-fetch] [--scope <#N>]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}
require_cmd git
require_cmd jq
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo "")"
GH_AVAILABLE=true
if ! command -v gh >/dev/null 2>&1; then
  GH_AVAILABLE=false
fi
if [ "$NO_FETCH" = false ]; then
  git fetch --prune origin 2>/dev/null || true
fi
# Detect base AFTER fetch --prune so a freshly-created (or remotely-deleted)
# origin/staging is reflected in the local remote-tracking refs before detection.
BASE_BRANCH="$(detect_base_branch)"
# Ref to compare branches against for merge detection: prefer the remote-tracking
# base (fresh after fetch --prune, and present even when the base branch is not
# checked out locally — the norm in the worktree-per-issue flow), else a local
# branch of that name. Empty when neither resolves, so the merge checks below skip
# rather than treat an unresolvable base as "0 commits ahead" (= false "merged").
if git rev-parse --verify --quiet "refs/remotes/origin/${BASE_BRANCH}" >/dev/null 2>&1; then
  BASE_REF="origin/${BASE_BRANCH}"
elif git rev-parse --verify --quiet "refs/heads/${BASE_BRANCH}" >/dev/null 2>&1; then
  BASE_REF="${BASE_BRANCH}"
else
  BASE_REF=""
fi
# Exact names only. The deploy/ prefix is decided in is_protected, which is
# also what the remote listing calls — do not add a second name list.
PROTECTED_JSON='["main","master","staging"]'
PR_LIMIT=1000
PR_JSON='[]'
PR_LIST_TRUNCATED=false
if [ "$GH_AVAILABLE" = true ]; then
  # headRefOid + mergeCommit travel with the state: `MERGED` alone is a label on a
  # PR, and the ancestry test below is what turns it into evidence about commits.
  PR_JSON="$(gh pr list --state all --limit "$PR_LIMIT" --json headRefName,number,state,title,headRefOid,mergeCommit 2>/dev/null || echo '[]')"
  if [ "$(echo "$PR_JSON" | jq 'length')" -eq "$PR_LIMIT" ]; then
    PR_LIST_TRUNCATED=true
  fi
fi
# shellcheck source=branch-analysis.sh
. "${SCRIPT_DIR}/branch-analysis.sh"
local_branches_json='[]'
while IFS= read -r branch_name; do
  [ -z "$branch_name" ] && continue
  if is_protected "$branch_name"; then
    continue
  fi
  if ! in_scope "$branch_name"; then
    continue
  fi
  entry="$(classify_branch "local" "$branch_name" "$branch_name")"
  local_branches_json="$(echo "$local_branches_json" | jq --argjson entry "$entry" '. + [$entry]')"
done < <(git branch --format='%(refname:short)' 2>/dev/null || true)
remote_branches_json='[]'
# Symbolic HEAD is not a branch. Protected names are not repeated in the
# listing below: the only check is is_protected (exact main/master/staging,
# prefix deploy/).
while IFS= read -r remote_ref; do
  [ -z "$remote_ref" ] && continue
  branch_name="${remote_ref#origin/}"
  if is_protected "$branch_name"; then
    continue
  fi
  if ! in_scope "$branch_name"; then
    continue
  fi
  entry="$(classify_branch "remote" "$branch_name" "$remote_ref")"
  remote_branches_json="$(echo "$remote_branches_json" | jq --argjson entry "$entry" '. + [$entry]')"
done < <(git branch -r 2>/dev/null | sed 's/^[[:space:]]*//' | while IFS= read -r ref; do
  case "$ref" in
    ""|*origin/HEAD*) continue ;;
  esac
  is_protected "${ref#origin/}" && continue
  printf '%s\n' "$ref"
done || true)
# `safe_*` selects on the proven action only. The hinted ones travel in their own
# lists so Step 4 / Step 6d can show them without a caller having to re-derive
# the distinction — re-deriving it downstream is how it gets lost.
safe_local_json="$(echo "$local_branches_json" | jq '[.[] | select(.action == "safe_delete") | .name]')"
safe_remote_json="$(echo "$remote_branches_json" | jq '[.[] | select(.action == "safe_delete") | .name]')"
probably_local_json="$(echo "$local_branches_json" | jq '[.[] | select(.action == "probably_merged") | .name]')"
probably_remote_json="$(echo "$remote_branches_json" | jq '[.[] | select(.action == "probably_merged") | .name]')"

result_json="$(jq -n \
  --arg current "$CURRENT_BRANCH" \
  --arg base "$BASE_BRANCH" \
  --arg scope "$SCOPE" \
  --argjson gh_available "$GH_AVAILABLE" \
  --argjson pr_list_truncated "$PR_LIST_TRUNCATED" \
  --argjson local "$local_branches_json" \
  --argjson remote "$remote_branches_json" \
  --argjson worktrees "$WORKTREE_JSON" \
  --argjson safe_local "$safe_local_json" \
  --argjson safe_remote "$safe_remote_json" \
  --argjson probably_local "$probably_local_json" \
  --argjson probably_remote "$probably_remote_json" \
  '{
    current: $current,
    base_branch: $base,
    scope: (if $scope == "" then null else $scope end),
    gh_available: $gh_available,
    pr_list_truncated: $pr_list_truncated,
    local_branches: $local,
    remote_branches: $remote,
    worktrees: $worktrees,
    safe_local: $safe_local,
    safe_remote: $safe_remote,
    probably_local: $probably_local,
    probably_remote: $probably_remote
  }')"

if [ "$OUTPUT_JSON" = true ]; then
  echo "$result_json" | jq .
  exit 0
fi

echo "---current---"
echo "$CURRENT_BRANCH"

echo "---base-branch---"
echo "$BASE_BRANCH"

echo "---scope---"
echo "${SCOPE:-none}"

echo "---gh-available---"
echo "$GH_AVAILABLE"

echo "---pr-list-truncated---"
echo "$PR_LIST_TRUNCATED"

echo "---local-branches---"
echo "$local_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "yes" else "no" end),
  .merge_reason,
  (if .commits_ahead == null then "?" else (.commits_ahead | tostring) end),
  .pr_label,
  (if .worktree == null then "—" else .worktree end),
  .last_commit,
  .action
] | @tsv' | while IFS=$'\t' read -r name merged reason ahead pr_label worktree last_commit action; do
  printf '%s\n' "$name|$merged|$reason|$ahead|$pr_label|$worktree|$last_commit|$action"
done

echo "---remote-branches---"
echo "$remote_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "yes" else "no" end),
  .merge_reason,
  (if .commits_ahead == null then "?" else (.commits_ahead | tostring) end),
  .pr_label,
  .last_commit,
  .action
] | @tsv' | while IFS=$'\t' read -r name merged reason ahead pr_label last_commit action; do
  printf '%s\n' "$name|$merged|$reason|$ahead|$pr_label|$last_commit|$action"
done

echo "---worktrees---"
echo "$WORKTREE_JSON" | jq -r '.[] | "\(.path)|\(.branch)"'

echo "---safe-local---"
echo "$safe_local_json" | jq -r '.[]'

echo "---safe-remote---"
echo "$safe_remote_json" | jq -r '.[]'

echo "---probably-local---"
echo "$probably_local_json" | jq -r '.[]'

echo "---probably-remote---"
echo "$probably_remote_json" | jq -r '.[]'

echo "---summary-table---"
printf '\nGit Cleanup Summary'
[ -n "$SCOPE" ] && printf ' (scoped to #%s)' "$SCOPE"
printf '\n'
printf '═══════════════════\n\n'
printf 'Local branches:\n'
printf '  %-30s │ %-6s │ %-20s │ %-5s │ %-12s │ %-20s │ %-12s │ %s\n' \
  "Branch" "Merged" "Evidence" "Ahead" "PR" "Worktree" "Last Commit" "Action"
echo "$local_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "✅ yes" elif .merge_reason == "none" then "❌ no" else "🔎 hint" end),
  .merge_reason,
  (if .commits_ahead == null then "?" else (.commits_ahead | tostring) end),
  .pr_label,
  (if .worktree == null then "—" else .worktree end),
  .last_commit,
  .action_label
] | @tsv' | while IFS=$'\t' read -r name merged reason ahead pr_label worktree last_commit action_label; do
  printf '  %-30s │ %-6s │ %-20s │ %-5s │ %-12s │ %-20s │ %-12s │ %s\n' \
    "$name" "$merged" "$reason" "$ahead" "$pr_label" "$worktree" "$last_commit" "$action_label"
done

printf '\nRemote branches:\n'
printf '  %-30s │ %-6s │ %-20s │ %-5s │ %-12s │ %-12s │ %s\n' \
  "Branch" "Merged" "Evidence" "Ahead" "PR" "Last Commit" "Action"
echo "$remote_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "✅ yes" elif .merge_reason == "none" then "❌ no" else "🔎 hint" end),
  .merge_reason,
  (if .commits_ahead == null then "?" else (.commits_ahead | tostring) end),
  .pr_label,
  .last_commit,
  .action_label
] | @tsv' | while IFS=$'\t' read -r name merged reason ahead pr_label last_commit action_label; do
  printf '  %-30s │ %-6s │ %-20s │ %-5s │ %-12s │ %-12s │ %s\n' \
    "$name" "$merged" "$reason" "$ahead" "$pr_label" "$last_commit" "$action_label"
done

# The verdict the operator approves, spelled out under the rows that carry it.
printf '\nEvidence: regular = commits are on %s · squash_pr = merged PR whose head is an\n' "${BASE_BRANCH}"
printf '  ancestor of its merge commit · squash_grep / squash_pr_unverified = a message\n'
printf '  matched, which proves nothing about these commits.\n'
printf '  Only the first two are "Safe to delete". 🔎 Probably merged is never pre-selected\n'
printf '  and never reaches the safe lists — verify it before deleting, remote above all:\n'
printf '  deleting a branch on the server has no unmerged check and leaves no copy.\n'
printf '  Ahead = commits in %s..<branch>; non-zero on a merged row is work added after it.\n' "${BASE_BRANCH}"

if [ "$(echo "$WORKTREE_JSON" | jq 'length')" -gt 0 ]; then
  printf '\nWorktrees:\n'
  printf '  %-40s │ %-24s\n' "Path" "Branch"
  echo "$WORKTREE_JSON" | jq -r '.[] | [.path, .branch] | @tsv' | while IFS=$'\t' read -r path branch; do
    printf '  %-40s │ %-24s\n' "$path" "$branch"
  done
fi

if [ "$PR_LIST_TRUNCATED" = true ]; then
  printf '\n⚠️  PR list truncated at %s — squash-merge detection may be incomplete.\n' "$PR_LIMIT"
fi

printf '\nSafe to delete (local): %s\n' "$(echo "$safe_local_json" | jq -r 'join(", ")' )"
printf 'Safe to delete (remote): %s\n' "$(echo "$safe_remote_json" | jq -r 'join(", ")' )"
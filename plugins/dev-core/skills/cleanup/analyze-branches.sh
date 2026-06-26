#!/usr/bin/env bash
# Usage: analyze-branches.sh [--json] [--no-fetch]
# Analyzes local and remote branches for /cleanup merge-status verification.
# Analyze-only — never deletes branches, worktrees, or remotes.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../shared/lib.sh
. "${SCRIPT_DIR}/../shared/lib.sh"

OUTPUT_JSON=false
NO_FETCH=false

for arg in "$@"; do
  case "$arg" in
    --json) OUTPUT_JSON=true ;;
    --no-fetch) NO_FETCH=true ;;
    -h | --help)
      echo "Usage: analyze-branches.sh [--json] [--no-fetch]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
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

BASE_BRANCH="$(detect_base_branch)"
CURRENT_BRANCH="$(git branch --show-current 2>/dev/null || echo "")"
GH_AVAILABLE=true
if ! command -v gh >/dev/null 2>&1; then
  GH_AVAILABLE=false
fi

if [ "$NO_FETCH" = false ]; then
  git fetch --prune origin 2>/dev/null || true
fi

PROTECTED_JSON='["main","master","staging"]'

PR_LIMIT=1000
PR_JSON='[]'
PR_LIST_TRUNCATED=false
if [ "$GH_AVAILABLE" = true ]; then
  PR_JSON="$(gh pr list --state all --limit "$PR_LIMIT" --json headRefName,number,state,title 2>/dev/null || echo '[]')"
  if [ "$(echo "$PR_JSON" | jq 'length')" -eq "$PR_LIMIT" ]; then
    PR_LIST_TRUNCATED=true
  fi
fi

worktree_json() {
  git worktree list --porcelain 2>/dev/null | awk '
    /^worktree / { path = substr($0, 10) }
    /^branch / {
      ref = substr($0, 8)
      sub(/^refs\/heads\//, "", ref)
      if (ref != "" && path != "") {
        printf "%s\t%s\n", ref, path
      }
      path = ""
    }
  ' | jq -Rn '
    [inputs
      | select(length > 0)
      | split("\t")
      | {branch: .[0], path: .[1]}
    ]
  ' || echo '[]'
}

WORKTREE_JSON="$(worktree_json)"

worktree_for_branch() {
  local branch="$1"
  echo "$WORKTREE_JSON" | jq -r --arg br "$branch" '.[] | select(.branch == $br) | .path' | head -1
}

is_protected() {
  local branch="$1"
  echo "$PROTECTED_JSON" | jq -e --arg br "$branch" 'index($br) != null' >/dev/null 2>&1
}

extract_issue_number() {
  local branch="$1"
  echo "$branch" | grep -oE '(^|/|-)([0-9]+)(/|-|_|$)' | grep -oE '[0-9]+' | head -1 || true
}

pr_for_branch() {
  local branch="$1"
  echo "$PR_JSON" | jq -c --arg br "$branch" '
    [.[] | select(.headRefName == $br)]
    | sort_by(
        if .state == "OPEN" then 0
        elif .state == "MERGED" then 1
        else 2 end
      )
    | .[0] // null
  '
}

branch_merged() {
  local ref="$1"
  local branch_name="$2"
  local merge_reason="none"
  local merged=false

  if git rev-parse --verify "$ref" >/dev/null 2>&1; then
    if [ -z "$(git log --oneline "${BASE_BRANCH}..${ref}" 2>/dev/null | head -1)" ]; then
      merged=true
      merge_reason="regular"
    fi
  fi

  if [ "$merged" = false ] && [ "$GH_AVAILABLE" = true ]; then
    local pr
    pr="$(pr_for_branch "$branch_name")"
    if [ "$pr" != "null" ] && [ "$(echo "$pr" | jq -r '.state')" = "MERGED" ]; then
      merged=true
      merge_reason="squash_pr"
    fi
  fi

  if [ "$merged" = false ]; then
    local issue
    issue="$(extract_issue_number "$branch_name")"
    if [ -n "$issue" ]; then
      if [ -n "$(git log --oneline --grep="#${issue}" "$BASE_BRANCH" 2>/dev/null | head -1)" ]; then
        merged=true
        merge_reason="squash_grep"
      fi
    fi
  fi

  if [ "$merged" = false ]; then
    if [ -n "$(git log --oneline --grep="${branch_name}" "$BASE_BRANCH" 2>/dev/null | head -1)" ]; then
      merged=true
      merge_reason="squash_grep"
    fi
  fi

  jq -n \
    --argjson merged "$merged" \
    --arg merge_reason "$merge_reason" \
    '{merged: $merged, merge_reason: $merge_reason}'
}

last_commit_age() {
  local ref="$1"
  git log -1 --format='%cr' "$ref" 2>/dev/null || echo "unknown"
}

classify_branch() {
  local scope="$1"
  local branch_name="$2"
  local ref="$3"

  local merged_info pr pr_number pr_state pr_label open_pr=false
  merged_info="$(branch_merged "$ref" "$branch_name")"
  local merged merge_reason
  merged="$(echo "$merged_info" | jq -r '.merged')"
  merge_reason="$(echo "$merged_info" | jq -r '.merge_reason')"

  pr="$(pr_for_branch "$branch_name")"
  pr_number="$(echo "$pr" | jq -r 'if . == null then "" else (.number | tostring) end')"
  pr_state="$(echo "$pr" | jq -r 'if . == null then "" else .state end')"
  if [ "$pr_state" = "OPEN" ]; then
    open_pr=true
    pr_label="#${pr_number} OPEN"
  elif [ -n "$pr_number" ]; then
    pr_label="#${pr_number} ${pr_state}"
  else
    pr_label="—"
  fi

  local worktree action action_label protected=false is_current=false
  worktree="$(worktree_for_branch "$branch_name")"
  if [ -z "$worktree" ]; then
    worktree="—"
  fi

  if is_protected "$branch_name"; then
    protected=true
    action="protected"
    action_label="🔒 Protected"
  elif [ "$branch_name" = "$CURRENT_BRANCH" ]; then
    is_current=true
    action="current"
    action_label="🔒 Current"
  elif [ "$open_pr" = true ]; then
    action="active_pr"
    action_label="⚠️ Active PR"
  elif [ "$merged" = true ]; then
    action="safe_delete"
    action_label="🗑 Safe to delete"
  else
    action="unmerged"
    action_label="⚠️ Unmerged"
  fi

  jq -n \
    --arg scope "$scope" \
    --arg name "$branch_name" \
    --arg ref "$ref" \
    --argjson merged "$merged" \
    --arg merge_reason "$merge_reason" \
    --arg pr_label "$pr_label" \
    --arg pr_number "$pr_number" \
    --arg pr_state "$pr_state" \
    --argjson open_pr "$open_pr" \
    --arg worktree "$worktree" \
    --arg last_commit "$(last_commit_age "$ref")" \
    --arg action "$action" \
    --arg action_label "$action_label" \
    --argjson protected "$protected" \
    --argjson is_current "$is_current" \
    '{
      scope: $scope,
      name: $name,
      ref: $ref,
      merged: $merged,
      merge_reason: $merge_reason,
      pr_label: $pr_label,
      pr_number: (if $pr_number == "" then null else ($pr_number | tonumber) end),
      pr_state: (if $pr_state == "" then null else $pr_state end),
      open_pr: $open_pr,
      worktree: (if $worktree == "—" then null else $worktree end),
      last_commit: $last_commit,
      action: $action,
      action_label: $action_label,
      protected: $protected,
      is_current: $is_current
    }'
}

local_branches_json='[]'
while IFS= read -r branch_name; do
  [ -z "$branch_name" ] && continue
  if is_protected "$branch_name"; then
    continue
  fi
  entry="$(classify_branch "local" "$branch_name" "$branch_name")"
  local_branches_json="$(echo "$local_branches_json" | jq --argjson entry "$entry" '. + [$entry]')"
done < <(git branch --format='%(refname:short)' 2>/dev/null || true)

remote_branches_json='[]'
while IFS= read -r remote_ref; do
  [ -z "$remote_ref" ] && continue
  branch_name="${remote_ref#origin/}"
  if is_protected "$branch_name"; then
    continue
  fi
  entry="$(classify_branch "remote" "$branch_name" "$remote_ref")"
  remote_branches_json="$(echo "$remote_branches_json" | jq --argjson entry "$entry" '. + [$entry]')"
done < <(git branch -r 2>/dev/null | sed 's/^[[:space:]]*//' | grep -vE 'origin/HEAD|origin/main$|origin/master$|origin/staging$' || true)

safe_local_json="$(echo "$local_branches_json" | jq '[.[] | select(.action == "safe_delete") | .name]')"
safe_remote_json="$(echo "$remote_branches_json" | jq '[.[] | select(.action == "safe_delete") | .name]')"

result_json="$(jq -n \
  --arg current "$CURRENT_BRANCH" \
  --arg base "$BASE_BRANCH" \
  --argjson gh_available "$GH_AVAILABLE" \
  --argjson pr_list_truncated "$PR_LIST_TRUNCATED" \
  --argjson local "$local_branches_json" \
  --argjson remote "$remote_branches_json" \
  --argjson worktrees "$WORKTREE_JSON" \
  --argjson safe_local "$safe_local_json" \
  --argjson safe_remote "$safe_remote_json" \
  '{
    current: $current,
    base_branch: $base,
    gh_available: $gh_available,
    pr_list_truncated: $pr_list_truncated,
    local_branches: $local,
    remote_branches: $remote,
    worktrees: $worktrees,
    safe_local: $safe_local,
    safe_remote: $safe_remote
  }')"

if [ "$OUTPUT_JSON" = true ]; then
  echo "$result_json" | jq .
  exit 0
fi

echo "---current---"
echo "$CURRENT_BRANCH"

echo "---base-branch---"
echo "$BASE_BRANCH"

echo "---gh-available---"
echo "$GH_AVAILABLE"

echo "---pr-list-truncated---"
echo "$PR_LIST_TRUNCATED"

echo "---local-branches---"
echo "$local_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "yes" else "no" end),
  .pr_label,
  (if .worktree == null then "—" else .worktree end),
  .last_commit,
  .action
] | @tsv' | while IFS=$'\t' read -r name merged pr_label worktree last_commit action; do
  printf '%s\n' "$name|$merged|$pr_label|$worktree|$last_commit|$action"
done

echo "---remote-branches---"
echo "$remote_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "yes" else "no" end),
  .pr_label,
  .last_commit,
  .action
] | @tsv' | while IFS=$'\t' read -r name merged pr_label last_commit action; do
  printf '%s\n' "$name|$merged|$pr_label|$last_commit|$action"
done

echo "---worktrees---"
echo "$WORKTREE_JSON" | jq -r '.[] | "\(.path)|\(.branch)"'

echo "---safe-local---"
echo "$safe_local_json" | jq -r '.[]'

echo "---safe-remote---"
echo "$safe_remote_json" | jq -r '.[]'

echo "---summary-table---"
printf '\nGit Cleanup Summary\n'
printf '═══════════════════\n\n'
printf 'Local branches:\n'
printf '  %-36s │ %-6s │ %-12s │ %-24s │ %-12s │ %s\n' \
  "Branch" "Merged" "PR" "Worktree" "Last Commit" "Action"
echo "$local_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "✅ yes" else "❌ no" end),
  .pr_label,
  (if .worktree == null then "—" else .worktree end),
  .last_commit,
  .action_label
] | @tsv' | while IFS=$'\t' read -r name merged pr_label worktree last_commit action_label; do
  printf '  %-36s │ %-6s │ %-12s │ %-24s │ %-12s │ %s\n' \
    "$name" "$merged" "$pr_label" "$worktree" "$last_commit" "$action_label"
done

printf '\nRemote branches:\n'
printf '  %-36s │ %-6s │ %-12s │ %-12s │ %s\n' \
  "Branch" "Merged" "PR" "Last Commit" "Action"
echo "$remote_branches_json" | jq -r '.[] | [
  .name,
  (if .merged then "✅ yes" else "❌ no" end),
  .pr_label,
  .last_commit,
  .action_label
] | @tsv' | while IFS=$'\t' read -r name merged pr_label last_commit action_label; do
  printf '  %-36s │ %-6s │ %-12s │ %-12s │ %s\n' \
    "$name" "$merged" "$pr_label" "$last_commit" "$action_label"
done

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
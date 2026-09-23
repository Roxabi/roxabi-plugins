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
# (main/master/staging) or checked out here can never reach `safe_delete` — see
# classify_branch.
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

in_scope() {
  local branch="$1"
  [ -z "$SCOPE" ] && return 0
  [ "$(extract_issue_number "$branch")" = "$SCOPE" ]
}

# --scope <#N> restricts worktree reporting to the given issue — reuses the
# same anchored extract_issue_number() boundary as the branch filters below, so
# #1 can't pick up #14's worktree. The anchor is the regex above: the character
# before the number is start-of-string or `/`/`-`, the one after is `/`, `-`, `_`
# or end. An unanchored substring match makes `--scope 19` sweep `feat/319-*`.
if [ -n "$SCOPE" ]; then
  WORKTREE_JSON="$(echo "$WORKTREE_JSON" | jq -c '.[]' | while IFS= read -r wt_entry; do
    wt_branch="$(echo "$wt_entry" | jq -r '.branch')"
    if [ "$(extract_issue_number "$wt_branch")" = "$SCOPE" ]; then
      echo "$wt_entry"
    fi
  done | jq -s '.')"
fi

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

# Merge evidence, ranked by what it proves. The ranking is the safety property,
# not presentation:
#
#   regular    — `BASE..ref` is empty. The commits are on the base. Proof.
#   squash_pr  — gh says a PR on this head is MERGED *and* that PR's head SHA is
#                an ancestor of the commit that merged it. Proof.
#   squash_grep— some commit message on BASE contains `#<issue>` or the branch
#                name. Any commit can type `#50` while referring to it; this says
#                nothing about whether *these* commits shipped. A hint, not proof.
#
# Collapsing the three into one boolean is how an unmerged branch reaches
# `git push origin --delete`: git itself refuses `branch -d` on unmerged work, so
# the local half is backstopped — but nothing refuses a remote delete, and the
# server copy is the last one. So the reason travels with the verdict: `merged`
# is true only for a proof, and classify_branch routes a hint to
# `probably_merged` instead of `safe_delete`.
#
# `commits_ahead` travels too, for the case the proofs do not cover: commits
# pushed *after* the PR merged are still ahead of BASE, and the operator only
# sees that if the number is on the row they approve.
branch_merged() {
  local ref="$1"
  local branch_name="$2"
  local merge_reason="none"
  local merged=false
  local commits_ahead=""

  if [ -n "$BASE_REF" ] && git rev-parse --verify "$ref" >/dev/null 2>&1; then
    commits_ahead="$(git rev-list --count "${BASE_REF}..${ref}" 2>/dev/null || echo "")"
    if [ "$commits_ahead" = "0" ]; then
      merged=true
      merge_reason="regular"
    fi
  fi

  if [ "$merged" = false ] && [ "$GH_AVAILABLE" = true ]; then
    local pr pr_head pr_merge
    pr="$(pr_for_branch "$branch_name")"
    if [ "$pr" != "null" ] && [ "$(echo "$pr" | jq -r '.state')" = "MERGED" ]; then
      pr_head="$(echo "$pr" | jq -r '.headRefOid // ""')"
      pr_merge="$(echo "$pr" | jq -r '.mergeCommit.oid // ""')"
      if [ -n "$pr_head" ] && [ -n "$pr_merge" ] &&
        git merge-base --is-ancestor "$pr_head" "$pr_merge" 2>/dev/null; then
        merged=true
        merge_reason="squash_pr"
      else
        # MERGED, but the ancestry could not be shown here — the objects may not
        # be fetched, or the PR's head moved after the merge. Reported, not proven.
        merge_reason="squash_pr_unverified"
      fi
    fi
  fi

  if [ "$merged" = false ] && [ "$merge_reason" = "none" ]; then
    local issue
    issue="$(extract_issue_number "$branch_name")"
    if [ -n "$issue" ]; then
      if [ -n "$BASE_REF" ] && [ -n "$(git log --oneline --grep="#${issue}" "$BASE_REF" 2>/dev/null | head -1)" ]; then
        merge_reason="squash_grep"
      fi
    fi
  fi

  if [ "$merged" = false ] && [ "$merge_reason" = "none" ]; then
    if [ -n "$BASE_REF" ] && [ -n "$(git log --oneline --grep="${branch_name}" "$BASE_REF" 2>/dev/null | head -1)" ]; then
      merge_reason="squash_grep"
    fi
  fi

  jq -n \
    --argjson merged "$merged" \
    --arg merge_reason "$merge_reason" \
    --arg commits_ahead "$commits_ahead" \
    '{
      merged: $merged,
      merge_reason: $merge_reason,
      commits_ahead: (if $commits_ahead == "" then null else ($commits_ahead | tonumber) end)
    }'
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
  local merged merge_reason commits_ahead
  merged="$(echo "$merged_info" | jq -r '.merged')"
  merge_reason="$(echo "$merged_info" | jq -r '.merge_reason')"
  commits_ahead="$(echo "$merged_info" | jq -r 'if .commits_ahead == null then "" else (.commits_ahead | tostring) end')"

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
  elif [ "$merge_reason" != "none" ]; then
    # Evidence exists but proves nothing about these commits. Its own action, so
    # the operator answers a verdict instead of a checkmark — and so `safe_local`
    # / `safe_remote`, which select on `safe_delete`, cannot pick it up.
    action="probably_merged"
    action_label="🔎 Probably merged — verify"
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
    --arg commits_ahead "$commits_ahead" \
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
      commits_ahead: (if $commits_ahead == "" then null else ($commits_ahead | tonumber) end),
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
  if ! in_scope "$branch_name"; then
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
  if ! in_scope "$branch_name"; then
    continue
  fi
  entry="$(classify_branch "remote" "$branch_name" "$remote_ref")"
  remote_branches_json="$(echo "$remote_branches_json" | jq --argjson entry "$entry" '. + [$entry]')"
done < <(git branch -r 2>/dev/null | sed 's/^[[:space:]]*//' | grep -vE 'origin/HEAD|origin/main$|origin/master$|origin/staging$' || true)

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
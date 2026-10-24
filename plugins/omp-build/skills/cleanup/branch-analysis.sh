# Sourced branch classification helpers; entry owns CLI parsing, setup, collection, and rendering.
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
  # deploy/* is a CD production branch: Cloudflare builds deploy/<branch>,
  # fast-forwarded from the base, so it is an ancestor by construction and
  # merge detection always calls it merged. The prefix lives only here.
  case "$branch" in
    deploy/*) return 0 ;;
  esac
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

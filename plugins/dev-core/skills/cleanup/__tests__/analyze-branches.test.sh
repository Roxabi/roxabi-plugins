#!/usr/bin/env bash
# Integration test for analyze-branches.sh using a temporary git fixture.
set -euo pipefail

# Isolate from any inherited git context. This fixture builds a throwaway repo
# via mktemp + cd + git init and relies on cwd-based repo discovery — but a git
# hook (e.g. pre-push, which runs this suite) exports GIT_DIR/GIT_WORK_TREE into
# the environment, and those override cwd discovery. Without clearing them the
# fixture's `git branch -M main`, `git worktree add`, etc. would target the
# caller's REAL repository instead of the temp one below.
unset $(git rev-parse --local-env-vars)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE="${SCRIPT_DIR}/../analyze-branches.sh"

TMPDIR_FIXTURE="$(mktemp -d)"
WT_DIR="${TMPDIR_FIXTURE}/wt-i18n"
trap 'rm -rf "$TMPDIR_FIXTURE" "${ORIGIN_ROOT:-}"' EXIT

cd "$TMPDIR_FIXTURE"
git init -q
git config user.email "test@example.com"
git config user.name "Test User"

echo "base" > README.md
git add README.md
git commit -q -m "chore: init main"
git branch -M main

echo "merged" > merged.txt
git checkout -q -b feat/19-auth
git add merged.txt
git commit -q -m "feat: auth (#19)"
git checkout -q main
git merge -q --no-ff feat/19-auth -m "Merge pull request #19 from feat/19-auth"

echo "wip" > wip.txt
git checkout -q -b feat/33-i18n
git add wip.txt
git commit -q -m "feat: i18n work in progress"

git checkout -q main
git worktree add -q "$WT_DIR" feat/33-i18n

# Scope-collision fixture (#2 / F1-style): a branch whose number *contains*
# 19 as a substring but is a different issue — must not leak into --scope 19.
echo "unrelated" > other.txt
git checkout -q -b feat/319-other-thing
git add other.txt
git commit -q -m "chore: unrelated branch (#319)"
git checkout -q main

DEBUG_JSON=""
assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label expected '$expected', got '$actual'" >&2
    echo "$DEBUG_JSON" | jq . >&2
    exit 1
  fi
}

result="$("$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$result"

safe_local="$(echo "$result" | jq -r '.safe_local | join(",")')"
safe_remote="$(echo "$result" | jq -r '.safe_remote | join(",")')"
i18n_action="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/33-i18n") | .action')"
auth_action="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/19-auth") | .action')"
auth_merged="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/19-auth") | .merged')"
i18n_worktree="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/33-i18n") | .worktree')"

assert_eq "safe_local includes feat/19-auth" "feat/19-auth" "$safe_local"
assert_eq "feat/19-auth action" "safe_delete" "$auth_action"
assert_eq "feat/19-auth merged" "true" "$auth_merged"
assert_eq "feat/33-i18n action" "unmerged" "$i18n_action"
assert_eq "feat/33-i18n has worktree" "true" "$(if [ "$i18n_worktree" != "null" ] && [ -n "$i18n_worktree" ]; then echo true; else echo false; fi)"
assert_eq "safe_remote empty without origin" "" "$safe_remote"
assert_eq "unscoped run sees all 3 local branches" "3" "$(echo "$result" | jq '.local_branches | length')"

# --scope 19 (F2): must include only feat/19-auth — excluding both
# feat/33-i18n (different issue) and feat/319-other-thing (substring
# collision: "19" ⊂ "319", would false-match an unanchored scope filter).
result_scoped="$("$ANALYZE" --json --no-fetch --scope 19)"
DEBUG_JSON="$result_scoped"

scoped_scope="$(echo "$result_scoped" | jq -r '.scope')"
scoped_names="$(echo "$result_scoped" | jq -r '[.local_branches[].name] | join(",")')"

assert_eq "--scope 19 echoed in JSON" "19" "$scoped_scope"
assert_eq "--scope 19 includes only feat/19-auth (excludes #33, #319)" "feat/19-auth" "$scoped_names"

# --scope with a leading '#' (as /dev passes it: `cleanup --scope #N`).
result_hash_scoped="$("$ANALYZE" --json --no-fetch --scope "#19")"
DEBUG_JSON="$result_hash_scoped"
assert_eq "--scope #19 strips the leading #" "19" "$(echo "$result_hash_scoped" | jq -r '.scope')"

# Regression: base present only as origin/<base>, not checked out locally (the
# worktree-per-issue norm). branch_merged must resolve origin/<base> and must NOT
# mis-classify an unmerged branch as safe_delete just because no LOCAL base branch
# exists. Before the BASE_REF fix, `git log staging..feat/50-thing` errored (no
# local staging) -> empty stdout -> merged=true -> safe_delete.
ORIGIN_ROOT="$(mktemp -d)"
git init -q --bare "${ORIGIN_ROOT}/origin.git"
git init -q "${ORIGIN_ROOT}/work"
cd "${ORIGIN_ROOT}/work"
git config user.email "test@example.com"
git config user.name "Test User"
git remote add origin "${ORIGIN_ROOT}/origin.git"
echo base > f.txt
git add f.txt
git commit -q -m "chore: base"
git branch -M staging
git push -q -u origin staging
echo wip > wip.txt
git checkout -q -b feat/50-thing
git add wip.txt
git commit -q -m "feat: wip (#50)"
git checkout -q -b scratch        # sit off the feature so it is not the current branch
git branch -q -D staging          # only origin/staging remains as the base ref
git fetch -q origin               # ensure the origin/staging tracking ref exists

result_origin="$("$ANALYZE" --json --no-fetch)"
DEBUG_JSON="$result_origin"
origin_base="$(echo "$result_origin" | jq -r '.base_branch')"
feat50_action="$(echo "$result_origin" | jq -r '.local_branches[] | select(.name == "feat/50-thing") | .action')"
feat50_merged="$(echo "$result_origin" | jq -r '.local_branches[] | select(.name == "feat/50-thing") | .merged')"

assert_eq "origin-only base resolves to staging" "staging" "$origin_base"
assert_eq "unmerged branch NOT safe_delete when base only on origin/*" "unmerged" "$feat50_action"
assert_eq "unmerged branch merged=false when base only on origin/*" "false" "$feat50_merged"

echo "PASS: analyze-branches.test.sh"
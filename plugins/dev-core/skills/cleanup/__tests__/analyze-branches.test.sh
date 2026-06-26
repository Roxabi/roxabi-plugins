#!/usr/bin/env bash
# Integration test for analyze-branches.sh using a temporary git fixture.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ANALYZE="${SCRIPT_DIR}/../analyze-branches.sh"

TMPDIR_FIXTURE="$(mktemp -d)"
WT_DIR="${TMPDIR_FIXTURE}/wt-i18n"
trap 'rm -rf "$TMPDIR_FIXTURE"' EXIT

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

result="$("$ANALYZE" --json --no-fetch)"

safe_local="$(echo "$result" | jq -r '.safe_local | join(",")')"
safe_remote="$(echo "$result" | jq -r '.safe_remote | join(",")')"
i18n_action="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/33-i18n") | .action')"
auth_action="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/19-auth") | .action')"
auth_merged="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/19-auth") | .merged')"
i18n_worktree="$(echo "$result" | jq -r '.local_branches[] | select(.name == "feat/33-i18n") | .worktree')"

assert_eq() {
  local label="$1"
  local expected="$2"
  local actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label expected '$expected', got '$actual'" >&2
    echo "$result" | jq . >&2
    exit 1
  fi
}

assert_eq "safe_local includes feat/19-auth" "feat/19-auth" "$safe_local"
assert_eq "feat/19-auth action" "safe_delete" "$auth_action"
assert_eq "feat/19-auth merged" "true" "$auth_merged"
assert_eq "feat/33-i18n action" "unmerged" "$i18n_action"
assert_eq "feat/33-i18n has worktree" "true" "$(if [ "$i18n_worktree" != "null" ] && [ -n "$i18n_worktree" ]; then echo true; else echo false; fi)"
assert_eq "safe_remote empty without origin" "" "$safe_remote"

echo "PASS: analyze-branches.test.sh"
#!/usr/bin/env bash
# Integration test for lib.sh worktree helpers (principal freeze + branch-first detect).
set -euo pipefail

# Isolate from any inherited git context (hooks export GIT_DIR/GIT_WORK_TREE).
unset $(git rev-parse --local-env-vars 2>/dev/null || true)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$SCRIPT_DIR/../lib.sh"

TMPDIR_FIXTURE="$(mktemp -d)"
WT_CLAUDE="${TMPDIR_FIXTURE}/.claude/worktrees/42-dark-mode"
WT_GROK="${TMPDIR_FIXTURE}/.grok-like/99-other"
trap 'rm -rf "$TMPDIR_FIXTURE"' EXIT

cd "$TMPDIR_FIXTURE"
git init -q
git config user.email "test@example.com"
git config user.name "Test User"
git remote add origin "git@github.com:Roxabi/roxabi-plugins.git"

echo "base" > README.md
git add README.md
git commit -q -m "chore: init"
git branch -M main

# Feature branches off main
git branch feat/42-dark-mode main
git branch feat/7-foo main
git branch feat/70-bar main

mkdir -p "$(dirname "$WT_CLAUDE")" "$(dirname "$WT_GROK")"
git worktree add -q "$WT_CLAUDE" feat/42-dark-mode
git worktree add -q "$WT_GROK" feat/7-foo

assert_eq() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label expected '$expected', got '$actual'" >&2
    exit 1
  fi
}

# Principal is first worktree, on main
p="$(principal_worktree_path)"
assert_eq "principal path is fixture root" "$TMPDIR_FIXTURE" "$p"
assert_eq "principal branch main" "main" "$(principal_branch)"
is_base_branch "$(principal_branch)"
assert_eq "is_base_branch main" "0" "$?"

# find by branch — Claude layout path
found42="$(find_feature_worktree 42 dark-mode)"
assert_eq "find #42" "$WT_CLAUDE" "$found42"

# find by branch — non-Claude path (Grok-like) still works
found7="$(find_feature_worktree 7 foo)"
assert_eq "find #7 non-claude path" "$WT_GROK" "$found7"

# anchored: N=7 must not match feat/70-bar (no worktree for 70)
found70="$(find_feature_worktree 70 bar || true)"
assert_eq "N=70 no worktree" "" "${found70:-}"

# N=7 must not match something under 70
found7b="$(find_feature_worktree 7)"
assert_eq "N=7 still only feat/7-foo" "$WT_GROK" "$found7b"

# principal must never be returned as feature worktree
# (simulate mis-checkout: if principal were on feat, still exclude it)
# Here principal is main — empty for missing issue
found999="$(find_feature_worktree 999 missing || true)"
assert_eq "missing issue empty" "" "${found999:-}"

# is_base_branch negatives
is_base_branch "feat/42-dark-mode" && exit 1 || true
is_base_branch "staging"
assert_eq "is_base_branch staging" "0" "$?"

# suggested_grok_worktree_path uses origin remote slug Roxabi → Roxabi-roxabi-plugins
# (owner alnum only)
gpath="$(suggested_grok_worktree_path 42 dark-mode)"
case "$gpath" in
  */.grok/worktrees/Roxabiroxabi-plugins/42-dark-mode|*/.grok/worktrees/Roxabi-roxabi-plugins/42-dark-mode)
    ;;
  *)
    # owner "Roxabi" is already alnum → Roxabi-roxabi-plugins
    expected_suffix="/.grok/worktrees/Roxabi-roxabi-plugins/42-dark-mode"
    case "$gpath" in
      *"$expected_suffix") ;;
      *)
        echo "FAIL: suggested_grok_worktree_path got '$gpath'" >&2
        exit 1
        ;;
    esac
    ;;
esac

# Principal still on main after all worktree ops
assert_eq "principal still main" "main" "$(principal_branch)"

echo "PASS: lib-worktree.test.sh"

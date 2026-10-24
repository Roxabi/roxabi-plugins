#!/usr/bin/env bash
# Usage: scan-orphan-worktree-shells.sh [--yes-targets]
# Analyze-only — never deletes. Emits one line per entry: path|kind|detail
#   kind ∈ empty_parent | empty_untracked | unregistered | inside_worktree |
#          nested_git | symlink | symlink_root | dangling_git | not_a_dir |
#          unreadable | unsafe_name
#
# --yes-targets is an allowlist: it emits ONLY `empty_parent` rows — a real,
# readable, searchable directory (`[ -d ] && [ ! -L ] && [ -r ] && [ -x ]`),
# empty, outside any git work tree, with no symlink component between its
# trusted anchor and itself. 5b deletes those with `rmdir` only, never
# `rm -rf`. Every other kind needs a per-row confirmation (or is not
# selectable at all).
#
# Finds leftover worktree *shells* that `git worktree list` misses after
# `git worktree remove`. It scans three roots, and nothing else:
#
#   1. ~/.omp/worktrees/<repo>/            — legacy leftover of the retired
#      `ensureWorktree`. Anchor: $HOME (or the parent of OMP_WORKTREES_ROOT).
#   2. <principal>/.claude/worktrees/      — harness-created worktrees.
#      Anchor: the principal.
#   3. <worktree base>/<repo>/             — the `/feature` root. Base is
#      OMP_WORKTREE_DIR, else stack.yml worktree.base, else ~/.omp/wt; a
#      relative base resolves against the principal. Anchor: the principal when
#      the base lies under it, else the base itself.
#
# Every anchor is canonical and every root is built lexically below it, so a
# root whose realpath differs from its spelling has a symlink component below
# the anchor: it is reported as `symlink_root` and its children are not listed.
#
# A child with `.git` is listed only when its `gitdir:` resolves under this
# repo's absolute `git-common-dir`/worktrees. The principal, anything under it
# outside an untracked harness / feature root, anything under a registered
# worktree, and anything that contains the principal or a registered worktree
# are skipped. Rows carry the lexical scanned entry; matching uses realpath.
set -euo pipefail

# Ambient GIT_* from a hook or an outer harness redirect every `git -C` to the
# wrong repository. Drop the known overrides so ownership is path-local.
unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_CEILING_DIRECTORIES
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

YES_TARGETS=false
for arg in "$@"; do
  case "$arg" in
    --yes-targets) YES_TARGETS=true ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# shellcheck source=orphan-scan-config.sh
. "${SCRIPT_DIR}/orphan-scan-config.sh"
# shellcheck source=orphan-scan-classify.sh
. "${SCRIPT_DIR}/orphan-scan-classify.sh"

# --- 1) ~/.omp/worktrees/<repo>/ ---
if [ -n "${OMP_WORKTREES_ROOT:-}" ]; then
  legacy_anchor="$(canon "$(dirname -- "$OMP_WORKTREES_ROOT")")"
  legacy_root="$legacy_anchor/$(basename -- "$OMP_WORKTREES_ROOT")"
else
  legacy_anchor="$(canon "$HOME")"
  legacy_root="$legacy_anchor/.omp/worktrees"
fi
scan_root "$legacy_root/$repo_name" "~/.omp/worktrees" "$legacy_anchor"

# --- 2) <principal>/.claude/worktrees/ ---
scan_root "$claude_root" ".claude/worktrees" "$principal"

# --- 3) <worktree base>/<repo>/ ---
if [[ "$wt_base" == "$principal" || "$wt_base" == "$principal"/* ]]; then
  feature_anchor="$principal"
else
  feature_anchor="$wt_base"
fi
scan_root "$feature_root" "worktree-base" "$feature_anchor"

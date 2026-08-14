#!/usr/bin/env bash
# Principal freeze — lefthook / pre-commit gate.
# Fail if THIS worktree is the principal checkout AND HEAD ∉ {staging, main, master}.
# Feature worktrees are a no-op. Hatch: DEV_CORE_ALLOW_PRINCIPAL_SWITCH=1 (not printed).
set -euo pipefail

if [ "${DEV_CORE_ALLOW_PRINCIPAL_SWITCH:-}" = "1" ]; then
  exit 0
fi

git_probe() {
  # Strip decoy GIT_* so a hook env cannot redirect probes (same axis as former plugin hook).
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_COMMON_DIR \
    -u GIT_OBJECT_DIRECTORY -u GIT_INDEX_FILE \
    -u GIT_ALTERNATE_OBJECT_DIRECTORIES -u GIT_CEILING_DIRECTORIES \
    git "$@"
}

top=""
if ! top=$(git_probe rev-parse --show-toplevel 2>/dev/null); then
  exit 0
fi
if [ -z "$top" ]; then
  echo "Principal freeze: could not verify git toplevel." >&2
  exit 1
fi

porcelain=""
if ! porcelain=$(git_probe worktree list --porcelain 2>/dev/null); then
  echo "Principal freeze: could not list worktrees." >&2
  exit 1
fi

principal=$(printf '%s\n' "$porcelain" | awk '/^worktree / { print substr($0, 10); exit }')
if [ -z "$principal" ]; then
  echo "Principal freeze: could not resolve principal worktree." >&2
  exit 1
fi

realpath_safe() {
  if command -v realpath >/dev/null 2>&1; then
    realpath "$1"
  else
    (cd "$1" && pwd -P)
  fi
}

if [ "$(realpath_safe "$top")" != "$(realpath_safe "$principal")" ]; then
  exit 0
fi

branch=""
if ! branch=$(git_probe -C "$principal" rev-parse --abbrev-ref HEAD 2>/dev/null); then
  echo "Principal freeze: could not read principal HEAD." >&2
  exit 1
fi
if [ -z "$branch" ] || [ "$branch" = "HEAD" ]; then
  echo "Principal freeze: principal HEAD is detached. Restore staging|main." >&2
  exit 1
fi

b="$branch"
b="${b#refs/heads/}"
b="${b#origin/}"

case "$b" in
  staging | main | master) exit 0 ;;
  *)
    echo "Principal freeze: principal HEAD is '${branch}', expected staging|main|master." >&2
    echo "Feature work belongs in a dedicated worktree (/setup-worktree or /dev #N)." >&2
    echo "Restore: git -C ${principal} switch staging  # or main" >&2
    exit 1
    ;;
esac

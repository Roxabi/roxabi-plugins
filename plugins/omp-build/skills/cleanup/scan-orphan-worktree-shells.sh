#!/usr/bin/env bash
# Usage: scan-orphan-worktree-shells.sh
# Analyze-only — never deletes. Emits lines: path|kind|detail
# kind ∈ empty_parent | unregistered
#
# Finds leftover worktree *shells* that `git worktree list` misses after
# `git worktree remove`. It scans the two roots THIS plugin creates worktrees in,
# and nothing else:
#
#   1. ~/.omp/worktrees/<repo>/<type>-<issue>-<slug>  — skills/build/workflow.js
#      `resolveNames`, the path `ensureWorktree` hands to `git worktree add`.
#   2. <repo>/.claude/worktrees/<…>                   — harness-created worktrees.
#
# dev-core's copy scanned ~/.grok/worktrees/<slug>/ and deleted rows from a Grok
# `worktrees.db` via sqlite3. omp-build ships neither the Grok harness nor a
# writer for that database, and it never puts a worktree under that root — so
# those branches could only ever report zero, while the root this plugin does use
# went unscanned. Both are repointed rather than copied (ADR-020 §3).
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "orphan_shells=none"
  exit 0
fi

# Registered worktree paths (absolute), and the principal — the FIRST porcelain
# entry. Both scan roots hang off the principal, never off `rev-parse
# --show-toplevel`: inside a linked worktree that returns the worktree's own
# directory, so `<toplevel>/.claude/worktrees` would name a path that does not
# exist and the scan would report zero orphans from every ω — exactly the place
# /cleanup is normally run from.
declare -A REGISTERED=()
principal=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      p="${line#worktree }"
      REGISTERED["$p"]=1
      [ -n "$principal" ] || principal="$p"
      ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null || true)
[ -n "$principal" ] || principal="$repo_root"

emit() {
  # path|kind|detail
  printf '%s|%s|%s\n' "$1" "$2" "$3"
}

is_registered() {
  local p="$1"
  [ -n "${REGISTERED[$p]+x}" ]
}

# True if directory has at least one entry (incl. hidden). Avoids
# `find | head` under `set -o pipefail` (SIGPIPE → exit 141).
dir_has_entries() {
  local d="$1" e
  shopt -s nullglob dotglob
  e=("$d"/*)
  shopt -u nullglob dotglob
  [ "${#e[@]}" -gt 0 ]
}

# Classify one candidate directory and emit it, unless git still tracks it.
# `.git` present but unregistered = a half-removed worktree; empty = a leftover
# shell; content without `.git` = an orphan (typically node_modules survived).
classify_child() {
  local child="$1" origin="$2"
  [ -e "$child" ] || return 0
  is_registered "$child" && return 0
  if [ -e "$child/.git" ]; then
    emit "$child" "unregistered" "has .git but not in git worktree list ($origin)"
  elif ! dir_has_entries "$child"; then
    emit "$child" "empty_parent" "empty leftover after worktree remove ($origin)"
  else
    emit "$child" "unregistered" "content without git registration ($origin)"
  fi
}

# Scan one root's depth-1 children; an existing-but-childless root is itself a shell.
scan_root() {
  local root="$1" origin="$2"
  [ -d "$root" ] || return 0
  local children=()
  shopt -s nullglob
  children=("$root"/*)
  shopt -u nullglob
  if [ "${#children[@]}" -eq 0 ]; then
    emit "$root" "empty_parent" "empty worktree parent ($origin)"
    return 0
  fi
  local child
  for child in "${children[@]}"; do
    classify_child "$child" "$origin"
  done
}

# --- 1) ~/.omp/worktrees/<repo>/ — the root ensureWorktree writes to ---
# The <repo> segment is the principal's directory name, exactly as workflow.js
# derives it. Scoped to this repo: a sibling checkout's worktrees are not ours to
# report on, let alone offer for deletion.
OMP_WT_ROOT="${OMP_WORKTREES_ROOT:-$HOME/.omp/worktrees}"
scan_root "$OMP_WT_ROOT/$(basename "$principal")" "~/.omp/worktrees"

# --- 2) <principal>/.claude/worktrees/* ---
scan_root "$principal/.claude/worktrees" ".claude/worktrees"

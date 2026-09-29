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

YES_TARGETS=false
for arg in "$@"; do
  case "$arg" in
    --yes-targets) YES_TARGETS=true ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "orphan_shells=none"
  exit 0
fi

# canon: physical path, missing components allowed. lexical: `.`/`..` folded
# without resolving symlinks. GNU realpath has both; elsewhere use python3.
if realpath -m / >/dev/null 2>&1; then
  canon() { realpath -m -- "$1"; }
  lexical() { realpath -ms -- "$1"; }
else
  canon() { python3 -c 'import os, sys; print(os.path.realpath(sys.argv[1]))' "$1"; }
  lexical() { python3 -c 'import os, sys; print(os.path.normpath(sys.argv[1]))' "$1"; }
fi

declare -A REGISTERED=()
principal=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      p="$(canon "${line#worktree }")"
      REGISTERED["$p"]=1
      [ -n "$principal" ] || principal="$p"
      ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null || true)
[ -n "$principal" ] || principal="$(canon "$repo_root")"
repo_name="$(basename "$principal")"

common_dir="$(git rev-parse --path-format=absolute --git-common-dir)"
ours_worktrees="$(canon "$common_dir")/worktrees"

# An in-principal root is scanned only while git tracks nothing under it.
untracked_in_principal() {
  [ -z "$(git -C "$principal" ls-files -- "$1" 2>/dev/null)" ]
}

claude_root="$principal/.claude/worktrees"
claude_root_exempt=false
untracked_in_principal "$claude_root" && claude_root_exempt=true

wt_base="${OMP_WORKTREE_DIR:-}"
if [ -z "$wt_base" ] && [ -f "$principal/.dev/stack.yml" ]; then
  wt_base="$(python3 - "$principal/.dev/stack.yml" << 'PY'
import sys
section = None
for raw in open(sys.argv[1], encoding="utf-8"):
    text = raw.split("#", 1)[0].rstrip()
    if not text.strip():
        continue
    indent = len(text) - len(text.lstrip(" "))
    stripped = text.strip()
    if indent == 0 and stripped.endswith(":"):
        section = stripped[:-1]
        continue
    if section == "worktree" and indent == 2 and stripped.startswith("base:"):
        print(stripped.split(":", 1)[1].strip().strip("'\""))
        break
PY
)"
fi
case "$wt_base" in
  "~") wt_base="$HOME" ;;
  "~/"*) wt_base="$HOME/${wt_base:2}" ;;
  "") wt_base="$HOME/.omp/wt" ;;
  /*) ;;
  *) wt_base="$principal/$wt_base" ;;
esac
wt_base="$(lexical "$wt_base")"
case "$wt_base" in
  "$principal"|"$principal"/*) ;;
  *) wt_base="$(canon "$wt_base")" ;;
esac
feature_root="$wt_base/$repo_name"
feature_root_exempt=false
case "$feature_root" in
  "$principal"/*) untracked_in_principal "$feature_root" && feature_root_exempt=true ;;
esac

in_exempt_root() {
  local p="$1"
  if [ "$claude_root_exempt" = true ]; then
    case "$p" in "$claude_root"|"$claude_root"/*) return 0 ;; esac
  fi
  if [ "$feature_root_exempt" = true ]; then
    case "$p" in "$feature_root"|"$feature_root"/*) return 0 ;; esac
  fi
  return 1
}

# Live work of this repo: the principal, what it contains or is contained by,
# and the same for every registered worktree. Never listed. Takes a canon path.
is_protected() {
  local p="$1" reg
  case "$principal" in "$p"|"$p"/*) return 0 ;; esac
  case "$p" in "$principal"/*) in_exempt_root "$p" || return 0 ;; esac
  for reg in "${!REGISTERED[@]}"; do
    [ "$reg" = "$principal" ] && continue
    case "$p" in "$reg"|"$reg"/*) return 0 ;; esac
    case "$reg" in "$p"/*) return 0 ;; esac
  done
  return 1
}

origin=""
current_anchor=""

# One row. A name that could split the row (control character, `|`) is shown
# %q-escaped with `|` spelled `\x7c`, as unsafe_name. --yes-targets keeps
# empty_parent rows only.
emit() {
  local p="$1" kind="$2" detail="$3"
  if [[ $p == *[[:cntrl:]]* || $p == *'|'* ]]; then
    p="$(printf '%q' "$p")"
    p="${p//\|/\x7c}"
    p="${p//|/\x7c}"
    kind=unsafe_name
    detail="control character or pipe in name, shown escaped"
  fi
  if [ "$YES_TARGETS" = true ] && [ "$kind" != empty_parent ]; then
    return 0
  fi
  printf '%s|%s|%s (%s)\n' "$p" "$kind" "$detail" "$origin"
}

resolve_gitdir() {
  local child="$1" gd
  if [ -d "$child/.git" ]; then
    canon "$child/.git"
    return 0
  fi
  gd="$(sed -n 's/^gitdir:[[:space:]]*//p' "$child/.git" | head -n1)"
  case "$gd" in
    "") return 0 ;;
    /*) ;;
    *) gd="$child/$gd" ;;
  esac
  canon "$gd"
}

belongs_to_this_repo() {
  case "$1" in "$ours_worktrees"/*) return 0 ;; esac
  return 1
}

dir_has_entries() {
  local e
  shopt -s nullglob dotglob
  e=("$1"/*)
  shopt -u nullglob dotglob
  [ "${#e[@]}" -gt 0 ]
}

# Live = owned by a work tree: the enclosing toplevel tracks something at or
# under p, or is rooted at/below p. Mere enclosure (principal, $HOME dotfiles)
# is not ownership.
live_in_worktree() {
  local p="$1" top tracked
  top="$(git -C "$p" rev-parse --show-toplevel 2>/dev/null)" || return 1
  case "$top" in
    "$p"|"$p"/*) return 0 ;;
  esac
  tracked="$(git -C "$top" ls-files -- "$p" 2>/dev/null || true)"
  [ -n "$tracked" ]
}

enclosing_toplevel() {
  git -C "$1" rev-parse --show-toplevel 2>/dev/null
}

classify() {
  local p="$1" nested top
  is_protected "$(canon "$p")" && return 0

  if [ -L "$p" ]; then
    emit "$p" symlink "symlink — never followed"
    return 0
  fi
  if [ ! -d "$p" ]; then
    emit "$p" not_a_dir "not a directory"
    return 0
  fi
  # Emptiness and nested searches need to list/search; without that a content
  # dir reads as empty_parent. Non-selectable until the operator can prove it.
  if [ ! -r "$p" ] || [ ! -x "$p" ]; then
    emit "$p" unreadable "directory not readable/searchable — emptiness unprovable"
    return 0
  fi
  if [ -L "$p/.git" ] && [ ! -e "$p/.git" ]; then
    emit "$p" dangling_git "dangling .git symlink — ownership unprovable"
    return 0
  fi
  if [ -e "$p/.git" ]; then
    # Another repository's checkout or worktree: never listed.
    belongs_to_this_repo "$(resolve_gitdir "$p")" || return 0
    # Git still resolves this path as a work tree → live (e.g. a copy sharing
    # a live gitdir). After worktrees/ is pruned, rev-parse fails → shell.
    if enclosing_toplevel "$p" >/dev/null; then
      emit "$p" inside_worktree "live worktree of this repo at another registered path"
    else
      emit "$p" unregistered "has .git but not in git worktree list"
    fi
    return 0
  fi
  if live_in_worktree "$p"; then
    emit "$p" inside_worktree "owned by a git work tree (tracked or rooted here)"
    return 0
  fi
  # Do not swallow EACCES: an unreadable descendant must not read as "no .git".
  if ! nested="$(find "$p" -mindepth 1 -maxdepth 4 -name .git -print -quit)"; then
    emit "$p" unreadable "cannot search directory for nested .git"
    return 0
  fi
  if [ -n "$nested" ]; then
    emit "$p" nested_git "contains a .git within depth 4"
    return 0
  fi
  # Under some work tree but not owned by it (untracked harness/feature child,
  # $HOME dotfiles repo, foreign untracked child): per-row only — never --yes.
  if top="$(enclosing_toplevel "$p")"; then
    if dir_has_entries "$p"; then
      emit "$p" unregistered "content without git registration"
    else
      emit "$p" empty_untracked "empty and untracked under enclosing work tree"
    fi
    return 0
  fi
  if dir_has_entries "$p"; then
    emit "$p" unregistered "content without git registration"
    return 0
  fi
  emit "$p" empty_parent "empty leftover after worktree remove"
}

# root is built lexically under a canonical anchor: realpath ≠ spelling means a
# symlink component below the anchor. Report it; list nothing through it.
scan_root() {
  local root="$1" child children=()
  origin="$2"
  current_anchor="$3"
  [ -e "$root" ] || [ -L "$root" ] || return 0
  if [ "$(canon "$root")" != "$root" ]; then
    emit "$root" symlink_root "symlink between trusted anchor and scan root — children not listed"
    return 0
  fi
  if [ -d "$root" ]; then
    shopt -s nullglob
    children=("$root"/*)
    shopt -u nullglob
  fi
  if [ "${#children[@]}" -eq 0 ]; then
    classify "$root"
    return 0
  fi
  for child in "${children[@]}"; do
    classify "$child"
  done
}

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

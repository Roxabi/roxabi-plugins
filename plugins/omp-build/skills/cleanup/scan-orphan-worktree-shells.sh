#!/usr/bin/env bash
# Usage: scan-orphan-worktree-shells.sh [--yes-targets]
# Analyze-only — never deletes. Emits one line per entry: path|kind|detail
#   kind ∈ empty_parent | unregistered | inside_worktree | nested_git |
#          symlink | symlink_root | dangling_git | not_a_dir | unsafe_name
#
# --yes-targets is an allowlist: it emits ONLY `empty_parent` rows — a real
# directory (`[ -d ] && [ ! -L ]`), empty, not inside any git work tree, with no
# symlink component between its trusted anchor and itself. 5b deletes those with
# `rmdir` only, never `rm -rf`. Every other kind needs a per-row confirmation;
# inside_worktree, nested_git, symlink, symlink_root, dangling_git, not_a_dir
# and unsafe_name are not selectable at all.
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
# without resolving symlinks.
canon() { realpath -m -- "$1"; }
lexical() { realpath -ms -- "$1"; }

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

# One row. A name that could split the row (control character, `|`) is shown
# %q-escaped with `|` spelled `\x7c`, as unsafe_name. --yes-targets keeps
# empty_parent rows only.
emit() {
  local p="$1" kind="$2" detail="$3"
  if [[ $p == *[[:cntrl:]]* || $p == *'|'* ]]; then
    p="$(printf '%q' "$p")"
    p="${p//\\|/\\x7c}"
    p="${p//|/\\x7c}"
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

inside_worktree() {
  git -C "$1" rev-parse --show-toplevel >/dev/null 2>&1
}

classify() {
  local p="$1"
  is_protected "$(canon "$p")" && return 0

  if [ -L "$p" ]; then
    emit "$p" symlink "symlink — never followed"
    return 0
  fi
  if [ ! -d "$p" ]; then
    emit "$p" not_a_dir "not a directory"
    return 0
  fi
  if [ -L "$p/.git" ] && [ ! -e "$p/.git" ]; then
    emit "$p" dangling_git "dangling .git symlink — ownership unprovable"
    return 0
  fi
  if [ -e "$p/.git" ]; then
    # Another repository's checkout or worktree: never listed.
    belongs_to_this_repo "$(resolve_gitdir "$p")" || return 0
    if inside_worktree "$p"; then
      emit "$p" inside_worktree "live worktree of this repo at another registered path"
    else
      emit "$p" unregistered "has .git but not in git worktree list"
    fi
    return 0
  fi
  if inside_worktree "$p"; then
    emit "$p" inside_worktree "path is inside a git work tree"
    return 0
  fi
  if [ -n "$(find "$p" -mindepth 1 -maxdepth 4 -name .git -print -quit 2>/dev/null || true)" ]; then
    emit "$p" nested_git "contains a .git within depth 4"
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
  legacy_root="$(canon "$(dirname -- "$OMP_WORKTREES_ROOT")")/$(basename -- "$OMP_WORKTREES_ROOT")"
else
  legacy_root="$(canon "$HOME")/.omp/worktrees"
fi
scan_root "$legacy_root/$repo_name" "~/.omp/worktrees"

# --- 2) <principal>/.claude/worktrees/ ---
scan_root "$claude_root" ".claude/worktrees"

# --- 3) <worktree base>/<repo>/ ---
scan_root "$feature_root" "worktree-base"

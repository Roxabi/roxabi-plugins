#!/usr/bin/env bash
# Sourced orphan classification and bounded root traversal. Configuration globals come from orphan-scan-config.sh.

origin=""
current_anchor=""

# One row. A name with a byte outside [A-Za-z0-9._/@+-] is shown %q-escaped
# with `|` spelled `\x7c`, as unsafe_name. --yes-targets keeps empty_parent only.
emit() {
  local p="$1" kind="$2" detail="$3"
  case "$p" in
    *[!A-Za-z0-9._/@+-]*)
      p="$(printf '%q' "$p")"
      p="${p//\|/\x7c}"
      p="${p//|/\x7c}"
      kind=unsafe_name
      detail="byte outside [A-Za-z0-9._/@+-] in name, shown escaped"
      ;;
  esac
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
# under p, or is rooted at/below p. A work tree rooted *strictly below* the
# trusted scan anchor (and not the principal) is someone else's checkout —
# its untracked children are also live. Mere enclosure by the principal or by
# an ancestor of the anchor ($HOME dotfiles) is not ownership.
live_in_worktree() {
  local p="$1" top tracked
  top="$(git -C "$p" rev-parse --show-toplevel 2>/dev/null)" || return 1
  case "$top" in
    "$p"|"$p"/*) return 0 ;;
  esac
  # Foreign enclosure: top sits under the trusted anchor and is not ours.
  if [ -n "$current_anchor" ] && [ "$top" != "$principal" ]; then
    case "$top" in
      "$current_anchor"/*) return 0 ;;
    esac
  fi
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
    # Dot-named leftovers (`.tmp-orphan`, `.empty`) are real shells; skip only
    # `.git` so a root holding solely a gitdir is not walked as a child.
    local entry
    shopt -s nullglob dotglob
    for entry in "$root"/*; do
      [ "$(basename -- "$entry")" = .git ] && continue
      children+=("$entry")
    done
    shopt -u nullglob dotglob
  fi
  if [ "${#children[@]}" -eq 0 ]; then
    # Root itself is only deletable when empty (empty_parent / empty_untracked).
    classify "$root"
    return 0
  fi
  for child in "${children[@]}"; do
    classify "$child"
  done
}

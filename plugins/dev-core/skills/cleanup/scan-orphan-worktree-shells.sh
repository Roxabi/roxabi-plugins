#!/usr/bin/env bash
# Usage: scan-orphan-worktree-shells.sh
# Analyze-only — never deletes.
#
# Finds leftover worktree *shells* that `git worktree list` misses after
# `git worktree remove`:
#   - empty or unregistered dirs under ~/.grok/worktrees/<repo-slug>/
#   - orphan paths under .claude/worktrees/ (not in git worktree list)
#   - Grok worktrees.db rows for this source_repo whose path no longer exists
#
# Emits lines: path|kind|detail
# kind ∈ empty_parent | unregistered | db_stale
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "orphan_shells=none"
  exit 0
fi

# Registered worktree paths (absolute).
declare -A REGISTERED=()
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      p="${line#worktree }"
      REGISTERED["$p"]=1
      ;;
  esac
done < <(git worktree list --porcelain 2>/dev/null || true)

# Grok slug: owner with non-alphanumerics stripped + "-" + repo
# (matches ~/.grok/worktrees/gosilex-spark for go-silex/spark).
grok_repo_slug() {
  local url owner repo
  url="$(git remote get-url origin 2>/dev/null || true)"
  [ -z "$url" ] && return 1
  # git@host:owner/repo.git | https://host/owner/repo.git | ssh://…/owner/repo.git
  if [[ "$url" =~ [:/]([^/:]+)/([^/]+?)(\.git)?$ ]]; then
    owner="${BASH_REMATCH[1]}"
    repo="${BASH_REMATCH[2]}"
    repo="${repo%.git}"
    owner="$(printf '%s' "$owner" | tr -cd '[:alnum:]')"
    printf '%s-%s' "$owner" "$repo"
    return 0
  fi
  return 1
}

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

# --- 1) ~/.grok/worktrees/<slug>/ ---
slug="$(grok_repo_slug || true)"
GROK_WT_ROOT="${GROK_WORKTREES_ROOT:-$HOME/.grok/worktrees}"
if [ -n "$slug" ]; then
  slug_dir="$GROK_WT_ROOT/$slug"
  if [ -d "$slug_dir" ]; then
    # children (depth 1)
    shopt -s nullglob
    children=("$slug_dir"/*)
    shopt -u nullglob
    if [ "${#children[@]}" -eq 0 ]; then
      emit "$slug_dir" "empty_parent" "empty Grok worktree parent for this repo"
    else
      for child in "${children[@]}"; do
        [ -e "$child" ] || continue
        if is_registered "$child"; then
          continue
        fi
        if [ -e "$child/.git" ]; then
          # Has a gitdir but not registered → stale / half-removed worktree
          emit "$child" "unregistered" "has .git but not in git worktree list"
        elif ! dir_has_entries "$child"; then
          emit "$child" "empty_parent" "empty leftover after worktree remove"
        else
          emit "$child" "unregistered" "content without git registration (orphan shell)"
        fi
      done
    fi
  fi

  # Legacy accidental layout: ~/.grok/worktrees/projects/<…>/<repo>
  # Only flag if path is under this repo's name and not registered.
  projects_root="$GROK_WT_ROOT/projects"
  if [ -d "$projects_root" ]; then
    while IFS= read -r -d '' candidate; do
      is_registered "$candidate" && continue
      if [ -e "$candidate/.git" ]; then
        emit "$candidate" "unregistered" "under ~/.grok/worktrees/projects, not registered"
      elif ! dir_has_entries "$candidate"; then
        emit "$candidate" "empty_parent" "empty under ~/.grok/worktrees/projects"
      else
        # partial leftover (e.g. only node_modules)
        emit "$candidate" "unregistered" "orphan content under ~/.grok/worktrees/projects"
      fi
    done < <(find "$projects_root" -mindepth 2 -maxdepth 4 -type d \( -name "$(basename "$repo_root")" -o -path "*/$(basename "$repo_root")" \) -print0 2>/dev/null || true)
  fi
fi

# --- 2) .claude/worktrees/* under main repo ---
claude_wt="$repo_root/.claude/worktrees"
if [ -d "$claude_wt" ]; then
  shopt -s nullglob
  for child in "$claude_wt"/*; do
    [ -e "$child" ] || continue
    is_registered "$child" && continue
    if [ -e "$child/.git" ]; then
      emit "$child" "unregistered" ".claude/worktrees entry not in git worktree list"
    elif ! dir_has_entries "$child"; then
      emit "$child" "empty_parent" "empty .claude/worktrees shell"
    else
      emit "$child" "unregistered" "orphan .claude/worktrees content"
    fi
  done
  shopt -u nullglob
  # empty parent .claude/worktrees with no children
  if ! dir_has_entries "$claude_wt"; then
    emit "$claude_wt" "empty_parent" "empty .claude/worktrees directory"
  fi
fi

# --- 3) Grok worktrees.db stale rows for this source_repo ---
db="${GROK_WORKTREES_DB:-$HOME/.grok/worktrees.db}"
if [ -f "$db" ] && command -v sqlite3 >/dev/null 2>&1; then
  # Match rows for this checkout path, or under this repo's Grok slug.
  # Escape single quotes for SQL string literals.
  _sql_escape() { printf "%s" "$1" | sed "s/'/''/g"; }
  _repo_sql="$(_sql_escape "$repo_root")"
  _slug_sql=""
  [ -n "${slug:-}" ] && _slug_sql="$(_sql_escape "$GROK_WT_ROOT/$slug")"
  _sql="SELECT path, status FROM worktrees WHERE source_repo = '${_repo_sql}'"
  if [ -n "$_slug_sql" ]; then
    _sql="${_sql} OR path LIKE '${_slug_sql}/%' OR path = '${_slug_sql}'"
  fi
  while IFS='|' read -r path status; do
    [ -n "$path" ] || continue
    if [ ! -e "$path" ]; then
      emit "$path" "db_stale" "worktrees.db status=${status:-?} path missing on disk"
    elif ! is_registered "$path"; then
      # Path exists but git does not know it — still report as unregistered
      emit "$path" "unregistered" "worktrees.db status=${status:-?} not in git worktree list"
    fi
  done < <(sqlite3 -separator '|' "$db" "$_sql" 2>/dev/null || true)
fi

# Always end with a marker if nothing printed (caller can treat empty as none)
# — caller checks for any lines after the section header.

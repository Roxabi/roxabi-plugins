#!/usr/bin/env bash
# Usage: scan-orphan-worktree-shells.sh [--yes-targets]
# Analyze-only — never deletes. Emits lines: path|kind|detail
# kind ∈ empty_parent | unregistered
#
# --yes-targets: emit only rows the 5b multi-select defaults to and that `--yes`
# may delete. `unregistered` rows that still have a `.git` are omitted (shown in
# the full scan, never pre-selected, never deleted under `--yes`).
#
# Finds leftover worktree *shells* that `git worktree list` misses after
# `git worktree remove`. It scans three roots, and nothing else:
#
#   1. ~/.omp/worktrees/<repo>/                       — legacy leftover of the
#      retired `ensureWorktree`. Still scanned; `/feature` does not write here.
#   2. <principal>/.claude/worktrees/<…>              — harness-created worktrees.
#   3. <worktree base>/<repo>/<slug>                  — the `/feature` root.
#      Base is OMP_WORKTREE_DIR, else stack.yml worktree.base, else ~/.omp/wt.
#
# A child with `.git` is emitted only when its `gitdir:` back-pointer resolves
# under this repo's `git rev-parse --git-common-dir`/worktrees. Otherwise it
# belongs to another checkout sharing the basename and is never listed. The
# principal itself (and paths under it outside `.claude/worktrees`) are skipped
# so a mis-set `worktree.base` equal to the principal's parent cannot offer the
# principal's own tree for deletion.
#
# dev-core's copy scanned ~/.grok/worktrees/<slug>/ and deleted rows from a Grok
# `worktrees.db` via sqlite3. omp-build ships neither the Grok harness nor a
# writer for that database, and it never puts a worktree under that root — so
# those branches could only ever report zero, while the root this plugin does use
# went unscanned. Both are repointed rather than copied (ADR-020 §3).
set -euo pipefail

YES_TARGETS=false
for arg in "$@"; do
  case "$arg" in
    --yes-targets) YES_TARGETS=true ;;
  esac
done

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "orphan_shells=none"
  exit 0
fi

# Registered worktree paths (absolute **and canonical**), and the principal — the
# FIRST porcelain entry. The scan roots hang off the principal, never off
# `rev-parse --show-toplevel`: inside a linked worktree that returns the
# worktree's own directory, so `<toplevel>/.claude/worktrees` would name a path
# that does not exist and the scan would report zero orphans from every ω —
# exactly the place /cleanup is normally run from.
#
# Canonical is load-bearing, not tidiness. `rm -rf` is what 5b-execute does to
# what this file calls an orphan, so the comparison that decides it must be
# between comparable spellings. The two sides come from different places:
#
#   registry  — `git worktree list`, which records the **resolved** path
#               (measured: git resolves both the stored path and
#               `rev-parse --show-toplevel`, even when reached through a
#               symlinked cwd). canon() here is symmetry, not a measured guard —
#               removing it changes no observed behaviour today; it holds the
#               invariant "both sides canonical" in one place instead of resting
#               on that git detail.
#   candidate — a glob of a root built out of `$HOME`, which is a symlink on
#               plenty of real machines (automounted or bind-mounted homes), and
#               whose entries may themselves be symlinks to relocated worktrees.
#               This is the side that really goes lexical, and where a
#               *registered, live* worktree otherwise reads as an orphan.
canon() {
  realpath -- "$1" 2>/dev/null || printf '%s\n' "$1"
}

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

# Absolute common dir + its worktrees/ — the only place a linked worktree's
# `gitdir:` back-pointer may land if it belongs to this repository.
common_dir="$(git rev-parse --git-common-dir 2>/dev/null || true)"
case "$common_dir" in
  '') common_dir="" ;;
  /*) ;;
  *) common_dir="$repo_root/$common_dir" ;;
esac
[ -n "$common_dir" ] && common_dir="$(canon "$common_dir")"
ours_worktrees=""
[ -n "$common_dir" ] && ours_worktrees="$(canon "$common_dir/worktrees" 2>/dev/null || printf '%s\n' "$common_dir/worktrees")"

claude_root="$(canon "$principal/.claude/worktrees")"

emit() {
  # path|kind|detail
  local path="$1" kind="$2" detail="$3"
  if [ "$YES_TARGETS" = true ]; then
    case "$kind|$detail" in
      unregistered\|has\ .git*) return 0 ;;
    esac
  fi
  printf '%s|%s|%s\n' "$path" "$kind" "$detail"
}

is_registered() {
  local p="$1"
  [ -n "${REGISTERED[$p]+x}" ]
}

# Principal itself, or anything under it outside the harness worktree root.
# The `.claude/worktrees` scan hangs off the principal on purpose; those children
# remain candidates. Everything else under the principal (e.g. `src/` when
# worktree.base points at the principal's parent) is never an orphan shell.
is_skipped_principal_path() {
  local p="$1"
  [ "$p" = "$principal" ] && return 0
  case "$p" in
    "$claude_root"|"$claude_root"/*) return 1 ;;
    "$principal"/*) return 0 ;;
  esac
  return 1
}

# Resolve a linked worktree's `gitdir:` back-pointer to a canonical path.
# Empty when `.git` is a directory (full checkout) or the file is unparseable.
resolve_gitdir() {
  local child="$1" gd
  [ -f "$child/.git" ] || return 0
  gd="$(sed -n 's/^gitdir:[[:space:]]*//p' "$child/.git" | head -n1)"
  [ -n "$gd" ] || return 0
  case "$gd" in
    /*) ;;
    *) gd="$child/$gd" ;;
  esac
  canon "$gd"
}

# True when gitdir lives under this repo's <common-dir>/worktrees/.
belongs_to_this_repo() {
  local gitdir="$1"
  [ -n "$ours_worktrees" ] || return 1
  case "$gitdir" in
    "$ours_worktrees"|"$ours_worktrees"/*) return 0 ;;
  esac
  return 1
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
# `.git` present but unregistered = a half-removed worktree of *this* repo only
# (gitdir under our common-dir/worktrees); empty = a leftover shell; content
# without `.git` = an orphan (typically node_modules survived).
classify_child() {
  local child="$1" origin="$2" gitdir
  [ -e "$child" ] || return 0
  child="$(canon "$child")"
  is_skipped_principal_path "$child" && return 0
  is_registered "$child" && return 0
  if [ -e "$child/.git" ]; then
    gitdir="$(resolve_gitdir "$child")"
    belongs_to_this_repo "$gitdir" || return 0
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
  root="$(canon "$root")"
  # Never treat the principal checkout as a worktree-shell root (mis-set base).
  [ "$root" = "$principal" ] && return 0
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

# --- 1) ~/.omp/worktrees/<repo>/ — legacy leftover of the retired ensureWorktree ---
# The <repo> segment is the principal's directory name. Basename alone is not a
# repo identity — same-named checkouts share it; the gitdir check above keeps
# another repo's live worktrees out. `$HOME` is canonicalised because git stored
# the resolved path for the very worktrees that live here.
OMP_WT_ROOT="${OMP_WORKTREES_ROOT:-$(canon "$HOME")/.omp/worktrees}"
scan_root "$OMP_WT_ROOT/$(basename "$principal")" "~/.omp/worktrees"

# --- 2) <principal>/.claude/worktrees/* ---
scan_root "$principal/.claude/worktrees" ".claude/worktrees"

# --- 3) <worktree base>/<repo>/ — the /feature root (OMP_WORKTREE_DIR, else stack.yml worktree.base, else ~/.omp/wt) ---
# Basename scopes the directory; gitdir ownership scopes the repo. A sibling
# checkout of the same name under the same base is not listed.
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
  "~/"*) wt_base="$HOME/${wt_base#~/}" ;;
  "~") wt_base="$HOME" ;;
  "") wt_base="$(canon "$HOME")/.omp/wt" ;;
esac
scan_root "$wt_base/$(basename "$principal")" "worktree-base"

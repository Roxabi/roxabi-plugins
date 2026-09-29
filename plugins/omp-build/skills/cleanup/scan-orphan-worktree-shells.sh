#!/usr/bin/env bash
# Usage: scan-orphan-worktree-shells.sh [--yes-targets]
# Analyze-only — never deletes. Emits lines: path|kind|detail
# kind ∈ empty_parent | unregistered | unsafe_name | symlink | outside_root | dangling_git
#
# --yes-targets: emit only rows the 5b multi-select defaults to and that `--yes`
# may delete — `empty_parent` and `unregistered` with content-without-`.git`.
# Never: `unregistered`+`.git`, `unsafe_name`, `symlink`, `outside_root`,
# `dangling_git`.
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
# principal itself (and paths under it outside `.claude/worktrees` and an
# in-principal feature base) are skipped — and so is any child that *contains*
# the principal or a registered worktree — so a mis-set base cannot offer the
# principal (or its ancestor) for deletion.
#
# Emitting: the lexical scanned entry (canon only for matching). A symlink
# child, a child whose canonical form leaves the root, a dangling `.git`
# symlink, or a path with control characters/`|` is reported as non-deletable
# and never enters `--yes-targets`.
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
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
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
# Matching uses canonical paths; the emitted deletion target is the **lexical**
# scanned entry so a symlink child cannot hand 5b an `rm -rf` path outside the
# scan root.
canon() {
  realpath -- "$1" 2>/dev/null || printf '%s\n' "$1"
}

# Ownership proof only: must not fall back to a raw lexical string. `realpath -m`
# canonicalises even when the final component is missing (git prune removed the
# admin entry under worktrees/, or the whole worktrees/ dir).
canon_m() {
  realpath -m -- "$1"
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
# `--path-format=absolute` is required: plain `--git-common-dir` is relative to
# the cwd, and joining that to `$repo_root` is wrong from any subdirectory.
common_dir="$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
ours_worktrees=""
if [ -n "$common_dir" ]; then
  common_dir="$(canon_m "$common_dir")"
  ours_worktrees="$(canon_m "$common_dir/worktrees")"
fi

claude_root="$(canon "$principal/.claude/worktrees")"

# Resolve worktree base early so an in-principal feature root can be exempted
# like `.claude/worktrees` (otherwise every orphan under it is skipped).
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
feature_root="$(canon "$wt_base/$(basename "$principal")")"

emit() {
  # path|kind|detail — path must be absolute; --yes-targets keeps only deletable kinds.
  local path="$1" kind="$2" detail="$3"
  case "$path" in
    /*) ;;
    *) return 0 ;;
  esac
  if [ "$YES_TARGETS" = true ]; then
    case "$kind" in
      empty_parent) ;;
      unregistered)
        case "$detail" in
          content\ without\ git\ registration*) ;;
          *) return 0 ;;
        esac
        ;;
      *) return 0 ;;
    esac
  fi
  printf '%s|%s|%s\n' "$path" "$kind" "$detail"
}

is_registered() {
  local p="$1"
  [ -n "${REGISTERED[$p]+x}" ]
}

# Carve-outs under the principal that are real worktree-shell roots.
is_exempt_under_principal() {
  local p="$1"
  case "$p" in
    "$claude_root"|"$claude_root"/*) return 0 ;;
  esac
  # Only when the feature root is *inside* the principal (not equal to it —
  # that case is a mis-set base equal to the principal's parent + basename).
  if [ -n "$feature_root" ] && [ "$feature_root" != "$principal" ]; then
    case "$p" in
      "$feature_root"|"$feature_root"/*) return 0 ;;
    esac
  fi
  return 1
}

# Skip any path equal to, under, or containing the principal or a registered
# worktree — except the harness / in-principal feature carve-outs.
is_protected_path() {
  local p="$1" reg
  [ "$p" = "$principal" ] && return 0
  case "$p" in
    "$principal"/*)
      is_exempt_under_principal "$p" && return 1
      return 0
      ;;
  esac
  case "$principal" in
    "$p"/*) return 0 ;;
  esac
  # Other registered worktrees (principal already handled above, including its
  # exempt carve-outs — do not re-catch those as "under a registered path").
  for reg in "${!REGISTERED[@]}"; do
    [ "$reg" = "$principal" ] && continue
    [ "$p" = "$reg" ] && return 0
    case "$p" in
      "$reg"/*) return 0 ;;
    esac
    case "$reg" in
      "$p"/*) return 0 ;;
    esac
  done
  return 1
}

path_is_unsafe() {
  local p="$1"
  case "$p" in
    *'|'*) return 0 ;;
  esac
  # Any control character forges a path|kind|detail row.
  printf '%s' "$p" | grep -q '[[:cntrl:]]' && return 0
  return 1
}

# Resolve a linked worktree's `gitdir:` back-pointer to a canonical path.
# Empty when `.git` is a directory (full checkout) or the file is unparseable.
# Uses canon_m so a relative gitdir still matches after git prunes worktrees/.
resolve_gitdir() {
  local child="$1" gd
  [ -f "$child/.git" ] || return 0
  gd="$(sed -n 's/^gitdir:[[:space:]]*//p' "$child/.git" | head -n1)"
  [ -n "$gd" ] || return 0
  case "$gd" in
    /*) ;;
    *) gd="$child/$gd" ;;
  esac
  canon_m "$gd"
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

# Classify one candidate. Matching uses canon; emit uses the lexical entry.
# root / root_canon bound every emitted path to the scan root.
classify_child() {
  local child="$1" origin="$2" root="$3" root_canon="$4"
  local child_canon gitdir

  # Dangling symlink children still need classifying; plain missing → skip.
  [ -e "$child" ] || [ -L "$child" ] || return 0

  case "$child" in
    /*) ;;
    *) return 0 ;;
  esac
  # Lexical containment under the (canonicalised) scan root.
  case "$child" in
    "$root"|"$root"/*) ;;
    *) return 0 ;;
  esac

  if path_is_unsafe "$child"; then
    emit "$child" "unsafe_name" "path contains control character or | ($origin)"
    return 0
  fi

  child_canon="$(canon "$child")"
  # Protected via canonical form (covers symlink → registered / principal).
  is_protected_path "$child_canon" && return 0

  if [ -L "$child" ]; then
    emit "$child" "symlink" "symlink child — not a deletable shell ($origin)"
    return 0
  fi

  case "$child_canon" in
    "$root_canon"|"$root_canon"/*) ;;
    *)
      emit "$child" "outside_root" "canonical path leaves scan root ($origin)"
      return 0
      ;;
  esac

  # `.git` present as file/dir, or as a (possibly dangling) symlink.
  if [ -e "$child/.git" ] || [ -L "$child/.git" ]; then
    if [ -L "$child/.git" ] && [ ! -e "$child/.git" ]; then
      emit "$child" "dangling_git" "dangling .git symlink ($origin)"
      return 0
    fi
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
  local root="$1" origin="$2" root_canon
  [ -d "$root" ] || return 0
  root="$(canon "$root")"
  root_canon="$root"
  local children=()
  shopt -s nullglob
  children=("$root"/*)
  shopt -u nullglob
  if [ "${#children[@]}" -eq 0 ]; then
    # Empty root inside / equal to the principal is not a shell we may rmdir.
    is_protected_path "$root" && return 0
    emit "$root" "empty_parent" "empty worktree parent ($origin)"
    return 0
  fi
  local child
  for child in "${children[@]}"; do
    classify_child "$child" "$origin" "$root" "$root_canon"
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

# --- 3) <worktree base>/<repo>/ — the /feature root ---
# Basename scopes the directory; gitdir ownership scopes the repo. feature_root
# was resolved above so in-principal bases keep their orphans.
scan_root "$feature_root" "worktree-base"

#!/usr/bin/env bash
# Sourced scanner configuration and ownership fences. The entry validates CLI arguments before sourcing this file.
# It exports no policy: all globals retain the scanner's original names and values.

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

# Parse only the map path consumed here. The NUL protocol keeps a configured
# trailing newline intact and makes parser failure distinct from an empty base.
read_stack_worktree_base() {
  local stack="$1" field status
  local -a fields=()
  while IFS= read -r -d '' field; do
    fields+=("$field")
  done < <(
    if cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && bun --no-env-file -e '
        import { readFileSync } from "node:fs"

        const stackPath = process.argv[1]
        const isMap = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

        try {
          const document = Bun.YAML.parse(readFileSync(stackPath, "utf8"))
          if (document != null && !isMap(document)) throw new Error("document must be a map, null, or absent")

          const worktree = document?.worktree
          if (worktree != null && !isMap(worktree)) throw new Error("worktree must be a map, null, or absent")

          const base = worktree?.base
          if (base != null && typeof base !== "string") throw new Error("worktree.base must be a string, null, or absent")
          if (base?.includes("\0")) throw new Error("worktree.base must not contain a NUL byte")

          process.stdout.write(`base\0${base ?? ""}\0`)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          console.error(`${stackPath}: invalid worktree configuration: ${message}`)
          process.exit(1)
        }
      ' "$stack"; then
      printf '%s\0%s\0' '__OMP_STACK_STATUS__' '0'
    else
      status=$?
      printf '%s\0%s\0' '__OMP_STACK_STATUS__' "$status"
    fi
  )

  if [ "${#fields[@]}" -ne 4 ] ||
    [ "${fields[0]}" != 'base' ] ||
    [ "${fields[2]}" != '__OMP_STACK_STATUS__' ]; then
    printf '%s: invalid worktree configuration reader output\n' "$stack" >&2
    return 1
  fi

  status="${fields[3]}"
  case "$status" in
    0) ;;
    ''|*[!0-9]*)
      printf '%s: invalid worktree configuration reader status\n' "$stack" >&2
      return 1
      ;;
    *)
      printf '%s: invalid worktree configuration reader failed (status %s)\n' "$stack" "$status" >&2
      return 1
      ;;
  esac

  wt_base="${fields[1]}"
}

wt_base="${OMP_WORKTREE_DIR:-}"
if [ -z "$wt_base" ] && [ -f "$principal/.dev/stack.yml" ]; then
  read_stack_worktree_base "$principal/.dev/stack.yml" || exit 1
fi
case "$wt_base" in
  "~") wt_base="$HOME" ;;
  "~/"*) wt_base="$HOME/${wt_base:2}" ;;
  "") wt_base="$HOME/.omp/wt" ;;
  /*) ;;
  *) wt_base="$principal/$wt_base" ;;
esac
wt_base_capture="$(lexical "$wt_base" && printf '.')"
wt_base="${wt_base_capture%$'\n.'}"
case "$wt_base" in
  "$principal"|"$principal"/*) ;;
  *)
    wt_base_capture="$(canon "$wt_base" && printf '.')"
    wt_base="${wt_base_capture%$'\n.'}"
    ;;
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

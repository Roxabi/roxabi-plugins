#!/usr/bin/env bash
# Idempotent worktree bootstrap. Never writes on the principal.
# Marker: $(git rev-parse --git-dir)/omp-build-bootstrapped
# Reads .dev/stack.yml worktree.copy / worktree.seed; runs the selected setup
# after ccc/codegraph and before semctx.
set -euo pipefail

toplevel="$(git rev-parse --show-toplevel)"
git_dir="$(git rev-parse --git-dir)"
git_dir="$(cd "$git_dir" && pwd)"
marker="$git_dir/omp-build-bootstrapped"

if [ -f "$marker" ]; then
  echo "bootstrap=noop"
  exit 0
fi

principal=""
while IFS= read -r line; do
  case "$line" in
    worktree\ *)
      principal="${line#worktree }"
      break
      ;;
  esac
done < <(git worktree list --porcelain)
[ -n "$principal" ] || principal="$toplevel"
principal="$(realpath -- "$principal")"
here="$(realpath -- "$toplevel")"

if [ "$here" = "$principal" ]; then
  echo "bootstrap=refused principal" >&2
  exit 2
fi

# One run at a time: omp-build's extension starts this in the background when a
# session enters the worktree, and /feature runs it in the foreground. The later
# run waits, then no-ops on the marker. The lock is a symlink naming its holder's
# pid, so a lock left by a killed run is taken over.
lock="$git_dir/omp-build-bootstrap.lock"
until ln -s "$$" "$lock" 2>/dev/null; do
  holder="$(readlink "$lock" 2>/dev/null || true)"
  if [ -n "$holder" ] && ! kill -0 "$holder" 2>/dev/null; then
    rm -f "$lock"
  else
    sleep 1
  fi
done
trap 'rm -f "$lock"' EXIT
if [ -f "$marker" ]; then
  echo "bootstrap=noop"
  exit 0
fi

stack="$here/.dev/stack.yml"

need_cli() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "bootstrap=$2-cli-missing" >&2
    exit 3
  }
}

if [ -f "$stack" ]; then
  need_cli bun bun
  fields=()
  while IFS= read -r -d '' field; do
    fields+=("$field")
  done < <(
    if cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && bun --no-env-file -e '
      import { readFileSync } from "node:fs"

      const path = process.argv[1]
      const invalid = (message) => {
        throw new Error(message)
      }
      const isMap = (value) => value == null || (typeof value === "object" && !Array.isArray(value))
      const list = (value, name) => {
        if (value == null) return []
        if (!Array.isArray(value) || value.some((item) => typeof item !== "string"))
          invalid(`${name} must be a list of strings or null`)
        if (value.some((item) => item.includes("\0"))) invalid(`${name} must not contain NUL`)
        return value
      }
      const record = (key, value) => process.stdout.write(`${key}\0${value}\0`)

      try {
        const config = Bun.YAML.parse(readFileSync(path, "utf8"))
        if (!isMap(config)) invalid("document must be a map or null")
        const worktree = config?.worktree
        const commands = config?.commands
        if (!isMap(worktree)) invalid("worktree must be a map or null")
        const copy = list(worktree?.copy, "worktree.copy")
        const seed = list(worktree?.seed, "worktree.seed")
        const setup = typeof worktree?.setup === "string" && worktree.setup.trim()
          ? ["snippet", worktree.setup]
          : typeof commands?.worktree_setup === "string" && commands.worktree_setup.trim()
            ? ["file", commands.worktree_setup]
            : ["none", ""]
        if (setup[1].includes("\0")) invalid("selected setup must not contain NUL")
        for (const value of copy.length ? copy : [""]) record("copy", value)
        for (const value of seed.length ? seed : [""]) record("seed", value)
        record("setup_mode", setup[0])
        record("setup", setup[1])
      } catch (error) {
        console.error(`${path}: ${error instanceof Error ? error.message : String(error)}`)
        process.exit(1)
      }
    ' "$stack"; then
      printf 'status\0%s\0' 0
    else
      status=$?
      printf 'status\0%s\0' "$status"
    fi
  )
  if [ $(( ${#fields[@]} % 2 )) -ne 0 ] || [ "${#fields[@]}" -lt 2 ]; then
    echo "bootstrap=stack-invalid $stack" >&2
    exit 1
  fi
  status_index=$((${#fields[@]} - 2))
  if [ "${fields[$status_index]}" != "status" ] || ! [[ "${fields[$((status_index + 1))]}" =~ ^[0-9]+$ ]]; then
    echo "bootstrap=stack-invalid $stack" >&2
    exit 1
  fi
  if [ "${fields[$((status_index + 1))]}" -ne 0 ]; then
    echo "bootstrap=stack-invalid $stack" >&2
    exit "${fields[$((status_index + 1))]}"
  fi
  if [ "${#fields[@]}" -lt 10 ]; then
    echo "bootstrap=stack-invalid $stack" >&2
    exit 1
  fi

  copy_values=()
  seed_values=()
  setup_mode=""
  setup_value=""
  phase=copy
  index=0
  while [ "$index" -lt "$status_index" ]; do
    key="${fields[$index]}"
    value="${fields[$((index + 1))]}"
    case "$key:$phase" in
      copy:copy)
        copy_values+=("$value")
        ;;
      seed:copy | seed:seed)
        phase=seed
        seed_values+=("$value")
        ;;
      setup_mode:seed)
        phase=setup_mode
        setup_mode="$value"
        ;;
      setup:setup_mode)
        phase=setup
        setup_value="$value"
        ;;
      *)
        echo "bootstrap=stack-invalid $stack" >&2
        exit 1
        ;;
    esac
    index=$((index + 2))
  done
  case "$phase:$setup_mode" in
    setup:snippet | setup:file | setup:none) ;;
    *)
      echo "bootstrap=stack-invalid $stack" >&2
      exit 1
      ;;
  esac
fi

refuse_example() {
  case "$1" in
    *.example | *.example/*) return 0 ;;
  esac
  return 1
}

path_stays_here() {
  local rel="$1" acc="$here" part probe canon captured
  case "$rel" in
    /* | .. | ../* | */.. | */../*) return 1 ;;
  esac
  local IFS=/
  for part in $rel; do
    [ -n "$part" ] || continue
    [ "$part" = "." ] || [ "$part" = ".." ] && return 1
    acc="$acc/$part"
    [ -L "$acc" ] && return 1
  done
  probe="$here/$rel"
  while [ ! -e "$probe" ] && [ "$probe" != "$here" ]; do
    captured="$(dirname -- "$probe" && printf '.')" || return 1
    probe="${captured%$'\n.'}"
  done
  captured="$(realpath -- "$probe" && printf '.')" || return 1
  canon="${captured%$'\n.'}"
  case "$canon" in
    "$here" | "$here"/*) return 0 ;;
  esac
  return 1
}

copy_from_principal() {
  local rel="$1" src dest parent
  refuse_example "$rel" && return 0
  src="$principal/$rel"
  [ -e "$src" ] || return 0
  if ! path_stays_here "$rel"; then
    echo "bootstrap=refused symlink $rel" >&2
    exit 2
  fi
  dest="$here/$rel"
  [ -e "$dest" ] || [ -L "$dest" ] && return 0
  parent="$(dirname -- "$dest" && printf '.')" || return 1
  parent="${parent%$'\n.'}"
  mkdir -p "$parent"
  cp -a "$src" "$dest"
}

if [ -f "$stack" ]; then
  for rel in "${copy_values[@]}"; do
    [ -n "$rel" ] || continue
    copy_from_principal "$rel"
  done
  for rel in "${seed_values[@]}"; do
    [ -n "$rel" ] || continue
    copy_from_principal "$rel"
  done
fi

# Copies the principal's ccc stores. Both hold repo-relative paths, so the copy
# is valid here and `ccc index` reprocesses only the branch delta. A copy that
# overlaps a principal re-index (a store mtime moved) is refused.
copy_ccc_stores() {
  python3 - "$1" "$2" << 'PY'
import os, shutil, sqlite3, sys
src, dest = sys.argv[1], sys.argv[2]
state = os.path.join("cocoindex.db", "mdb", "data.mdb")
vectors = "target_sqlite.db"
def stamp():
    return [os.stat(os.path.join(src, name)).st_mtime_ns for name in (state, vectors)]

try:
    before = stamp()
    os.makedirs(os.path.dirname(os.path.join(dest, state)), exist_ok=True)
    shutil.copyfile(os.path.join(src, state), os.path.join(dest, state))
    source = sqlite3.connect(os.path.join(src, vectors), timeout=30)
    source.backup(sqlite3.connect(os.path.join(dest, vectors)))
    if stamp() != before:
        raise RuntimeError("principal index changed during the copy")
except Exception as error:
    print(f"bootstrap=cocoindex-copy-skipped {error}", file=sys.stderr)
    sys.exit(1)
PY
}

# Code indexes are gitignored, so a new worktree has none. Each one is built
# only when the principal has it: ccc started without its own settings.yml
# walks up and indexes an ancestor directory (`~`). They come before
# worktree.setup: a session already editing here re-indexes through ccc, and
# must find this worktree's settings.yml rather than wait out an install.
if [ -f "$principal/.cocoindex_code/settings.yml" ]; then
  need_cli ccc cocoindex
  ccc_dir="$here/.cocoindex_code"
  if [ ! -f "$ccc_dir/settings.yml" ]; then
    mkdir -p "$ccc_dir"
    cp "$principal/.cocoindex_code/settings.yml" "$ccc_dir/settings.yml"
    copy_ccc_stores "$principal/.cocoindex_code" "$ccc_dir" ||
      rm -rf "$ccc_dir/cocoindex.db" "$ccc_dir/target_sqlite.db"
  fi
  # An unreadable copy fails the index: drop it from the daemon and rebuild.
  (cd "$here" && ccc index) || (cd "$here" && ccc reset -f && ccc index)
fi

if [ -f "$principal/.codegraph/codegraph.db" ]; then
  need_cli codegraph codegraph
  codegraph init -y "$here"
fi

if [ -f "$stack" ]; then
  case "$setup_mode" in
    snippet)
      (cd "$here" && bash -c "$setup_value")
      ;;
    file)
      (cd "$here" && bash -- "$setup_value")
      ;;
  esac
fi

if [ -d "$here/.semctx" ]; then
  need_cli semctx semctx
  (cd "$here" && semctx index)
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$marker"
echo "bootstrap=done"

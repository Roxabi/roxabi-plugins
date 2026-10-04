#!/usr/bin/env bash
# Idempotent worktree bootstrap. Never writes on the principal.
# Marker: $(git rev-parse --git-dir)/omp-build-bootstrapped
# Reads .dev/stack.yml worktree.copy / worktree.seed / worktree.setup, then
# builds each code index (ccc, codegraph, semctx) the principal has.
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

stack="$here/.dev/stack.yml"
copy_list=""
seed_list=""
setup=""
if [ -f "$stack" ]; then
  parsed="$(python3 - "$stack" << 'PY'
import sys
path = sys.argv[1]
lines = open(path, encoding="utf-8").read().splitlines()
section = None
key = None
copy, seed, setup = [], [], ""
for raw in lines:
    if not raw.strip() or raw.lstrip().startswith("#"):
        continue
    indent = len(raw) - len(raw.lstrip(" "))
    text = raw.strip()
    if indent == 0 and text.endswith(":"):
        section = text[:-1]
        key = None
        continue
    if section != "worktree" or indent < 2:
        continue
    if indent == 2 and text.endswith(":") and not text.startswith("-"):
        key = text[:-1]
        continue
    if text.startswith("- ") and key in {"copy", "seed"}:
        item = text[2:].strip().strip("'\"")
        (copy if key == "copy" else seed).append(item)
        continue
    if indent == 2 and ":" in text:
        name, value = text.split(":", 1)
        if name.strip() == "setup":
            setup = value.strip().strip("'\"")
print("\n".join(copy))
print("---")
print("\n".join(seed))
print("---")
print(setup)
PY
)"
  copy_list="$(printf '%s\n' "$parsed" | awk 'BEGIN{p=0} /^---$/{p++; next} p==0')"
  seed_list="$(printf '%s\n' "$parsed" | awk 'BEGIN{p=0} /^---$/{p++; next} p==1')"
  setup="$(printf '%s\n' "$parsed" | awk 'BEGIN{p=0} /^---$/{p++; next} p==2')"
fi

refuse_example() {
  case "$1" in
    *.example | *.example/*) return 0 ;;
  esac
  return 1
}

path_stays_here() {
  local rel="$1" acc="$here" part probe canon
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
    probe="$(dirname "$probe")"
  done
  canon="$(realpath -- "$probe")"
  case "$canon" in
    "$here" | "$here"/*) return 0 ;;
  esac
  return 1
}

copy_from_principal() {
  local rel="$1"
  refuse_example "$rel" && return 0
  local src="$principal/$rel"
  [ -e "$src" ] || return 0
  if ! path_stays_here "$rel"; then
    echo "bootstrap=refused symlink $rel" >&2
    exit 2
  fi
  local dest="$here/$rel"
  [ -e "$dest" ] || [ -L "$dest" ] && return 0
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
}

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  copy_from_principal "$rel"
done <<< "$copy_list
$seed_list"

if [ -n "$setup" ]; then
  (cd "$here" && bash -c "$setup")
fi

need_cli() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "bootstrap=$2-cli-missing" >&2
    exit 3
  }
}

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
# walks up and indexes an ancestor directory (`~`).
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

if [ -d "$here/.semctx" ]; then
  need_cli semctx semctx
  (cd "$here" && semctx index)
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$marker"
echo "bootstrap=done"

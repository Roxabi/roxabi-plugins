#!/usr/bin/env bash
# Idempotent worktree bootstrap. Never writes on the principal.
# Marker: $(git rev-parse --git-dir)/omp-build-bootstrapped
# Reads .dev/stack.yml worktree.copy / worktree.seed / worktree.setup.
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

under_here() {
  local dest="$1"
  case "$dest" in
    "$here" | "$here"/*) return 0 ;;
  esac
  return 1
}

copy_from_principal() {
  local rel="$1"
  refuse_example "$rel" && return 0
  local src="$principal/$rel"
  [ -e "$src" ] || return 0
  local dest="$here/$rel"
  [ -e "$dest" ] && return 0
  under_here "$dest" || return 0
  mkdir -p "$(dirname "$dest")"
  cp -a "$src" "$dest"
}

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  copy_from_principal "$rel"
done <<< "$copy_list"

while IFS= read -r rel; do
  [ -n "$rel" ] || continue
  refuse_example "$rel" && continue
  if [ "$rel" = ".cocoindex_code" ]; then
    if [ -d "$principal/.cocoindex_code" ]; then
      command -v ccc >/dev/null 2>&1 || {
        echo "bootstrap=cocoindex-cli-missing" >&2
        exit 3
      }
      (cd "$here" && ccc index)
    fi
    continue
  fi
  copy_from_principal "$rel"
done <<< "$seed_list"

if [ -n "$setup" ]; then
  (cd "$here" && bash -c "$setup")
fi

if [ -d "$here/.semctx" ]; then
  command -v semctx >/dev/null 2>&1 || {
    echo "bootstrap=semctx-cli-missing" >&2
    exit 3
  }
  (cd "$here" && semctx index)
fi

date -u +%Y-%m-%dT%H:%M:%SZ > "$marker"
echo "bootstrap=done"

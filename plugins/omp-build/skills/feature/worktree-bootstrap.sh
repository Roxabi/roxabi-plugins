#!/usr/bin/env bash
# Idempotent worktree bootstrap. Never writes on the principal.
# Marker: $(git rev-parse --git-dir)/omp-build-bootstrapped
# after ccc/codegraph and before setup.
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
need_cli() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "bootstrap=$2-cli-missing" >&2
    exit 3
  }
}


stack="$here/.dev/stack.yml"
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# Helpers receive only the already-proved worktree/principal paths; no home-directory discovery.
# shellcheck source=worktree-bootstrap-stack.sh
source "$script_dir/worktree-bootstrap-stack.sh"
# shellcheck source=worktree-bootstrap-files.sh
source "$script_dir/worktree-bootstrap-files.sh"
# shellcheck source=worktree-bootstrap-indexes.sh
source "$script_dir/worktree-bootstrap-indexes.sh"

read_bootstrap_stack "$stack"

for rel in "${copy_values[@]}"; do
  [ -n "$rel" ] || continue
  copy_from_principal "$rel"
done
for rel in "${seed_values[@]}"; do
  [ -n "$rel" ] || continue
  copy_from_principal "$rel"
done

run_pre_setup_indexes

case "$setup_mode" in
  snippet)
    (cd "$here" && bash -c "$setup_value")
    ;;
  file)
    (cd "$here" && bash -- "$setup_value")
    ;;
esac


# Emit status before the stamp, then flush file-backed stdout. glibc fully
# buffers non-TTY stdout; without the flush, waiters can see the stamp while
# omp-build-bootstrap.log is still empty (CI flake on startBootstrap).
echo "bootstrap=done"
exec 1>/dev/null
date -u +%Y-%m-%dT%H:%M:%SZ > "$marker"

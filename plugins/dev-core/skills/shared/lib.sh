#!/usr/bin/env bash
# Shared helpers for dev-core skill state scripts.
# Sourced, not executed — callers do: . "$SCRIPT_DIR/../shared/lib.sh"
# No `set` here: sourcing must not mutate the caller's shell options.

# Echo the base branch: the first of `staging`, `main`, `master` that exists as a
# remote-tracking ref, else `main`. `show-ref --verify` tests the exact ref — no
# substring match (so `origin/staging-x`, or a remote named `myorigin`, cannot
# false-positive) and no dependency on `git branch -r` formatting. Unlike
# `refs/remotes/origin/HEAD` (a symbolic ref that `git fetch` never refreshes), these
# refs ARE kept current by fetch. The result is always one of the three protected
# branches, so callers' protected-set assumptions stay valid. Every path ends in an
# `echo`, so the function always exits 0 even under `set -e`.
detect_base_branch() {
    local b
    for b in staging main master; do
        if git show-ref --verify --quiet "refs/remotes/origin/$b" 2>/dev/null; then
            echo "$b"
            return
        fi
    done
    echo main
}

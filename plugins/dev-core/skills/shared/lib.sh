#!/usr/bin/env bash
# Shared helpers for dev-core skill state scripts.
# Sourced, not executed — callers do: . "$SCRIPT_DIR/../shared/lib.sh"
# No `set` here: sourcing must not mutate the caller's shell options.

# Echo the base branch: `staging` if origin/staging exists, else `main`.
# `show-ref --verify` tests the exact ref refs/remotes/origin/staging: no substring
# match (so `origin/staging-x`, or a remote literally named `myorigin`, cannot
# false-positive) and no dependency on `git branch -r` output formatting. A missing
# ref (or running outside a repo) short-circuits the `&&` and falls through to
# `|| echo main`, so the function always exits 0 even under `set -e`.
detect_base_branch() {
    git show-ref --verify --quiet refs/remotes/origin/staging 2>/dev/null && echo staging || echo main
}

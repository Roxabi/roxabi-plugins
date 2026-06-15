#!/usr/bin/env bash
# Shared helpers for dev-core skill state scripts.
# Sourced, not executed — callers do: . "$SCRIPT_DIR/../shared/lib.sh"
# No `set` here: sourcing must not mutate the caller's shell options.

# Echo the base branch: `staging` if origin/staging exists, else `main`.
# `grep -q` failing (no staging) short-circuits the `&&` and falls through to
# `|| echo main`, so the function always exits 0 even under `set -e`.
detect_base_branch() {
    git branch -r 2>/dev/null | grep -q 'origin/staging' && echo staging || echo main
}

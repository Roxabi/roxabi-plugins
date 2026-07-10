#!/usr/bin/env bash
# Shared helpers for dev-core skill state scripts.
# Sourced, not executed — callers do: . "$SCRIPT_DIR/../shared/lib.sh"
# No `set` here: sourcing must not mutate the caller's shell options.

# Echo the base branch: `staging` if origin/staging exists; otherwise the remote's
# default branch (origin/HEAD, e.g. `main` or `master`); falling back to `main`.
# `show-ref --verify` tests the exact ref refs/remotes/origin/staging: no substring
# match (so `origin/staging-x`, or a remote literally named `myorigin`, cannot
# false-positive) and no dependency on `git branch -r` output formatting. Every
# branch ends in an `echo`, and the origin/HEAD lookup is `|| true`-guarded, so the
# function always exits 0 (even outside a repo / under `set -e`).
detect_base_branch() {
    if git show-ref --verify --quiet refs/remotes/origin/staging 2>/dev/null; then
        echo staging
        return
    fi
    # No staging → the remote's default branch (main/master/…), else main.
    # `git fetch` does NOT refresh refs/remotes/origin/HEAD (a symbolic ref set at
    # clone / by `git remote set-head`), so after a remote default-branch rename it
    # can dangle. Validate the resolved ref exists before trusting it — otherwise a
    # stale name would misdirect `gh pr create --base` / mask diffs — else `main`.
    local default
    default=$(git symbolic-ref --quiet --short refs/remotes/origin/HEAD 2>/dev/null) || true
    default=${default#origin/}
    if [ -n "$default" ] && git show-ref --verify --quiet "refs/remotes/origin/${default}" 2>/dev/null; then
        echo "$default"
    else
        echo main
    fi
}

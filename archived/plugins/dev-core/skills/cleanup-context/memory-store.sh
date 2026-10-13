#!/usr/bin/env bash
# Single source of truth for locating a project's Claude Code memory store.
# Sourced, never executed:  . "${CLAUDE_SKILL_DIR}/memory-store.sh"
# Callers: cookbooks/discovery.md (Phase 1) and cookbooks/analysis.md (§2f).
# They cite this file instead of restating the derivation, so the two cannot
# drift apart — the bug below shipped precisely because the rule existed twice.
# No `set` here: sourcing must not mutate the caller's shell options.

# Claude Code names a project's store after its absolute cwd with EVERY byte
# outside [A-Za-z0-9] replaced by `-`. Not only `/`: `_`, `.`, ` ` and the
# leading `/` map to `-` as well. `tr -c` states that rule as the encoder states
# it, complementing the kept set, instead of enumerating the separators that one
# observed path happened to contain — an enumeration is wrong for the first path
# holding a character nobody thought to list.
#
# Example:   cwd /home/dev/projects/external_repos/acme_tool
#         →  ~/.claude/projects/-home-dev-projects-external-repos-acme-tool
# A `/`-only substitution yields `…-external_repos-…`, which exists nowhere, and
# the caller then reports a reassuring "No project memory" over a live store.
claude_project_slug() {
    printf '%s' "${1:?claude_project_slug: path required}" | tr -c 'a-zA-Z0-9' '-'
}

# Absolute path of the memory store for $1 (default: $PWD).
claude_memory_dir() {
    printf '%s/.claude/projects/%s/memory' \
        "${HOME:?claude_memory_dir: HOME unset}" "$(claude_project_slug "${1:-$PWD}")"
}

# The store to work on: a caller-supplied $memory_dir wins (tests, --scope onto
# another checkout), otherwise the derivation above. One accessor, so no caller
# has to remember which of the two it is looking at.
claude_resolve_memory_dir() {
    if [ -n "${memory_dir:-}" ]; then
        printf '%s' "$memory_dir"
    else
        claude_memory_dir
    fi
}

# Classify a store path: `missing` | `empty` | `populated`.
# The three are different findings and must never print the same line —
# `missing` means the path resolved to nothing (historically: a wrong
# derivation), `empty` means a clean store. Conflating them is what let the
# broken slug read as healthy.
claude_store_state() {
    local dir="${1:?claude_store_state: dir required}" md
    [ -d "$dir" ] || { printf 'missing'; return; }
    shopt -s nullglob
    md=("$dir"/*.md)
    shopt -u nullglob
    if [ ${#md[@]} -eq 0 ]; then printf 'empty'; else printf 'populated'; fi
}

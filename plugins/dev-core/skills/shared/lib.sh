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

# True if $1 is a protected base branch (staging|main|master).
is_base_branch() {
    case "${1:-}" in
        staging|main|master) return 0 ;;
        *) return 1 ;;
    esac
}

# Principal (main) worktree path — first porcelain entry. Empty if not a git repo.
principal_worktree_path() {
    git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -1
}

# Branch checked out in the principal worktree (or empty).
principal_branch() {
    local p
    p="$(principal_worktree_path)"
    [ -n "$p" ] && git -C "$p" rev-parse --abbrev-ref HEAD 2>/dev/null || true
}

# Grok repo slug for ~/.grok/worktrees/<slug>/ — owner with non-alphanumerics
# stripped + "-" + repo (matches cleanup/scan-orphan-worktree-shells.sh).
grok_repo_slug() {
    local url owner repo
    url="$(git remote get-url origin 2>/dev/null || true)"
    [ -z "$url" ] && return 1
    if [[ "$url" =~ [:/]([^/:]+)/([^/]+?)(\.git)?$ ]]; then
        owner="${BASH_REMATCH[1]}"
        repo="${BASH_REMATCH[2]}"
        repo="${repo%.git}"
        owner="$(printf '%s' "$owner" | tr -cd '[:alnum:]')"
        printf '%s-%s' "$owner" "$repo"
        return 0
    fi
    return 1
}

# Suggested path for a new feature worktree under harness-default (Grok layout).
# Args: N slug  — N may be empty (frame-only → dir = slug only).
# Echoes absolute path; does not create. Empty if slug missing or slug resolve fails.
suggested_grok_worktree_path() {
    local n="${1:-}" slug="${2:-}" gslug leaf
    [ -z "$slug" ] && return 1
    gslug="$(grok_repo_slug)" || gslug="$(basename "$(git rev-parse --show-toplevel 2>/dev/null || pwd)")"
    if [ -n "$n" ]; then
        leaf="${n}-${slug}"
    else
        leaf="${slug}"
    fi
    printf '%s/.grok/worktrees/%s/%s\n' "${HOME}" "$gslug" "$leaf"
}

# Find a non-principal worktree checked out on the feature branch for issue N.
# Detection SSoT = branch (refs/heads/feat/{N}-*), not path layout.
# Fallback: Claude `.claude/worktrees/{N}-*` path + legacy `../${REPO}-{N}`.
# Args: N [slug]  — slug used for frame-only (N empty) and path fallback.
# Echoes absolute path or empty.
find_feature_worktree() {
    local n="${1:-}" slug="${2:-}"
    local principal wt="" branch="" found="" line repo pattern

    principal="$(principal_worktree_path)"

    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in
            worktree\ *)
                wt="${line#worktree }"
                ;;
            branch\ *)
                branch="${line#branch }"
                if [ -n "$n" ]; then
                    case "$branch" in
                        "refs/heads/feat/${n}-"*)
                            if [ -n "$wt" ] && [ "$wt" != "$principal" ]; then
                                found="$wt"
                            fi
                            ;;
                    esac
                elif [ -n "$slug" ]; then
                    case "$branch" in
                        "refs/heads/feat/${slug}" | "refs/heads/feat/${slug}/"*)
                            if [ -n "$wt" ] && [ "$wt" != "$principal" ]; then
                                found="$wt"
                            fi
                            ;;
                    esac
                fi
                ;;
            "")
                wt=""
                branch=""
                ;;
        esac
        [ -n "$found" ] && break
    done < <(git worktree list --porcelain 2>/dev/null || true)

    if [ -n "$found" ]; then
        printf '%s\n' "$found"
        return 0
    fi

    # Path fallback (Claude layout + legacy parent-dir) — branch may be missing
    # from porcelain in rare states; still never return principal.
    repo="$(gh repo view --json name --jq '.name' 2>/dev/null || echo "")"
    if [ -n "$n" ]; then
        if [ -n "$repo" ]; then
            pattern="${repo}-${n}([^0-9]|\$)|worktrees/${n}-"
        else
            pattern="worktrees/${n}-"
        fi
        found="$(git worktree list --porcelain 2>/dev/null \
            | sed -n 's/^worktree //p' \
            | grep -E "$pattern" \
            | head -1 || true)"
    elif [ -n "$slug" ]; then
        found="$(git worktree list --porcelain 2>/dev/null \
            | sed -n 's/^worktree //p' \
            | grep -F "worktrees/${slug}" \
            | head -1 || true)"
    fi

    if [ -n "$found" ] && [ "$found" != "$principal" ]; then
        printf '%s\n' "$found"
    fi
}

# ── Artifact classification (shared: dev/scan-state.sh, pr/gather-state.sh) ────
# artifacts/analyses/ is not exclusively analyses. Historically three writers used
# it, and legacy files stay where they were written:
#   /analyze    → α analysis          (type: analysis, or status: draft|approved)
#   /interview  → brainstorm          (type: brainstorm)   — now artifacts/brainstorms/
#   legacy      → consensus artifact  (status: consensus-reached) — /consensus removed 2026-08-03
# Filename is not a discriminator (≥4 live naming forms + .orig/.rej leftovers), so
# classify on FRONTMATTER.
#
# Implementation is TypeScript (artifact-classify.ts), not bash/awk. Hand-rolled
# YAML fence parsers failed three review rounds (CRLF/BOM/trailing-space on ---,
# unterminated fence treating body as header, first-wins vs YAML last-wins). The
# TS module is unit-tested; these wrappers only dispatch. Do not re-implement
# classification in bash — extend artifact-classify.ts and its tests.

_ARTIFACT_CLASSIFY_TS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/artifact-classify.ts"

_artifact_classify() {
    if ! command -v bun >/dev/null 2>&1; then
        printf 'artifact-classify: bun not found on PATH\n' >&2
        return 127
    fi
    bun "$_ARTIFACT_CLASSIFY_TS" "$@"
}

# analysis | brainstorm | consensus | missing | malformed
artifact_kind() {
    _artifact_classify kind "${1:-}"
}

# Normalized status (lowercased), or empty when absent / unreadable.
artifact_status() {
    _artifact_classify status "${1:-}"
}

# kind|status — same contract as scan-state.sh --classify-artifact.
artifact_classify() {
    _artifact_classify classify "${1:-}"
}

# First file in <dir> that is BOTH name-matched (anchored N, else slug) AND kind=analysis.
# The name match only narrows candidates; the kind check decides. Prints "" when none.
resolve_analysis() {
    _artifact_classify resolve "${1:-}" "${2:-}" "${3:-}"
}

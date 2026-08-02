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
# classify on FRONTMATTER. Both consumers call these — ¬re-implement per callsite.

# Emit ONLY the YAML frontmatter block: from the opening `---` to the next `---`.
# Scanning the file body instead (e.g. `head -30`) cannot tell a document's
# declaration from its content: an analysis that merely quotes `status:
# consensus-reached` in a fenced example would classify as consensus and become
# permanently unresolvable. No line cap — the fence is the boundary.
artifact_frontmatter() {
    local f="$1"
    [ -f "$f" ] || return 0
    awk 'NR==1 && $0!="---" {exit} NR==1 {next} /^---[[:space:]]*$/ {exit} {print}' "$f"
}

# analysis | brainstorm | consensus | missing
# A file with no frontmatter defaults to `analysis`: legacy artifacts predate the
# `type:` key and are genuine analyses (3 such files exist in this repo). Positive
# `type:` is checked first so new files are identified rather than defaulted.
artifact_kind() {
    local f="$1" fm
    [ -f "$f" ] || { printf 'missing\n'; return 0; }
    case "$f" in *.orig|*.rej|*.bak|*~) printf 'missing\n'; return 0 ;; esac
    fm=$(artifact_frontmatter "$f")
    if printf '%s\n' "$fm" | grep -qiE '^type:[[:space:]]*["'\'']?brainstorm'; then
        printf 'brainstorm\n'
    elif printf '%s\n' "$fm" | grep -qiE '^type:[[:space:]]*["'\'']?analysis'; then
        printf 'analysis\n'
    elif printf '%s\n' "$fm" | grep -qiE '^status:[[:space:]]*["'\'']?consensus-reached'; then
        printf 'consensus\n'
    else
        printf 'analysis\n'
    fi
}

# Normalized `status:` value from the frontmatter, or empty when absent.
# Normalizes the spellings YAML treats as equivalent but a string compare does not:
# surrounding quotes, a trailing ` # comment`, and case. Without this,
# `status: "Approved"` reads as not-approved and stalls the pipeline.
artifact_status() {
    local f="$1"
    [ -f "$f" ] || return 0
    case "$f" in *.orig|*.rej|*.bak|*~) return 0 ;; esac
    artifact_frontmatter "$f" \
        | grep -iE '^status:[[:space:]]*' \
        | head -1 \
        | sed -E 's/^[Ss][Tt][Aa][Tt][Uu][Ss]:[[:space:]]*//; s/[[:space:]]+#.*$//; s/^["'\'']//; s/["'\''][[:space:]]*$//; s/[[:space:]]*$//' \
        | tr '[:upper:]' '[:lower:]'
}

# First file in <dir> that is BOTH name-matched (anchored N, else slug) AND kind=analysis.
# The name match only narrows candidates; the kind check decides. Prints "" when none.
resolve_analysis() {
    local dir="$1" n="$2" slug="$3" anchor cand
    [ -d "$dir" ] || return 0
    anchor="(^|[^0-9])${n}-"
    while IFS= read -r cand; do
        [ -n "$cand" ] || continue
        if [ "$(artifact_kind "${dir}/${cand}")" = "analysis" ]; then
            printf '%s\n' "$cand"
            return 0
        fi
    done <<EOF
$( [ -n "$n" ] && ls "$dir" 2>/dev/null | grep -E "$anchor" || true)
$( [ -n "$slug" ] && ls "$dir" 2>/dev/null | grep -iF -- "$slug" || true)
EOF
    return 0
}

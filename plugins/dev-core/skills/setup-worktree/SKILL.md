---
name: R-setup-worktree
argument-hint: '[--issue <N> --slug <slug>]'
description: Create + link feature branch to issue, then check out worktree. Triggers: "setup worktree" | "create worktree" | "prepare workspace" | "bootstrap branch".
version: 0.3.2
allowed-tools: Bash, Read, EnterWorktree, ExitWorktree, ToolSearch
---

# Setup Worktree

## Success

I := branch ∃ on origin ∧ linked to issue (∃N) ∧ ω ∃ ∧ principal on β ∧ status "In Progress" (∃N)
V := `gh issue develop --list {N} | grep feat/<N>-<slug>` ∧ `find_feature_worktree` non-empty ∧ `principal_ok=true`

Let:
  N    := issue number (∅ if frame-only)
  slug := kebab-case title slug
  BRANCH := `feat/{N}-{slug}` (∃N) ∨ `feat/{slug}` (¬N)
  β    := base branch (staging if ∃ origin/staging, else main) — `detect_base_branch`
  principal := main checkout (must stay on β — **never** switch to BRANCH)
  ω    := non-principal worktree checked out on BRANCH (path = harness layout)
  H_wt := claude-enter | harness-default — see [harness-worktree.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-worktree.md)

One-time setup per issue. Idempotent — safe to re-run if branch/link/ω already exist.

**SSoT dual-harness:** [harness-worktree.md](${CLAUDE_PLUGIN_ROOT}/skills/shared/references/harness-worktree.md)

## Entry

```
/R-setup-worktree --issue 42 --slug dark-mode    Create + link feat/42-dark-mode + ω for #42
/R-setup-worktree --slug spike-foo               Frame-only (no link, no issue)
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 0 | probe H_wt | ✓ | claude-enter ∨ harness-default | tools available |
| 1 | detect | ✓ | β, principal_ok, WORKTREE, REMOTE_BRANCH, LINKED | idempotent |
| 2 | branch + link | ✓ | branch on origin + linked to issue | `gh issue develop` (atomic create+link) |
| 3 | worktree + deps | ✓ | ω ∃ + deps installed | skip if exists; **¬** touch principal branch |
| 4 | status | — | issue status updated | optional |

## Step 0 — Probe H_wt

```
if tools ∋ EnterWorktree ∧ ExitWorktree → H_wt := claude-enter
else                                    → H_wt := harness-default
```

## Step 1 — Detect

```bash
BASE=$(. "${CLAUDE_SKILL_DIR}/../shared/lib.sh" && detect_base_branch)
# shellcheck source=../shared/lib.sh
. "${CLAUDE_SKILL_DIR}/../shared/lib.sh"
git fetch origin "$BASE" 2>&1

if [ -n "$N" ]; then
  BRANCH="feat/${N}-${slug}"
else
  BRANCH="feat/${slug}"
fi

PRINCIPAL=$(principal_worktree_path)
PRINCIPAL_BRANCH=$(principal_branch)
is_base_branch "$PRINCIPAL_BRANCH" && PRINCIPAL_OK=true || PRINCIPAL_OK=false

WT_PATH=$(find_feature_worktree "$N" "$slug")
[ -n "$WT_PATH" ] && WORKTREE=exists || WORKTREE=false

git ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q . && REMOTE_BRANCH=exists || REMOTE_BRANCH=false
if [ -n "$N" ]; then
  gh issue develop --list "$N" 2>/dev/null | grep -qF "$BRANCH" && LINKED=exists || LINKED=false
else
  LINKED=na
fi
```

`PRINCIPAL_OK` = false → **STOP**. Present choice: **Switch principal to $BASE** (`git -C "$PRINCIPAL" switch "$BASE"` after user confirms) | **Abort**.  
**¬** silently leave principal on a feat branch. **¬** use principal as ω.

## Step 2 — Create + Link Branch on Origin

Run from principal CWD (or any path). **Never** `git switch "$BRANCH"` on principal.

∃ N ∧ `LINKED` = false ∧ `REMOTE_BRANCH` = false → atomic create + link via `gh issue develop`:
```bash
gh issue develop "$N" --base "$BASE" --name "$BRANCH"
```

∃ N ∧ `LINKED` = false ∧ `REMOTE_BRANCH` = exists → branch pushed before /R-dev workflow. **Cannot auto-link existing remote branches** — the `createLinkedBranch` GraphQL mutation is create-only. Warn:
```bash
echo "WARN: $BRANCH on origin but not linked to #$N — attach manually via the issue's Development panel." >&2
```

¬N (frame-only) ∧ `REMOTE_BRANCH` = false → push base SHA to new branch on origin (no link, no issue):
```bash
git push origin "${BASE}:refs/heads/${BRANCH}"
```

Why `gh issue develop`: the underlying `createLinkedBranch` GraphQL mutation **only creates** new branches. If the branch already exists on origin, the mutation returns `linkedBranch: null` silently. So linking has to happen at branch-creation time — never after the fact.

## Step 3 — Worktree + Install

`WORKTREE` = exists → skip create (ω already checked out on BRANCH).

`WORKTREE` = false → fetch + add **non-principal** worktree:

```bash
git fetch origin "$BRANCH"

# Create path by H_wt (layout only — detection stays branch-first)
if [ "$H_wt" = "claude-enter" ]; then
  if [ -n "$N" ]; then
    WT_PATH="${PRINCIPAL}/.claude/worktrees/${N}-${slug}"
  else
    WT_PATH="${PRINCIPAL}/.claude/worktrees/${slug}"
  fi
else
  # harness-default (Grok): stable path under ~/.grok/worktrees/<slug>/
  WT_PATH=$(suggested_grok_worktree_path "$N" "$slug")
fi

mkdir -p "$(dirname "$WT_PATH")"
git worktree add "$WT_PATH" "$BRANCH"
```

**¬** `git checkout` / `switch` BRANCH on principal after add.

### Enter + install

**H_wt = claude-enter:**
```
EnterWorktree(path: "$WT_PATH")
```
```bash
cp .env.example .env 2>/dev/null; {package_manager} install
# Optional: {commands.worktree_setup} <N>
```

**H_wt = harness-default:**  
Do **not** expect `EnterWorktree`. All subsequent code ops use `$WT_PATH` as CWD (`cd` in bash, Write/Edit absolute under ω, or `spawn_subagent(cwd: WT_PATH)`). Session may already be inside a Grok worktree on BRANCH — if `find_feature_worktree` found it, skip create and use that path.

```bash
cd "$WT_PATH"
cp .env.example .env 2>/dev/null; {package_manager} install
# Optional: {commands.worktree_setup} <N>
```

### Post-assert

```bash
is_base_branch "$(principal_branch)" || { echo "FATAL: principal left base branch" >&2; exit 1; }
git -C "$WT_PATH" rev-parse --abbrev-ref HEAD | grep -qx "$BRANCH"
```

## Step 4 — Issue Status (optional)

∃ N →
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set "$N" --status "In Progress"
```

## Exit

- **Success:** BRANCH on origin + link (∃N) + ω ∃ + principal on β. Return silently.
- **Idempotent re-run:** all detect flags exist → skip → return silently.
- **Failure:** propagate `gh issue develop` errors (do not swallow — caller decides).
- **Migration edge (remote branch pre-existed):** warn on stderr, continue with worktree; user links manually via UI.
- **Principal not on β:** stop until user restores β (Step 1).

## Chain Position

- **Phase:** Frame (pre-step)
- **Predecessor:** `/issue-triage`
- **Successor:** `/R-frame`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/R-dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

$ARGUMENTS

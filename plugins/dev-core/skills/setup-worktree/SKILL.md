---
name: setup-worktree
argument-hint: '[--issue <N> --slug <slug>]'
description: Create + link feature branch to issue, then check out worktree. Triggers: "setup worktree" | "create worktree" | "prepare workspace" | "bootstrap branch".
version: 0.3.1
allowed-tools: Bash, Read, EnterWorktree, ExitWorktree, ToolSearch
---

# Setup Worktree

## Success

I := branch ∃ on origin ∧ linked to issue (∃N) ∧ ω ∃ ∧ status "In Progress" (∃N)
V := `gh issue develop --list {N} | grep feat/<N>-<slug>` ∧ `git worktree list | grep "$WT_PATH"`

Let:
  N    := issue number (∅ if frame-only)
  slug := kebab-case title slug
  ω    := worktree at `.claude/worktrees/{N}-{slug}` (∃N) ∨ `.claude/worktrees/{slug}` (¬N)
  β    := base branch (staging if ∃ origin/staging, else main)

One-time setup per issue. Idempotent — safe to re-run if branch/link/ω already exist.

## Entry

```
/setup-worktree --issue 42 --slug dark-mode    Create + link feat/42-dark-mode + ω for #42
/setup-worktree --slug spike-foo               Frame-only (no link, no issue)
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | detect | ✓ | β, WORKTREE, REMOTE_BRANCH, LINKED | idempotent |
| 2 | branch + link | ✓ | branch on origin + linked to issue | `gh issue develop` (atomic create+link) |
| 3 | worktree + deps | ✓ | ω ∃ + deps installed | skip if exists |
| 4 | status | — | issue status updated | optional |

## Step 1 — Detect

```bash
BASE=$(. "${CLAUDE_SKILL_DIR}/../shared/lib.sh" && detect_base_branch)
git fetch origin "$BASE" 2>&1

# Paths depend on mode (issue vs frame-only)
if [ -n "$N" ]; then
  WT_PATH=".claude/worktrees/${N}-${slug}"
  BRANCH="feat/${N}-${slug}"
else
  WT_PATH=".claude/worktrees/${slug}"
  BRANCH="feat/${slug}"
fi

git worktree list | grep -qF "$WT_PATH" && WORKTREE=exists || WORKTREE=false
git ls-remote --heads origin "$BRANCH" 2>/dev/null | grep -q . && REMOTE_BRANCH=exists || REMOTE_BRANCH=false
if [ -n "$N" ]; then
  gh issue develop --list "$N" 2>/dev/null | grep -qF "$BRANCH" && LINKED=exists || LINKED=false
else
  LINKED=na
fi
```

## Step 2 — Create + Link Branch on Origin

∃ N ∧ `LINKED` = false ∧ `REMOTE_BRANCH` = false → atomic create + link via `gh issue develop`:
```bash
gh issue develop "$N" --base "$BASE" --name "$BRANCH"
```

∃ N ∧ `LINKED` = false ∧ `REMOTE_BRANCH` = exists → branch pushed before /dev workflow. **Cannot auto-link existing remote branches** — the `createLinkedBranch` GraphQL mutation is create-only. Warn:
```bash
echo "WARN: $BRANCH on origin but not linked to #$N — attach manually via the issue's Development panel." >&2
```

¬N (frame-only) ∧ `REMOTE_BRANCH` = false → push base SHA to new branch on origin (no link, no issue):
```bash
git push origin "${BASE}:refs/heads/${BRANCH}"
```

Why `gh issue develop`: the underlying `createLinkedBranch` GraphQL mutation **only creates** new branches. If the branch already exists on origin, the mutation returns `linkedBranch: null` silently. So linking has to happen at branch-creation time — never after the fact.

## Step 3 — Worktree + Install

`WORKTREE` = false → fetch the now-existing remote branch + add worktree from it:
```bash
git fetch origin "$BRANCH"
git worktree add "$WT_PATH" "$BRANCH"
```

`WORKTREE` = exists → skip (worktree already checked out).

Enter + install:
```
EnterWorktree(path: "$WT_PATH")
```
```bash
cp .env.example .env 2>/dev/null; {package_manager} install
```

## Step 4 — Issue Status (optional)

∃ N →
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set "$N" --status "In Progress"
```

## Exit

- **Success:** branch on origin + link (∃N) + ω ∃. Return silently.
- **Idempotent re-run:** all detect flags exist → skip → return silently.
- **Failure:** propagate `gh issue develop` errors (do not swallow — caller decides).
- **Migration edge (remote branch pre-existed):** warn on stderr, continue with worktree; user links manually via UI.

## Chain Position

- **Phase:** Frame (pre-step)
- **Predecessor:** `/issue-triage`
- **Successor:** `/frame`
- **Class:** adv (continuous flow, no gate)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- This skill does NOT update its own dev-pipeline task
- Sub-tasks created: none

$ARGUMENTS

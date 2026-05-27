---
name: setup-worktree
argument-hint: '[--issue <N> --slug <slug>]'
description: Create worktree + feature branch + push to signal work-in-progress. Triggers: "setup worktree" | "create worktree" | "prepare workspace" | "bootstrap branch".
version: 0.1.0
allowed-tools: Bash, Read, EnterWorktree, ExitWorktree, ToolSearch
---

# Setup Worktree

## Success

I := ω ∃ ∧ branch ∃ on origin ∧ status "In Progress"
V := `git worktree list | grep "worktrees/${N}-*"` ∧ `git ls-remote --heads origin feat/<N>-<slug>`

Let:
  N    := issue number
  slug := kebab-case title slug
  ω    := worktree at `.claude/worktrees/{N}-{slug}`
  β    := base branch (staging if ∃ origin/staging, else main)

One-time setup per issue. Idempotent — safe to re-run if ω already exists.

## Entry

```
/setup-worktree --issue 42 --slug dark-mode    Create ω + branch for #42
```

## Pipeline

| Step | ID | Required | Verifies via | Notes |
|------|----|----------|---------------|-------|
| 1 | detect | ✓ | β, existing ω, existing branch | idempotent |
| 2 | create | ✓ | ω ∃ | skip if exists |
| 3 | branch | ✓ | `feat/<N>-<slug>` on origin | skip if pushed |
| 4 | status | — | issue status updated | optional |

## Step 1 — Detect

```bash
BASE=$(git branch -r 2>/dev/null | grep -q 'origin/staging' && echo staging || echo main)
REPO=$(gh repo view --json name --jq '.name' 2>/dev/null || echo "unknown")
```

Existing checks:
```bash
git worktree list | grep "worktrees/${N}-${slug}" && echo "worktree=exists" || echo "worktree=false"
git branch -a | grep "feat/${N}-${slug}" && echo "branch=exists" || echo "branch=false"
git ls-remote --heads origin "feat/${N}-${slug}" && echo "remote=exists" || echo "remote=false"
```

Fetch base:
```bash
git fetch origin "$BASE" 2>&1
```

## Step 2 — Create / Enter Worktree

`worktree` = false → create with correct branch, then enter:
```bash
git worktree add .claude/worktrees/{N}-{slug} -b feat/{N}-{slug} origin/${BASE}
```
```
EnterWorktree(path: ".claude/worktrees/{N}-{slug}")
```

Inside ω:
```bash
cp .env.example .env 2>/dev/null; {package_manager} install
```

`worktree` = exists → enter:
```
EnterWorktree(path: ".claude/worktrees/{N}-{slug}")
```

Frame-only mode (¬N): path = `.claude/worktrees/{slug}`, branch = `feat/{slug}`.
```bash
git worktree add .claude/worktrees/{slug} -b feat/{slug} origin/${BASE}
```
```
EnterWorktree(path: ".claude/worktrees/{slug}")
```

## Step 3 — Push

Branch already created at Step 2. Push idempotent:
```bash
git push -u origin feat/{N}-{slug}
```

Frame-only mode (¬N): `git push -u origin feat/{slug}`.

## Step 4 — Issue Status (optional)

∃ N →
```bash
bun ${CLAUDE_PLUGIN_ROOT}/skills/issue-triage/triage.ts set N --status "In Progress"
```

## Exit

- **Success:** ω ∃, branch pushed. Return silently.
- **Idempotent re-run:** detect existing → enter → verify pushed → return silently.
- **Failure:** return error.

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

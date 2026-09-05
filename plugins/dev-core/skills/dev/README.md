# dev

Single entry point for the full dev lifecycle — scan artifacts, detect state, drive the pipeline from issue to merge.

## When to use

```
/R-dev #42             Resume or start work on issue #42
/R-dev "dark mode"     Find or create an issue, then start
/R-dev #42 --from spec Jump directly to a specific step
/R-dev #42 --audit     Enable reasoning checkpoints before critical steps
/R-dev --cleanup-context  Audit and clean CLAUDE.md, skills, memory
```

**Triggers:** `"dev"` | `"start working on"` | `"work on issue"` | `"work on #"` | `"develop"` | `"pick up issue"` | `"tackle issue"` | `"let's work on"`

## How it works

`/R-dev` scans existing artifacts (frames, analyses, specs, plans, worktrees, PRs) to determine where you left off, then drives the pipeline step by step without re-running completed work. Issue triage (`issue-triage:issue-triage`) is an **external** step that runs before `/R-dev` — it lives in the `issue-triage` plugin, not dev-core. `/R-dev`'s own pipeline starts with `/R-recheck` — a drift check that catches stale issues (git/symbol/dep drift) before any artifact is written.

Worktrees: principal checkout stays on staging/main; feature work runs in a non-principal worktree on `feat/{N}-{slug}` (Claude or Grok layout). See `skills/shared/references/harness-worktree.md`.

Pipeline phases:

| Phase | Steps |
|-------|-------|
| Frame | recheck → frame |
| Shape | analyze → spec |
| Build | plan → implement → pr |
| Verify | ci-watch → validate → review → fix |
| Ship | promote → cleanup |

Tier affects which steps run:

| Step | S | F-lite | F-full |
|------|---|--------|--------|
| frame | skip | run + approval stop | run + approval stop |
| analyze | skip | skip | run + approval stop |
| spec | skip | run + approval stop | run + approval stop |
| plan | skip | run + approval stop | run + approval stop |
| implement | run | run | run |

## Options

| Flag | Description |
|------|-------------|
| `#N` | Resume/start from a GitHub issue |
| `"idea"` | Find or create issue from free text |
| `--from <step>` | Jump to a specific step (warn if deps missing) |
| `--audit` | Show reasoning checkpoint before critical steps |
| `--cleanup-context` | Delegate to `/R-cleanup-context` |

## Chain position

Entry point of the full dev pipeline. Preceded by the external `issue-triage:issue-triage` step (not dev-core). Delegates to: `/R-recheck` → `/R-frame` → `/R-analyze` → `/R-spec` → `/R-dev-plan` → `/R-dev-implement` → `/R-pr` → `/R-ci-watch` → `/R-validate` → `/R-dev-review` → `/R-fix` → `/R-cleanup`.

**Code already ready?** Use `/R-ship` instead — commit → PR → review → fix loop → `reviewed` + ci-watch (review-before-CI order).

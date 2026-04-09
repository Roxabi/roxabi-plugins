# dev

Single entry point for the full dev lifecycle — scan artifacts, detect state, drive the pipeline from issue to merge.

## When to use

```
/dev #42             Resume or start work on issue #42
/dev "dark mode"     Find or create an issue, then start
/dev #42 --from spec Jump directly to a specific step
/dev #42 --audit     Enable reasoning checkpoints before critical steps
/dev --cleanup-context  Audit and clean CLAUDE.md, skills, memory
```

**Triggers:** `"dev"` | `"start working on"` | `"work on issue"` | `"work on #"` | `"develop"` | `"pick up issue"` | `"tackle issue"` | `"let's work on"`

## How it works

`/dev` scans existing artifacts (frames, analyses, specs, plans, worktrees, PRs) to determine where you left off, then drives the pipeline step by step without re-running completed work.

Pipeline phases:

| Phase | Steps |
|-------|-------|
| Frame | triage → frame |
| Shape | analyze → spec |
| Build | plan → implement → pr |
| Verify | ci-watch → validate → review → fix |
| Ship | promote → cleanup |

Tier affects which steps run:

| Step | S | F-lite | F-full |
|------|---|--------|--------|
| frame | skip | gate | gate |
| analyze | skip | skip | run |
| spec | skip | gate | gate |
| plan | skip | gate | gate |
| implement | run | run | run |

## Options

| Flag | Description |
|------|-------------|
| `#N` | Resume/start from a GitHub issue |
| `"idea"` | Find or create issue from free text |
| `--from <step>` | Jump to a specific step (warn if deps missing) |
| `--audit` | Show reasoning checkpoint before critical steps |
| `--cleanup-context` | Delegate to `/cleanup-context` |

## Chain position

Entry point of the full dev pipeline. Delegates to: `/issue-triage` → `/frame` → `/analyze` → `/spec` → `/plan` → `/implement` → `/pr` → `/ci-watch` → `/validate` → `/code-review` → `/fix` → `/cleanup`.

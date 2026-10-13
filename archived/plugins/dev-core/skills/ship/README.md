# ship

Meta-orchestrator to land **ready** code on a feature branch:

```
commit → /R-pr → /R-dev-review → [/R-fix ↺ /R-dev-review] → reviewed label → /R-ci-watch → [/R-cleanup]
```

## When to use

```
/R-ship                    Full gate path on current feature branch
/R-ship --draft            Open a draft PR first
/R-ship --from review      PR already open — start at agent review
/R-ship --max-fix-iters 1  Single fix pass only
/R-ship --skip-cleanup     Leave branches/worktrees after merge
```

**Triggers:** `"ship"` | `"ship this"` | `"land this"` | `"land the PR"` | `"ship PR"` | `"submit for merge"` | `"get this merged"` | `"ship my branch"`

Use when implementation is already done (or mostly done) and you want review + merge-on-green without running `/R-dev` Frame/Shape/Build.

## vs `/R-dev`

| | `/R-dev` | `/R-ship` |
|---|--------|---------|
| Starts from | GitHub issue + artifacts | Current feature branch |
| Pipeline | recheck→…→implement→pr→**ci-watch**→validate→**review**→fix→cleanup | **commit**→pr→**review**→fix loop→**reviewed+ci-watch**→cleanup |
| validate | yes | no |
| Ideal for | Greenfield issue work | Hotfix, agent-coded branch, “just land it” |

## How it works

1. **commit** — if the tree is dirty, conventional-commit + push (skipped when clean).
2. **pr** — delegates to `/R-pr` (create or update).
3. **code-review** — delegates to `/R-dev-review`.
4. **fix loop** — on CHANGES_REQUESTED, `/R-fix` then re-review (max 2). Strips a premature `reviewed` label after fix so merge-on-green cannot fire mid-loop.
5. **reviewed + ci-watch** — adds `reviewed`, enables auto-merge when possible, watches CI/merge via `/R-ci-watch`.
6. **cleanup** — optional post-merge `/R-cleanup`.

## Chain position

**Predecessor:** finished coding on a feature branch · **Successor:** `/R-promote` (if base is staging) · **Class:** meta-orchestrator

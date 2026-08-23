# ship

Meta-orchestrator to land **ready** code on a feature branch:

```
commit → /pr → /dev-review → [/fix ↺ /dev-review] → reviewed label → /ci-watch → [/cleanup]
```

## When to use

```
/ship                    Full gate path on current feature branch
/ship --draft            Open a draft PR first
/ship --from review      PR already open — start at agent review
/ship --max-fix-iters 1  Single fix pass only
/ship --skip-cleanup     Leave branches/worktrees after merge
```

**Triggers:** `"ship"` | `"ship this"` | `"land this"` | `"land the PR"` | `"ship PR"` | `"submit for merge"` | `"get this merged"` | `"ship my branch"`

Use when implementation is already done (or mostly done) and you want review + merge-on-green without running `/dev` Frame/Shape/Build.

## vs `/dev`

| | `/dev` | `/ship` |
|---|--------|---------|
| Starts from | GitHub issue + artifacts | Current feature branch |
| Pipeline | recheck→…→implement→pr→**ci-watch**→validate→**review**→fix→cleanup | **commit**→pr→**review**→fix loop→**reviewed+ci-watch**→cleanup |
| validate | yes | no |
| Ideal for | Greenfield issue work | Hotfix, agent-coded branch, “just land it” |

## How it works

1. **commit** — if the tree is dirty, conventional-commit + push (skipped when clean).
2. **pr** — delegates to `/pr` (create or update).
3. **review** — delegates to `/dev-review`.
4. **fix loop** — on CHANGES_REQUESTED, `/fix` then re-review (max 2). Strips a premature `reviewed` label after fix so merge-on-green cannot fire mid-loop.
5. **reviewed + ci-watch** — adds `reviewed`, enables auto-merge when possible, watches CI/merge via `/ci-watch`.
6. **cleanup** — optional post-merge `/cleanup`.

## Chain position

**Predecessor:** finished coding on a feature branch · **Successor:** `/promote` (if base is staging) · **Class:** meta-orchestrator

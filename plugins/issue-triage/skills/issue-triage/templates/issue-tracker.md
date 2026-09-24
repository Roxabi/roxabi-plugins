# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `{{REPO}}`.
Infer the repo from `git remote -v`; `gh` does this automatically inside a clone.

**Reads use `gh` directly. issue-triage is the only writer of labels and
relations** — `bun skill://issue-triage/triage.ts`. Nothing else writes them.
Not `gh issue create`, not `gh issue edit --add-label`, not a `Blocked by:` line in a body.

## Relations

Relations are **native GitHub**: sub-issues for parent/child, issue dependencies
for blocked-by / blocks. A `Blocked by:` line in a body is **not** a relation.

| Need | Flag |
|---|---|
| Create an issue | `create --title "..."` |
| Parent | `--parent "#N"` |
| Blocked by | `--blocked-by "#N"` |
| Tier | `--size S` \| `F-lite` \| `F-full` |
| Priority | `--priority P0` \| `P1` \| `P2` \| `P3` |
| Change an existing issue | `set <number> <same flags>` |

### Tier is mandatory

Every ticket carries a `size:` label. It is the only source of the review tier.
A ticket without one is reviewed as `F-lite`.

| Label | Meaning |
|---|---|
| `size:S` | one worktree, direct implementation |
| `size:F-lite` | worktree + a small agent panel |
| `size:F-full` | worktree + the full panel, test-first |

### Deferred follow-ups are siblings

A follow-up deferred out of issue A is a **sibling** of A under their shared
parent, blocked-by A — never a child of A.

### No `ready-for-agent`

This repo does not use that label. A ticket is grabbable when every blocker is
closed. Applying `ready-for-agent` would be a second copy of a fact GitHub
already computes.

## Labels in use

{{LABELS}}

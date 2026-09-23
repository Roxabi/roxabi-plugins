# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `Roxabi/roxabi-plugins`.
Infer the repo from `git remote -v`; `gh` does this automatically inside a clone.

**Reads use `gh` directly. Every write that creates an issue, sets a label, or
creates a relation goes through the `issue-triage` skill** — see
[Relations and labels](#relations-and-labels). Authority: ADR-020 §6.

## Read conventions

- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with `--label` / `--state` filters
- **Comment**: `gh issue comment <number> --body "..."` (heredoc for multi-line)
- **Close**: `gh issue close <number> --comment "..."`
- **Tree of open issues with parent/child hierarchy**: the `issue-triage` skill's `list`

`gh issue view` shows sub-issues and the dependency summary, so a read needs no
extra call to see relations.

## Relations and labels

Relations are **native GitHub**: sub-issues for parent/child, issue dependencies
for blocked-by / blocks. A `Blocked by: #12` line in a body is **not** a relation —
it is invisible to the frontier query and to `gh issue view`. Never write one.

Invoke the `issue-triage` skill (`/issue-triage`, or `Skill("issue-triage:issue-triage")`)
rather than calling the API by hand: it owns the GraphQL mutations, accepts
cross-repo refs (`OWNER/REPO#N`), and is the only place these relations are
written.

| Need | Flag |
|---|---|
| Create an issue | `create --title "..." [--body "..."]` |
| Parent (issue is a child of N) | `--parent "#N"` |
| Children | `--add-child "#N,#M"` |
| Blocked by | `--blocked-by "#N"` |
| Blocks | `--blocks "#N"` |
| Tier | `--size S` \| `F-lite` \| `F-full` |
| Priority | `--priority Urgent` \| `High` \| `Medium` \| `Low` (also `P0`–`P3` and the label spelling `P3-low`) |
| Type | `--type feat` \| `fix` \| `docs` \| `test` \| `chore` \| `ci` \| `perf` \| `epic` \| `research` \| `refactor` |
| Change an existing issue | `set <number> <same flags>` |

Requires the plugin: `omp plugin install issue-triage@roxabi-marketplace`. If the
skill is unavailable, **stop and say so** — do not fall back to `gh issue create`
for anything carrying a relation or a tier.

### Tier is mandatory

Every ticket carries a `size:` label. It is the **only** source of the review tier
(`R-dev-review` reads τ from the issue labels), so a ticket created without one
silently downgrades its own review to `F-lite`.

| Label | Meaning |
|---|---|
| `size:S` | one worktree, direct implementation, no agents |
| `size:F-lite` | worktree + a small agent panel |
| `size:F-full` | worktree + the full panel, test-first |

The tier is derived from the body, so **a body edit that changes scope is not
complete until the tier is re-asserted** — `T set <n> --size <tier>`, even when
the answer is the tier already on the label.

A stale `size:` gives no first contact. Nothing re-checks the label after the
thing it describes has changed, and `R-dev-review` simply consumes it and
proceeds with the wrong panel — so the defect surfaces as an under-reviewed
ticket that *looks* reviewed. The exposed case is one author growing a ticket's
scope with no reviewer between the two acts, which is the case with no natural
check.

### Deferred follow-ups are siblings

A follow-up deferred out of issue A is a **sibling** of A under their shared
parent, blocked-by A — never a child of A:

```
       Epic E
      ╱      ╲
     A ←—————— B     B.parent = A.parent (= E)
       blocked-by    B.blocked-by = A
```

This keeps the epic's fan-out flat instead of building a nested cascade. Planned
decomposition (epic → phase) *is* parent/child; post-hoc deferral is not. Full
rule: the `issue-triage` skill, § Deferred Follow-Ups.

### No `ready-for-agent`

This repo does not use that label. A ticket is grabbable when every blocker is
closed — read `issue_dependencies_summary.blocked_by` (open blockers only), not a
label. Applying `ready-for-agent` would be a second, hand-maintained copy of a
fact GitHub already computes.

## When a skill says "publish to the issue tracker"

Create a GitHub issue through `issue-triage`, with a `size:` label and whatever
relations the work implies.

**Exception — an epic already exists for the subject.** When the conversation is
already tracked by an issue (the grill ran before the spec, the issue holds the
decisions), **amend that issue** instead of publishing a second one. One subject,
one spec home.

## When a skill says "fetch the relevant ticket"

`gh issue view <number> --comments`.

## Pull requests as a triage surface

**PRs as a request surface: no.**

PRs are the landing surface, not an intake queue: a PR merges on the `reviewed`
label plus green required checks. External PRs are not triaged as feature
requests.

## Labels in use

Type: `bug` `enhancement` `feature` `refactor` `docs` `documentation` `chore`
`research` `test`
Area: `dev-core` `marketplace` `forge` `backend` `frontend` `api` `infra`
`design` `init` `review` `dependencies` `javascript` `github_actions`
Tier: `size:S` `size:F-lite` `size:F-full` · `epic`
Priority: `P0-critical` `P1-high` `P2-medium` `P3-low` (legacy `priority:P2`,
`priority:P3`, `priority: low` exist; prefer the `PN-` form)
Pipeline: `reviewed` (gates auto-merge) · `autorelease: pending` /
`autorelease: tagged` (written by release automation, never by hand)

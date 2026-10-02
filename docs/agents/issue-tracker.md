# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues in `Roxabi/roxabi-plugins`.
Infer the repo from `git remote -v`; `gh` does this automatically inside a clone.

**Reads use `gh` directly. Every write that creates an issue, sets a label, or
creates a relation goes through the `issue-triage` skill** — see
[Relations and labels](#relations-and-labels). CI workflows are the one exception:
[Issues filed by CI](#issues-filed-by-ci). Authority: ADR-020 §6.

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

The tier is derived from the body by the κ rubric in the `issue-triage` skill
(files · risk · architecture · unknowns · domains), so **a body edit that
changes any κ input is not complete until the tier is re-asserted** —
`/issue-triage set <n> --size <tier>`.

It moves in both directions. Adding an acceptance criterion or pasting review
findings raises it; adding a reproduction or splitting work out of the ticket
lowers it. Correcting a factual error touches no κ input and re-opens nothing.

Re-asserting the **same** tier writes no label event, so it leaves no trace that
anyone looked. When the answer is unchanged, say so in a comment instead — an
unchanged tier after a scope edit is a decision, and a decision nobody can
distinguish from an omission has not been recorded.

A stale `size:` gives no first contact: `R-dev-review` consumes it and proceeds
with the wrong panel, so the defect surfaces as an under-reviewed ticket that
*looks* reviewed.

### Priority

The rubric lives in the `issue-triage` skill, § Priority Guidelines. `P1-high`
fires on either of two triggers: the milestone in progress, or a shipped check
that lies. A check that fails closed is `P2-medium`, and an epic caps its
feature slices but not its defects. This repo binds the two triggers:

- **Milestone**: the open `epic` that carries `P1-high`.
- **Shipped**: everything under `plugins/`, the published plugins. A gate,
  guard, verifier or success predicate there that reports a pass when it
  should fail or stop is `P1-high`, whatever the milestone.

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

### Issues filed by CI

Workflows create issues with `gh issue create`, not through `issue-triage`,
because CI has no skill runtime. They arrive **without** a `size:` label. Whoever
picks one up sets the tier first — `/issue-triage set <n> --size <tier>` — before
`/feature`, so the review does not fall back to `F-lite`.

- `.github/workflows/dependency-audit.yml` files two issues. The finding issue
  carries `security` + `dependencies` and is found again by `security` + its exact
  title. The "audit failed" issue carries `dependencies` only and is found by
  `dependencies` + its exact title; each failing run comments on it, and the next
  run on its ref that delivers its result (clean, or filed) closes it. Keep those
  labels and titles: a relabelled or renamed issue gets a duplicate on the next run.
- `.github/workflows/upstream-watch.yml` is meant to file drift issues, but files
  none today: its `upstream-update` label does not exist, and the failure is masked
  behind a green run (#649).

## When a skill says "publish to the issue tracker"

Create a GitHub issue through `issue-triage`, with a `size:` label and whatever
relations the work implies.

**Exception — an epic already exists for the subject.** When the conversation is
already tracked by an issue (the grill ran before the spec, the issue holds the
decisions), **amend that issue** instead of publishing a second one. One subject,
one spec home. An amendment that changes a κ input re-opens the tier — see
[Tier is mandatory](#tier-is-mandatory).

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
`design` `init` `review` `dependencies` `javascript` `github_actions` `security`
(`security`: a human triage label, and the dedup key of dependency-audit's finding
issue · `dependencies` `javascript` `github_actions`: Dependabot PR labels;
`dependencies` is also the dedup key of dependency-audit's "audit failed" issue —
never remove either label from the workflow's issues)
Tier: `size:S` `size:F-lite` `size:F-full` · `epic`
Priority: `P0-critical` `P1-high` `P2-medium` `P3-low` (legacy `priority:P2`,
`priority:P3`, `priority: low` exist; prefer the `PN-` form; meaning: [Priority](#priority))
Pipeline: `reviewed` (gates auto-merge) · `autorelease: pending` /
`autorelease: tagged` (written by release automation, never by hand)

Tracker vocabulary (what `issue-triage init` creates when missing; it never recolours an existing label):

| Label | Colour |
|---|---|
| `size:S` | bfd4f2 |
| `size:F-lite` | fbca04 |
| `size:F-full` | d93f0b |
| `P0-critical` | b60205 |
| `P1-high` | d93f0b |
| `P2-medium` | fbca04 |
| `P3-low` | 0e8a16 |
| `epic` | ededed |
| `reviewed` | ededed |

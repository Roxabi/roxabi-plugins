# Issue tracker: GitHub

Issues and specs for this repository live as GitHub issues in the repository behind `origin`.
`gh` does not infer that on its own: with no default set it ranks a remote named `upstream`
ahead of `origin`, so a product clone (which has both) must run `gh repo set-default
<org>/<product>` once per clone. This file names no repository, so a product inherits it
unchanged: it is a kit surface (`tool_mandated_paths` +
`protected_files` in `config/kit/zero-edit-zones.json`, ADR-0009 D1 amendment) and a product
never edits it.

**Product additions** — extra label families, lanes, external-tracker mirrors — live in
`docs/product/issue-tracker.md`. Read it too when it exists; it extends this contract and never
overrides the writer, the tier or the relations below.

`issue-triage init` and `/feature init` keep this file: an existing contract is authoritative
(`contract: keep-existing`, byte-identical after a run). `issue-triage init` creates any missing
label from [Labels](#labels) in the colour listed there.

## Writer

Every issue write goes through the `issue-triage` skill (`issue-triage:issue-triage`): creation,
`size:`, priority, type, and every relation.

Never `gh issue create`. Never a `Blocked by:` line in a body — it is invisible to
`gh issue view` and to the frontier query. If the skill is unavailable, stop and say so; do not
fall back to `gh issue create` for anything carrying a relation or a tier.

Reads use `gh`:

- **Read an issue**: `gh issue view <number> --comments`, and fetch labels.
- **List issues**: `gh issue list --state open --limit 500 --json number,title,body,labels,comments`
  with the filters the question needs (the default stops at 30).
- **Comment**: `gh issue comment <number> --body-file <file>`. A comment is not a relation and not
  a label.
- **Close**: comment first with `--body-file`, then `gh issue close <number>`, once the work is
  done. Text you did not write never goes on a command line. Do not close as a substitute for a
  missing relation.

## Pull requests as a triage surface

**PRs as a request surface: no.** A PR is the landing surface: it merges on the `reviewed` label
plus green checks (`merge-on-green.yml`). It is not an intake queue.

## When a skill says "publish to the issue tracker"

Create a GitHub issue through `issue-triage`, with a `size:` label and the relations the work
implies. When an issue already tracks the subject, amend that issue instead of publishing a
second one.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Labels

The triage vocabulary is exactly these seven labels (merge-gate and type labels are separate,
below). `issue-triage` exits 1 on a label the repository does not carry, so a clone without them
cannot be triaged. This table is the only list of their names and colours; create them once per
repository (kit and every product). `size:` is the only source of the review tier — see
[Tier](#tier).

| Role | Label | Colour |
|---|---|---|
| Size / tier | `size:S` | `bfd4f2` |
| Size / tier | `size:F-lite` | `fbca04` |
| Size / tier | `size:F-full` | `d93f0b` |
| Priority | `P0-critical` | `b60205` |
| Priority | `P1-high` | `d93f0b` |
| Priority | `P2-medium` | `fbca04` |
| Priority | `P3-low` | `0e8a16` |

```bash
gh label create 'size:S' --color bfd4f2 --force
gh label create 'size:F-lite' --color fbca04 --force
gh label create 'size:F-full' --color d93f0b --force
gh label create 'P0-critical' --color b60205 --force
gh label create 'P1-high' --color d93f0b --force
gh label create 'P2-medium' --color fbca04 --force
gh label create 'P3-low' --color 0e8a16 --force
```

Type is a GitHub issue type written by `issue-triage --type` (`feat`, `fix`, `docs`, `chore`,
`ci`, `refactor`, …), not a label. Any other label family — for example labels mirrored from an
external tracker — is a product surface, not this vocabulary: never use it in place of `size:` or
`P0-critical`. `reviewed` and `deps-automerge` are merge-gate labels, not triage.

## Tier

The `size:` label is the **only** source of the review tier τ. Do not infer τ from the diff size,
the issue title, or a spec file.

| Label | τ | What it costs |
|---|---|---|
| `size:S` | S | No SC→Test matrix in the PR body; no decision brief. |
| `size:F-lite` | F-lite | SC→Test matrix required in the PR body; `/feature` writes a decision brief (what, why, chosen solution, pros, cons, rejected alternatives) into the issue before publishing. |
| `size:F-full` | F-full | Same as F-lite, with the full review panel. |

No `size:` label → τ = `F-lite`, and say so out loud: a silent default is the failure
`issue-triage` exists to prevent. The tier is derived from the body by the κ rubric in
`issue-triage`; κ is advisory, the label is the record. A body edit that changes a κ input
(scope, acceptance, unknowns) re-opens the tier: re-assert it with `issue-triage set`, or say in a
comment that it is unchanged.

## Relations

Ticket links are native GitHub relations, written only by `issue-triage`:

- **Parent / child**: `--parent "#E"`. Planned decomposition (epic → phase) is parent/child.
- **Blocked-by**: `--blocked-by "#N"`. The frontier reads
  `GET /repos/{owner}/{repo}/issues/{n}/dependencies/blocked_by` and counts **open** blockers. Do
  not trust `issue_dependencies_summary.blocked_by` in the turn that wrote the edge — that counter
  lags.
- **Cross-repository**: `OWNER/REPO#N`, never a bare `#N`, when the other end lives elsewhere.

A `Blocked by:` line in the body is not a relation.

## Deferred follow-ups are siblings

A follow-up deferred out of issue A is a **sibling** of A under their shared parent, blocked-by A
— never a child of A. This keeps the epic's fan-out flat instead of building a nested cascade.
Planned decomposition (epic → phase) *is* parent/child; post-hoc deferral is not.

Create that sibling through `issue-triage`, with `--parent` set to A's parent (omit it when A has
none) and `--blocked-by` set to A. Never `--parent` A.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either: resolve with
`gh pr view 42` and fall back to `gh issue view 42`.

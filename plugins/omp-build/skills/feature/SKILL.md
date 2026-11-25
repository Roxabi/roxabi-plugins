---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject> | init | pause #N | abandon #N | new #N | material-decision #N]'
description: Deliver a leaf UW through implementation, independent review, correction and protected merge.
version: 0.1.21
---

# Feature

Start only with the installed command's appended `## Feature context`, `## Accepted Spec` and skill directory. A bare skill read grants no authority. Work in the named worktree. Plan, implement and review against the criteria, invariants, exclusions and inherited clauses in `## Accepted Spec`. Its `spec: <digest>` binds the effective accepted Spec snapshot taken by host admission for this `/feature` invocation. Report a live issue body that differs; treat it as a proposal, not as requirements. Scope every GitHub query to the named repository.

Before planning or implementing, read the repository's default branch with `gh repo view <owner>/<repo> --json defaultBranchRef --jq '.defaultBranchRef.name'`. If unavailable or different from `base` in `## Feature context`, stop and report why: composed delivery and its required review verdict target only the default branch.

## Continue from facts

Compare local, remote and PR tips against the selected base. Look for matching PRs (including closed ones) by repository, branch and base, never by title. A PR number in context is a hint; the CLI confirms bindings.

A current review is the latest review evidence comment by a writer (see [../dev-fix/SKILL.md](../dev-fix/SKILL.md)) for the bound PR. Its header must match the live head/base and the `spec: <digest>` in `## Accepted Spec`. A missing or different digest, including on an existing approval, requires a new composed `/dev-review`; never select an older matching comment.

| Observed facts | Next action |
|---|---|
| No bound PR; local or remote commits may exist | Compare the committed diff against the Spec. Preserve dirty files and existing commits. Plan and implement only missing requirements; green checks or an existing branch are not proof. A fresh machine can recover only published commits. |
| Exact verified tip is already on remote; no PR or one matching unbound open PR | Run `open-pr` to create or confirm the binding. If an earlier effect is uncertain, observe before writing again. |
| Bound open PR, no completed current review | Review that exact head and accepted Spec independently. |
| Bound open PR with a completed current review; clean local branch has unpushed correction commits | Follow composed `/dev-fix`'s resume branch to verify and publish the existing tip without redoing work. |
| Bound open PR, current blocking review or failing CI | Follow composed `/dev-fix` only after completing a review of this head. If already pushed, review the new head. |
| Current approval and no red checks | Observe checks on the exact approved SHA. If the verdict was not published, rerun review. If behind the selected base, integrate locally only from a clean checkout and with a completed current review; stop on conflicts or scope change. Use the PR-bound correction push and review the new head. |
| Bound PR merged | Skip to `finish`. |

## Plan and implement

1. Map every own or inherited requirement from `## Accepted Spec` to code and a targeted check in the session; preserve exclusions. Apply project instructions and resolve scope conflicts before editing.
2. Choose agents available to the session for design and implementation. Give `task` implementers disjoint slices of the canonical worktree, and keep review independent of authorship. Verify the diff and checks against every criterion, including affected docs. Make Conventional Commits linked to the issue; capture the exact committed tip with `git rev-parse HEAD`.
3. Use `push` for that tip. Omit `--from` only for an observed absent branch; otherwise pass the observed remote SHA. On `pushed` or `already-published`, run `open-pr` for the same tip.

## Review and correct

1. Read installed [../dev-review/SKILL.md](../dev-review/SKILL.md) relative to the feature skill directory. Follow its composed mode with the bound issue, repository, PR, exact head/base and `## Accepted Spec`. Await separate read-only reviewers and confirm the published review. Do not invoke a nested slash command.
2. For a completed current review with blockers or red CI, read installed [../dev-fix/SKILL.md](../dev-fix/SKILL.md) and follow its composed mode. Review each changed head again. Stop on conflicting scope, no progress, or after **two automatic correction rounds** in this invocation. Report what remains for the operator to rerun.

## Land and finish

- Observe required checks, including `review` and CI, on the exact current head. If pending, wait read-only for a bounded time. Immediately before calling `land`, re-read the open PR's head/base and its latest review. Land only when that review approves this head/base, names the snapshot digest, its published verdict points to that review comment, and required checks are green. If the review digest is missing or differs from the snapshot, run composed `/dev-review` again; never land on a mismatch. Pass `--spec <digest>` from that approving review's header, not an independently computed digest. If `land` refuses with `spec-changed`, stop and tell the operator to rerun `/feature` to obtain a new Accepted Spec snapshot and review it. The protected base is the merge lock; never bypass it or arm auto-merge. No verdict lock → stop for the operator.
- Once the bound PR is observed merged, call `finish` and report its URL, merge commit and confirmed UW completion. Offer `/cleanup` and, only for `release.model: staging-train`, `/promote`; leave both to the operator.

## Delivery CLI

Run in the canonical worktree. Set `FEATURE_SKILL_DIR` to the absolute directory in the host banner; use the installed files, never a copy from the candidate:

```sh
bash "$FEATURE_SKILL_DIR/trusted-bun.sh" "$FEATURE_SKILL_DIR/feature-cli.ts" \
  <subcommand> --repo <owner/repo> --issue <N> --mandate <recordId> <effect-args>
```

| Subcommand | Effect arguments |
|---|---|
| `push` | `--tip <sha> [--from <sha>] [--pr <N>]` — correction requires `--from` and `--pr` |
| `open-pr` | `--tip <sha>` |
| `land` | `--pr <N> --head <sha> --spec <digest>` |
| `finish` | `--pr <N>` |

Exit 0 confirms one JSON status: `pushed`, `already-published`, `created`, `existing`, `merged` or `finished`. Exit 1 reports `refused`, `waiting` or `uncertain` with a reason; observe before taking another step. Exit 2 is usage error, no effect. Use only these commands for delivery writes, including base integration pushes.

Stop on inactive authority, material/coverage hold, ambiguous or divergent refs, unrelated or closed-unmerged delivery, or uncertain effects that cannot be reconciled. Report observed facts and the next operator action. Never abandon, mint another mandate or replace a PR to work around a failure.

## Operator controls

| Command | Boundary |
|---|---|
| `/feature <reference>` | Selects or establishes a leaf mandate. Repeating it continues under a live mandate from current Git and GitHub facts. Parent delivery is suspended. |
| `/feature pause <reference>` | Stops this session's running Feature without remote writes or a mandate change. |
| `/feature abandon <reference>` | Publishes and reads back exact mandate revocation, with no PR disarm or automatic renewal. |
| `/feature new <reference>` | Selects a successor over an intact abandoned or revoked mandate and conformant Spec. |
| `/feature material-decision <reference>` | Requires genuine operator confirmation of the exact pending Spec proposal. |
| `/feature init` | Previews the invoking checkout. Apply requires the preview digest and the operator's own reply. |

For framing, `Ctrl+Alt+U` opens the staged proposal for review; only `Confirmer` authorizes publication. If a move is required, the operator runs the displayed `/move <path>`, observes success, then presses `Ctrl+Alt+U` in the destination to attest it. A model tool cannot confirm or attest.

## Public-safe publication

Read every final GitHub title, body and comment before publishing. Omit secrets, client data, private paths and operational details, and raw logs. Send sensitive security details through the project's private security contact.

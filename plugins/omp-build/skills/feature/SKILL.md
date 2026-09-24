---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject>]'
description: OMP-only feature cycle — frame a GitHub issue, propose its branch immediately, hand off /wt to the operator, then implement, review, fix and land in the matching worktree.
version: 0.1.0
---

# Feature

One issue → one branch → one worktree → one PR. Read the issue as the spec;
use the current repository conventions, not a separate spec-file lifecycle.
`SKILL_DIR` below is this skill's directory, printed by the command.

## 0. Boundaries

- The operator alone invokes `/wt`. Propose the branch as soon as the issue number
  is known; stop at that handoff rather than creating a worktree behind their back.
- Read-only exploration and tracker framing may start on the Principal. File edits,
  dependency installation and implementation require the matching worktree.
- Issue creation, labels and native relations belong to `skill://issue-triage`.
- `dev-review` owns findings; `fix --no-label` applies them; §6.7 alone lands.
- After confirmed merge, offer `/cleanup`. Offer `/promote` only when
  `.dev/stack.yml` declares `release.model: staging-train`. Never invoke either.

## 1. Route-specific prerequisites

Read the project's `.dev/stack.yml` and `docs/agents/issue-tracker.md`.
Missing tracker contract → stop and name the missing path. Missing stack → use
repository-documented commands; do not guess an installer or release model.

| Route | Read before executing |
|---|---|
| Frame | `skill://grilling`, `skill://issue-triage` |
| Build | `skill://dev-review`, `skill://fix`; `bun skill://issue-triage/triage.ts` before a deferral |
| Agreed test-first work | `skill://tdd` |

Check only the selected route. A missing required skill stops that route with its
name; do not replace tracker mutations or the review panel with an improvised flow.
Implementation is native agent work, not dependent on an external `implement` skill.

## 2. Locate the session

Collect the real worktree root (`git rev-parse --show-toplevel`, resolve symlinks),
the Principal (first path in `git worktree list --porcelain`, also resolved), and
HEAD's branch (`git branch --show-current`, empty means detached).

```javascript
const { isPrincipal, resolveEntry } = await import(`${SKILL_DIR}/entry.js`)
```

| Situation | Next |
|---|---|
| No issue number yet | §4: frame in conversation; no local file edits on the Principal |
| Issue exists, session on Principal | Read it, then §3 immediately |
| Issue exists, linked worktree | Call `resolveEntry({ cwd, principalPath, branch, ticket: issue })` |
| `action: build` | Incomplete scope → §4; actionable ticket → §6 |
| `action: refuse` | Name the mismatch/detached HEAD; §3, never implement here |

Use `isPrincipal(cwd, principalPath)` before `resolveEntry`: its legacy Principal
hop route is not used. A branch for #N is not a branch for #M, including an epic's
branch versus a child's. Read the ticket before deciding whether its scope is ready.

## 3. Issue → branch proposal → operator `/wt`

**Run this immediately after creating or selecting an issue**, before more grilling,
spec refinement, decomposition or implementation. Do not wait for a finished spec
or a batch of tickets. Reuse an already tracked issue instead of minting a duplicate.

1. Derive `<type>/<N>-<short-kebab-slug>` from the issue and repository conventions.
   Read existing local/remote branches and worktrees first. If this session is
   already in the matching worktree, continue without asking for another branch.
2. Resolve the base from the release model: trunk → repository default branch;
   staging-train → `staging`. Fetch the intended base before proposing creation.
   Unknown base/model → resolve from repository configuration before proceeding.
3. Check the checkout `/wt` will branch from — it creates the branch from the
   current `HEAD`: on the intended base, clean and up to date. Otherwise report the
   precise mismatch and the operator action needed, and print no `/wt` line until it
   holds. Never branch from an unrelated ticket, and never move or stash the
   operator's changes. Do not pre-create a branch that `/wt` would then refuse.
4. Present the concrete branch, base and next operator action:

   > Issue #N créée. Je propose la branche `<type>/<N>-<slug>` depuis `<base>`.
   > Pour créer la branche et son worktree, saisis `/wt <type>/<N>-<slug>`.
   > Puis reprends avec `/feature #N` ; le cadrage continuera si nécessaire.

   For an existing issue, say “Issue #N sélectionnée”. **The proposal is not a
   branch-creation receipt.** Only report creation after observing the branch.
5. Stop for the operator. Do not invoke `/wt` through a tool, create the worktree,
   switch the Principal's branch, or implement while waiting. If they defer the
   branch, continue only read-only exploration/conversation and tracker framing;
   no local file edit happens outside the matching worktree.

These rules are agent discipline: the plugin's guard blocks moving the Principal's
`HEAD`, not creating a branch or worktree from it.

Existing branch/worktree → offer reuse, not another branch. For a registered
worktree, print `omp --cwd <quoted-existing-path>`, then `/feature #N`. For a branch
without a worktree, propose an unused path and the operator commands
`git worktree add <quoted-new-path> <existing-branch>` then `omp --cwd <quoted-new-path>`.
Do not execute them, reset/delete the branch or pass it to a create-only `/wt`.

## 4. Frame — agreed scope in the issue

1. Use `skill://grilling` for unresolved decisions; research facts yourself. Stop
   questioning when the user confirms shared understanding. An already actionable
   issue needs no replay of the interview.
2. Draft scope, acceptance criteria, invariants and out-of-scope in conversation.
   Publish with `bun skill://issue-triage/triage.ts create`, or `set` to amend
   an existing issue. Titles and bodies you did not write go through
   `--title-file` and `--body-file`. If that command cannot be resolved, stop
   and name issue-triage. Do not resolve the CLI from a path inside the skill body.
   **A newly returned issue number immediately triggers §3**, even mid-framing.
3. Record durable vocabulary/decisions only in the matching worktree, using the
   project's glossary and ADR conventions when warranted. The issue remains the
   spec home; no `artifacts/specs` or `status: validated` gate.
4. Split only when needed into independently landable tickets. Through
   `bun skill://issue-triage/triage.ts create`, each gets `--size`, `--priority`,
   `--type`; add `--parent` only for actual decomposition and `--blocked-by` only
   for actual dependencies.
   Every newly created ticket gets its branch proposal immediately; a declined
   proposal does not authorize creating branches for the rest of the batch.

Scope changes require re-evaluating the issue tier under the tracker contract.
Post-review deferrals are siblings under the origin's parent, blocked by the origin;
`fix` and `issue-triage` own that procedure.

## 5. Frontier and framing handoff

Read the native dependency edges **for every ticket**, including on build re-entry:

```bash
gh api --paginate 'repos/{owner}/{repo}/issues/<N>/dependencies/blocked_by'
```

Only tickets with no **open** blocker are actionable. Name blockers for the others.
Use the edge list, not the eventually consistent dependency summary after writes.
Branch preparation does not authorize implementing a blocked ticket.

After framing, print ready ticket numbers and their branch/worktree handoffs from
§3. Stop before implementation: the operator starts `/feature #N` in the matching
worktree with fresh context (`/clear` when staying in that same worktree).

## 6. Build — implement → review → fix → land

### 6.0 Preflight

Verify the actual cwd/branch again after the operator's handoff. Read the issue body,
`size:` label and open blockers (§5). Missing scope → §4; open blocker → stop.
Resolve the base as in §3, fetch it, and check history: every commit in
`origin/<base>..HEAD` belongs to this ticket (none on first entry). A foreign commit,
or a fork point off `<base>`, → stop and name it; a correct branch name proves nothing.
Install dependencies with the repository's documented command in this worktree
before running hooks/builds; no unconditional `bun install` for unrelated stacks.

```javascript
const { openPr, landPr, resumeReviewLoop } =
  await import(`${SKILL_DIR}/../build/workflow.js`)
```

These bundled functions remain the PR/landing seam. Do not invoke the legacy
`/build` driver or its spec-file stages.

### 6.1 Plan against acceptance criteria

Map every criterion to the affected code and the evidence needed to prove it.
Reuse repository patterns. Agree any uncertain behavior before implementation.

### 6.2 Implement and verify

Implement in this worktree, delegating independent slices when useful. Use `tdd`
for agreed test-first seams. Run the actual changed path and relevant existing
checks; keep regression tests for plausible failures, not to inflate coverage.
Update affected docs. Finish every acceptance criterion before opening the PR.
For a criterion whose surface is `frontend.path` or `shared.ui`, run the app and
check it with the OMP `browser`, and record the steps, URL and observed result
in the PR. If `.dev/stack.yml` declares `commands.test_e2e`, that command is the
proof — do not record `ui-manual-only`.

### 6.3 Commit, push, open or resume

Stage only task-owned files, commit with a Conventional Commit subject and push
this branch. Preserve unrelated work; never stage the whole checkout indiscriminately.
Use the base resolved in §3, including when already inside a worktree on entry.

```javascript
const { number: pr, status } = await openPr(cwd, {
  issue, branch, base,
  title: '<Conventional Commit subject>',
  body: '<changes, verification, and criterion→evidence matrix>',
})
const loop = await resumeReviewLoop(cwd, { pr })
```

`openPr` returns the numeric PR and `created | existing`, and supplies the closing
issue link. Print that result. Failure → report it; reconcile remote state before
retrying, never blindly create a second PR. The matrix follows `dev-review`'s
SC→Test contract, including justified NO TEST rows.

### 6.4 Review

Read and execute `skill://dev-review` for `#<pr>`, using **its own** directory for
`SKILL_DIR`. Keep feature's directory separately. After its posted verdict and
before its Phase 8 decision, record the verdict below. This cycle owns subsequent
fix/landing actions; the nested review must not execute them independently.

Translate the panel's verdict before calling the loop:
`Approve`, `Approve (clean)`, `Approve with comments` → `verdict = 'green'`;
`Request changes` → `verdict = 'red'`. Pass only `'green'` or `'red'` to
`loop.record`, never a raw panel string such as `'Request changes'`.

```javascript
let step = loop.record(verdict)
await loop.persist(cwd)
```

Present the Phase 8 human choice constrained by `step`: **Fix now** routes through
§6.5 only on `fix`; **Merge** routes through §6.7 only on `land`; **Stop** exits
without fixing or merging. On `stop`, enforce §6.6 rather than offer another round.
Never choose on the user's behalf or offer “Merge as-is” for a red verdict.
The human's **Stop** simply exits; `enforceStop` is valid only when the loop itself
returned `step.action === 'stop'`, not when the user declines an available fix.
`record` has already counted the round when the choice is offered: say so, since a
red verdict spends a fix round whether or not the operator then fixes.

### 6.5 Fix

`step.action === 'fix'`, by `step.reason`:

- review round (no reason) → execute `skill://fix` with `#<pr> --no-label`. It applies
  one change per posted root cause, inline, and does not stop for a per-finding choice.
  A cause it cannot apply becomes a sibling issue.
- `ci-failed` → fix inline from the failed checks (`land.failed`) and their logs.
  `fix` reads review comments, not CI: running it here replays stale findings.

Verify and commit/push the fixes, then return to §6.4 on the same PR for a fresh
review. State `step.remaining`.

### 6.6 Bound

| `step.action` | Next |
|---|---|
| `fix` | §6.5 |
| `land` | §6.7 |
| `stop` | `await loop.enforceStop(cwd)`; print its result and stop |

At most two fix rounds; a third red stops. Persist every verdict and CI reopening;
resume from the PR on re-entry, never reset its spent rounds. `enforceStop` removes
the `reviewed` label and disables native auto-merge; it cannot reverse a completed merge.
The PR marker stores counts, not the stop itself: a re-entry after a stop resumes an
open loop, so report the exhausted bound rather than start another round unasked.
Nothing on a stopped path invokes landing or the optional tail.
`loop.reopen('ci-failed')` **spends one fix round immediately** (0 → 1, 1 → 2;
already 2 → stop). It never refunds or preserves an unspent round after reopening.

### 6.7 Land

Only `step.action === 'land'` may reach this step. Obtain the operator's merge
approval if not already explicit for this PR. Then `await landPr(cwd, pr)` waits
for required contexts, writes `reviewed` and enables merge-commit auto-merge. If a
required check fails or is skipped after that, it removes the label and disables
auto-merge before returning (`land.disarmed`).
Neither a fix round nor another review action may write that label in this cycle.

| `land.status` | Action |
|---|---|
| `merged` | Report issue + PR; offer the optional tail (§0), stop |
| `ci-failed` | Gate already disarmed if armed; `step = loop.reopen('ci-failed')`; `await loop.persist(cwd)`; follow §6.6 |
| `ci-skipped` / `no-required-checks` | Stop; report skipped contexts / missing protection, no bypass — a skipped required check counts as passing on GitHub, hence the disarm |
| `timeout` / `auto-merge-failed` | Stop; inspect and report actual PR/label/auto-merge state, never claim merged |
| `closed` | Stop; report closure |

Errors stop with their evidence. No manual mid-CI merge and no automatic release
or worktree deletion.

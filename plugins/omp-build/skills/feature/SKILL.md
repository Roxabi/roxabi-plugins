---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject>]'
description: OMP-only feature cycle — frame a GitHub issue, create the worktree from origin/<base>, hand off /move and /goal, then implement, review, fix and land.
version: 0.1.6
---

# Feature

One issue → one branch → one worktree → one PR. Read the issue as the spec;
use the current repository conventions, not a separate spec-file lifecycle.
`SKILL_DIR` below is this skill's directory, printed by the command.

## 0. Boundaries

- The operator enters with `/move <path>`, then `/goal` for an epic. The agent creates the worktree from fresh `origin/<base>`, never from HEAD, and never asks the operator to type `/wt`.
- Read-only exploration and tracker framing may start on the Principal. File edits,
  dependency installation and implementation require the matching worktree.
- Issue creation, labels and native relations belong to `skill://issue-triage`.
- `dev-review` owns findings; `fix` applies them; §6.7 alone lands.
- After confirmed merge, offer `/cleanup`. Offer `/promote` only when
  `.dev/stack.yml` declares `release.model: staging-train`. Never invoke either.
  Under the Epic goal the loop deletes each merged child's local branch itself and
  offers `/cleanup` once, when the goal ends (§ Epic goal).

`/feature init [--dry-run]` runs `bun "$SKILL_DIR/feature-init.ts"` (with
`--dry-run` when requested). It adopts a repository from a worktree, never the
Principal. `--dry-run` prints the plan and writes nothing, and its next line
includes `--dry-run`. A real run fills `landing` and `worktree` in
`.dev/stack.yml` and prints
`next: T=$(realpath skill://issue-triage/triage.ts) && bun "$T" init`.
It does not run that command and does not print `init=done`. Run the printed
command as given — `T=$(realpath …) && bun "$T"` fails closed as the last
command of a line, or with `|| { …; exit 1; }` on its own line when more
commands follow (`realpath` is an OMP builtin). If it cannot be resolved, stop
and name issue-triage. Do not resolve
the CLI from a path inside the skill body. Do not write issues by hand. An
existing `docs/agents/issue-tracker.md` is left untouched by that command
(`contract: keep-existing`). The command does not write the
`omp-build-feature-init` marker, because the tracker step has not run. It does
not index ccc or codegraph without consent already recorded there. Active
semctx contracts are listed, never closed: a change may land active or partial,
and only Semctx closes one, from a VERIFIED result.
Exit 3 with `init=blocked issue-triage missing` → stop and name issue-triage; nothing was written.

## 1. Route-specific prerequisites

Read the project's `.dev/stack.yml` and `docs/agents/issue-tracker.md`.
Missing tracker contract → stop and name the missing path. Missing stack → use
repository-documented commands; do not guess an installer or release model.

| Route | Read before executing |
|---|---|
| Frame | `skill://grilling`, `skill://issue-triage` |
| Build | `skill://dev-review`, `skill://fix`; `T=$(realpath skill://issue-triage/triage.ts) && bun "$T"` before a deferral |
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
| Issue exists, linked worktree | Call `resolveEntry({ cwd, principalPath, branch, ticket: issue, children })`, `children` from `gh api --paginate 'repos/{owner}/{repo}/issues/<N>/sub_issues' --jq '.[].number'` |
| `action: build` | Incomplete scope → §4; actionable ticket → §6 |
| `action: epic` | The issue has sub-issues and HEAD is detached or on a child's branch → § Epic goal (gate first) |
| `action: refuse` | Principal, or a ticket/branch mismatch — name it; §3, never implement here |

Use `isPrincipal(cwd, principalPath)` before `resolveEntry`. On the Principal it
returns `{ action: 'refuse', reason: 'principal' }` — do not implement there. A branch for #N is not a branch for #M, including an epic's
branch versus a child's; only the `epic` route runs an epic, and only through its driver.
Read the ticket before deciding whether its scope is ready.

## 3. Issue → worktree → operator `/move`

**Run this immediately after creating or selecting an issue**, before more grilling,
spec refinement, decomposition or implementation. Do not wait for a finished spec
or a batch of tickets. Reuse an already tracked issue instead of minting a duplicate.

1. Derive `<type>/<N>-<short-kebab-slug>` from the issue and repository conventions.
   Read existing local/remote branches and worktrees first. If this session is
   already in the matching worktree, continue without asking for another branch.
2. Resolve the base from the release model: trunk → repository default branch;
   staging-train → `staging`. Fetch the intended base before proposing creation.
   Unknown base/model → resolve from repository configuration before proceeding.
3. Create the worktree from fresh `origin/<base>`, never from HEAD and never via `/wt`.
   The base must be clean and up to date. Otherwise report the mismatch and print
   no `/move` line until it holds. Never branch from an unrelated ticket, and never
   move or stash the operator's changes. For an epic, create it **detached**, with
   no epic branch: `git fetch origin '+refs/heads/<base>:refs/remotes/origin/<base>'`,
   then `git worktree add --detach <path> refs/remotes/origin/<base>`. Each child
   gets its own branch inside it, from the driver.
4. Present the concrete branch, base and next operator action:

   > Issue #N créée. Worktree `<path>`.
   > Saisis `/move <path>`, puis `/goal` avec la ligne générée.
   > Puis reprends avec `/feature #N` ; le cadrage continuera si nécessaire.

   For an existing issue, say “Issue #N sélectionnée”. **The proposal is not a
   branch-creation receipt.** Only report creation after observing the branch.
5. Stop for the operator. Print `/move <path>` and, for an epic, the generated
   `/goal` line: `bun "$SKILL_DIR/epic-driver.ts" objective --epic <E>` prints it
   once every open child is framed, and prints none while one is not (that child
   goes to §4). `/feature #E` in the epic worktree prints it too. Do not switch the
   Principal's branch or implement while waiting.
   If they defer, continue only read-only exploration and tracker framing.

These rules are agent discipline: the plugin's guard blocks moving the Principal's
`HEAD`, not creating a branch or worktree from it.

Existing branch/worktree → offer reuse, not another branch. For a registered
worktree, print `/move <path>`, then `/feature #N`. For a branch without a
worktree, create it at `<worktree base>/<repo>/<slug>` from `origin/<base>` and
print `/move`. Do not ask the operator to type `/wt`.

## Epic goal

`$SKILL_DIR/epic-driver.ts` is the transition contract for an epic under `/goal`
(its pure core is `epic.ts`). The goal session calls it before every ticket and
never relies on its memory of earlier tickets: every fact it acts on is re-read
from GitHub and git, so a compaction or a new `/goal` resumes from that state.
A goal reaches this body through the `skill:` URL its objective names; `SKILL_DIR`
is then the `realpath` of that URL.

**Gate.** Call `goal({op:"get"})`. This section applies only when all three hold:
its status is `active` (paused or budget-limited do not count), its objective
contains `/feature #E` with one `run=<id>` and one `base=<branch>`, and the ticket
is a sub-issue of E — the driver acts on nothing else. Otherwise `/feature` stays
assisted and unchanged: `/feature #E` in the epic worktree prints the line from
`bun "$SKILL_DIR/epic-driver.ts" objective --epic E` and stops.
Every other driver call carries the gate as `--goal-status <status> --goal-objective-file <file>`
(`<gate>` below); the driver re-checks it and exits 3 when it fails. Free text never
reaches a command line: write the objective, and each `--detail-file`, with the
`write` tool into a `mktemp -d` directory and pass the path.

Under the gate three things are pre-authorized, and nothing else: the Phase 8
choice follows `step.action`, the goal is the merge approval, and deleting a
merged child's local branch plus running the post-merge hook need no question.

**Loop.** With `D="$SKILL_DIR/epic-driver.ts"`, repeat `bun "$D" next --epic E <gate>`
and act on its JSON `step.action`. Print `step.report` (merged, stopped, skipped,
pending base checks), each entry of `reconciled` (a stopped child's armed PR the
driver disarmed, or would disarm under `--dry-run`), and each entry of `recorded`:
the ticket stops the driver proved itself (no scope, branch mismatch, foreign commit),
each already disarmed and recorded exactly like the `stop` subcommand does.

| `step.action` | Do |
|---|---|
| `start` / `resume` | The driver fetched, checked the tree and base CI, switched to `step.branch` (new from `refs/remotes/origin/<base>`, or the existing one), validated it with `resolveTicketBranch` and `refuseForeignCommits`, and disarmed an armed PR. Run §6 for `step.ticket` in this worktree: §6.0 without the operator handoff, then §6.1–§6.7. The PR is `step.pr?.number ?? null`, never discovered by branch name (a branch name also matches fork PRs): `resume` with `step.pr` continues that PR from its `nextReviewStep` (§6.0), and no `step.pr` means a new PR through `openPr`. |
| `final-review`, `stage: review` | R-architect and R-adversarial, read-only, on `git diff <step.range>`. Then `bun "$D" review --epic E <gate> --verdict clean\|blocking --range <step.range> --detail-file <findings file>`. |
| `final-review`, `stage: fix-ticket` | One fix ticket through issue-triage: `create --parent "#E" --type fix --size … --priority … --body-file <f>`, body's first line `<!-- omp-build:epic-fix -->`, an `## Acceptance criteria` heading holding the blocking findings. The next `next` starts it. Non-blocking findings are follow-up siblings, each scoped the same way: an `## Acceptance criteria` heading and a `size:` label (`skill://fix` § Filing). |
| `post-merge` | Only after a clean final review, a clean tree, and base CI green or absent. This run's hook `ok` or `skipped` at another commit is `drop hook-stale`, not another run. Then `bun --no-env-file "$D" hook --epic E <gate> --repo <epic worktree>`, with the bash `cwd` outside the repository (`$SKILL_DIR`): the runner must load nothing from the epic worktree. |
| `complete` | `bun "$D" report --epic E <gate> --outcome complete` refuses unless `next` is `complete`. Print it, `goal({op:"complete"})`, offer `/cleanup`. |
| `drop` | `bun "$D" report --epic E <gate> --outcome drop --reason <step.stop>`, print it, `goal({op:"drop"})`. If that command fails, print the error, then `goal({op:"drop"})`. A failing drop still drops the goal. |

**Inside a child**, map each outcome, then call `next` again (`landOutcome` in `epic.ts`):

| Outcome | Do |
|---|---|
| `land.status` `watching` | Run `land.watch` as in §6.7, map its exit with `applyCiWatchExit`, then this table |
| `land.status` `merged` | Nothing: `next` re-reads the PR (MERGED into the base, head claiming the child, tip equal), detaches and deletes the local branch |
| `ci-failed` | `step = await nextReviewStep(cwd, pr, { ciFailed: true })`, then §6.6 |
| `timeout`, `ci-cancelled`, `ci-blocked`, `stopped`, `closed`, `proof-blocked` | Ticket stop `--reason <status>`, with `land.error` as detail when present. A timeout is never re-attached under a goal |
| `nextReviewStep` `stop`, any reason | Ticket stop `--reason review-bound`; the step already disarmed the PR |
| `nextReviewStep` or `landPr` throws | Ticket stop `--reason stopped`, the error as detail |
| `proof-acquire` exits 1 (§6.3) | Ticket stop `--reason proof-blocked`, its stderr as detail |
| `watch-failed`, `bad-landing`, `no-required-checks`, `evaluate-only`, `auto-merge-failed`, any other status | Shared-state stop: the `drop` row, `--reason <status>` |
| issue-triage CLI unresolvable | Shared-state stop: the `drop` row, `--reason tracker-unresolvable` |
| driver exit 1 | Shared-state stop: the `drop` row, `--reason driver-error` (`hook-failed` for `hook`) |

A ticket stop is `bun "$D" stop --epic E <gate> --ticket N --reason <r> --detail-file <file>` (what happened).
It refuses a dirty tree: first commit the ticket's work on its branch, locally,
as `wip: goal-stop <r> (#N)`. It disarms the PR (`reviewed` removed, auto-merge
disabled), detaches HEAD, keeps the branch and writes the `goal-stop` marker on
the child. A shared-state stop is the `drop` row above. `report --outcome drop`
reads only the children and PRs: it disarms every open armed child PR without
reading base CI or the landing, and one failed disarm does not stop the others.
If a PR is still armed it exits non-zero and names it; the report is still posted,
with base CI marked unread when the full read fails or the landing cannot be read. `next` re-disarms every open
armed PR of a stopped child before the first `nextStep` and lists them under
`reconciled`. If that disarm fails, or the PR already merged, `next` returns a `drop` (`driver-error`) and
creates no branch. `--dry-run` reports the PR and writes nothing. No stopped
ticket stays armed.

| Class | Triggers | Effect |
|---|---|---|
| Ticket stop | review loop stop; `proof-blocked` or a failed `proof-acquire`; foreign commit, branch mismatch; child without scope; `timeout`; `ci-cancelled`; `ci-blocked`; `stopped`; `closed` | report, `goal-stop` marker; dependents skipped by their open blocker edge; independent children continue |
| Shared-state stop | base CI red; `base-ci-pending` at finalization; dirty tree between tickets, before the hook, or before a none-merged complete; `hook-stale`; `watch-failed`; `bad-landing`; `no-required-checks`; `evaluate-only`; `auto-merge-failed`; tracker CLI unresolvable; post-merge hook failure; final review still blocking after its fix round | disarm, report, `goal({op:"drop"})` |
| No progress | no actionable child while children remain open | report, `goal({op:"drop"})` |

A stop marker holds for its run: a new `/goal` line (new `run=`) retries the
child. `review-bound` holds across runs, as does an open PR whose review bound is
spent. Before a ticket, base checks that are pending or absent do not stop the loop; they are reported. At finalization, pending drops as `base-ci-pending` and absent does not.

**Fix-filed children are scoped children.** A cause `skill://fix` files and its
one deferral carry an `## Acceptance criteria` heading right after their Origin
line and a `size:` label (`skill://fix` § Filing), so `objective` and `next`
treat them like any other child; neither special-cases them. Their criteria come
from the operator's own review record. Each is blocked by its origin: it waits
until the origin merges or closes, and a stopped origin keeps it skipped. Their
own reviews can defer again. The signal is the order `objective` prints: each
link waits on its origin, and a stopped origin keeps it skipped. A chain that
keeps advancing always has an actionable link, so `no-progress` does not end it;
that drop ends only a stalled chain, where no child is actionable and some remain
open. The bound on an advancing chain is the goal budget: a `budget-limited` goal
is not `active`, the driver acts on nothing, and the open links stay for a new
`/goal` line. The operator can close a deferral as not planned at any time; a
running goal does not do that itself.

**Final epic review and hook.** Once every child is closed or merged into the
base, the review above runs on the cumulative range from `epicDiffRange`. A red
base, a pending base, or a dirty tree does not hold that review or its fix ticket.
A blocking verdict gets one fix ticket, delivered in the same goal; still blocking
after it merged is a shared-state stop, even on a red base. The ticket counts that
round across runs. After a clean review the goal finalizes only on a clean tree
and base CI green or absent. Otherwise it drops `dirty-tree`, `base-ci-red`, or
`base-ci-pending`. `base-ci-pending` is the pending bucket (in progress, cancelled,
`action_required`): the reason names the checks, and a new `/goal` line reaches the
hook only once the rollup is no longer pending. The same tree and CI drops apply
when every child closed and none merged. A failed or stale hook record drops there
too (`hook-failed`, `hook-stale`); otherwise that path completes with no review and
no hook. Then `release.post_merge` runs once, per ADR-024 §1: read from
`refs/remotes/origin/<base>`, a YAML list executed as argv with no shell, in a
temporary detached checkout of that commit, removed afterwards; `argv[0]` is a
path inside it (`./scripts/…`). A string value, a PATH lookup or an escaping
symlink fails it; its failure is a shared-state stop. An absent hook is skipped
and the report says so. No per-ticket deploy. A resume skips a review whose
latest verdict is clean for the current range. This run's hook `ok` or `skipped`
counts as done only at the current base commit; at another commit the goal drops
`hook-stale` and does not run the hook again. A later run treats an earlier `ok`
at another commit as not done — that relaunch is the operator's new `/goal` line,
not an automatic re-run. Any run's `ok` or `skipped` at the current base still
counts as done.

Without an active goal naming the epic, nothing in this section runs on its own:
the final review and the hook are the operator's call.

## 4. Frame — agreed scope in the issue

1. Use `skill://grilling` for unresolved decisions; research facts yourself. Stop
   questioning when the user confirms shared understanding. An already actionable
   issue needs no replay of the interview.
2. Draft scope, acceptance criteria, invariants and out-of-scope in conversation.
   For τ ≠ `size:S`, write a **decision brief** into the issue body before
   publishing: what, why, chosen solution, pros, cons, and rejected alternatives.
   Skip the brief for `size:S`.
   Publish with `T=$(realpath skill://issue-triage/triage.ts) && bun "$T" create`, or `set` to amend
   an existing issue. Titles and bodies you did not write go through
   `--title-file` and `--body-file`. Amending a body with `set --body` or `set --body-file` requires issue-triage ≥ 0.2.0 (the `.omp-plugin/marketplace.json` cache key). An older cached CLI skips an unknown flag and can exit 0 when another flag is present, leaving the body unwritten. If that command cannot be resolved, stop and name issue-triage. Do not resolve the CLI from a path inside the skill body.
   **A newly returned issue number immediately triggers §3**, even mid-framing.
3. Record durable vocabulary/decisions only in the matching worktree, using the
   project's glossary and ADR conventions when warranted. The issue remains the
   spec home; no `artifacts/specs` or `status: validated` gate.
4. Split only when needed into independently landable tickets. Through
   `T=$(realpath skill://issue-triage/triage.ts) && bun "$T" create`, each gets `--size`, `--priority`,
   `--type`; add `--parent` only for actual decomposition and `--blocked-by` only
   for actual dependencies.
   Every newly created ticket gets its branch proposal immediately; a declined
   proposal does not authorize creating branches for the rest of the batch.
   A child that is not framed yet carries a heading containing "needs framing"
   (`## Needs framing`, any case). Framed means a `size:` label, an acceptance or
   criteria heading, and no such heading: only then does the Epic goal start it.

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
Under the Epic goal the session does not stop here: the driver picks the next child.

## 6. Build — implement → review → fix → land

### 6.0 Preflight

Verify the actual cwd/branch again after the operator's handoff (under the Epic goal,
the driver has already switched to the child's branch and checked its history). Read the issue body,
`size:` label and open blockers (§5). Missing scope → §4; open blocker → stop.
Resolve the base as in §3, fetch it, and check history: every commit in
`origin/<base>..HEAD` belongs to this ticket (none on first entry). A foreign commit,
or a fork point off `<base>`, → stop and name it; a correct branch name proves nothing.
Install dependencies with the repository's documented command in this worktree
before running hooks/builds; no unconditional `bun install` for unrelated stacks.
On entering a worktree that is not the principal, run
`bash "$SKILL_DIR/worktree-bootstrap.sh"`; omp-build's extension has usually
started it in the background already, and this call then waits for it and
no-ops. It copies `worktree.copy` and `worktree.seed` from the principal, builds
each code index the principal has (never one it lacks: ccc without its own
`settings.yml` indexes an ancestor directory), then runs `worktree.setup` and
`semctx index` when `.semctx/` exists. `.cocoindex_code` starts from a copy of
the principal's (repo-relative paths), so `ccc index` reprocesses only the
branch delta, and a copy that races a principal re-index or fails to load is
rebuilt; `.codegraph` is a fresh `codegraph init -y`. A marker under
`git rev-parse --git-dir` makes a second run a no-op, and a lock there
serialises concurrent runs. It refuses to write on the principal and never
copies `*.example` in place of a missing real file.
Agent-created worktrees live at `<worktree base>/<repo>/<slug>`, where the base
is `OMP_WORKTREE_DIR`, else `.dev/stack.yml` `worktree.base`, else `~/.omp/wt`.
Resolve the review target before opening a semantic contract. An existing PR
resumes its already-implemented change from its review records; it does not open
a new contract or repeat the implementation/proof/push stages.

```javascript
const { openPr, landPr, nextReviewStep, applyCiWatchExit, disarmReviewedBeforePush, resolveReviewPr } =
  await import(`${SKILL_DIR}/workflow.js`)
// Under the Epic goal: `let pr = step.pr?.number ?? null` — the driver's PR, never a discovery.
let pr = await resolveReviewPr(cwd)
let step = pr === null ? null : await nextReviewStep(cwd, pr)
```

Discovery/read errors stop with evidence; never substitute a local review.
An existing PR follows `step` through §6.6: `review` → §6.4, `fix` → §6.5,
`land` → §6.7, `stop` → the dossier, and exit before any edit.
For a new PR only, decide Semctx once, before any Semctx call: it applies when
`.semctx/` exists at this worktree's root or at the principal. Then open the change
contract from the issue (goal, invariants, evidence, unknowns) and follow Semctx's
own cycle — this skill adds no lifecycle step to it; the issue stays the spec.
Otherwise run no Semctx step. `landPr` re-derives the same decision from the
candidate (§6.7): a committed `.semctx` without its config, committed working
state, or a root it cannot read is not absence and refuses there. Then §6.1.

### 6.1 Plan against acceptance criteria

Map every criterion to the affected code and the evidence needed to prove it.
Reuse repository patterns. Agree any uncertain behavior before implementation.
After that mapping, spawn R-architect and R-adversarial read-only on the plan —
one round. A blocking plan finding amends the plan before any code. This review
never calls the review loop: it spends no fix round and writes no PR marker.


### 6.2 Implement and verify

Implement in this worktree, delegating independent slices when useful. Use `tdd`
for agreed test-first seams. Run the actual changed path and relevant existing
checks; keep regression tests for plausible failures, not to inflate coverage.
Update affected docs. Finish every acceptance criterion before the review (§6.4);
the PR itself may open earlier (§6.3) — it authorizes nothing.
For a criterion whose surface is `frontend.path` or `shared.ui`, run the app and
check it with the OMP `browser`, and record the steps, URL and observed result
in the PR. If `.dev/stack.yml` declares `commands.test_e2e`, that command is the
proof — do not record `ui-manual-only`.
Re-entry on an existing PR skips §§6.1–6.3 and retains its PR and step from preflight.

### 6.3 Commit, push, open or resume, proof records

Stage only task-owned files, commit with a Conventional Commit subject ending with
`(#N)`, the ticket's number, and push this branch. The Epic goal refuses a branch
commit that claims no ticket, or another one. Preserve unrelated work; never stage
the whole checkout indiscriminately.
Use the base resolved in §3, including when already inside a worktree on entry.

```javascript
const opened = await openPr(cwd, {
  issue, branch, base,
  title: '<Conventional Commit subject>',
  body: '<changes, verification, and criterion→evidence matrix>',
})
pr = opened.number
```

`openPr` returns the numeric PR and `created | existing`, and supplies the closing
issue link. Print that result. Failure → report it; reconcile remote state before
retrying, never blindly create a second PR. The matrix follows `dev-review`'s
SC→Test contract, including justified NO TEST rows. An `existing` PR is not new:
an earlier run may have left it armed, so §6.4 runs the review's step 0 before
anything reads or reviews it.

**Proof records, after each push.** When Semctx applies — `origin/<base>` or
the head commits `.semctx`, or the operator keeps an uncommitted (ignored)
`.semctx/config.json` in this worktree or the principal checkout — or the
PR is a fix — a `fix/…` head branch, or a closing ticket or the ticket the
head branch names (`<type>/<N>-…`; GitHub links closing keywords only into
the default branch) typed Fix or Bug, labelled `bug` or titled `fix…:` (any
case; nothing establishing a type refuses) — and the base or the head
declares an assertledger adapter (`assertledger.config.json` with an `adapter`, or
`scripts/kit/assertledger/vitest-adapter.mjs`), run from this worktree at the
pushed head:

```bash
bun "$SKILL_DIR/proof-acquire.ts" --pr <pr> [--assertledger-manifest <path>]
```

It runs the producers for that head outside admission — Semctx in a private
clean checkout of the candidate; assertledger as a replay of the manifest of an
`assertledger check . --after <head> …` you ran — and conserves their native
output as one PR comment per producer and head — a record above GitHub's
65,536-character comment ceiling as an ordered run of `part=<i>/<n>` comments,
which admission reads only whole (a part missing or out of order is a missing
record; acquire again). A record that still binds is
reused: same head and inputs, nothing runs again. Exit 1 names what is missing;
it decides nothing. VERIFIED is Semctx's composition over the evidence statuses
the contract declares, never a test run: mark evidence `tested` only for a test
that exercises the change — the review judges it. Landing's runtime-proof claim
depends on CI GitHub actually enforces on this base/head. The pre-existing native
guard accepts explicit check names or a nonempty `landing.required_checks`;
only otherwise does it discover protection/ruleset checks. Declared names do not
establish enforcement: an unprotected native PR can merge before they finish.
Publish every Semctx record before §6.4;
a later publication needs a new review, and a recorded edit needs acquisition
again, regardless of verdict. Nothing ties the required checks to the tests
a `tested` evidence names. A PARTIAL stays PARTIAL: each gap its record names needs one
PR-body row `| <gap> | … | ⚠ NO TEST — <reason> |` with a reason from the closed
enum, and a `ui-manual-only` gap a `### Browser check <gap>` block (the gap bare
or in backticks; `- Steps:`, `- URL:` http(s), `- Observed:`), legal only when neither the base's nor the head's
`.dev/stack.yml` declares `commands.test_e2e`. The review judges those rows, so
publish the complete PARTIAL record and write those rows before §6.4.
`landPr` reads native GitHub creation/revision times of every selected applicable
producer record part, regardless of producer or verdict, and a body last edited
before approval. Missing or unreadable times refuse. Any recorded part revision
requires acquisition again, then review; an unmodified later publication or
body edit requires same-head review (§6.4), without a producer at admission.
PARTIAL→VERIFIED and WEAK_ORACLE/miss→detection edits do not disable this guard.
§6.4 captures the exact body and complete applicable producer runs before
judgement, consumes that capture and compares again before posting. The approval's
line 3 retains `<!-- omp-build:review-input v=1 sha256=<64 lowercase hex> -->`.
Admission compares repository/PR/head, body bytes + `lastEditedAt`, and each
selected part's ID/body/native creation/revision values, even for VERIFIED or
detection. Missing/malformed marker or changed inputs requires same-head review,
not an automatic digest update; a recorded producer revision needs acquisition
first. Genuine no-proof repositories have no new marker prerequisite.
This equality binding is not a signature, a lasting pin or an atomic read/post/arm:
`landPr` re-reads these inputs only at its own checkpoints and on re-entry. After
`watching`, CI-watch and review-step observers read approval/head/bound, not
proof, so a later change goes undetected unless `landPr` is re-entered.
**Reviewer trust ceiling** ([operator-authorized #768 amendment](https://github.com/Roxabi/roxabi-plugins/issues/768#issuecomment-6114046814)):
the proof-aware review judges reason truth and whether a browser check was
credibly performed for this head; unsupported claims block review. Admission
checks native binding, policy, form, chronology and exact observed review-input
equality, not those two truths.
Approval and timestamps are not runtime certification; an admitted gap remains
unproved. Never close a PARTIAL change as verified. Semctx runs under the head's committed `.semctx/config.json`, which
must equal the base's when the base commits one (a PR never changes or deletes
the policy it is judged by); with none committed, under the uncommitted one,
copied into the private checkout — the head's `.gitignore` must ignore it and
every copy on disk must agree. The record binds that configuration's source
and sha256. `.semctx/working/` is Semctx's own ignored state; the clean checkout
never sees it, so nothing asks to empty it. Only `landPr` admits (§6.7).

### 6.4 Review

Read and execute `skill://dev-review` for `#<pr>`, using **its own** directory for
`SKILL_DIR`, starting with its Phase 1 step 0: that disarms the PR before the panel
reads the diff — for a PR opened in §6.3, an `existing` one, and one resumed in
§6.0 alike. A throw from step 0 is reported and stops this cycle (Epic goal:
ticket stop `stopped`): no diff, no review, no fix, no land. Keep feature's
directory separately. The review returns its posted verdict
and `REVIEWED_HEAD` before its Phase 8 decision. This cycle owns the fix and
landing actions; the nested review does not execute them.

```javascript
step = await nextReviewStep(cwd, pr, { posted: { verdict, head: REVIEWED_HEAD } })
```

`verdict` is the panel's verdict as posted: `Request changes`, `Approve`,
`Approve (clean)` or `Approve with comments`. `nextReviewStep` re-reads the PR:
the latest review record must be that post, or it throws and decides nothing.
Every posted review counts toward the bound, whether or not a fix follows it.
A capture refusal in dev-review Phase 2 posts nothing and counts nothing: stop
with its `producer` / `reason` / `error`. A missing producer record goes to the
acquisition in §6.3 (even for an `existing` PR), then §6.4 again; any other
refusal is an environment precondition (checkout at the head, base fetch,
transport) fixed before re-running §6.4. Epic goal: ticket stop `stopped`.

Present the Phase 8 human choice constrained by `step` (§6.6). Never choose on
the user's behalf or offer “Merge as-is” for a red verdict — except under the
Epic goal, where the choice follows `step.action` with no prompt. The human's
**Stop** while a fix is available simply exits; the next run derives the same
step from the records.

### 6.5 Fix

`step.action === 'fix'`, by `step.reason`:

- review round (no reason) → execute `skill://fix` with `#<pr>`. It applies the
  one plan of each well-formed posted root cause that contains a blocking finding, and
  falsifies it against the cause's own proof. A block missing any of its seven lines
  (`skill://dev-review/root-causes.md` § Record) is not applied; its blocking cited
  findings are filed per finding. A record from before the seven-line plan (blocks
  with only `mechanism:`, `fix:` and `findings:`) halts it with nothing applied or
  filed: that PR needs one re-review. It does not stop for a per-finding choice.
  Non-blocking causes are not applied; they go into one sibling follow-up, blocked by
  the origin. A blocking cause it cannot apply becomes its own sibling issue, and it
  still blocks.
- `ci-failed` → fix inline from the failed checks (`land.failed`) and their
  logs. `fix` reads review comments, not CI: running it here replays stale findings.

**Order, review-driven round** (`skill://fix` owns it, including its published-candidate baseline binding when a cause is applied): per-cause light checks
(lint, covering tests, the proof) → one local commit per cause → local plain
pre-review (`skill://fix` Phase 3 § Local pre-review: read-only plan conformity, not
`dev-review`, no post/label/gate, no review bound spent) → falsification → clean tree,
global lint/tests, actual-path runtime smoke → the final costly or infrastructure
proof on the final head → push only that final pre-reviewed, verified head. Any later
permanent change is pre-reviewed again and its affected proof refreshed per the
`skill://fix` Phase 3 post-commit rule. A red or unavailable required smoke, proof or
authorization halts with the commits local — no push, no receipt — and is reported as
red or unavailable, never as checked.

**`ci-failed` fixes** stay inline and never run `fix`: baseline := the head whose CI
failed; equivalent light checks → commit → the same plain pre-review of the actual
unpublished diff from that baseline, judged against the failed checks and their logs
(there is no root-cause record) → the `skill://fix` post-commit rule for any later
delta, where the failed checks and logs (`land.failed`) stand in for the cause plan —
no RC is required and `fix` is not run, so a correction within that CI scope uses the
same bounded verification instead of halting for want of an `r` → the Phase 5 order
above (clean tree, global lint/tests, smoke, costly proof; same halt rule) → push only
the matching pre-reviewed, clean head.

**Receipt:** in a review-driven round, `fix` posts it even when no cause was
applied and no push was needed. For an inline `ci-failed` correction with new
commits, post it after the required push succeeds. A failed push or required-proof
halt produces no success receipt.
A review-driven halt returns its known failed/filed issue links in the error;
re-entry uses `fix` Phase 2's receipt-free disposition lookup before any reapplication.
The receipt is for humans: no gate reads it, and a failed post is reported, not
retried. It never reports a falsification skip as a pass, nor a `none` record
with actionable findings as clean. When a push moved the head, run §6.3's proof records for it;
state `step.remaining`, then §6.4 — the current candidate still needs its
ordinary official review.

### 6.6 Bound

| `step.action` | Next |
|---|---|
| `review` | §6.4. `nextReviewStep` already disarmed an armed PR |
| `fix` | §6.5 |
| `land` | §6.7 |
| `stop` | Publish/display the escalation dossier from `skill://dev-review` Phase 8, print `step.message`, and stop. `nextReviewStep` already disarmed an armed PR. Epic goal: then ticket stop `review-bound` |

`nextReviewStep` is the bound (#710): the review records by the automation
login, counted, and the latest one. A fix is allowed while the PR has at most
two records. A record past the second that does not approve spends the bound for
good: a later green does not lift it, and `landPr` refuses it. A `ci-failed`
stop is not in the records: under the Epic goal the ticket stop keeps it;
outside it, re-entry is the operator's call. The dossier lives in `dev-review`
Phase 8.

**The armed gate (#713).** An OPEN PR is armed — `reviewed` label or auto-merge
enabled — only when the latest review record approves the current head, the bound
is not spent, and no review of that head is running. `enforceArmedGate` is the
shared exit policy for `landPr`, `nextReviewStep`, `applyCiWatchExit` and
`disarmReviewedBeforePush` (#729). `reviewing` means an actual review is running;
forced-unarmed exits use a separate policy. Failed opening acquisitions leave
no known gate to act on. Retaining an OPEN arm requires fresh review/head evidence
after intervening reads. A refused pin whose head is unreadable forces the known gate
clear and throws the original read error (§6.7).
`disarmGate` is the clearing primitive: disable auto-merge first, attempt label
removal independently, then validate the read-back. A stuck or unreadable disarm
throws naming the remainder; native legacy result adapters report that same error
without retrying cleanup. `disarmed: true` means this call attempted clearing and
confirmed no OPEN armed gate; an already clear or non-OPEN gate carries no flag.
A PR closed during clearing has no OPEN gate left; one merged during clearing
throws (only the watch mapper translates that race to `merged`).

### 6.7 Land

Only `step.action === 'land'` may reach this step. Obtain the operator's merge
approval if not already explicit for this PR; under the Epic goal the goal is that
approval, and each `land.status` maps through § Epic goal instead of the table
below. Then `await landPr(cwd, pr)`
resolves the landing mode itself from the PR base through `readLanding(cwd, { base })` — the same
resolver `/ci-watch` uses: `landing.mode` in `origin/<base>:.dev/stack.yml` (parsed as YAML),
else merge-on-green when `origin/<base>:.github/workflows/merge-on-green.yml` exists, else
native. The head worktree never selects the mode or its required checks (#623). Before reading configuration, `landPr` reads the review records itself,
then the PR's gate: a spent bound returns `not-approved` with reason
`review-bound`, and a latest record that does not approve returns `not-approved`.
An approval arms only the commit its record names: line 2 must be
`<!-- omp-build:review-head sha=<40 lowercase hex> -->` and must equal the PR's
current `headRefOid`. A record with no head line returns `not-approved` with
reason `no-review-head` — a PR reviewed before this line existed needs one
re-review. A different or unreadable head returns `not-approved` with reason
`head-moved`. Every `not-approved` disarms a gate already armed on an OPEN PR
(`disarmed: true`) and writes nothing else. Invalid configuration then returns
`bad-landing` before arming. Immediately before each merge-capable arming write,
it re-reads the latest review records and then `headRefOid`, including after
disable/remove preparation. Red or spent records refuse arming; missing,
moved or unreadable authorization never permits that write. Known OPEN arms
are cleared through the exit policy, or its error names the remainder.
Native pins use the refreshed reviewed head; a refreshed approval of another
head arms it only once the landing admission admits that head too (otherwise
`proof-blocked`, unarmed). Under merge-on-green
it then adds `reviewed` — a pre-existing label is removed first so a fresh
labeled run exists — and returns
`{ status: 'watching', mode, watch, proof }`. `watch` is the absolute real path of
`ci-watch.sh` (derived from this module), carrying `--merge-mode <mode>` and,
under merge-on-green, always `--since <GitHub labeled time>` of that new event.
If the labeled event cannot be read after re-label, `landPr` returns
`watch-failed` — never watches without `--since` under merge-on-green. Run that
string as given — the OMP shell does not resolve `skill://` for a bare `bash`
argv. It does not poll. Native enables the pinned auto-merge
(`--match-head-commit` of the reviewed sha) before adding `reviewed`.
`already enabled` is not success: auto-merge is disabled and enabled again with
that pin. If that disable fails and the head is still the reviewed one, `landPr`
returns `auto-merge-failed` with `armed: true` and an `error` naming what stays
armed — the label may stay. A head that moved or cannot be read in that window
is disarmed through `disarmGate`; `armed: false` is returned only when that
read-back confirms the gate clear. When the disarm cannot finish, or the
read-back shows the gate still armed, the same status carries an `error` naming
the remainder. A refused pin (not `already enabled`) on a readable stable head returns
`auto-merge-failed` / `armed: false`, which is no read-back claim. If the head cannot
be read there, the known gate is forced clear and `landPr` throws the original read
error; when clearing cannot finish, the thrown error names the remaining or uncertain
arms and keeps that error as its cause. The fleet
workflow enables only on `labeled`, and only when the event head equals the
line-2 sha of the latest automation-account Approve record. On `synchronize` it
disables auto-merge and removes `reviewed` instead of re-enabling from a
comment, and it does not `update-branch` a reviewed PR. merge-on-green has no
equivalent pin: once `reviewed` is applied, a push by another actor is not
refused by GitHub.
merge-on-green never returns `no-required-checks`; native returns it only after its own disarm (table).

**Landing admission (#768).** After the review gate and `no-required-checks`,
`landPr` admits the reviewed head through `admitLanding` (`proof.ts`). It reads
and never produces: no producer, test or model call. The local tip must be that
head. Semctx applies when `origin/<base>`, the head or the uncommitted
configuration on disk at the root and the principal configures it; an adapter or
`commands.test_e2e` applies when the base or the head declares it. Applicable §6.3 records must bind
repository, PR, head, base, merge base, the changed contracts — at least one
added by the head; a modified older contract never stands in for it — and the
Semctx configuration (assertledger's
reference world: the head's commit and tree), and are read with their native
verdicts: VERIFIED, or PARTIAL with every gap review-judged — a gap is each
warning finding, pending evidence and open unknown the result names, mirrored
or not; draft, blocked, stale, superseded, a PARTIAL closed as verified, a
PARTIAL with a stale link or a blocking impact, a VERIFIED that requires no
evidence, and a non-terminal change that is not the one block of its own
`changes/<id>.sem` refuse. A refusal returns `proof-blocked` with `producer`
(`candidate` | `semctx` | `assertledger`), `reason` and `error` through the
forced-unarmed exit; every arm `landPr` writes targets the admitted head, and `watching` reports
`proof`.

Run `watch` as an async bash job (`timeout: 0`). Map the exit with
`applyCiWatchExit(cwd, pr, code, { mode: land.mode })`:

| Exit | Result |
|---|---|
| 0 | re-read state: MERGED → `merged`; CLOSED or otherwise unmerged → `stopped` (do not claim merged) |
| 1 | re-read gate first (MERGED → `merged`, CLOSED → `stopped`); otherwise disable any auto-merge, independently remove `reviewed`, confirm read-back, return `ci-failed`, then `nextReviewStep(cwd, pr, { ciFailed: true })` |
| 2 | same forced-unarmed policy, then `ci-cancelled` |
| 3 | same forced-unarmed policy, then `ci-blocked` |
| 4 | stop and report; do not claim merged (includes CLOSED during the check phase) |
| 5 | `timeout`; re-attach the same watch later |
| 6 | `evaluate-only`: merge-on-green is green but its run for this landing reports `kit-ci not configured`; retain an OPEN gate only while currently authorized |
| 70 | usage, missing tool, invalid landing, or `gh`/`jq` failure → `watch-failed`; retain an OPEN gate only while currently authorized |
| other | unmapped code (including killed jobs 124/137/143) → `watch-failed`; retain an OPEN gate only while currently authorized |

Every mapped exit passes the shared policy. Observer exits (0/4/5/6/70/other)
preserve their status but clear moved, red or spent OPEN gates. If those review/head
reads fail after acquiring the gate, clear the known arms before surfacing the read
error. Forced exits 1–3 need no review-service reads. A no-op never claims `disarmed`.
Observer exits never re-admit: a base retarget, body edit, ignored configuration
or classification change keeps the arm until §6.7 re-enters `landPr`.

Before any push that follows a `reviewed` label, call
`disarmReviewedBeforePush(cwd, pr, { push })`. Disable auto-merge, remove the label
independently and confirm clearing before invoking `push`, once. A failed barrier
prevents the push. Reuse its receipt after callback success or failure: no second
cleanup or push retry, and the original callback error is preserved. An already
clear or non-OPEN gate is a no-op, without `disarmed: true`.

Neither a fix round nor another review action may write that label in this cycle.

| `land.status` | Action |
|---|---|
| `no-pr` | Stop; no PR was resolved and no gate was armed |
| `not-approved` | Stop; the latest review record does not approve the current head, or the bound is spent (`reason: 'review-bound'`), or — `reason: 'head-moved'` — the head moved from the one this call admitted. `landPr` disarmed a gate that was armed (`disarmed: true`). When the latest record already approves the new current head, re-run `nextReviewStep(cwd, pr)` (§6.6): its `land` re-enters §6.7 without a new review. Otherwise review again only when the bound is not spent; do not merge |
| `watching` | Report `land.proof` — Semctx `absent`, or each change's VERIFIED/PARTIAL and every review-judged gap (form checked, still unproved); assertledger `not-applicable` or `detection` — then start the async `/ci-watch` job named in `land.watch` |
| `proof-blocked` | Stop; report `land.producer`, `land.reason` and `land.error`. No arm remains; clearing is read back (`disarmed: true`). Re-enter §6.7 once the named cause is fixed: missing producer record → §6.3; recorded proof revision → acquisition again, then §6.4; late unmodified publication, edited body or missing/malformed/changed review-input binding → same-head review (§6.4), no producer at admission; unreadable native facts → obtain native metadata. A moved head goes through §6.4. The review bound stays sticky |
| `merged` | Report issue + PR; offer the optional tail (§0), stop |
| `ci-failed` | Gate already disarmed; `step = await nextReviewStep(cwd, pr, { ciFailed: true })`, then §6.6 |
| `ci-cancelled` | Gate disarmed; stop, report the cancelled checks; operator re-runs CI then re-enters §6.7 |
| `ci-blocked` | Gate disarmed; stop, report the checks named on stderr; operator resolves the named checks or re-runs CI, then re-enters §6.7 |
| `watch-failed` | Stop; report code or error. The gate is retained only with current authorization; invalid arms are cleared or the error names their remainder. Do not claim merged |
| `evaluate-only` | Stop; report "evaluate-only — manual merge required" and `docs/kit/ci-app-setup.md`. The gate is retained only with current authorization; the operator merges by hand. Do not claim merged; do not wait |
| `bad-landing` | Stop; report `land.error` (landing configuration problem). Any armed gate is cleared, or the error names its remainder. Fix the landing configuration, then re-enter §6.7 |
| `no-required-checks` | Stop; native guard found no check name: explicit list, otherwise nonempty stack `landing.required_checks`, otherwise protection/ruleset discovery. Discovery error is not evidence that protection is absent. Merge-on-green does not return this. Applicable arms are cleared and read back (`disarmed: true`); a failed clear throws. Resolve the lookup/configuration and verify actual GitHub enforcement before re-entering §6.7. Nonempty declared names alone do not establish protection |
| `timeout` | Re-attach the watch. Do not claim merged. Epic goal: ticket stop, no re-attach |
| `stopped` | Stop and report. Do not claim merged |
| `auto-merge-failed` | Stop; inspect and report actual PR/label/auto-merge state, never claim merged. Every `armed: true` carries an `error` naming what stays armed — remove that remainder by hand before anything else |
| `closed` | Stop; report closure |

Errors stop with their evidence. A `landPr` throw from a disarm that could not finish names what stays armed — on `no-required-checks` too, where the refusal itself is not returned: remove that remainder by hand. No manual mid-CI merge and no automatic release
or worktree deletion; the Epic goal deletes merged children's local branches, never a worktree.

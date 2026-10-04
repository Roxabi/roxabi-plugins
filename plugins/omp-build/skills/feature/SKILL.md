---
name: feature
disable-model-invocation: true
argument-hint: '[#N | <subject>]'
description: OMP-only feature cycle — frame a GitHub issue, create the worktree from origin/<base>, hand off /move and /goal, then implement, review, fix and land.
version: 0.1.0
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
not index ccc or codegraph without consent already recorded there. Orphan
semctx contracts are listed, not closed.
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
| `start` / `resume` | The driver fetched, checked the tree and base CI, switched to `step.branch` (new from `refs/remotes/origin/<base>`, or the existing one), validated it with `resolveTicketBranch` and `refuseForeignCommits`, and disarmed an armed PR. Run §6 for `step.ticket` in this worktree: §6.0 without the operator handoff or the history check, then §6.1–§6.7. The PR is `step.pr?.number ?? null`, never discovered by branch name (a branch name also matches fork PRs): `resume` with `step.pr` continues that PR at §6.4, and no `step.pr` means a new PR through `openPr`. |
| `final-review`, `stage: review` | R-architect and R-adversarial, read-only, on `git diff <step.range>`. Then `bun "$D" review --epic E <gate> --verdict clean\|blocking --range <step.range> --detail-file <findings file>`. |
| `final-review`, `stage: fix-ticket` | One fix ticket through issue-triage: `create --parent "#E" --type fix --size … --priority … --body-file <f>`, body's first line `<!-- omp-build:epic-fix -->`, an `## Acceptance criteria` heading holding the blocking findings. The next `next` starts it. Non-blocking findings are follow-up siblings. |
| `post-merge` | Only after a clean final review, a clean tree, and base CI green or absent. This run's hook `ok` or `skipped` at another commit is `drop hook-stale`, not another run. Then `bun --no-env-file "$D" hook --epic E <gate> --repo <epic worktree>`, with the bash `cwd` outside the repository (`$SKILL_DIR`): the runner must load nothing from the epic worktree. |
| `complete` | `bun "$D" report --epic E <gate> --outcome complete` refuses unless `next` is `complete`. Print it, `goal({op:"complete"})`, offer `/cleanup`. |
| `drop` | `bun "$D" report --epic E <gate> --outcome drop --reason <step.stop>`, print it, `goal({op:"drop"})`. If that command fails, print the error, then `goal({op:"drop"})`. A failing drop still drops the goal. |

**Inside a child**, map each outcome, then call `next` again (`landOutcome` in `epic.ts`):

| Outcome | Do |
|---|---|
| `land.status` `watching` | Run `land.watch` as in §6.7, map its exit with `applyCiWatchExit`, then this table |
| `land.status` `merged` | Nothing: `next` re-reads the PR (MERGED into the base, head claiming the child, tip equal), detaches and deletes the local branch |
| `ci-failed` | §6.6 `loop.reopen('ci-failed')` |
| `timeout`, `ci-cancelled`, `ci-blocked`, `stopped`, `closed` | Ticket stop `--reason <status>`. A timeout is never re-attached under a goal |
| review loop `stop`, any reason | `enforceStop`, then ticket stop `--reason review-bound` |
| proof gate BLOCKED | Ticket stop `--reason proof-blocked` |
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
| Ticket stop | review loop stop; proof BLOCKED; foreign commit, branch mismatch; child without scope; `timeout`; `ci-cancelled`; `ci-blocked`; `stopped`; `closed` | report, `goal-stop` marker; dependents skipped by their open blocker edge; independent children continue |
| Shared-state stop | base CI red; `base-ci-pending` at finalization; dirty tree between tickets, before the hook, or before a none-merged complete; `hook-stale`; `watch-failed`; `bad-landing`; `no-required-checks`; `evaluate-only`; `auto-merge-failed`; tracker CLI unresolvable; post-merge hook failure; final review still blocking after its fix round | disarm, report, `goal({op:"drop"})` |
| No progress | no actionable child while children remain open | report, `goal({op:"drop"})` |

A stop marker holds for its run: a new `/goal` line (new `run=`) retries the
child. `review-bound` holds across runs, as does an open PR whose review bound is
spent. Before a ticket, base checks that are pending or absent do not stop the loop; they are reported. At finalization, pending drops as `base-ci-pending` and absent does not.

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
`bash "$SKILL_DIR/worktree-bootstrap.sh"`. It copies `worktree.copy` and
`worktree.seed` from the principal, runs `worktree.setup`, then builds each code
index the principal has, never one it lacks: ccc without its own `settings.yml`
indexes an ancestor directory. `.cocoindex_code` starts from a copy of the
principal's (repo-relative paths), so `ccc index` reprocesses only the branch
delta, and a copy that races a principal re-index or fails to load is rebuilt.
`.codegraph` is a fresh `codegraph init -y`, and `.semctx/` gets `semctx index`.
A marker under `git rev-parse --git-dir` makes a second run a no-op. It refuses
to write on the principal and never copies `*.example` in place of a missing
real file.
Agent-created worktrees live at `<worktree base>/<repo>/<slug>`, where the base
is `OMP_WORKTREE_DIR`, else `.dev/stack.yml` `worktree.base`, else `~/.omp/wt`.
Resolve the review target before opening a semantic contract. An existing PR
resumes its already-implemented change directly at §6.4; it does not open a new
contract or repeat the implementation/proof/push stages.

```javascript
const { openPr, landPr, resumeReviewLoop, applyCiWatchExit, disarmReviewedBeforePush, resolveReviewPr } =
  await import(`${SKILL_DIR}/workflow.js`)
// Under the Epic goal: `let pr = step.pr?.number ?? null` — the driver's PR, never a discovery.
let pr = await resolveReviewPr(cwd)
let loop = pr === null ? null : await resumeReviewLoop(cwd, { pr })
```

Discovery/read errors stop with evidence; never substitute a local loop.
If `loop?.closed === 'stop'`, run `enforceStop`, publish the canonical dossier
(`dev-review` Phase 8), and exit before any edit. Otherwise an existing `pr`
continues at §6.4 using this same `pr` and `loop`.
For a new PR only, when `.semctx/` exists, derive/open the change contract from the
issue (goal, invariants, evidence, unknowns); the issue stays the spec. Then §6.1.

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
Update affected docs. Finish every acceptance criterion before opening the PR.
For a criterion whose surface is `frontend.path` or `shared.ui`, run the app and
check it with the OMP `browser`, and record the steps, URL and observed result
in the PR. If `.dev/stack.yml` declares `commands.test_e2e`, that command is the
proof — do not record `ui-manual-only`.
When a contract is open, record each piece of evidence on it as it is produced.
Re-entry on an existing PR skips §§6.1–6.3 and retains its PR/loop from preflight.

### 6.3 Commit, push, open or resume

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
loop = await resumeReviewLoop(cwd, { pr })
if (loop.closed === 'stop') {
  // Sticky / derived / history-ambiguous stop — disarm again if needed,
  // publish/display the Phase 8 dossier, and exit. Do not record a new verdict.
  // Escalation keys only on `loop.closed === 'stop'` (derived by `interpretReviewHistory`).
  print((await loop.enforceStop(cwd)).message)
  return
}
```

`openPr` returns the numeric PR and `created | existing`, and supplies the closing
issue link. Print that result. Failure → report it; reconcile remote state before
retrying, never blindly create a second PR. The matrix follows `dev-review`'s
SC→Test contract, including justified NO TEST rows.

**Proof gate, before `openPr`, when `.semctx/` exists.** `proofGate` in
`$SKILL_DIR/proof-gate.ts` must pass: VERIFIED, or PARTIAL where every gap is a
NO TEST row with an accepted reason. BLOCKED stops. A `type: fix` ticket with an
assertledger adapter stops on any verdict other than detection, including
`WEAK_ORACLE`. No adapter is non-blocking. Then close the contract and leave
`.semctx/working/` empty apart from `.gitkeep`. No PR opened by `/feature` in a
semctx repo carries any other file there. The PR body's proof section is the
criterion → evidence map from the contract.

### 6.4 Review

Read and execute `skill://dev-review` for `#<pr>`, using **its own** directory for
`SKILL_DIR`. Keep feature's directory separately. After its posted verdict and
before its Phase 8 decision, record the verdict below. This cycle owns subsequent
fix/landing actions; the nested review must not execute them independently.

Translate the panel's verdict before calling the loop:
`Approve`, `Approve (clean)`, `Approve with comments` → `verdict = 'green'`;
`Request changes` → `verdict = 'red'`. Pass only `'green'` or `'red'` to the
loop, never a raw panel string such as `'Request changes'`.

```javascript
let step = pr ? await loop.recordPosted(cwd, verdict) : loop.record(verdict)
if (step.action === 'stop') {
  const stop = await loop.enforceStop(cwd) // BEFORE dossier; publishes durable stop + disarms
  print(stop.message)
  // publish/display Phase 8 escalation dossier, then return — do not persist separately
} else {
  await loop.persist(cwd)
}
```

A resumed loop does not replay `record` to recover an allocation. If
`loop.persistedFix` is set, that step is the unconsumed allocation: pass it to
`assertFixAllowed`. Do not call `record` or `recordPosted` for it. The grant
writes `<!-- omp-build:fix-grant reviews=N fixes=M token=… -->` and succeeds once.
A second call throws `grant already consumed` and writes nothing. A missing or
moved review head throws and writes nothing, including no stop.

Only a divergence of the durable history can make a stop sticky. A caller-order
mistake this process can see — `assertFixAllowed` before `persist`, a reused
step, `record` on a stopped loop, or `record` on a resumed loop without
`recordPosted` — throws and writes nothing. A live allocation stays live;
`persist`, then `assertFixAllowed`, still grants it.

Present the Phase 8 human choice constrained by `step`: **Fix now** routes through
§6.5 only on `fix`; **Merge** routes through §6.7 only on `land`; on `stop`,
follow §6.6 (enforceStop already ran above + escalation dossier) rather than offer
another round.
Never choose on the user's behalf or offer “Merge as-is” for a red verdict — except
under the Epic goal, where the choice follows `step.action` with no prompt.
The human's **Stop** while a fix is still available simply exits; `enforceStop` is
valid only when the loop itself returned `step.action === 'stop'`. A **Stop** at
the second fix offer (`fixes=2`) simply exits. It does not escalate: the
allocating review precedes its marker and its receipt, so the next resume stays
open until that receipt is posted. A later red review after that receipt is the
derived `review-bound`. A crash between the fix push and the receipt is the same
open allocation, never a sticky stop.
`resumeReviewLoop` already counts one review posted after the last marker.
`record` acknowledges that review when the verdict matches it, and does not
count it again. More than one unrecorded review is `history-ambiguous`: no live
grant. `record` has already counted the round when the choice is offered: say so,
since a red verdict **spends/allocates** a fix round whether or not the operator
then fixes.

### 6.5 Fix

`step.action === 'fix'`, by `step.reason`. On a resumed loop `step` is
`loop.persistedFix`, not a step from replaying `record`:

- review round (no reason) → `await loop.assertFixAllowed(cwd, step)`, then execute
  `skill://fix` with `#<pr>`. Nested fix consumes this caller-owned
  allocated step and must not call `record('red')` again. It applies one change per
  well-formed posted root cause that contains a blocking finding. A block missing a non-empty `mechanism:`, `fix:`, or `findings:` line is not applied; its blocking cited findings are filed per finding. It does not stop for a per-finding choice. Non-blocking causes are not applied; they go into one sibling follow-up, blocked by the origin. A blocking cause it
  cannot apply becomes its own sibling issue.
- `ci-failed` → `await loop.assertFixAllowed(cwd, step)`, then fix inline from the failed checks
  (`land.failed`) and their logs. `fix` reads review comments, not CI: running it
  here replays stale findings.

Both routes follow `dev-review` Phase 8's executable action contract. A rejected
grant stops before editing; print `error.stop` when present and publish the dossier.

Verify and commit/push the fixes, and post `## Review Fixes Applied` in that same
step. A receipt failure after a successful push stops; do not return to §6.4 until
the receipt is on the PR. State `step.remaining`.

### 6.6 Bound

| `step.action` | Next |
|---|---|
| `fix` | §6.5 |
| `land` | §6.7 |
| `stop` | `await loop.enforceStop(cwd)` first (when a PR exists), then publish/display the escalation dossier from `skill://dev-review` Phase 8; print both results and stop. No PR → never `persist`/`enforceStop`; keep `stopReason` locally and display the dossier. Epic goal: then ticket stop `review-bound` |

The bound, recovery policy and dossier live in `dev-review` Phase 8.
`record` and `reopen` spend rounds; `persist` records nonterminal steps;
`enforceStop` records terminal ones and disarms OPEN PRs. A sink observing a newer
stop already enforces it: report its result and publish the dossier, not a second
enforcement call. A final green after two completed fixes may land only when
strict current history has no stop. Helpers never unlock a stop.

### 6.7 Land

Only `step.action === 'land'` may reach this step. Obtain the operator's merge
approval if not already explicit for this PR; under the Epic goal the goal is that
approval, and each `land.status` maps through § Epic goal instead of the table
below. Then `await landPr(cwd, pr)`
resolves the landing mode itself from `cwd` through `readLanding` — the same
resolver `/ci-watch` uses: `landing.mode` in `.dev/stack.yml` (parsed as YAML),
else merge-on-green when `.github/workflows/merge-on-green.yml` exists, else
native. Before reading configuration, `landPr` independently reads current review
state: a stop returns `review-stopped` with disarm evidence; no approving review
after the latest correction/allocation returns `not-approved`. An approval arms
only the commit its record names: line 2 must be
`<!-- omp-build:review-head sha=<40 lowercase hex> -->` and must equal the PR's
current `headRefOid`. A record with no head line returns `not-approved` with
reason `no-review-head` and writes nothing — a PR reviewed before this line
existed needs one re-review. A different or unreadable head returns
`not-approved` with reason `head-moved`, also with no write. Invalid
configuration then returns `bad-landing` before arming. Immediately before every
write it re-reads `headRefOid`; a different or unreadable head returns
`not-approved` with reason `head-moved` and writes nothing. Under merge-on-green
it then adds `reviewed` — a pre-existing label is removed first so a fresh
labeled run exists — and returns
`{ status: 'watching', mode, watch }`. `watch` is the absolute real path of
`ci-watch.sh` (derived from this module), carrying `--merge-mode <mode>` and,
under merge-on-green, always `--since <GitHub labeled time>` of that new event.
If the labeled event cannot be read after re-label, `landPr` returns
`watch-failed` — never watches without `--since` under merge-on-green. Run that
string as given — the OMP shell does not resolve `skill://` for a bare `bash`
argv. It does not poll. Native enables the pinned auto-merge
(`--match-head-commit` of the reviewed sha) before adding `reviewed`.
`already enabled` is not success: auto-merge is disabled and enabled again with
that pin, or `landPr` returns `auto-merge-failed` without the label. The fleet
workflow enables only on `labeled`, and only when the event head equals the
line-2 sha of the latest automation-account Approve record. On `synchronize` it
disables auto-merge and removes `reviewed` instead of re-enabling from a
comment, and it does not `update-branch` a reviewed PR. merge-on-green has no
equivalent pin: once `reviewed` is applied, a push by another actor is not
refused by GitHub.
merge-on-green never returns `no-required-checks`.

Run `watch` as an async bash job (`timeout: 0`). Map the exit with
`applyCiWatchExit(cwd, pr, code, { mode: land.mode })`:

| Exit | Result |
|---|---|
| 0 | re-read state: MERGED → `merged`; CLOSED or otherwise unmerged → `stopped` (do not claim merged) |
| 1 | re-read state first (MERGED → `merged`, CLOSED → `stopped`); otherwise remove `reviewed` (native: also disable auto-merge), `ci-failed`, then `loop.reopen('ci-failed')` |
| 2 | re-read state first (MERGED → `merged`, CLOSED → `stopped`); otherwise remove `reviewed` (native: also disable auto-merge), `ci-cancelled` |
| 3 | re-read state first (MERGED → `merged`, CLOSED → `stopped`); otherwise remove `reviewed` (native: also disable auto-merge), `ci-blocked` |
| 4 | stop and report; do not claim merged (includes CLOSED during the check phase) |
| 5 | `timeout`; re-attach the same watch later |
| 6 | `evaluate-only`: merge-on-green is green but its run for this landing (started at or after `--since`, or the latest run without `--since`) reports `kit-ci not configured`; gate left armed |
| 70 | usage, missing tool, invalid `.dev/stack.yml` landing, or `gh`/`jq` failure → `watch-failed`; gate left armed |
| other | any other code (bad argv that somehow returned 1, job killed 124/137/143, …) → `watch-failed`; gate left armed |

Before any push that follows a `reviewed` label, call
`disarmReviewedBeforePush(cwd, pr, { push })`. The label is removed before the
push. A push with the label still on is forbidden — metalyde does not revoke it
on synchronize.

Neither a fix round nor another review action may write that label in this cycle.

| `land.status` | Action |
|---|---|
| `review-stopped` | Print `land.stop`, publish the `dev-review` Phase 8 dossier and exit; no watch, fix or merge |
| `no-pr` | Stop; no PR was resolved and no gate was armed |
| `not-approved` | Stop; no current approving review covers the latest correction. Review again; do not merge |
| `watching` | Start the async `/ci-watch` job named in `land.watch` |
| `merged` | Report issue + PR; offer the optional tail (§0), stop |
| `ci-failed` | Gate already disarmed; `step = loop.reopen('ci-failed')`; if `step.action === 'stop'` → `enforceStop` then dossier (do not `persist` separately); else `await loop.persist(cwd)` and follow §6.6 |
| `ci-cancelled` | Gate disarmed; stop, report the cancelled checks; operator re-runs CI then re-enters §6.7 |
| `ci-blocked` | Gate disarmed; stop, report the checks named on stderr; operator resolves the named checks or re-runs CI, then re-enters §6.7 |
| `watch-failed` | Stop; report the code or `land.error` (including when the labeled `reviewed` event could not be read after re-label under merge-on-green). Gate left as is; do not claim merged |
| `evaluate-only` | Stop; report "evaluate-only — manual merge required" and `docs/kit/ci-app-setup.md`. Gate left armed; the operator merges by hand. Do not claim merged; do not wait |
| `bad-landing` | Stop; report `land.error` (the `.dev/stack.yml` problem). Nothing was labelled or armed. Fix the stack file, then re-enter §6.7 |
| `no-required-checks` | Stop; report missing protection. Native only, when no required context was found (declared `landing.required_checks`, protection or rulesets) — merge-on-green does not return this |
| `timeout` | Re-attach the watch. Do not claim merged. Epic goal: ticket stop, no re-attach |
| `stopped` | Stop and report. Do not claim merged |
| `auto-merge-failed` | Stop; inspect and report actual PR/label/auto-merge state, never claim merged |
| `closed` | Stop; report closure |

Errors stop with their evidence. No manual mid-CI merge and no automatic release
or worktree deletion; the Epic goal deletes merged children's local branches, never a worktree.

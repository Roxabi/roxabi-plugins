# omp-build

OMP-only delivery plugin. Owns the OMP cycle after `dev-core` is uninstalled from the live OMP machine.

## Language

**omp-build**:
The OMP-only plugin that owns the OMP delivery cycle.
_Avoid_: factory, /R-dev, /build, dev-core (on OMP)

**Feature**:
The unit of OMP delivery, run by `/feature`.
_Avoid_: build, /build, /dev, /R-dev, omp-wt

**Epic goal**:
The `/goal` in the operator's session that delivers one epic. The autonomy unit of `/feature`.
_Avoid_: a per-ticket stop, an autonomy level stored on the issue, one goal per ticket

**Goal run**:
One `/goal` line for an Epic goal, named by the `run=<id>` in its objective. Only an active goal whose objective names the epic authorizes the loop. Stops are recorded per run; a new `/goal` line is a new run.
_Avoid_: a session, a paused goal, the run as a counter of attempts

**Ticket stop**:
A child the Goal run stops on - review bound spent, proof blocked, foreign commit or branch mismatch, no scope, a watch that timed out, cancelled or blocked checks, an unmerged or closed PR. Recorded as a `goal-stop` marker on the child; its PR is disarmed, its dependents are skipped, independent children continue. A later `next` re-disarms an armed PR of a stopped child before it continues; a failed re-disarm, or a PR that already merged, drops the goal and creates no branch. A spent review bound stays stopped across runs; any other ticket stop is retried by the next run.
_Avoid_: a goal drop, a skipped dependent, a stop held in session memory

**Shared-state stop**:
A failure that makes every remaining child unsafe — base CI red, base CI pending at finalization (`base-ci-pending`), a dirty tree between tickets, when `fix` starts, or before the goal completes, a hook `ok` or `skipped` at another commit (`hook-stale`), a landing or tracker failure, a failed post-merge hook, a final review still blocking after its fix round. Every armed child PR is disarmed, the goal is reported and dropped. Finalization (the hook, and `complete`) also requires a clean tree and base CI green or absent; a red or pending base does not hold the final review.
_Avoid_: a ticket stop, skipping the ticket, waiting on pending base CI

**Spec**:
The GitHub issue body: agreed scope, acceptance criteria, invariants and exclusions. The SSoT for what to build.
_Avoid_: artifacts/specs, validated, /R-spec

**Change contract**:
The semctx record derived from the issue body. It is proof, not a second Spec.
_Avoid_: artifacts/specs, a second spec home, the contract as what to build

**Proof gate**:
The bar a change must clear before its PR opens: a verified Change contract, and assertledger where an adapter exists.
_Avoid_: a green test run standing in for it, a falsify gate with no producer

**TDD**:
Test-first implementation at the seams agreed with the operator, using the model-invoked `tdd` skill.
_Avoid_: automatic tests for every change, a mandatory user slash

**Implementation**:
Work that satisfies one ticket's acceptance criteria inside its matching Worktree.
_Avoid_: an external `implement` skill as a prerequisite, implementation on the Principal

**Land**:
The authorized transition from a green review to the repository's merge gate.
Only an approving latest Review record of the current head lands, and never past a spent Review bound.
Arming the gate is not evidence that the PR merged.
_Avoid_: manual merge while checks run, treating a label as a completed landing

**Post-merge hook**:
The repository's declared command that runs once the epic has landed, not after each ticket. This run's `ok` or `skipped` counts only at the current base commit; at another commit the goal drops `hook-stale` and does not run the hook again.
_Avoid_: a per-ticket deploy, a release cut, re-running this run's hook on a moved base

**Review bound**:
At most two automated fixes per PR, one per Review record, derived on every read from the automation login's Review records: how many there are, and the latest one.
A fix — after a red review, or after a CI failure on the approved head — is allowed while the PR has at most two records; the fix's push moves the head, so the next step needs a review of it.
A record past the second that does not approve spends the bound for good: a later green does not lift it, and `landPr` refuses to arm. A CI failure after the third review stops too; the records do not show it, so only a ticket stop keeps that stop across runs.
Every posted review counts, with or without a fix before it. Nothing writes accounting.
The bound guards against agent mistakes, not against an agent that bypasses it. After a stop, resumption is an explicitly selected superseding PR under a revised plan, or the operator finishing by hand.
_Avoid_: a ledger, counting fix receipts, a stop marker, one more automatic retry, merging with blockers

**Snapshot**:
A frozen copy of selected `dev-core` files inside `omp-build`. No resync. Claude's `dev-core` evolves alone.
_Avoid_: fork, submodule, live share

**Ticket link**:
A native GitHub relation between tracker issues: sub-issue (parent/child) or dependency (blocked-by/blocks). Written by `issue-triage`.
_Avoid_: a `Blocked by:` text line, `.scratch/` local edges, raw `gh issue create` for a relation

**Sibling rule**:
A deferred follow-up is a sibling of its origin under their shared parent, blocked-by the origin — never its child.
_Avoid_: child-of-origin, nested deferral cascade

**Tier**:
`S` | `F-lite` | `F-full`, read from the tracker issue's `size:` label. Determines the review's spec-evidence requirements, not its agent roster.
_Avoid_: spec frontmatter, κ alone, tier-selected review agents

**issue-triage**:
The tracker plugin: creates issues, writes `size:`/`priority:`/type labels, and owns every Ticket link. Sibling to `omp-build`, not part of it.
_Avoid_: folding it into omp-build, copying its mutations

**Optional tail**:
`cleanup` after land, plus `promote` for staging-train projects only. Both remain the operator's decision.
_Avoid_: putting them in the review loop

**dev-core**:
The Claude/Grok factory plugin. Source stays in the marketplace; it is not loaded on OMP after the cut.
_Avoid_: "the plugin" when the host is OMP

**Dark-to-model**:
A skill that ships in the armed package (`extensions:`) so slash and `skill://` work, with `disable-model-invocation` so the model does not autoload it. omp normalises that key to `hide`: it omits the skill from the prompt listing and gates nothing — `skill://<name>` and `/skill:<name>` still reach the body. What makes a skill user-only is `registerCommand`, the lane the model cannot call.
_Avoid_: unloaded, hidden, Isolation-dark (that last one is not invocable), "two gates"

**Principal**:
The first `git worktree list --porcelain` worktree. Read-only exploration and tracker framing can start here; feature file edits belong in a matching Worktree.
_Avoid_: main, staging, master (those are bases, not this worktree)

**Worktree**:
A durable linked git checkout (ω) that isolates delivery from the Principal. Created by the agent from a fresh `origin/<base>`, meaning `refs/remotes/origin/<base>`; one per epic under an Epic goal. The operator enters it by moving the session, not by `/wt`.
_Avoid_: branch; Isolation (ephemeral `task.isolated` sandbox); `/wt`

**Epic worktree**:
The one Worktree an epic is delivered from, created **detached** at `refs/remotes/origin/<base>`, with no epic branch. Each child gets its own branch inside it, from the base, and its own PR; after a confirmed merge HEAD is detached there again and the child's local branch deleted.
_Avoid_: one worktree per ticket, an epic branch, the Principal, Isolation

**Bootstrap**:
The prepared state of an Epic worktree, taken once from what the repository declares, before its first ticket.
_Avoid_: a hand-maintained checklist, copying the Principal's uncommitted state

**Init**:
A repository's adoption by `/feature`: its tracker contract, canonical labels, proof tools and declared stack blocks.
_Avoid_: R-dev-init, assuming every repository is already adopted

**Isolation**:
An ephemeral `task.isolated` sandbox for a subagent. Torn down at yield; patches or cherry-pick land on the parent cwd. Not a Feature Worktree.
_Avoid_: ω, /wt, omp-wt

**Guard**:
In-process OMP `tool_call` interceptor (principal freeze, bare `bun test`, secret scan).
_Avoid_: hook (Claude `hooks.json`), lefthook (commit/push persist law)

**dev-review**:
The skill holding Roxabi's multi-domain review on OMP: roster, Conventional Comments, findings + verdict. Named `dev-review`, not `R-dev-review`, so it cannot shadow dev-core's while both are installed.
_Avoid_: R-dev-review as the skill name, code-review (Matt), /review (host builtin)

**fix**:
The skill that applies one change per blocking root cause from a review, inline, with no per-finding choice. Non-blocking causes are deferred into one sibling issue, not applied.
_Avoid_: R-fix as the skill name, R-fixer, spawning a fixer agent, a per-finding walkthrough, applying a non-blocking cause

**Root cause**:
The shared mechanism behind one or more review findings. Named after the review, before any edit. The unit `fix` applies when a member blocks; otherwise the unit it defers.
_Avoid_: the finding itself, a class slug alone, a file

**Review record**:
The one PR comment `fix` reads: first line `<!-- omp-build:code-review -->`, authored by the account running `fix`, newest wins. Root causes and findings both come from it. It is also the unit the Review bound counts. Line 2, when a PR was reviewed, is `<!-- omp-build:review-head sha=<40 lowercase hex> -->` — the commit that approval names. `fix` does not read it. `landPr` arms only when it matches the PR's current `headRefOid`; a record without it does not arm, so a PR reviewed before the line existed needs one re-review. Native auto-merge is then pinned with `--match-head-commit`. Merge-on-green remains label-driven: a push by another actor after `reviewed` is applied is not refused by GitHub.
_Avoid_: scraping every PR comment, matching `## Code Review` as a substring, reading a sha from prose or from any line but line 2

**Panel**:
The five dispatchable review roles: the `R-adversarial` floor plus at most two specialists the roster proved relevant.
_Avoid_: domain roles, FE/BE reviewers, a per-language reviewer

**R-adversarial**:
The single red-team posture and review-panel floor (OWASP + sibling-drop).
_Avoid_: reviewer, security-reviewer, a second unprefixed `adversarial`

**R-advisor**:
Read-only constructive second opinion. Not the session WATCHDOG.
_Avoid_: advisor.enabled, WATCHDOG

**elon**:
Read-only Algorithm posture (inventory → delete → simplify → accelerate → automate last).
_Avoid_: R-elon, Musk roleplay

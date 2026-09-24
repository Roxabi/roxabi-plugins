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
After a green review loop: the `reviewed` label, then the landing mode declared in `.dev/stack.yml`, followed by `/ci-watch`. That mode is read from the base ref, not from the epic worktree. An unregistered `/ci-watch` is a stop: remove `reviewed` and disable auto-merge. The label is not a completed landing.
_Avoid_: R-ci-watch, gh pr merge while checks run, a raw delay inside `landPr`

**Post-merge hook**:
The repository's declared command that runs once the epic has landed, not after each ticket.
_Avoid_: a per-ticket deploy, a release cut

**Review bound**:
At most two review→fix rounds per PR, counted by `createReviewLoop` and resumed from
the PR by `resumeReviewLoop`. The third red returns `stop`; `enforceStop` then removes
`reviewed` and disables auto-merge, so the PR really is unlabelled and unmerged.
A CI failure after a green verdict re-enters through `reopen('ci-failed')`, which
spends a round rather than refunding one.
_Avoid_: "one more review", a second loop on the same PR, a round counter held in
prose, a `reviewed` label written by anything but the landing step

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
The one Worktree an epic is delivered from. Each ticket inside it is its own branch and its own PR.
_Avoid_: one worktree per ticket, the Principal, Isolation

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
The skill that applies one change per common root cause from a review, inline, with no per-finding choice.
_Avoid_: R-fix as the skill name, R-fixer, spawning a fixer agent, a per-finding walkthrough

**Root cause**:
The shared mechanism behind one or more review findings. Named after the review, before any edit. The unit `fix` applies.
_Avoid_: the finding itself, a class slug alone, a file

**Review record**:
The one PR comment `fix` reads: first line `<!-- omp-build:code-review -->`, authored by the account running `fix`, newest wins. Root causes and findings both come from it.
_Avoid_: scraping every PR comment, matching `## Code Review` as a substring

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

# omp-build

OMP-only delivery plugin. Owns the OMP cycle after `dev-core` is uninstalled from the live OMP machine.

## Language

**omp-build**:
The OMP-only plugin that owns the OMP delivery cycle.
_Avoid_: factory, /R-dev, /build, dev-core (on OMP)

**Feature**:
The unit of OMP delivery, run by `/feature`.
_Avoid_: build, /build, /dev, /R-dev, omp-wt

**Mandate**:
The operator's accepted authority to deliver or correct a defined scope under a specified configuration. A correction-only mandate does not authorize landing.
_Avoid_: a session goal, a review verdict, a permission inferred from missing data

**Pause**:
Temporary suspension of an otherwise valid Mandate, confirmed only after the applicable landing arms are cleared. Resumption does not clear a review-bound or safety stop.
_Avoid_: abandonment, a spent bound, stopping the local process

**Session pause**:
The durable pause a native session stop, switch, or shutdown awaits for a pausable owner. A finished or confirmed-abandoned owner is released and is not paused again.
_Avoid_: a local interrupt, an unconfirmed pause request, a spent review bound

**Abandonment**:
Explicit revocation of a Mandate. A successor, if one exists, retains its antecedents and does not erase their stops.
_Avoid_: pause, automatic renewal, resetting a bound

**Successor**:
A mandate that names an abandoned or revoked antecedent on the same issue. An open pull request stays the same request, rebound to the successor.
_Avoid_: automatic renewal, a second issue, a second pull request, `/feature <reference>`

**Operator control**:
A confirmed record that pauses, resumes, abandons, names a successor, or records an explicit material-Spec decision. A local process stop is not this record.
_Avoid_: a session goal, an unconfirmed inhibit

**Action receipt**:
The confirmed start or result of a semantic, planning, or implementation action that otherwise has no durable product record.
_Avoid_: a review record, a transcript, a local cache

**Workflow binding**:
The confirmed link on a pull request to one mandate, branch, and base. It adds no permission.
_Avoid_: a closing keyword, a branch name, a body parse

**Additional requirements**:
The string list at `review.additional_requirements` in committed `.dev/stack.yml`, recorded on the mandate. It is not a graph, a bound, or an admission rule.
_Avoid_: `.omp-build/workflow.json`, a working-tree copy, `review.graph`, `review.workflow`

**Confirmed checkpoint**:
A published result whose complete remote record has been read back and can support resumption. Unpublished work and a still-running agent are not checkpoints.
_Avoid_: a local snapshot, an attempted write, an unconfirmed acknowledgement

**Epic mandate**:
The confirmed `mandate` on the epic issue: run, base, and approved child scope for that delivery. It is not a session goal.
_Avoid_: Epic goal, /goal, an autonomy level stored on the issue, one goal per ticket

**Run**:
The run id stored on an Epic mandate. It names one delivery pass. It does not authorize the pass, reset a review bound, or join authority by itself.
_Avoid_: Goal run, a /goal line, `run=` in an objective, a counter of attempts

**Ticket stop**:
A child the epic driver stops while independent children continue. The child record is an `epic-event` whose `event` is the historical wire name `goal-stop`.
_Avoid_: a shared-state stop, a /goal drop, a stop held in session memory

**Shared-state stop**:
A failure that makes every remaining child unsafe to continue. The drop record is an `epic-event` whose `event` is the historical wire name `goal-report`.
_Avoid_: a ticket stop, a /goal, waiting on pending base CI before a ticket

**Spec**:
The GitHub issue body: agreed scope, acceptance criteria, invariants and exclusions. The SSoT for what to build.
_Avoid_: artifacts/specs, validated, /R-spec

**Canonical record**:
A versioned common record whose payload is the authority for that operation. The Markdown beside it is a deterministic projection, not a second contract.
_Avoid_: a positional HTML marker, a Markdown section a consumer parses, a local session store

**Epic event**:
A canonical record on an epic or child issue. Its payload `event` is one of the historical wire names `goal-stop`, `epic-review`, `epic-fix`, `post-merge`, or `goal-report`. Those names are protocol, not a session goal.
_Avoid_: a /goal, a body marker, a `goal-stop` comment prefix, session memory

**Landing admission**:
The read-only check before `landPr` writes its arms. It admits only when the latest review approves the current head inside an unspent review bound, required CI is green, normative inputs are unchanged, and the selected outputs are authentic. Normative inputs are the mandate configuration version and digest, the accepted Spec, and a fresh `omp-build:review-input/3` capture equal to the review binding. Authentic outputs have the expected author and readable, unedited native dates on every record that establishes the selected review's verdict and findings: its review, inventories, decision, synthesis and finding contributions, and their bound inputs; and on every mandate-chain and workflow-binding part.

Mandates use `omp-build-mandate/2`; reviews that carry input use `omp-build:review-input/3`. Missing or older formats, obsolete payload fields, and frames using the removed `kind: 'proof'` refuse with `incompatible-format`. They are not migrated, re-reviewed, or exempted.

_Avoid_: a green check alone, an earlier review, an unbound head, treating a digest as authentication

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
The repository's declared command that runs once the epic has landed, not after each ticket. This run's `ok` or `skipped` counts only at the current base commit; at another commit the driver stops `hook-stale` and does not run the hook again.
_Avoid_: a per-ticket deploy, a release cut, re-running this run's hook on a moved base

**Review bound**:
At most two automated fixes per PR, one per canonical final review, derived on every read from the automation login's complete `review` records: how many there are, and the latest one. A legacy marker is not a review.
A fix — after a red review, or after a CI failure on the approved head — is allowed while the PR has at most two records; the fix's push moves the head, so the next step needs a review of it.
A review past the second that does not approve spends the bound for good: a later green does not lift it, and `landPr` refuses to arm. A CI failure on the head the third review approved is a canonical `stop` and stays spent.
Every posted review counts, with or without a fix before it. Nothing writes accounting.
After a stop, resumption is operator-supervised agent processing: the operator explicitly approves revised scope, a diagnostic/correction plan and the continuation checkpoint; agents perform the correction, targeted proof and independent review. A spent PR stays stopped and disarmed, so revised work goes to a superseding PR with a fresh bound while its records remain evidence; fresh review, proof, CI and `landPr` admission still apply.
_Avoid_: a ledger, counting fix receipts, resetting a canonical stop, one more automatic retry, raw label or manual-merge bypass

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
A skill that ships in the armed package (`extensions:`) so slash and `skill://` work, with `disable-model-invocation` so the model does not autoload it. omp normalises that key to `hide`: it omits the skill from the prompt listing and gates nothing — `skill://<name>` and `/skill:<name>` still reach the body. A user-only command is `registerCommand`, the lane the model cannot call. Review is also a model tool; correction starts through `/fix` or the Feature review-bound handoff. Neither grants execution authority.
_Avoid_: unloaded, hidden, Isolation-dark (that last one is not invocable), "two gates", slash-only for every product path

**Principal**:
The first `git worktree list --porcelain` worktree. Read-only exploration and tracker framing can start here; feature file edits belong in a matching Worktree.
_Avoid_: main, staging, master (those are bases, not this worktree)

**Worktree**:
A durable linked git checkout (ω) that isolates delivery from the Principal. Created from a fresh `origin/<base>`, meaning `refs/remotes/origin/<base>`. The operator enters it with `/move <path>`, not `/wt`.
_Avoid_: branch; Isolation (ephemeral `task.isolated` sandbox); `/wt`; a session goal

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
The native review product on OMP: spec, panel, recall, synthesis, and confirmed canonical records. Named `dev-review`, not `R-dev-review`.
_Avoid_: a Markdown review protocol, R-dev-review as the skill name, code-review (Matt), /review (host builtin)

**fix**:
The native correction that applies each admitted cause's one plan through dedicated correction profiles, then falsifies that plan. It does not walk findings inline and does not revive `R-fixer`. Baseline defers non-blocking causes; a blocker it cannot apply is filed and still blocks. A correction never lands.
_Avoid_: an inline orchestrator edit, R-fix as the skill name, the absent general `R-fixer`, a per-finding walkthrough, applying a non-blocking baseline cause, picking a fix from a finding's solutions

**Root cause**:
The shared mechanism behind one or more review findings, stated with its one plan: mechanism, fix, failure scenario, restored behaviour, affected paths, proof, findings. Named after the review, before any edit. The unit `fix` applies when a member blocks; otherwise the unit it defers.
_Avoid_: the finding itself, a class slug alone, a file, a menu of solutions

**Review record**:
The canonical `review` a consumer reads by record identity. It names the decision, the candidate SHA, and the input digest; projection lists source provenance and is not authority. The review bound counts complete final reviews by the automation login's native authorship. `landPr` arms only when that candidate equals the current `headRefOid`. A legacy marker does not arm. Native auto-merge then pins that head with `--match-head-commit`. Merge-on-green remains label-driven: a push by another actor after `reviewed` is applied is not refused by GitHub.
_Avoid_: `<!-- omp-build:code-review -->`, a line-2 head marker, scraping `## Code Review`, reading a SHA from projection prose

**Review input binding**:
The SHA-256 on a canonical review, or null. Prefix `omp-build:review-input/3` covers the observed PR inputs and semantic context without producer parts. A null input is not approval. Admission recaptures the input and requires equality; the digest checks observed inputs, not authorship.

Missing or older input formats refuse with `incompatible-format`; they are not migrated, re-reviewed, or exempted.

_Avoid_: a line-3 HTML marker, an acquisition attestation, a frozen manifest, a cached snapshot, a digest rebound after panel work

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

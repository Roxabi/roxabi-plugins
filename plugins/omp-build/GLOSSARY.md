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

**Change contract**:
The Semctx change declaration derived from the issue body. It is proof, not a second Spec, and its lifecycle is Semctx's own.
_Avoid_: artifacts/specs, a second spec home, the contract as what to build, closing it to open or land a PR

**Canonical record**:
A versioned common record whose payload is the authority for that operation. The Markdown beside it is a deterministic projection, not a second contract.
_Avoid_: a positional HTML marker, a Markdown section a consumer parses, a local session store

**Epic event**:
A canonical record on an epic or child issue. Its payload `event` is one of the historical wire names `goal-stop`, `epic-review`, `epic-fix`, `post-merge`, or `goal-report`. Those names are protocol, not a session goal.
_Avoid_: a /goal, a body marker, a `goal-stop` comment prefix, session memory

**Proof record**:
A canonical `proof` record for one candidate head: `candidateGitSHA` plus the producer's untouched native JSON. Posted on its PR by the automation account before landing and reused while it still binds that head. Legacy proof framing cannot admit landing. It attests the selected comment's current body, not what the producer printed nor who ran it: any account with write access can edit or delete the comment. Every applicable native part must have readable creation/revision facts, predate approval and have no recorded edit, regardless of producer or current verdict.
_Avoid_: `<!-- omp-build:proof -->`, a trailing JSON frame as the contract, a ledger, a cache, a caller's boolean, a re-run at landing, a signed attestation

**Proof pin**:
The Git identity of one normative proof-configuration path: path, source commit, and blob. A null blob is explicit absence, not an omitted pin.
_Avoid_: a local ignored file, a review-input hash, an omitted path

**Landing admission**:
The read-only check that lets a reviewed head land through the arms `landPr` writes. Semctx applies when the base, the head or the operator's uncommitted configuration configures it; it then needs the record of the change contract the head adds, VERIFIED or PARTIAL with every gap justified by a NO TEST row in a PR body the approving review judged. A fix PR needs a detection only when the established base or candidate commits a root `assertledger.config.json` with an adapter; bundled Kit Vitest tooling alone is not applicable. Each record binds one head; a new head needs its own. VERIFIED composes declared evidence statuses, never a test run: landing's runtime-proof claim depends on CI GitHub actually enforces on the selected base and head. Supplied or stack-declared check names do not establish that enforcement, and unprotected native merge need not wait for them. A `reviewed` label or auto-merge set by another actor is an override that admission does not govern. It produces nothing.
_Avoid_: proof gate, a check before the PR opens, a green test run standing in for it, a PARTIAL reported as verified, VERIFIED read as tests passed, every merge proved

**Reviewer trust ceiling**:
The operator-authorized split for a PARTIAL gap: admission checks native producer/input/candidate/base binding, policy, form, publication/body chronology and exact observed review-input equality; the proof-aware review judges reason truth and credible browser-check performance. Unsupported claims block review. A row/block is form, timestamps show availability, the digest identifies captured inputs (not who actually read them), approval is judgement, and VERIFIED composes authored statuses — none independently certifies the unproved gap. Required CI and applicable assertledger remain independent.
_Avoid_: approval as runtime certification, a Browser check block as an observation, a NO TEST row as proof, a review-judged gap called producer-certified

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
The plain SHA-256 on a canonical review, or null. Prefix `omp-build:review-input/2` covers observed PR inputs and the semantic canon, including when producer part lists are null. A null input is not approval. It is equality of observed inputs, not authentication; genuine no-proof repositories keep their existing admission path.
_Avoid_: a line-3 HTML marker, an acquisition attestation, a frozen manifest, a cached snapshot, a digest rebound after panel work, PARTIAL-only binding

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

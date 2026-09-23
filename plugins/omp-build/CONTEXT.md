# omp-build

OMP-only delivery plugin. Owns the OMP cycle after `dev-core` is uninstalled from the live OMP machine.

## Language

**omp-build**:
The OMP-only plugin that owns the OMP delivery cycle.
_Avoid_: factory, /R-dev, /build, dev-core (on OMP)

**Feature**:
The unit of OMP delivery, run by `/feature`.
_Avoid_: build, /build, /dev, /R-dev, omp-wt

**Spec**:
The tracker issue body produced by Matt `to-spec`. The SSoT for what to build.
_Avoid_: artifacts/specs, validated, /R-spec

**TDD**:
Matt's model-invoked `tdd` skill — red→green at agreed seams, driven by `implement`.
_Avoid_: R-tester, /test, a user slash in `/feature`

**implement**:
Matt's user-invoked build step. Drives TDD, then we run R-dev-review instead of Matt `code-review`.
_Avoid_: R-dev-implement, listing tdd as a sibling step

**Land**:
After a green review loop: required checks, `reviewed` label, auto-merge (`landPr`).
_Avoid_: R-ci-watch, gh pr merge while checks run

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
`S` | `F-lite` | `F-full`, read from the tracker issue's `size:` label. Sizes the review panel.
_Avoid_: spec frontmatter, κ alone, guessing a default

**issue-triage**:
The tracker plugin: creates issues, writes `size:`/`priority:`/type labels, and owns every Ticket link. Sibling to `omp-build`, not part of it.
_Avoid_: folding it into omp-build, copying its mutations

**Optional tail**:
`promote` and `cleanup`, offered after land, not part of the happy path.
_Avoid_: putting them in the review loop

**dev-core**:
The Claude/Grok factory plugin. Source stays in the marketplace; it is not loaded on OMP after the cut.
_Avoid_: "the plugin" when the host is OMP

**Dark-to-model**:
A skill that ships in the armed package (`extensions:`) so slash and `skill://` work, with `disable-model-invocation` so the model does not autoload it. omp normalises that key to `hide`: it omits the skill from the prompt listing and gates nothing — `skill://<name>` and `/skill:<name>` still reach the body. What makes a skill user-only is `registerCommand`, the lane the model cannot call.
_Avoid_: unloaded, hidden, Isolation-dark (that last one is not invocable), "two gates"

**Principal**:
The first `git worktree list --porcelain` worktree. Feature work does not run here.
_Avoid_: main, staging, master (those are bases, not this worktree)

**Worktree**:
A durable linked git checkout (ω) that isolates one Feature from the Principal. Created by `/wt` (session moves with it) or `omp worktree add` (tree only).
_Avoid_: branch; Isolation (ephemeral `task.isolated` sandbox)

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
The skill that applies review findings — auto-apply, then 1b1, every edit made inline in the session.
_Avoid_: R-fix as the skill name, R-fixer, spawning a fixer agent

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

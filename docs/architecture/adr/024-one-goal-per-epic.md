---
title: "ADR-024: One goal per epic"
description: Amends ADR-020 §3, §4, §8 and §9 — autonomy is an epic goal, the change contract is proof not a second spec, assertledger is a separate gate where an adapter exists and does not restore the R-tester falsify gate, and the agent creates the worktree from a fresh origin base.
status: accepted
normative: true
date: 2026-09-24
---

> Implements Roxabi/roxabi-plugins#576.
> Amends [ADR-020](020-omp-delivery-feature-cycle.md) §3, §4, §8 and §9.
> The rest of ADR-020 stays in force, including its refuse list, except the
> consequences §3 and §8 reverse: the per-ticket frontier stop, and the claim
> that OMP loses every executable check. Those sentences are qualified in
> ADR-020. They are not still law.

## Context

[ADR-020](020-omp-delivery-feature-cycle.md) made `/feature` the only OMP
orchestrator and stopped it at the frontier: one ticket, one operator relaunch,
one `/wt`. That matched a host whose session could not be trusted to run a whole
cycle. It also cut executable falsification, because the producer (`R-pr`) was
not absorbed, and it made the tracker issue the only spec home.

Four facts since then changed the cost of those clauses:

- An epic of independently landable tickets, each stopped for a relaunch, spends
  the operator on handoffs the cycle already knows how to make.
- `/wt` branches from the session `HEAD` and carries uncommitted changes. An epic
  worktree created that way inherits whatever the Principal happened to hold.
- A semctx change contract written as a second spec reintroduces the
  `artifacts/specs` split ADR-020 retired. Derived from the issue, the same
  record is proof.
- assertledger, where an adapter exists, is a separate gate. It is not the
  `R-pr` / `oracle_ok` producer, and it does not discharge the refuse line
  against restoring the `R-tester` falsify gate. Where no adapter exists that
  gate is absent, not a permanent `false`.

## Options Considered

### Option A: Leave ADR-020 as written

- **Pros:** No new vocabulary. The per-ticket stop is the context hygiene ADR-020
  priced, and `/wt` stays the only way into a worktree.
- **Cons:** The operator is the queue. `/wt` cannot create an epic worktree from
  a fresh base. Falsification stays absent even where a producer now exists.

### Option B: Rewrite the four clauses inside ADR-020

- **Pros:** One document holds the current law.
- **Cons:** Rewrites a decision that was taken and shipped. A reader can no
  longer see what #488 decided, which is how a decision log gets falsified.

### Option C: Partial supersession (chosen)

A new ADR names the four clauses it replaces. ADR-020 stays `accepted` and
`normative: true`, and records the exception in `superseded_in_part_by`.

- **Pros:** Current law is one hop away; the original decision stays readable.
- **Cons:** Two documents. A reader who stops at ADR-020's prose, and skips the
  frontmatter, still sees the retired clauses.

## Decision

Adopt **Option C**. `/feature` remains the only orchestrator. Four clauses of
ADR-020 no longer bind:

1. **§3 — autonomy is an epic goal.** The unit of unattended delivery is one
   `/goal` in the operator's session, covering one epic: one epic worktree, and
   one branch plus one PR per ticket, in `blocked_by` order. A stopped ticket is
   reported; independent tickets continue and its dependents are skipped. A
   shared-state failure stops the goal. Base CI is read before each ticket
   starts; red stops the goal, it does not skip the ticket. The post-merge
   hook failing stops the goal. Its command is read from
   `refs/remotes/origin/<base>`, not from the working tree, and executed as
   argv with no shell. A missing ref, or a short `origin/<base>` that is
   ambiguous, stops the goal. A value that is not that argv stops the goal.
   The glossary names the hook; it does not
   carry this rule. No autonomy level is stored on the issue.
   Without a goal, `/feature` stays assisted: the operator starts each step.
   The per-ticket stop ADR-020 required is the assisted case, not the law for
   an epic under a goal.

2. **§4 — the semctx change contract is proof, not a spec.** It is derived from
   the issue body. The issue remains the only spec home. Where the contract and
   the issue diverge, the issue wins: the contract is re-derived, and it cannot
   add a requirement the issue does not contain. ADR-020's refuse line against
   a second spec home stays in force; renaming the home does not satisfy it.

3. **§8 — executable falsification returns through assertledger, where an
   adapter exists.** The adapter is the producer of that gate, and of no other.
   ADR-020's refuse line stays in force as written: do not restore the
   `R-tester` falsify gate without its producer. assertledger is not that gate
   and does not write `oracle_ok` or `artifacts/reviews/{N}-falsify.json`. It
   does not discharge the line, and this decision does not restore the gate.
   Where no adapter exists the assertledger gate is absent, not a permanent
   `false`. The ADR-019 sentence this qualifies is its banner: the OMP product
   has no oracle producer and no tester falsify gate. That sentence means the
   `R-pr` / `oracle_ok` oracle. `superseded_in_part_by` records that
   qualification and no other ADR-019 clause. The same reading applies to
   ADR-020's preamble and Negative.

4. **§9 — the agent creates the worktree** from a freshly fetched
   `refs/remotes/origin/<base>`, never from `HEAD`, and never carrying the
   Principal's uncommitted changes. A missing ref, or a short `origin/<base>`
   that is ambiguous, stops the goal. The operator enters that directory by moving the
   session (`/move`, or `omp --cwd`). `/wt` is neither the creation path nor
   the hop: it branches from `HEAD`, carries uncommitted changes, and refuses
   an existing tree. This is not a second worktree CLI. ADR-020's refuse line
   against one stays.

## Consequences

### Positive

- An epic lands as one goal instead of one relaunch per ticket.
- The worktree starts from the base the PR will merge into, not from whatever
  the Principal held.
- Proof has a home that cannot become a second spec. assertledger, where an
  adapter exists, is a separate gate; it is not the `R-pr` producer and does
  not discharge the `R-tester` refuse line.

### Negative

- A goal runs the omp-build that was installed when it started. Tickets inside
  it cannot depend on each other's runtime behaviour without a reinstall the
  goal itself must not do.
- Two creation paths now exist in the operator's head. Only one is in contract.
  Using `/wt` for an epic worktree is a contract break, not a shortcut.
- A repository with no assertledger adapter has no assertledger gate. That
  absence is stated, not a permanent `false`, and it is not the `R-pr` oracle,
  which stays cut.

### Neutral

- ADR-020's other clauses are untouched: host split, snapshot freeze,
  `issue-triage` owns ticket links, five-role panel, principal freeze, TDD as a
  posture.
- The glossary terms this decision adds live in `plugins/omp-build/CONTEXT.md`.

## References

- Issue #576 · [ADR-020](020-omp-delivery-feature-cycle.md) · Glossary `plugins/omp-build/CONTEXT.md`

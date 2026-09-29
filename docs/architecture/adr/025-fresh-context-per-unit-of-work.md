---
title: "ADR-025: Fresh context per unit of work"
description: Amends ADR-020 §7 and its Negative (context hygiene), and ADR-024 decision 1 (§3) — a ticket, each fix round and any new assignment that delivers another issue or PR start in a fresh context seeded with the unit's assignment and durable state only; a finished agent gets no new work; fix still edits inline, inside its own fresh agent; under a goal the ticket unit holds the goal's merge approval.
status: accepted
normative: true
date: 2026-09-29
---

> Amends [ADR-020](020-omp-delivery-feature-cycle.md) §7 (where `fix` runs) and its
> Negative (context hygiene), and [ADR-024](024-one-goal-per-epic.md) decision 1
> (§3 — where a ticket runs under an epic goal).
> Restores the context hygiene that ADR-020's Negative priced and that ADR-024
> removed without a replacement.

## Context

Every model call resends the agent's whole conversation. The prompt cache
discounts that resend; it does not remove it. A unit of work therefore costs the
sum of its context over its turns, and that sum grows faster than the work.

One measured OMP session (2026-09-29, one kit repository, Grok 4.7) delivered
about ten tickets through parallel agents:

- 351 M input tokens in about two and a half hours, 93 % of them cache reads of
  history already sent.
- Implementer contexts grew from about 17.5 k tokens on the first turn to
  300–430 k. The five largest implementers compacted once between them. The
  model's window is 500 k and the default compaction trigger sits near 425 k,
  so it almost never fired.
- Review findings went back to the same implementer agents. For the four
  largest implementers with a PR, 60–78 % of their tokens were spent after the
  first review, at their largest contexts: 31.6 % of the whole session.

The cycle does not need that history. Everything a later step reads is already
durable: the issue (the spec), the branch and its commits, the review record on
the PR, the `omp-build:review-rounds` marker and the change contract.
`workflow.js` keeps the round count on the PR precisely because an agent's memory
is not trusted across a compaction. ADR-020 adopted `/clear` between tickets as a
consequence. ADR-024 removed the per-ticket stop under a goal and nothing took its
place, so a goal carries every ticket in one context.

## Options Considered

### Option A: Rely on compaction

Lower the compaction trigger and keep one context per goal or per ticket.

- **Pros:** No workflow change.
- **Cons:** A summary is lossy and costs a call. Until the trigger fires, the
  context still carries the previous unit's reads and findings. Compaction bounds
  the size of a context, not what a context is for. It is operator
  configuration, not plugin law.

### Option B: Cap how many tickets run at once

- **Pros:** Paces spend and leaves checkpoints.
- **Cons:** Does not change what one ticket costs. A goal already runs its
  tickets one at a time and still accumulates them in one context.

### Option C: Fresh context per unit of work (chosen)

- **Pros:** A unit costs what that unit needs. A fix round starts from the skill
  and the review record, not from the implementer's transcript. The durable state
  already exists, so nothing new has to be persisted.
- **Cons:** A fresh agent re-reads the files it needs. A fix agent does not see the
  implementer's reasoning beyond the PR, its commits and the review record. Under a
  goal, work runs one spawn level deeper.

## Decision

Adopt **Option C**.

1. **Unit of work.** One ticket's delivery (`/feature` §6), one review fix round,
   one `ci-failed` round, and any new assignment that delivers another issue or PR
   (implement, review, fix, land). Tracker reads and writes done for the current
   unit — PR state, `blocked_by` edges, a filed sibling issue — stay inline. Each
   unit starts in a fresh context. One exception: without a PR there is no durable
   review record, so a standalone `dev-review` **Fix now** on a local diff runs
   `fix` in the reviewing session.
2. **Fresh context.** A new session — the assisted case, unchanged: the operator
   runs `/feature #N` after `/clear` — or an agent spawned for that unit alone.
   Its seed is at most the unit's assignment, verbatim, and durable data: issue
   number, worktree path, branch, base, PR number, the skill directory and, under
   a goal, the epic number. No transcript, pasted finding or summary of another
   unit goes in. `/feature` § Context boundary is the one definition. A spawn site
   outside its table (a `/feature` §6.2 slice delegate, `dev-review` Fix now)
   states its own assignment under the same ceiling.
3. **A finished agent gets no new work.** No IRC follow-up, no resume, no second
   assignment. A new unit spawns a new agent. Every unit returns a closed result
   that its spawner checks against durable state. A unit that returns `halted`,
   or whose result does not match that state, ends there: the spawner stops and
   reports, and never respawns the same unit. Under a goal, a ticket unit that
   returns no well-formed outcome, or one its PR state refutes, is a
   `shared-state-stop` unless the PR is merged (`/feature` § Ticket unit).
4. **Fix rounds.** A review round — `/feature` §6.5, and a standalone `dev-review`
   **Fix now** on a PR — runs `fix` in a fresh agent with the caller's label mode:
   `/feature` always passes `--no-label`, because its loop owns the merge gate,
   and `fix` never labels a PR that carries the loop's `omp-build:review-rounds`
   marker, whatever its arguments say.
   ADR-020 §7 still holds inside it: `fix` applies every cause inline, in the
   session that runs it, spawns no fixer and delegates no edit. That session is
   now the fresh one. No fixer role returns.
   A `ci-failed` round runs `/feature`'s `ci-failed` round procedure, never
   `fix`: it reads the failed checks from GitHub, stages only what it changed,
   verifies before its push and writes no label.
5. **Epic goal.** ADR-024 decision 1 (§3) makes a goal unattended; this decision
   makes the operator's `/goal` the standing Phase 8 choice and merge approval for
   every ticket of the epic. The goal session keeps the frontier, the base-CI read and
   each ticket's outcome, and owns the hand-over of the epic worktree: before each
   spawn it requires a clean tree and checks out the ticket's branch, created from
   fresh `refs/remotes/origin/<base>` when it does not exist. It spawns one ticket
   unit at a time, in `blocked_by` order, seeded with its role, the epic number,
   the branch, the base and the skill directory. The ticket unit runs `/feature` §6
   to a terminal outcome without asking, with every operator gate mapped per
   `/feature` § Ticket unit: it follows the review loop's step, lands on green and
   waits on its own CI watch, re-attaching a timeout at most twice. It returns one
   closed outcome — `merged`, `ticket-stopped` or `shared-state-stop` — and the
   goal session confirms `merged` from PR state before trusting it. The rest of
   ADR-024 decision 1 stands: the goal is still the autonomy unit.
6. **What enters a context.** A full-suite or test run writes its log to a
   temporary file outside the worktree and brings back its exit code and its
   failing section. Reads prefer line ranges and skip content already in the
   context; a skill step that requires a full read wins.

## Consequences

### Positive

- A unit's cost is bounded by that unit, not by what ran before it.
- The most expensive turns measured — fix rounds at the largest contexts — now
  start small.
- No new state: the cycle already persists what a fresh context needs.

### Negative

- Fresh agents re-read the files they touch. That cost is bounded by the diff; the
  history it replaces is not.
- A fix agent knows the implementer's intent only through the issue, the PR body,
  the commits and the review record. A cause that needs more is filed, as today.
- Under a goal, a ticket agent spawns its reviewers and its fix agents one level
  down. That fits the default `task.maxRecursionDepth` of 2; a lower setting breaks
  the goal path.
- Under a goal nothing asks the operator before a merge: the `/goal` is the
  approval, written down here instead of left to the goal session's judgement.
  Assisted `/feature` keeps the Phase 8 choice.

### Neutral

- Compaction still bounds a single unit. On Grok 4.7 the operator sets
  `task.agentCompactionThresholdOverrides.task` (200 000 on the reference machine).
  That is machine configuration, not this plugin's contract.
- Panel reviewers were already fresh agents; nothing changes for them.

## References

- [ADR-020](020-omp-delivery-feature-cycle.md) §7 and Negative (context hygiene) ·
  [ADR-024](024-one-goal-per-epic.md) decision 1 (§3) and Option A
- `plugins/omp-build/skills/feature/SKILL.md` § Context boundary, §6.5
- `plugins/omp-build/skills/fix/SKILL.md` · `plugins/omp-build/CONTEXT.md`
  (Context boundary)

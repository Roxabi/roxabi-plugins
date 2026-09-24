---
title: "ADR-020: OMP delivery leaves dev-core — /feature on the Matt base"
description: >
  OMP runs omp-build + issue-triage; dev-core is uninstalled there.
  /feature = grilling + issue-triage → implement → dev-review → fix ≤2 → landPr.
  Absorb mode is snapshot freeze, not resync. Spec home is the tracker issue.
  Narrows ADR-019 to the Claude product; keeps ADR-017.
status: accepted
normative: true
date: 2026-09-21
superseded_in_part_by: [ADR-024]
---

> Implements Roxabi/roxabi-plugins#488.
>
> Extends the ADR-018 amendment (2026-08-24) from the back half to the whole cycle.
> **Narrows ADR-019** to the Claude/Grok product — the `R-pr` falsify oracle is not
> part of the OMP product. [ADR-024](024-one-goal-per-epic.md) does not restore it.
> **Keeps ADR-017** — the principal freeze is the reason parallel features are
> possible at all.
>
> **Amended 2026-09-24 by [ADR-024](024-one-goal-per-epic.md)** — §3, §4, §8 and §9
> no longer bind as written. Autonomy is an epic goal; the change contract is proof,
> not a second spec; assertledger is a separate gate where an adapter exists, and
> does not restore the `R-tester` falsify gate; the agent creates the worktree
> from a fresh `refs/remotes/origin/<base>`.

## Context

`dev-core` is a factory: 37 `SKILL.md`, 10 agents, a TS/hook/CLI/doctor surface, and
`/R-dev` as the orchestrator that `Skill()`s its children. On OMP the factory was
never what the host consumed: under Isolation only `package.json#omp.extensions`
loads, so the live surface was three guards plus a hardcoded 7-name slash allowlist
(`SKILL_COMMANDS` in `plugins/dev-core/omp/index.ts`). The other 30 skills stayed
dark, and `omp-build` already owned the back half (`/build`).

Meanwhile the operator's OMP session already carries the Matt Pocock skill set
through `skills.customDirectories`, with `tdd`, `code-review`, and `research`
ignored. That set answers the front half — interview, spec, tickets — with a flow
Matt maintains upstream. Two orchestrators for one cycle is the duplication this
ADR removes.

Three measurements set the boundaries (omp v18.2.6, 2026-09-21):

- `feature` is not a builtin slash name, so `registerCommand("feature")` is not
  silently skipped. `wt` (alias `worktree`) **is** builtin.
- `omp worktree add -b <branch> <path>` creates ω and leaves the source HEAD alone;
  `/wt` additionally moves the session into it.
- `applyCwdChange` lives on the interactive-mode controller, reached through
  `session.switchSession({ onCwdChange })`. It is **not** in the documented
  `ExtensionCommandContext`. The in-session hop is therefore unproven.

## Options Considered

### Option A: Trim `dev-core` in place, keep it on OMP

Drop the unused skills and agents from the installed plugin; keep `/R-dev`.

- **Pros:** one plugin; no snapshot; no divergence.
- **Cons:** the trim lands in the plugin Claude also ships, so every OMP-driven
  deletion is a Claude regression. `/R-dev`'s children are exactly what OMP does not
  load, so the orchestrator stays a hollow router. Does not remove the second
  orchestrator.

### Option B: Move the factory into `omp-build` and keep it in sync

Relocate the keep-list, then resync from `dev-core` as it evolves.

- **Pros:** one live source per file; Claude improvements reach OMP.
- **Cons:** a sync obligation with no enforcement — the copy-sync governance retired
  with ADR-014 is exactly this shape. Two hosts with divergent needs share one file
  and both get vetoes.

### Option C: `/feature` on the Matt base, snapshot freeze, two plugins (chosen)

`omp-build` owns delivery; `issue-triage` owns the tracker; `dev-core` is uninstalled
from OMP and untouched as source. The absorbed files are a frozen snapshot.

- **Pros:** one orchestrator per host. The front half is maintained upstream by Matt.
  The Roxabi differentiators that measurably beat the alternative — the multi-domain
  review and the native tracker links — are the only things we keep carrying.
- **Cons:** permanent divergence between the OMP snapshot and Claude's `dev-core`. A
  fix to `R-dev-review` has to be applied twice or consciously not.

## Decision

Adopt **Option C**.

1. **Host split.** OMP delivery = `omp-build` (delivery) + `issue-triage` (tracker).
   `dev-core` is uninstalled from the live machine and dropped from `extensions:`.
   Its source stays in the marketplace for Claude/Grok, unmodified.

2. **Absorb mode = snapshot freeze.** Absorbed files are copied once and never
   resynced. `dev-core` is the Claude product; the snapshot is the OMP product. A
   shared fix is applied twice, deliberately, or not at all.

3. **One orchestrator: `/feature`.** A `registerCommand`, slash-only, two modes.
   Mode 1 (no ticket): `grill-with-docs` → `to-spec` → `to-tickets`, then stop at the
   frontier. Mode 2 (ticket, inside ω): `implement` → `R-dev-review` → `R-fix` → land
   → optional tail. `/build` and the `/R-dev` factory both die on OMP.

4. **Spec home = the tracker issue.** `to-spec` publishes; `to-tickets` splits into
   tracer bullets. `artifacts/specs/{N}-*-spec.md` and the `status: validated` gate
   are retired on OMP — `grill-with-docs` already owns the HITL turn.

5. **TDD is a posture, not a step.** Matt `tdd` is un-ignored and stays
   model-invoked, driven by `implement`. It is never a slash of `/feature`. Matt
   `code-review` stays ignored: `R-dev-review` replaces it.

6. **Ticket links and tier belong to `issue-triage`.** Relations are native GitHub
   sub-issues and dependencies written through its CLI, never a `Blocked by:` text
   line. Deferred findings follow its sibling rule. Because decision 4 removes the
   spec frontmatter, the tracker issue's `size:` label becomes the **only** source of
   τ, so `to-tickets` must write it or every review defaults to `F-lite`. We author
   `docs/agents/issue-tracker.md` so the Matt skills route through this CLI.

7. **The review panel is five roles.** `R-adversarial` (floor), `R-security-auditor`,
   `R-architect`, `R-devops`, `R-tester`. `R-frontend-dev`, `R-backend-dev`, and
   `R-fixer` are dropped; their concerns fall to the floor by the existing
   sibling-drop rule, and `R-fix` applies inline. The roster's FE/BE scoring axis and
   the `dev-core:`-prefixed agent name map are rewritten, not trimmed.

8. **The falsify oracle leaves the OMP product.** `R-pr` is not absorbed, so nothing
   writes `artifacts/reviews/{N}-falsify.json`; the `R-tester` two-step gate is cut
   and the role arms on `delta_test_hit` alone. ADR-019 remains in force for
   Claude/Grok, where the producer (`/R-dev-implement` Step 6b) still exists. A gate
   whose producer is gone is a permanent `false`, not a control.

9. **Isolation stays ω; the hop is spiked, not assumed.** `/wt` is the native hop and
   `omp-wt` leaves the contract. Because `applyCwdChange` is not extension-facing,
   the in-session hop ships **with** its fallback in the same slice: create ω, print
   the `/wt` line, stop. The ADR-017 guards are ported as-is — the freeze is what
   makes parallel worktrees safe, and it is the reason the guards survive a cut whose
   stated goal was minimalism.

## Consequences

### Positive

- One orchestrator per host; the "two pipelines, one cycle" duplication is gone.
- The front half is maintained upstream; our carrying cost is the review and the
  tracker, the two places we measured a real advantage.
- Delivery and tracker are separate plugins with disjoint domains, so neither owns
  the other's vocabulary.

### Negative

- Permanent divergence. `R-dev-review`, `R-fix`, `cleanup`, and `promote` exist twice
  with no drift detection. A future ADR may retire the Claude copies; this one does
  not.
- Adopting the Matt base means adopting its context hygiene (`/clear` between
  tickets). The frontier stop is the assisted case — no Epic goal. Under an
  Epic goal, [ADR-024](024-one-goal-per-epic.md) §3 replaces it.
- The OMP product loses the `R-pr` falsify oracle (`oracle_ok`,
  `artifacts/reviews/{N}-falsify.json`). Test quality on that gate rests on `tdd`
  plus `R-tester` judgement. [ADR-024](024-one-goal-per-epic.md) does not restore
  that oracle; assertledger, where an adapter exists, is a separate gate.

### Named residuals

- The in-session cwd hop may turn out to be unreachable from an extension. In
  the assisted case the fallback is the steady state, and `/feature` costs one
  relaunch per feature. An Epic goal is not that case.
- Setup skills (`R-dev-init`, `R-env-setup`, `R-stack-setup`, `R-ci-setup`,
  `R-release-setup`, `R-seed-docs`, `R-seed-community`) are **parked**, not decided.
  Until that pass, OMP has no project-init surface.

## Refuse list

- Do not resync the snapshot with `dev-core`.
- Do not copy the `issue-triage` mutations into `omp-build`.
- Do not reintroduce `artifacts/specs` frontmatter as a second spec home.
- Do not add a second worktree CLI beside `/wt`.
- Do not restore the `R-tester` falsify gate without its producer.
- Do not make `tdd` a step of `/feature`.

## References

- Issue #488 · Glossary `plugins/omp-build/CONTEXT.md`
- ADR-017 (principal freeze) · ADR-018 (skill homes, 2026-08-24 amendment) ·
  ADR-019 (falsify oracle — Claude product only) ·
  [ADR-024](024-one-goal-per-epic.md) (amends §3, §4, §8, §9)
- `plugins/dev-core/omp/index.ts` (`SKILL_COMMANDS`, guards)
- `plugins/dev-core/skills/dev-review/roster.ts` (`DISPATCHABLE`, FE/BE scoring)
- `plugins/issue-triage/skills/shared/queries.ts` (`addSubIssue`, `addBlockedBy`)

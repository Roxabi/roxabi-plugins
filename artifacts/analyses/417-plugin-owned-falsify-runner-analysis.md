---
title: "Control quality: plugin-owned falsify runner (markdown is a report)"
description: "Executable falsify oracle + shared skip helper + claim-axis roster — replace parse-falsify-as-oracle after #416."
type: analysis
status: approved
---

## Source

Issue [#417](https://github.com/Roxabi/roxabi-plugins/issues/417) — architectural follow-up to #415/#416 and kit motivation from `roxabi-boilerplate-cf#101`.

**This α = claims (1)(2)(3) in `roxabi-plugins` only.** Claims (4)(5)(6) stay in boilerplate (blocked on a generic runner from (1)). Kit is motivation, not in-scope deliverable.

Frame: `artifacts/frames/417-plugin-owned-falsify-runner-frame.md` (approved).

## Problem

After #416, “falsify ok” is still **document-shaped**: `/implement` 6b may run stash or a consumer script, then persists `artifacts/reviews/{N}-falsify.md`; `/pr` and `/code-review` tester-skip call `parse-falsify.sh`, which greps matrix status + `broke … → …` tokens + file reality. Parser-ok can skip the tester without an executable re-verify. Roster spawn still keys off **filename globs** (`scripts/`, `**/auth/**`, …) for several agents — wrong axis for priced fail-closed / authz / SSoT claims.

Priced quantity is declared in `/spec`; the control measures report hygiene. Two `/fix` rounds stacked more proxies. Matcher patches will not close the gap.

## Outcome

Observable control-quality end-state (method open — stash **or equivalent**):

1. **Oracle** — for τ≠S mapped unit/fast-integration rows, “proven” exists only when executable evidence shows tests **fail** with priced source absent and **pass** when restored.
2. **One skip helper** — `/implement` 6b, `/pr`, and `/code-review` tester-skip share **one** `oracle_ok` / `falsify_run_ok` source. Parser-ok alone must not skip tester or clear `/pr`.
3. **Roster axis** — control-relevant spawn (tester / security-class / adversarial density) keys off **priced claim of the diff** (fail-closed / authz / SSoT) or adversarial-only — not path globs for that concern. Structural devops/architect triggers may stay path-based unless a priced substitute lands.

Markdown (`*-falsify.md`) is a **report** of the run, never the pass oracle. Kit calling the runner later is a non-blocking enablement signal, ¬ this-cycle AC.

## Appetite

One F-full cycle. Prefer cut order if overflow: **(1)+(2) first**, roster axis (3) second. Kit consumption of the runner is **out of appetite**.

## Shapes

**Diagram:** [Falsify oracle shapes](../visuals/417-plugin-owned-falsify-runner-shapes.html)

### Shape 1: Plugin runner owns oracle; parser is report-only (recommended)

Ship a plugin-owned executable helper (`run-falsify` under `plugins/dev-core`, path TBD) that, given the SC→test map + source list:

1. Isolates mutation (prefer **temp worktree / copy at HEAD**, ¬repo-global `git stash` as the shared API).
2. Runs mapped unit/fast-integration tests → assert FAIL → restore → assert PASS.
3. Writes **machine JSON** (`artifacts/reviews/{N}-falsify.json`: schema version, HEAD, per-row exits/errors, `runner_id`) and optionally renders markdown from it.

Gates: `/pr` refuse and tester-skip require **verify of JSON / runner exit** (`oracle_ok`). `parse-falsify.sh` stays as optional report hygiene or shrinks — **never sole skip/pass input**. Consumer `test:falsify` may remain an optional fast-path **only if** it delegates to the same helper (else stub-refuse).

Roster (claim 3): spawn control agents from priced claims in spec∩Δ (or adversarial-only); do not blindly delete structural `scripts/`/CI globs for architect/devops without a substitute.

**Trade-offs:**
- Pro: closes (1)(2); unblocks kit invoke-by-path later; kills dual oracle.
- Con: isolation + monorepo `test_cmd` wiring; flaky tests fail-closed.

**Rough scope:** L

### Shape 2: Harden document oracle (JSON sidecar; parse still gate)

Keep markdown (+ sidecar) as what `/pr` and tester-skip trust; extend `parse-falsify.sh` further.

**Trade-offs:**
- Pro: smaller skill diff.
- Con: still document-shaped; kit cannot import a real runner; repeats #416 proxy stack. **Eliminated by frame failure mode.**

**Rough scope:** M — **killed**

### Shape 3: Export thin CLI; skills keep LLM stash path

Publish a callable CLI for boilerplate; leave implement/pr/cr on stash + parse.

**Trade-offs:**
- Pro: unblocks kit surface early.
- Con: claim (2) stays open (dual paths); skills still treat report as oracle. **Interim only — reject as primary.**

**Rough scope:** M — **not recommended**

## Fit Check

**Diagram:** [Recommended oracle data flow](../visuals/417-plugin-owned-falsify-runner-data-flow.html)

| Constraint / claim | Shape 1 | Shape 2 | Shape 3 |
|--------------------|---------|---------|---------|
| (1) Executable oracle | ✓ | ✗ doc | partial CLI |
| (2) One skip helper | ✓ single JSON verify | ✗ parse-ok | ✗ dual |
| (3) Claim-axis roster | ✓ in scope | optional | optional |
| Markdown = report only | ✓ | ✗ | ✗ for skills |
| ¬ denylist/token race | ✓ | ✗ more parse | — |
| Kit 4–6 this cycle | N/A | N/A | N/A |

**Fit:** Shape 1. Shape 2 eliminated (frame). Shape 3 rejected as primary (leaves dual oracle). Isolation default = temp tree / trap-backed backup; ADR before spec for schema + gate boolean graph.

## Files impacted

| Path | Role |
|------|------|
| `plugins/dev-core/skills/pr/run-falsify.sh` (or sibling) | new executable oracle |
| `plugins/dev-core/skills/pr/parse-falsify.sh` | demote to report hygiene / retire as gate |
| `plugins/dev-core/skills/implement/SKILL.md` | 6b invokes runner; matrix `✓ proven` from JSON |
| `plugins/dev-core/skills/pr/SKILL.md` + `gather-state.sh` | gate on `oracle_ok` |
| `plugins/dev-core/skills/code-review/SKILL.md` | tester-skip = verify JSON; roster claim axis |
| `plugins/dev-core/skills/test/SKILL.md` + `validate/SKILL.md` | align falsify candidate order |
| `plugins/dev-core/agents/tester.md` | evidence contract |
| ADR under `docs/architecture/adr/` | oracle ownership + schema + isolation |

¬boilerplate files in this cycle.

## Expert review (folded)

- **architect:** Shape 1 good; prefer temp isolation over stash; encode `oracle_ok` via runner-written JSON + verify; scope roster claim to control agents (¬blind-delete devops path globs); ADR before spec.
- **product-lead:** Outcome rewritten to observables (¬prescribe stash); kit call = enablement ¬ AC; cut order (1)(2) then (3).
- **doc-writer:** Source fence (1)(2)(3); rename skip API vs matrix `✓ proven`; shapes state parse-falsify fate.

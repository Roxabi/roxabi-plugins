---
title: "Control quality: plugin-owned falsify runner (markdown is a report)"
description: "Executable run-falsify oracle, sole oracle_ok gate, claim-axis roster deferred-safe — Shape 1 from #417 analysis."
type: spec
status: approved
---

## Context

**Promoted from:** [Control quality: plugin-owned falsify runner](../analyses/417-plugin-owned-falsify-runner-analysis.md) (Shape 1, approved)  
**Frame:** [417-plugin-owned-falsify-runner-frame.md](../frames/417-plugin-owned-falsify-runner-frame.md)  
**GitHub issue:** #417  
**ADR:** lands **before** runner/gate code (U6 before U1 merge). Records oracle ownership, isolation, JSON schema v1, gate boolean graph.

**Scope fence:** claims **(1)(2)** in V1; claim **(3)** roster = V2 only. Claims (4)(5)(6) = `roxabi-boilerplate-cf` — out.

**Non-goals:** kit bar · `classifyOrigin` · kit CP-FALSIFY · deleting structural path globs in V1 · claiming (3) done in V1.

**Adversarial fold:** forged JSON must not pass; `falsify_ok` / parse-only leave the gate graph; empty / all-exempt maps must not be “proven”; roster must not over-cut path triggers without a classifier.

## Intent

#416 made falsify mechanically *parseable*, but the control still measures **document shape**. `/pr` and `/code-review` tester-skip can clear on `parse-falsify.sh` → `falsify_ok=true` without an executable fail→restore→pass of mapped unit/fast-integration tests.

## Goal

For τ≠S work in this marketplace, `/pr` refuse and tester-skip are driven only by an executable plugin falsify verify (`oracle_ok`); markdown is a report; parser-ok alone never clears a gate.

## Users

- **Primary:** as a dev-core maintainer running `/implement` → `/pr` → `/code-review`, I want gates to require real falsify runs so forged markdown cannot skip the tester.
- **Secondary:** kit authors who will later invoke the same runner (enablement ¬ AC here).

## Expected Behavior

**Write path (τ≠S):**
1. `/implement` builds SC→Test matrix (unit/FI only; e2e stays `⚠ NO FALSIFY — e2e`).
2. Invokes plugin `run-falsify` at `plugins/dev-core/skills/pr/run-falsify.sh` with the map + source paths.
3. Runner isolates via **canonical API = temp worktree / copy at HEAD** (¬repo-global `git stash`). Trap-backed in-place backup allowed only as an impl detail with restore guarantee — not the public API.
4. Runs each mapped test with sources absent → must FAIL, restores → must PASS; writes `artifacts/reviews/{N}-falsify.json`; optionally renders `*-falsify.md` from JSON.
5. Matrix row `✓ proven` only from runner row results.

**Gate path:**
6. `/pr` and `/code-review` tester-skip call `run-falsify --verify <json>`, which **always re-runs** fail→restore→pass for mapped rows. Schema-parse of a pre-written green JSON alone → ¬`oracle_ok`. Cost: accept up to 2–3× (implement + pr + review); plan may add same-`head` session cache later — not a receipt-only bypass.
7. Sole gate boolean for refuse/skip: **`oracle_ok`**. Remove `falsify_ok` from gather-state / skip / refuse (incl. code-review tester path). `parse-falsify.sh` may remain as ungated md lint.
8. Hand-crafted / LLM green JSON → verify fails → `/pr` REFUSE ∧ tester **spawned**.

**Empty / all-exempt map:**
9. If τ≠S and **≥1** priced SC maps to unit/FI (¬e2e-exempt) → zero FAIL→PASS rows ⇒ `oracle_ok=false` (preserve `no-proven-row`).
10. If τ≠S and **zero** unit/FI mapped rows (all e2e / `NO FALSIFY` / `NO TEST` exempt) ⇒ `oracle_ok=false` as well (all-exempt is not proven). Explicit product skip for “no falsifiable surface” is a future χ — not green.

**Roster (V2 only):**
11. V1 **keeps** structural path triggers for architect/devops/security-auditor (`scripts/`, `**/auth/**`, …).
12. V2: control-agent spawn from structured SC `claim: [fail-closed|authz|ssot]` ∩ Δ; missing tags on control-shaped Δ → fail-closed spawn. Path globs retained until classifier proven. V2 priced SCs land in a follow-on — ¬claimed done here.

**Consumer `test:falsify`:** drop as alternate oracle this cycle unless it execs the plugin helper as child and cannot swallow non-zero; else stub-refuse.

## Data Model & Consumers

### Data Structure

`artifacts/reviews/{N}-falsify.json` (`schema_version: "1"`):

| Field | Notes |
|-------|--------|
| `schema_version` | `"1"` |
| `issue` | N |
| `head` | `git rev-parse HEAD` at run |
| `runner_id` | plugin helper identity |
| `rows[]` | see below |
| `oracle_ok` | bool — true iff every required unit/FI-mapped priced SC has a `proven` row; false on empty/all-exempt (rules 9–10) |

`rows[]` entry:

| Field | Notes |
|-------|--------|
| `sc_id` | SC identifier |
| `sources[]` | repo-relative paths |
| `source_hashes` | required when verify checks Δ ∩ sources |
| `test_cmd` | exact command run |
| `fail_exit` / `pass_exit` | ints |
| `error` | failure token from fail phase |
| `status` | `proven` \| `failed` \| `error` \| `skipped_e2e` |

Markdown `*-falsify.md` = optional render. Not a gate input.

### Consumers

| Consumer | Fields | When | Status |
|----------|--------|------|--------|
| `/implement` 6b | writes JSON (+ optional md) | after matrix | V1 |
| `/pr` gather-state | `oracle_ok` via `--verify` | pre-create | V1 |
| `/code-review` tester skip | `oracle_ok` via `--verify` | dispatch | V1 |
| `parse-falsify.sh` | md lint only | optional | Demoted V1 |
| Kit / boilerplate | invoke runner | later | Out |

## Breadboard

### Runner

| ID | Element | Handler | Data |
|----|---------|---------|------|
| S1 | `run-falsify` CLI | `skills/pr/run-falsify.sh` | temp tree + test runner |
| S2 | `--verify` mode | same helper | full re-exec → `oracle_ok` |
| N1 | write `*-falsify.json` | S1 | `artifacts/reviews/` |
| N2 | render `*-falsify.md` | optional from N1 | report only |

### Skills / gates

| ID | Element | Handler | Data |
|----|---------|---------|------|
| U1 | `/implement` Step 6b | invoke S1 | matrix → N1 |
| U2 | `/pr` refuse rail | S2 → `oracle_ok` | gather-state |
| U3 | `/code-review` tester skip | S2 → `oracle_ok` | skip table |
| U4 | Remove `falsify_ok` gate key | gather-state + SKILL.md + code-review | — |
| U5 | Roster claim tags + spawn | `/spec` template + `/code-review` | SC YAML |
| U6 | ADR | `docs/architecture/adr/` | decisions |

### Wiring

U6 before U1 merge. U1 → S1 → N1 (N2 optional). U2/U3 → S2(N1) → sole `oracle_ok`. U4 deletes parallel path. U5 = V2 only.

## Slices

| # | Name | Scope (IDs) | Demo criteria |
|---|------|-------------|---------------|
| V1 | Oracle + sole gate | S1, S2, N1, U1–U4, U6 (N2 optional) | Forged JSON fails verify; parse-ok alone cannot clear `/pr` or skip tester; empty/all-exempt ¬proven; public API ¬stash |
| V2 | Claim-axis roster | U5 | Claim tags ∩ Δ drive control spawn; path globs retained until classifier green; priced SCs in follow-on |

## Success Criteria

- [ ] ADR merged **before** runner/gate implementation, documenting: oracle ownership (plugin runner), isolation (temp worktree canonical), JSON schema v1, gate boolean graph (`oracle_ok` sole refuse/skip; parse demoted).
- [ ] `plugins/dev-core/skills/pr/run-falsify.sh` performs fail-under-absent → pass-under-restore for mapped unit/FI tests and writes `artifacts/reviews/{N}-falsify.json`.
- [ ] `/implement` Step 6b invokes that helper as the default oracle; consumer `test:falsify` is not an alternate oracle unless it execs the helper without swallowing non-zero.
- [ ] Matrix `✓ proven` is set only from runner row results.
- [ ] `/pr` REFUSEs when `oracle_ok` is false after `--verify` (τ≠S).

```yaml
claim: [fail-closed]
priced:  "τ≠S PR create requires executable falsify verify success (oracle_ok)"
not:     "parse-falsify.sh returns falsify_ok=true on markdown tokens / forged JSON schema-only"
oracles:
  - "hand-crafted green *-falsify.json with valid schema → --verify fails → /pr REFUSE"
  - "parse-falsify ok ∧ JSON missing/bad → /pr REFUSE"
  - "zero FAIL→PASS rows while τ≠S has any unit/FI-mapped priced SC → /pr REFUSE"
  - "all-exempt matrix (no unit/FI rows) at τ≠S → /pr REFUSE"
  - "JSON.head ≠ git rev-parse HEAD at gate → /pr REFUSE"
  - "priced source path in Δ absent from JSON rows → /pr REFUSE"
```

- [ ] `/code-review` skips tester **only** when `--verify` yields `oracle_ok=true`; otherwise tester is spawned.

```yaml
claim: [fail-closed]
priced:  "tester skip iff executable verify says oracle_ok"
not:     "tester skip iff parse-falsify.md hygiene passes"
oracles:
  - "forged JSON → tester spawned"
  - "parse-ok ∧ ¬oracle_ok → tester spawned"
```

- [ ] No skill refuse/skip path keys solely on `falsify_ok` / md parse after V1 (gather-state emits `oracle_ok` only for that concern).

```yaml
claim: [fail-closed]
priced:  "sole gate boolean for falsify refuse/skip is oracle_ok"
not:     "OR-fallback oracle_ok ∨ falsify_ok"
oracles:
  - "any refuse/skip still conditioned on falsify_ok alone → suite red"
```

- [ ] Public runner API is not repo-global `git stash` (temp worktree/copy at HEAD).
- [ ] V1 does not delete structural path triggers for architect/devops/security-auditor; claim (3) is **not** marked done in V1 (V2 / follow-on).
- [ ] Kit bar / `classifyOrigin` / kit CP-FALSIFY are not implemented in this PR.

## Open Questions

none — path = `skills/pr/run-falsify.sh`; `--verify` = full re-exec; isolation canonical = temp worktree; all-exempt = ¬`oracle_ok`.

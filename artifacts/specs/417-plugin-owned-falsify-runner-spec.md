---
title: "Control quality: plugin-owned falsify runner (markdown is a report)"
description: "Executable run-falsify oracle, sole oracle_ok gate, claim-axis roster deferred-safe — Shape 1 from #417 analysis."
type: spec
status: draft
---

## Context

**Promoted from:** [Control quality: plugin-owned falsify runner](../analyses/417-plugin-owned-falsify-runner-analysis.md) (Shape 1, approved)  
**Frame:** [417-plugin-owned-falsify-runner-frame.md](../frames/417-plugin-owned-falsify-runner-frame.md)  
**GitHub issue:** #417  
**ADR (this cycle):** record oracle ownership, isolation method, JSON schema, and the gate boolean graph before implement.

**Scope fence:** claims **(1)(2)(3)** in `roxabi-plugins` only. Claims (4)(5)(6) = `roxabi-boilerplate-cf`, blocked on (1) — out of this spec.

**Adversarial fold (pre-spec):** forged JSON must not pass; `falsify_ok` / parse-only must leave the gate graph; empty maps must not be “proven”; roster (3) must not claim done while path triggers are deleted without a classifier.

## Intent

#416 made falsify mechanically *parseable*, but the control still measures **document shape**. `/pr` and `/code-review` tester-skip can clear on `parse-falsify.sh` → `falsify_ok=true` without an executable fail→restore→pass of mapped unit/fast-integration tests. Matcher patches (#416 `/fix` rounds) will not close that hole.

## Goal

For τ≠S work in this marketplace, `/pr` refuse and tester-skip are driven only by an executable plugin falsify run (`oracle_ok`); markdown is a report; parser-ok alone never clears a gate.

## Users

- **Primary:** dev-core maintainers running `/implement` → `/pr` → `/code-review`.
- **Secondary:** kit authors who will later invoke the same runner (enablement ¬ AC here).

## Expected Behavior

**Write path (τ≠S):**
1. `/implement` builds SC→Test matrix (unit/FI only; e2e stays `⚠ NO FALSIFY — e2e`).
2. Invokes plugin `run-falsify` (path under `plugins/dev-core/skills/pr/` or sibling — χ if rename) with the map + source paths.
3. Runner isolates (prefer **temp worktree / copy at HEAD**; ¬repo-global `git stash` as the shared API), runs each mapped test with sources absent → must FAIL, restores → must PASS, writes `artifacts/reviews/{N}-falsify.json`, optionally renders `*-falsify.md` from JSON.
4. Matrix row becomes `✓ proven` only from runner output for that row.

**Gate path:**
5. `/pr` and `/code-review` tester-skip call `run-falsify --verify <json>` (or equivalent) which **re-executes** the falsify contract for the mapped rows (or fails closed). Schema-parse of a pre-written green JSON alone → ¬`oracle_ok`.
6. Sole gate boolean for refuse/skip: **`oracle_ok`**. `falsify_ok` from `parse-falsify.sh` is removed from gather-state / skip / refuse branches (parse may remain as optional md lint with no gate key).
7. Hand-crafted or LLM-authored green JSON → verify re-run fails or refuses → `/pr` REFUSE ∧ tester **spawned**.

**Roster (Slice V2):**
8. Until a priced-claim classifier ships, **keep** existing structural path triggers for architect/devops/security-auditor. Do **not** delete `**/auth/**` (etc.) in V1.
9. V2: control-agent spawn keys off structured claim tags on SCs (`claim: [fail-closed|authz|ssot]`) ∩ Δ; missing tags on control-shaped Δ → fail-closed spawn (adversarial + security-class), not skip. Path globs retained until classifier proven.

**Consumer `test:falsify`:** optional this cycle only if it execs the plugin helper as child and cannot swallow non-zero; otherwise **drop fast-path** and always call plugin runner. Stub wrappers → stub-refuse.

## Data Model & Consumers

### Data Structure

`artifacts/reviews/{N}-falsify.json` (mutable per run; schema_version frozen):

| Field | Notes |
|-------|--------|
| `schema_version` | string, start `1` |
| `issue` | N |
| `head` | `git rev-parse HEAD` at run |
| `runner_id` | plugin helper identity/version |
| `rows[]` | `{ sc_id, sources[], source_hashes? , test_cmd, fail_exit, pass_exit, error, status }` |
| `oracle_ok` | bool — true iff every required priced unit/FI SC has a row with fail≠0 under absent ∧ pass=0 under restore; **false** if zero such required rows while τ≠S priced unit/FI SCs exist |

Markdown `*-falsify.md` = render of JSON. Not an input to gates.

### Consumers

| Consumer | Fields | When | Status |
|----------|--------|------|--------|
| `/implement` 6b | writes JSON (+ optional md) | after matrix | This issue (V1) |
| `/pr` gather-state | `oracle_ok` via `--verify` | pre-create | This issue (V1) |
| `/code-review` tester skip | `oracle_ok` via `--verify` | dispatch | This issue (V1) |
| `parse-falsify.sh` | md lint only | optional | Demoted (V1) |
| Kit / boilerplate | invoke runner | later | Future (out) |

## Breadboard

### Runner

| ID | Element | Handler | Data |
|----|---------|---------|------|
| S1 | `run-falsify` CLI | bash helper under `plugins/dev-core/skills/pr/` | temp tree + test runner |
| S2 | `--verify` mode | same helper | re-exec → `oracle_ok` |
| N1 | write `*-falsify.json` | S1 | `artifacts/reviews/` |
| N2 | render `*-falsify.md` | optional from N1 | report only |

### Skills / gates

| ID | Element | Handler | Data |
|----|---------|---------|------|
| U1 | `/implement` Step 6b | invoke S1 | matrix → N1 |
| U2 | `/pr` refuse rail | S2 → `oracle_ok` | gather-state |
| U3 | `/code-review` tester skip | S2 → `oracle_ok` | skip table |
| U4 | Remove `falsify_ok` gate key | gather-state + SKILL.md | — |
| U5 | Roster claim tags + spawn | `/spec` template + `/code-review` | SC front YAML | V2 |
| U6 | ADR | docs/architecture/adr/ | decisions |

### Wiring

U1 → S1 → N1 → (N2). U2/U3 → S2(N1) → sole `oracle_ok`. U4 deletes parallel path. U5 after V1. U6 before or with V1 implement.

## Slices

| # | Name | Scope (IDs) | Demo criteria |
|---|------|-------------|---------------|
| V1 | Oracle + sole gate | S1, S2, N1, N2, U1–U4, U6 | Forged JSON fails verify; parse-ok alone cannot clear `/pr` or skip tester; empty map ¬proven; stash not shared API |
| V2 | Claim-axis roster | U5 | Control spawn from SC `claim:` tags ∩ Δ; path globs for security retained until classifier green |

## Success Criteria

- [ ] ADR exists documenting: oracle ownership (plugin runner), isolation (temp tree preferred), JSON schema v1, gate boolean graph (`oracle_ok` sole refuse/skip; parse demoted).
- [ ] Plugin `run-falsify` executable ships under `plugins/dev-core` and performs fail-under-absent → pass-under-restore for mapped unit/FI tests, writing `artifacts/reviews/{N}-falsify.json`.
- [ ] `/implement` Step 6b invokes the plugin runner as the default oracle (consumer `test:falsify` only if it execs the helper without swallowing non-zero; else removed as oracle path).
- [ ] Matrix status `✓ proven` is set only from runner row results (not from markdown authorship alone).
- [ ] `/pr` REFUSEs when `oracle_ok` is false after `--verify` (τ≠S).

```yaml
priced:  "τ≠S PR create requires executable falsify verify success (oracle_ok)"
not:     "parse-falsify.sh returns falsify_ok=true on markdown tokens / forged JSON schema-only"
oracles:
  - "hand-crafted green *-falsify.json with valid schema → --verify fails → /pr REFUSE"
  - "parse-falsify ok ∧ JSON missing/bad → /pr REFUSE"
  - "oracle_ok with 0 FAIL→PASS rows while τ≠S priced unit/FI SCs exist → /pr REFUSE"
  - "JSON.head ≠ git rev-parse HEAD at gate → /pr REFUSE"
  - "priced source path in Δ absent from JSON rows → /pr REFUSE"
```

- [ ] `/code-review` skips tester **only** when `--verify` yields `oracle_ok=true`; otherwise tester is spawned.

```yaml
priced:  "tester skip iff executable verify says oracle_ok"
not:     "tester skip iff parse-falsify.md hygiene passes"
oracles:
  - "forged JSON → tester spawned"
  - "parse-ok ∧ ¬oracle_ok → tester spawned"
```

- [ ] No skill refuse/skip path keys solely on `falsify_ok` / md parse after V1 (gather-state emits `oracle_ok` only for that concern).

```yaml
priced:  "sole gate boolean for falsify refuse/skip is oracle_ok"
not:     "OR-fallback oracle_ok ∨ falsify_ok"
oracles:
  - "grep/skills still conditioning refuse/skip on falsify_ok alone → suite red"
```

- [ ] Empty / all-exempt map cannot yield `oracle_ok=true` when τ≠S priced unit/FI SCs exist (preserve fail-closed `no-proven-row` semantics).
- [ ] Isolation: shared API is not repo-global `git stash` (temp worktree or trap-backed in-place backup with restore guarantee).
- [ ] V1 does **not** delete structural path triggers (`scripts/`, `**/auth/**`, …) for architect/devops/security-auditor; V2 either ships claim classifier + retention until proven, or Fit/AC mark roster deferred — ¬claim (3) fixed in V1 alone.
- [ ] Kit bar / `classifyOrigin` / kit CP-FALSIFY are not implemented in this PR.

## Open Questions

- [NEEDS CLARIFICATION: exact filesystem path/name for `run-falsify` under `skills/pr/` vs `skills/shared/` — default `skills/pr/run-falsify.sh` unless plan says otherwise]
- [NEEDS CLARIFICATION: `--verify` always full re-exec vs receipt that still requires helper process in-gate — default **full re-exec** (adversarial SC1)]

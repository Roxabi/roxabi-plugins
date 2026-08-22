---
title: "Plan: Control quality: claim-axis /code-review roster (V2 of #417)"
issue: 419
spec: artifacts/specs/419-claim-axis-code-review-roster-spec.md
complexity: 5/10
tier: F-lite
generated: "2026-08-22T08:55:00+02:00"
---

## Summary

Ship structured `claim:` on priced YAML fences, extend `priced_ok` parse (all fences), add S1 `claim-roster` spawn oracle, wire `/code-review` When+Skip+README parity, deterministic σ resolver in Phase 2, unconditional path-glob retention test. Migrate legacy spec fences (417) with `claim:` tags.

## Architecture

### Data Flow

approved σ → `pf_parse_priced` (claim validate) → `priced_ok` @ `/pr`  
Δ + σ → `claim-roster` → `{spawn_security_auditor, priced_claim_ok}` → Phase 3 dispatch (global, not per-chunk)

### File x Function Map

| File | Role |
|------|------|
| `skills/spec/references/templates.md` + `spec/SKILL.md` | U1 docs |
| `skills/pr/parse-falsify.sh` | U2 all-fence claim parse |
| `skills/code-review/claim-roster.ts` + `.sh` | S1 spawn oracle |
| `skills/code-review/SKILL.md` + README | U3 When/Skip/Phase 2 |
| `skills/code-review/__tests__/claim-roster.test.ts` | S1 fixtures |
| `skills/code-review/__tests__/glob-retention.test.ts` | U4 retention |
| `artifacts/specs/417-*-spec.md` | migration claim tags |

## Agents

| Agent | Tasks | Files |
|-------|-------|-------|
| doc-writer | 2 | spec template/SKILL, code-review SKILL/README |
| backend-dev | 3 | claim-roster.ts, parse-falsify extend, Phase 2 resolver helper |
| tester | 3 | claim-roster tests, glob retention, parse-falsify claim tests |

## Wave Structure

| Wave | Agents | Tasks |
|------|--------|-------|
| 1 | backend-dev ∥ doc-writer | T1–T2 ∥ T3 |
| 2 | backend-dev | T4–T5 |
| 3 | doc-writer ∥ tester | T6 ∥ T7–T9 |
| 4 | tester | T10 |

## Task IDs

- T1: Extend `pf_parse_priced` — scan all YAML fences with `priced:`; require valid `claim` list → backend-dev
- T2: Implement `claim-roster.ts` + `claim-roster.sh` (JSON, exit 0/2, spawn rules) → backend-dev
- T3: Document `claim:` in spec template + spec SKILL → doc-writer
- T4: Extend code-review Phase 2 — PR-linked σ resolver + draft reject → backend-dev
- T5: Wire code-review Phase 3 — invoke S1; update When + Skip + agent-map to `spawn_security_auditor` → doc-writer + backend-dev
- T6: Update code-review README spawn table parity → doc-writer
- T7: Tests — claim-roster fixtures (spawn, fail-closed invalid claim, path_hit) → tester
- T8: Tests — glob retention greps When cells → tester
- T9: Tests — parse-falsify claim validation (all fences, ssot-only) → tester
- T10: Migration — add `claim:` to 417 spec priced fences + grep repo specs → doc-writer

### Task 1: Extend pf_parse_priced for claim on all priced fences
- **File:** `plugins/dev-core/skills/pr/parse-falsify.sh`
- **Verify:** `cd plugins/dev-core && bunx vitest run skills/pr/__tests__/parse-falsify*.test.ts` (after T9)
- **Traces:** U2 · **Instance:** backend-dev

### Task 2: claim-roster spawn oracle
- **Files:** `plugins/dev-core/skills/code-review/claim-roster.ts`, `claim-roster.sh`
- **Verify:** `bunx vitest run skills/code-review/__tests__/claim-roster.test.ts`
- **Traces:** S1 · **Instance:** backend-dev

### Task 3: Spec template + SKILL claim docs
- **Files:** `skills/spec/references/templates.md`, `skills/spec/SKILL.md`
- **Verify:** `grep -q 'claim:' plugins/dev-core/skills/spec/references/templates.md`
- **Traces:** U1 · **Instance:** doc-writer

### Task 4: Phase 2 deterministic σ resolver
- **File:** `plugins/dev-core/skills/code-review/SKILL.md` (+ optional `resolve-review-spec.sh`)
- **Verify:** grep Phase 2 priority table in SKILL
- **Traces:** U5 · **Instance:** backend-dev

### Task 5: Phase 3 S1 + When/Skip parity
- **File:** `plugins/dev-core/skills/code-review/SKILL.md`
- **Verify:** `grep spawn_security_auditor plugins/dev-core/skills/code-review/SKILL.md`
- **Traces:** U3 · **Instance:** doc-writer

### Task 6: README parity
- **File:** `plugins/dev-core/skills/code-review/README.md`
- **Traces:** U3 · **Instance:** doc-writer

### Task 7–9: Test suites
- **Traces:** SC oracles · **Instance:** tester

### Task 10: Legacy spec migration
- **File:** `artifacts/specs/417-plugin-owned-falsify-runner-spec.md`
- **Traces:** Constraints migration · **Instance:** doc-writer

## Task Seeding Blueprint

### Wave 1
- T1 (backend-dev) — no deps
- T3 (doc-writer) — no deps

### Wave 2
- T2 (backend-dev) — after T1 parse patterns known
- T4 (backend-dev) — parallel with T2

### Wave 3
- T5, T6 (doc-writer) — after T2
- T7, T8, T9 (tester) — after T2, T5

### Wave 4
- T10 (doc-writer) — after T1

## Consistency Report

- Criteria covered: 7/7 SCs mapped to T1–T10
- Uncovered: none
- Out of scope honored: no oracle_ok changes; no glob deletion

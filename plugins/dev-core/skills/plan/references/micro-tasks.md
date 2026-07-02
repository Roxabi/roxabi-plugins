# Step 4f — Micro-Task Generation (Tier F only)

Let: τ := tier | V := slice | α := agent | μ := micro-task

τ S ⇒ skip → Step 5.

## 4f.1 Detect Spec Format

| Mode | Condition | Source |
|------|-----------|--------|
| Primary | ∃ `## Breadboard` ∧ `## Slices` | Parse affordances (U*/N*/S*) + slices (V*) |
| Fallback | ∃ `## Success Criteria` only | Parse criteria as SC-1, SC-2, ... |
| Skip | Neither | Warn, use text tasks from Step 2d |

Partial (one of Breadboard/Slices ¬both): fallback if ∃ Success Criteria, else skip.

## 4f.2 Generate Micro-Tasks

**Primary (Breadboard + Slices):**

∀ V (V1, V2, ...):
1. Identify referenced affordances (N1, N2, U1, S1)
2. Expand each → 1–3 μ by complexity
3. Order: S* → N* → U* → tests
4. Assign α per Step 2c path rules
5. Generate verification cmd

**Fallback (Success Criteria):**

∀ criterion (SC-1, SC-2, ...):
1. Identify affected files + logic
2. Expand → 1–5 μ
3. Verification cmd ∨ `[manual]` marker
4. Assign α per Step 2c

**Verification heuristics:**

| Change type | Verify |
|------------|--------|
| `.ts/.tsx` code | Unit test ∨ typecheck |
| Type defs | `bun run typecheck --filter=@repo/types` |
| Config (json/yaml) | `bun run lint && grep -q 'key' path` |
| Skill/agent (.md) | `grep -q 'expected' path` |
| Docs (.mdx) | `test -f path && grep -q '## Section' path` |
| Migrations | `bun run db:migrate && bun run db:generate --check` |
| Other | `[manual]` |

**RED tasks:** Structural verify only (grep test structure). Tests expected to fail pre-impl.

**Safety:** Single-quote grep args. Read-only only. Allowed: `bun run test`, `bun run typecheck`, `bun run lint`, `grep -q`, `test -f`, `bun run db:generate --check`.

**Per-slice floor:** ≥2 μ (1 impl + 1 test). < 2 ⇒ merge w/ adjacent slice.

### Micro-Task Fields

| Field | Description |
|-------|-------------|
| Description | Imperative, specific |
| File path | Target file |
| Code snippet | Expected shape skeleton |
| Verify command | Bash confirmation |
| Expected output | Success criteria |
| Time estimate | 2–5 min (up to 8–10 for atomic ops) |
| `[P]` marker | Parallel-safe |
| Agent | Owner α |
| Agent instance | Named owner (backend-dev-A, tester-B, ...) |
| Subject | 1-word surface tag (auth, cache, http, parser, …) — drives per-instance subject-diversity cap |
| Spec trace | SC-N ∨ U1→N1→S1 |
| Slice | V1, V2, ... |
| Phase | RED ∨ GREEN ∨ REFACTOR ∨ RED-GATE |
| Difficulty | 1–5 |

## 4f.3 Detect Parallelization

`[P]` := ¬file-path conflict ∧ ¬import conflict w/ any other `[P]` μ in same slice+phase.

∀ μ pair in same slice:
1. Same file → ¬parallel
2. Import dep (read existing ∨ infer from wiring) → ¬parallel
3. Unknown → ¬parallel (conservative)

## 4f.4 Scale Task Count

| τ | Target | Floor |
|---|--------|-------|
| F-lite | 5–15 | 2 |
| F-full | 15–30 | 2 |

\> 30 ⇒ → present choice: warn, suggest splitting. Show full list (¬truncate).
< 2 ⇒ warn, suggest text tasks from Step 2d.

## 4f.5 Consistency Check

Bidirectional spec↔task:

1. **Coverage (spec→tasks):** ∀ criterion/affordance → ≥1 μ. Report uncovered.
2. **Gold plating (tasks→spec):** ∀ μ → spec trace required. **Exempt** (sole purpose): infra, quality, build, docs.
3. **Report:** covered N/total, uncovered list, untraced list, exemptions count.

0 coverage ⇒ block α. Return to spec ∨ regenerate.

## 4f.6 Write Plan Artifact

Write to `artifacts/plans/{N}-{slug}-plan.mdx`. Create dir if needed.

```markdown
---
title: "Plan: {title}"
issue: {N}
spec: artifacts/specs/{N}-{slug}-spec.mdx
complexity: {score}/10
tier: {tier}
generated: {ISO}
---

## Summary
{1-2 sentences}

## Bootstrap Context
{From artifacts/analyses/{issue}-*-analysis.mdx: conclusions + selected shape}

## Agents
| Agent | Tasks | Files |
|-------|-------|-------|
| {agent} | {N} | {files} |

## Consistency Report
- Covered: {N}/{total}
- Uncovered: {list ∨ "none"}
- Untraced: {list ∨ "none"}
- Exemptions: {N}

## Micro-Tasks

### Slice V1: {desc}

#### Task 1: {desc} [P] → {agent}
- **File:** {path}
- **Snippet:** {skeleton}
- **Verify:** `{cmd}` ({ready|deferred|manual})
- **Expected:** {output}
- **Time:** {N} min | **Difficulty:** {1-5}
- **Traces:** {SC-N, U1→N1→S1} | **Phase:** {phase}

#### RED-GATE: RED complete V1 → tester
```

## 4f.7 Present for Approval

→ present choice: complexity, τ, μ count, α, consistency, slices.
Options: **Approve** | **Modify** | **Return to spec**

## 4f.8 Commit Plan

Standalone commit (¬amend): `git add artifacts/plans/{N}-{slug}-plan.mdx` + commit per CLAUDE.md Rule 5.

## 4f.9 Dispatch TaskCreate

∀ μ → TaskCreate w/ metadata:

```json
{
  "taskDifficulty": 3,
  "verificationCommand": "bun run test apps/api/test/auth.test.ts",
  "verificationStatus": "ready|deferred|manual",
  "expectedOutput": "description",
  "estimatedMinutes": 3,
  "parallel": true,
  "specTrace": "SC-3, N1→S1",
  "slice": "V1",
  "phase": "GREEN"
}
```

| Field | Values |
|-------|--------|
| taskDifficulty | 1–5 |
| verificationStatus | ready (run now) ∨ deferred (wait RED-GATE) ∨ manual (no auto-check) |
| estimatedMinutes | 2–10 |
| parallel | true if [P] |
| phase | RED ∨ GREEN ∨ REFACTOR ∨ RED-GATE |

RED-GATE sentinels: auto-generate 1/slice → tester, phase: RED-GATE.

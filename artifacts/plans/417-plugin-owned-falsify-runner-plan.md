---
title: "Plan: Control quality: plugin-owned falsify runner (markdown is a report)"
issue: 417
spec: artifacts/specs/417-plugin-owned-falsify-runner-spec.md
complexity: 8/10
tier: F-full
generated: "2026-08-21T21:46:00+02:00"
---

## Summary

V1 only: ship `run-falsify.sh` as the sole executable oracle (temp-worktree isolation + `--verify` re-exec), demote `parse-falsify`/`falsify_ok` out of the gate graph, and wire `/implement` 6b + `/pr` + `/code-review` to `oracle_ok`. ADR first. Claim-axis roster (V2) deferred.

## Architecture

### Data Flow

**Diagram:** [Recommended oracle data flow](../visuals/417-plugin-owned-falsify-runner-data-flow.html)

matrix → `run-falsify` (absent→FAIL, restore→PASS) → JSON → `--verify` → sole `oracle_ok` for `/pr` + tester-skip.

### File x Function Map

**Diagram:** [V1 file × function map](../visuals/417-plugin-owned-falsify-runner-file-map.html)

ADR locks decisions; runner owns writes; gather-state emits `oracle_ok`; skills consume; parse is lint-only.

## Bootstrap Context

From approved α (Shape 1): plugin runner owns oracle; markdown is report; parser-ok alone must not skip tester; prefer temp isolation over stash; encode proven via runner-written JSON + re-exec verify; roster (3) deferred — keep path globs in V1.

## Agents

| Agent | Task count | Files |
|-------|-----------|-------|
| doc-writer-A | 1 | `docs/architecture/adr/019-*.md` |
| tester-A | 4 | `plugins/dev-core/skills/pr/__tests__/run-falsify.test.ts` |
| devops-A | 3 | `plugins/dev-core/skills/pr/run-falsify.sh` |
| devops-B | 2 | `gather-state.sh`, `parse-falsify.sh` (demote notes) |
| doc-writer-B | 5 | implement/pr/code-review/test/validate SKILL.md + tester.md |
| tester-B | 2 | gate/integration tests + RED-GATE |

## Wave Structure

5 waves, max 3 parallel agents. Elapsed ~0.5–1 week vs ~1.5 sequential.

| Wave | Trigger | Agents | Tasks |
|------|---------|--------|-------|
| 1 | start | 2 ∥ | doc-writer-A: T1 · tester-A: T2→T3 |
| 2 | Wave 1 done | 1 | devops-A: T4→T5→T6 |
| 3 | Wave 2 done | 2 ∥ | devops-B: T7→T8 · doc-writer-B: T9→T10 |
| 4 | Wave 3 done | 2 ∥ | doc-writer-B: T11→T12→T13 · tester-B: T14 |
| 5 | Wave 4 done | 1 | tester-B: T15 (RED-GATE) |

### Budget — per task

| Task | Items | Class | Est. ops | Split? |
|------|-------|-------|----------|--------|
| T1 ADR | 1 | judgmental | 5 | — |
| T2–T3 RED runner tests | 2 | bounded | 6 | — |
| T4–T6 run-falsify | 3 | judgmental | 15 | — |
| T7–T8 gather-state demote | 2 | bounded | 6 | — |
| T9–T13 skill wires | 5 | bounded | 12 | — |
| T14–T15 GREEN + gate | 2 | bounded | 8 | — |

**Total estimated ops: ~52**

### Budget — per agent instance

| Instance | Tasks | Σ ops | Subjects | Split? |
|----------|-------|-------|----------|--------|
| doc-writer-A | T1 | 5 | adr | — |
| tester-A | T2, T3 | 6 | runner | — |
| devops-A | T4, T5, T6 | 15 | runner, verify, schema | — (3 subjects at cap) |
| devops-B | T7, T8 | 6 | gates | — |
| doc-writer-B | T9–T13 | 12 | skills | YES risk → keep ≤5 skill files as one subject `skills` |
| tester-B | T14, T15 | 8 | gates | — |

## Consistency Report

- Criteria covered: 10/10 V1 SCs (roster/kit SCs explicitly out / V2)
- Uncovered criteria: V2 claim-axis (deferred) · kit (out)
- Tasks without spec backing: none
- Gold plating exemptions applied: 0

## Micro-Tasks

### Slice V1: Oracle + sole gate

#### Task 1: Write ADR-019 oracle ownership [P] → doc-writer-A
- **File:** `docs/architecture/adr/019-plugin-owned-falsify-oracle.md`
- **Snippet:** `## Decision` · oracle = `run-falsify` · isolation = temp worktree · schema v1 · gate = `oracle_ok` only · parse demoted
- **Verify:** `test -f docs/architecture/adr/019-plugin-owned-falsify-oracle.md && grep -q 'oracle_ok' docs/architecture/adr/019-plugin-owned-falsify-oracle.md`
- **Expected:** ADR exists with four locked decisions
- **Time:** 8 min · **Difficulty:** 3
- **Traces:** SC-ADR, U6 · **Phase:** GREEN · **Subject:** adr · **Instance:** doc-writer-A

#### Task 2: RED — forged JSON fails --verify [P] → tester-A
- **File:** `plugins/dev-core/skills/pr/__tests__/run-falsify.test.ts`
- **Snippet:** `it('forged green json fails verify', …)` write schema-valid JSON without running helper → `oracle_ok=false`
- **Verify:** `grep -q 'forged' plugins/dev-core/skills/pr/__tests__/run-falsify.test.ts`
- **Expected:** test file exists (may fail until T4–T6)
- **Time:** 5 min · **Difficulty:** 3
- **Traces:** SC-/pr priced oracle 1 · **Phase:** RED · **Subject:** runner · **Instance:** tester-A

#### Task 3: RED — empty/all-exempt maps ¬oracle_ok → tester-A
- **File:** `plugins/dev-core/skills/pr/__tests__/run-falsify.test.ts`
- **Snippet:** cases for zero FAIL→PASS rows + all-exempt matrix → `oracle_ok=false`
- **Verify:** `grep -qE 'all-exempt|empty' plugins/dev-core/skills/pr/__tests__/run-falsify.test.ts`
- **Expected:** cases present
- **Time:** 5 min · **Difficulty:** 3
- **Traces:** SC-/pr oracles 3–4 · **Phase:** RED · **Subject:** runner · **Instance:** tester-A

#### Task 4: Implement run-falsify run mode (temp worktree) → devops-A
- **File:** `plugins/dev-core/skills/pr/run-falsify.sh`
- **Snippet:** `run_falsify_map` · `git worktree add` temp · stash-absent sources · run `test_cmd` · assert fail · restore · assert pass · write JSON
- **Verify:** `test -x plugins/dev-core/skills/pr/run-falsify.sh && grep -q 'worktree' plugins/dev-core/skills/pr/run-falsify.sh`
- **Expected:** executable script; ¬`git stash` as public API
- **Time:** 10 min · **Difficulty:** 5
- **Traces:** S1, N1 · **Phase:** GREEN · **Subject:** runner · **Instance:** devops-A

#### Task 5: Implement --verify full re-exec → devops-A
- **File:** `plugins/dev-core/skills/pr/run-falsify.sh`
- **Snippet:** `--verify <json>` re-runs mapped rows; schema-only → ¬`oracle_ok`; emit `oracle_ok=true|false`
- **Verify:** `grep -q '\\-\\-verify' plugins/dev-core/skills/pr/run-falsify.sh`
- **Expected:** verify path present
- **Time:** 8 min · **Difficulty:** 4
- **Traces:** S2 · **Phase:** GREEN · **Subject:** verify · **Instance:** devops-A

#### Task 6: JSON schema v1 writer + optional md render → devops-A
- **File:** `plugins/dev-core/skills/pr/run-falsify.sh`
- **Snippet:** write `schema_version/head/runner_id/rows/oracle_ok`; optional `*-falsify.md` render
- **Verify:** `grep -q 'schema_version' plugins/dev-core/skills/pr/run-falsify.sh`
- **Expected:** JSON fields match spec data model
- **Time:** 6 min · **Difficulty:** 3
- **Traces:** N1, N2 · **Phase:** GREEN · **Subject:** schema · **Instance:** devops-A

#### Task 7: gather-state emits oracle_ok via --verify → devops-B
- **File:** `plugins/dev-core/skills/pr/gather-state.sh`
- **Snippet:** call `run-falsify.sh --verify`; emit `oracle_ok=`; remove gate use of `falsify_ok`
- **Verify:** `grep -q 'oracle_ok' plugins/dev-core/skills/pr/gather-state.sh && ! grep -E 'falsify_ok=true' plugins/dev-core/skills/pr/gather-state.sh | grep -v demoted || true`
- **Expected:** `oracle_ok` present; refuse path not keyed on `falsify_ok`
- **Time:** 6 min · **Difficulty:** 4
- **Traces:** U2, U4 · **Phase:** GREEN · **Subject:** gates · **Instance:** devops-B

#### Task 8: Demote parse-falsify to ungated lint → devops-B
- **File:** `plugins/dev-core/skills/pr/parse-falsify.sh` (+ header comment)
- **Snippet:** header: "report hygiene only — ¬gate input"
- **Verify:** `grep -qi 'hygiene\\|lint\\|¬gate\\|not a gate' plugins/dev-core/skills/pr/parse-falsify.sh`
- **Expected:** demotion documented in script header
- **Time:** 3 min · **Difficulty:** 2
- **Traces:** U4 · **Phase:** GREEN · **Subject:** gates · **Instance:** devops-B

#### Task 9: Wire /implement Step 6b → runner [P] → doc-writer-B
- **File:** `plugins/dev-core/skills/implement/SKILL.md`
- **Snippet:** prefer `bash ${CLAUDE_PLUGIN_ROOT}/skills/pr/run-falsify.sh`; drop consumer/LLM stash as alternate oracle (stub-refuse unless delegates)
- **Verify:** `grep -q 'run-falsify' plugins/dev-core/skills/implement/SKILL.md`
- **Expected:** 6b points at plugin runner
- **Time:** 5 min · **Difficulty:** 3
- **Traces:** U1 · **Phase:** GREEN · **Subject:** skills · **Instance:** doc-writer-B

#### Task 10: Wire /pr refuse on ¬oracle_ok [P] → doc-writer-B
- **File:** `plugins/dev-core/skills/pr/SKILL.md`
- **Snippet:** refuse when `oracle_ok=false`; ¬`falsify_ok` as pass
- **Verify:** `grep -q 'oracle_ok' plugins/dev-core/skills/pr/SKILL.md`
- **Expected:** priced refuse rail documented
- **Time:** 4 min · **Difficulty:** 2
- **Traces:** U2 · **Phase:** GREEN · **Subject:** skills · **Instance:** doc-writer-B

#### Task 11: Wire /code-review tester-skip → oracle_ok → doc-writer-B
- **File:** `plugins/dev-core/skills/code-review/SKILL.md`
- **Snippet:** skip tester iff `--verify` → `oracle_ok=true`; keep path globs for architect/devops/security
- **Verify:** `grep -q 'oracle_ok' plugins/dev-core/skills/code-review/SKILL.md && grep -q 'scripts/' plugins/dev-core/skills/code-review/SKILL.md`
- **Expected:** skip uses oracle_ok; path triggers remain
- **Time:** 5 min · **Difficulty:** 3
- **Traces:** U3 · **Phase:** GREEN · **Subject:** skills · **Instance:** doc-writer-B

#### Task 12: Align test + validate skill candidate order → doc-writer-B
- **File:** `plugins/dev-core/skills/test/SKILL.md`, `plugins/dev-core/skills/validate/SKILL.md`
- **Snippet:** plugin runner first; consumer `test:falsify` only if execs helper
- **Verify:** `grep -q 'run-falsify' plugins/dev-core/skills/test/SKILL.md`
- **Expected:** candidate order matches implement
- **Time:** 4 min · **Difficulty:** 2
- **Traces:** SC-6b · **Phase:** GREEN · **Subject:** skills · **Instance:** doc-writer-B

#### Task 13: Update tester.md evidence contract → doc-writer-B
- **File:** `plugins/dev-core/agents/tester.md`
- **Snippet:** evidence from runner JSON / `--verify`; ¬markdown-alone proven
- **Verify:** `grep -q 'run-falsify\\|oracle_ok' plugins/dev-core/agents/tester.md`
- **Expected:** agent doc aligned
- **Time:** 3 min · **Difficulty:** 2
- **Traces:** U3 · **Phase:** GREEN · **Subject:** skills · **Instance:** doc-writer-B

#### Task 14: GREEN — priced oracle suite passes → tester-B
- **File:** `plugins/dev-core/skills/pr/__tests__/run-falsify.test.ts`
- **Snippet:** run vitest; forged/empty/head-mismatch/Δ-coverage cases green
- **Verify:** `cd plugins/dev-core && bunx vitest run skills/pr/__tests__/run-falsify.test.ts`
- **Expected:** exit 0
- **Time:** 8 min · **Difficulty:** 4
- **Traces:** SC-/pr, SC-tester-skip · **Phase:** GREEN · **Subject:** gates · **Instance:** tester-B

#### RED-GATE: RED complete V1 → tester-B
- **Verify:** T2–T3 complete before relying on T14 green; all V1 RED tasks done
- **Phase:** RED-GATE
- **Traces:** V1 · **Instance:** tester-B · **Task:** T15

#### Task 15: Assert no falsify_ok sole-gate residue → tester-B
- **File:** (grep across skills)
- **Snippet:** fail if `falsify_ok` still used as refuse/skip sole condition in pr/code-review/gather-state
- **Verify:** `! grep -RIn --include='*.md' --include='*.sh' -E 'falsify_ok=true|falsify_ok \\' plugins/dev-core/skills/pr/plugins/dev-core/skills/code-review/gather-state.sh 2>/dev/null | grep -viE 'demoted|hygiene|legacy|¬|not '; true`
- **Expected:** no sole-gate residue (manual review of grep)
- **Time:** 4 min · **Difficulty:** 3
- **Traces:** SC-sole-oracle_ok · **Phase:** REFACTOR · **Subject:** gates · **Instance:** tester-B

## Task Seeding Blueprint

<!-- Used by /implement to seed TaskCreate calls on session start. -->

### Wave 1 — no deps, 2 agents ∥

| Task | Agent instance | blockedBy | Subject |
|------|---------------|-----------|---------|
| T1 | doc-writer-A | — | adr |
| T2 | tester-A | — | runner |
| T3 | tester-A | T2 | runner |

### Wave 2 — after Wave 1, 1 agent

| Task | Agent instance | blockedBy | Subject |
|------|---------------|-----------|---------|
| T4 | devops-A | T1,T3 | runner |
| T5 | devops-A | T4 | verify |
| T6 | devops-A | T5 | schema |

### Wave 3 — after Wave 2, 2 agents ∥

| Task | Agent instance | blockedBy | Subject |
|------|---------------|-----------|---------|
| T7 | devops-B | T6 | gates |
| T8 | devops-B | T7 | gates |
| T9 | doc-writer-B | T6 | skills |
| T10 | doc-writer-B | T9 | skills |

### Wave 4 — after Wave 3, 2 agents ∥

| Task | Agent instance | blockedBy | Subject |
|------|---------------|-----------|---------|
| T11 | doc-writer-B | T10 | skills |
| T12 | doc-writer-B | T11 | skills |
| T13 | doc-writer-B | T12 | skills |
| T14 | tester-B | T6,T11 | gates |

### Wave 5 — after Wave 4, 1 agent

| Task | Agent instance | blockedBy | Subject |
|------|---------------|-----------|---------|
| T15 | tester-B | T14 | gates |

## Task IDs

<!-- Generated by /plan. Used by /implement to resume tasks on session restart. -->
- T1: T1 — adr
- T2: T2 — runner
- T3: T3 — runner
- T4: T4 — runner
- T5: T5 — verify
- T6: T6 — schema
- T7: T7 — gates
- T8: T8 — gates
- T9: T9 — skills
- T10: T10 — skills
- T11: T11 — skills
- T12: T12 — skills
- T13: T13 — skills
- T14: T14 — gates
- T15: T15 — gates

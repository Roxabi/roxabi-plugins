---
name: fix
argument-hint: '[#PR]'
description: Apply review findings — auto-apply high-confidence, 1b1 for rest, spawn fixers. Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these".
version: 0.1.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task, Skill
---

# Fix

Apply review findings from a PR or conversation context — auto-apply high-confidence findings, walk through the rest 1b1, spawn fixer agents for accepted findings, then commit.

**⚠ Flow: single continuous pipeline. ¬stop between phases. AskUserQuestion response → immediately execute next phase. Stop only on: explicit Cancel, or pipeline completion.**

```
/fix        → findings from conversation context
/fix #42    → gather findings from PR #42 comments
```

## Definitions

```
F         = set of all findings
f ∈ F     = a single finding
C(f)      ∈ [0,100] ∩ ℤ        — confidence score
A(f)      = {agents that flagged f}
cat(f)    ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
src(f)    = originating agent
Δ         = set of changed files
actionable = {issue, suggestion, todo}
T         = 80                   — auto-apply threshold
```

## Phase 1 — Gather Findings

1. PR# provided → `gh pr view <#> --json comments --jq '.comments[].body'` — parse Conventional Comments findings from review output
2. ¬PR# → scan conversation context for most recent `/review` output
3. F = ∅ → inform ("No findings to apply"), halt
4. Parse each finding into structured form: label, file:line, agent, root cause, solutions, C(f)
5. Malformed finding (missing fields ∨ C ∉ ℤ ∩ [0,100]) → C(f) := 0

## Phase 2 — Queue Split

```
auto_apply(f) ⟺ C(f) ≥ T  ∧  cat(f) ∈ actionable  ∧  src(f) ≠ security-auditor
Q_auto = {f ∈ F | auto_apply(f)}
Q_1b1  = F \ Q_auto
∀f: cat(f) ∈ {thought, question, praise} → f ∈ Q_1b1  (unconditional)
```

## Phase 3 — Confidence-Gated Auto-Apply

Runs before 1b1 — `[auto-applied]` markers reflect outcomes.

**1. Early exit:** Q_auto = ∅ → skip to Phase 4.

**2. Verify single-agent:** ∀ f ∈ Q_auto ∧ |A(f)| = 1 → spawn fresh verifier (different domain).
- C(f) ≥ T → stays, |A(f)| := 2
- C(f) < T ∨ rejects → Q_1b1
- Batch ∥

**3. Large queue:** |Q_auto| > 5 → AskUserQuestion: "Auto-apply all N?" / "Review via 1b1".
- 1b1 → Q_1b1 ∪= Q_auto; Q_auto := ∅; skip to Phase 4.

**4. Dispatch strategy — agent vs inline:**

```
|Q_auto| ≤ 2  → orchestrator applies directly (inline, ¬spawn agent)
|Q_auto| ≥ 3  → spawn agent(s) per dispatch table below
```

**Agent dispatch (|Q_auto| ≥ 3):**

```
simple(f) ⟺ mechanical fix (rename, remove unused, add import/type, one-liner)
complex(f) ⟺ domain reasoning needed (logic change, multi-file, arch-adjacent, security)
```
Evaluate the fix, ¬the label — any category can be simple or complex.

```
simple(f) → fixer
complex(f) → domain agent: FE→frontend-dev | BE→backend-dev | Infra→devops
```
Domains: FE = `apps/web/`, `packages/ui/` | BE = `apps/api/`, `packages/types/` | Infra = `packages/config/`, root, CI

**Batching (cost efficiency):**
- Min 3 findings per agent — ¬spawn for <3
- <3 in a group → merge into nearest agent (prefer `fixer` as catch-all)
- Mixed domains → 1 agent per domain (if ≥3 each), else consolidate into fewest agents respecting min 3

**5. Apply (inline or via agent):**

*Inline (|Q_auto| ≤ 2):* ∀ f ∈ Q_auto (sequential):
- succeeds → `[applied]`
- fails (test / lint / timeout / crash) → stash restore → demote f + remaining → Q_1b1 + note → **halt serial apply**
- Prior fixes ¬rolled back

*Agent (|Q_auto| ≥ 3):* Spawn per dispatch table. Agent payload = findings in scope + diff context + "fix each finding; re-read files before editing; run lint + tests after each fix."
- Agent succeeds → `[applied]` per finding
- Agent fails on a finding → `[failed -> 1b1]`, demote to Q_1b1
- Agent constraints: same as Phase 5 fixer constraints (re-read, CI fail → retry max 3, escalate if stuck)

**6. Summary:** Display before Phase 4:
```
-- Auto-Applied Fixes (C ≥ 80%, verified) --
Applied N finding(s) [inline | via fixer | via frontend-dev | ...]:
  1. [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
  2. [failed -> 1b1] nitpick: Unused import in dashboard.tsx:3 (85%) -- test failure
Remaining M finding(s) → 1b1.
```

**→ immediately continue to Phase 4 (¬stop).**

## Phase 4 — Finding Walkthrough

Q_1b1 = ∅ → skip to Phase 5.

**Auto-apply context note:** |Q_auto| > 0 → display before first item:
```
Note: N finding(s) were auto-applied in Phase 3.
Run `git diff` to review the auto-applied changes.
```

∀ f ∈ Q_1b1, sequentially:

**4a. Brief** — present enriched finding:
```
── Finding {N}/{|Q_1b1|}: {label} ──

<label> -- estimated confidence: C(f)% -- <src(f)>
  <file>:<line>

Root cause: <root cause>

Solutions:
  1. <primary> (recommended)
  2. <alternative>
  3. <alternative> [if ∃]

Recommended: Solution 1 -- <rationale>
```

If f was demoted from auto-apply (failed) → prepend: `Auto-apply attempted but failed: <reason>`

**4b. Decision** — AskUserQuestion:
- **Fix now** — accept finding
- **Reject** — invalid, discard
- **Skip** — move on
- **Defer** — valid but not urgent

**4c. Solution choice (Fix now only)** — AskUserQuestion with available solutions:
- **Solution 1 (recommended):** <description>
- **Solution 2:** <description>
- **Solution 3:** <description> [if ∃]

Store chosen solution with f for Phase 5 fixer payload.

**4d. Summary** after all items:
```
── Walkthrough Complete ──
Accepted: N | Rejected: N | Skipped: N | Deferred: N
```

accepted = {f ∈ Q_1b1 | decision(f) = accept}, each with chosen solution

## Phase 5 — Spawn Fixer Agents

accepted = ∅ → inform ("No findings accepted"), skip to Phase 6.

**Inline vs agent (same rule as Phase 3):**
```
|accepted| ≤ 2  → orchestrator applies directly (inline, ¬spawn agent)
|accepted| ≥ 3  → spawn agent(s) per dispatch below
```

**Dispatch — same rules as Phase 3:**
```
simple(f) → fixer
complex(f) → domain agent: FE→frontend-dev | BE→backend-dev | Infra→devops
```

**Batching (cost efficiency):**
- Min 3 findings per agent — ¬spawn for <3
- <3 in a group → merge into nearest agent (prefer `fixer` as catch-all)
- ≥6 findings/domain across distinct modules → N agents (disjoint file groups), 1/module group
- Mixed domains → 1 agent per domain (if ≥3 each), else consolidate into fewest agents respecting min 3

**Fixer payload per agent:** accepted findings in scope + **chosen solution text from Phase 4c** + full diff context + "fix each finding using the chosen solution; re-read files before editing; run lint + tests after each fix." If f was demoted from auto-apply, include the failure note so fixer understands what was already attempted.

Fixer constraints:
- Re-read all target files before editing (Phase 3 edits may have changed them)
- CI fail → respawn until green (max 3 attempts)
- Cannot fix → escalate to lead, mark as unresolved

## Phase 6 — Commit + Push

1. Stage specific files only (¬`git add -A`)
2. Commit per CLAUDE.md Rule 5. Include list of applied findings in body.
3. AskUserQuestion: "Push now?" / "I'll push later"
4. If push approved → `git push`

## Phase 7 — Post Follow-Up Comment

∄ PR → skip.

`/tmp/review-fixes.md` → `gh pr comment <#> --body-file /tmp/review-fixes.md`

```markdown
## Review Fixes Applied

**Auto-applied (Phase 3):** N finding(s)
**Accepted via 1b1:** M finding(s)
**Rejected:** K finding(s)
**Deferred:** J finding(s)

### Applied
- [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
- [applied] suggestion: Missing error boundary in dashboard.tsx:15 (83%)

### Deferred
- nitpick: Variable naming in auth.service.ts:88 — noted for future cleanup
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| F = ∅ | Inform, halt |
| Q_auto = ∅ | Skip Phase 3, go to Phase 4 |
| Q_1b1 = ∅ after Phase 3 | Skip Phase 4 |
| accepted = ∅ | Skip Phase 5, inform |
| ∀f: auto_apply(f) ∧ |Q_auto| ≤ 2 | All auto-applied inline, 1b1 skipped |
| ∀f: auto_apply(f) ∧ |Q_auto| ≥ 3 | All auto-applied via agent(s), 1b1 skipped |
| ∀f: C(f) < T | Phase 3 skipped, all → 1b1 |
| |A(f)| = 1 ∧ C(f) ≥ T | Verification agent → auto-apply ∨ 1b1 |
| Auto-apply breaks tests/lint | Stash restore, demote to 1b1 |
| Fixer timeout/crash/cannot-fix | Demote to 1b1, stash restore |
| cat(f) ∈ {praise, thought, question} | Exempt from auto-apply |
| C(f) = T | Inclusive (≥ T) |
| Missing root cause/solutions | C(f) := 0, → Q_1b1 |
| Phase 3 edits ∩ Phase 5 targets | Phase 5 fixer re-reads files first |
| security-auditor finding ∧ C ≥ T | Still → Q_1b1 (safety rule) |
| ¬∃ PR | Skip Phase 7, local commit only |
| Critical security accepted | Escalate immediately after 1b1 |

## Safety Rules

1. security-auditor findings ¬auto-apply regardless of C(f) — always → Q_1b1
2. ¬approve PRs on GitHub, ¬auto-merge
3. Human can `git diff` anytime — applied changes visible in working tree
4. ∃ PR → must post follow-up comment (Phase 7)
5. Fixer agents ¬have implementation context from current session → spawn fresh
6. Stage specific files only — ¬`git add -A` (risk of including .env, secrets)

$ARGUMENTS

---
name: fix
argument-hint: '[#PR]'
description: Apply review findings — auto-apply high-confidence, 1b1 for rest, spawn fixers. Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these".
version: 0.2.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task, Skill
---

# Fix

Apply review findings from a PR or conversation context — auto-apply high-confidence findings, walk through the rest 1b1, spawn fixer agents for accepted findings, then commit.

**⚠ Flow: single continuous pipeline. ¬stop between phases. AskUserQuestion response → immediately execute next phase. Stop only on: explicit Cancel, or Phase 8 completion.**

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

Let: Q_a := Q_auto | Q_1 := Q_1b1 | acc := accepted findings

## Phase 1 — Gather Findings

1. PR# provided → `gh pr view <#> --json comments --jq '.comments[].body'`; parse Conventional Comments findings
2. ¬PR# → scan conversation for most recent `/review` output
3. F = ∅ → inform, halt
4. ∀ f: parse into structured form: label, file:line, agent, root cause, solutions, C(f)
5. Malformed finding (missing fields ∨ C ∉ ℤ ∩ [0,100]) → C(f) := 0

## Phase 2 — Queue Split

```
auto_apply(f) ⟺ C(f) ≥ T  ∧  cat(f) ∈ actionable  ∧  src(f) ≠ security-auditor
Q_a = {f ∈ F | auto_apply(f)}
Q_1 = F \ Q_a
∀f: cat(f) ∈ {thought, question, praise} → f ∈ Q_1  (unconditional)
```

## Phase 3 — Confidence-Gated Auto-Apply

Runs before 1b1 — `[auto-applied]` markers reflect outcomes.

**1.** Q_a = ∅ → skip to Phase 4.

**2. Verify single-agent:** ∀ f ∈ Q_a ∧ |A(f)| = 1 → spawn fresh verifier (different domain from src(f)).
- Verifier confirms (C_v ≥ T) → f stays in Q_a, |A(f)| := 2
- Verifier rejects (C_v < T) → demote f → Q_1
- Batch verifications ∥ (group by domain, 1 verifier/domain)

**3. Large queue:** |Q_a| > 5 → AskUserQuestion: "Auto-apply all N?" / "Review via 1b1".
- 1b1 → Q_1 ∪= Q_a; Q_a := ∅; skip to Phase 4.

**4. Dispatch strategy:**

```
|Q_a| ≤ 2  → orchestrator applies directly (inline, ¬spawn agent)
|Q_a| ≥ 3  → spawn agent(s) per dispatch table below
```

**Agent dispatch (|Q_a| ≥ 3):**

```
simple(f) ⟺ mechanical fix (rename, remove unused, add import/type, one-liner)
complex(f) ⟺ domain reasoning needed (logic change, multi-file, arch-adjacent, security)
```
Evaluate the fix, ¬the label — any category can be simple or complex.

```
simple(f) → fixer
complex(f) → domain agent: FE→frontend-dev | BE→backend-dev | Infra→devops
```
Domains: FE = `{frontend.path}`, `{shared.ui}` | BE = `{backend.path}`, `{shared.types}` | Infra = `{shared.config}`, root, CI

**Batching (cost efficiency):**
- Min 3 findings per agent — ¬spawn for <3
- <3 in a group → merge into nearest agent (prefer `fixer` as catch-all)
- Mixed domains → 1 agent/domain (if ≥3 each), else consolidate into fewest agents respecting min 3

**5. Apply:**

*Inline (|Q_a| ≤ 2):* ∀ f ∈ Q_a (sequential):
- succeeds → `[applied]`
- fails (test / lint / timeout / crash) → stash restore → demote f + remaining → Q_1 + note → **halt serial apply**
- Prior fixes ¬rolled back

*Agent (|Q_a| ≥ 3):* Spawn per dispatch. Payload = findings in scope + diff context + "fix each finding; re-read files before editing; run lint + tests after each fix."
- succeeds → `[applied]` per finding | fails on f → `[failed -> 1b1]`, demote to Q_1
- Agent constraints: re-read; CI fail → retry max 3; escalate if stuck

**6. Summary:**
```
-- Auto-Applied Fixes (C ≥ 80%, verified) --
Applied N finding(s) [inline | via fixer | via frontend-dev | ...]:
  1. [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
  2. [failed -> 1b1] nitpick: Unused import in dashboard.tsx:3 (85%) -- test failure
Remaining M finding(s) → 1b1.
```

**→ immediately continue to Phase 4 (¬stop).**

## Phase 4 — Finding Walkthrough

Q_1 = ∅ → skip to Phase 5.

|Q_a| > 0 → display before first item:
```
Note: N finding(s) were auto-applied in Phase 3.
Run `git diff` to review the auto-applied changes.
```

∀ f ∈ Q_1, sequentially:

**4a. Brief** — present enriched finding:
```
── Finding {N}/{|Q_1|}: {label} ──

<label> -- estimated confidence: C(f)% -- <src(f)>
  <file>:<line>

Root cause: <root cause>

Solutions:
  1. <primary> (recommended)
  2. <alternative>
  3. <alternative> [if ∃]

Recommended: Solution 1 -- <rationale>
```

f demoted from auto-apply (failed) → prepend: `Auto-apply attempted but failed: <reason>`

**4b. Decision** — AskUserQuestion: **Fix now** | **Reject** (invalid, discard) | **Skip** | **Defer** (valid, not urgent)

**4c. Solution choice (Fix now only)** — AskUserQuestion with available solutions:
- **Solution 1 (recommended):** <description>
- **Solution 2:** <description>
- **Solution 3:** <description> [if ∃]

Store chosen solution with f for Phase 5 payload.

**4d. Summary:**
```
── Walkthrough Complete ──
Accepted: N | Rejected: N | Skipped: N | Deferred: N
```

acc = {f ∈ Q_1 | decision(f) = accept}, each with chosen solution

## Phase 5 — Spawn Fixer Agents

acc = ∅ → inform ("No findings accepted"), skip to Phase 6.

```
|acc| ≤ 2  → orchestrator applies directly (inline, ¬spawn agent)
|acc| ≥ 3  → spawn agent(s) per dispatch below
```

Dispatch + batching rules identical to Phase 3:
- `simple(f) → fixer` | `complex(f) → frontend-dev | backend-dev | devops`
- Min 3/agent; <3 → merge into nearest (prefer `fixer`); ≥6 findings/domain across distinct modules → N agents (disjoint file groups), 1/module group; mixed domains → 1/domain if ≥3, else consolidate

**Fixer payload per agent:** acc findings in scope + **chosen solution text from Phase 4c** + full diff context + "fix each finding using the chosen solution; re-read files before editing; run lint + tests after each fix." f demoted from auto-apply → include failure note.

Fixer constraints:
- Re-read all target files before editing (Phase 3 edits may have changed them)
- CI fail → respawn until green (max 3 attempts)
- Cannot fix → escalate to lead, mark as unresolved

## Phase 6 — Validate + Commit + Push

1. Run `{commands.lint} && {commands.test}` — full quality gate across all applied changes
   - Pass → continue
   - Fail → display failure output; AskUserQuestion: **Retry** (attempt auto-fix) | **Continue anyway** | **Abort** (leave changes uncommitted)
   - Retry → attempt inline fix of the reported error; re-run gate; max 2 retries; still failing → AskUserQuestion: Continue anyway | Abort
2. Stage specific files only (¬`git add -A`)
3. Commit per CLAUDE.md Rule 5; include list of applied findings in body
4. AskUserQuestion: "Push now?" / "I'll push later"
5. Push approved → `git push`

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

## Phase 8 — Merge Gate

∄ PR → skip.

```
BASE := `staging` (∃ origin/staging) ∨ `main`
```

AskUserQuestion:
- **Rebase & merge** — rebase onto base, label, squash merge
- **I'll merge later** — exit

**If Rebase & merge:**

1. `git fetch origin ${BASE} && git rev-list HEAD..origin/${BASE} --count`
   - count > 0 → `git rebase origin/${BASE}` + `git push --force-with-lease`
   - conflict → inform user, halt (¬label, ¬merge)
2. AskUserQuestion: "Add `reviewed` label?" → Yes / No
3. Yes → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"`
4. Squash merge on green CI: `gh pr merge <#> --squash`

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| F = ∅ | Inform, halt |
| Q_a = ∅ | Skip Phase 3, go to Phase 4 |
| Q_1 = ∅ after Phase 3 | Skip Phase 4 |
| acc = ∅ | Skip Phase 5, inform |
| ∀f: auto_apply(f) ∧ |Q_a| ≤ 2 | All auto-applied inline, 1b1 skipped |
| ∀f: auto_apply(f) ∧ |Q_a| ≥ 3 | All auto-applied via agent(s), 1b1 skipped |
| ∀f: C(f) < T | Phase 3 skipped, all → 1b1 |
| |A(f)| = 1 ∧ C(f) ≥ T | Verification agent → auto-apply ∨ 1b1 |
| Auto-apply breaks tests/lint | Stash restore, demote to 1b1 |
| Fixer timeout/crash/cannot-fix | Demote to 1b1, stash restore |
| cat(f) ∈ {praise, thought, question} | Exempt from auto-apply |
| C(f) = T | Inclusive (≥ T) |
| Missing root cause/solutions | C(f) := 0, → Q_1 |
| Phase 3 edits ∩ Phase 5 targets | Phase 5 fixer re-reads files first |
| security-auditor finding ∧ C ≥ T | Still → Q_1 (safety rule) |
| ¬∃ PR | Skip Phase 7, local commit only |
| Critical security accepted | Escalate immediately after 1b1 |

## Safety Rules

1. security-auditor findings ¬auto-apply regardless of C(f) — always → Q_1
2. ¬approve PRs on GitHub, ¬auto-merge
3. Human can `git diff` anytime — applied changes visible in working tree
4. ∃ PR → must post follow-up comment (Phase 7)
5. Fixer agents ¬have implementation context from current session → spawn fresh
6. Stage specific files only — ¬`git add -A` (risk of including .env, secrets)

$ARGUMENTS

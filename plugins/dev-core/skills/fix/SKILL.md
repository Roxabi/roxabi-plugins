---
name: fix
argument-hint: '[#PR]'
description: 'Apply review findings — auto-apply high-confidence, 1b1 for rest, then batch-apply. Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these".'
version: 0.4.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task, Skill
---

# Fix

Two-pass fix pipeline: auto-apply high-confidence findings (C≥80, 2+ agents), then 1b1 walkthrough for the rest with a single focused question per finding.

**⚠ Continuous pipeline. ¬stop between phases. Stop only on: unrecoverable failure, or Phase 8 completion.**

```
/fix        → findings from conversation context
/fix #42    → gather findings from PR #42 comments
```

## Definitions

```
F          = set of all findings
f ∈ F      = a single finding
C(f)       ∈ [0,100] ∩ ℤ        — confidence score
A(f)       = {agents that flagged f}
cat(f)     ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
src(f)     = originating agent
actionable = {issue, suggestion, todo, nitpick}
T          = 80                   — auto-apply threshold
```

## Phase 1 — Gather Findings

1. PR# provided → `gh pr view <#> --json comments --jq '.comments[].body'`; parse Conventional Comments findings
2. ¬PR# → scan conversation for most recent `/review` output
3. F = ∅ → inform, halt
4. ∀ f: parse into structured form: label, file:line, agent, root cause, solutions, C(f)
5. Malformed finding (missing fields ∨ C ∉ ℤ ∩ [0,100]) → C(f) := 0

## Phase 2 — Triage + Verify

**Split:**
```
Q_auto = {f ∈ F | cat(f) ∈ actionable ∧ C(f) ≥ T ∧ |A(f)| ≥ 2}
Q_1b1  = {f ∈ F | cat(f) ∈ actionable ∧ f ∉ Q_auto}
skipped = {f ∈ F | cat(f) = praise}
```

**Verify single-agent high-confidence:** ∀ f where cat(f) ∈ actionable ∧ C(f) ≥ T ∧ |A(f)| = 1:
- Spawn fresh verifier agent (different domain from src(f))
- Verifier confirms (C_v ≥ T) → f → Q_auto, |A(f)| := 2
- Verifier rejects (C_v < T) → f → Q_1b1
- Batch verifications ∥ (group by domain, 1 verifier/domain)

∀ f ∈ Q_auto: solution(f) := Solution 1 (recommended).

Display:
```
── Fix Plan ──
Auto-apply: |Q_auto| finding(s) (C≥80, 2+ agents)
1b1 review: |Q_1b1| finding(s)
Skipped:    |skipped| (praise)
```

Q_auto = ∅ ∧ Q_1b1 = ∅ → inform ("No actionable findings"), halt.

## Phase 3 — Auto-Apply (High Confidence)

Q_auto = ∅ → skip to Phase 4.

Apply all inline (sequential, ¬spawn agents — already verified by 2+ agents):

∀ f ∈ Q_auto:
- Apply recommended solution directly
- succeeds → `[applied]`
- fails → stash restore, mark `[failed]`, demote to Q_1b1

**Summary:**
```
── Auto-Apply Results ──
  1. [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
  2. [failed → 1b1] nitpick: Unused import in dashboard.tsx:3 (85%) -- test failure
Applied: N | Failed → 1b1: M
```

## Phase 4 — Push Auto-Applied Changes

∃ applied changes → validate + commit + push:
1. Run `{commands.lint} && {commands.test}` — quality gate
   - Fail → auto-fix + retry (max 3); still failing → halt
2. Stage specific files only (¬`git add -A`)
3. Commit: `fix(<scope>): auto-apply N review findings` + list in body
4. `git push`

¬∃ applied changes → skip.

## Phase 5 — 1b1 Walkthrough

Q_1b1 = ∅ → skip to Phase 7.

∀ f ∈ Q_1b1, sequentially (excluding praise):

**Present:**
```
── Finding {i}/{|Q_1b1|}: {cat(f)} ──
{cat} — C(f)% — {src(f)}
  {file}:{line}

Root cause: {root cause}

Recommended: Solution 1 — {rationale}
Alternative: Solution 2 — {rationale}
```

f demoted from auto-apply → prepend: `Auto-apply failed: {reason}`

**AskUserQuestion** (single question per finding):
- **Solution 1** (recommended)
- **Solution 2**
- **Defer** — create GitHub issue for later
- **Skip**

Defer → `gh issue create --title "{cat}: {summary}" --body "{details}"` immediately.

**Walkthrough summary:**
```
── Walkthrough Complete ──
Accepted: N | Deferred (issues created): M | Skipped: K
```

acc = {f ∈ Q_1b1 | decision(f) ∈ {solution1, solution2}}, each with chosen solution.

## Phase 6 — Apply 1b1 Decisions

acc = ∅ → skip to Phase 7.

**Dispatch:**
```
|acc| ≤ 2  → orchestrator applies directly (inline)
|acc| ≥ 3  → spawn agent(s) per Phase 3 dispatch + batching rules
```

Payload = findings + **chosen solution text** + diff context + "fix using chosen solution; re-read files before editing; run lint + tests after each fix."

Fixer constraints:
- Re-read all target files before editing (Phase 3 edits may have changed them)
- CI fail → retry max 3; mark `[failed]` if stuck

## Phase 7 — Final Push + Approve

1. ∃ changes from Phase 6 → validate + commit + push:
   - Run `{commands.lint} && {commands.test}` — quality gate
   - Fail → auto-fix + retry (max 3); still failing → halt
   - Stage specific files only (¬`git add -A`)
   - Commit: `fix(<scope>): apply N review findings from 1b1` + list in body
   - `git push`

2. ∃ PR → label as reviewed:
   - `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"`

## Phase 8 — Post Follow-Up Comment

∄ PR → skip.

`/tmp/review-fixes.md` → `gh pr comment <#> --body-file /tmp/review-fixes.md`

```markdown
## Review Fixes Applied

**Auto-applied (C≥80, 2+ agents):** N finding(s)
**Applied via 1b1:** M finding(s)
**Deferred (issues created):** J finding(s)
**Skipped:** K finding(s)
**Failed:** L finding(s)

### Auto-Applied
- [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)

### Applied (1b1)
- [applied] suggestion: Missing error boundary in dashboard.tsx:15

### Deferred
- nitpick: Variable naming in auth.service.ts:88 → #123

### Failed
- [failed] nitpick: Unused import in dashboard.tsx:3 -- test failure
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| F = ∅ | Inform, halt |
| Q_auto = ∅ ∧ Q_1b1 = ∅ | Inform, halt |
| All praise | Inform ("nothing actionable"), halt |
| C(f) ≥ T ∧ \|A(f)\| = 1 | Verify → confirmed: auto-apply / rejected: 1b1 |
| Auto-apply fails | Demote to Q_1b1 |
| 1b1 fix fails | Mark `[failed]`, continue |
| Quality gate fails after 3 retries | Halt, leave changes uncommitted |
| ¬∃ PR | Skip Phase 8, local commit only, no label |

## Safety Rules

1. Human can `git diff` anytime — applied changes visible in working tree
2. ∃ PR → must post follow-up comment (Phase 8)
3. Fixer agents ¬have implementation context from current session → spawn fresh
4. Stage specific files only — ¬`git add -A` (risk of including .env, secrets)
5. ¬auto-merge — label `reviewed` only, human merges

$ARGUMENTS

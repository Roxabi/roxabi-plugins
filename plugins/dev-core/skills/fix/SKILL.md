---
name: fix
argument-hint: '[#PR]'
description: 'Apply review findings — auto-apply all with recommended solution, no questions. Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these".'
version: 0.3.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task, Skill
---

# Fix

Auto-apply all actionable review findings using the recommended solution. Zero questions — findings were already reviewed in `/review`.

**⚠ Fully automatic pipeline. ¬stop between phases. Stop only on: unrecoverable failure, or Phase 6 completion.**

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
actionable = {issue, suggestion, todo, nitpick}
skip_cats  = {thought, question, praise}
```

## Phase 1 — Gather Findings

1. PR# provided → `gh pr view <#> --json comments --jq '.comments[].body'`; parse Conventional Comments findings
2. ¬PR# → scan conversation for most recent `/review` output
3. F = ∅ → inform, halt
4. ∀ f: parse into structured form: label, file:line, agent, root cause, solutions, C(f)
5. Malformed finding (missing fields ∨ C ∉ ℤ ∩ [0,100]) → C(f) := 0

## Phase 2 — Triage

```
apply_queue = {f ∈ F | cat(f) ∈ actionable}
skipped     = {f ∈ F | cat(f) ∈ skip_cats}
```

∀ f ∈ apply_queue: solution(f) := Solution 1 (recommended). No user choice — `/review` already presented alternatives.

Display:
```
── Fix Plan ──
Applying: |apply_queue| finding(s) with recommended solution
Skipping: |skipped| non-actionable (praise/thought/question)
```

apply_queue = ∅ → inform ("No actionable findings"), halt.

## Phase 3 — Auto-Apply All

**Dispatch strategy:**

```
|apply_queue| ≤ 2  → orchestrator applies directly (inline, ¬spawn agent)
|apply_queue| ≥ 3  → spawn agent(s) per dispatch table below
```

**Agent dispatch (|apply_queue| ≥ 3):**

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

**Apply:**

*Inline (≤ 2):* ∀ f ∈ apply_queue (sequential):
- succeeds → `[applied]`
- fails → stash restore for that finding, mark `[failed]`, continue with next

*Agent (≥ 3):* Spawn per dispatch. Payload = findings in scope + recommended solution text + diff context + "fix each finding using the recommended solution; re-read files before editing; run lint + tests after each fix."
- succeeds → `[applied]` per finding
- fails on f → `[failed]`, continue with remaining
- Agent constraints: re-read files before editing; CI fail → retry max 3; mark `[failed]` if stuck

**Summary:**
```
── Applied ──
  1. [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
  2. [applied] suggestion: Missing error boundary in dashboard.tsx:15 (83%)
  3. [failed] nitpick: Unused import in dashboard.tsx:3 (85%) -- test failure
Applied: N | Failed: M | Skipped: K
```

## Phase 4 — Validate + Auto-Fix + Commit + Push

1. Run `{commands.lint} && {commands.test}` — full quality gate
   - Pass → continue
   - Fail → attempt inline auto-fix of the reported error; re-run gate; max 3 retries
   - Still failing after 3 retries → display failure output, halt (leave changes uncommitted for manual review)
2. Stage specific files only (¬`git add -A`)
3. Commit per CLAUDE.md conventions; include list of applied findings in body
4. `git push`

## Phase 5 — Post Follow-Up Comment

∄ PR → skip.

`/tmp/review-fixes.md` → `gh pr comment <#> --body-file /tmp/review-fixes.md`

```markdown
## Review Fixes Applied

**Applied:** N finding(s)
**Failed:** M finding(s)
**Skipped (non-actionable):** K finding(s)

### Applied
- [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
- [applied] suggestion: Missing error boundary in dashboard.tsx:15 (83%)

### Failed
- [failed] nitpick: Unused import in dashboard.tsx:3 -- test failure after fix
```

## Phase 6 — Merge Gate

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
2. `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"`
3. Squash merge on green CI: `gh pr merge <#> --squash`

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| F = ∅ | Inform, halt |
| apply_queue = ∅ | Inform, halt |
| All findings are praise/thought/question | Inform ("nothing actionable"), halt |
| Auto-fix breaks tests/lint | Auto-retry up to 3×, then halt for manual review |
| Fixer timeout/crash/cannot-fix | Mark `[failed]`, continue with remaining |
| C(f) = 0 (malformed) | Still applied if cat ∈ actionable (solution exists) |
| ¬∃ PR | Skip Phase 5, local commit only |

## Safety Rules

1. ¬approve PRs on GitHub, ¬auto-merge (merge gate is the only question)
2. Human can `git diff` anytime — applied changes visible in working tree
3. ∃ PR → must post follow-up comment (Phase 5)
4. Fixer agents ¬have implementation context from current session → spawn fresh
5. Stage specific files only — ¬`git add -A` (risk of including .env, secrets)

$ARGUMENTS

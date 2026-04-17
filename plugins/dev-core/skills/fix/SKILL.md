---
name: fix
argument-hint: '[#PR]'
description: 'Apply review findings — auto-apply high-confidence, 1b1 for rest, then batch-apply. Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these" | "apply review comments" | "apply the review" | "fix the review issues" | "address review feedback" | "fix PR comments".'
version: 0.4.0
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task, Skill, ToolSearch
---

# Fix

Two-pass pipeline: auto-apply high-C findings (C≥T, 2+ agents), then 1b1 for rest.

**⚠ Continuous pipeline. ¬stop between phases. Stop only on: unrecoverable failure or Phase 8 completion.**

```
/fix        → findings from conversation context
/fix #42    → gather findings from PR #42 comments
```

Let:
  F := all findings | f ∈ F | C(f) ∈ [0,100] ∩ ℤ — confidence
  A(f) := {agents that flagged f} | cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  src(f) := originating agent | actionable := {issue, suggestion, todo, nitpick}
  T := 80 — auto-apply threshold
  Q_auto := {f | cat(f) ∈ actionable ∧ C(f) ≥ T ∧ |A(f)| ≥ 2}
  Q_1b1 := {f | cat(f) ∈ actionable ∧ f ∉ Q_auto}
  O_push(N, scope, msg) { lint+test gate (max 3 retries) → stage specific files (¬`git add -A`) → commit `fix(<scope>): <msg>` → `git push` }

## Phase 1 — Gather Findings

1. PR# → `gh pr view <#> --json comments --jq '.comments[].body'`; parse Conventional Comments
2. ¬PR# → scan conversation for latest `/code-review` output
3. F = ∅ → halt
4. ∀ f: parse → label, file:line, agent, root cause, solutions, C(f)
5. Malformed (missing fields ∨ C ∉ ℤ ∩ [0,100]) → C(f) := 0

## Phase 2 — Triage + Verify

Split into Q_auto, Q_1b1, skipped (praise).

**Single-agent high-C verification:** ∀ f where cat(f) ∈ actionable ∧ C(f) ≥ T ∧ |A(f)| = 1:
- Spawn fresh verifier (different domain from src(f))
- C_v ≥ T → f → Q_auto, |A(f)| := 2
- C_v < T → f → Q_1b1
- Batch ∥ (group by domain, 1 verifier/domain)

∀ f ∈ Q_auto: solution(f) := Solution 1 (recommended).

Display:
```
── Fix Plan ──
Auto-apply: |Q_auto| finding(s) (C≥80, 2+ agents)
1b1 review: |Q_1b1| finding(s)
Skipped:    |skipped| (praise)
```

Q_auto = ∅ ∧ Q_1b1 = ∅ → "No actionable findings", halt.

## Phase 3 — Auto-Apply (High Confidence)

Q_auto = ∅ → skip to Phase 4.

∀ f ∈ Q_auto (sequential, inline — already verified by 2+ agents):
- Apply recommended solution
- succeeds → `[applied]`
- fails → stash restore, `[failed]`, demote to Q_1b1

```
── Auto-Apply Results ──
  1. [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)
  2. [failed → 1b1] nitpick: Unused import in dashboard.tsx:3 (85%) -- test failure
Applied: N | Failed → 1b1: M
```

## Phase 4 — Push Auto-Applied

∃ applied → O_push(N, scope, "auto-apply N review findings" + list in body). Fail after 3 → halt.
¬∃ applied → skip.

## Phase 5 — 1b1 Walkthrough

Q_1b1 = ∅ → skip to Phase 7.

∀ f ∈ Q_1b1 sequentially (excluding praise):

```
── Finding {i}/{|Q_1b1|}: {cat(f)} ──
{cat} — C(f)% — {src(f)}
  {file}:{line}

Root cause: {root cause}

Recommended: Solution 1 — {rationale}
Alternative: Solution 2 — {rationale}
```

Demoted from auto-apply → prepend: `Auto-apply failed: {reason}`

→ DP(A)(single per finding): **Solution 1** | **Solution 2** | **Defer** (→ create issue) | **Skip**

Defer → `gh issue create --title "{cat}: {summary}" --body "{details}"` immediately.

```
── Walkthrough Complete ──
Accepted: N | Deferred (issues created): M | Skipped: K
```

acc := {f ∈ Q_1b1 | decision ∈ {solution1, solution2}}, each with chosen solution.

## Phase 6 — Apply 1b1 Decisions

acc = ∅ → skip to Phase 7.

```
|acc| ≤ 2  → orchestrator applies directly (inline)
|acc| ≥ 3  → spawn agent(s) per dispatch + batching rules
```

Payload = findings + chosen solution + diff context + "fix using chosen solution; re-read files before editing; lint + test after each fix."

Fixer constraints: re-read targets before editing (Phase 3 may have changed them). CI fail → retry max 3; `[failed]` if stuck.

## Phase 7 — Final Push + Approve

1. ∃ Phase 6 changes → O_push(N, scope, "apply N review findings from 1b1" + list in body). Fail after 3 → halt.
2. ∃ PR → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"`

## Phase 8 — Post Follow-Up Comment

∄ PR → skip.

Tempfile per `${CLAUDE_PLUGIN_ROOT}/../shared/references/tempfile-convention.md`:
```bash
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
TMPDIR=$(mktemp -d -t "dev-core-review-fixes-PR${PR}-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
BODY="$TMPDIR/body.md"
```
Write summary (below) to `"$BODY"` → `gh pr comment "$PR" --body-file "$BODY"`

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
| F = ∅ | Halt |
| Q_auto = ∅ ∧ Q_1b1 = ∅ | Halt |
| All praise | "Nothing actionable", halt |
| C(f) ≥ T ∧ \|A(f)\| = 1 | Verify → confirmed: auto / rejected: 1b1 |
| Auto-apply fails | Demote to Q_1b1 |
| 1b1 fix fails | `[failed]`, continue |
| Quality gate fails 3× | Halt, leave uncommitted |
| ¬∃ PR | Skip Phase 8, local only, no label |

## Safety Rules

1. Human can `git diff` anytime — applied changes visible in working tree
2. ∃ PR → must post follow-up comment (Phase 8)
3. Fixer agents ¬have implementation context → spawn fresh
4. Stage specific files only — ¬`git add -A` (risk of .env, secrets)
5. ¬auto-merge — label `reviewed` only, human merges

## Chain Position

- **Phase:** Verify
- **Predecessor:** `/code-review` (findings)
- **Successor:** `/code-review` (re-review after fix) — LOOP
- **Class:** loop (bounded, max 2 iterations)

## Task Integration

- `/dev` owns the dev-pipeline task lifecycle externally
- Sub-tasks created: none directly (findings are ephemeral — tracked in-skill via F, Q_auto, Q_1b1)
- Follow-up tasks: on success → `TaskCreate` new review task with `metadata: { kind: "dev-pipeline", step: "review", follow_up: true, iteration: N+1, blockedBy: [this.id] }`

## Exit

- **Success via `/dev`:** fixes applied + committed + pushed + PR comment posted → `TaskCreate` follow-up review task → return silently. `/dev` picks up the new review task.
- **Success standalone:** print summary (Applied/Skipped/Deferred/Failed) + `Next: /code-review` (re-verify). Stop.
- **Failure (quality gate, ¬findings, unrecoverable):** return error. `/dev` presents Retry | Skip | Abort.
- **Loop cap:** `metadata.iteration ≥ 2` on entry → refuse another iteration; return with message "Max fix iterations reached — resolve remaining manually". `/dev` presents Abort.

$ARGUMENTS

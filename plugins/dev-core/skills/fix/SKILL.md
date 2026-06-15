---
name: fix
argument-hint: '[#PR]'
description: 'Apply review findings — auto-apply high-confidence, 1b1 for rest, then batch-apply. Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these" | "apply review comments" | "apply the review" | "fix the review issues" | "address review feedback" | "fix PR comments".'
version: 0.4.1
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, WebFetch, Task, Skill, ToolSearch
---

# Fix

## Success

I := ∀ f ∈ actionable → applied ∨ deferred (issue ∃) ∨ skipped (user) ∧ PR comment posted
V := `gh pr view {N} --comments | grep "## Review Fixes Applied"`

Two-pass pipeline: auto-apply high-C findings (C≥T, 2+ agents), then 1b1 for rest.

**⚠ Continuous pipeline. ¬stop between phases. Stop only on: unrecoverable failure or Phase 8 completion.**

```
/fix        → findings from conversation context
/fix #42    → gather findings from PR #42 comments
```

## Pipeline

| Phase | ID | Required | Verifies via | Notes |
|-------|----|----------|---------------|-------|
| 1 | gather | ✓ | F parsed | — |
| 2 | triage | ✓ | Q_auto + Q_1b1 split | — |
| 3 | auto-apply | — | applied count | Q_auto = ∅ → skip |
| 4 | push-auto | — | `git push` success | ¬applied → skip |
| 5 | walkthrough | — | decisions recorded | Q_1b1 = ∅ → skip |
| 6 | apply-1b1 | — | applied count | acc = ∅ → skip |
| 7 | final-push | ✓ | `git push` success | — |
| 8 | post-comment | — | comment posted | ∄ PR → skip |

## Pre-flight

Success: ∀ actionable → applied ∨ deferred ∧ PR comment posted
Evidence: `gh pr view {N} --comments | grep "## Review Fixes Applied"`
Steps: gather → triage → auto-apply → walkthrough → apply-1b1 → final-push → post-comment
¬clear → STOP + ask: "Do you have review findings to fix?"

Let:
  F := all findings | f ∈ F | C(f) ∈ [0,100] ∩ ℤ — confidence
  A(f) := {agents that flagged f} | cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  src(f) := originating agent | actionable := {issue, suggestion, todo, nitpick}
  T := 80 — auto-apply threshold
  Q_auto := {f | cat(f) ∈ actionable ∧ C(f) ≥ T ∧ |A(f)| ≥ 2}
  Q_1b1 := {f | cat(f) ∈ actionable ∧ f ∉ Q_auto}
  O_push(N, scope, msg) { lint+test gate (max 3 retries) → stage specific files (¬`git add -A`) → commit `fix(<scope>): <msg>` → `git push` }
  D_subsumption := {d ∈ D | d.tag = "subsumption-violation"}

## Diagnostics Bus

```
D := []   — ordered list of records; insertion-ordered; duplicates permitted iff (tag, file, line) tuple differs
d ∈ D := {tag: str, file: str, line: int, description: str, phase: str}
```

- **Initial value:** `[]` (empty)
- **Append-only invariant:** entries are never removed or mutated after insertion
- **Lifecycle:** written in Phase 1 (enforcement checks); rendered in Phase 8 when `|D| > 0`. D is per-invocation and ephemeral.

- **Future invariant slots:** agent_src trust (append here when landed) (when promoting, set `phase` to non-empty `^[a-z0-9-]+$`; do not leave angle-bracket placeholders in shipped records)

## Phase 0 — Load Taxonomy

Read `${CLAUDE_PLUGIN_ROOT}/skills/code-review/review-classes.yml` → extract `classes[].class` slugs → `canonical_slugs`. (Canonical YAML ships with `code-review`; `fix` reads it cross-skill — single source, ¬duplicate copy that could drift.)
File absent, unreadable, or parse error → HALT: `[taxonomy-error] review-classes.yml {reason} at ${CLAUDE_PLUGIN_ROOT}/skills/code-review/review-classes.yml — reinstall dev-core plugin.`
Used in Phase 1 steps 4–5 to validate class[] values against the live YAML (¬LLM memory).


## Phase 1 — Gather Findings

1. PR# → `gh pr view <#> --json comments,closingIssuesReferences`; parse Conventional Comments from `.comments[].body`; capture `SOURCE_ISSUE` = `.closingIssuesReferences[0].number` (∅ if none — used in Phase 5 Defer to wire blocked-by). When `SOURCE_ISSUE ≠ ∅`, also resolve `SOURCE_PARENT` = `gh api graphql -f query='query{repository(owner:"<O>",name:"<R>"){issue(number:<SOURCE_ISSUE>){parent{number}}}}' --jq '.data.repository.issue.parent.number // empty'` — used in Phase 5 Defer to wire deferred issue as **sibling** under shared parent (see `roxabi-issues:issue-triage` "Deferred Follow-Ups — Sibling Rule").
2. ¬PR# → scan conversation for latest `/code-review` output
3. F = ∅ → halt
4. ∀ f: parse → label, file:line, agent, root cause, class[], raw_callsites[], solutions, C(f)
   - `class[]` — 0–N canonical slugs from `review-classes.yml` + 0–1 `candidate/<slug>`; absent field → class[] = []
   - `raw_callsites[]` — [{file, line}] list; required when class[] ≠ []; absent when class[] = []
5. Malformed (missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label not in canonical list and not `candidate/*` ∨ `candidate/<slug>` violates `^candidate/[a-z][a-z0-9-]{1,48}$` ∨ class[] ≠ [] ∧ raw_callsites[] = []) → C(f) := 0
   Step 5 fires first; step 5b applies only to findings that passed step 5 (C(f) ≠ 0 after step 5).
5b. [only if step 5 did not fire for f] Subsumption strip: ∃ `bare-except` ∧ `missing-error-handling` in same finding's class[] → strip `missing-error-handling`; D.append({tag: "subsumption-violation", file: f.file, line: f.line, description: "bare-except subsumes missing-error-handling, duplicate tag stripped", phase: "1"}); ¬set C(f) := 0

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

Defer → create linked follow-up issue via `roxabi-issues:issue-triage` (¬raw `gh issue create` — global rule: issue mutations go through the skill so blocked-by + parent are wired atomically). **Sibling rule:** the deferred issue is a sibling of `SOURCE_ISSUE` under their shared parent (¬child of `SOURCE_ISSUE`) — see `roxabi-issues:issue-triage` SKILL "Deferred Follow-Ups — Sibling Rule":

Invoke the `roxabi-issues:issue-triage` skill in **create** mode (requires the **roxabi-issues** plugin installed — issue-triage relocated dev-core → roxabi-issues, 2026-06-09). Pass:

- `--title "{cat}: {summary}"`
- `--body "{details}"`
- `--blocked-by "#${SOURCE_ISSUE}"`  — omit when `SOURCE_ISSUE = ∅`
- `--parent "#${SOURCE_PARENT}"`  — omit when `SOURCE_PARENT = ∅`

`SOURCE_ISSUE` (captured Phase 1, step 1) → blocked-by ensures the deferred finding is traceable back to the issue whose review surfaced it. `SOURCE_PARENT` (also captured Phase 1, step 1) → parent makes the deferred issue a sibling of `SOURCE_ISSUE` under the same epic, so `gh issue view <epic>` shows the full fan-out flat. ∄ SOURCE_ISSUE → create without `--blocked-by` or `--parent`; `{details}` MUST include `**Origin:** PR #<N>` so traceability is preserved. ∄ SOURCE_PARENT (SOURCE_ISSUE is top-level) → create without `--parent` (the deferred issue is also top-level).

`{details}` template:
```markdown
**Origin:** PR #<N> review <comment-id> (deferred per `/fix` walkthrough).

{root-cause + agent finding text}

**Action:** {chosen path or open question}
```

`issue-triage` `--blocked-by` accepts issues only (¬PRs) — when the source review is on a PR with no closing-issue reference, fall back to no `--blocked-by` and rely on the `Origin: PR #N` body line.

```
── Walkthrough Complete ──
Accepted: N | Deferred (issues created): M | Skipped: K
```

acc := {f ∈ Q_1b1 | decision ∈ {solution1, solution2}}, each with chosen solution.

## Phase 6 — Apply 1b1 Decisions

acc = ∅ → skip to Phase 7.

Group acc by class, then dispatch per class:

```
classes = { c | ∃ f ∈ acc: cls(f) = c }

∀ class ∈ classes:
  files_in_class = unique({ file(f) | f ∈ acc, cls(f) = class })

  |files_in_class| ≤ 3  →  single fixer agent for the class
  |files_in_class| > 3  →  shard by file: ⌈|files_in_class| / 3⌉ fixer agents
                            each fixer owns ≤3 files of the same class

unclassified = { f ∈ acc | cls(f) = ∅ }
¬∅ → single fixer agent for unclassified findings (same path as |files_in_class| ≤ 3)
```

Fixer payload per agent:
- findings (with class + raw_callsites) for owned files
- chosen solution per finding
- diff context for owned files
- instructions: "re-read targets before editing; lint + test after each fix; sweep file for same-class anti-pattern — justify or fix any uncited hit."

Fixer constraints: re-read targets before editing (Phase 3 may have changed them). CI fail → retry max 3; `[failed]` if stuck.

`pattern-class` findings (Lane B tag) → same class-shard dispatch as Lane A findings.
_(TODO: `pattern-class` tag and Lane B defined in Slice 3 — targeted recall. Until Slice 3 lands, this clause is a forward-reference only; `pattern-class` is not yet in review-classes.yml.)_

## Phase 6.5 — Falsification Gate

∀ class ∈ classes (from Phase 6):

Run falsification gate per `${CLAUDE_SKILL_DIR}/falsification.md`. Gate emits boolean per class:

```
pass  →  fix accepted; continue
fail  →  fix tautological (RC-1); re-open each failed finding for that class
          (max 1 falsification-retry per finding — independent of CI retry budget in Phase 6)
```

New findings surfaced during falsification → **parking lot**: file as candidate finding for next PR cycle. ¬reopen current `/fix` loop. ¬increment 2-iter cap. Applies to same-class and cross-class anti-patterns alike.

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
**Enforcement diagnostics:** |D_subsumption| subsumption violation(s) (0 if none)

### Auto-Applied
- [applied] issue(blocking): SQL injection in users.service.ts:42 (92%)

### Applied (1b1)
- [applied] suggestion: Missing error boundary in dashboard.tsx:15

### Deferred
- nitpick: Variable naming in auth.service.ts:88 → #123

### Failed
- [failed] nitpick: Unused import in dashboard.tsx:3 -- test failure

### Parking Lot
_(omit section when parking_lot = ∅)_
- {class}: {file}:{line} — {description} (falsification-gate)

### Enforcement diagnostics
_(omit section when |D| = 0; group by tag when |distinct tags| > 1 using **[tag]** (N) sub-groupings)_
- `[subsumption-violation]` `auth.service.ts`:`42` — bare-except subsumes missing-error-handling, duplicate tag stripped
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
| cls(f) = ∅ for some f ∈ acc | Route to `unclassified` fixer agent (single agent, ≤3 files path) |

## Safety Rules

1. Human can `git diff` anytime — applied changes visible in working tree
2. ∃ PR → must post follow-up comment (Phase 8)
3. Fixer agents ¬have implementation context → spawn fresh
4. Stage specific files only — ¬`git add -A` (risk of .env, secrets)
5. Merge via the gate: label `reviewed` → auto-merge merges (merge commit) on green. ¬manual `gh pr merge` while any check is IN_PROGRESS/QUEUED

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

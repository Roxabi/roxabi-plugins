---
name: fix
argument-hint: '[#PR]'
description: >-
  OMP-only — apply review findings: auto-apply high-confidence, 1b1 for the rest, every edit made inline.
  Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these" | "apply review comments" | "apply the review" | "fix the review issues" | "address review feedback" | "fix PR comments".
version: 0.1.0
---

# Fix

## Success

I := ∀ f ∈ actionable → applied ∨ deferred (issue ∃) ∨ skipped (user) ∧ PR comment posted
V := `gh pr view {N} --comments | grep "## Review Fixes Applied"`

Two-pass pipeline: auto-apply high-C findings (C≥T, 2+ agents), then 1b1 for the rest.

**⚠ Continuous pipeline. ¬stop between phases. Stop only on: unrecoverable failure or Phase 8 completion.**

```
/skill:fix        → findings from conversation context
/skill:fix #42    → gather findings from PR #42 comments
```

**You apply every fix yourself.** There is no `R-fixer` in this plugin (ADR-020 §7) and nothing replaces it: Phase 3 and Phase 6 edit files inline, in this session, with the diff visible in the working tree. ¬spawn a fixer, ¬delegate the edit.

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

## Phase 0 — Load Taxonomy

Read `skill://dev-review/review-classes.yml` → extract `classes[].class` slugs → `canonical_slugs`. (The canonical YAML ships with `dev-review`; this skill reads it cross-skill — single source, ¬a duplicate copy that could drift.)

File absent, unreadable, or parse error → **HALT**: `[taxonomy-error] review-classes.yml {reason} at skill://dev-review/review-classes.yml — reinstall omp-build.`

This edge is real and load-bearing: without the live taxonomy, Phase 1 steps 4–5 would validate `class[]` against model memory, and a hallucinated slug would pass. HALT, never fall back.

Used in Phase 1 steps 4–5 to validate `class[]` values against the live YAML (¬LLM memory).

## Phase 1 — Gather Findings

1. PR# → `gh pr view <#> --json comments,closingIssuesReferences`; parse Conventional Comments from `.comments[].body`; capture `SOURCE_ISSUE` = `.closingIssuesReferences[0].number` (∅ if none — used in Phase 5 Defer to wire blocked-by). When `SOURCE_ISSUE ≠ ∅`, also resolve `SOURCE_PARENT`:
   ```bash
   gh api graphql -f query='query{repository(owner:"<O>",name:"<R>"){issue(number:<SOURCE_ISSUE>){parent{number}}}}' \
     --jq '.data.repository.issue.parent.number // empty'
   ```
   — used in Phase 5 Defer to wire the deferred issue as a **sibling** under the shared parent.
1a. **Strip historical finding-verifier HTML** — ∀ comment body: remove everything from `<summary>Filtered by finding-verifier` through the next `</details>` **before** parsing. That keep/drop filter is retired; `skill://dev-review` keeps findings after deterministic dedup (especially blockers) and does ¬drop on C alone. Strip leftover HTML so old PR comments cannot re-ingest dropped rows.
2. ¬PR# → scan conversation for the latest `dev-review` output
3. F = ∅ → halt
4. ∀ f: parse → label, file:line, agent, root cause, class[], raw_callsites[], solutions, C(f)
   - `class[]` — 0–N canonical slugs from `review-classes.yml` + 0–1 `candidate/<slug>`; absent field → class[] = []
   - `raw_callsites[]` — [{file, line}] list; required when class[] ≠ []; absent when class[] = []
5. Malformed (missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label not in canonical list and not `candidate/*` ∨ `candidate/<slug>` violates `^candidate/[a-z][a-z0-9-]{1,48}$` ∨ class[] ≠ [] ∧ raw_callsites[] = []) → C(f) := 0
   Step 5 fires first; step 5b applies only to findings that passed step 5 (C(f) ≠ 0 after step 5).
5b. [only if step 5 did not fire for f] Subsumption strip: ∃ `bare-except` ∧ `missing-error-handling` in the same finding's class[] → strip `missing-error-handling`; D.append({tag: "subsumption-violation", file: f.file, line: f.line, description: "bare-except subsumes missing-error-handling, duplicate tag stripped", phase: "1"}); ¬set C(f) := 0

## Phase 2 — Triage + Verify

Split into Q_auto, Q_1b1, skipped (praise).

**Single-agent high-C verification:** ∀ f where cat(f) ∈ actionable ∧ C(f) ≥ T ∧ |A(f)| = 1:
- Spawn one fresh verifier through `task`, with a **different posture** from src(f): `R-adversarial` when src(f) ≠ `R-adversarial`, else `R-advisor`. Bare agent name, no prefix — the five review roles plus `R-advisor` are the spawnable set in this plugin.
- C_v ≥ T → f → Q_auto, |A(f)| := 2
- C_v < T → f → Q_1b1
- Batch ∥ — one `task` call carrying every verifier, one verifier per posture

∀ f ∈ Q_auto: solution(f) := Solution 1 (recommended).

**Proxy-fix ban** (cls(f) ∈ {test-tautology, vacuous-guard, parallel-path-drift}): a Solution 1 that widens a denylist, adds a grep, or copies an inventory/`validate:full` list is **invalid** — demote to Q_1b1 with note "oracle/SSoT required". Required fix: change the oracle / single SSoT (matcher, parser, one `package.json` script).

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

∀ f ∈ Q_auto (sequential, **inline in this session** — already verified by 2+ agents):
- Re-read the target before editing, then apply the recommended solution yourself
- succeeds → `[applied]`
- fails → restore the file, `[failed]`, demote to Q_1b1

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

→ present choice (single per finding): **Solution 1** | **Solution 2** | **Defer** (→ create issue) | **Skip**

### Defer — the follow-up is a sibling, never a child

Create the follow-up through `Skill(skill: "issue-triage:issue-triage")` in **create** mode (requires the **issue-triage** plugin installed). Never raw `gh issue create`: issue mutations go through the skill so blocked-by and parent are wired atomically, and a `Blocked by: #12` line in a body is invisible to `gh issue view` and to the frontier query.

`docs/agents/issue-tracker.md` § "Deferred follow-ups are siblings":

> A follow-up deferred out of issue A is a **sibling** of A under their shared parent, blocked-by A — never a child of A. This keeps the epic's fan-out flat instead of building a nested cascade. Planned decomposition (epic → phase) *is* parent/child; post-hoc deferral is not.

So the deferred issue takes the **origin's** parent, not the origin:

- `--title "{cat}: {summary}"`
- `--body "{details}"`
- `--blocked-by "#${SOURCE_ISSUE}"` — the origin. Omit when `SOURCE_ISSUE = ∅`
- `--parent "#${SOURCE_PARENT}"` — the origin's **parent**. Omit when `SOURCE_PARENT = ∅`
- `--size`, `--type` — per `issue-triage`; a ticket with no `size:` label silently downgrades its own future review to F-lite

`--parent "#${SOURCE_ISSUE}"` is the bug this section exists to prevent: it nests the deferral under its origin and the epic's fan-out stops being flat.

∄ SOURCE_ISSUE → create without `--blocked-by` or `--parent`; `{details}` MUST include `**Origin:** PR #<N>` so traceability survives. ∄ SOURCE_PARENT (SOURCE_ISSUE is top-level) → create without `--parent`; the deferred issue is top-level too.

`issue-triage` `--blocked-by` accepts issues only (¬PRs) — when the source review is on a PR with no closing-issue reference, fall back to no `--blocked-by` and rely on the `Origin: PR #N` body line.

`{details}` template:
```markdown
**Origin:** PR #<N> review <comment-id> (deferred per `fix` walkthrough).

{root-cause + agent finding text}

**Action:** {chosen path or open question}
```

```
── Walkthrough Complete ──
Accepted: N | Deferred (issues created): M | Skipped: K
```

acc := {f ∈ Q_1b1 | decision ∈ {solution1, solution2}}, each with chosen solution.

## Phase 6 — Apply 1b1 Decisions (inline)

acc = ∅ → skip to Phase 7.

Group acc by class and work one class at a time — the grouping is what makes the same-class sweep possible, not a sharding key for agents:

```
classes = { c | ∃ f ∈ acc: cls(f) = c }
∀ class ∈ classes:
  files_in_class = unique({ file(f) | f ∈ acc, cls(f) = class })
unclassified = { f ∈ acc | cls(f) = ∅ }   → handled last, one finding at a time
```

Per class, in this session:

1. Re-read every target — Phase 3 may have changed it.
2. Apply the chosen solution per finding.
3. Sweep the touched files for the same-class anti-pattern: justify or fix any uncited hit.
4. Run lint + the tests covering the changed files. CI fail → retry max 3; `[failed]` if still red.

**Proxy-fix ban** (class ∈ {test-tautology, vacuous-guard, parallel-path-drift}):
**Forbidden:** widen a denylist, add another grep, copy another inventory/`validate:full` list.
**Required:** change the oracle / single SSoT (matcher, parser, one `package.json` script).
A proxy "fix" → `[failed]`, do not apply.

`pattern-class` findings (Lane B tag) → same class-grouped handling as Lane A findings. Cross-chunk recall extra callsites come from a fresh read-only worker inside `skill://dev-review`, not from a durable agent; the tags on the finding are unchanged.

## Phase 6.5 — Falsification Gate

∀ class ∈ classes (from Phase 6):

Run the falsification gate per `skill://fix/falsification.md`. It emits a boolean per class:

```
pass  →  fix accepted; continue
fail  →  fix tautological (RC-1); re-open each failed finding for that class
          (max 1 falsification-retry per finding — independent of the CI retry budget in Phase 6)
```

This gate is a **local procedure** — delete the guard the fix introduced, re-run the test, restore. It is not the executable falsify oracle cut by ADR-020 §8: it has no script, no artifact, and no roster input. Nothing here reads a verdict file.

New findings surfaced during falsification → **parking lot**: file as a candidate finding for the next PR cycle. ¬reopen the current fix loop. ¬increment the 2-iter cap. Applies to same-class and cross-class anti-patterns alike.

## Phase 7 — Final Push + Approve

1. ∃ Phase 6 changes → O_push(N, scope, "apply N review findings from 1b1" + list in body). Fail after 3 → halt.
2. ∃ PR → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"`

## Phase 8 — Post Follow-Up Comment

∄ PR → skip.

Write the body into a mktemp dir — never a fixed `/tmp` path:
```bash
[[ "$PR" =~ ^[0-9]+$ ]] || { echo "Invalid PR number: $PR" >&2; exit 1; }
TMPDIR=$(mktemp -d -t "omp-build-review-fixes-PR${PR}-XXXXXX")
trap 'rm -rf "$TMPDIR"' EXIT
BODY="$TMPDIR/body.md"
```
Write the summary (below) to `"$BODY"` → `gh pr comment "$PR" --body-file "$BODY"`

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
- nitpick: Variable naming in auth.service.ts:88 → #123 (sibling of #120, blocked-by #120)

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
| `review-classes.yml` absent/unreadable/unparseable | HALT (Phase 0) — ¬validate classes from memory |
| F = ∅ | Halt |
| Q_auto = ∅ ∧ Q_1b1 = ∅ | Halt |
| All praise | "Nothing actionable", halt |
| C(f) ≥ T ∧ \|A(f)\| = 1 | Verify → confirmed: auto / rejected: 1b1 |
| Auto-apply fails | Demote to Q_1b1 |
| 1b1 fix fails | `[failed]`, continue |
| Quality gate fails 3× | Halt, leave uncommitted |
| ¬∃ PR | Skip Phase 8, local only, no label |
| cls(f) = ∅ for some f ∈ acc | Handled last, one finding at a time |
| ∄ SOURCE_PARENT | Deferred issue is top-level — ¬parent it to the origin |
| class ∈ {test-tautology, vacuous-guard, parallel-path-drift} ∧ solution is denylist/grep/inventory | `[failed]` — change the oracle / SSoT instead |

## Safety Rules

1. Human can `git diff` anytime — applied changes are visible in the working tree
2. ∃ PR → must post the follow-up comment (Phase 8)
3. Every edit is made here, inline — ¬spawn a fixer, ¬delegate the edit
4. Stage specific files only — ¬`git add -A` (risk of .env, secrets)
5. Merge via the gate: label `reviewed` → auto-merge merges (merge commit) on green. ¬manual `gh pr merge` while any check is IN_PROGRESS/QUEUED

## Chain Position

- **Phase:** Verify
- **Predecessor:** `skill://dev-review` (findings)
- **Successor:** `skill://dev-review` (re-review after fix) — LOOP
- **Class:** loop (bounded, max 2 iterations)

## Exit

- **Success:** fixes applied + committed + pushed + PR comment posted → print the summary (Applied/Skipped/Deferred/Failed) + `Next: re-review with skill://dev-review`. Stop.
- **Failure (quality gate, ¬findings, unrecoverable):** return the error and stop — the caller decides Retry | Skip | Abort.
- **Loop cap:** 2 fix→review iterations. On entry to a 3rd, refuse: "Max fix iterations reached — resolve the remainder manually".

$ARGUMENTS

---
name: fix
argument-hint: '[#PR] [--no-label]'
description: >-
  OMP-only — apply one fix per common root cause from a review, inline, no per-finding choice.
  Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these" | "apply review comments" | "apply the review" | "fix the review issues" | "address review feedback" | "fix PR comments".
version: 0.2.0
---

# Fix

## Success

I := ∀ r ∈ R → applied ∨ filed (issue ∃) ∧ PR comment posted
V := `gh pr view {N} --comments | grep "## Review Fixes Applied"`

One pass: name the causes, apply each cause's fix, push once.

**⚠ Continuous pipeline. The cause plan is the decision — apply it in this turn. Stop only on: unrecoverable failure or Phase 6 completion.**

```
/skill:fix             → findings from conversation context
/skill:fix #42         → gather findings from PR #42 comments
/skill:fix #42 --no-label → idem, and **write no `reviewed` label**: the caller owns the merge gate
```

**Label mode.** `mode := no-label` when `--no-label` is in the arguments, else `label`.
It decides one thing, in Phase 5 step 2: whether this skill writes the `reviewed` label.
That label is not a status — `.github/workflows/auto-merge.yml` turns it into
`gh pr merge --auto --merge`, so writing it *is* merging. A caller that owns a review
bound (`/feature` §6.6, where the loop decides whether the PR may land at all) must pass
`--no-label`: a fix round that labels the PR merges it before the re-review that was
supposed to judge the fix.

**You apply every fix yourself.** There is no `R-fixer` in this plugin (ADR-020 §7) and nothing replaces it: Phase 3 edits files inline, in this session, with the diff visible in the working tree. ¬spawn a fixer, ¬delegate the edit.

## Pipeline

| Phase | ID | Required | Verifies via | Notes |
|-------|----|----------|---------------|-------|
| 1 | gather | ✓ | F parsed | latest review's causes, if posted |
| 2 | causes | ✓ | R named | posted blocks, else cluster |
| 3 | apply | — | applied count | R = ∅ → skip |
| 4 | falsify | — | pass/fail per class | no applied class → skip |
| 5 | push | ✓ | `git push` success | label written iff mode = `label` ∧ applied ≠ ∅ |
| 6 | post-comment | — | comment posted | ∄ PR → skip |

## Pre-flight

Success: ∀ r ∈ R → applied ∨ filed ∧ PR comment posted
Evidence: `gh pr view {N} --comments | grep "## Review Fixes Applied"`
Steps: gather → causes → apply → falsify → push → post-comment
¬clear → STOP + ask: "Do you have review findings to fix?"

Let:
  F := all findings | f ∈ F | C(f) ∈ [0,100] ∩ ℤ — confidence
  cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  actionable := {issue, suggestion, todo, nitpick}
  R := root causes | r ∈ R := {id, title, mechanism, fix, findings[]}
  O_push(N, scope, msg) { lint+test gate (max 3 retries) → stage specific files (¬`git add -A`) → commit `fix(<scope>): <msg>` → `git push` }
  D_subsumption := {d ∈ D | d.tag = "subsumption-violation"}

Join rules, the `## Root causes` shape, and what may not join: `../shared/root-causes.md` relative to this skill directory. Read it in Phase 2. Unset `SKILL_DIR` → halt: `fix Phase 2: skill directory not announced — export SKILL_DIR to this skill's directory and re-run`.

## Diagnostics Bus

```
D := []   — ordered list of records; insertion-ordered; duplicates permitted iff (tag, file, line) tuple differs
d ∈ D := {tag: str, file: str, line: int, description: str, phase: str}
```

- **Initial value:** `[]` (empty)
- **Append-only invariant:** entries are never removed or mutated after insertion
- **Lifecycle:** written in Phase 1 (enforcement checks); rendered in Phase 6 when `|D| > 0`. D is per-invocation and ephemeral.

## Phase 0 — Load Taxonomy

Read `skill://dev-review/review-classes.yml` → extract `classes[].class` slugs → `canonical_slugs`. (The canonical YAML ships with `dev-review`; this skill reads it cross-skill — single source, ¬a duplicate copy that could drift.)

File absent, unreadable, or parse error → **HALT**: `[taxonomy-error] review-classes.yml {reason} at skill://dev-review/review-classes.yml — reinstall omp-build.`

This edge is real and load-bearing: without the live taxonomy, Phase 1 steps 4–5 would validate `class[]` against model memory, and a hallucinated slug would pass. HALT, never fall back.

Used in Phase 1 steps 4–5 to validate `class[]` values against the live YAML (¬LLM memory).

## Phase 1 — Gather Findings

1. PR# → `gh pr view <#> --json comments,closingIssuesReferences`; parse Conventional Comments from `.comments[].body`; capture `SOURCE_ISSUE` = `.closingIssuesReferences[0].number` (∅ if none — used when an unfixable cause is filed, to wire blocked-by). When `SOURCE_ISSUE ≠ ∅`, also resolve `SOURCE_PARENT`:
   ```bash
   gh api graphql -f query='query{repository(owner:"<O>",name:"<R>"){issue(number:<SOURCE_ISSUE>){parent{number}}}}' \
     --jq '.data.repository.issue.parent.number // empty'
   ```
   — used to wire the filed issue as a **sibling** under the shared parent.
1a. **Strip historical finding-verifier HTML** — ∀ comment body: remove everything from `<summary>Filtered by finding-verifier` through the next `</details>` **before** parsing. That keep/drop filter is retired; `skill://dev-review` keeps findings after deterministic dedup (especially blockers) and does ¬drop on C alone. Strip leftover HTML so old PR comments cannot re-ingest dropped rows.
1b. **Posted causes.** From the last comment body that contains `## Code Review`, take the `## Root causes` section when it contains one or more `### RC-` blocks. That section is R_posted. A `## Review Fixes Applied` comment is not a review. Absent section, or the section is exactly `none` → R_posted = ∅.
2. ¬PR# → scan conversation for the latest `dev-review` output, including its `## Root causes` section.
3. F = ∅ ∧ R_posted = ∅ → halt
4. ∀ f: parse → label, file:line, agent, root cause, class[], raw_callsites[], solutions, C(f)
   - `class[]` — 0–N canonical slugs from `review-classes.yml` + 0–1 `candidate/<slug>`; absent field → class[] = []
   - `raw_callsites[]` — [{file, line}] list; required when class[] ≠ []; absent when class[] = []
5. Malformed (missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label not in canonical list and not `candidate/*` ∨ `candidate/<slug>` violates `^candidate/[a-z][a-z0-9-]{1,48}$` ∨ class[] ≠ [] ∧ raw_callsites[] = []) → C(f) := 0
   Step 5 fires first; step 5b applies only to findings that passed step 5 (C(f) ≠ 0 after step 5).
5b. [only if step 5 did not fire for f] Subsumption strip: ∃ `bare-except` ∧ `missing-error-handling` in the same finding's class[] → strip `missing-error-handling`; D.append({tag: "subsumption-violation", file: f.file, line: f.line, description: "bare-except subsumes missing-error-handling, duplicate tag stripped", phase: "1"}); ¬set C(f) := 0

## Phase 2 — Name Causes

Read `"$SKILL_DIR/../shared/root-causes.md"`.

- R_posted ≠ ∅ → R := R_posted. The review owned the joins. Do not split or merge those blocks.
- R_posted = ∅ ∧ actionable F ≠ ∅ → cluster F with those rules. Read cited lines before a join the text does not already make obvious.
- actionable F = ∅ ∧ R = ∅ → "No actionable findings", halt.

An actionable finding cited by no block in R is unfixable this round: file it (below), do not invent a second cause, do not ask.

Print the plan, then continue. This print is not a gate.

```
── Causes ──
RC-1 — missing roster SSoT (3 findings) → apply
RC-2 — bare except in auth.ts (1 finding) → apply
Uncited actionable: N → file
Not causes: K (praise, thought, question)
```

## Phase 3 — Apply Causes (inline)

R = ∅ → skip to Phase 5.

∀ r ∈ R, in order, **inline in this session**:

1. Re-read every cited file.
2. Apply `r.fix` once, so every member callsite is covered. The fix line is the change. There is no alternate solution to pick.
3. Sweep the touched files for the same-class anti-pattern: justify or fix any uncited hit of a class already on a member finding.
4. Run lint + the tests covering the changed files. Red → retry max 3.

succeeds → `[applied]`
fails after 3, or the only available change breaks the proxy-fix ban → restore the files, `[failed]`, file the cause, continue with the next cause.

**Proxy-fix ban** (a member class ∈ {test-tautology, vacuous-guard, parallel-path-drift}):
**Forbidden:** widen a denylist, add another grep, copy another inventory/`validate:full` list.
**Required:** change the oracle / single SSoT (matcher, parser, one `package.json` script).
A proxy change → `[failed]`, do not apply, file the cause.

```
── Apply ──
  1. [applied] RC-1 — missing roster SSoT
  2. [failed → filed] RC-2 — bare except in auth.ts — test failure
Applied: N | Filed: M
```

### Unfixable cause — the follow-up is a sibling, never a child

File when a cause cannot be applied, or an actionable finding is cited by no cause. This is the skill's decision. Create the follow-up through `Skill(skill: "issue-triage:issue-triage")` in **create** mode (requires the **issue-triage** plugin installed). Never raw `gh issue create`: issue mutations go through the skill so blocked-by and parent are wired atomically, and a `Blocked by: #12` line in a body is invisible to `gh issue view` and to the frontier query.

`docs/agents/issue-tracker.md` § "Deferred follow-ups are siblings":

> A follow-up deferred out of issue A is a **sibling** of A under their shared parent, blocked-by A — never a child of A. This keeps the epic's fan-out flat instead of building a nested cascade. Planned decomposition (epic → phase) *is* parent/child; post-hoc deferral is not.

So the filed issue takes the **origin's** parent, not the origin:

- `--title "{cause}"`
- `--body "{details}"`
- `--blocked-by "#${SOURCE_ISSUE}"` — the origin. Omit when `SOURCE_ISSUE = ∅`
- `--parent "#${SOURCE_PARENT}"` — the origin's **parent**. Omit when `SOURCE_PARENT = ∅`
- `--size`, `--type` — per `issue-triage`; a ticket with no `size:` label silently downgrades its own future review to F-lite

`--parent "#${SOURCE_ISSUE}"` is the bug this section exists to prevent: it nests the deferral under its origin and the epic's fan-out stops being flat.

∄ SOURCE_ISSUE → create without `--blocked-by` or `--parent`; `{details}` MUST include `**Origin:** PR #<N>` so traceability survives. ∄ SOURCE_PARENT (SOURCE_ISSUE is top-level) → create without `--parent`; the filed issue is top-level too.

`issue-triage` `--blocked-by` accepts issues only (¬PRs) — when the source review is on a PR with no closing-issue reference, fall back to no `--blocked-by` and rely on the `Origin: PR #N` body line.

`{details}` template:
```markdown
**Origin:** PR #<N> review <comment-id> (filed because the cause could not be applied in this round).

{mechanism + member findings}

**Action:** {the fix line, or why no fix could be named}
```

## Phase 4 — Falsification Gate

∀ class among applied member findings:

Run the falsification gate per `skill://fix/falsification.md`. It emits a boolean per class:

```
pass  →  fix accepted; continue
fail  →  fix tautological (RC-1); re-apply that class's causes once
          (max 1 falsification-retry per cause — independent of the CI retry budget in Phase 3)
```

This gate is a **local procedure** — delete the guard the fix introduced, re-run the test, restore. It is not the executable falsify oracle cut by ADR-020 §8: it has no script, no artifact, and no roster input. Nothing here reads a verdict file.

Second `fail` → those causes `[failed]`; file them. New findings surfaced during falsification → **parking lot**: file as a candidate finding for the next PR cycle. ¬reopen the current fix loop. ¬increment the 2-iter cap. Applies to same-class and cross-class anti-patterns alike.

## Phase 5 — Push + Approve

1. ∃ Phase 3 changes still in the tree → O_push(N, scope, "apply N root causes" + list in body). Fail after 3 → halt.
2. ∃ PR ∧ mode = `label` ∧ applied ≠ ∅ → `gh api repos/:owner/:repo/issues/<#>/labels -f "labels[]=reviewed"`
3. mode = `no-label` → **write nothing**: ¬`labels[]=reviewed`, ¬`gh pr edit --add-label`, ¬`gh pr merge`. Say one line — « fix appliqué, pas de label : le gate appartient à l'appelant » — and continue to Phase 6. The caller is holding a bound this label would jump: `/feature` §6.6's loop is the sole writer of `reviewed` on a PR it drives, and a label written here merges the PR before the re-review that judges this very fix.
4. applied = ∅ → write no label either. Nothing was fixed; a label would merge the unfixed PR.

## Phase 6 — Post Follow-Up Comment

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

**Applied:** N cause(s)
**Filed (sibling issues):** J cause(s)
**Failed:** L cause(s)
**Not causes:** K finding(s)
**Enforcement diagnostics:** |D_subsumption| subsumption violation(s) (0 if none)

### Applied
- [applied] RC-1 — missing roster SSoT — `roster.ts:80`

### Filed
- RC-2 — oracle required — #123 (sibling of #120, blocked-by #120)

### Failed
- [failed] RC-3 — unused import in dashboard.tsx:3 — test failure

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
| F = ∅ ∧ R_posted = ∅ | Halt |
| actionable F = ∅ ∧ R = ∅ | "No actionable findings", halt |
| All praise | "No actionable findings", halt |
| Posted `## Root causes` has `### RC-` blocks | Apply those blocks; do not recluster |
| Posted section absent | Cluster actionable F with `../shared/root-causes.md` |
| Actionable finding cited by no cause | File it, continue |
| Apply fails after 3 | Restore, `[failed]`, file the cause, continue |
| Quality gate fails 3× on the push | Halt, leave uncommitted |
| ¬∃ PR | Skip Phase 6, local only, no label |
| ∄ SOURCE_PARENT | Filed issue is top-level — ¬parent it to the origin |
| class ∈ {test-tautology, vacuous-guard, parallel-path-drift} ∧ the change is a denylist/grep/inventory | `[failed]` — file the cause; the fix is the oracle / SSoT |
| mode = `no-label` | Phase 5 step 2 skipped — ¬label, ¬merge; the caller's gate decides |
| applied = ∅ | No label, even in `label` mode |

## Safety Rules

1. Human can `git diff` anytime — applied changes are visible in the working tree
2. ∃ PR → must post the follow-up comment (Phase 6)
3. Every edit is made here, inline — ¬spawn a fixer, ¬delegate the edit
4. Stage specific files only — ¬`git add -A` (risk of .env, secrets)
5. Merge via the gate: label `reviewed` → auto-merge merges (merge commit) on green. ¬manual `gh pr merge` while any check is IN_PROGRESS/QUEUED. mode = `no-label` → this skill writes no label at all: writing it *is* merging, and a bounded caller owns that decision

## Chain Position

- **Phase:** Verify
- **Predecessor:** `skill://dev-review` (findings + root causes)
- **Successor:** `skill://dev-review` (re-review after fix) — LOOP
- **Class:** loop (bounded, max 2 iterations)

## Exit

- **Success:** causes applied or filed + committed + pushed + PR comment posted → print the summary (Applied/Filed/Failed) + `Next: re-review with skill://dev-review`. Stop.
- **Failure (quality gate, ¬findings, unrecoverable):** return the error and stop — the caller decides Retry | Skip | Abort.
- **Loop cap:** 2 fix→review iterations. On entry to a 3rd, refuse: "Max fix iterations reached — resolve the remainder manually".

$ARGUMENTS

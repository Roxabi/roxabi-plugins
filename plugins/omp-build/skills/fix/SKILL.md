---
name: fix
argument-hint: '[#PR]'
description: >-
  OMP-only — apply one fix per blocking root cause from a review, inline, no per-finding choice.
  Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these" | "apply review comments" | "apply the review" | "fix the review issues" | "address review feedback" | "fix PR comments".
version: 0.2.0
---

# Fix

## Success

I := ∀ blocking r → applied ∨ filed (issue ∃) ∧ (deferred set = ∅ ∨ one deferral issue ∃) ∧ ∀ uncited blocking f → filed ∧ ∀ uncited non-blocking f → in that deferral ∨ already deferred ∧ ∀ cited non-blocking finding of a malformed block → in that deferral ∨ already deferred ∧ PR comment posted
V := `gh pr view {N} --comments | grep "## Review Fixes Applied"`

One pass: find the review record, name the causes, apply each eligible well-formed blocking cause as its own commit, defer every non-blocking cause into one issue, push once when a cause was committed. A malformed block is never a commit.

**⚠ Continuous pipeline. The cause plan is the decision — apply it in this turn. Stop only on: unrecoverable failure or Phase 6 completion.**

```
/skill:fix             → the latest dev-review output in this conversation
/skill:fix #42         → the review record on PR #42, after the caller's `fix` step
```

**No `reviewed` from a review-driven fix.** A review-driven fix — nested under
`/feature` / standalone Phase 8, or a direct `/fix #PR` — never writes the `reviewed` label. That label is not a status:
`.github/workflows/auto-merge.yml` turns it into `gh pr merge --auto --merge`, so
writing it *is* merging. Phase 5 never writes it; only an approved `landPr` arms.

**A `fix` step precedes edits.** The caller's `nextReviewStep` returned `fix` for
this PR's latest review record (`dev-review` Phase 8); this skill neither derives
nor re-checks it. Direct `/fix` without that step routes through standalone
`dev-review`, which resolves the PR before reading its records. CI-only failures
use `/feature` §6.5, not this review-comment consumer.

**You apply every blocking fix yourself.** There is no `R-fixer` in this plugin (ADR-020 §7) and nothing replaces it: Phase 3 edits files inline, in this session, with the diff visible in the working tree. ¬spawn a fixer, ¬delegate the edit. A cause with no blocking member is not applied.

## Pipeline

| Phase | ID | Required | Verifies via | Notes |
|-------|----|----------|---------------|-------|
| 1 | gather | ✓ | record found, F + R_posted parsed | the marked review record only |
| 2 | causes | ✓ | R named, eligibility decided | posted blocks, else cluster |
| 3 | apply | — | one commit per applied cause | empty apply bucket → no commit; defer and file still run |
| 4 | falsify | — | pass/fail per cause | no applied cause with a classed member → skip |
| 5 | push | ✓ | `git push` success when a cause was committed | no cause commit → skip the push; never writes `reviewed` on a review-driven fix |
| 6 | post-comment | — | comment posted | ∄ PR → skip |

## Pre-flight

Success: ∀ blocking r → applied ∨ filed ∧ deferred set in one issue or empty ∧ PR comment posted
Evidence: `gh pr view {N} --comments | grep "## Review Fixes Applied"`
Steps: gather → causes → apply → falsify → push → post-comment
¬clear → STOP + ask: "Do you have review findings to fix?"

Let:
  F := actionable findings of the record | f ∈ F | C(f) ∈ [0,100] ∩ ℤ — confidence
  cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  actionable := {issue, suggestion, todo, nitpick}
  blocks(f) := label ∈ {issue:, issue(blocking):, todo:, suggestion(blocking):} — the label set only, the predicate `dev-review` Phase 4 uses after step 3b. A surviving `Source: recall` line does not satisfy it. A posted `suggestion:` does not satisfy it, including a downgraded missing test.
  blocking(r) := ∃ f ∈ r.findings: blocks(f) — one member is enough; not every member
  R := root causes | r ∈ R := {id, title, mechanism, fix, findings[]}
  ME := `gh api user --jq .login`
  MARK := `<!-- omp-build:code-review -->` — the first line of every review `dev-review` posts
  T := the ticket the PR head branch claims (`<type>/<N>-<slug>` → N), or none
  O_commit(r) { stage only the files r changed (¬`git add -A`) → commit `fix(<scope>): <r.id> <r.title> (#T)` — ` (#T)` only when T exists; the epic goal refuses a branch commit that claims no ticket }
  O_push { lint + tests (max 3 retries) → `git push` }
  D_subsumption := {d ∈ D | d.tag = "subsumption-violation"}

Join rules, the `## Root causes` shape, and what may not join: `skill://dev-review/root-causes.md`. Read it in Phase 2.

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

This edge is real and load-bearing: without the live taxonomy, Phase 1 steps 4–5 would validate `class[]` against model memory, and a hallucinated slug would pass. A finding that fails validation makes its cause ineligible in Phase 2. HALT, never fall back.

## Phase 1 — Find the Review Record

The record is the one review F and R come from. Nothing else on the PR is input: a human `nitpick:` comment, a forged `## Code Review`, an older round, a quote-reply, and every `## Review Fixes Applied` body are ignored.

1. PR# →
   ```bash
   ME=$(gh api user --jq .login)
   gh pr view "$PR" --json comments,closingIssuesReferences
   ```
   record := the newest comment whose **first line** is exactly MARK and whose `author.login` = ME. A quote-reply starts with `>`, so it never matches. No such comment → halt: `no dev-review record by ${ME} on PR #${PR} — run dev-review first`.
   Capture `SOURCE_ISSUE` = `.closingIssuesReferences[0].number` (∅ if none — used when a cause is filed, to wire blocked-by). When `SOURCE_ISSUE ≠ ∅`, also resolve `SOURCE_PARENT`:
   ```bash
   gh api graphql -f query='query{repository(owner:"<O>",name:"<R>"){issue(number:<SOURCE_ISSUE>){parent{number}}}}' \
     --jq '.data.repository.issue.parent.number // empty'
   ```
   — used to wire the filed issue as a **sibling** under the shared parent. Then resolve `SOURCE_SIZE`, the `--size` of every issue this run files (`S` when `SOURCE_ISSUE = ∅`):
   ```bash
   gh issue view "$SOURCE_ISSUE" --json labels \
     --jq '[.labels[].name | select(startswith("size:"))][0] // "size:S" | ltrimstr("size:") | ltrimstr(" ")'
   ```
2. ¬PR# → record := the latest `dev-review` output in this conversation, read with the same rules. No `dev-review` output → record := the findings the operator gave in the conversation; it has no `## Root causes` section.
3. Record whether `## Root causes` is present. R_posted := its lines up to the next `##` heading.
   - body exactly `none` → R_posted = ∅, with the section still present. Parse F before any empty halt.
   - `### RC-` blocks → R_posted. A block missing a non-empty `mechanism:`, `fix:` or `findings:` line is malformed: it is not applied. Unambiguously cited findings that satisfy `blocks(f)` are filed per finding; the rest join the single deferral.
   - any other line in the section (text outside the blocks, a Conventional Comment) → halt: `review record on PR #${PR} has a malformed ## Root causes section — re-run dev-review`.
   - no section → R_posted = ∅ (a finding list from the conversation); only this case permits clustering.
4. F := the Conventional Comments under `## Findings` in that record, never the Spec, Standards or Root causes roll-ups. Only an operator's conversational finding list without review sections is read directly. ∀ f: parse → label, exact rendered description, file:line, agent, provenance, root cause, symptoms/evidence and extensions, class[], raw_callsites[], solutions, C(f). Retain all detail; do not re-deduplicate.
   - `class[]` — 0–N canonical slugs from `review-classes.yml` + 0–1 `candidate/<slug>`; absent field → class[] = []
   - `raw_callsites[]` — [{file, line}] list; required when class[] ≠ []; classless explicit lists are retained, absent field → []. Provenance retains original Source, but neither it nor agent/phase/chunk changes `blocks(f)`.
5. Malformed (missing mandatory fields ∨ C ∉ ℤ ∩ [0,100] ∨ free-text class label not in canonical list and not `candidate/*` ∨ `candidate/<slug>` violates `^candidate/[a-z][a-z0-9-]{1,48}$` ∨ class[] ≠ [] ∧ raw_callsites[] = []) → C(f) := 0
   Step 5 fires first; step 5b applies only to findings that passed step 5 (C(f) ≠ 0 after step 5).
5b. [only if step 5 did not fire for f] Subsumption strip: ∃ `bare-except` ∧ `missing-error-handling` in the same finding's class[] → strip `missing-error-handling`; D.append({tag: "subsumption-violation", file: f.file, line: f.line, description: "bare-except subsumes missing-error-handling, duplicate tag stripped", phase: "1"}); ¬set C(f) := 0

## Phase 2 — Name Causes

Read `skill://dev-review/root-causes.md`.

- Cause section present → R := R_posted, including R = ∅ for `none`. The review owned the joins. Do not split, merge or recluster those blocks or uncited findings.
- Cause section absent ∧ actionable F ≠ ∅ → cluster F with those rules. Read cited lines before a join the text does not already make obvious.
- actionable F = ∅ ∧ R = ∅ → "No actionable findings", halt.

Resolve each `findings:` reference by `path:line` + exact final rendered description to exactly one actionable F. Each F may belong to at most one cause. Zero-match, multi-match or conflicting membership makes each affected cause non-applicable; do not guess by class/file/line, import another same-anchor finding, or recluster. Retain unambiguously associated members through malformed-block per-finding file/single-deferral handling; unresolved or conflicting findings use uncited handling exactly once. An independent malformed/low-C finding sharing an anchor does not contaminate a correctly bound cause.

Partition. Each cause, and each uncited actionable finding, goes in exactly one bucket. Do not apply a non-blocking cause, and do not file it on its own.

- apply — the block is well-formed (non-empty `mechanism:`, `fix:`, and `findings:` lines), its references and memberships passed the resolution rules above, and `blocking(r)` and every eligibility condition below holds. Missing fields or unresolved/conflicting members never enter apply. One commit.
- file — `blocking(r)` and a condition fails, or the apply or falsification later fails; malformed/non-applicable-reference blocks use per-finding filing for unambiguously associated blockers, and uncited blockers are filed per finding. Today's per-cause or per-finding filing. Not the deferral issue.
- defer — a well-formed, correctly bound cause with no blocking member, including when an eligibility condition fails, plus each uncited non-blocker and each unambiguously associated non-blocker of a malformed/non-applicable-reference block. One issue for the whole set. Not applied.

An actionable finding with no valid unique cause membership is uncited, including unresolved or conflicting references. It is filed when it satisfies `blocks(f)`; otherwise it joins the deferral. Retain each finding exactly once across these dispositions. Do not invent a cause. Do not ask.

**Eligibility of an apply.** These three conditions gate the apply bucket only. A non-blocking cause is deferred even when one of them fails:

- every member finding passed Phase 1 validation — none has C(f) := 0
- `r.fix` does not widen a denylist, add a grep, or copy an inventory / `validate:full` list — checked on the fix line itself, whatever the members' classes
- every cited path and every explicit member Raw callsite path resolves inside the repository root (`git rev-parse --show-toplevel`)

**Already filed.** Before filing or deferring, read `### Filed` and `### Deferred` in the earlier `## Review Fixes Applied` comments by ME on this PR. A cause whose evidenced mechanism is already under `### Filed` is reported `already filed → #N`, not filed again. A prior deferral suppresses only another deferral of the same evidenced, still-non-blocking cause: report `already deferred → #N` and do not defer it again. A blocking cause that is ineligible or failed is filed even if its mechanism appears under `### Deferred`. For an uncited non-blocking finding, suppress a repeat only when the prior description, mechanism and evidence establish the same defect; file:line alone never matches. Consult linked issue details if receipts lack that evidence; uncertain identity stays in the deferred set. Round-local RC numbers are not cross-round identity. Create the deferral issue only when the remaining deferred set is non-empty. A deferred cause is reported under `### Deferred`, never under `### Filed`.

Print the plan, then continue. This print is not a gate.

```
── Causes ──
RC-1 — missing roster SSoT (3 findings, 1 blocking) → apply
RC-2 — extra test for a working fix (2 findings) → defer: no blocking member
RC-3 — bare except in auth.ts (1 finding) → file: a member failed validation
Uncited non-blocking: N → defer
Uncited blocking: M → file
Not causes: K (praise, thought, question)
```

## Phase 3 — Apply Causes (inline, one commit each)

No cause in the apply bucket → commit nothing. The defer and file steps below still run, then Phase 5, which pushes only when a cause commit exists.

The tree must be clean before the first applied cause. Uncommitted changes → halt and name them when the apply bucket is non-empty: a restore below must never touch the operator's work. An empty apply bucket does not halt on a dirty tree.

∀ r in the apply bucket, in order, **inline in this session**:

1. Re-read every cited file and every member raw-callsite file.
2. Apply `r.fix` once over the union of every member's cited location and all explicit Raw callsites, including classless lists. The fix line is the change. There is no alternate solution to pick. At a shared line, correct only this cause's mechanism; preserve any independent deferred, uncited or malformed finding's mechanism. Shared file/class/line neither drops the eligible blocker nor authorizes the other correction. If the eligible correction cannot be separated from that independent correction, do not apply it: file the eligible cause as ineligible/failed through the existing disposition.
3. Sweep the touched files for the same-class anti-pattern. The sweep may justify a hit of a class already on a member finding. It must not apply the independent mechanism of a deferred cause, an uncited non-blocking finding, or a malformed block's finding, whether filed per finding or deferred. At their cited/raw locations, only the explicitly bound eligible cause correction from step 2 is authorized; no additional sweep correction is authorized there. An uncited hit outside that protected set may be fixed. Keep this existing touched-file/same-class sweep boundary.
4. Run lint + the tests covering the changed files. Red → retry max 3.

succeeds → O_commit(r) → `[applied]`, keep the commit sha.
fails after 3, or the only change that turns the tests green widens a denylist, adds a grep, or copies an inventory list → restore the tree to the last cause commit (`git restore --staged --worktree -- .`, then delete the files r created) → `[failed]`, file r, continue with the next cause. Earlier causes keep their commits.

```
── Apply ──
  1. [applied] RC-1 — missing roster SSoT — 3f2a1c0
  2. [failed → filed] RC-2 — bare except in auth.ts — test failure
Applied: N | Deferred: D | Filed: M
```

### Filing — the follow-up is a sibling, never a child

Two dispositions, one wiring. A non-blocking cause is not filed on its own: it joins the single deferral below. Today's filing is only an ineligible or failed blocking cause, an uncited finding that satisfies `blocks(f)`, or a cited finding of a malformed block that satisfies `blocks(f)`. Each of those gets its own issue. Create every follow-up with `T=$(realpath skill://issue-triage/triage.ts) && bun "$T" create --title-file … --body-file …`. If that command cannot be resolved, stop and name issue-triage. Never raw `gh issue create`: issue mutations go through that CLI so blocked-by and parent are wired atomically, and a `Blocked by: #12` line in a body is invisible to `gh issue view` and to the frontier query.

**Comment text never reaches a command line.** Titles and bodies come from PR comments, which anyone can write. Write them with the `write` tool into a mktemp dir and pass the files; a double-quoted `$(…)` or backtick in an argument runs in the operator's shell.

**Deferral — one issue per run.** Every cause that is not `blocking(r)`, every uncited finding that does not satisfy `blocks(f)`, and every cited finding of a malformed block that does not satisfy `blocks(f)`, and that is not already deferred or filed, goes into exactly one follow-up. They are not applied. One `create`, not one per cause. The title file is the bundle title `Deferred non-blocking review findings`. The body file opens with `**Origin:** PR #<N>`, then `## Acceptance criteria` with one checkbox per deferred item, then the details: every deferred mechanism, its fix line, and its findings, plus each uncited non-blocking finding, plus each cited non-blocking finding of a malformed block. Same `--blocked-by` / `--parent` / `--size` / `--type` wiring as the bullets under the fence. Empty set after the already-deferred filter → no issue. Do not use the per-cause sentence `could not be applied` for this issue. Do not copy a non-blocking member of an applied cause into it.

```bash
FILE_DIR=$(mktemp -d -t "omp-build-fix-file-XXXXXX")
trap 'rm -rf "$FILE_DIR"' EXIT
# write "$FILE_DIR/title.txt" and "$FILE_DIR/body.md" with the write tool, then:
T=$(realpath skill://issue-triage/triage.ts) && bun "$T" create --title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" ...
```

`docs/agents/issue-tracker.md` § "Deferred follow-ups are siblings":

> A follow-up deferred out of issue A is a **sibling** of A under their shared parent, blocked-by A — never a child of A. This keeps the epic's fan-out flat instead of building a nested cascade. Planned decomposition (epic → phase) *is* parent/child; post-hoc deferral is not.

So the filed issue takes the **origin's** parent, not the origin:

- `--title-file` — the cause title
- `--body-file` — the `{details}` below
- `--blocked-by "#${SOURCE_ISSUE}"` — the origin. Omit when `SOURCE_ISSUE = ∅`
- `--parent "#${SOURCE_PARENT}"` — the origin's **parent**. Omit when `SOURCE_PARENT = ∅`
- `--size "${SOURCE_SIZE}"` — mandatory, from Phase 1
- `--type` — per `issue-triage`

`--parent "#${SOURCE_ISSUE}"` is the bug this section exists to prevent: it nests the deferral under its origin and the epic's fan-out stops being flat.

∄ SOURCE_ISSUE → create without `--blocked-by` or `--parent`; `{details}` MUST include `**Origin:** PR #<N>` so traceability survives. ∄ SOURCE_PARENT (SOURCE_ISSUE is top-level) → create without `--parent`; the filed issue is top-level too.

`issue-triage` `--blocked-by` accepts issues only (¬PRs) — when the source review is on a PR with no closing-issue reference, fall back to no `--blocked-by` and rely on the `Origin: PR #N` body line.

**Every filed issue is a scoped child.** Inside an epic, `objective` and `next` start only a child with a `size:` label and an acceptance heading, and no "needs framing" heading (`hasScope`, `skill://feature` § Epic goal). A filed issue missing either stops the epic: no `/goal` line (`missing scope`). So both templates below open with the Origin line, then `## Acceptance criteria`, before any copied text: a stray fence in a copied finding cannot hide the heading. Copied text — titles, mechanisms, findings — is never a heading line and never opens a fence; quote code inline. Each checkbox is one line.

`{details}` template — for a filed cause, and for a single filed finding:
```markdown
**Origin:** PR #<N> review <comment-id> (filed because the cause could not be applied in this round).

## Acceptance criteria

- [ ] {one checkbox per row of the table below}

## Details

{mechanism + member findings, each with `path:line` — exact final rendered description, symptoms/evidence, raw callsites, solutions and immutable provenance; for a single finding retain the same detail even when its mechanism is unusable}

**Why it was filed:** {the eligibility condition that failed, or the failed apply or falsification}
```

The checkbox states the outcome, never a fix line the policy refused:

| Filed because | Checkbox |
|---|---|
| a member has C(f) := 0 | the finding `path:line` — `<exact final rendered description>` is confirmed or dismissed with evidence; a confirmed one is fixed |
| the fix line widens a denylist, adds a grep, or copies an inventory | `<mechanism>` no longer holds for `path:line` — `<exact final rendered description>`, fixed at its oracle or single source, without widening a denylist, adding a grep, or copying an inventory |
| a cited path is outside the repository | the cited path is resolved inside the repository, or the finding is dismissed with evidence |
| the apply failed after 3, falsification failed twice, or the correction cannot be separated from an independent deferred mechanism | first `confirm <mechanism> still holds on the current base`, then `<mechanism> no longer holds for path:line — <exact final rendered description>; the earlier attempt (<reason>) did not hold`, preserving the independent deferred mechanism |
| an uncited blocking finding, or a blocking finding of a malformed/unresolvable block | the finding's solution for `path:line` — `<exact final rendered description>` — `one of: …` when it lists several, its description when it has none, never the malformed block's `fix:` |

Deferral body, one issue for the whole set. Not the per-cause template above:

```markdown
**Origin:** PR #<N> review <comment-id> (deferred: non-blocking; not applied this round).

## Acceptance criteria

- [ ] RC-2: <the fix line> for `path:line` — <exact final rendered description>
- [ ] <the uncited finding's solution> for `path:line` — <exact final rendered description>
- [ ] <the malformed-block finding's solution> for `path:line` — <exact final rendered description>

## Details

### Deferred causes

- **RC-2 — <title>**
  - mechanism: <why>
  - fix: <the fix line, not applied>
  - findings: `path:line` — <exact final rendered description>
  - member detail: <all symptoms/evidence, raw callsites, solutions and immutable provenance>

### Uncited non-blocking findings

- `suggestion:` <exact final rendered description> — `path:line`
  - mechanism/evidence, raw callsites, solutions and provenance: <retained finding detail>

### Cited non-blocking findings of a malformed block

- `suggestion:` <exact final rendered description> — `path:line` — cited by malformed RC-<n>
  - mechanism/evidence, raw callsites, solutions and provenance: <retained finding detail>
```

## Phase 4 — Falsification Gate (per cause)

∀ applied cause with at least one classed member: run the gate per `skill://fix/falsification.md`. It emits pass or fail per cause.

```
pass  →  the cause's commit stands
fail  →  the fix is tautological; re-apply that cause once, as a new commit
          (max 1 falsification-retry per cause — independent of the CI retry budget in Phase 3)
```

Second `fail` → `git revert --no-edit` that cause's commits → `[failed]`, file it. The reverted edit is never pushed as a fix.

This gate is a **local procedure** — delete the guard the fix introduced, re-run the test, restore. It is not the executable falsify oracle cut by ADR-020 §8: it has no script, no artifact, and no roster input. Nothing here reads a verdict file.

New findings surfaced during falsification → **parking lot**: file as a candidate finding for the next PR cycle. ¬reopen the current fix loop. ¬increment the 2-iter cap. Applies to same-class and cross-class anti-patterns alike.

## Phase 5 — Push (no review-driven label)

Phase 5 and Phase 6 are one step: post the receipt right after the push.

1. ∃ cause commits → O_push. Fail after 3 → halt; the commits stay local. Do not post the receipt for a push that did not land.
2. **Never write `reviewed` for a review-driven fix.** If ∃ PR and a review record,
   write nothing:
   ¬`labels[]=reviewed`, ¬`gh pr edit --add-label`, ¬`gh pr merge`. Say one line —
   « fix appliqué, pas de label : le gate appartient à landPr / l'appelant » — and
   post the receipt in this same step. A label here would merge before the re-review
   that judges this fix; see `skill://dev-review` Phase 8.
3. No option enables labelling here: automatic landing belongs to `landPr` alone.

## Phase 6 — Post Follow-Up Comment

∄ PR → skip. This comment is the rest of the push step, not a later session.
If the push succeeded and `gh pr comment` fails, report it and do not push
again. The receipt is for humans; no gate reads it.

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
**Deferred (non-blocking):** D cause(s) + U uncited finding(s) + M cited non-blocking finding(s) of a malformed block → #456
**Filed (sibling issues):** J cause(s)
**Already filed:** A cause(s)
**Failed:** L cause(s)
**Not causes:** K finding(s)
**Enforcement diagnostics:** |D_subsumption| subsumption violation(s) (0 if none)

### Applied
- [applied] RC-1 — missing roster SSoT — `3f2a1c0`

### Deferred
_(omit section when nothing was deferred this run; the summary line is then `**Deferred (non-blocking):** 0`)_
- RC-2 — mechanism: the tests assert a fix that already passes — deferred, not applied — #456
- uncited `suggestion:` polish the name — `ui.ts:12` — mechanism: <evidenced defect> — #456
- malformed-block cited `suggestion:` <exact final rendered description> — `b.ts:2` — mechanism/evidence: <retained detail> — #456

### Filed
- RC-2 — mechanism: <evidenced defect> — findings: `path:line` — <exact final rendered description> — a member failed validation — #123 (sibling of #120, blocked-by #120)

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
| No marked record by ME on the PR | Halt — run dev-review first |
| `## Root causes` is exactly `none` | Parse F; actionable findings remain uncited and file/defer without clustering. Halt only if F has no actionable findings |
| `## Root causes` has a line outside `### RC-` blocks | Halt — malformed record |
| A block misses `mechanism:`, `fix:` or `findings:` | Not applied. Cited findings that satisfy `blocks(f)` are filed per finding. Cited findings that do not are deferred in the one issue |
| Zero/multi-match member reference or conflicting memberships | Affected causes are not applied; retain findings in per-finding/uncited file/single-deferral paths exactly once. No anchor-only binding or reclustering |
| Record has `### RC-` blocks | Use those blocks; do not recluster. Apply only the apply bucket. A malformed block is not in that bucket. Defer every well-formed block with no blocking member |
| Conversation finding list, no section | Cluster with `skill://dev-review/root-causes.md` |
| Actionable finding cited by no cause | `blocks(f)` → file it. Otherwise defer it. Do not ask |
| A member has C(f) := 0 | A blocking cause is filed, not applied. A non-blocking cause is deferred, not filed on its own |
| Fix line widens a denylist / adds a grep / copies an inventory | A blocking cause is filed, not applied. A non-blocking cause is deferred |
| Cited path outside the repository | A blocking cause is filed, not applied. A non-blocking cause is deferred |
| Eligible and independent deferred mechanisms share a line | Apply only the eligible mechanism and all its member raw callsites; no additional sweep correction at protected locations. If inseparable, file the eligible cause |
| Cause already under Filed, or a still-non-blocking cause already under Deferred | `already filed → #N` or `already deferred → #N`. A prior deferral does not suppress filing a blocking cause that is ineligible or failed |
| All causes non-blocking | Commit nothing. File exactly one follow-up listing them. Receipt reports deferred → #N. No push |
| Mixed causes | Apply the well-formed blocking eligible ones. A malformed block is not applied. One deferral issue holds every non-blocking cause, every uncited non-blocking finding, and every cited non-blocking finding of a malformed block |
| Dirty tree before an apply | Halt, name the changes. An empty apply bucket does not halt |
| Apply fails after 3 | Restore to the last cause commit, `[failed]`, file, continue |
| Falsification fails twice | Revert that cause's commits, `[failed]`, file |
| Quality gate fails 3× on the push | Halt, commits stay local. No cause commit → the push is skipped, not failed |
| ¬∃ PR | Skip Phase 6, local only, no label |
| ∄ SOURCE_PARENT | Filed issue is top-level — ¬parent it to the origin |
| review-driven fix | Phase 5 writes no `reviewed`; landing owns the gate |

## Safety Rules

1. Human can `git log` / `git diff` anytime — each applied cause is its own local commit
2. ∃ PR → must post the follow-up comment (Phase 6)
3. Every edit is made here, inline — ¬spawn a fixer, ¬delegate the edit
4. Stage specific files only — ¬`git add -A` (risk of .env, secrets)
5. Input is the marked record by ME, nothing else on the PR
6. Comment text never reaches a command line — filed titles and bodies go through files
7. Merge via the gate only after a fresh green review: `landPr` writes `reviewed`. ¬manual `gh pr merge` while any check is IN_PROGRESS/QUEUED. This skill never writes `reviewed` on a review-driven fix — writing it *is* merging

## Chain Position

- **Phase:** Verify
- **Predecessor:** `skill://dev-review` (review record: findings + root causes)
- **Successor:** `skill://dev-review` (re-review after fix) — LOOP
- **Class:** loop (bounded, max 2 iterations)

## Exit

- **Success:** blocking causes applied or filed, non-blocking causes deferred in one issue or already deferred, receipt posted. A run that applied nothing is success without a commit or a push. Print Applied / Deferred / Filed / Failed + `Next: re-review with skill://dev-review`. Stop.
- **Failure (quality gate, ¬findings, unrecoverable):** return the error and stop — the caller decides next steps outside the automatic bound.
- **Loop cap:** at most 2 automatic fixes, derived by the caller's `nextReviewStep`
  from the review records. On `stop`, follow `skill://dev-review` Phase 8 —
  escalation dossier. Automation on that PR is finished; resumption is a NEW
  superseding PR or the operator finishing by hand.

$ARGUMENTS

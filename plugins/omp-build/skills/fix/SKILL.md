---
name: fix
argument-hint: '[#PR]'
description: >-
  OMP-only — apply one fix per blocking root cause from a review, inline, no per-finding choice.
  Triggers: "fix findings" | "fix review" | "apply fixes" | "fix these" | "apply review comments" | "apply the review" | "fix the review issues" | "address review feedback" | "fix PR comments".
version: 0.3.3
---

# Fix

## Success

I := baseline: ∀ blocking r → applied ∨ filed (issue ∃) ∧ (deferred set = ∅ ∨ one deferral issue ∃) ∧ ∀ uncited blocking f → filed ∧ ∀ uncited non-blocking f → in that deferral ∨ already deferred ∧ ∀ cited non-blocking finding of a malformed block → in that deferral ∨ already deferred ∧ PR comment posted; evidence-v1: every required obligation is applied only from an authorized safe selected plan or remains blocking, and every attempted debt issue satisfies `important ∧ urgent ∧ too-large`
V := `gh pr view {N} --comments | grep "## Review Fixes Applied"`

One pass: find the review record, name the causes, apply each eligible well-formed blocking cause as its own commit, defer every non-blocking cause into one issue **only under the baseline**. An evidence-v1 candidate uses the selected-plan, optional-withdrawal and debt rules below. A malformed block is never a commit.

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
| 4 | falsify | — | pass / fail / skipped per applied cause | no applied cause → skip |
| 5 | push | ✓ | `git push` success when a cause was committed | no cause commit → skip the push; never writes `reviewed` on a review-driven fix |
| 6 | post-comment | — | comment posted | ∄ PR → skip |

## Pre-flight

Success: ∀ blocking r → applied ∨ filed ∧ deferred set in one issue or empty ∧ PR comment posted
Evidence: `gh pr view {N} --comments | grep "## Review Fixes Applied"`
Steps: gather → causes → apply → falsify → push → post-comment
¬clear → STOP + ask: "Do you have review findings to fix?"

Let:
  F := actionable findings of the record | f ∈ F | C(f) ∈ [0,100] ∩ ℤ, or absent — certainty that the defect exists; orders only, never a condition | unusable(f) — Phase 1 step 5
  cat(f) ∈ {issue, suggestion, todo, nitpick, thought, question, praise}
  actionable := {issue, suggestion, todo, nitpick}
  blocks(f) := label ∈ {issue:, issue(blocking):, todo:, suggestion(blocking):} — the label set only, the predicate `dev-review` Phase 4 uses after step 3b. A surviving `Source: recall` line does not satisfy it. A posted `suggestion:` does not satisfy it, including a downgraded missing test.
  blocking(r) := ∃ f ∈ r.findings: blocks(f) — one member is enough; not every member
  R := root causes | r ∈ R := {id, title, mechanism, fix, failure, restored, paths, proof, findings[], authorization?, admission?} — seven-line baseline plan; an active evidence-v1 authoritative posted plan additionally requires non-empty `authorization` and `admission`, per `skill://dev-review/root-causes.md`
  unplanned := `## Root causes` is exactly `none` ∧ F holds an actionable finding — the record carries no plan for it (root-causes.md § `none`)
  ME := `gh api user --jq .login`
  MARK := `<!-- omp-build:code-review -->` — the first line of every review `dev-review` posts
  T := the ticket the PR head branch claims (`<type>/<N>-<slug>` → N), or none
  O_commit(r) { stage only the files r changed (¬`git add -A`) → commit `fix(<scope>): <r.id> <r.title> (#T)` — ` (#T)` only when T exists; the epic goal refuses a branch commit that claims no ticket }
  O_push { lint + tests (max 3 retries) → `git push` }
  D_subsumption := {d ∈ D | d.tag = "subsumption-violation"}

Join rules, the `## Root causes` shape, and what may not join: `skill://dev-review/root-causes.md`. Read it in Phase 2.

## Evidence-v1 candidate consumer

Read `skill://dev-review/evidence-policy.md` before consuming candidate material.
Shadow keeps the marked baseline PR comment unchanged. Supplied-input validation may
read separate local candidate bytes to compute a hypothetical fix plan,
optional-withdrawal transition and receipt without a patch, issue, label, route or
post; missing acceptance is shadow, not a parser failure.

After independently verified acceptance for explicitly selected later work, active
evidence-v1 is not a sidecar: Phase 4 posts its qualified normal marked review body
through the existing writer, preserving markers/head/input/bounds, and this consumer
reads that same body. It never discovers authority from a model output,
self-declaration or replay result. An explicitly fictional fixture acceptance exercises
the branch locally only and never establishes authority or permits a write.

For that active record, use only selected blocks with all seven lines, exact unique
memberships, `authorization: required | optional-neighbor-of RC-N`, and bounded
`admission:` evidence. A missing/malformed field, unsafe plan or unverified acceptance
authorizes no patch. A required finding is an evidenced applicable accepted mandatory
obligation, not a baseline label inherited from shadow; `none` does not clear it.
Apply a `required` block only when it is eligible under the existing rules. An
`optional-neighbor-of RC-N` block needs all six `evidence-policy.md` conditions and
may change only inside that required correction while separable.

One `required` block may carry exact non-blocking memberships when its demonstrated
single mechanism is resolved by the same minimal shared-producer correction; do not
split it by label. `optional-neighbor-of` is reserved for an additional independent
correction and never expands the required plan to unrelated work.

On optional application/falsification failure: withdraw the optional edit, restore and
revalidate the required paths. Continue only when the required correction is still
separable; otherwise stop. Do not use the falsification retry, a new optional repair,
or a substitute plan to rescue it. Every neighboring discovery is independently
requalified; same class/file/anchor is not membership or admission.

Before **every** `triage create` contemplated by candidate handling—blocking, uncited,
malformed, unplanned, failed, falsification, deferred or bundled—record retained
evidence for `important`, `urgent`, and `too-large`. Create an issue only when all
three are true. If one is false, unknown, absent or disputed, create neither an issue
nor a debt bundle: retain the obligation in the PR comment/receipt. This never
unblocks a required finding. Existing issue-triage transport and relationship ownership
remain mandatory.

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
   gh api graphql -f query='query{repository(owner:"<O>",name:"<R>"){issue(number:<SOURCE_ISSUE>){parent{number repository{nameWithOwner}}}}}' \
     --jq '.data.repository.issue.parent | select(. != null) | "\(.repository.nameWithOwner)#\(.number)"'
   ```
   — used to wire the filed issue as a **sibling** under the shared parent. Then resolve `SOURCE_SIZE`, the `--size` of every issue this run files (`S` when `SOURCE_ISSUE = ∅`):
   ```bash
   gh issue view "$SOURCE_ISSUE" --json labels \
     --jq '[.labels[].name | select(startswith("size:"))][0] // "size:S" | ltrimstr("size:") | ltrimstr(" ")'
   ```
2. ¬PR# → record := the latest `dev-review` output in this conversation, read with the same rules. No `dev-review` output → record := the findings the operator gave in the conversation; it has no `## Root causes` section.
3. Record whether `## Root causes` is present. R_posted := its lines up to the next `##` heading.
   - body exactly `none` → R_posted = ∅, with the section still present. Parse F before any empty halt. An actionable finding in F makes the record `unplanned`: every actionable finding is uncited, and the run reports it (Phase 2 print, Exit, receipt). It is never read as a clean review.
   - a `### RC-` block with `mechanism:`, `fix:` and `findings:` and none of `failure:`, `restored:`, `paths:`, `proof:` was written under the three-line cause contract that predates the seven-line plan → halt before any filing: `review record on PR #${PR} predates the seven-line cause plan — re-run dev-review`. Nothing is applied, filed or deferred.
   - `### RC-` blocks → R_posted. A block missing any of its seven lines — `mechanism:`, `fix:`, `failure:`, `restored:`, `paths:`, `proof:`, `findings:` — or carrying an empty one is malformed: it is not applied. Baseline files/defer its unambiguously cited members by label. An active evidence-v1 authoritative record also requires exactly one non-empty `authorization: required | optional-neighbor-of RC-N` and `admission:` line with unique exact memberships; a missing/malformed candidate field authorizes no patch and retains required obligations. The active record is the normal marked PR body, not a sidecar.
   - any other line in the section (text outside the blocks, a Conventional Comment) → halt: `review record on PR #${PR} has a malformed ## Root causes section — re-run dev-review`.
   - no section → R_posted = ∅ (a finding list from the conversation); only this case permits clustering.
4. F := the Conventional Comments under `## Findings` in that record, never the Spec, Standards or Root causes roll-ups. Only an operator's conversational finding list without review sections is read directly. ∀ f: parse → label, exact rendered description, file:line, agent, provenance, root cause, symptoms/evidence and extensions, class[], raw_callsites[], C(f) when stated. Findings carry no solutions; a solution line in an old record is detail, never a plan. Retain all detail; do not re-deduplicate.
   - `class[]` — 0–N canonical slugs from `review-classes.yml` + 0–1 `candidate/<slug>`; absent field → class[] = []
   - `raw_callsites[]` — [{file, line}] list; required when class[] ≠ []; classless explicit lists are retained, absent field → []. Provenance retains original Source, but neither it nor agent/phase/chunk changes `blocks(f)`.
5. unusable(f) := a mandatory field is missing (label, description, file:line, agent, provenance, root cause, symptoms/evidence) ∨ free-text class label not in canonical list and not `candidate/*` ∨ `candidate/<slug>` violates `^candidate/[a-z][a-z0-9-]{1,48}$` ∨ class[] ≠ [] ∧ raw_callsites[] = [] or unparsable. An unusable finding is kept and still blocks when its label blocks. Confidence absent, or not an integer in [0,100] → recorded absent; it never makes f unusable.
   Step 5 fires first; step 5b applies only to findings that step 5 left usable.
5b. [only if f is not unusable] Subsumption strip: ∃ `bare-except` ∧ `missing-error-handling` in the same finding's class[] → strip `missing-error-handling`; D.append({tag: "subsumption-violation", file: f.file, line: f.line, description: "bare-except subsumes missing-error-handling, duplicate tag stripped", phase: "1"}); f stays usable

## Phase 2 — Name Causes

Read `skill://dev-review/root-causes.md`.

- Cause section present → R := R_posted, including R = ∅ for `none`. The review owned the joins and the plans. Do not split, merge or recluster those blocks or uncited findings, and never add a line to a posted block. An `unplanned` record leaves every actionable finding uncited.
- Cause section absent ∧ actionable F ≠ ∅ → cluster F with those rules, and state each cause's seven lines (root-causes.md § Record and § Proof) in the plan print below, before any edit: here `fix` is the one naming causes, so its printed plan is the plan it applies and falsifies. A cluster it cannot plan is not a cause; its findings are uncited. Read cited lines before a join the text does not already make obvious.
- actionable F = ∅ ∧ R = ∅ → "No actionable findings", halt.

Resolve each `findings:` reference by `path:line` + exact final rendered description to exactly one actionable F. Each F may belong to at most one cause. Zero-match, multi-match or conflicting membership makes each affected cause non-applicable; do not guess by class/file/line, import another same-anchor finding, or recluster. Retain unambiguously associated members through malformed-block per-finding file/single-deferral handling; unresolved or conflicting findings use uncited handling exactly once. An independent malformed or unusable finding sharing an anchor does not contaminate a correctly bound cause.

Partition. Each cause, and each uncited actionable finding, goes in exactly one bucket. Baseline behavior does not apply a non-blocking cause and puts it in its single deferral issue. For an active evidence-v1 candidate, partition only from the separately authorized selection: `required` may enter apply; a safe, bounded optional neighbor may accompany it; all other optional findings are retained in the receipt/comment. No candidate bucket creates an issue unless the three-condition debt admission in the candidate consumer holds.

- apply — the block is well-formed (all seven lines present and non-empty), its references and memberships passed the resolution rules above, and `blocking(r)` and every eligibility condition below holds. An active candidate additionally needs verified required authorization and admission. Missing lines or unresolved/conflicting members never enter apply. One commit.
- file — `blocking(r)` and a condition fails, or the apply or falsification later fails; malformed/non-applicable-reference blocks use per-finding filing for unambiguously associated blockers, and uncited blockers are filed per finding. This is baseline terminology. An active evidence-v1 candidate retains the blocker and uses `triage create` only if its debt conjunction is established; otherwise comment only. Not the deferral issue.
- defer — a well-formed, correctly bound cause with no blocking member, including when an eligibility condition fails, plus each uncited non-blocker and each unambiguously associated non-blocker of a malformed/non-applicable-reference block. This is the baseline single issue. Active evidence-v1 retains it in the normal receipt/comment unless the debt conjunction admits issue creation.

An actionable finding with no valid unique cause membership is uncited, including unresolved or conflicting references. Baseline files it when it satisfies `blocks(f)`; otherwise it joins the deferral. An active candidate retains required blockers and uses an issue only after the debt conjunction; otherwise comment only. Retain each finding exactly once across these dispositions. Do not invent a cause. Do not ask.

**Eligibility of an apply.** These four conditions gate the apply bucket only. A non-blocking cause is deferred even when one of them fails. Confidence — low or absent — is never a condition:

- no member finding is unusable (Phase 1 step 5)
- `r.fix` does not widen a denylist, add a grep, or copy an inventory / `validate:full` list — checked on the fix line itself, whatever the members' classes
- `r.proof` is admissible under root-causes.md § Proof: an executable observation of behaviour, a boundary, a transition or an error that exercises every `r.paths` entry — runnable as a repository test, or needing infrastructure the repository lacks (applied, then `skipped` in Phase 4) — or `NO TEST:` with a reason legal under `dev-review` Phase 2 steps 5–5a. A source-text, wiring-copy or mock-echo assertion is not admissible
- every cited path, every explicit member Raw callsite path, every file path in `r.paths`, and the test file `r.proof` names, when it names one, resolve inside the repository root (`git rev-parse --show-toplevel`). A proof that names no file is written to a test file inside the root

**Already filed.** Before filing or deferring, read `### Filed` and `### Deferred` in the earlier `## Review Fixes Applied` comments by ME on this PR. A cause whose evidenced mechanism is already under `### Filed` is reported `already filed → #N`, not filed again. A prior deferral suppresses only another deferral of the same evidenced, still-non-blocking cause: report `already deferred → #N` and do not defer it again. A blocking cause that is ineligible or failed is filed even if its mechanism appears under `### Deferred`. For an uncited non-blocking finding, suppress a repeat only when the prior description, mechanism and evidence establish the same defect; file:line alone never matches. Consult linked issue details if receipts lack that evidence; uncertain identity stays in the deferred set. Round-local RC numbers are not cross-round identity. Create the deferral issue only when the remaining deferred set is non-empty. A deferred cause is reported under `### Deferred`, never under `### Filed`.

Print the plan, then continue. This print is not a gate.

```
── Causes ──
RC-1 — missing roster SSoT (3 findings, 1 blocking) → apply
RC-2 — extra test for a working fix (2 findings) → defer: no blocking member
RC-3 — bare except in auth.ts (1 finding) → file: a member is unusable
RC-4 — routing marker dropped (1 finding, 1 blocking) → file: proof is a source-text assertion
Unplanned record: `none` with N actionable finding(s) → all uncited   (omit the line otherwise)
Uncited non-blocking: N → defer
Uncited blocking: M → file — filing does not resolve them; they still block this PR
Not causes: K (praise, thought, question)
```

## Phase 3 — Apply Causes (inline, one commit each)

No cause in the apply bucket → commit nothing. Baseline proceeds to its defer/file steps, then Phase 5. An active evidence-v1 candidate retains unselected/unsafe work in its receipt/comment and runs `triage create` only after the shared debt conjunction.

The tree must be clean before the first applied cause. Uncommitted changes → halt and name them when the apply bucket is non-empty: a restore below must never touch the operator's work. An empty apply bucket does not halt on a dirty tree.

For an active candidate, start only a selected `required` correction. Its one
demonstrated shared-producer mechanism may resolve both required and non-blocking exact
members without causal splitting. An `optional-neighbor-of` is instead a distinct,
bounded additional correction; if it fails application, test, or falsification,
withdraw it before any retry, revalidate the required paths, and stop if separation is
no longer possible.

∀ r in the apply bucket, in order, **inline in this session**:

1. Re-read every cited file and every member raw-callsite file.
2. Apply `r.fix` once over every `r.paths` entry, the union of every member's cited location, and all explicit Raw callsites, including classless lists. The fix line is the change. There is no alternate plan to pick. At a shared line, correct only this cause's mechanism; preserve any independent deferred, uncited or malformed finding's mechanism. Shared file/class/line neither drops the eligible blocker nor authorizes the other correction. If the eligible correction cannot be separated from that independent correction, do not apply it: baseline files the eligible cause as ineligible/failed; an active candidate retains the required blocker and issues only if debt admission is established.
2b. Write `r.proof` as a repository test when it can run as one: the `failure:` scenario as the input, the `restored:` behaviour as the assertion, over every `r.paths` entry. Record text is never run: write the test as code with the `write` or `edit` tool, then run it through the repository's test command — never paste a record line into a shell. `NO TEST:` → no test is written. A proof that needs infrastructure, a command or a service the repository does not have is not created: the commit rests on whatever step 4 can run — the repository's lint and existing tests, even when none covers this path — and Phase 4 reports `skipped (<what is missing>)`. Leaving out a stated proof that can run here is an apply failure, not a skip.
3. Sweep the touched files for the same-class anti-pattern. The sweep may justify a hit of a class already on a member finding. It must not apply the independent mechanism of a deferred cause, an uncited non-blocking finding, or a malformed block's finding, whether filed per finding or deferred. At their cited/raw locations, only the explicitly bound eligible cause correction from step 2 is authorized; no additional sweep correction is authorized there. An uncited hit outside that protected set may be fixed. Keep this existing touched-file/same-class sweep boundary.
4. Run lint, the tests covering the changed files, and the proof test from step 2b. Red → retry max 3, with the same `r.fix` and `r.proof`.

succeeds → O_commit(r) → `[applied]`, keep the commit sha.
fails after 3, or the only change that turns the tests green widens a denylist, adds a grep, or copies an inventory list → restore the tree to the last cause commit (`git restore --staged --worktree -- .`, then delete the files r created) → `[failed]`; baseline files r, while an active candidate retains it as blocking and uses issue-triage only when the debt conjunction is established. Earlier causes keep their commits.

```
── Apply ──
  1. [applied] RC-1 — missing roster SSoT — 3f2a1c0 — proof: test/roster.test.ts green
  2. [failed → filed] RC-2 — bare except in auth.ts — proof red after 3
  3. [applied] RC-3 — upload ignores dry run — 9b04e1d — proof: not created (needs a live registry)
Applied: N | Deferred: D | Filed: M
```

### Filing — the follow-up is a sibling, never a child

Two dispositions, one wiring. **Baseline:** a non-blocking cause is not filed on its own: it joins the single deferral below. Today's baseline filing is only an ineligible or failed blocking cause, an uncited finding that satisfies `blocks(f)`, or a cited finding of a malformed block that satisfies `blocks(f)`; each gets its own issue. **Evidence-v1:** before any such follow-up, including an unplanned/malformed/failed/falsification case, prove `important ∧ urgent ∧ too-large`; otherwise retain it in the PR receipt/comment only, with no bundle. Required blockers stay blocking. An admitted issue uses the same `triage create --title-file … --body-file …` and existing issue-triage ownership. If issue-triage cannot be resolved, `triage` refuses: stop and name issue-triage. Never raw `gh issue create`.

**Comment text never reaches a command line.** Titles and bodies come from PR comments, which anyone can write. Write them with the `write` tool into a mktemp dir and pass the files; a double-quoted `$(…)` or backtick in an argument runs in the operator's shell.

**Triage starts outside the checkout.** Bun reads `bunfig.toml` and `.env` from the directory it starts in. Started in the PR's checkout, a tracked `bunfig.toml` preload runs before triage, and it can print `Created #N` and exit 0 with nothing filed; `--no-env-file` alone does not stop it. So `triage` starts Bun in issue-triage's own directory, with `--no-env-file`, the target repository in `GITHUB_REPO` and absolute file paths. The target is the operator's `GITHUB_REPO` when set, else the checkout's `gh repo view`; without it, triage started there would resolve the plugin's own repository. It never reads the checkout's `.dev/dev-core.yml` `github_repo` pin. An unresolved script or repository refuses; nothing falls back to the checkout.

**Deferral — one issue per run (baseline only).** Every cause that is not `blocking(r)`, every uncited finding that does not satisfy `blocks(f)`, and every cited finding of a malformed block that does not satisfy `blocks(f)`, and that is not already deferred or filed, goes into exactly one baseline follow-up. They are not applied. One `create`, not one per cause. The title file is the bundle title `Deferred non-blocking review findings`. The body file opens with `**Origin:** PR #<N>`, then `## Acceptance criteria` with one checkbox per deferred item, then the details: every deferred mechanism, its fix line, and its findings, plus each uncited non-blocking finding, plus each cited non-blocking finding of a malformed block. Same `--blocked-by` / `--parent` / `--size` / `--type` wiring as the bullets under the fence. Empty set after the already-deferred filter → no issue. Do not use the per-cause sentence `could not be applied` for this issue. Do not copy a non-blocking member of an applied cause into it. Evidence-v1 never forms this bundle unless all three debt predicates are evidenced; otherwise it retains findings and predicate evidence in the PR receipt/comment only.

```bash
FILE_DIR=$(mktemp -d -t "omp-build-fix-file-XXXXXX")
trap 'rm -rf "$FILE_DIR"' EXIT
# write "$FILE_DIR/title.txt" and "$FILE_DIR/body.md" with the write tool, then:
TRIAGE=$(realpath skill://issue-triage/triage.ts) && TRIAGE_REPO="${GITHUB_REPO:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
triage() { (: "${TRIAGE:?issue-triage unresolved}" "${TRIAGE_REPO:?repository unresolved}" && cd "$(dirname "$TRIAGE")" && GITHUB_REPO="$TRIAGE_REPO" bun --no-env-file "$TRIAGE" "$@"); }
triage create --title-file "$FILE_DIR/title.txt" --body-file "$FILE_DIR/body.md" ...
```

**A partial create is never created again.** `create` prints `Created #N` first, then one line per write: `Type=`, `Priority=`, `Size=`, `Parent=`, `BlockedBy=`. A nonzero exit after `Created #N` leaves #N filed but incomplete. Record #N as filed, and run the same block with `triage set N` as its last line, passing only the flags whose line is missing.

`docs/agents/issue-tracker.md` § "Deferred follow-ups are siblings":

> A follow-up deferred out of issue A is a **sibling** of A under their shared parent, blocked-by A — never a child of A. This keeps the epic's fan-out flat instead of building a nested cascade. Planned decomposition (epic → phase) *is* parent/child; post-hoc deferral is not.

So the filed issue takes the **origin's** parent, not the origin:

- `--title-file` — the cause title
- `--body-file` — the `{details}` below
- `--blocked-by "#${SOURCE_ISSUE}"` — the origin. Omit when `SOURCE_ISSUE = ∅`
- `--parent "${SOURCE_PARENT}"` — the origin's qualified **parent**. Omit when `SOURCE_PARENT = ∅`
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

{the cause's seven lines when it has them (mechanism, fix, failure, restored, paths, proof, findings) + member findings, each with `path:line` — exact final rendered description, root cause, symptoms/evidence, raw callsites and immutable provenance; for a single finding retain the same detail even when its mechanism is unusable}

**Why it was filed:** {the eligibility condition that failed, or the failed apply or falsification}
```

The checkbox states the outcome, never a fix line the policy refused:

| Filed because | Checkbox |
|---|---|
| a member is unusable | the finding `path:line` — `<exact final rendered description>` is confirmed or dismissed with evidence; a confirmed one is fixed |
| the fix line widens a denylist, adds a grep, or copies an inventory | `<mechanism>` no longer holds for `path:line` — `<exact final rendered description>`, fixed at its oracle or single source, without widening a denylist, adding a grep, or copying an inventory |
| `r.proof` is not admissible (a source-text, wiring-copy or mock-echo assertion, or a proof that misses a `paths:` entry) | `<mechanism>` no longer holds for `path:line` — `<exact final rendered description>`, shown by a test that observes the `restored:` behaviour on every path, or by a NO TEST row legal under `dev-review` Phase 2 steps 5–5a |
| a cited path, `paths:` entry or proof test file is outside the repository | the path is resolved inside the repository, or the finding is dismissed with evidence |
| the apply failed after 3, falsification failed twice, or the correction cannot be separated from an independent deferred mechanism | first `confirm <mechanism> still holds on the current base`, then `<mechanism> no longer holds for path:line — <exact final rendered description>; the earlier attempt (<reason>) did not hold`, preserving the independent deferred mechanism |
| an uncited blocking finding, a blocking finding of a malformed/unresolvable block, or a blocker of an `unplanned` record | `<the finding's Root cause line>` no longer holds for `path:line` — `<exact final rendered description>`, or the finding is dismissed with evidence; never the malformed block's `fix:`, never a solution line copied from the finding |

Deferral body, one issue for the whole set. Not the per-cause template above:

```markdown
**Origin:** PR #<N> review <comment-id> (deferred: non-blocking; not applied this round).

## Acceptance criteria

- [ ] RC-2: <the fix line> for `path:line` — <exact final rendered description>
- [ ] `<the uncited finding's Root cause line>` no longer holds for `path:line` — <exact final rendered description>, or it is dismissed with evidence
- [ ] `<the malformed-block finding's Root cause line>` no longer holds for `path:line` — <exact final rendered description>, or it is dismissed with evidence

## Details

### Deferred causes

- **RC-2 — <title>**
  - mechanism: <why>
  - fix: <the fix line, not applied>
  - failure / restored / paths / proof: <the four lines as posted>
  - findings: `path:line` — <exact final rendered description>
  - member detail: <all root causes, symptoms/evidence, raw callsites and immutable provenance>

### Uncited non-blocking findings

- `suggestion:` <exact final rendered description> — `path:line`
  - root cause/evidence, raw callsites and provenance: <retained finding detail>

### Cited non-blocking findings of a malformed block

- `suggestion:` <exact final rendered description> — `path:line` — cited by malformed RC-<n>
  - root cause/evidence, raw callsites and provenance: <retained finding detail>
```

## Phase 4 — Falsification Gate (per cause)

∀ applied cause: run the gate per `skill://fix/falsification.md`. It emits pass, fail or skipped per cause. A class on a member is not a condition: every applied cause has a proof line to break.
For an evidence-v1 optional neighbor, a failure is withdrawal, required-path revalidation and then continuation only if separable; it is never a retry budget. Record withdrawal and residual required obligations locally in shadow or in the normal active receipt after accepted activation.

```
pass     →  removing the production guard made the proof fail on its `failure:` scenario; the commit stands
fail     →  the proof still passed without the guard: the fix is tautological; re-apply the same
            `fix:` and `proof:` once, as a new commit
            (max 1 falsification-retry per cause — independent of the CI retry budget in Phase 3)
skipped  →  NO TEST, a proof needing absent infrastructure, or an inconclusive run (error, unrelated
            failure); the commit stands, reported as skipped with its reason — never as pass
```

Second `fail` → `git revert --no-edit` that cause's commits → `[failed]`; baseline files it. An active evidence-v1 candidate retains it as a blocker and creates a follow-up only when `important ∧ urgent ∧ too-large` is evidenced. The reverted edit is never pushed as a fix.

This gate is a **local procedure** — remove the production guard the fix introduced (for a missing-test cause, the existing guard its test observes), re-run the proof, restore. Never the proof's own test, assertion, fixture or setup. It is not the executable falsify oracle cut by ADR-020 §8: it has no script, no artifact, and no roster input. Nothing here reads a verdict file.

```
── Falsification ──
  RC-1 — pass
  RC-3 — skipped (proof needs a live registry)
Falsification: P pass · S skipped · F fail
```

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

The rendered PR receipt below is the baseline template. Shadow evidence-v1 keeps its
receipt local. After accepted activation, evidence-v1 uses the normal PR receipt,
separate from—but linked to—the authoritative review record; it records retained
evidence/dimensions, authorizations/admissions, optional withdrawals, required-path
revalidation or residuals, and each `important`/`urgent`/`too-large` decision. A failed
debt predicate is rendered as `comment only — no issue/bundle`, not as a deferred issue.
It never treats unavailable evaluation or skipped/inconclusive falsification as a pass.

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
**Falsification:** P pass · S skipped · F fail — a skip is not a pass
**Unplanned record:** `## Root causes` was `none` with X actionable finding(s); each blocker was filed and still blocks _(omit the line when the record was planned)_
**Deferred (non-blocking):** D cause(s) + U uncited finding(s) + M cited non-blocking finding(s) of a malformed block → #456
**Filed (sibling issues):** J cause(s) — filed blockers still block this PR; filing is not a resolution
**Already filed:** A cause(s)
**Failed:** L cause(s)
**Not causes:** K finding(s)
**Enforcement diagnostics:** |D_subsumption| subsumption violation(s) (0 if none)

### Applied
- [applied] RC-1 — missing roster SSoT — `3f2a1c0` — falsification: pass
- [applied] RC-4 — upload ignores dry run — `9b04e1d` — falsification: skipped (proof needs a live registry)

### Deferred
_(omit section when nothing was deferred this run; the summary line is then `**Deferred (non-blocking):** 0`)_
- RC-2 — mechanism: the tests assert a fix that already passes — deferred, not applied — #456
- uncited `suggestion:` polish the name — `ui.ts:12` — mechanism: <evidenced defect> — #456
- malformed-block cited `suggestion:` <exact final rendered description> — `b.ts:2` — mechanism/evidence: <retained detail> — #456

### Filed
- RC-2 — mechanism: <evidenced defect> — findings: `path:line` — <exact final rendered description> — a member is unusable — #123 (sibling of #120, blocked-by #120)
- uncited `issue:` <exact final rendered description> — `path:line` — root cause: <evidenced defect> — unplanned record — #124 (sibling of #120, blocked-by #120)

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

Baseline rows follow. For an active evidence-v1 candidate, `file`, `defer`, and every
follow-up named below mean: retain/comment only unless the debt conjunction is
independently evidenced; a required blocker remains blocking in either case.

| Scenario | Behavior |
|----------|----------|
| `review-classes.yml` absent/unreadable/unparseable | HALT (Phase 0) — ¬validate classes from memory |
| No marked record by ME on the PR | Halt — run dev-review first |
| `## Root causes` is exactly `none` | Baseline: parse F, then file/defer uncited actionable findings without clustering. Evidence-v1: no selected plan; retain required blockers and comment only unless each proposed issue meets the debt conjunction. The plan print, receipt and Exit name the unplanned record; it is never clean |
| `## Root causes` has a line outside `### RC-` blocks | Halt — malformed record |
| A `### RC-` block carries only `mechanism:`, `fix:` and `findings:` (a record from before the seven-line plan) | Halt before any filing — re-run dev-review. Nothing is applied, filed or deferred |
| A block misses one of its seven lines, or one is empty | Not applied. Baseline files/defer its members by label; evidence-v1 retains required blockers and applies the debt conjunction before any issue |
| Zero/multi-match member reference or conflicting memberships | Affected causes are not applied; retain findings exactly once. Baseline uses per-finding/uncited file/single-deferral paths; evidence-v1 comment-only unless debt admission holds. No anchor-only binding or reclustering |
| Record has `### RC-` blocks | Use those blocks; do not recluster. Apply only the apply bucket. A malformed block is not in that bucket. Baseline defers a well-formed non-blocker; evidence-v1 retains it unless debt admission permits an issue |
| Conversation finding list, no section | Cluster with `skill://dev-review/root-causes.md` |
| Actionable finding cited by no cause | Baseline: `blocks(f)` → file; otherwise defer. Evidence-v1: required stays blocking; issue only after debt admission. Do not ask |
| A member is unusable | A blocking cause is not applied. Baseline files it and defers a non-blocker; evidence-v1 retains/comment-only unless debt admission holds |
| A member has low or absent confidence | No effect on the bucket: confidence orders, it is never a condition |
| `proof:` is a source-text, wiring-copy or mock-echo assertion, or misses a `paths:` entry | A blocking cause is not applied. Baseline files/defer; evidence-v1 keeps required obligations and gates an issue on debt admission |
| `proof:` needs infrastructure the repository lacks | Apply; no proof test is created; Phase 4 reports `skipped (<what is missing>)`, never pass |
| Proof run errors or fails on another assertion during falsification | `skipped (inconclusive)`, never pass; the commit stands |
| Fix line widens a denylist / adds a grep / copies an inventory | Do not apply. Baseline files/defer; evidence-v1 retains/comment-only unless debt admission holds |
| Cited path, `paths:` entry or proof test file outside the repository | Do not apply. Baseline files/defer; evidence-v1 retains/comment-only unless debt admission holds |
| Eligible and independent deferred mechanisms share a line | Apply only the eligible mechanism and all its member raw callsites; no additional sweep correction at protected locations. If inseparable, baseline files; evidence-v1 stops with the required obligation retained |
| Cause already under Filed, or a still-non-blocking cause already under Deferred | Baseline reports the existing issue. Evidence-v1 does not create/reuse debt authority without current three-predicate evidence |
| All causes non-blocking | Baseline commits nothing and files one follow-up. Evidence-v1 creates no bundle unless all three debt predicates hold; otherwise receipt/comment only. No push |
| Mixed causes | Apply baseline-eligible blockers. Evidence-v1 applies only authorized required plans, admits optional neighbors only while separable, and gates every issue on the debt conjunction |
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

- **Success:** baseline: blocking causes applied or filed, non-blocking causes deferred in one issue or already deferred, receipt posted. Evidence-v1: required causes are applied only from authorized safe plans or remain blocking; optional failures are withdrawn/revalidated; every issue is debt-admitted or the evidence stays comment-only in the normal active receipt (local only in shadow). A run that applied nothing is success without a commit or a push. Print Applied (each with its falsification result) / Falsification P·S·F / Deferred / Filed / Failed, the `Unplanned record` line when it applies, + `Next: re-review with skill://dev-review`. A filed blocker still blocks: a run that filed one is never reported as a clean review, whatever it applied. Stop. This run owns its lint, tests, commits, push and receipt: a caller (`/feature` §6.5) does not repeat them; it records proof for a moved head, then reviews it.
- **Failure (quality gate, ¬findings, unrecoverable):** return the error and stop — the caller decides next steps outside the automatic bound.
- **Loop cap:** at most 2 automatic fixes, derived by the caller's `nextReviewStep`
  from the review records. On `stop`, follow `skill://dev-review` Phase 8 —
  escalation dossier. Automation on that PR remains stopped and disarmed;
  operator-supervised agents continue only after explicit approval of revised
  scope, a diagnostic/correction plan and a checkpoint, on a NEW superseding PR.

$ARGUMENTS

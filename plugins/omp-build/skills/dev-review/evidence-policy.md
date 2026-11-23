# Evidence review policy — evidence-v1

Use the baseline proof and classification rules as a checklist. This file also describes the legacy native `evidence-v1` candidate and its record format; `/dev-review` publishes the comment defined in `SKILL.md`, which `/dev-fix` reads.

## Baseline Phase 2 proof adjudication

For tiers other than S, the SC→Test matrix must cover every SC without silent gaps. Its only NO TEST reasons are `infra-not-wired`, `prompt-logic-only`, `ui-manual-only`, and `out-of-scope`; a missing matrix is `issue(blocking)`.

For each browser-scoped success criterion, if Δ touches `frontend.path` or `shared.ui` and the base or head stack declares `commands.test_e2e`, `ui-manual-only` is `issue(blocking)`. Otherwise it needs a `### Browser check <criterion>` in the captured PR body with `- Steps:`, an http/https `- URL:`, and concrete `- Observed:` evidence credibly performed for this head; unsupported claims are `issue(blocking)`.


A Phase 2 missing/weak-test finding reaches the Phase 4 final-label write. A missing SC→Test matrix or an unmet behaviour criterion remains `issue(blocking)`.

## Baseline Phase 4 classification

Baseline Phase 4 retains every finding by default. Confidence orders it; it never removes, demotes, files, or repairs a finding. After collection, same-defect-only merge, and recall normalization, baseline applies this final missing-or-weak-test label rule before verdict and root causes:

- Rewrite a finding whose subject is a missing or weak test, including an agent `issue:`, a recall finding, and a Phase 2 unmet-criterion finding whose only gap is that test. Do not rewrite a missing SC→Test matrix, an unmet behaviour criterion, or an evidenced behaviour defect the fix missed or introduced.
- Keep the finding as `issue:` only when both are true: the unproven behaviour is an issue acceptance criterion with no other PR evidence, or a safety invariant (merge/release/deploy/delete/publish/permission/automated-stop-or-disarm path); and the PR has no accepted proof under `root-causes.md` § Proof.
- A test in Δ that is not accepted proof satisfies the second condition; a restatement of accepted proof without new defect evidence does not. Source-text, wiring-copy, and mock-echo assertions are never requirements.
- Otherwise relabel the finding `suggestion:`. Retain `Source: recall` in immutable provenance, but do not give that source independent blocking weight; this is the last baseline label write.

Final baseline grouping is exact: Blockers are `issue:`, `issue(blocking):`, `todo:`, and `suggestion(blocking):`; Warnings are `suggestion:`, `suggestion(non-blocking):`, and `nitpick:`; Suggestions are `thought:` and `question:`; Praise is `praise:`. The final label set alone controls blocking.
These labels are review-record classifications only; they never mutate a GitHub label or erase captured provenance.


## Legacy native `evidence-v1` policy

`baseline` was the default. An independent operator acceptance selected `evidence-v1` for specific native work; without it, the candidate stayed in **shadow**. This selection does not apply to composed review.

- call `await evaluateFindings(evidenceById, { judgeBatch })`; retain its typed
  observations and per-item provider/model identity only as candidate evidence;
  a degraded result preserves every supplied ID and supplies no Jev score;
- render candidate findings, selected plans and a receipt locally and separately
  from the authoritative review body; never post, append, copy a candidate verdict,
  plan or receipt into it. Keep candidate output out of authoritative verdict accounting;
- shadow cannot create an issue, make a patch, change a label, alter routing or
  change the baseline verdict. A replay pass, a model-generated "pass" or acceptance
  reference, and a self-declared mode are not authority.

### Shadow execution procedure

Shadow is executable; lack of acceptance never halts its **local computation**. With
supplied snapshots, Phase 4 must: (1) preserve the supplied baseline, delta, affected
paths and residual obligations separately; (2) collect and retain complete F; (3) call
the evaluator once; (4) run qualification, exact-membership checking and plan admission
as a **hypothetical** candidate decision; (5) render separate local candidate review
bytes, a hypothetical fix plan, and a hypothetical receipt. The local render identifies
`Mode: shadow`, retains every required blocker and residual, and records the
hypothetical review selection. It contains no authoritative verdict declaration and
is never passed to a live writer/reader.

A shadow fixture may read those exact local bytes only for hypothetical observation.
Its output is not correction authorization.

An isolated fixture may exercise the active branch with an explicitly labelled
**fictional acceptance event**. It may prove branch behavior only: it cannot establish
operator acceptance, authorize a real candidate, publish a body, alter a review record,
or trigger any GitHub/issue/patch/label/routing write. Keep that fixture event out of
production records and all claims of activation.

In a historical native review record using `evidence-v1`, positional markers and
head/input bindings precede `Policy: evidence-v1` and `Acceptance: <real reference>`.
The record contains the qualified findings and selected plans, and retains ordinary
verdict accounting, stops and bounds. Missing, malformed, self-generated or
unverified acceptance identifies shadow evidence, not patch authority.

Suspend candidate use immediately on a missed required blocker, an out-of-policy
correction, an unauthorized issue, or a lost residual obligation. Retain the
observations and ordinary stops/bounds, restore baseline authority and full review,
and require renewed independent acceptance; suspension never resets review accounting.

## Qualification and selection

For each supplied finding, `evaluateFindings` returns only typed dimensions:
`evidenceSupport` (`supported|refuted|unknown`), `supportedApplicability`
(`applicable|not-applicable|unknown`), `concreteConsequence`
(`concrete|not-concrete|unknown`), and `uncertainty`
(`known|uncertain|unknown`). Disagreement or degraded availability is retained,
never converted to a confidence, Jev score, disposition, patch permission, or
merge permission.

A **required** finding is an evidenced, applicable accepted spec, safety, data, or
other mandatory obligation. A baseline blocking label is authoritative only while in
shadow; it is not inherited into active evidence-v1 classification. Active Phase 4
requalifies each finding before final labels/verdict: direct positive refutation or
unsupported applicability may produce a documented non-required disposition, retaining
the finding, evidence and residual obligations. Missing evidence is `unknown`, not
refutation; it blocks only when it leaves an unresolved applicable required obligation.

Supported current uses are evaluated against the accepted promise; hypothetical future
uses do not create a required obligation. Correction handling follows the cause
disposition rules independently of this review classification.
A disputed product promise or a requested promise change is human arbitration, not an
agent disposition. Material Jev disagreement is investigated against the cited evidence,
never voted away; no aggregate, confidence, availability or score waives an obligation.

Every neighboring discovery is independently qualified for review; shared class,
file, line, mechanism wording, or a prior decision is never inheritance. Causes
retain exact finding memberships and the seven-field plan. Their necessary, urgent,
and too-large judgments require cited evidence, and the engine assesses their
disposition under `skill://dev-review/root-causes.md`. Review classification alone
does not authorize a patch, create an issue, or clear a required blocker.

Phase 4 alone computes the complete deduplicated F, performs active qualification and
disposition before final labels/verdict, selects plans, and renders the authoritative
body: baseline while shadow, evidence-v1 after verified acceptance. Neither evaluator,
root-cause writer, fix, receipt, nor a replay can replace that authority.

## Differential review and residuals

Candidate scope records, separately, supplied/reconstructed `baseline`, `delta`,
`affected paths`, and `residual obligations`. Review the delta and affected paths, then
inspect every residual explicitly. If baseline, history, closure, or affected-path
reconstruction is unknown, perform full review plus explicit residual inspection; never
claim a differential closure. A previously unchanged deferral reopens only for new
evidence or a new obligation, not merely a new run.

Differential processing has its own independent activation/qualification gate: general
evidence-v1 acceptance is insufficient. It remains shadow/full-review-only until its
replay or full comparison, residual inspection and shadow results are independently
accepted for the selected differential use. Failure or uncertainty restores full review;
no differential disposition becomes authoritative merely because the general candidate
is active.

## Historical correction dispositions

Cause outcomes belong to the original UW. A blocking or indeterminate cause with
missing, contested or contradictory evidence stays pending; unsupported nonblocking
work is a report, not an issue. A sister needs exact authenticated confirmation; a
blocking sister holds the original. Skipped or inconclusive falsification is not a pass.

# Evidence review policy — evidence-v1

This is the single policy for the evidence-v1 candidate. `dev-review`, `root-causes`,
`fix`, `falsification`, and `feature` consume it; none redefines qualification, plan
admission, debt admission, or rollout state.

## Authority and rollout

`baseline` is the default and remains the only live authority until an **independent
operator acceptance** authorizes `evidence-v1` for later, explicitly selected work.
Baseline's existing review body, markers, head/input binding, verdict, review-record
accounting, routing, landing and stop/bound rules are unchanged.
## Baseline Phase 2 proof adjudication

For tiers other than S, the SC→Test matrix must cover every SC without silent gaps. Its only NO TEST reasons are `infra-not-wired`, `prompt-logic-only`, `ui-manual-only`, and `out-of-scope`; a missing matrix is `issue(blocking)`.

For each browser-scoped success criterion, if Δ touches `frontend.path` or `shared.ui` and the base or head stack declares `commands.test_e2e`, `ui-manual-only` is `issue(blocking)`. Otherwise it needs a `### Browser check <criterion>` in the captured PR body with `- Steps:`, an http/https `- URL:`, and concrete `- Observed:` evidence credibly performed for this head; unsupported claims are `issue(blocking)`.


A Phase 2 missing/weak-test finding reaches the Phase 4 final-label write. A missing SC→Test matrix or an unmet behaviour criterion remains `issue(blocking)`.

## Baseline Phase 4 classification

Baseline Phase 4 retains every finding by default. Confidence orders it; it never removes, demotes, files, or repairs a finding. After collection, same-defect-only merge, and recall normalization, baseline applies this final missing-or-weak-test label rule before verdict and root causes:

- Rewrite a finding whose subject is a missing or weak test, including an agent `issue:`, a recall finding, and a Phase 2 unmet-criterion finding whose only gap is that test. Do not rewrite a missing SC→Test matrix, an unmet behaviour criterion, or a real missed/fix-induced behaviour defect with evidence.
- Keep the finding as `issue:` only when both are true: the unproven behaviour is an issue acceptance criterion with no other PR evidence, or a safety invariant (merge/release/deploy/delete/publish/permission/automated-stop-or-disarm path); and the PR has no accepted proof under `root-causes.md` § Proof.
- A test in Δ that is not accepted proof satisfies the second condition; a restatement of accepted proof without new defect evidence does not. Source-text, wiring-copy, and mock-echo assertions are never requirements.
- Otherwise relabel the finding `suggestion:`. Retain `Source: recall` in immutable provenance, but do not give that source independent blocking weight; this is the last baseline label write.

Final baseline grouping is exact: Blockers are `issue:`, `issue(blocking):`, `todo:`, and `suggestion(blocking):`; Warnings are `suggestion:`, `suggestion(non-blocking):`, and `nitpick:`; Suggestions are `thought:` and `question:`; Praise is `praise:`. The final label set alone controls blocking.
These labels are review-record classifications only; they never mutate a GitHub label or erase captured provenance.



Candidate evaluation is callable with supplied inputs, but begins in **shadow**:

- call `await evaluateFindings(evidenceById, { judgeBatch })`; retain its typed
  observations and per-item provider/model identity only as candidate evidence;
  a degraded result preserves every supplied ID and supplies no Jev score;
- render candidate findings, selected plans and a receipt locally and separately
  from the authoritative review body; never post, append, copy a candidate verdict,
  plan or receipt into it. The fix reader scans verdict declarations, so this
  separation is load-bearing;
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
`Mode: shadow`, retains every required blocker and residual, and records why each
hypothetical plan/issue is admitted or comment-only. It contains no authoritative
verdict declaration, and is never passed to a live writer/reader.

The local fix consumer may read those exact local bytes only to compute the same
hypothetical plan, optional-withdrawal transition and receipt. It must not perform a
write or treat a missing acceptance reference as a parsing failure. Its output is
observation evidence, not a fix authorization.

An isolated fixture may exercise the active branch with an explicitly labelled
**fictional acceptance event**. It may prove branch behavior only: it cannot establish
operator acceptance, authorize a real candidate, publish a body, alter a review record,
or trigger any GitHub/issue/patch/label/routing write. Keep that fixture event out of
production records and all claims of activation.

An **active candidate** is possible only for later selected work when an independently
established acceptance reference is present and verified by the operator-controlled
record. Its normal review record keeps the ordinary positional markers/head/input first,
then exactly `Policy: evidence-v1` and `Acceptance: <real reference>`. It is the
authoritative Phase 4 body for that selected work: it contains the qualified findings
and selected plans, is posted through the normal writer, and is the same marked record
the normal `/fix` reader consumes. It preserves head/input binding, verdict accounting,
the canonical [stop recovery](recovery.md), and bounds. Missing, malformed,
self-generated, or unverified acceptance means shadow; it never authorizes a patch.

Suspend candidate use immediately on a missed required blocker, an out-of-policy
correction, an inadmissible debt issue, or a lost residual obligation. Retain the
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
uses do not create a required obligation. A known minor may be autonomously deferred
only when the evidence establishes it is optional and the debt rule admits its handling.
A disputed product promise or a requested promise change is human arbitration, not an
agent disposition. Material Jev disagreement is investigated against the cited evidence,
never voted away; no aggregate, confidence, availability or score waives an obligation.

An **optional** finding may join a selected required plan only as
`optional-neighbor-of RC-N` when all of these are recorded:

1. it is a real current defect with an understood mechanism, independently evidenced
   at each cited producer/consumer path;
2. `RC-N` is a selected, safe required plan with exact member bindings, and the
   optional work is within that already-authorized required fix;
3. the correction preserves the accepted/promised contract;
4. the correction introduces no dependency;
5. caller compatibility is evidenced and preserved;
6. a targeted behavioral proof is available for the optional correction.

Separability is additionally mandatory: the optional correction must be separable from
every required obligation so it can be safely withdrawn and the required paths
revalidated.

Every new discovery at a neighboring path is independently requalified; shared class,
file, line, mechanism wording, or a prior neighbor decision is never inheritance.
An optional-only set selects no plan, creates no red verdict and starts no new fix route.
`none` means no selected plan, never no finding and never clearance of a required blocker.

## Required membership versus optional neighbor

One selected `authorization: required` plan may bind exact memberships for every
symptom of its one demonstrated mechanism, including non-blocking members, when its
minimal shared-producer correction resolves them all. Do not split that causal plan
because members carry different labels, and do not require optional-neighbor metadata
for those naturally resolved symptoms.

`optional-neighbor-of RC-N` is only for an additional, independent correction beside
that required plan. It never authorizes an unrelated improvement, a second mechanism
hidden in a shared file, or a causal split that the cited evidence does not demonstrate.
Its own exact memberships and all six conditions remain mandatory.

## Selected-plan contract

The seven causal lines remain mandatory. A candidate-selected RC additionally has:

```markdown
- authorization: required | optional-neighbor-of RC-N
- admission: <bounded evidence; required's safe-plan evidence or optional's six conditions plus separability>
```

`findings:` retains exact `path:line` plus final rendered description memberships; a
finding appears in at most one selected plan. Missing/malformed authorization, admission,
seven-line plan, exact membership, proof, or safe boundary authorizes no active patch.
Required members stay blockers; optional members are retained as findings.

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

## Correction and debt admission

An active correction first needs a selected `required` plan. Optional neighbors may be
changed only inside that already authorized correction. If an optional change fails
application or falsification, withdraw it, restore/revalidate every required path and
continue only if the required correction remains separable. If it is inseparable, stop;
never consume a discretionary retry or invent a replacement plan.

Issue creation is admissible only when the retained evidence establishes **all three**:
`important AND urgent AND too-large`. This conjunction applies to every cause, uncited
finding, malformed/unplanned record, failed correction, falsification discovery, bundle,
receipt and feature handoff. The issue itself must use existing `issue-triage` transport
and relationship ownership. If any predicate is absent, false, unknown, or disputed:
post/retain a PR comment only; create no debt issue and no bundle. Required blockers
remain blockers even when no safe plan or admissible debt issue exists.

Candidate receipts list: retained evidence/dimensions, selected authorization and
admission, optional withdrawals, required obligations revalidated or still residual,
debt decision with all three predicates, and suspension if triggered. They never claim
that a skipped/inconclusive falsification or unavailable evaluator is a pass.

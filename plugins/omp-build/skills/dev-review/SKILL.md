---
name: dev-review
argument-hint: '[#PR]'
description: Native structured review: bind → chunk/panel → recall → synthesis → confirmed records.
version: 0.3.0
---

# Native review

`dev-review` is the product entry. It never renders, posts, or parses a parallel Markdown review protocol.

## Bind

1. Resolve exactly one existing target before work. For a PR use `resolveReviewPr`; unknown, closed, stopped, ambiguous, moved head, or a spent bound stops. Standalone may use only an existing local target; never invent a PR.
2. Capture `REVIEWED_HEAD` and `captureReviewInput(cwd, pr, REVIEWED_HEAD)`. Before every **new dispatch**, decision, final record, or stop publication, call `validateReviewInput(cwd, pr, REVIEWED_HEAD, input)` again. If binding moves while an already-authorized batch runs, retain every observed native output under its confirmed old root first, then stop before another dispatch/decision/final record; never retarget or rebind.
3. Baseline is default. Candidate evidence policy remains advisory unless the existing accepted reference independently admits it; do not add policy rules.

The installed product resolves the exact candidate head itself, invokes `captureReviewInput`, and refuses every unbound/stopped target. Do not recreate this binding with an ad-hoc shell helper.

## Prepare native product

Before preparation, read `review-classes.yml`, `root-causes.md`, `evidence-policy.md`, and applicable `review-blind-spots.md` / `review-smells.md`. Their semantic requirements remain authoritative; native records transport their results and do not replace their policy or causal admission rules.

Use the installed `omp-build` review product, not a shell runner or a replacement panel:

- Parse the full diff with `chunker.py`, produce every boundary digest with `digest.py`, and preserve their ordered outputs.
- Allocate every chunk with `roster.allocateReview`; retain its full allocation. `review_halt` stops. Existing tier $\tau \in \{S,F\text{-lite},F\text{-full}\}$ remains host-selected; an Epic range is not silently tier S.
- Read `review-classes.yml`; only canonical classes can trigger recall. `candidate/<slug>` is advisory.
- Publish and read back the immutable initial `review-attempt` before dispatch. Initial PR inventory has `subject:{kind:'pull-request'}`; Epic range inventory has `subject:{kind:'epic-range',range:'<40hex>..<40hex>'}`. Later recall/synthesis inventories inherit the root; do not repeat `subject`.
- **Recall** — index report/callsite associations. Trigger a canonical non-candidate class only at $\ge2$ chunks and $\ge3$ unique callsites. Recall uses `R-review-recall`, the explicitly named blocking, read-only Roxabi profile configured with the bundled scout's `@smol` role and read-only tool subset; it is not the bundled `scout` or a scheduler replacement. Its terminal strict result is required before synthesis.

## Stages

`spec → panel → class index/recall → strict synthesis → confirmed records` is one product continuation, not an orchestration transcript.

1. **Initial** — required spec and panel slots use strict schemas. Preserve raw attempts and each child identity before inspecting the structured report. The outer task success does not make a child valid: every required `event.details.results` child needs expected ID, exitCode 0, no error/abort, and `structuredOutput.status === 'valid'`.
2. **Recall** — use the confirmed class index and `R-review-recall`; its strict terminal result is required before synthesis.
3. **Synthesis** — after all required source slots are retained and valid, use the blocking `R-review-synthesis` role. It alone classifies identities, final labels, impact, merges, and causes. Core only validates references/conservation and derives labels/groups/verdict.
4. **Publication** — revalidate binding, publish canonical contribution/decision records through the GitHub adapter, and read them back. A PR publishes only its final `review`; an Epic range never publishes `review` or consumes PR rounds. Its driver publishes its domain `epic-event` from the confirmed decision/inventory references and exact range.

Any incomplete or unusable required result stops. Retain raw partial output, including extractable reports, rather than replacing it with `[]` or a successful empty finding list. A third-red or third-green+CI-red stop remains sticky and is published as canonical `stop` before continuation/disarm.

## Scoped PR #118 replacement

Use the [operator-supervised PR #118 replacement procedure](recovery.md) only for its documented legacy-admission failure or stop case. It preserves #118's evidence and requires a separate checkpoint plus #107's genuine native `missing` authority before a distinct PR. A generic stopped bound is not a successor authorization.

## Next action

`deriveReviewState`/`nextReviewStep` derive the specialized PR review state. Standalone `/dev-review` ends with confirmed review records and grants no landing authority. Under `/feature`, completion returns to `continueFeature` → `reconstructWorkflow` before selecting the next lifecycle action. `/fix` consumes confirmed records by reference without reclassifying findings. Human choice remains only at the existing explicit decision boundaries; no routine continuation confirmation is introduced.

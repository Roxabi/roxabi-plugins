---
title: "Plan: remove external proof and the proof mechanism from omp-build"
issue: 902
parent: 901
decisions: [D21, D22, D44, Q79]
complexity: 6/10
tier: F-lite
base: c70e7454
generated: "2026-10-26T00:00:00+01:00"
---

## Summary

Delete Semctx, AssertLedger and every piece of the external-proof mechanism: the
`proof` workflow step, producer acquisition and `kind:'proof'` records, `proofPins` in
mandates, the producer parts of the review fingerprint, the external-proof part of landing
admission, and Semctx/AssertLedger detection at adoption and worktree start.

Landing admission becomes: the latest review approves the current head within the review
bound, CI is green, normative inputs are unchanged, and outputs are authentic. The mandate
and the review fingerprint gain an explicit format marker. Pre-#902 mandates, reviews and
proof records are refused with `incompatible-format`. There is no migration, re-review,
exemption or rollover (D44).

Footprint at `c70e7454`: 69 proof files, 28 of them production (3 584 lines) and the rest
tests and fixtures (7 444 lines). Around 140 files mention a removed term.

Delivery is manual, with review and CI, and does not run the current `/feature` (Q79).

## Decisions

| # | Decision | Source |
|---|---|---|
| P1 | Record date and non-edit verification is **extended** to the records that landing admission reads: the selected review attempt, the mandate chain and the workflow binding. A part is admitted only if its native `createdAt`/`updatedAt` are readable and `updatedAt == createdAt`. Today this check guards only proof parts (`skills/feature/proof-records.ts:110-155`). Records are POST-only (`adapters/github/publication-writer.ts:25-34`), so normal use cannot trigger a false refusal. | Operator, 2026-10-26 |
| P2 | The mandate payload and every review payload that carries `input` get an explicit format literal: `format: 'omp-build-mandate/2'` and `inputFormat: 'omp-build:review-input/3'`. `parseRecord` refuses an absent or older marker with `incompatible-format`, and the message names the #902 cut. Later slices bump the same markers (D44: every slice refuses old formats). Today an old mandate fails only as generic `malformed` (`engine/record-construction.ts:7-19`), and an old fingerprint only mismatches. | Plan; reuses the unsupported-version refusal pattern (`engine/workflow-landing-admission.ts:166-170`) |
| P3 | A framed `kind:'proof'` record is refused as `incompatible-format`, not reported as generic `malformed`. The legacy `<!-- omp-build:proof … -->` marker keeps its current `legacy` status (`adapters/github/history-codec.ts:60-71`). | Plan |
| P4 | Residual Semctx or AssertLedger configuration is never read. `.semctx/**`, `assertledger.config.json`, Semctx lefthook commands and an `assertledger` dependency produce no plan line, no refusal and no call. | Issue AC6, D21 |
| P5 | Native behavioral evidence named `proof` stays: `engine/record-values.ts:79-91,131-180`, `engine/workflow-output-schema.ts:105-116`, the `NO TEST` rules in `skills/dev-review/evidence-policy.md:15` and `root-causes.md:102-105`, and correction falsification (`roxabi/correction-native-falsify.ts`, `skills/fix/falsification.md`). Removal is never done by lexical match on the word "proof". | Issue, out of scope |

## Admission: before and after

| Step | Before (`scripts/review-gate-admission.ts`, `skills/feature/landing-initial.js`) | After |
|---|---|---|
| Authenticated history read, expected author | `review-gate-admission.ts:106-122` | **unchanged** |
| Date and non-edit of the admitted records | proof parts only (`proof-records.ts:110-155`) | review attempt, mandate chain and binding parts (P1) |
| Requested head is the live head; base refresh | `:123-130` | **unchanged** (`refreshSelectedBase` moves out of the proof modules) |
| Mandate admission: parents, binding, authority, config version and digest, accepted Spec | `engine/workflow-landing-admission.ts:162-205` | **unchanged** except the pin drift check at `:182-183`, which is removed |
| Mandate and review format | none | `incompatible-format` at parse (P2) |
| Pin re-read, Semctx admission, AssertLedger admission | `skills/feature/proof-admission.ts:42-60` | **removed** |
| Stored review input equals a fresh capture | `proof-admission.ts:16-35` and `engine/review-state.ts:227` | **kept**, using fingerprint `review-input/3` without producer parts |
| `facts.proofAdmission` gate | `engine/review-state.ts:224` | **removed** |
| Reviewed head = current head, CI neither pending nor red, bound not spent | `engine/review-state.ts:225-277` | **unchanged** |
| Pre-arm proof freshness (`proof-changed`) | `skills/feature/workflow-review-state.js:108-140` | **removed**; the review-input and head freshness checks stay |

Workflow graph: `ready --pr-open→ proof --proof-confirmed→ review` disappears
(`roxabi/workflow-graph.ts:19,55-57`). An open bound PR reaches `review` through the existing
`review-step-review` edge, and `review-step-land→land` is unchanged. No new edge is needed.

## Commits

Each commit must leave `bun run typecheck` green, along with the suites it touches.
C2 through C7 form a chain on shared engine files. C1 and C8 touch disjoint files and may be
done in parallel.

### C0 — `docs(omp-build): plan external proof removal (#902)`
This file.

### C1 — `refactor(omp-build): stop detecting Semctx and AssertLedger at adoption and worktree start`
- **Delete:** `skills/feature/feature-init-hooks.ts`. Move any non-Semctx cases in `feature-init-hooks.test.ts` (landing, owner-origin, issue-triage) to the test file of the module they exercise.
- **Strip:** `skills/feature/feature-init-facts.ts:9,33-51,182-186,218-245` (Semctx plan, hook state, `semctx-working-empty`, active contracts, AssertLedger package detection and its `toolPlan` entry). Strip `feature-init-types.ts:7-29` and `feature-init.fixture.ts:31-40,69-91`. Strip `feature-init-workspaces.ts` `detectsVitest` if it has no importer left.
- **Bootstrap:** remove `run_semctx_index` from `worktree-bootstrap.sh:4,75` and `worktree-bootstrap-indexes.sh:41-45`. Keep ccc (`:19-32`) and codegraph (`:34-38`).
- **Fixtures:** remove Semctx and AssertLedger data from `__fixtures__/feature-init/{pr-only,hooks-ok,kept,kept-hidden}`. Keep `acme/.semctx/**` and `acme/package.json` as residual-config negatives.
- **Tests:** strip the Semctx/AssertLedger suites in `feature-init-facts.test.ts`, `feature-init-facts.integration.test.ts:210-243,274-276` and `feature-init-hooks.test.ts`. Add negatives: (a) `/feature init` facts and plan on a repository with `.semctx/semantic/changes/*.sem`, a Semctx lefthook command, a Semctx CI job and an `assertledger` dependency produce no Semctx/AssertLedger plan line and no refusal; (b) `worktree-bootstrap.integration.test.ts:351-385` with a residual `.semctx/` and no `semctx` on PATH completes without calling it.
- **Verify:** `bunx vitest run plugins/omp-build/skills/feature/feature-init* plugins/omp-build/skills/feature/worktree-bootstrap*`.

### C2 — `refactor(omp-build): remove the proof workflow step`
- **Graph and engine:** in `roxabi/workflow-graph.ts:10-26,35-64`, remove node `proof` and the edges `pr-open→proof` and `proof-confirmed→review`. Also strip `engine/workflow-graph.ts:7-40`, `engine/workflow-action-completion.ts:24-42,109-114`, `engine/workflow-condition-evaluation.ts:16-37`, `engine/workflow-control.ts:17-35` (`'proof'` in `WORKTREE_ACTIONS`), `engine/workflow-walk-step.ts:27-28`, and `engine/workflow-reconstruction-types.ts` (`ProofSelector`, `SpecializedDecisions.proof`).
- **Continuation:** delete `roxabi/feature-continuation-proof.ts`. Strip `roxabi/feature-continuation-observation.ts` (selector construction), `feature-continuation-effects.ts:7-8,39-43,65-81`, `feature-continuation-dispatch.ts:71-115` (`acquireFeatureProof`), `feature-selection.ts:42-54`, and the proof selector in `roxabi/fix-ci-evidence.ts`. Move `refreshSelectedBase` out of `proof-candidate.ts` for `workflow-readiness.js:2`, which keeps its generic base refresh.
- **Producers:** delete `skills/feature/proof-acquire.ts`, `proof-acquire-tools.ts`, `proof-acquire-semctx.ts`, `proof-acquire-assertledger.ts` and `proof-acquire-binding.ts`, together with their tests.
- **Tests:** in `testing/workflow-decision-cases/ci.test.ts:36-99`, the first case dispatches review directly and the selector-completion case `:78-99` is deleted. Remove `openProof` from `completion.test.ts:247-249` and `support/workflow-decision-fixtures.ts`. In `engine/__tests__/workflow-{implementation,plan-execution,attribution,spec-assessment,transition}-behavior.test.ts`, a bound open PR now selects `review` and the proof boilerplate goes. Preserve the invariants that open or rejected implementations stay blocked.
- **Verify:** `bunx vitest run plugins/omp-build/engine plugins/omp-build/testing/workflow-decision-cases plugins/omp-build/roxabi/feature-*`.

### C3 — `refactor(omp-build): admit landing without external proof`
- **Delete:** `skills/feature/proof-admission.ts`, `proof-chronology.ts`, `proof-justification.ts` (Semctx gap, `NO_TEST_REASONS` landing policy, browser/e2e gap form) and `proof-readiness.ts`, together with their tests (`proof-integration-semctx-gap-policy`, `-record-admission`, `-chronology`, `-applicability`, `proof-assertledger-admission*`, `proof-readiness.test.ts`).
- **Engine:** remove `ReviewFacts.proofAdmission` (`engine/result.ts:14-24`) and its wait (`engine/review-state.ts:223-230`). Keep `:225-277` byte-for-byte in behavior.
- **Readers:** strip `Admission`, `proofResult` and `proof-refused` from `scripts/review-gate-admission.ts:1-26,38-48,147-189,196-267`, `skills/feature/landing-initial.js:101-170`, `workflow-landing.d.ts` (`ProofSummary`, `producer`) and `workflow-review-state.js:108-140` (`proof-changed`). Move the stored-versus-fresh review-input equality (`proof-admission.ts:16-35`) into the review-input owner. It stays a refusal.
- **Verify:** `bunx vitest run plugins/omp-build/scripts plugins/omp-build/skills/feature/land* plugins/omp-build/skills/feature/workflow-*`. Positive case: an existing gate case with a current review, green CI and an unchanged mandate is admitted with zero producer calls.

### C4 — `refactor(omp-build): version the review fingerprint without producer parts`
- **Schema:** remove `selectedProofPartSchema`, `semctxParts` and `assertledgerParts` from `engine/review-schema.ts:22-35`. Add `inputFormat: 'omp-build:review-input/3'` to every review payload that carries `input` (P2).
- **Hash and capture:** the `hashReviewInput` preimage (`proof-context-hash.ts:7-29`) changes to `omp-build:review-input/3` and drops both producer arrays. In `proof-capture.ts:109-160`, capture stops calling `candidateFacts`, loading proof history and selecting producer records. Strip the `semctx`/`assertledger` fields from `roxabi/review-input-contract.ts:19-33`, `roxabi/review-pr-inputs.ts:64-85,220-238`, `roxabi/review-runner.ts:110-136` and `review-runner.test.ts:58-65`. Check that `review-pr-inputs.ts:138-139` still fingerprints the base and candidate `.dev/stack.yml` (see C5 risk).
- **Records:** remove `kind:'proof'` from `engine/record-schema.ts:45-77`, `engine/record-references.ts:4-16` and `engine/record-construction.ts:27-63`. Add `engine/record-format.ts`, called first in `parseRecord`, which returns `incompatible-format` for a framed `proof` record and for a review payload whose `inputFormat` is absent or not current (P2, P3). Add the code to `engine/record-diagnostics.ts`.
- **Delete, now orphaned:** `proof-semctx-protocol.ts`, `proof-semctx-validation.ts`, `proof-semctx-validation-result.ts`, `proof-candidate-semctx.ts`, `proof-candidate-contract.ts`, `proof-association.ts`, `proof-retained-provenance.ts`, `proof-assertledger.ts`, `proof-ticket.ts`, `proof-tree.ts`, and `proof-records.ts` (`findProofRecord`, `newProofRecord`). Keep `recordIntegrity` and `nativeInstant` for C6. Delete their tests and `__fixtures__/proof/{records,historical*,capture*,wire,sandbox-semctx-*,sandbox-assertledger,sandbox-both}`.
- **Negatives:** an initial review inventory without `inputFormat` or with `semctxParts` → `incompatible-format`; a framed `kind:'proof'` comment → `incompatible-format`; the legacy `producer=semctx` marker in `adapters/__tests__/github.test.ts:228-234` stays `legacy`. In `github-workflow-history-binding-readback.test.ts:80-138,334-340` and `github-workflow-support.ts:36-39`, replace the proof-kind frames with an allowed kind.

### C5 — `refactor(omp-build): remove proof pins from mandates`
- **Engine:** remove `proofPins` and `ProofConfigPin` from `engine/workflow-mandate-schema.ts:3,23-32`, `engine/workflow-correction-mandate.ts:12-50`, `engine/workflow-landing-admission.ts:25-36,86-94,162-184,222-227` (`pinIdentity`, `samePins`, drift), `engine/workflow-landing.ts:1-30` (`proof-pin-drift`, success `proofPins`), `engine/workflow-reconstruction-types.ts:1-16,63-81` and `engine/record-references.ts:43-54`. Add `format: 'omp-build-mandate/2'` to `mandateShared`; `record-format.ts` refuses an absent or older format (P2).
- **Callers:** delete `roxabi/workflow-pins.ts` and `skills/feature/proof-pins.ts`. Strip `roxabi/feature-mandate.ts:6-9,42-72`, `feature-succession.ts:18-27,181-205`, `feature-continuation-observation.ts:13-16,48-84`, `fix-ci-evidence.ts:15-17,166-210`, `fix-mandate-authority.ts:10-11,139-160`, `fix-mandate-resolution.ts:229-270`, `skills/feature/epic-driver-authority.ts:9,23-25,110-122,185-204`, `workflow-mandate.js:72-80,132-200` and `.d.ts`, `workflow-watch.js:90-119` (pin argument only) and `workflow-review-state.js:11,60-79`. Remove `ProofGraphOutcome` from `roxabi/workflow-config-digest.ts:80-113`; the digest serialization at `:8-70` is untouched.
- **Tests:** delete the pin drift case in `engine/__tests__/workflow-authority-behavior.test.ts:55-99` and the pin fields from `testing/workflow-fixtures.ts`, `testing/roxabi-presets.ts:38-55,69-71`, `testing/workflow-decision-cases/landing.test.ts:7,50-51,136`, `roxabi/feature-recovery.integration.test.ts` and `skills/feature/review-record-fixture.js`. Negative: a mandate carrying `proofPins` or lacking `format` → `incompatible-format`, and it cannot authorize landing.
- **Risk:** `PROOF_PIN_PATHS` also pinned `.dev/stack.yml` (`roxabi/workflow-pins.ts:1`). Before deleting, confirm that review overrides from it are covered by the config digest (`roxabi/workflow-overrides.ts`, `workflow-config-digest.ts`) and that the base and candidate stack are in the review fingerprint (`review-pr-inputs.ts:138-139`). If either is missing, removing the pin drops a normative input, and the commit stops for arbitration.

### C6 — `feat(omp-build): refuse edited records at landing admission`
- Rehome `nativeInstant` and `recordIntegrity` (`proof-records.ts:102-131`) as a producer-free native-record verifier next to the history readers (`adapters/github/`). It returns `record-unreadable` for an unreadable `createdAt`/`updatedAt` or `updatedAt < createdAt`, and `record-edited` when `updatedAt != createdAt`.
- Apply it in both admission readers (`scripts/review-gate-admission.ts` and `landing-initial.js`) to the parts of the selected latest review attempt, every mandate in the admitted chain and the workflow binding, before the decision. The parts are already on the decoded operations (`engine/review-state.ts:140`).
- **Tests:** an edited review part, an edited mandate and an edited binding are each refused with `record-edited`; an unreadable date is refused; the unedited counterpart is admitted. Update fixtures that publish `updatedAt: null` (`review-record-fixture.js:122-156`, `debt-filing.fixture-*`) so the positive paths carry readable native facts.

### C7 — `refactor(omp-build): rehome the generic proof-named modules`
Use `lsp rename_file` and `rename` so every importer is rewritten.

| From | To | Kept symbols |
|---|---|---|
| `proof-base.ts` (generic subset) | `skills/feature/review-base.ts` | `Git`, `Gh`, `GitResult`, `Refusal` and its reason narrowed to review input, `repositoryOf`, `refreshSelectedBase` (from `proof-candidate.ts`) |
| `proof-context.ts` semantic projection + `proof-semantic-canon.ts` | merge into the existing `roxabi/review-semantic-context.ts` | `ConfirmedReviewSemanticContext`, projection, `ReviewSemanticCanon`, `reviewSemanticCanon` |
| `proof-context-hash.ts` + `proof-capture.ts` + `proof-review-contract.ts` `Target` | `skills/feature/review-input.ts`, collapsing the wrapper `workflow-review-input.{js,d.ts}` onto it | `hashReviewInput`, `captureReviewInput`, `ReviewTarget`, the input-equality refusal |
| `epic-events.ts` `isRecord` import | local guard | — |
| `__fixtures__/proof/sandbox-{repository,types}.ts`, `plain-git.js` | `testing/sandbox/` | used by `omp/__tests__/feature-*-lifecycle`, `feature-review-races`, `testing/feature-review-fixture.ts` |
| `testing/review-gate-proof-arrangement.ts` | `testing/review-gate-arrangement.ts` | — |

After C7, no `proof-*` file remains under `skills/feature/`, and `__fixtures__/proof/` and `testing/proof-integration/` are gone. The `skills/feature/workflow-*.{js,d.ts}` and `scripts/review-*.ts` facade importers change only their import path.

### C8 — `docs(omp-build): drop Semctx from review guidance`
- `skills/dev-review/evidence-policy.md:17,18,21`: remove Semctx status, `PARTIAL` gap and producer-part chronology. Keep the SC→Test check, the `NO TEST` enum (`:15`) and behavior-bound browser evidence (`:21`), reattached to a criterion and not to a landing gap.
- `skills/dev-review/validation/evidence-policy/calibration-packets.json:6-20`: delete case C01.
- `roxabi/review-prompts.ts:33,56,59,69,82`: remove "proof owner" and Semctx verdict judgement, and point the input slot at `review-input/3`.
- **Verify:** `bunx vitest run plugins/omp-build/skills/dev-review plugins/omp-build/roxabi/review-*`.

### C9 — `docs(omp-build): document proof-free landing; rebuild contracts; bump 0.12.0`
- `GLOSSARY.md`: delete Change contract (`:75-77`), Proof record (`:87-89`), Proof pin (`:91-93`) and Reviewer trust ceiling (`:99-101`). Rewrite Landing admission (`:95-97`) as the four-condition admission plus `incompatible-format`, and Review input binding (`:205-207`) as `review-input/3` without producer parts.
- `README.md`: rewrite `:104,144,379-424,450-468,484-498`; delete `:106,260-262,274-276,290-296,427-448`.
- `skills/feature/SKILL.md`: delete row `:67` and rewrite `:68`.
- `bun run build` regenerates `dist/contracts.js`; never edit it by hand.
- Set `.omp-plugin/marketplace.json` and `plugins/omp-build/package.json` to `0.12.0` together. This is an incompatible format change, so minor in 0.x. No changelog entry: the root `CHANGELOG.md` is frozen, and the rationale goes in the PR body.

## Acceptance → proof

| Issue criterion | Commits | Observed proof |
|---|---|---|
| No Semctx/AssertLedger in active code or docs, negatives only | C1–C9 | `rg -n -i 'semctx\|assertledger' plugins/omp-build` hits only the negative fixtures and assertions from C1, C4 and C5, each listed in the PR body |
| Proof recording, `proofPins`, `proof` step and adoption detection are gone | C1, C2, C4, C5 | `rg -n "proofPins\|ProofConfigPin\|'proof-confirmed'\|kind: 'proof'\|acquireFeatureProof" plugins/omp-build` returns no hit outside the C4/C5 negatives |
| Mandate and review change version; old format refused by name | C4, C5 | Negative tests for P2/P3 assert the `incompatible-format` code and message |
| Admitted without external proof; tests, CI and review untouched | C3, C6 | Gate positive case admitted with zero producer calls; red CI, moved head, spent bound and changed input each still refused |
| No exemption, renewal, migration or rollover | all | No such code path; reviewers check the diff |
| Worktree start indexes nothing for Semctx; residual config ignored | C1 | Integration negatives from C1, plus a smoke run: `worktree-bootstrap.sh` on a scratch repo with `.semctx/` and no `semctx` binary |
| Review guidance no longer judges Semctx verdicts | C8 | File diff and `rg` sweep |
| Glossary entries removed; Landing admission rewritten | C9 | `GLOSSARY.md` diff |
| Manual delivery under Q79 | PR | The PR body states the manual delivery and makes no positive-proof claim for the current `/feature` |

Final gate before review: `bun run typecheck`, `bun run lint`, `bun run test`,
`bun run build` with a clean `git status`, `bun run verify:omp-build-distribution`, and
`scripts/check-skill-version.sh`.

## Cutover (operator responsibility, not developed)

- Precondition (D44): no omp-build delivery in flight. Every pre-#902 mandate, review and proof record becomes `incompatible-format`.
- The hosted gate (`.github/workflows/auto-merge.yml:164-180`) runs the pinned tooling `vars.OMP_BUILD_TOOLING_SHA` with its committed `dist/contracts.js`. Until that variable points at a commit containing this change, the old strict schema rejects every new-format mandate, because it lacks `proofPins`. Updating the variable is an operator infra step (`wizard`).
- Reinstall the omp-build plugin cache after merge.

## Out of scope

- Per-criterion proof (tranche "livraison par critère"). Today's behavioral-verification review obligations stay.
- Correction-loop falsification.
- `.gitignore:22-25` `.semctx` entries at the repository root: inert, outside omp-build.
- Any migration, re-review or exemption for in-flight deliveries (D44).

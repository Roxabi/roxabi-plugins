# Goal

Make `landPr` admit only the selected PR/current candidate for which applicable producers already supplied usable evidence. Allow an early PR before full proofs exist. Admission reads evidence; it does not generate proof, rerun tests or reviewers, or promote PARTIAL to VERIFIED.

**Origin:** replaces [#751](https://github.com/Roxabi/roxabi-plugins/issues/751) and [#624](https://github.com/Roxabi/roxabi-plugins/issues/624) under [#720](https://github.com/Roxabi/roxabi-plugins/issues/720). The operator-approved 2026-10-08 contract substantively removes opening-time admission. Both old issues are superseded as NOT_PLANNED, not delivered. Their comments and stops remain evidence.

## Current evidence and entry files

Source was re-read at [baseline `5715fe300648eaaae3b4ff6191540eefa6afd117`](https://github.com/Roxabi/roxabi-plugins/tree/5715fe300648eaaae3b4ff6191540eefa6afd117):

- `plugins/omp-build/skills/feature/workflow.js`: `openPr` returns an existing PR without proof or disarm; `landPr` owns review/head authorization, base-authoritative landing and the shared armed-gate exit. `nextReviewStep`, `applyCiWatchExit` and `disarmReviewedBeforePush` already use that owner.
- `plugins/omp-build/skills/feature/proof-gate.ts`: currently a caller-input predicate; nonempty `acceptedReasons` replaces the fixed enum. `proof-gate.test.ts` has predicate tests, not production admission evidence.
- `plugins/omp-build/skills/feature/SKILL.md` §§6.0–6.7, `plugins/omp-build/skills/dev-review/SKILL.md` Phase 2 step 5/5a, `plugins/omp-build/GLOSSARY.md`, `plugins/omp-build/README.md`, `workflow.d.ts` and `epic-close.ts`: current prose places proof before open and closes the contract; those instructions need the explicit policy cutover.
- Existing production consumers/tests: `land.integration.test.js`, `land.test.js`, `armed-gate.test.js`, `openpr.test.js`, `review-start.integration.test.ts`, `epic-driver.ts` and `goal-scenario.integration.test.ts` in `plugins/omp-build/skills/feature/`. The stopped branch contains `proof.integration.test.js`; that is historical reusable evidence, not a current-main file or a passing current test.

PR [#756](https://github.com/Roxabi/roxabi-plugins/pull/756) is OPEN/disarmed at `0119b57142a2c01179d217f15cea47cf0169a0ea` in the current snapshot. Review references, with round-local RC IDs:

| Reference | Exact review / receipt |
|---|---|
| P1, head `11643336` | https://github.com/Roxabi/roxabi-plugins/pull/756#issuecomment-6044599290 |
| P2, head `ddf111f7b0b478cbeb3e64f10275d860356fcef0` | https://github.com/Roxabi/roxabi-plugins/pull/756#issuecomment-6045882195 |
| P3, head `0119b57142a2c01179d217f15cea47cf0169a0ea` | https://github.com/Roxabi/roxabi-plugins/pull/756#issuecomment-6055555881 |
| Corrections, not delivery | https://github.com/Roxabi/roxabi-plugins/pull/756#issuecomment-6045493004 ; https://github.com/Roxabi/roxabi-plugins/pull/756#issuecomment-6046106984 |
| Stop dossier | https://github.com/Roxabi/roxabi-plugins/pull/756#issuecomment-6055566846 ; https://github.com/Roxabi/roxabi-plugins/issues/751#issuecomment-6055568304 |

P3 observed a trailing-space principal path producing a false no-Semctx exemption. It also observed existing/422 open admitting proof from a different selected GitHub head; the review explicitly did not demonstrate that as a landing bypass. Four additional P3 findings concern missing safety regressions. These are unmerged-branch observations, not claims that all those helpers exist on main.

## Decisions and implementation responsibilities

### One admission boundary, existing evidence

1. Keep `openPr` as early publication/idempotent lookup, including the 422 race. Delete opening-time proof admission and its special refusal/cleanup machinery instead of porting it. An existing PR does not become authorized merely because open returned it. Resume which reexamines authority must confirm disarm through the existing owner before reading/reviewing/editing; a failed barrier stops work. Do not claim current `openPr` already disarms.
2. Integrate evidence acquisition/assessment into `landPr` after ordinary review/spent-bound/head refusals and before any merge-capable arm. Carry repository, selected PR, ticket/branch, current candidate and evidence input identity consistently through this boundary. A local HEAD, a offered PR body, a proof for another SHA or a similarly named branch cannot substitute for the selected artifact.
3. Consume existing producer results and their exact tested/analyzed inputs using producer-specific formats. Preserve the actual result and supporting observations, not an agent-authored `proof: true`, a narrative alone, a lifecycle word, or a made-up receipt. Reuse only evidence applicable to the selected candidate; changed relevant inputs, unreadable evidence or missing binding refuse admission and identify what proof must be produced separately. No new universal manifest, cache, ledger or verification-commit protocol. At implementation, use the owning producer reader/parser; do not resurrect the stopped hand-written `.sem` subset parser as a proof oracle.
4. Semctx is applicable only when configured for the intended repository, including ignored configured state in a linked/principal checkout. Establish actual absence separately from unreadable/ambiguous configuration or Git failures. Read applicable committed change contracts from `.semctx/semantic/changes/*.sem` at the bound candidate and root, not `.semctx/working/` emptiness or a nested shadow. The composed change producer has VERIFIED/PARTIAL/BLOCKED/STALE results; its impact producer PASS/WARN/BLOCK is a different namespace and not runtime proof. The existing `semctx_change_verify`/`semctx_verify_change` producer workflow runs outside admission, never as an admission rerun.
5. Retain applicable fix+adapter assertledger policy independently of Semctx absence: `detection` admits; `WEAK_ORACLE`, `miss`, missing or unreadable applicable verdict refuses. No adapter is nonblocking. Applicability must reflect actual ticket/adapter facts and existing producer information, not a caller false value that disables the rule. Do not invent a new adapter framework or restore the removed falsify oracle.

### Policy and exits

- A valid justified PARTIAL stays PARTIAL, with all gaps named and accounted for. Never invoke contract close as VERIFIED or require a forged verified lifecycle to land it. BLOCKED/STALE or contradictory VERIFIED+unresolved-gaps refuses. PARTIAL with no named gap refuses rather than vacuously satisfying coverage.
- Closed NO TEST enum: `infra-not-wired`, `prompt-logic-only`, `ui-manual-only`, `out-of-scope`; caller `acceptedReasons` cannot widen it. For `ui-manual-only`, committed candidate `commands.test_e2e` makes the reason inadmissible. Otherwise the actual selected PR body contains nonblank browser steps, a valid URL and nonblank observed result supported by the producer evidence. Body wording alone does not certify the check.
- A proof refusal uses the existing shared forced-unarmed epilogue and observable `proof-blocked` stop. No pin, label or other admission arm may occur. Clearing failure throws naming remaining/uncertain arms, never a false disarmed receipt. Review refusal precedence, refreshed current-SHA approval, base configuration, required CI, native `no-required-checks` disarm and unreadable-pin handling remain intact.

## Acceptance criteria

### Admission and evidence

- [ ] **AC1.** Early create, existing lookup and duplicate-422 reuse do not demand full proof. An authority-reexamining resume confirms disarm through the existing owner before work; barrier failure causes no work. No opening gate remains in executable code or skill instructions.
- [ ] **AC2.** The real `landPr` path reads producer evidence for the selected repository/PR/current candidate and verifies exact relevant input identity. Independently different proof SHA, selected PR SHA, local checkout/branch tip or analyzed inputs cannot authorize the wrong artifact. Stale/missing/unreadable applicable evidence returns an actionable refusal before arming; a genuinely exact reusable result admits without tests, Semctx analysis or LLM reruns from admission.
- [ ] **AC3.** Actual Semctx absence skips only that producer. Configured-but-ignored, unreadable, malformed or ambiguously located state cannot manufacture an exemption. Root, nested cwd and linked worktree produce the same bound decision, including principal paths with a trailing space or embedded newline. A failed HEAD probe is not an unborn-repository exemption; corrupt/missing candidate objects and non-repository failures refuse with their real cause.
- [ ] **AC4.** Committed applicable change evidence is read with the owning grammar/reader and bound root/candidate. Goal/evidence/non-change blocks cannot satisfy a change requirement; active/blocked relevant changes cannot hide behind a verified non-change block. Unsupported/read-error forms fail closed. Ignored `.semctx/working/` emptiness grants nothing.

### Policy and safety

- [ ] **AC5.** The closed NO TEST policy, contradiction checks and meaningful PARTIAL-gap requirement are enforced. Supported PARTIAL remains PARTIAL in reports/contracts; no automatic VERIFIED close occurs. `ui-manual-only` refuses for committed e2e declarations even when the dirty worktree stack omits them; otherwise blank/whitespace steps or observed result, bad URL, absent body content or absent underlying observation refuses.
- [ ] **AC6.** Actual fix+adapter cases admit only current applicable `detection`; WEAK_ORACLE/miss/missing refuse. Caller false applicability claims cannot disable the rule. No-adapter cases are nonblocking; no-Semctx does not exempt an otherwise applicable assertledger requirement.
- [ ] **AC7.** Proof refusal through the shared exit confirms clearing of known OPEN arms or throws naming the remainder, with zero new arm/pin. Red review and spent-bound refusals keep precedence, including a single non-spent red with bad proof. Existing base-required-CI/current-SHA/pre-arm refresh and unreadable-pin behavior stay effective.
- [ ] **AC8.** The real changed admission path has passing and failing behavioral regressions for AC2–AC7, with a valid counterpart for each refusal. The PR matrix distinguishes current exercised evidence from historical branch evidence and legitimate NO TEST; source-wording pins and exempt-Git mocks do not prove admission.

### Delivery and documentation

- [ ] **AC9.** Feature, dev-review UI/matrix guidance, workflow types, plugin/root README and GLOSSARY describe early publication versus landing admission, producer-specific evidence, configured applicability, freshness limits and PARTIAL honestly. Final epic review still uses the current enclosing range as a superset, not child-only and not permission to auto-fix foreign changes. Post-merge hook delivery #620 is unchanged.
- [ ] **AC10.** Implement from fresh `origin/main` on the new issue branch. Reuse proven design/hunks only after current-base revalidation, with fresh commits claiming this actual new issue; no wholesale cherry-pick of stopped commits claiming old tickets. Bump changed skill/plugin/package/catalogue versions consistently from then-current main and avoid an in-flight cache-key collision. Leave #756/#722 and all recorded stops/reviews untouched; do not retry, review, arm, merge or close them.

## Cause-disposition mapping

IDs refer to the exact reviews above. Removed opening obligations are intentionally lost capability, not delivered behavior; equivalent live landing protections remain mandatory.

### P3 residual blockers — all retained or causally removed

| Finding | Revised disposition |
|---|---|
| P3 RC-1 principal pathname loses identity | Required on the real admission/applicability reader: lossless path acquisition, absence versus unreadability, AC3. Not deferred. |
| P3 RC-2 existing/422 open uses another selected head; RC-5 missing divergent-head witness | Opening admission and its head-equality guard are removed. Selected-PR/current-candidate binding and a divergent-head refusal witness are required at `landPr` under AC2/AC8. Do not encode the observed open bypass as a landing policy. |
| P3 RC-3 blank PARTIAL UI fields | Required landing policy and production refusal regression, AC5/AC8. |
| P3 RC-4 empty PARTIAL gaps | Required nonvacuous landing refusal and regression, AC5/AC8. |
| P3 RC-6 non-change contract substitution | Required owning-reader change-kind discrimination and mixed-block regression, AC4/AC8. |

### Earlier blocking mechanisms — identity and policy

| Finding | Revised disposition |
|---|---|
| P1 RC-1 contradictory VERIFIED | Required status/gap consistency at admission, AC5/AC8. |
| P1 RC-2 create-body guard unproved | Removed with opening admission. Actual selected PR body/observations are required at landing, AC2/AC5/AC8. |
| P1 RC-3 pre-discovery proof refusal bypasses disarm | Removed with opening proof refusal. Real authority-reexamining resume must confirm disarm; landing proof refusal uses the shared owner, AC1/AC7. |
| P1 RC-4 competing version/cache identity | Required fresh release/cache identity in AC10, not an obsolete version number. |
| P1 RC-5 one-landing-only coverage in abandoned union implementation | Do not port that coverage certification. Exact child union/all claiming landings remain #723; retain the existing superset and its limits under AC9. No blocker of the revised admission path is deferred here. |

| Finding | Revised disposition |
|---|---|
| P2 RC-1 proof SHA inequality; RC-4 separate local-tip witness | Required selected candidate/evidence and local checkout/branch binding where those inputs are used, independent regressions AC2/AC8. No extra remote-tracking-tip policy. |
| P2 RC-2 ignored on-disk Semctx false exemption | Required configured-applicability distinction AC3/AC8. Presence triggers investigation, never proof of closure. |
| P2 RC-3 applicable open branch names another ticket | Removed as an opening proof gate. Required ticket/branch/PR identity for actual admission AC2; no wrong-ticket proof reuse. |
| P2 RC-5 committed stack versus dirty worktree; RC-6 cwd-relative shadow reads | Required root/candidate reads and discriminating regressions AC3/AC5/AC8. |
| P2 RC-7 non-spent review refusal precedence | Required independent single-red admission regression AC7/AC8. |

### Original acceptance and nonblocking records

| Previous owned criterion | Disposition |
|---|---|
| #751 AC1–3 opening/create/existing/body/head checks | Opening gate withdrawn; early publication AC1. Real selected-body/producer/candidate admission AC2/AC5/AC7. Born/unborn/read-error identity remains AC3. |
| #751 AC4–6 closed enum, Semctx, assertledger | Preserved and revised to producer evidence/PARTIAL at landing, AC3–AC6; no fresh rerun or false verified close. |
| #751 AC7 shared cleanup and precedence | Preserved on real admission, AC7; opening proof-specific cleanup removed. |
| #751 AC8–9 superset documentation, current gate/types/version/evidence | Preserved AC8–AC10. Exact union/teardown stays #723; useful #722 work is hunks/design only. |
| #624 items 1/2/3 | Proof item 1 revised here; item 2 delivered by #620, unchanged; item 3 exact union remains #723. Old origins close NOT_PLANNED as superseded, never as fulfilled old acceptance. |

Nonblocking records stay traceable: P1 RC-6/7 mock corruption fidelity and fixture isolation on #758; P2 RC-8–15 types, simulator parent selector, README qualifiers, subset-parser drift, missing local object, open-throw table, version-hook wording and rebase coverage on #759 with existing overlap #723/#724. Reconcile them against the selected implementation, not historical helper names. Types/docs/error handling necessary for these AC are required here; do not move a live admission parser/identity/refusal hole to those debt issues. No new ad-hoc parser is introduced, so old subset grammar is not a deferred safety exception. Coverage-specific proposals remain outside this slice because that union/certification is not installed.

## Verification

Use the existing workflow test harness with production Git and stateful isolated GitHub transport for real `landPr` results, arm/disarm state and side effects. Include admissible VERIFIED, admissible PARTIAL, no-Semctx and detection cases plus the independent counterexamples above. Observe the raw producer/input/candidate binding and prove admission invokes no proof-producing work. Fresh opening without proof and resumed-barrier failure are separate consumer smokes. Use long/space-containing principal paths, nested shadow artifacts, ignored configured state and Git/read/disarm failures. Regressions must fail if the relevant boundary is removed, not if prose changes. Keep temporary fixtures under suite teardown; no live merge or stopped-PR exercise.

Repository commands observed at the baseline are `bun run test` (Vitest), `bun run typecheck` and `bun run lint`; implementation runs relevant cases then repository checks and records the actual criterion-to-evidence matrix. None is claimed run by this drafting issue.

## Dependencies and sibling boundaries

- Prerequisite [#737](https://github.com/Roxabi/roxabi-plugins/issues/737): supplies the shared admissible behavioral-evidence contract; #768 is its executable landing consumer, not a second proof engine.
- Siblings #767 and #766 own safe fix-halt routing/conservation and red-only accounting/complete stop history respectively. Preserve their shared exits and refusal precedence without implementing their loops here. [#762](https://github.com/Roxabi/roxabi-plugins/issues/762) owns filing/final-review startup, not producer admission.
- [#723](https://github.com/Roxabi/roxabi-plugins/issues/723), [#724](https://github.com/Roxabi/roxabi-plugins/issues/724), [#758](https://github.com/Roxabi/roxabi-plugins/issues/758), [#759](https://github.com/Roxabi/roxabi-plugins/issues/759) are nonblocking followups outside #720, not prerequisites to excuse a live safety hole. General derivation/harness/union work is not automatically imported; exact required behavior here takes precedence over a debt label.

Parent alone integrates native relations and supersession. No provenance-only blocked-by edge to #624/#751 or stopped PRs.

## Non-goals

No full-proof opening gate, new universal evidence format, proof boolean oracle, admission test/reviewer rerun, autonomous standalone mode, exact epic child union, repeated post-merge hook, fresh accounting ledger or confidence waiver. No hostile-checkout sandbox claim: supported authorized repositories and trusted tools only, with accidental execution surfaces guarded. No stopped-PR automation or rewritten historical stop.

## Tier and priority

Proposed High / F-lite / fix. Factors files 7, risk 6, architecture 5, unknowns 3, breadth 4: κ = round(1.40 + 1.50 + 1.25 + 0.45 + 0.60) = 5. Cross-consumer candidate/evidence binding and safety regressions are independently landable, not a scaffold. #720 requires the slice; the current caller-widened NO TEST predicate also satisfies the shipped wrong-green priority trigger. Parent owns final metadata integration.

<!-- complexity: 5 -->

## Explicit revised acquisition plan and producer references

Approved decision: https://github.com/Roxabi/roxabi-plugins/issues/575#issuecomment-6068130413 . P1/P2/P3 repeatedly reconstructed identity at separate filesystem, Git tree and selected-PR acquisitions. The revised plan removes the opening gate completely and has one real landing selection carry repository/PR/candidate identity through applicability, producer evidence and final authorization. This is a substantive design/policy change, not an unchanged ticket with a renewed bound.

- **Retain:** closed NO TEST policy, actual selected-body UI observation, committed root/candidate reads, configured Semctx distinction, fix+adapter detection, shared refusal/disarm and current-SHA/base-CI safeguards, with their independent counterexamples.
- **Discard:** opening/create/existing/422 proof authorization and cleanup, caller-filled status/boolean as an oracle, `.semctx/working/` emptiness, lifecycle alone as freshness proof, and the stopped hand-written contract subset parser. Do not require full proofs merely to publish an early PR.
- **Revise:** acquire evidence through each configured producer and compare its own tested/analyzed-content and repository-state binding to the current candidate. Consumer transport preserves those native results/inputs; it is not a new universal receipt file or persistent proof ledger. If an owning producer cannot establish that binding, admission names the missing proof and stays disarmed rather than inventing provenance or running the producer itself.
- **Semctx references:** existing `semctx_change_verify` composes VERIFIED/PARTIAL/BLOCKED/STALE without upgrading PARTIAL; `semctx_verify_change` reports PASS/WARN/BLOCK impact and runs no runtime tests. `skill://semctx-verify` describes optional guarded-state canonical input/repository binding and the separate runtime proof obligation. Use the installed owning reader and supported native output, not guessed schema fields or a renamed PASS as VERIFIED. Assertledger likewise uses the configured producer native detection result/input evidence, not a fabricated common adapter envelope.
- **Discriminator:** independently vary selected GitHub candidate, proof inputs, local tip, root/nested/principal identity and absence/unreadability. Valid exact producer reuse admits without invoking tests or reviewers; a mismatch refuses before arm and preserves the native diagnostic. This is the real safety oracle replacing open-time narrative checks.


## Supported perimeter and conservative trust boundary

The initial delivery perimeter is authorized repositories already configured for Semctx. Do not add a generic proof store, manifest, runner or provenance protocol for non-Semctx repositories. Actual Semctx absence is explicit nonapplicability for Semctx only: the existing behavioral verification, current-SHA review, required CI and applicable fix+adapter detection policy continue. #770 observes installed Semctx-present and Semctx-absent paths separately.

For an applicable proof, acquire the existing producer result/receipt from its supported native output or existing producer-owned state, together with the actual invocation/tested input facts needed to bind it to the selected candidate. Use trusted installed producer readers and authorized operator evidence; caller narration or PR-body text cannot manufacture a result. No undocumented field, arbitrary status object or closed lifecycle alone supplies provenance. Missing/unreadable/stale/unbound applicable results keep admission disarmed with a diagnostic identifying what must be produced in the normal verification workflow, outside admission. Admission does not execute that producer to repair missing evidence.

This is conservative evidence acquisition under a trusted operator/tool model, not cryptographic attestation or anti-fraud against that operator. A native analyzed-content/input binding may remain applicable across a changed commit identity only if the producer actually proves the exact relevant candidate inputs match; no guessed SHA equivalence or invented verification ledger. Applicable PARTIAL keeps its honest native result and justified gaps. Genuine absence never creates a fake producer result and never waives unrelated review/CI behavior.



## Execution preflight — 2026-10-09 (#768 integration)

Steps 2–5 of the local integration todo are now operator-authorized; the historical “awaiting authorization” is superseded. No acceptance criterion is removed or declared delivered by this note.

The fresh issue worktree is on `fix/768-semctx-proof-admission`, at current `origin/main` `70d753bacff708145111c8d8bd6ffc3c807c26d8`. Native dependencies were read directly: **#768 is blocked by OPEN #737**; #737's #734 prerequisite is CLOSED. Feature §§5 and 6.0 stop implementation on that open edge. Branch preparation is not implementation authority for a blocked ticket.

This is not only a stale tracker state: current `fix/falsification.md` lines 37–54 still emits `pass` when falsification was skipped and aggregates coverage gaps as pass; `dev-review/root-causes.md` lines 33–39 does not carry failure/restored/paths/proof and line 56 still selects Solution 1. The shared one-proof/explicit-skip contract belongs to #737; #768 must consume it rather than create a second proof engine. The current scope does not authorize silently importing all #737 emitters, confidence, recall, taxonomy and causal-walk work into #768.

**Safety stop:** no plugin implementation, commit, push, PR or merge started. The actual `resolveReviewPr` owner returned `null` for this branch; a separate GitHub branch query returned no PR. Consequently there is no selected OPEN PR gate to clear and no `disarmed: true` claim. All historically stopped PRs remain untouched. Semctx stays installed 0.4.2 with bundle SHA-256 `ee7a4626a4b395757c5d989cfb0db60bdeb202d4354c7f922539741043a46ca8`; the old fixture proof was not rerun or promoted to current production evidence.

Resume requires the genuine #737 prerequisite to be delivered, or explicit human arbitration of a bounded prerequisite scope/landing sequence. The native edge is retained; #737 remains open and #734 is not re-closed or re-certified. Tier High/F-lite and complexity 5 are unchanged: this note records a preflight stop, not new acceptance scope.

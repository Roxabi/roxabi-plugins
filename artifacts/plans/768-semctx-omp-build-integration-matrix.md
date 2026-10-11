# #768 — integration preflight and criterion ownership

Date: 2026-10-09, updated 2026-10-11 after implementation. Baseline then: `70d753bacff708145111c8d8bd6ffc3c807c26d8`; delivery base: `2c44cc10c21ab278fa7e0f668518d211cbf4ebb1` (#737 merged via PR #774). Worktree: `fix/768-semctx-proof-admission`.

## Status and authority

**Historical (2026-10-09):** implementation was stopped at the native prerequisite barrier #768 → OPEN #737 → CLOSED #734. **Current (2026-10-11):** #737 closed by PR #774; the implementation is on the branch and its current evidence is § Implementation evidence. The tables between that section and this one are the plan of record written before implementation; their "pending/owed" wording is historical.

Sources: current [#768](https://github.com/Roxabi/roxabi-plugins/issues/768), [#737](https://github.com/Roxabi/roxabi-plugins/issues/737), [#734](https://github.com/Roxabi/roxabi-plugins/issues/734); direct `gh api .../dependencies/blocked_by`; current source paths below. #734 closure is observed tracker state, not a new certification of every #734 criterion.

## Native prerequisite and scope boundary

| Contract | Owner | Current evidence | Disposition |
|---|---|---|---|
| One falsifiable failure/restored behavior/paths/proof per mechanism | #737; `dev-review/root-causes.md`, review/fix consumers | Current cause block has mechanism/fix/findings only (33–39); line 56 selects Solution 1 | Genuine unimplemented prerequisite; no parallel proof schema in #768 |
| Skipped falsification is not a pass | #737; `fix/falsification.md`, `fix/SKILL.md` Phase 4 and receipt | `falsification.md` 37–54 emits pass on skip and aggregates gaps as pass; fix 281–289 consumes pass/fail | Genuine safety dependency, not narrative debt |
| Distinct defects/callsites/provenance survive review→fix | #734; current rendered record | Tracker CLOSED; current #737 contract retains its independence requirement | Preserve delivered owner; do not reopen or claim new whole-issue coverage |
| Emitter solution menus/confidence/recall and complete causal walk | #737, not the #768 landing consumer | #737 current acceptance names these cross-consumer changes | Importing the complete issue is a substantive extension; requires arbitration, not silent epic execution |
| Native acquisition/landing/resume integration | #768; existing feature/workflow/disarm owners | `proof-gate.ts` still caller-driven; feature 388–395 still opening gate/forced close/working emptiness | Required #768 work remains unimplemented |

## Exhaustive #768 acceptance → owner → change → proof

Plan of record, written before implementation: every row was pending then. Executed evidence per row is in § Implementation evidence.

| Criterion and sub-obligation | Existing owner | Required change | Production proof still owed |
|---|---|---|---|
| AC1 early create/existing/duplicate-422 without full proof | `workflow.js` `openPr`; feature §§6.2–6.3 | Remove opening proof instructions; retain idempotent lookup and publication | Real fresh/existing/422 publication without producer result |
| AC1 authority-reexamining resume barrier, failure prevents work | `nextReviewStep`, `disarmReviewedBeforePush`, `enforceArmedGate`; feature §6.0 | Reuse confirmed forced-unarmed owner before review/edit | Armed resume clears both arms; failed clear executes no review/edit/producer |
| AC2 selected repository/PR/ticket/branch/current candidate | `landPr`, `resolveReviewPr`, entry/ticket owners | Carry one selected identity through admission, no local/body substitution | Independently vary proof SHA, selected SHA, local tip, ticket/branch and candidate scope |
| AC2 exact relevant analyzed/tested inputs | Installed native Semctx readers; normal producer workflow; `landPr` consumer | Capture native output separately from actual invocation and behavioral-input observations; compare exact relevant identities | Positive native reuse plus independently changed code/model/config/index/base/inputs refusals |
| AC2 no producer/test/LLM inside admission | `landPr` | Reader-only admission; missing proof names external production action | Instrument actual calls and effects: positive admission with zero new analysis/test/LLM |
| AC2 missing/stale/absent/ill-readable applicable result | `landPr`, shared armed-gate exit | Actionable named refusal before arm | Each refusal paired with applicable positive proof and observable unarmed state |
| AC3 genuine absence versus ignored/root/nested/principal state | Git/root owners, configured applicability, native config reader | Evidence-based applicability before any Semctx call, no caller exemption | Real absent case; ignored/principal configured and nested-shadow counterparts |
| AC3 linked worktree and lossless special principal path | Same root/identity owners | Preserve pathname bytes including trailing spaces/newlines; bind actual repository | Real linked/nested fixture with long/space/newline paths and same decision |
| AC3 unreadable/malformed/ambiguous config; Git/object errors | Owning readers and Git adapter | No absent/unborn exemption on read error or failed HEAD/object probe | Permission/config/ambiguous-root/nonrepo/corrupt/missing-object refusals with precise cause |
| AC4 committed applicable change kind and relevance | Native Semctx grammar/semantic reader | Read candidate root `.semctx/semantic/changes/*.sem`; no ad-hoc DSL parser | Non-change substitution refuses; active/blocked relevant change cannot hide behind verified unrelated declaration |
| AC4 working state not closure/freshness evidence | Same native reader; feature guidance | Remove working emptiness and forced VERIFIED close | Changed ignored overlay refuses; nonempty legitimate native working state does not itself refuse |
| AC5 closed NO TEST enum | Existing `proof-gate.ts` policy consumer | Remove `acceptedReasons` widening; exactly infra-not-wired/prompt-logic-only/ui-manual-only/out-of-scope | Fixed enum permits justified counterpart, refuses caller-added reason |
| AC5 meaningful PARTIAL/contradictions | Native composed verdict + existing policy consumer | Preserve PARTIAL; require all named gaps justified; reject empty gaps and VERIFIED with unresolved obligations | Actual PARTIAL positive; empty/unjustified/contradictory refusal; no close/upgrade |
| AC5 amended selected-body UI form, committed e2e and review judgement | Proof-aware review (truth ceiling); committed stack and admission form/chronology readers | Read the selected body and both base/head e2e declarations; review judges reason truth/credible performance; no native observation oracle | Dirty stack cannot hide e2e; blank fields, invalid URL, missing block/body and late proof/body refuse. Truth/performance are review-judged, not established by regressions |
| AC6 actual fix+adapter detection independent of Semctx | Existing assertledger producer/adapter policy | Derive applicability from ticket/adapter/native result; retain native verdict and tested input facts | Current detection admits; WEAK_ORACLE/miss/missing/unreadable refuse; no adapter nonblocks; absent Semctx does not waive adapter |
| AC7 shared proof-blocked forced-unarmed epilogue | `landPr`, `enforceArmedGate`, `disarmGate` | No new cleanup convention or arm/pin on proof refusal | Known label/auto-merge cleared and read back; failed clear names uncertain/remainder arms |
| AC7 red/spent precedence | Existing review-record and bound owners | Keep ordinary review/spent/head refusals before proof assessment | Single non-spent red + bad proof still review refusal; spent bound cannot be reset |
| AC7 current-SHA/pre-arm refresh/base-required CI/pin errors | Existing `landPr`, base landing resolver, CI owner | Preserve authoritative base policy and refreshed head/review checks | Head/review movement and unreadable pin refuse; required-checks and no-required-checks behavior remains |
| AC8 real production smokes and regressions, not prose/mock echoes | Existing integration harness plus disposable repos/isolated transport | Exercise actual consumers after last writers; keep behavior regressions | Valid counterpart for each AC2–7 negative; arm/disarm and call traces observed |
| AC9 coherent executable types/output/docs/skills | Feature/review/fix owners; `workflow.d.ts`; plugin/root README; GLOSSARY; epic-close | Cut over all affected consumers and document provenance/freshness limits/PARTIAL | Current owner interfaces compile and real surface emits the honest result; docs describe exercised behavior |
| AC9 final enclosing superset and unchanged #620 hook | Existing epic-close/review/hook owner | Preserve enclosing range; no exact child-union claim or foreign auto-fix grant | Existing behavior intentionally unchanged; no epic/hook execution in #768 smokes |
| AC10 fresh base/history/versions/no stopped-PR reuse | Feature entry/history; package/catalogue and changed-skill version owners | Fresh #768 commits; version keys move consistently without collision; no wholesale stopped cherry-pick | Preflight observed fresh branch at remote base, no PR; future checks still required after actual edits |

## Additional authorized integration obligations

| Obligation | Owner/change boundary | Proof/status |
|---|---|---|
| Semctx applicability before orchestration; no redundant lifecycle injunctions | Feature/fix/review guidance and existing normal producer workflow | Pending actual present/absent/invalid paths; no lifecycle stage manufactured |
| `/fix`→`/feature` avoids already completed verification/commit/push on identical inputs | Existing fix completion, feature re-entry and review-record owners | Pending real fix-complete/resume walk; require new candidate review and retained bounds/disarm |
| Durable result conservation and re-read across process/session resume | Existing workflow dossier, producer-specific captured outputs and actual invocation facts only | Not demonstrated by historical in-memory probe; pending production acquisition design and smoke |
| Changes during acquisition, including transient modification+restoration | Acquisition owner, not admission rerun | Unresolved: pre/post hashes alone are insufficient; must establish a genuine immutable/exclusive consumed-input window or refuse unknown binding |
| Relevant dependencies beyond the old fixture | Native identity plus actual consumed runtime/config/tool/environment dependency facts | Closed supported perimeter must be explicit; unknown load-bearing input refuses rather than guessed universal certification |
| Delete only demonstrated equivalent local validation | Existing producers and local diagnostic owners | No deletion authorized merely by repetition; equivalence of exact inputs and diagnostics not yet proved; independent CI and CCC retained |
| One PR with current review/required CI, bounded fixes and native landing | Existing review/fix/landPr owners | No PR yet; all production delivery proofs pending |
| Issue closure only on complete shipped acceptance | Issue-triage/tracker owners | No issue closed or dependency removed; #737 open preserved; #734 closure observed only |

## Acquisition, conservation and re-read protocol — fixed 2026-10-11 before implementation

Resume 2026-10-11: #737 CLOSED via PR #774 (merge `2c44cc10c21ab278fa7e0f668518d211cbf4ebb1`); #768's only blocker is closed; branch fast-forwarded to that base. Installed Semctx re-read: `0.4.2`, bundle SHA-256 unchanged (`ee7a4626…`). Native surfaces re-characterized on disposable fixtures (scout `SemctxSurfaces`, `AssertledgerSurfaces`, and a local fixture `/tmp/omp768/fx`): the facts below are current observations, not the step-1 history.

### Native facts that constrain the protocol (Semctx 0.4.2)

| Fact (observed) | Consequence |
|---|---|
| `change verify` reads contract + evidence status from the **checked-out working tree**, and requires the checkout's index bound to `--head` (else BLOCKED `index_binding_stale`) | Production only in a clean detached checkout of the exact candidate, indexed there |
| Ignored `.semctx/working/active-change.sem` **overrides** the committed contract (tampered pointer turned PARTIAL into VERIFIED) | Private clone has no ignored state; a candidate that *commits* `.semctx/working/*` (other than `.gitkeep`) is refused |
| Empty `requires_evidence` yields VERIFIED with no proof (S3) | VERIFIED is not self-sufficient: the change's native contract must require ≥1 evidence |
| `analysisInputHash`, `repositoryGraphHash`, `sealHash` depend on the absolute root; `planeAIndexSnapshotHash` changes per index run | Seals are compared only within one acquisition (before/after), never across checkouts |
| `status --json` exit 0 only FRESH/DIRTY_KNOWN; absence = `UNSEALED` + `REPOSITORY_NOT_INITIALIZED`; config errors exit 1 `CONFIG_INVALID` | Applicability is decided from Git/filesystem facts before any call; a config error is a refusal, never absence |
| No native enumerator of change contracts; `semantic check --json` gives `counts.changes` and non-terminal ids | Changed contract files come from `git diff`; each must be one `change inspect`-able change; `counts.changes` must equal the committed change-file count |
| `change verify`/`status`/`semantic check`/`change inspect` write nothing; `index` writes only ignored `.semctx/semctx.db`; no network/HOME needed | Producers run in the private clone; Git status stays empty there |
| Gaps: `pendingEvidence[]`, `openUnknowns[]` (present), findings `required_evidence_pending`/`open_unknown`; lifecycles `draft/active/verified/partial/blocked/stale/superseded`; proved statuses `tested/statically_verified/runtime_verified` | Policy reads these native fields only; no `.sem` parser |

Assertledger (source 1.4.0, installed 1.1.0, npm 2.0.2): no native `detection`/`miss` and no freshness command. Native result = evidence manifest (`decision.status`, `candidates[].status` incl. `WEAK_ORACLE`); `replay` checks integrity only; Git `check` manifests carry `worlds[].provenance` `{format:'assertledger-git-regression/1', role, commit, tree}`. The Roxabi vitest kit `verify` manifests carry only a short `HEAD[+dirty]` string.

### Protocol

1. **Selection (one identity).** The selected PR `N` (driver/`resolveReviewPr`), its current `headRefOid` `C` (GitHub), its base and `nameWithOwner`. Local tip, branch name or PR body never substitute for `C`.
2. **Applicability before any call** (`proof.ts` `candidateFacts`, Git + `lstat` only, lossless paths from `git worktree list --porcelain -z` and a single-newline strip of `rev-parse --show-toplevel`): the local tip must be `C` (`rev-parse --verify HEAD^{commit}`; a failed probe refuses with its cause, never as an unborn branch); `ls-tree` of `C` failing (missing/corrupt object) → refuse with Git's stderr; committed `.semctx/working/*` other than `.gitkeep` → ambiguous; committed root `.semctx/config.json` (regular file, JSON object) → applicable, else unreadable; committed root `.semctx/**` without that config → ambiguous; nothing committed but `.semctx` present on disk at the toplevel or the principal worktree → ambiguous, and an unreadable one → unreadable; nothing anywhere → **absent**: only the Semctx proof is non-applicable. A `.semctx` committed deeper in the tree is not Semctx's root state and does not decide (decision below).
3. **Acquisition (producer, outside admission)** — `bun proof-acquire.ts --pr N [--assertledger-manifest <path>]` from the worktree at `C`: reuse first (latest record by the automation login that still binds `N`/`C`/repo/inputs → `reused`, no producer call). Otherwise `git clone -q --shared --no-checkout` of the toplevel into a fresh `mkdtemp` dir, `checkout --detach C`; refuse if `git status --porcelain -z --untracked-files=all` is not empty. Run, capturing raw stdout/exit: `index`, `status` (before), `semantic check`, `change inspect <id>` and `change verify <id> --base <merge-base> --head C` for every changed `.semctx/semantic/changes/<id>.sem` in `merge-base..C`, `status` (after), then `git status` again plus the `--ignored` list. A run whose own record does not bind (status not FRESH, seals differ, dirty or Semctx working state in the clone, step exit outside the native set) posts nothing and exits 1.
4. **Conservation** — one PR comment per producer by the automation login, first line `<!-- omp-build:proof producer=semctx -->` (or `producer=assertledger`): a human summary, then a JSON record with two separate parts: `invocation` (observations: repository, PR, candidate, base, merge-base, tool version/path, private root, changed contract files, clean-tree before/after, argv/exit per step) and `native` (the producers' raw stdout, unmodified). No file in the repository, no cache, no ledger; the PR is the dossier the review records already use.
5. **Re-read at admission (`landPr`, readers only)** — after review/spent/head refusals and landing resolution, before any arm: applicability at `C`; latest record of each applicable producer by the automation login; binding checks (repository, PR, candidate = reviewed = current head, merge-base recomputed locally from `origin/<base>`, changed-contract set recomputed from `git diff`, native `underlying.head/mergeBase/changeId`, `status` FRESH before/after at `C` with equal seals, private root consistent); then policy. Admission executes no Semctx, assertledger, test or LLM call.
6. **Policy** — VERIFIED needs non-empty `requiresEvidence`, no pending/unknown/stale/finding, invariants `proved`/`untouched`; otherwise contradiction → refuse. PARTIAL needs ≥1 named gap, every gap justified by a PR-body NO TEST row from the closed enum; `ui-manual-only` refused when `C:.dev/stack.yml` declares `commands.test_e2e`, else the selected PR body must carry that gap's browser check (nonblank steps, valid http(s) URL, nonblank observed result). BLOCKED/STALE, lifecycle `draft/blocked/stale/superseded` → refuse. Nothing is closed or promoted.
7. **Assertledger** — applicable iff the candidate tree declares an adapter (`assertledger.config.json` with `adapter`, or the kit adapter `scripts/kit/assertledger/vitest-adapter.mjs`) **and** a closing issue of the selected PR has issue type `fix` (read from GitHub, unreadable → refuse). Acquisition (`--assertledger-manifest <path>`) records the manifest bytes and a native `replay`. Admission: replay valid, a `reference` world provenance `commit` = `C`, `decision.status` VERIFIED with a selected candidate = `detection`; `WEAK_ORACLE`, any other result, a missing or unbound manifest → refuse. Short/dirty provenance (kit `verify`) is an unknown binding → refuse with that diagnostic. Independent of Semctx absence.
8. **Refusal** — `{ status: 'proof-blocked', producer: 'candidate' | 'semctx' | 'assertledger', reason, error }` through the shared forced-unarmed epilogue (`enforceArmedGate`), no pin/label; the error names what to produce outside admission. Epic: ticket stop `proof-blocked`.

**Relevant inputs** (supported perimeter): commit `C` (sources, committed `.semctx/config.json`, `.semctx/semantic/**`), merge-base with the selected base, the Semctx tool version recorded from its native seal. Ignored/untracked state is never an input (private clone). External dependencies are not analysed by Semctx (config excludes `node_modules`). Not covered, hence refused rather than guessed: unknown or missing binding fields, records of another candidate/PR/repository, other tool outputs. Trust model: authorized operator and installed tools; the automation-login PR comment is trusted like the review records — not cryptographic attestation.

## Implementation evidence — current (2026-10-11, branch before the PR)

Observed on the final worktree state, after the last writer of each file. The PR's own CI, review and landing add the delivery rows.

| AC | Change | Current evidence (observed) |
|---|---|---|
| AC1 | Opening gate (feature §6.3) and `proof-gate.ts` deleted; `openPr` unchanged — it never consulted proof; §6.2/§6.3 allow an early PR that authorizes nothing | `openpr.test.js` created/existing/422 rows unchanged and green; walk below opens with no record. Resume barrier unchanged: `nextReviewStep`/dev-review step 0 disarm owner (`armed-gate.test.js`) |
| AC2 binding | `admitLanding` binds repository, operator login, selected PR, candidate = reviewed = current head = local tip, base, merge base, every added/modified contract, native verify range, FRESH equal seals | Integration: another login's record → `missing`, the same record by the operator admits; the latest complete record wins and a newer BLOCKED never falls back to an older VERIFIED; multipart above GitHub's 65536 ceiling admits only whole. Unit: status before/after, absolute clone root, indexed commit/root, argv/exit, native range, repository/PR/base/contract set and seal mismatches refuse |
| AC2 no producer | Admission reads only | Every integration scenario uses failing, logging `semctx`/`assertledger` stand-ins first on PATH; positive admissions and paired refusals observe zero producer calls. A VERIFIED admission posts no comment |
| AC3 | Base∪candidate∪checkouts decide applicability before any producer call | Integration: ignored operator config copied into the private acquisition checkout binds and admits; removing/relaxing base policy or adapter/e2e declarations grants no exemption. Real Git: unborn local HEAD, malformed committed JSON, missing tree object and actual principal-root EACCES after declaration reads refuse precisely, with gates unarmed; restoring HEAD/access admits. Unit: symlink/array config, unresolved/option base and ambiguous root state refuse |
| AC4 | The candidate must add its own contract; every open change must have its own file | Integration: modified-only → `missing`; added+modified with both VERIFIED admits; a hidden active change refuses even when counts match; a goal block under `changes/` is never recorded. Unit: only `ACTIVE_CHANGE_POINTER_MISSING` is tolerated, other pointer findings or unreadable lifecycle findings refuse; nested, deleted and retyped contracts fail closed |
| AC5 (amended) | PARTIAL gaps = findings∪pending evidence∪open unknowns; stale links, blocking findings and impact BLOCK refuse; browser check form is gap-bound; truth is review-judged | Integration: enum/browser/e2e and post-review body edits refuse or admit their paired valid cases; blank/null e2e declares none, non-map document/commands refuses ui-manual-only. A mixed VERIFIED+PARTIAL record stays PARTIAL and needs the pending gap's row. Unit: each VERIFIED/PARTIAL contradiction term and lifecycle guard is discriminated; impact WARN preserves PARTIAL. No regression claims observation/reason truth |
| AC6 | Shared `fixKind` signals on head branch or any closing issue; either side's adapter applies independently of Semctx | Integration: branch/title/label/org Bug signals each require detection; Semctx VERIFIED alone in a repository with both producers refuses missing assertledger, both records admit. Detection admits; WEAK_ORACLE and absent/unbound records refuse. Unit: selected candidate ELIGIBLE, every replay validity flag and replay exit are checked separately |
| AC7 | Existing forced-unarmed epilogue; current approval and admitted head bind every arm | Integration: proof refusals disarm with read-back, red/spent precedence preserved. Stateful armed-gate: a freshly approved new head is re-admitted before pin/re-pin; an unbound new head refuses. Head+approval moved only at the epilogue → `head-moved`, unarmed; same-head fresh approval stays armed. Native and merge-on-green proof refusals either confirm disarm or throw naming exactly what remains armed |
| AC8 | Real consumers on disposable repositories | Records are the real producers' output (Semctx 0.4.2, assertledger 1.4.0, node v24.18.1, git 2.56.0) conserved by `capture.ts`; the sandbox rebuilds every sha byte for byte and the test fails on drift. Smokes below |
| AC9 | feature 0.1.2, dev-review 0.2.1, fix 0.3.1; `workflow.d.ts` `proof`; `landPr` JSDoc; plugin/root README; GLOSSARY; ADR-024 §4 | `bun run typecheck`, `bun run lint`, `scripts/check-skill-version.sh` exit 0; `landOutcome('proof-blocked')` → ticket stop (`epic.test.ts`); epic-close superset and the #620 hook untouched |
| AC10 | Fresh commits on `2c44cc10`; omp-build 0.9.12 → 0.9.13 in `package.json` and `.omp-plugin/marketplace.json` | No stopped PR reused; #756, #760, #763, #722 untouched |

Throwaway smokes (real `landPr`, `nextReviewStep`, `proof-acquire`, simulator transport):

- **Reuse/resume.** A second `proof-acquire` on the same head reports `reused` for Semctx VERIFIED, Semctx PARTIAL and assertledger detection, with failing stand-ins first on PATH: 0 producer calls, no new comment.
- **/fix → /feature.** PR 11: acquire C1 `posted` → approval of C1 → `nextReviewStep` `land` → a fix commit pushed as C2 → `nextReviewStep` `review`/`head-moved` → `landPr` `not-approved`/`head-moved` → approval of C2 → `landPr` `proof-blocked`/`semctx`/`missing` → acquire C2 `posted` (inputs changed) → acquire C2 `reused` → `landPr` `watching` with `proof` VERIFIED. Every `landPr` and the second acquire: 0 producer calls.

## Decisions and limits

- **Root state only.** Semctx's state is the `.semctx` at the repository root (committed at `C`, or on disk at the toplevel or the principal). A `.semctx` committed deeper in the tree does not decide; the cwd never does. Limit: a sub-project Semctx root inside a monorepo is not supported.
- **Local tip = candidate.** Admission reads the candidate's tree and the checkouts' `.semctx` from this checkout, so its tip must be the reviewed head. A new approved head is re-admitted before any subsequent arming write; an unbound one refuses `proof-blocked`. A head that moves only at the final epilogue, never admitted, refuses `head-moved` and disarms.
- **Missing or corrupt `C` objects** refuse with Git's own stderr (`candidate`/`unreadable`), never as absence.
- **Kit `verify` manifests** carry a request-authored `working tree of <short sha>[+dirty]` provenance, not assertledger's Git provenance: they bind nothing and refuse as `unbound`. Only `assertledger check` (git-regression) manifests admit.
- **Acquisition window.** The producer reads a private `--shared --no-checkout` clone detached at `C` in a fresh `mkdtemp` directory: its inputs are content-addressed objects; its status must be empty before and after, with no Semctx working state among ignored files. A modification-and-restore in the operator's checkout cannot reach it; a writer inside the private directory is outside the trust model (same user).
- **Fixture records.** CI has no Semctx, so tests read records the real producers emitted; `capture.ts` regenerates them, copying the tools into a temporary directory so no record names a home or a surviving path.
- **Local validation deleted** (equivalence shown): `proof-gate.ts` and its test (a predicate over caller-supplied verdicts, replaced by native records read at landing); the opening gate, forced VERIFIED close and `.semctx/working/` emptiness (feature §6.3); `/feature`'s verify/commit/push/receipt after `/fix` (`/fix` already runs lint and tests per cause and on push, commits, pushes and posts on the same head); `dev-review/__tests__/ui-proof.test.ts` (a wording pin; the behavior is exercised in `proof.integration.test.ts`).
- **Retained.** Independent CI and CCC triggers; `worktree-bootstrap.sh` `semctx index`; `feature-init`'s `semctx-working-empty` CI recommendation — it checks the same committed fact admission refuses, but also covers landings that never pass through `landPr`, so no equivalence. `feature-init` now lists "active semctx contracts" instead of "orphan": a change may land active or partial, and only Semctx closes one from VERIFIED.
- **Record boundary.** Records are native output plus invocation observations posted by the operator account, not cryptographic attestations. Multipart runs are read only whole. Admission governs arms `landPr` writes; another actor's `reviewed`/auto-merge is an override the server-side executors honour without reading these records. Independent CI remains in place.
- **Combined producer fixture.** assertledger 1.4.0 requires equal world path sets besides the selected test and ancestor ordering. Its combined fixture's buggy world is the PR's intermediate commit after opening/proving the Semctx contract and before the clamp fix; `main` is still the landing base. Only the reference/fixed world is admitted as the candidate. Both producers' real records are captured together.

## Review-fix evidence (2026-10-11, before re-review)

PR #776 remains the only delivery PR. Review [6110812277](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6110812277) owns the cause plans; RC-1–RC-12 are corrected, RC-13 remains non-blocking and is deferred to [#777](https://github.com/Roxabi/roxabi-plugins/issues/777), sibling under #720 and blocked by #768.

RC-10: `proof.test.ts` + `proof.integration.test.ts` = **167 passing tests**. Forty-one independent production-guard mutations each made their named regression fail; every guard was restored. Real-Git unborn HEAD, malformed JSON and real filesystem EACCES also fail with their corresponding guard removed. The EACCES scenario uses unchanged real Git responses and withdraws principal-directory search permission immediately after the declaration read; restoring permission is its admitted counterpart. It runs here; root processes skip that permission scenario because they bypass EACCES.


For the modified-only candidate, `capture.ts` also records the public native Semctx steps directly: its older contract is genuinely VERIFIED, yet the candidate adds no ticket-owned contract. This is an intentionally inadmissible native record, separate from `proof-acquire`'s refusal to produce it. The integration test supplies that complete record and still expects `missing`; adding the candidate's own contract is its admissible counterpart. It does not infer safety from an absent comment or from diagnostic wording.
RC-7 and RC-12 are normative documentation: **falsification skipped — NO TEST: prompt-logic-only**, never counted as pass. No source-text or wording test was added. RC-13 was not applied.

## Second review — bounded final fix round

Review [6112206661](https://github.com/Roxabi/roxabi-plugins/pull/776#issuecomment-6112206661)
returned Request changes for `3843c2ce`: five executable causes were planned
alongside two unplanned blockers. This is the final allowed fix, not a clean review.

- **RC-1:** real `landPr` CLI regressions mutate the PARTIAL body, ignored principal
  configuration, disagreeing root configuration, real file readability (EACCES),
  closing-ticket type and latest native record during awaits, independently before
  arming and after the label write in both modes. They observe precise refusal,
  no pre-arm write or confirmed clearing; two clearing-failure cases observe the
  actual remaining arm and its named error. The STALE response is a controlled
  mutation of a genuinely conserved native fixture, not a producer execution.
  Removing checkpoint re-admission made **26 named regressions fail**; restored,
  the admission/armed-gate/landing suites passed **1,150 tests**, including the
  unchanged configured candidate's merge-on-green counterpart with zero producers.
- **RC-2:** thirteen real-Git `landPr` cases cover retarget before pin/label,
  after pin/label, during re-pin/re-label preparation, freshly approved H2,
  same-name tip movement and an unreadable base tip. Each observes candidate
  refusal and cleared arms; pre-arm cases observe no new arm. Disabling the
  common base-coordinate guard made **all 13 fail** with `watching`; restored,
  the four landing/admission suites passed **1,204 tests** after the final writers. The captured base
  also owns required-CI discovery: replacing it with an unbound second peek
  made the additional cross-base CI regression fail (`watching` instead of
  `no-required-checks`). The obsolete exact-RPC-order assertion was removed,
  not re-pinned.
- **RC-3:** seventeen real-consumer scenarios exercise acquisition and both
  landing modes against newly committed Semctx/adapter obligations, a changed
  or malformed base policy, failed fetches, lagging selected API tips, mutable
  tracking refs and acquisition coordinate drift. Twelve initial cases failed
  before the correction. With the production freshness guard removed, five
  failed; restoring mutable-ref declaration/range reads made three fail;
  removing acquisition coordinate revalidation made its CLI drift case fail.
  All guards restored, the seventeen passed. No producer runs at admission.
  The obsolete invalid-policy test that pinned retention of an existing arm
  was deleted; malformed current policy now confirms clearing.
  Final writers: lint and typecheck passed; five admission/landing suites passed
  **1,309 tests**, including the migrated real EACCES race.
- **RC-4:** actual assertledger 1.4.0 replays of B and its duration-only A
  counterpart return respectively exit 0 / all validity flags true and exit 4 /
  `artifactDigestValid:false` with `decisionDigestValid:true`. Both CLI temporal
  regressions failed before the fix and again with replay redirected to the
  exporter. Corrected acquisition snapshots before the tool await.
  The actual native CLI smoke confirms invalid A cannot borrow valid B's
  replay: acquisition exits 1, admission reports missing detection, both arms
  clear. Valid B stays a detection while its exporter becomes invalid A;
  reacquisition reuses it and landing makes no producer call (two native calls
  total: version + replay). Snapshot mode 0400, parent 0700, exact captured
  bytes, snapshot cleanup and preservation of the changed exporter were observed.
  `capture.ts` regenerated the complete real-producer corpus and native replay
  counterparts successfully (Semctx 0.4.2, assertledger 1.4.0).
  Final writers: lint and typecheck passed; the five admission/landing suites
  passed **1,311 tests** against the regenerated native corpus.
- **RC-5:** native `created_at` and `updated_at` from every part of the selected
  complete PARTIAL run bound it to the approving review; no time is inferred.
  Semctx 0.4.2 actually produced the added two-part PARTIAL fixture. Sixteen
  consumer cases cover later publication, every-part revisions, missing/bad
  native dates, invalid calendar dates, same-second ambiguity, no approval
  time, an irrelevant older run, and chronology-independent VERIFIED reuse.
  The thirteen negative cases failed before the correction and again when the
  chronology call was removed. With it present all sixteen passed.
  The actual CLI smoke (real native record, simulated GitHub transport) observes
  late final part → refusal + confirmed clearing → new same-head approval →
  PARTIAL admission → first-part revision → refusal + confirmed clearing;
  zero producer calls throughout. Feature/reviewer/ADR recovery agrees.
  After the final writers, the complete repository suite passed **132 files /
  4,185 tests**; lint and typecheck passed with no lint diagnostics.
  Native GitHub calls also confirmed both publication fields on #776 and the
  frozen pre-merge `baseRefOid` on merged PRs #774/#773/#771. The continuous
  goal's transport now preserves that native base fact instead of manufacturing
  drift after merge; production base guards are unchanged.
  The Semctx MCP impact reader returned `CONFIG_NOT_FOUND` for this genuinely
  unconfigured repository: no index/config was created and no PASS is claimed.
  At review 2 the two uncited blockers were preserved in full on siblings
  **#779** (browser) and **#778** (truth), parent #720, blocked-by origin #768;
  still blocking then. Their authorized later disposition is below.
- **At that review, unresolved:** browser observation and NO TEST reason truth
  had no accepted replacement oracle; filing/unarmed was not resolution.
  The [explicit human amendment](https://github.com/Roxabi/roxabi-plugins/issues/768#issuecomment-6114046814)
  now accepts a proof-aware reviewer ceiling for those two truths only.
  #779/#778 are superseded obligations, not code-fixed/native-proved gaps.
  Admission still checks binding, enum, e2e, form and native chronology; the
  reviewer blocks unsupported claims. Approval and timestamps certify no gap.



## Observed preflight and safety state (historical, 2026-10-09)

- `git status --short --branch` initially showed only the #768 branch header; no user changes were moved/stashed.
- Registered #768 worktree and principal both started at `70d753bacff708145111c8d8bd6ffc3c807c26d8`; remote `refs/heads/main` returned that same SHA.
- Existing `resolveEntry` returned `action: build`, `ticket: 768`; this checks matching worktree/branch, **not** native prerequisite readiness. Feature §3.1 permits continuation in a matching worktree without another branch or move request. No historical `/move` transcript is certified.
- GitHub branch PR list returned `[]`; actual existing `resolveReviewPr` returned `null`. There is no selected OPEN PR gate to disarm, and no `disarmed: true` receipt is asserted.
- Installed Semctx CLI returned `0.4.2`; bundle SHA-256 was `ee7a4626a4b395757c5d989cfb0db60bdeb202d4354c7f922539741043a46ca8`, equal to the historical probe bundle. No repeat of the old probe and no production admission proof claimed.
- No plugin edit, install, cache change, commit/push, PR/review marker, arm/merge, release, cleanup or #720 epic execution was performed.

## Resume discriminator (historical, resolved 2026-10-11 by #737's closure)

Either deliver the real #737 prerequisite through its owner first, or obtain explicit arbitration defining the necessary #737 subset and its landing sequence while retaining any unresolved native dependency. Do not close #737 by proximity, delete its blocker edge to make #768 ready, or import its whole cross-consumer backlog silently. Re-read remote base, dependencies, source and selected PR at the next entry. The #768 implementation and production proof rows above remain pending.

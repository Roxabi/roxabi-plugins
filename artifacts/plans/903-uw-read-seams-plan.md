# #903 — UW glossary and single read seams

Manual Q79 delivery, based on `origin/main` at `9117549f838e624664d5217d9a99215214d907cc`. Normative sources: [#903](https://github.com/Roxabi/roxabi-plugins/issues/903), parent [#901](https://github.com/Roxabi/roxabi-plugins/issues/901), Q79/Q80. #902 is natively closed/completed; #903's native parent is #901 and its only observed blocker is #902. No open PR was observed at the preflight. Operator authorized manual merge after independent review, complete criterion verification and green CI, then pin/plugin maintenance; no other omp-build delivery is in flight.

## Acceptance mapping

| #903 criterion | Implementation | Evidence required |
|---|---|---|
| UW glossary, no active Ticket/Epic vocabulary | Update `plugins/omp-build/GLOSSARY.md`; preserve historical wire names and distinguish the action Instantané from the frozen dev-core copy | Content review against #901 vocabulary; independent review |
| One Spec reading/analysis module | Central `roxabi/uw-spec/` module owns delivery-body decoding and the existing separate scope, acceptance-list, priced-fence and draft analyses; migrate selection, plan, implementation, PR/range review and finalization | Existing unchanged semantic expectations, targeted consumer tests, observed smoke and static consumer inventory |
| One native graph reader | Central `adapters/github-native/` module owns actual queries and native response translations for issue metadata, relations, child/blocker reads, debt readbacks and peripheral state/date reads | Existing adapter, driver, debt and promotion behavior; native-read inventory |
| Real transport and both doubles retained; no new policy | Move existing implementations without changing argv, result/error variants, read timing, limits or interpretations; keep injected Gh and executable simulator | Existing tests, smoke using both transport seams, no changes to expected behavior |
| One review-reference loader | Reuse `roxabi/review-assets.ts` for references and class bytes; migrate PR/range inputs and secondary taxonomy/class readers | Existing semantic context/digest/prompt tests and smoke, exact reference bytes retained |
| Feature/review behavior unchanged | Preserve body bytes, digests, references, prompt fields, requests, errors and workflow policy | Full suite, build/lint/typecheck/quality/distribution/pin checks, independent manual Q79 review, PR CI |

## Interfaces and ownership

- Native graph module owns queries and native decoding. It exposes named existing operations/profiles, not a generic GraphQL wrapper, universal read, cache or newly complete graph. It keeps every current transport (asynchronous Gh, synchronous epic effects, debt ProcessRunner).
- Spec module owns interpretation of issue bodies as Spec. Its reader calls the native graph interface for transport/facts. Scope control and criterion extraction remain different functions with their existing divergent behavior until #897. No whitespace normalization or reference rewriting.
- Review reference loading converges in the existing loader module. Preserve bytes, errors and requested-file behavior; do not make a class-only read depend on unrelated reference files.
- Graph implementer owns native-reader files and graph consumers; Spec implementer owns Spec readers/parsers and their consumers. Spec owns shared `review-pr-inputs.ts` and `epic-range-inputs.ts` call-site edits for both Spec and reference interfaces. Reference implementer edits loader/config and supplies shared-callsite changes to Spec owner. Parent integrates `contracts.ts`, docs, version/catalogue and generated distribution.
- Before exported-symbol moves, use worktree LSP references; preserve the public `contracts.ts` names/signatures and update all internal consumers/tests' import paths without changing assertions.

## Execution and verification

1. Complete source map and interfaces; implement coherent slices in the dedicated worktree. No child publishes to GitHub or runs build/lint/tests/formatters mid-flight.
2. Integrate all slices; update README/root index and bump matching omp-build package/catalogue from 0.12.3 to 0.12.4. Do not change the frozen CHANGELOG or create a release/tag.
3. Build generated distribution and exercise current Spec, graph and reference paths with exact observed outputs. Run declared checks and existing tests after integration; record results without re-pinning changed expectations.
4. Independent manual Q79 review: adversarial plus relevant architecture/test specialists; correct findings and re-examine the final head. Review is not a fabricated native record or /feature qualification.
5. Push PR targeting main, observe green CI, manually merge-commit without bypass; update/read back tooling SHA and plugin installation. Block for OMP restart if needed before #897, preserving a consultable continuation.

## Explicit non-goals

No new grammar, ids, scope unification, pagination, incompleteness/blocker/cycle policy, relationship rewrite, inherited Spec projection, calculated termination, snapshots/manifests, migration/rollover, workflow/wire rename or #910 qualification. These are later slices. The new glossary names target concepts without claiming their later runtime implementation.

## Research references

Source maps: `agent://SpecSeams903` and `agent://GraphDesign903` (read-only findings). Compatibility risks: raw-body digest drift; profile-specific null/Result/throw variants; added reads/permissions; graph limits and error translation; class-only loader behavior; historical record names.

## Review-led compatibility corrections

The first manual Q79 review of `a21c47af2cab8e04f740ca9df60ec028e544c70f` found three blocking defects. No existing expectation was changed to accept them.

| Observation before correction | Causal correction | Observed proof after correction |
|---|---|---|
| Parent input reused the stricter PR date profile and threw `epic issue unreadable` for an absent date | Retain a separate native parent-input projection; absent/non-string dates become `null`, while PR review remains strict | Direct Spec-reader smoke passes missing/numeric/null/timestamp inputs; permanent behavioral regression |
| New Bun state subprocess loaded worktree `.env`: baseline kept open `#42`, candidate silently filtered it using another `GH_REPO` | Disable automatic env-file loading on the new subprocess only; preserve caller environment | Real collector smoke now keeps `#42` in both baseline and candidate; integration regression also checks explicit caller `GH_REPO` |
| Hosted admission still read the taxonomy independently | Obtain class bytes through the common loader, retaining the gate's own regex and duplicate/empty refusals | Hosted-taxonomy smoke preserves baseline classes, class-only loading, historical whitespace and both refusals |

Native association decoders are colocated with their single reader; the glossary/README explicitly distinguish the future Report contract from current historical reports. Record the complete declared check results, exact final head, independent re-examination and CI on [PR #924](https://github.com/Roxabi/roxabi-plugins/pull/924) before merge.

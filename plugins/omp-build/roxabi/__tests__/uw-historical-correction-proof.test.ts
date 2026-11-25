import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { PinnedFileRef, RecordInputRef } from '../../engine/action-input-schema.ts'
import { resolveAdmittedCorrectionCriterionSource } from '../../engine/correction-criterion-source.ts'
import { resolveHistoricalCorrectionBasis } from '../../engine/correction-historical-basis.ts'
import { correctionObservationAuthenticationDiagnostics } from '../../engine/correction-observation-authentication.ts'
import { recordGitPinBytes } from '../../engine/historical-git-pins.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { historicalCorrectionProof } from './uw-historical-correction-proof-fixture.ts'

function fixture(expand?: Parameters<typeof historicalCorrectionProof>[0]) {
  const proof = historicalCorrectionProof(expand)
  const collect = ({
    head = proof.head,
    histories = [proof.review, proof.issue, proof.contextHistory],
    mandate = proof.mandate,
    spec = proof.spec,
  }: {
    head?: string
    histories?: DecodedHistory[]
    mandate?: typeof proof.mandate
    spec?: typeof proof.spec
  } = {}) =>
    resolveAdmittedCorrectionCriterionSource(
      proof.result,
      histories,
      {
        head,
        planActionId: proof.planActionId,
        mandate: {
          scope: { repository: mandate.repository, target: mandate.target },
          kind: 'mandate',
          recordId: mandate.recordId,
        },
        ownSpec: spec.effective.own,
      },
      fixtureHostReviewClassCatalogues(),
    )
  function expectExpansionAuthority(admitted: boolean) {
    const histories = [proof.review, proof.issue, proof.contextHistory]
    const captured = proof.review.operations.find((operation) => operation.recordId === proof.source.recordId)
    expect(captured).toMatchObject({ status: 'complete', record: proof.source })
    const [evidence] = proof.evidence
    if (evidence === undefined) throw new Error('Expected native correction evidence')
    expect(
      resolveHistoricalCorrectionBasis({
        contribution: proof.source,
        histories,
        catalogues: fixtureHostReviewClassCatalogues(),
      }),
    ).toMatchObject({ ok: admitted })
    expect(collect()).toMatchObject(admitted ? { ok: true, value: { contribution: proof.source } } : { ok: false })
    const diagnostics = correctionObservationAuthenticationDiagnostics(evidence, histories, [], proof.source)
    if (admitted) expect(diagnostics).toEqual([])
    else
      expect(diagnostics).toContainEqual(
        expect.objectContaining({
          code: 'unconfirmed',
          message: `Evidence ${evidence.id} has no authenticated correction submission`,
        }),
      )
  }
  return { ...proof, collect, expectExpansionAuthority }
}

describe('historical correction criterion proof', () => {
  it('selects authenticated evidence and its lineage at the exact corrected head', () => {
    const { collect, result, source, correction, priorHead } = fixture()
    const selected = collect()
    expect(selected).toMatchObject({
      ok: true,
      value: {
        criteria: result.payload.criterionReceipt?.criteria,
        lineage: expect.arrayContaining([source, correction]),
      },
    })
    expect(collect({ head: priorHead })).toEqual({ ok: true, value: null })
  })

  it('refuses a visible fix result without its historical proof source or UW history', () => {
    const { collect, review, reviewWithoutSource, issue } = fixture()
    for (const histories of [[reviewWithoutSource, issue], [review]]) {
      expect(collect({ histories })).toMatchObject({ ok: false })
    }
  })

  it.each<[string, (ref: RecordInputRef) => RecordInputRef, boolean]>([
    ['observed', (ref) => ref, true],
    ['absent', (ref) => ({ ...ref, record: { ...ref.record, recordId: 'absent-expansion-record' } }), false],
    [
      'wrong scope',
      (ref) => ({ ...ref, record: { ...ref.record, scope: { ...ref.record.scope, target: 'acme/widgets#99' } } }),
      false,
    ],
    ['wrong selector', (ref) => ({ ...ref, selector: '/payload/unobserved-field' }), false],
    ['wrong digest', (ref) => ({ ...ref, digest: 'f'.repeat(64) }), false],
  ])('requires unrelated expanded record context to bind: %s', (_case, expand, admitted) => {
    fixture((ref) => [expand(ref)]).expectExpansionAuthority(admitted)
  })

  it.each([
    { variant: 'observed', observed: true, wrongDigest: false },
    { variant: 'missing', observed: false, wrongDigest: false },
    { variant: 'wrong digest', observed: true, wrongDigest: true },
  ])('requires unrelated expanded Git context to match observed bytes: $variant', ({ observed, wrongDigest }) => {
    const bytes = new TextEncoder().encode('native correction context unrelated to the submitted criterion')
    const pin: PinnedFileRef = {
      source: 'git-file',
      repository: 'acme/widgets',
      commit: 'c'.repeat(40),
      path: 'docs/expanded-correction-context.md',
      digest: createHash('sha256').update(bytes).digest('hex'),
    }
    const f = fixture(() => [wrongDigest ? { ...pin, digest: 'f'.repeat(64) } : pin])
    if (observed) recordGitPinBytes(f.review, [pin], bytes)
    f.expectExpansionAuthority(observed && !wrongDigest)
  })

  it('refuses the same Spec version accepted by a different source', () => {
    const { collect, spec } = fixture()
    const { own } = spec.effective
    const wrongOwn = { ...own, sourceAccepted: { ...own.sourceAccepted, recordId: 'wrong-acceptance-source' } }
    const wrongSpec: typeof spec = {
      ...spec,
      effective: { ...spec.effective, own: wrongOwn, versionVector: [wrongOwn] },
    }
    expect(collect({ spec: wrongSpec })).toMatchObject({ ok: false })
  })

  it('refuses the same mandate identity in a different scope', () => {
    const { collect, mandate } = fixture()
    expect(collect({ mandate: { ...mandate, target: 'acme/widgets#99' } })).toMatchObject({ ok: false })
  })
})

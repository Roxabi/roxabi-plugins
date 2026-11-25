import { describe, expect, it } from 'vitest'
import { resolveAdmittedCorrectionCriterionSource } from '../../engine/correction-criterion-source.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { historicalCorrectionProof } from './uw-historical-correction-proof-fixture.ts'

function fixture() {
  const proof = historicalCorrectionProof()
  const collect = ({
    head = proof.head,
    histories = [proof.review, proof.issue],
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
  return { ...proof, collect }
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

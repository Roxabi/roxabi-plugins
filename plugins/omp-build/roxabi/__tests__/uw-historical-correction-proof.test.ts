import { describe, expect, it } from 'vitest'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import type { DeliveryDataRef } from '../uw-action-contract.ts'
import { authenticate } from '../uw-action-observe.ts'
import { gatherCorrectionRefs } from '../uw-action-selection-refs.ts'
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
  } = {}) => {
    const gathered = { refs: [] as DeliveryDataRef[], selected: [] as CanonicalRecord[] }
    const result = gatherCorrectionRefs(
      { ...proof.request, code: { ...proof.request.code, head, referenceCommit: head } },
      mandate,
      histories,
      fixtureHostReviewClassCatalogues(),
      (record) => authenticate(record, histories),
      proof.planActionId,
      spec,
      gathered,
    )
    return { result, ...gathered }
  }
  return { ...proof, collect }
}

describe('historical correction criterion proof', () => {
  it('selects authenticated evidence and its lineage at the exact corrected head', () => {
    const { collect, result, source, correction, priorHead } = fixture()
    const selected = collect()
    expect(selected.result).toEqual({ ok: true, value: true })
    expect(selected.selected).toEqual([result])
    expect(selected.refs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'implementation',
          record: expect.objectContaining({ kind: 'fix-result', recordId: result.recordId }),
          selector: '/payload/criterionReceipt/criteria/0',
        }),
        expect.objectContaining({
          role: 'criterion-evidence',
          record: expect.objectContaining({ kind: 'fix-result', recordId: result.recordId }),
          selector: '/payload/criterionReceipt/criteria/0/evidence/0',
        }),
        ...[source, correction].map((record) =>
          expect.objectContaining({
            role: 'correction-lineage',
            record: expect.objectContaining({ kind: record.kind, recordId: record.recordId }),
            selector: '/payload',
          }),
        ),
      ]),
    )
    expect(collect({ head: priorHead })).toEqual({ result: { ok: true, value: true }, selected: [], refs: [] })
  })

  it('refuses a visible fix result without its historical proof source or UW history', () => {
    const { collect, review, reviewWithoutSource, issue } = fixture()
    for (const histories of [[reviewWithoutSource, issue], [review]]) {
      expect(collect({ histories })).toMatchObject({ result: { ok: false }, selected: [], refs: [] })
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
    expect(collect({ spec: wrongSpec })).toMatchObject({ result: { ok: false }, selected: [], refs: [] })
  })

  it('refuses the same mandate identity in a different scope', () => {
    const { collect, mandate } = fixture()
    expect(collect({ mandate: { ...mandate, target: 'acme/widgets#99' } })).toMatchObject({
      result: { ok: false },
      selected: [],
      refs: [],
    })
  })
})

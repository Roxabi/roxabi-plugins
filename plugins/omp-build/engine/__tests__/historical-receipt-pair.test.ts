import { expect, test } from 'vitest'
import { acceptedActionInputs, observeFixtureCatalogue } from '../../testing/action-input-fixtures.ts'
import { canonicalValueDigest } from '../action-input.ts'
import { authenticateHistoricalActionInputs } from '../historical-action-inputs.ts'
import { authenticateHistoricalReceiptStart } from '../historical-receipt-pair.ts'
import { buildRecord } from '../record-construction.ts'
import type { ActionReceiptPayload } from '../workflow-receipt-schema.ts'
import { fixtures } from './workflow-receipt-schema-parity-fixtures.ts'
import { shippedFeatureMandate } from './workflow-spec-assessment-support.ts'
import { history, must, SCOPE } from './workflow-test-support.ts'

type Start = Extract<ActionReceiptPayload, { phase: 'start' }>
type Result = Extract<ActionReceiptPayload, { phase: 'result' }>

function receipt(recordId: string, payload: ActionReceiptPayload) {
  const record = must(
    buildRecord({
      version: 1,
      ...SCOPE,
      recordId,
      runId: 'receipt-pair-run',
      operationId: `receipt-pair-${recordId}`,
      kind: 'action-receipt',
      payload,
    }),
  )
  if (record.kind !== 'action-receipt') throw new Error('Expected a native action receipt')
  return record
}

function variant(payload: ActionReceiptPayload) {
  return payload.action === 'frame' && payload.mandate.kind === 'absent' ? 'frame before mandate' : payload.action
}

const historicalPayloads = fixtures().payloads
const results = historicalPayloads.filter((payload): payload is Result => payload.phase === 'result')

test.each(results.map((result) => ({ name: variant(result), result })))(
  '$name requires its exact native START',
  ({ result }) => {
    const startPayload = historicalPayloads.find(
      (payload): payload is Start => payload.phase === 'start' && variant(payload) === variant(result),
    )
    if (startPayload === undefined) throw new Error(`Missing ${variant(result)} START fixture`)
    const start = receipt('native-start', startPayload)
    const end = receipt('native-result', {
      ...result,
      start: { scope: SCOPE, kind: 'action-receipt', recordId: start.recordId },
    })
    const other = receipt('other-matching-start', startPayload)
    const check = (records: (typeof start)[]) => {
      const observed = history(records)
      return authenticateHistoricalReceiptStart(observed, end, [observed], { inputs: 'structural' })
    }
    expect(check([start, end])).toMatchObject({ ok: true, value: { start: { recordId: start.recordId } } })
    expect(check([end])).toMatchObject({ ok: false, stage: 'start' })
    expect(check([other, end])).toMatchObject({ ok: false, stage: 'start' })
    expect(check([start, other, end])).toMatchObject({ ok: false, stage: 'identity' })
  },
)

test('historical correction stage evidence cannot use a CI attribution RESULT without its exact START', () => {
  const startPayload = historicalPayloads.find((item) => item.action === 'attribute-ci' && item.phase === 'start')
  const resultPayload = results.find((item) => item.action === 'attribute-ci')
  if (startPayload === undefined || resultPayload === undefined) throw new Error('Missing CI attribution fixture')
  const start = receipt('ci-start', startPayload)
  const attribution = receipt('ci-result', {
    ...resultPayload,
    start: { scope: SCOPE, kind: 'action-receipt', recordId: start.recordId },
  })
  const input = {
    ...acceptedActionInputs(shippedFeatureMandate(), 'correction'),
    stageSources: [
      {
        source: 'record' as const,
        record: { scope: SCOPE, kind: 'action-receipt' as const, recordId: attribution.recordId },
        selector: '/payload',
        digest: canonicalValueDigest(attribution.payload),
      },
    ],
  }
  expect(authenticateHistoricalActionInputs(input, [observeFixtureCatalogue(history([start, attribution]))]).ok).toBe(
    true,
  )
  expect(authenticateHistoricalActionInputs(input, [observeFixtureCatalogue(history([attribution]))])).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'attribute-ci-start-unpaired' })]),
  })
})

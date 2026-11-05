import { describe, expect, it } from 'vitest'
import { standaloneReviewInputs } from '../../testing/action-input-fixtures.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { actionInputDigest, validateActionInputs } from '../action-input.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { actionReceiptPayloadSchema } from '../workflow-receipt-schema.ts'
import { fixtures } from './workflow-receipt-schema-parity-fixtures.ts'
import { SCOPE } from './workflow-test-support.ts'

describe('action receipt schema variant parity', () => {
  it('accepts all sixteen real action/phase modes without changing their parsed JSON or record meaning', () => {
    const { payloads } = fixtures()
    expect(payloads).toHaveLength(16)
    const variants = new Set(
      payloads.map(
        (payload) =>
          `${payload.action}:${payload.phase}:${payload.action === 'frame' && payload.mandate.kind === 'absent' ? 'pre' : 'mandated'}`,
      ),
    )
    expect(variants.size).toBe(16)
    for (const [index, payload] of payloads.entries()) {
      const parsed = actionReceiptPayloadSchema.safeParse(payload)
      expect(parsed.success, `${payload.action}:${payload.phase}`).toBe(true)
      if (!parsed.success) throw new Error('receipt fixture failed schema validation')
      expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(JSON.parse(JSON.stringify(payload)))
      const record = buildRecord({
        version: 1,
        ...SCOPE,
        recordId: `schema-${index}`,
        runId: 'schema-run',
        operationId: `schema-operation-${index}`,
        kind: 'action-receipt',
        payload: parsed.data,
      })
      expect(record.ok, `${payload.action}:${payload.phase}`).toBe(true)
      if (!record.ok) throw new Error(JSON.stringify(record.diagnostics))
      expect(parseRecord(JSON.parse(JSON.stringify(record.value)))).toEqual(record)
    }
  })

  it('rejects invalid tags, strict keys, and mismatched frame mandate modes', () => {
    const { payloads, frame, preFrame } = fixtures()
    for (const payload of payloads) {
      for (const invalid of [
        { ...payload, action: 'unknown-action' },
        { ...payload, action: undefined },
        { ...payload, phase: 'unknown-phase' },
        { ...payload, phase: undefined },
        { ...payload, phase: payload.phase === 'start' ? 'result' : 'start' },
        { ...payload, unexpected: true },
      ])
        expect(actionReceiptPayloadSchema.safeParse(invalid).success).toBe(false)
    }
    expect(actionReceiptPayloadSchema.safeParse({ ...frame, mandate: preFrame.mandate }).success).toBe(false)
    expect(actionReceiptPayloadSchema.safeParse({ ...preFrame, mandate: frame.mandate }).success).toBe(false)
    expect(actionReceiptPayloadSchema.safeParse({ ...frame, exactInputs: preFrame.exactInputs }).success).toBe(false)
    expect(actionReceiptPayloadSchema.safeParse({ ...preFrame, exactInputs: frame.exactInputs }).success).toBe(false)
  })

  it('retains fingerprint, duplicate reference, malformed nested and raw full-validator rejection', () => {
    const { frame } = fixtures()
    const inputs = frame.inputs
    const duplicated = {
      ...inputs.manifest,
      acceptedSources: [...inputs.manifest.acceptedSources, ...inputs.manifest.acceptedSources],
    }
    const duplicateInputs = { ...inputs, manifest: duplicated, fingerprint: actionInputDigest(duplicated) }
    const malformed = {
      ...inputs,
      manifest: { ...inputs.manifest, plugin: { ...inputs.manifest.plugin, version: '' } },
    }
    expect(validateActionInputs(duplicateInputs).ok).toBe(false)
    expect(actionReceiptPayloadSchema.safeParse({ ...frame, inputs: duplicateInputs }).success).toBe(false)
    expect(
      actionReceiptPayloadSchema.safeParse({ ...frame, inputs: { ...inputs, fingerprint: 'f'.repeat(64) } }).success,
    ).toBe(false)
    const reviewInputs = standaloneReviewInputs()
    const graph = reviewGraph({ inputs: reviewInputs })
    expect(parseRecord(graph.root).ok).toBe(true)
    const badReviewInputs = {
      ...reviewInputs,
      manifest: { ...reviewInputs.manifest, plugin: { ...reviewInputs.manifest.plugin, version: '' } },
    }
    expect(parseRecord({ ...graph.root, payload: { ...graph.root.payload, inputSnapshot: badReviewInputs } }).ok).toBe(
      false,
    )
    expect(actionReceiptPayloadSchema.safeParse({ ...frame, inputs: malformed }).success).toBe(false)
    expect(validateActionInputs(malformed).ok).toBe(false)
  })

  it('retains normalization digest, slot, contribution and assessment operand refinements', () => {
    const { normalize, planReview, planResult, assessment } = fixtures()
    expect(
      actionReceiptPayloadSchema.safeParse({
        ...normalize,
        exactInputs: { ...normalize.exactInputs, bodySha256: 'f'.repeat(64) },
      }).success,
    ).toBe(false)
    if (
      planReview.kind !== 'action-receipt' ||
      planReview.payload.action !== 'plan-review' ||
      planReview.payload.phase !== 'start'
    )
      throw new Error('expected plan review start')
    if (
      planResult.kind !== 'action-receipt' ||
      planResult.payload.action !== 'plan-review' ||
      planResult.payload.phase !== 'result'
    )
      throw new Error('expected plan review result')
    const slots = planReview.payload.slots
    expect(actionReceiptPayloadSchema.safeParse({ ...planReview.payload, slots: [slots[0], slots[0]] }).success).toBe(
      false,
    )
    const contribution = planResult.payload.contributions[0]
    if (!contribution) throw new Error('expected contribution')
    expect(
      actionReceiptPayloadSchema.safeParse({
        ...planResult.payload,
        contributions: [{ ...contribution, host: { ...contribution.host, slotId: 'outside' } }],
      }).success,
    ).toBe(false)
    if (assessment.start.kind !== 'action-receipt' || assessment.start.payload.action !== 'assess-spec')
      throw new Error('expected assessment')
    const exact = assessment.start.payload.exactInputs
    expect(
      actionReceiptPayloadSchema.safeParse({
        ...assessment.start.payload,
        exactInputs: { ...exact, mechanical: { ...exact.mechanical, tierChanged: !exact.mechanical.tierChanged } },
      }).success,
    ).toBe(false)
  })

  it('preserves incompatible-format precedence over malformed receipt content', () => {
    const { assessment } = fixtures()
    const record = assessment.start
    if (record.kind !== 'action-receipt') throw new Error('expected assessment receipt')
    const incompatible = parseRecord({ ...record, payload: { ...record.payload, format: 'old', phase: 'invalid' } })
    expect(incompatible.ok).toBe(false)
    if (incompatible.ok) throw new Error('old format unexpectedly accepted')
    expect(incompatible.diagnostics[0]?.code).toBe('incompatible-format')
    const malformed = parseRecord({ ...record, payload: { ...record.payload, phase: 'invalid' } })
    expect(malformed.ok).toBe(false)
    if (malformed.ok) throw new Error('malformed receipt unexpectedly accepted')
    expect(malformed.diagnostics[0]?.code).toBe('malformed')
  })
})

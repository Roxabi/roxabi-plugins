import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { actionInputDigest, canonicalValueDigest } from '../engine/action-input.ts'
import { recordInputRefSchema } from '../engine/action-input-schema.ts'
import { parseRecord } from '../engine/record-construction.ts'
import { acceptedActionInputs } from './action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'

const legacyInventory = z.looseObject({
  kind: z.literal('review-attempt'),
  payload: z.looseObject({
    candidateGitSHA: z.string(),
    slots: z
      .array(
        z.looseObject({
          action: z.object({
            actionId: z.string(),
            inputs: z.object({
              manifest: z.object({
                code: z.object({
                  repository: z.string(),
                  base: z.string(),
                  head: z.string(),
                  referenceCommit: z.string(),
                }),
              }),
              stageSources: z.array(recordInputRefSchema),
            }),
          }),
        }),
      )
      .min(1),
  }),
})

/** Rebuild captured action inputs from current canonical mandate and binding; retain the original native submissions. */
export function nativeCorrectionRecords() {
  const raw: unknown = JSON.parse(
    readFileSync(new URL('../engine/__tests__/fixtures/native-correction-records.json', import.meta.url), 'utf8'),
  )
  if (!Array.isArray(raw)) throw new Error('Expected native correction records')
  const records = raw.map((value) => {
    if (value !== null && typeof value === 'object' && 'kind' in value && value.kind === 'review-attempt') return null
    const parsed = parseRecord(value)
    if (!parsed.ok) throw new Error(`Invalid native correction record: ${JSON.stringify(parsed.diagnostics)}`)
    return parsed.value
  })
  const binding = records.find((record) => record?.kind === 'workflow-binding')
  if (binding?.kind !== 'workflow-binding' || binding.payload.mandate.kind !== 'mandate')
    throw new Error('Expected native correction binding')
  const mandate = roxabiWorkflowFixtures().fixOnlyMandate(binding.payload.mandate.scope)
  if (mandate.recordId !== binding.payload.mandate.recordId) throw new Error('Correction binding names another mandate')
  const base = acceptedActionInputs(mandate, 'correction')
  const request = records.find((record) => record?.kind === 'fix-request')
  if (
    request?.kind !== 'fix-request' ||
    canonicalValueDigest(request.payload.originalSpec) !==
      canonicalValueDigest(base.manifest.spec.kind === 'accepted' ? base.manifest.spec.effective.own : null)
  )
    throw new Error('Correction request names another accepted Spec')
  const pullRequest = { repository: binding.repository, target: binding.target }
  const subject = {
    kind: 'uw' as const,
    uw: binding.payload.mandate.scope,
    pullRequest,
    binding: {
      source: 'record' as const,
      record: { scope: pullRequest, kind: 'workflow-binding' as const, recordId: binding.recordId },
      selector: '/payload',
      digest: canonicalValueDigest(binding.payload),
    },
  }
  return raw.map((value, index) => {
    const existing = records[index]
    if (existing) return existing
    const inventory = legacyInventory.parse(value)
    const slots = inventory.payload.slots.map((slot) => {
      const manifest = { ...base.manifest, subject, code: slot.action.inputs.manifest.code }
      const stageSources = slot.action.inputs.stageSources.map((source) => {
        if (source.source !== 'record' || source.selector !== '/payload')
          throw new Error('Unexpected correction stage source')
        const record = records.find(
          (candidate) =>
            candidate?.recordId === source.record.recordId &&
            candidate.kind === source.record.kind &&
            candidate.repository === source.record.scope.repository &&
            candidate.target === source.record.scope.target,
        )
        if (!record || canonicalValueDigest(record.payload) !== source.digest)
          throw new Error('Correction stage source is not authenticated')
        return { ...source, digest: canonicalValueDigest(record.payload) }
      })
      const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest), stageSources }
      return { ...slot, action: { actionId: slot.action.actionId, inputs } }
    })
    const action = slots[0]?.action
    if (!action || slots.some((slot) => slot.action.inputs.fingerprint !== action.inputs.fingerprint))
      throw new Error('Correction inventory must have one exact captured manifest')
    const parsed = parseRecord({
      ...inventory,
      payload: {
        ...inventory.payload,
        slots,
        input: action.inputs.fingerprint,
        actionInputDigest: action.inputs.fingerprint,
      },
    })
    if (!parsed.ok) throw new Error(`Invalid rebuilt correction inventory: ${JSON.stringify(parsed.diagnostics)}`)
    return parsed.value
  })
}

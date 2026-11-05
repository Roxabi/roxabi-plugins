import type { ActionInputs } from '../action-input-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import type { Json } from '../record-values.ts'

type RawAttempts = Extract<CanonicalRecord, { kind: 'contribution' }>['payload']['rawAttempts']

export function captureSamePrSubmission(attempts: RawAttempts, data: Json): RawAttempts {
  if (attempts.length !== 1) throw new Error('expected one captured fixture submission')
  return attempts.map((attempt) => {
    const raw = attempt.raw
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('expected native structured submission')
    const output = raw.structuredOutput
    if (output === null || typeof output !== 'object' || Array.isArray(output))
      throw new Error('expected native structured output')
    return { ...attempt, data, raw: { ...raw, structuredOutput: { ...output, data } } }
  })
}

export function samePrReviewInventories(
  records: CanonicalRecord[],
  review: Extract<CanonicalRecord, { kind: 'review' }>,
) {
  const inventories = records.filter(
    (record) => record.kind === 'review-attempt' && review.payload.inventoryIds.includes(record.recordId),
  )
  const root = inventories.find((record) => record.kind === 'review-attempt' && record.payload.stage === 'initial')
  const synthesis = inventories.find(
    (record) => record.kind === 'review-attempt' && record.payload.stage === 'synthesis',
  )
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    synthesis?.kind !== 'review-attempt' ||
    synthesis.payload.stage !== 'synthesis'
  )
    throw new Error('expected initial and synthesis review inventories')
  return { root, synthesis }
}

export function replaceSamePrSourceContributions(
  source: CanonicalRecord[],
  actions: Map<string, { actionId: string; inputs: ActionInputs }>,
  specId: string,
  specOutput: Json,
  replace: (record: unknown) => void,
): void {
  for (const record of source) {
    if (record.kind !== 'contribution') continue
    const action = record.payload.host.slotId === null ? undefined : actions.get(record.payload.host.slotId)
    if (action === undefined) throw new Error('source contribution lacks an allocated action')
    replace({
      ...record,
      payload: {
        ...record.payload,
        host: {
          ...record.payload.host,
          action,
          ...(record.recordId === specId ? { role: 'R-review-spec' } : {}),
        },
        ...(record.recordId === specId
          ? { structured: specOutput, rawAttempts: captureSamePrSubmission(record.payload.rawAttempts, specOutput) }
          : {}),
      },
    })
  }
}

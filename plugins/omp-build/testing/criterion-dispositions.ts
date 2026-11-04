import type { ActionInputs } from '../engine/action-input-schema.ts'
import { assessCauseDispositions } from '../engine/cause-assessment.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { buildRecord } from '../engine/record-construction.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'

/** Assess the actual authenticated decision; do not synthesize empty or preselected dispositions. */
export function criterionDispositionRecords(
  inputs: ActionInputs,
  decision: Extract<CanonicalRecord, { kind: 'decision' }>,
  histories: readonly DecodedHistory[],
) {
  if (inputs.manifest.spec.kind !== 'accepted') throw new Error('Expected accepted review origin')
  const original = inputs.manifest.spec.effective.own.uw
  const assessment = assessCauseDispositions({
    context: { original, effective: inputs.manifest.spec.effective },
    source: { kind: 'decision', decision },
    histories,
    adjudications: [],
  })
  if (!assessment.ok)
    throw new Error(
      `Cannot assess fixture dispositions: ${assessment.diagnostics.map(({ code, message }) => `${code}: ${message}`).join(', ')}`,
    )
  const dispositions = assessment.value.outcomes.map((payload, index) => {
    const id = `${decision.recordId}-disposition-${index}`
    const result = buildRecord({
      version: 1,
      recordId: id,
      operationId: `op-${id}`,
      runId: decision.runId,
      repository: original.repository,
      target: original.target,
      kind: 'cause-disposition',
      payload,
    })
    if (!result.ok || result.value.kind !== 'cause-disposition')
      throw new Error(`Cannot build fixture disposition ${id}`)
    return result.value
  })
  return { original, dispositions }
}

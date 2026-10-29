import type { CanonicalRecord } from '../../../../engine/record-schema.ts'

export function bindImplementationIdentity(record: CanonicalRecord, number: number, planActionId: string) {
  if (record.kind !== 'action-receipt' || record.payload.action !== 'implement')
    throw new Error('expected implementation fixture receipt')
  const implementActionId = `act-implement-${number}`
  const phase = record.payload.phase
  const payload = {
    ...record.payload,
    actionId: implementActionId,
    exactInputs: { ...record.payload.exactInputs, planActionId },
  }
  if (phase === 'start') {
    return { ...record, recordId: `${implementActionId}-start`, operationId: `op-${implementActionId}-start`, payload }
  }
  if (!record.payload.structured || !('criteria' in record.payload.structured))
    throw new Error('expected implementation criteria')
  const originalStart = record.payload.start.recordId
  return {
    ...record,
    recordId: `${implementActionId}-result`,
    operationId: `op-${implementActionId}-result`,
    inputs: record.inputs.map((input) => (input === originalStart ? `${implementActionId}-start` : input)),
    payload: {
      ...payload,
      start: { ...record.payload.start, recordId: `${implementActionId}-start` },
      structured: {
        ...record.payload.structured,
        criteria: record.payload.structured.criteria.map((criterion) =>
          criterion.verification !== 'evidence'
            ? criterion
            : {
                ...criterion,
                evidence: criterion.evidence.map((evidence) => {
                  if (!('provenance' in evidence) || evidence.provenance.kind !== 'native')
                    throw new Error('expected native implementation evidence')
                  return { ...evidence, provenance: { ...evidence.provenance, actionId: implementActionId } }
                }),
              },
        ),
      },
    },
  }
}

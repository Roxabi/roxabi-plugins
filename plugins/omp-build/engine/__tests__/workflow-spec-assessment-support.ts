import { buildRecord } from '../record-construction.ts'
import { specDigest } from '../record-digests.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { must, SCOPE } from './workflow-test-support.ts'

export function assessFixture(
  mandated: CanonicalRecord,
  id: string,
  acceptedBody: string,
  currentBody: string,
  classification: 'editorial' | 'material' | 'unknown' | null,
  native: {
    completion: 'completed' | 'error' | 'cancelled' | 'incomplete'
    strict: 'valid' | 'invalid' | 'absent'
  } = {
    completion: 'completed',
    strict: 'valid',
  },
  mandateId = mandated.recordId,
) {
  const acceptedDigest = specDigest(acceptedBody)
  const currentDigest = specDigest(currentBody)
  const exactInputs = { acceptedDigest, currentDigest, acceptedBody, currentBody }
  const mandateRef = { scope: SCOPE, recordId: mandateId, kind: 'mandate' as const }
  const start = must(
    buildRecord({
      version: 1,
      repository: SCOPE.repository,
      target: SCOPE.target,
      recordId: `${id}-start`,
      runId: 'run-1',
      operationId: `op-${id}-start`,
      kind: 'action-receipt',
      payload: { phase: 'start', action: 'assess-spec', actionId: `act-${id}`, mandate: mandateRef, exactInputs },
    }),
  )
  const result = must(
    buildRecord({
      version: 1,
      repository: SCOPE.repository,
      target: SCOPE.target,
      recordId: id,
      runId: 'run-1',
      operationId: `op-${id}`,
      kind: 'action-receipt',
      payload: {
        phase: 'result',
        action: 'assess-spec',
        actionId: `act-${id}`,
        mandate: mandateRef,
        start: { scope: SCOPE, recordId: start.recordId, kind: 'action-receipt' },
        exactInputs,
        native: { ...native, raw: null },
        structured: classification === null ? null : { classification },
        admission: null,
        diagnostics: [],
      },
    }),
  )
  return { start, result, currentDigest }
}

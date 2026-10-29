import { CREDENTIAL_DISCLOSURE, CREDENTIAL_MODE, retainActionRecordSync } from '../action-communication.ts'
import type { NativeBatch, NativeExecutionObservation } from './contracts'

export type OwnedResultReplacement = {
  content: [{ type: 'text'; text: string }]
  details: { summary: string; detailRef: string; credentialMode: typeof CREDENTIAL_MODE; childIds: string[] }
  isError: boolean
}

export function unusableOwnedReplacement(reason: string): OwnedResultReplacement {
  const summary = `native batch result unusable: ${reason}`
  return {
    content: [
      {
        type: 'text',
        text: `${summary}\ndetail: retention-unavailable\n${CREDENTIAL_DISCLOSURE}\nnext: restore artifact storage and prepare a new action`,
      },
    ],
    details: { summary, detailRef: 'retention-unavailable', credentialMode: CREDENTIAL_MODE, childIds: [] },
    isError: true,
  }
}

export function retainNativeObservation(
  observation: NativeExecutionObservation,
  batch: NativeBatch,
  retain: (value: unknown) => string,
): OwnedResultReplacement {
  let detailRef: string
  try {
    detailRef = retain(observation)
  } catch {
    return unusableOwnedReplacement('retention-failed')
  }
  if (!detailRef.startsWith('local://')) return unusableOwnedReplacement('retention-failed')
  const summary = `native batch ${batch.operationId} retained`
  const childIds = observation.results.flatMap((result) =>
    result !== null && typeof result === 'object' && 'id' in result && typeof result.id === 'string' ? [result.id] : [],
  )
  return {
    content: [{ type: 'text', text: `${summary}\ndetail: ${detailRef}\n${CREDENTIAL_DISCLOSURE}` }],
    details: { summary, detailRef, credentialMode: CREDENTIAL_MODE, childIds },
    isError: observation.errors.length > 0,
  }
}

export function retainOwnedResult(ctx: Parameters<typeof retainActionRecordSync>[0], value: unknown): string {
  return retainActionRecordSync(ctx, 'native-result', value)
}

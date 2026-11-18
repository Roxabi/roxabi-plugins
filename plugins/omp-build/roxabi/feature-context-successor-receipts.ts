import {
  authenticateWorkflowReceiptPair,
  implementationReceiptEligible,
  integrationReceiptEligible,
  recordsOf,
} from '../dist/contracts.js'
import { sameRef } from '../engine/record-diagnostics.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'

export function successorReceiptResults(
  issue: FeatureAuthority['history'],
  mandate: MandateRecord,
  ref: ScopedRecordRef,
) {
  return recordsOf(issue).filter(
    (record) =>
      record.kind === 'action-receipt' &&
      record.payload.phase === 'result' &&
      record.payload.mandate.kind !== 'absent' &&
      sameRef(record.payload.mandate, ref) &&
      (mandate.payload.branch === null
        ? record.payload.action === 'integrate' && integrationReceiptEligible(record)
        : record.payload.action === 'implement' && implementationReceiptEligible(record)),
  )
}

export function admittedImplementationReceipt(
  issue: FeatureAuthority['history'],
  result: ReturnType<typeof successorReceiptResults>[number] | undefined,
) {
  if (
    result?.kind !== 'action-receipt' ||
    result.payload.action !== 'implement' ||
    result.payload.phase !== 'result' ||
    !implementationReceiptEligible(result) ||
    !authenticateWorkflowReceiptPair(issue, result).ok ||
    result.payload.admission?.published !== true ||
    result.payload.admission.remoteTip === null
  )
    return null
  return { result, tip: result.payload.admission.remoteTip }
}

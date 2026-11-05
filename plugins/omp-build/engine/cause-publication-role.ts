import type { CanonicalRecord } from './record-schema.ts'

/** Retained-report publication is selected by the record itself, never by caller policy. */
export function isRetainedReportPublication(record: CanonicalRecord): boolean {
  return (
    record.kind === 'report-promotion' ||
    (record.kind === 'cause-operation' &&
      record.payload.proposal.operation === 'create' &&
      record.payload.proposal.creation.kind === 'report-promotion')
  )
}

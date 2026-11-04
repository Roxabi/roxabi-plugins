import type { CauseDispositionPayload } from './cause-disposition-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'

export type Ref<K extends CanonicalRecord['kind']> = ExternalRecordRef & { kind: K }
export type DispositionSource =
  | { kind: 'decision'; decision: Extract<CanonicalRecord, { kind: 'decision' }> }
  | {
      kind: 'retained-output'
      contributions: Extract<CanonicalRecord, { kind: 'contribution' }>[]
      diagnostics: Diagnostic[]
    }
export type CauseAssessment = {
  outcomes: CauseDispositionPayload[]
  executableCauseIds: string[]
  diagnostics: Diagnostic[]
}
export type ReportListing = {
  root: Scope
  reports: {
    ref: Ref<'cause-disposition'>
    record: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
    promotion: Ref<'report-promotion'> | null
  }[]
}

export { resolveCauseActionInputs, validateCauseAdjudication } from './cause-adjudication.ts'
export { assessCauseDispositions } from './cause-assessment.ts'
export { effectiveRejectedFindingIds } from './cause-effective-findings.ts'
export { readCauseDispositionHeads } from './cause-heads.ts'
export { causeHistoryReferences } from './cause-history-references.ts'
export { causeDispositionLineage } from './cause-lineage.ts'
export { validateCauseDispositionRecords } from './cause-record-validation.ts'
export { readCauseReports, resolveCauseSisterReceipt } from './cause-reports.ts'

import { validateCauseEffects } from './cause-effect-validation.ts'
import { validateCauseChain, validateCauseCycles } from './cause-record-chain-validation.ts'
import { validateCauseOperations } from './cause-record-operation-validation.ts'
import { validateCauseSubject } from './cause-record-subject-validation.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { resolveOwnSpecEffective, sameOwnSpecRef } from './spec-effective.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { recordsOf, workflowOperationProblem } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>

function validateHistories(histories: readonly DecodedHistory[], diagnostics: Diagnostic[]): void {
  for (const history of histories) {
    const duplicates = histories.filter((candidate) => equalScope(candidate.source.scope, history.source.scope))
    if (duplicates.length !== 1 || workflowOperationProblem(history) !== null)
      diagnostics.push(
        diagnostic(
          'cause-history-unconfirmed',
          `History for ${history.source.scope.target} is incomplete, ambiguous or unauthenticated`,
        ),
      )
  }
}

function validateOrigin(record: Disposition, histories: readonly DecodedHistory[], diagnostics: Diagnostic[]): void {
  const payload = record.payload
  if (!equalScope(payload.origin.uw, record))
    diagnostics.push(
      diagnostic('cause-origin-mismatch', `Disposition ${record.recordId} is not stored on its original UW`),
    )
  const originHistory = histories.find((history) => equalScope(history.source.scope, payload.origin.uw))
  const acceptedSpec =
    originHistory &&
    recordsOf(originHistory).some((candidate) => {
      if (candidate.kind !== 'mandate') return false
      const accepted = resolveAcceptedSpec(candidate, histories)
      return (
        accepted.ok && sameOwnSpecRef(accepted.spec.ref, payload.origin) && resolveOwnSpecEffective(accepted.spec).ok
      )
    })
  if (!acceptedSpec)
    diagnostics.push(
      diagnostic('cause-origin-unconfirmed', `Disposition ${record.recordId} lacks its authenticated accepted Spec`),
    )
}

export function validateCauseDispositionRecords(input: {
  records: readonly CanonicalRecord[]
  histories: readonly DecodedHistory[]
}): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const dispositions = input.records.filter((record): record is Disposition => record.kind === 'cause-disposition')
  const operations = input.records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'cause-operation' }> => record.kind === 'cause-operation',
  )
  const subjects = new Map<string, string>()
  const successors = new Set<string>()
  validateHistories(input.histories, diagnostics)
  validateCauseOperations(operations, input.histories, diagnostics)
  for (const record of dispositions) {
    validateOrigin(record, input.histories, diagnostics)
    validateCauseChain(record, dispositions, operations, subjects, successors, diagnostics)
    validateCauseSubject(record, operations, input.histories, diagnostics)
  }
  validateCauseCycles(dispositions, diagnostics)
  diagnostics.push(...validateCauseEffects(input, dispositions))
  return diagnostics
}

import { validateCauseEffects } from './cause-effect-validation.ts'
import { validateConfirmation, validateCreation } from './cause-record-operation-validation.ts'
import { validateCauseDispositionRecords } from './cause-record-validation.ts'
import { readCauseReports } from './cause-reports.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { bindExternalRef, recordsOf, workflowOperationProblem } from './workflow-control.ts'

type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Promotion = Extract<CanonicalRecord, { kind: 'report-promotion' }>

type Input = { record: CanonicalRecord; history: DecodedHistory; externalHistories: readonly DecodedHistory[] }

function isPromotionIntent(record: CanonicalRecord): record is Operation {
  return (
    record.kind === 'cause-operation' &&
    record.payload.proposal.operation === 'create' &&
    record.payload.proposal.creation.kind === 'report-promotion'
  )
}

function promotionReport(input: Input, record: Operation | Promotion) {
  const history = input.history
  const scope = history.source.scope
  if (!equalScope(record, scope) || workflowOperationProblem(history) !== null)
    return {
      ok: false as const,
      diagnostics: [
        diagnostic('cause-history-unconfirmed', 'A complete authenticated original UW history is required'),
      ],
    }
  const reportRef =
    record.kind === 'report-promotion'
      ? record.payload.report
      : record.payload.proposal.operation === 'create' && record.payload.proposal.creation.kind === 'report-promotion'
        ? record.payload.proposal.creation.report
        : null
  if (reportRef === null || !equalScope(reportRef.scope, scope))
    return {
      ok: false as const,
      diagnostics: [
        diagnostic('cause-operation-source-unconfirmed', 'Promotion must name a report on the original UW'),
      ],
    }
  const listing = readCauseReports({ root: scope, subtree: [scope], histories: [history] })
  if (!listing.ok) return listing
  const report = listing.value.reports.find((entry) => sameRef(entry.ref, reportRef))
  if (
    !report ||
    (report.promotion !== null &&
      !(record.kind === 'report-promotion' && report.promotion.recordId === record.recordId))
  )
    return {
      ok: false as const,
      diagnostics: [
        diagnostic('cause-operation-source-unconfirmed', 'Promotion requires an unpromoted final authenticated report'),
      ],
    }
  return { ok: true as const, report, reportRef }
}

function validatePromotionReceipt(
  input: Input,
  record: Promotion,
  existing: readonly CanonicalRecord[],
  report: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
  diagnostics: Diagnostic[],
): void {
  const effects = existing.filter((item) => item.kind === 'debt-receipt' || item.kind === 'report-promotion')
  if (
    effects.some(
      (effect) =>
        (effect.kind === 'report-promotion' && sameRef(effect.payload.report, record.payload.report)) ||
        sameRef(effect.payload.operation, record.payload.operation),
    )
  )
    diagnostics.push(diagnostic('cause-effect-duplicate', 'Report or creation intent already has a receipt'))
  if (input.externalHistories.some((item) => workflowOperationProblem(item) !== null))
    diagnostics.push(diagnostic('cause-history-unconfirmed', 'Created UW history must be complete and authenticated'))
  if (
    input.externalHistories.filter((item) => equalScope(item.source.scope, record.payload.identity.scope)).length !== 1
  )
    diagnostics.push(diagnostic('cause-history-unconfirmed', 'A unique created UW identity history is required'))
  diagnostics.push(
    ...validateCauseEffects({ records: [record], histories: [input.history, ...input.externalHistories] }, [report]),
  )
}

function historicalPublication(input: Input, record: Operation | Promotion): Diagnostic[] {
  const { history } = input
  const diagnostics: Diagnostic[] = []
  const result = promotionReport(input, record)
  if (!result.ok) return result.diagnostics
  const { report, reportRef } = result
  const existing = recordsOf(history).filter((item) => item.recordId !== record.recordId)
  const operations = existing.filter((item): item is Operation => item.kind === 'cause-operation')
  const confirmations = new Set<string>()
  for (const operation of record.kind === 'cause-operation' ? [...operations, record] : operations)
    validateConfirmation(operation, confirmations, diagnostics)
  const operation =
    record.kind === 'cause-operation'
      ? record
      : (() => {
          const bound = bindExternalRef(record.payload.operation, history)
          return bound.ok && isPromotionIntent(bound.value) ? bound.value : null
        })()
  if (
    operation === null ||
    operation.payload.proposal.operation !== 'create' ||
    operation.payload.proposal.creation.kind !== 'report-promotion'
  )
    return [
      ...diagnostics,
      diagnostic('cause-operation-source-unconfirmed', 'Promotion lacks its authenticated creation intent'),
    ]
  validateCreation(operation, operation.payload.proposal, report.record, diagnostics)
  const competing = operations.filter(
    (item) =>
      item.recordId !== operation.recordId &&
      isPromotionIntent(item) &&
      item.payload.proposal.operation === 'create' &&
      item.payload.proposal.creation.kind === 'report-promotion' &&
      sameRef(item.payload.proposal.creation.report, reportRef),
  )
  if (competing.length > 0) diagnostics.push(diagnostic('cause-effect-duplicate', 'Report has another creation intent'))
  if (record.kind === 'report-promotion') validatePromotionReceipt(input, record, existing, report.record, diagnostics)
  return diagnostics
}

/** Publication-only semantic dispatch; all other causal records retain live validation. */
export function validateCausePublication(input: Input): Diagnostic[] {
  if (isPromotionIntent(input.record) || input.record.kind === 'report-promotion')
    return historicalPublication(input, input.record)
  return validateCauseDispositionRecords({
    histories: [input.history, ...input.externalHistories],
    records: [
      ...recordsOf(input.history).filter((item) => item.recordId !== input.record.recordId),
      ...input.externalHistories.flatMap(recordsOf),
      input.record,
    ],
  })
}

import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import type { Ref, ReportListing } from './cause-disposition.ts'
import { readCauseDispositionHeads } from './cause-heads.ts'
import {
  diagnoseDispositionCycle,
  validateDispositionSuccessor,
  validateInitialDisposition,
  validateReportPromotion,
} from './cause-report-validation.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { Result } from './result.ts'
import { bindExternalRef, recordsOf, workflowOperationProblem } from './workflow-control.ts'
export function resolveCauseSisterReceipt(input: {
  disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  histories: readonly DecodedHistory[]
}): Result<Extract<CanonicalRecord, { kind: 'debt-receipt' }> | null> {
  const disposition = input.disposition
  const uw = { repository: disposition.repository, target: disposition.target }
  const histories = input.histories.filter((history) => equalScope(history.source.scope, uw))
  const history = histories[0]
  if (histories.length !== 1 || history === undefined || workflowOperationProblem(history) !== null)
    return {
      ok: false,
      diagnostics: [diagnostic('cause-history-unconfirmed', 'A complete original UW history is required')],
    }
  const ref: Ref<'cause-disposition'> = { scope: uw, recordId: disposition.recordId, kind: 'cause-disposition' }
  const bound = bindExternalRef(ref, history)
  if (!bound.ok || canonicalValueDigest(bound.value) !== canonicalValueDigest(disposition))
    return {
      ok: false,
      diagnostics: [diagnostic('cause-source-unconfirmed', 'Sister disposition is not authenticated')],
    }
  if (
    disposition.payload.subject.kind !== 'cause' ||
    disposition.payload.outcome.state !== 'final' ||
    (disposition.payload.outcome.disposition !== 'sister-blocking' &&
      disposition.payload.outcome.disposition !== 'sister-after')
  )
    return { ok: false, diagnostics: [diagnostic('cause-effect-mismatch', 'Disposition is not a final sister')] }
  const receipts = recordsOf(history).filter(
    (record): record is Extract<CanonicalRecord, { kind: 'debt-receipt' }> =>
      record.kind === 'debt-receipt' && sameRef(record.payload.disposition, ref),
  )
  if (receipts.length === 0) return { ok: true, value: null }
  if (receipts.length !== 1 || receipts[0] === undefined)
    return {
      ok: false,
      diagnostics: [diagnostic('cause-effect-duplicate', 'Sister disposition has multiple receipts')],
    }
  const receipt = receipts[0]
  const originalHistory = history
  const subject = disposition.payload.subject
  const outcome = disposition.payload.outcome
  return validateReceipt()

  function validateReceipt(): Result<Extract<CanonicalRecord, { kind: 'debt-receipt' }>> {
    const receiptBound = bindExternalRef(
      { scope: uw, kind: 'debt-receipt', recordId: receipt.recordId },
      originalHistory,
    )
    const operation = bindExternalRef(receipt.payload.operation, originalHistory)
    const sisterHistories = input.histories.filter((item) => equalScope(item.source.scope, receipt.payload.sister))
    const sisterHistory = sisterHistories[0]
    if (
      !receiptBound.ok ||
      !operation.ok ||
      operation.value.kind !== 'cause-operation' ||
      sisterHistories.length !== 1 ||
      sisterHistory === undefined ||
      workflowOperationProblem(sisterHistory) !== null
    )
      return {
        ok: false,
        diagnostics: [
          diagnostic('cause-effect-unconfirmed', 'Receipt, operation or complete sister history is unavailable'),
        ],
      }
    const identity = bindExternalRef(receipt.payload.identity, sisterHistory)
    const op = operation.value.payload
    const proposal = op.proposal
    if (
      !identity.ok ||
      identity.value.kind !== 'spec-identity' ||
      identity.value.payload.event !== 'allocate' ||
      proposal.operation !== 'create' ||
      proposal.creation.kind !== 'sister' ||
      !equalScope(receipt.payload.identity.scope, receipt.payload.sister) ||
      !equalScope(receipt.payload.original, uw) ||
      !sameRef(receipt.payload.decision, subject.decision) ||
      receipt.payload.causeId !== subject.cause.id ||
      !sameRef(proposal.creation.disposition, ref) ||
      !equalScope(proposal.creation.original, uw) ||
      proposal.creation.dispositionDigest !== createHash('sha256').update(JSON.stringify(disposition)).digest('hex') ||
      proposal.creation.relation !== receipt.payload.relation ||
      receipt.payload.relation !==
        (outcome.disposition === 'sister-blocking' ? 'original-blocked-by-sister' : 'sister-blocked-by-original') ||
      canonicalValueDigest(proposal.creation.parent) !== canonicalValueDigest(receipt.payload.parent) ||
      op.proposalDigest !== createHash('sha256').update(JSON.stringify(proposal)).digest('hex') ||
      op.confirmation.proposalDigest !== op.proposalDigest ||
      op.confirmation.operationId !== proposal.operationId ||
      identity.value.operationId !== proposal.operationId ||
      identity.value.payload.proposalDigest !== op.proposalDigest ||
      canonicalValueDigest(identity.value.payload.confirmation) !== canonicalValueDigest(op.confirmation) ||
      canonicalValueDigest(identity.value.payload.allocations) !== canonicalValueDigest(proposal.allocation.assignments)
    )
      return {
        ok: false,
        diagnostics: [
          diagnostic('cause-effect-mismatch', 'Sister receipt does not match its confirmed proposal and identity'),
        ],
      }
    return { ok: true, value: receipt }
  }
}
export function readCauseReports(input: {
  root: Scope
  subtree: readonly Scope[]
  histories: readonly DecodedHistory[]
}): Result<ReportListing> {
  const diagnostics: Diagnostic[] = []
  if (!input.subtree.some((scope) => equalScope(scope, input.root)))
    diagnostics.push(diagnostic('missing-root', 'The selected subtree must contain its root'))
  const keys = input.subtree.map((scope) => `${scope.repository}\0${scope.target}`)
  if (new Set(keys).size !== keys.length)
    diagnostics.push(diagnostic('duplicate-scope', 'The selected subtree repeats a scope'))
  const reports: ReportListing['reports'] = []
  function collectScope(scope: Scope): void {
    const histories = input.histories.filter((history) => equalScope(history.source.scope, scope))
    const history = histories[0]
    if (histories.length !== 1 || history === undefined || !history.source.complete) {
      diagnostics.push(
        diagnostic('incomplete', `A unique complete history is required for ${scope.repository} ${scope.target}`),
      )
      return
    }
    const completeHistory = history
    const heads = readCauseDispositionHeads({ uw: scope, histories })
    if (!heads.ok) diagnostics.push(...heads.diagnostics)
    const problem = workflowOperationProblem(history)
    if (problem !== null)
      diagnostics.push(diagnostic(problem, `Workflow history is not complete and authoritative for ${scope.target}`))
    const records = recordsOf(history)
    const dispositions = records.filter(
      (record): record is Extract<CanonicalRecord, { kind: 'cause-disposition' }> =>
        record.kind === 'cause-disposition',
    )
    const promotions = records.filter(
      (record): record is Extract<CanonicalRecord, { kind: 'report-promotion' }> => record.kind === 'report-promotion',
    )
    const ids = new Set(dispositions.map((record) => record.recordId))
    const successorCount = new Map<string, number>()
    const initialSubjects = new Set<string>()
    function validateLineage(record: (typeof dispositions)[number]): void {
      const ref: Ref<'cause-disposition'> = { scope, recordId: record.recordId, kind: 'cause-disposition' }
      const bound = bindExternalRef(ref, completeHistory)
      if (!bound.ok) diagnostics.push(...bound.diagnostics)
      if (!equalScope(record.payload.origin.uw, scope))
        diagnostics.push(
          diagnostic('cause-origin-mismatch', `Disposition ${record.recordId} is not stored on its origin`),
        )
      const previous = record.payload.previous
      if (previous === null) validateInitialDisposition(record, initialSubjects, diagnostics)
      if (previous !== null)
        validateDispositionSuccessor(record, previous, scope, ids, dispositions, successorCount, diagnostics)
    }
    for (const record of dispositions) validateLineage(record)
    if ([...successorCount.values()].some((count) => count !== 1))
      diagnostics.push(diagnostic('ambiguous', 'Disposition chain has competing successors'))
    function collectReport(record: (typeof dispositions)[number]): void {
      diagnoseDispositionCycle(record, dispositions, diagnostics)
      if (
        successorCount.has(record.recordId) ||
        record.payload.outcome.state !== 'final' ||
        record.payload.outcome.disposition !== 'report'
      )
        return
      const matches = promotions.filter(
        (item) => equalScope(item.payload.report.scope, scope) && item.payload.report.recordId === record.recordId,
      )
      if (matches.length > 1)
        diagnostics.push(diagnostic('ambiguous', `Report ${record.recordId} has multiple promotions`))
      const promotion = matches[0]
      if (promotion) validateReportPromotion(promotion, record, scope, completeHistory, diagnostics)
      reports.push({
        ref: { scope, recordId: record.recordId, kind: 'cause-disposition' },
        record,
        promotion: promotion ? { scope, recordId: promotion.recordId, kind: 'report-promotion' } : null,
      })
    }
    for (const record of dispositions) collectReport(record)
  }
  for (const scope of input.subtree) collectScope(scope)
  return diagnostics.length ? { ok: false, diagnostics } : { ok: true, value: { root: input.root, reports } }
}

import {
  readCauseDispositionHeads,
  resolveCauseSisterReceipt,
  validateCauseDispositionRecords,
} from './cause-disposition.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { recordsOf } from './workflow-control.ts'

/** Durable cause state is a delivery veto, not a replacement for mandate authority. */
export function assessCauseHolds(input: { uw: Scope; histories: readonly DecodedHistory[] }): Diagnostic[] {
  const heads = readCauseDispositionHeads(input)
  if (!heads.ok) return heads.diagnostics
  const own = input.histories.find(
    (history) =>
      history.source.scope.repository === input.uw.repository && history.source.scope.target === input.uw.target,
  )
  if (own === undefined) return [diagnostic('cause-history-unconfirmed', 'Original UW history is missing')]
  const diagnostics: Diagnostic[] = validateCauseDispositionRecords({
    records: recordsOf(own),
    histories: input.histories,
  })
  for (const disposition of heads.value) {
    const outcome = disposition.payload.outcome
    if (outcome.state === 'pending-blocking') {
      diagnostics.push({
        ...diagnostic('cause-adjudication-required', outcome.reason),
        recordId: disposition.recordId,
      })
      continue
    }
    if (outcome.disposition !== 'sister-blocking') continue
    const receipt = resolveCauseSisterReceipt({ disposition, histories: input.histories })
    if (!receipt.ok) {
      diagnostics.push(...receipt.diagnostics)
      continue
    }
    if (receipt.value === null) {
      diagnostics.push({
        ...diagnostic('cause-sister-confirmation-required', 'Blocking sister creation is not confirmed'),
        recordId: disposition.recordId,
      })
    }
  }
  return diagnostics
}

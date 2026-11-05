import { readCauseDispositionHeads, resolveCauseSisterReceipt } from './cause-disposition.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { isCompletedUw, sameScope, type UwGraphObservation } from './uw-graph.ts'

/** Durable cause state is a delivery veto, not a replacement for mandate authority. */
export function assessCauseHolds(input: {
  uw: Scope
  histories: readonly DecodedHistory[]
  graph: UwGraphObservation
  catalogues: ReviewClassCatalogues
}): Diagnostic[] {
  const heads = readCauseDispositionHeads(input)
  if (!heads.ok) return heads.diagnostics
  const diagnostics: Diagnostic[] = []
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
      continue
    }
    const confirmedReceipt = receipt.value
    const sister = input.graph.nodes.find((node) => sameScope(node.uw, confirmedReceipt.payload.sister))
    if (input.graph.status !== 'complete' || sister === undefined || !isCompletedUw(sister)) {
      diagnostics.push({
        ...diagnostic('cause-sister-incomplete', 'Blocking sister completion is not established'),
        recordId: disposition.recordId,
      })
    }
  }
  return diagnostics
}

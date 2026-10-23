import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import { type MandateRecord, mandateScope, mandatesOf } from './workflow-control.ts'
import { diagnostic, equalScope, sameRef } from './workflow-support.ts'

function epicListings(mandate: MandateRecord, histories: readonly DecodedHistory[]): ExternalRecordRef[] {
  const scope = mandateScope(mandate)
  const refs: ExternalRecordRef[] = []
  for (const history of histories) {
    for (const record of mandatesOf(history)) {
      if (record.payload.role !== 'epic') continue
      if (!record.payload.children.some((child) => equalScope(child.scope, scope))) continue
      refs.push({ scope: mandateScope(record), recordId: record.recordId, kind: 'mandate' })
    }
  }
  return refs
}

export function epicParentProblem(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): { reason: 'ambiguous' | 'missing' | 'incompatible'; evidence: Diagnostic[] } | null {
  const listings = epicListings(mandate, histories)
  if (listings.length > 1) {
    return { reason: 'ambiguous', evidence: [diagnostic('ambiguous', 'More than one epic lists this child')] }
  }
  const listing = listings[0]
  if (listing === undefined) return null
  if (mandate.payload.parent === null) {
    return { reason: 'missing', evidence: [diagnostic('missing', 'Epic-created child omitted its parent')] }
  }
  if (!sameRef(mandate.payload.parent, listing)) {
    return {
      reason: 'incompatible',
      evidence: [diagnostic('incompatible', 'Epic child parent ref does not name the listing epic')],
    }
  }
  return null
}

import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Diagnostic } from './record-values.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import { abandoned, type MandateRecord, mandateScope, mandatesOf, successorOf } from './workflow-control.ts'

function parentListings(mandate: MandateRecord, histories: readonly DecodedHistory[]): ExternalRecordRef[] {
  const scope = mandateScope(mandate)
  const refs: ExternalRecordRef[] = []
  for (const history of histories) {
    const active = mandatesOf(history).filter(
      (record) => !abandoned(history, record) && successorOf(history, record) === null,
    )
    if (active.length !== 1) continue
    const parent = active[0]
    if (parent === undefined) continue
    const accepted = resolveAcceptedSpec(parent, [history, ...histories])
    if (!accepted.ok || !accepted.spec.children.some((child) => equalScope(child.scope, scope))) continue
    refs.push({ scope: mandateScope(parent), recordId: parent.recordId, kind: 'mandate' })
  }
  return refs
}

export function epicParentProblem(
  mandate: MandateRecord,
  histories: readonly DecodedHistory[],
): { reason: 'ambiguous' | 'missing' | 'incompatible'; evidence: Diagnostic[] } | null {
  const listings = parentListings(mandate, histories)
  if (listings.length > 1) {
    return { reason: 'ambiguous', evidence: [diagnostic('ambiguous', 'More than one parent lists this child')] }
  }
  const listing = listings[0]
  if (listing === undefined) return null
  if (mandate.payload.parent === null) {
    return { reason: 'missing', evidence: [diagnostic('missing', 'Parent-created child omitted its parent')] }
  }
  if (!sameRef(mandate.payload.parent, listing)) {
    return {
      reason: 'incompatible',
      evidence: [diagnostic('incompatible', 'Child parent ref does not name the listing parent')],
    }
  }
  return null
}

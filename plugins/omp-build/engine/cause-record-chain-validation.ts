import type { Ref } from './cause-disposition.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Operation = Extract<CanonicalRecord, { kind: 'cause-operation' }>

export function validateCauseChain(
  record: Disposition,
  dispositions: readonly Disposition[],
  operations: readonly Operation[],
  subjects: Map<string, string>,
  successors: Set<string>,
  diagnostics: Diagnostic[],
): void {
  const payload = record.payload
  const identity = JSON.stringify([payload.origin, payload.basis.versionVector, payload.subject])
  if (payload.previous === null) {
    if (payload.adjudication !== null)
      diagnostics.push(diagnostic('cause-chain-invalid', `Initial disposition ${record.recordId} has an adjudication`))
    if (subjects.has(identity))
      diagnostics.push(
        diagnostic('cause-duplicate-initial', `Disposition ${record.recordId} duplicates ${subjects.get(identity)}`),
      )
    subjects.set(identity, record.recordId)
    return
  }
  const key = JSON.stringify(payload.previous)
  if (successors.has(key))
    diagnostics.push(diagnostic('cause-chain-competing', `Disposition ${record.recordId} competes for a predecessor`))
  successors.add(key)
  const predecessor = payload.previous
  const previous = dispositions.find(
    (item) => item.recordId === predecessor.recordId && equalScope(item, predecessor.scope),
  )
  if (
    previous?.payload.outcome.state !== 'pending-blocking' ||
    JSON.stringify(previous.payload.subject) !== JSON.stringify(payload.subject) ||
    JSON.stringify(previous.payload.origin) !== JSON.stringify(payload.origin) ||
    JSON.stringify(previous.payload.basis) !== JSON.stringify(payload.basis)
  )
    diagnostics.push(
      diagnostic('cause-chain-invalid', `Disposition ${record.recordId} has no matching pending predecessor`),
    )
  const adjudicationRef = payload.adjudication
  const operation =
    adjudicationRef &&
    operations.find((item) => item.recordId === adjudicationRef.recordId && equalScope(item, adjudicationRef.scope))
  if (
    operation?.payload.proposal.operation !== 'adjudicate-cause' ||
    !sameRef(operation.payload.proposal.pending, payload.previous)
  )
    diagnostics.push(
      diagnostic('cause-chain-invalid', `Disposition ${record.recordId} lacks its matching adjudication`),
    )
}

export function validateCauseCycles(dispositions: readonly Disposition[], diagnostics: Diagnostic[]): void {
  for (const record of dispositions) {
    const visited = new Set<string>()
    let cursor: typeof record | undefined = record
    while (cursor?.payload.previous) {
      if (visited.has(cursor.recordId)) {
        diagnostics.push(diagnostic('cause-chain-cycle', `Disposition chain cycles at ${cursor.recordId}`))
        break
      }
      visited.add(cursor.recordId)
      const previous: Ref<'cause-disposition'> = cursor.payload.previous
      cursor = dispositions.find((item) => item.recordId === previous.recordId && equalScope(item, previous.scope))
    }
  }
}

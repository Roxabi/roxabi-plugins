import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Result } from './result.ts'
import { bindExternalRef } from './workflow-control.ts'
export function causeDispositionLineage(input: {
  head: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  history: DecodedHistory
}): Result<
  readonly {
    disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
    adjudication: Extract<CanonicalRecord, { kind: 'cause-operation' }> | null
  }[]
> {
  const chain: {
    disposition: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
    adjudication: Extract<CanonicalRecord, { kind: 'cause-operation' }> | null
  }[] = []
  const seen = new Set<string>()
  let cursor = input.head
  while (true) {
    if (seen.has(cursor.recordId))
      return {
        ok: false,
        diagnostics: [diagnostic('cause-chain-cycle', `Disposition chain cycles at ${cursor.recordId}`)],
      }
    seen.add(cursor.recordId)
    const scope = input.history.source.scope
    const current = bindExternalRef({ scope, recordId: cursor.recordId, kind: 'cause-disposition' }, input.history)
    if (
      !current.ok ||
      current.value.kind !== 'cause-disposition' ||
      canonicalValueDigest(current.value) !== canonicalValueDigest(cursor)
    )
      return { ok: false, diagnostics: [diagnostic('cause-chain-invalid', 'Disposition chain is not authenticated')] }
    const previous = cursor.payload.previous
    const operationRef = cursor.payload.adjudication
    if (previous === null) {
      if (operationRef !== null)
        return {
          ok: false,
          diagnostics: [diagnostic('cause-chain-invalid', 'Initial disposition has an adjudication')],
        }
      chain.unshift({ disposition: cursor, adjudication: null })
      return { ok: true, value: chain }
    }
    const step = confirmedPredecessor(cursor, input.history)
    if (!step.ok) return step
    chain.unshift({ disposition: cursor, adjudication: step.value.operation })
    cursor = step.value.predecessor
  }
}

function confirmedPredecessor(
  cursor: Extract<CanonicalRecord, { kind: 'cause-disposition' }>,
  history: DecodedHistory,
): Result<{
  predecessor: Extract<CanonicalRecord, { kind: 'cause-disposition' }>
  operation: Extract<CanonicalRecord, { kind: 'cause-operation' }>
}> {
  const previous = cursor.payload.previous
  const operationRef = cursor.payload.adjudication
  if (previous === null || operationRef === null)
    return { ok: false, diagnostics: [diagnostic('cause-chain-invalid', 'Successor has no adjudication')] }
  const operation = bindExternalRef(operationRef, history)
  const predecessor = bindExternalRef(previous, history)
  if (
    !operation.ok ||
    operation.value.kind !== 'cause-operation' ||
    operation.value.payload.proposal.operation !== 'adjudicate-cause' ||
    !predecessor.ok ||
    predecessor.value.kind !== 'cause-disposition'
  )
    return {
      ok: false,
      diagnostics: [diagnostic('cause-chain-invalid', 'Successor operation or predecessor is not authenticated')],
    }
  const payload = operation.value.payload
  const proposal = payload.proposal
  if (
    proposal.operation !== 'adjudicate-cause' ||
    !sameRef(proposal.pending, previous) ||
    !equalScope(proposal.uw, history.source.scope) ||
    proposal.pendingDigest !== createHash('sha256').update(JSON.stringify(predecessor.value)).digest('hex') ||
    payload.proposalDigest !== createHash('sha256').update(JSON.stringify(proposal)).digest('hex') ||
    payload.confirmation.proposalDigest !== payload.proposalDigest ||
    payload.confirmation.operationId !== proposal.operationId ||
    predecessor.value.payload.outcome.state !== 'pending-blocking' ||
    canonicalValueDigest(predecessor.value.payload.subject) !== canonicalValueDigest(cursor.payload.subject) ||
    canonicalValueDigest(predecessor.value.payload.origin) !== canonicalValueDigest(cursor.payload.origin)
  )
    return {
      ok: false,
      diagnostics: [diagnostic('cause-chain-invalid', 'Successor differs from its confirmed predecessor')],
    }
  return { ok: true, value: { predecessor: predecessor.value, operation: operation.value } }
}

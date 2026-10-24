import type { Gh } from '../adapters/github/types.ts'
import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { ActionReceiptPayload } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { findHistoryRecord } from './feature-approved-context.ts'
import { explicitParentHistories } from './feature-context.ts'
import { type Contracts, type History, type HistoryRecord, loadContracts } from './feature-engine.ts'

type ImplementationStartPayload = Extract<ActionReceiptPayload, { action: 'implement'; phase: 'start' }>
type ImplementationStartReceipt = Omit<Extract<HistoryRecord, { kind: 'action-receipt' }>, 'payload'> & {
  payload: ImplementationStartPayload
}

export type ImplementationResultBinding = {
  loaded: Contracts
  gh: Gh
  history: History
  receiptScope: ScopedRecordRef['scope']
  start: ImplementationStartReceipt
  mandate: MandateReference
  branch: string
  exactInputs: { mandateId: string; planActionId: string }
  publicationParents: History[]
  child: NativeBatchResult['children'][number] | undefined
}

type ImplementationStart = {
  history: History
  start: ImplementationStartReceipt
}

type MandateReference = {
  scope: ScopedRecordRef['scope']
  recordId: string
  kind: 'mandate'
}

function isMandateReference(reference: ScopedRecordRef): reference is MandateReference {
  return reference.kind === 'mandate'
}

function isImplementationStartReceipt(
  record: HistoryRecord | null,
  start: ScopedRecordRef,
  operationId: string,
): record is ImplementationStartReceipt {
  return (
    record?.kind === 'action-receipt' &&
    record.recordId === start.recordId &&
    record.payload.phase === 'start' &&
    record.payload.action === 'implement' &&
    record.payload.actionId === operationId
  )
}

function mandateReference(start: ImplementationStartReceipt): MandateReference | null {
  const mandate = start.payload.mandate
  return isMandateReference(mandate) ? mandate : null
}

async function findImplementationStart(
  loaded: Contracts,
  input: { cwd: string; start: ScopedRecordRef; result: NativeBatchResult; gh: Gh },
): Promise<ImplementationStart | { reason: string }> {
  const composed = await loaded.readComposedWorkflowHistory([input.start.scope], { cwd: input.cwd, gh: input.gh })
  if (!composed.ok) return { reason: composed.reason }
  const history = composed.histories[0]
  if (!history) return { reason: 'incomplete' }
  for (const operation of history.operations) {
    const record = operation.record
    if (isImplementationStartReceipt(record, input.start, input.result.batch.operationId)) {
      return { history, start: record }
    }
  }
  return { reason: 'implementation-start-unconfirmed' }
}

function exactImplementationInputs(
  start: ImplementationStartReceipt,
  mandate: MandateReference,
): { mandateId: string; planActionId: string } | { reason: string } {
  const { mandateId, planActionId } = start.payload.exactInputs
  if (mandateId !== mandate.recordId) return { reason: 'implementation-start-unconfirmed' }
  return { mandateId, planActionId }
}

function externalPublicationParents(
  mandateHistory: History,
  parents: History[],
  receiptScope: ScopedRecordRef['scope'],
): History[] {
  return [mandateHistory, ...parents].filter(
    (context, index, contexts) =>
      (context.source.scope.repository !== receiptScope.repository ||
        context.source.scope.target !== receiptScope.target) &&
      contexts.findIndex(
        (known) =>
          known.source.scope.repository === context.source.scope.repository &&
          known.source.scope.target === context.source.scope.target,
      ) === index,
  )
}

export async function bindImplementationResult(input: {
  cwd: string
  start: ScopedRecordRef
  result: NativeBatchResult
  gh: Gh
}): Promise<ImplementationResultBinding | { reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { reason: `engine-unavailable:${loaded.missing}` }
  if (input.start.kind !== 'action-receipt') return { reason: 'implementation-start-unconfirmed' }
  const found = await findImplementationStart(loaded, input)
  if ('reason' in found) return found
  const mandate = mandateReference(found.start)
  if (mandate === null) return { reason: 'implementation-start-unconfirmed' }
  const mandateRead = await loaded.readComposedWorkflowHistory([mandate.scope], { cwd: input.cwd, gh: input.gh })
  if (!mandateRead.ok || !mandateRead.histories[0]) {
    return { reason: mandateRead.ok ? 'incomplete' : mandateRead.reason }
  }
  const mandateHistory = mandateRead.histories[0]
  const originalMandate = findHistoryRecord([mandateHistory], 'mandate', mandate.recordId)
  if (originalMandate === null) return { reason: 'mandate-missing' }
  const parents = await explicitParentHistories(loaded, originalMandate, { cwd: input.cwd, gh: input.gh })
  if (!parents.ok) return { reason: parents.reason }
  const branch = typeof originalMandate.payload.branch === 'string' ? originalMandate.payload.branch : null
  const exactInputs = exactImplementationInputs(found.start, mandate)
  if ('reason' in exactInputs) return exactInputs
  if (typeof branch !== 'string' || branch.length === 0) return { reason: 'implementation-branch-unbound' }
  return {
    loaded,
    gh: input.gh,
    history: found.history,
    receiptScope: input.start.scope,
    start: found.start,
    mandate,
    branch,
    exactInputs,
    publicationParents: externalPublicationParents(mandateHistory, parents.parents, input.start.scope),
    child: input.result.children[0],
  }
}

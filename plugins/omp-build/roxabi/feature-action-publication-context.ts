import type { ScopedRecordRef } from '../engine/record-references.ts'
import type { WorkflowReceiptAction } from '../engine/workflow-receipt-schema.ts'
import type { NativeBatchResult } from '../omp/review-runtime/contracts.ts'
import { type ActionStartReceipt, mandateReference, startedActionReceipt } from './feature-approved-context.ts'
import { explicitParentHistories } from './feature-context.ts'
import { type Contracts, defaultGh, type History, loadContracts } from './feature-engine.ts'
import { readFreshUwCausalContext } from './fix-uw-histories.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

type Gh = (cwd: string, args: string[]) => Promise<string>
export type NonImplementPublication<A extends WorkflowReceiptAction = WorkflowReceiptAction> = {
  loaded: Contracts
  gh: Gh
  history: History
  receiptScope: ScopedRecordRef['scope']
  publicationParents: History[]
  opened: ActionStartReceipt<A>
  cwd: string
}
async function publicationParents(
  loaded: Contracts,
  opened: ActionStartReceipt,
  receiptScope: ScopedRecordRef['scope'],
  parents: History[],
  cwd: string,
  gh: Gh,
): Promise<History[] | { reason: string }> {
  const mandate = mandateReference(opened)
  if (mandate === null) return { reason: 'action-uncertain' }
  const mandateRead = await loaded.readComposedWorkflowHistory([mandate.scope], withRoxabiGitHubPolicy({ cwd, gh }))
  if (!mandateRead.ok || !mandateRead.histories[0]) {
    return { reason: mandateRead.ok ? 'incomplete' : mandateRead.reason }
  }
  const mandateHistory = mandateRead.histories[0]
  const mandateRecord = mandateHistory.operations.find(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'mandate' &&
      operation.record.recordId === mandate.recordId,
  )?.record
  if (mandateRecord == null) return { reason: 'action-uncertain' }
  const external = await explicitParentHistories(loaded, mandateRecord, withRoxabiGitHubPolicy({ cwd, gh }))
  if (!external.ok) return { reason: external.reason }
  for (const context of [mandateHistory, ...external.parents]) {
    if (
      context.source.scope.repository === receiptScope.repository &&
      context.source.scope.target === receiptScope.target
    )
      continue
    if (
      parents.some(
        (known) =>
          known.source.scope.repository === context.source.scope.repository &&
          known.source.scope.target === context.source.scope.target,
      )
    )
      continue
    parents.push(context)
  }
  return parents
}

export async function resolvePublication(input: {
  cwd: string
  result: NativeBatchResult
  start: ScopedRecordRef
  gh?: Gh
}): Promise<NonImplementPublication | { reason: string }> {
  const loaded = await loadContracts()
  if ('missing' in loaded) return { reason: `engine-unavailable:${loaded.missing}` }
  const gh = input.gh ?? defaultGh()
  if (input.start.kind !== 'action-receipt') return { reason: 'action-uncertain' }
  const composed = await loaded.readComposedWorkflowHistory(
    [input.start.scope],
    withRoxabiGitHubPolicy({ cwd: input.cwd, gh }),
  )
  if (!composed.ok) return { reason: composed.reason }
  const history = composed.histories[0]
  if (!history) return { reason: 'incomplete' }
  const opened = startedActionReceipt(history, input.start, input.result.batch.operationId)
  if (opened === null) return { reason: 'action-uncertain' }
  const parents = await publicationParents(
    loaded,
    opened,
    input.start.scope,
    composed.histories.slice(1),
    input.cwd,
    gh,
  )
  if ('reason' in parents) return parents
  const mandate = mandateReference(opened)
  if (mandate === null) return { reason: 'action-uncertain' }
  const causal = await readFreshUwCausalContext(mandate.scope, [history, ...parents], { cwd: input.cwd, gh })
  if (!causal.ok) return { reason: 'action-authority-unreadable' }
  const resolution = loaded.startResolution(causal.value.histories, input.start)
  if (!resolution.ok) return { reason: 'interruption-resolution-invalid' }
  if (resolution.value !== null) return { reason: 'action-start-resolved' }
  if (
    history.operations.some(
      (operation) =>
        operation.record?.kind === 'action-receipt' &&
        operation.record.payload.phase === 'result' &&
        operation.record.payload.actionId === opened.payload.actionId,
    )
  )
    return { reason: 'action-result-present' }
  return { loaded, gh, history, receiptScope: input.start.scope, publicationParents: parents, opened, cwd: input.cwd }
}

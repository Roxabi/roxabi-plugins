import type { Gh } from '../adapters/github/types.ts'
import type { Scope } from '../engine/record-values.ts'
import { scopeKey, type UwGraphObservation, type UwNativeNode } from '../engine/uw-graph.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { bindExternalRef, historyFor, workflowOperationProblem } from '../engine/workflow-control.ts'
import type { ContinueFeatureResult } from '../roxabi/feature-contract.ts'
import type { UwOperations, UwRead } from '../roxabi/uw-contract.ts'
import type { GitRunner } from '../roxabi/workflow-checkout.ts'
import type { DeclaredCheckout } from './native-implementation-world.ts'

export type World = {
  parentScope: Scope
  parent: MandateRecord
  reviews: readonly { uw: Scope }[]
  operations: UwOperations
  gh: Gh
  git: GitRunner
  checkout(facts: DeclaredCheckout): void
}

export function integrationCompletions(initial: UwRead, world: World) {
  const completions = world.reviews.map((child) => {
    const completion = initial.completion.completions.get(scopeKey(child.uw))
    if (completion?.state !== 'complete')
      throw new Error(
        JSON.stringify({
          child: child.uw,
          completion,
          histories: initial.histories.map((history) => ({
            scope: history.source.scope,
            complete: history.source.complete,
            problem: workflowOperationProblem(history),
            diagnostics: history.diagnostics,
            operations: history.operations.map((operation) => ({
              operationId: operation.operationId,
              recordId: operation.recordId,
              kind: operation.kind,
              status: operation.status,
              authority: operation.authority,
            })),
          })),
        }),
      )
    return completion
  })
  return completions
}

export function ancestorHistories(
  initial: UwRead,
  graph: Extract<UwGraphObservation, { status: 'complete' }>,
  native: UwNativeNode,
) {
  const parents = []
  let ancestor = native.parent
  while (ancestor !== null) {
    const currentAncestor = ancestor
    const node = graph.nodes.find(
      (item) => item.uw.target === currentAncestor.target && item.uw.repository === currentAncestor.repository,
    )
    const parent = initial.histories.find(
      (item) =>
        item.source.scope.target === currentAncestor.target &&
        item.source.scope.repository === currentAncestor.repository,
    )
    if (!node || !parent) throw new Error('Parent ancestor observation missing')
    parents.push(parent)
    ancestor = node.parent
  }
  return parents
}

export async function authenticatedIntegrationStart(
  installed: UwOperations,
  scope: Scope,
  opened: Extract<ContinueFeatureResult, { kind: 'action' }>,
) {
  const startReadback = await installed.readUw(scope)
  const startHistory = historyFor(opened.start.scope, startReadback.histories)
  if (startHistory === null || !startHistory.source.complete)
    throw new Error('Integration START history is missing or incomplete')
  const boundStart = bindExternalRef(opened.start, startHistory)
  if (
    !boundStart.ok ||
    boundStart.value.kind !== 'action-receipt' ||
    boundStart.value.payload.action !== 'integrate' ||
    boundStart.value.payload.phase !== 'start'
  )
    throw new Error('Integration START is not authenticated')
  return boundStart.value
}

export function requireIntegrationAction(opened: ContinueFeatureResult) {
  if (opened.kind !== 'action' || opened.node !== 'integrate')
    throw new Error(`Parent integrate not opened: ${JSON.stringify(opened)}`)
  return opened
}

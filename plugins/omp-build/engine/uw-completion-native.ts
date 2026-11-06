import type { DecodedHistory } from './history-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type {
  DependencyBasis,
  DependencyResolution,
  UwCompletionObservation,
  UwWaitProjection,
} from './uw-completion-types.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { isWayfinder, sameScope, type UwNativeNode, unknownWayfinderLabels } from './uw-graph.ts'
import { recordsOf } from './workflow-control.ts'

type Refuse = (
  basis: DependencyBasis,
  state: 'not-complete' | 'indeterminate' | 'abandoned',
  problem: UwDiagnostic,
  managed: boolean,
) => DependencyResolution

function inboundProblem(
  other: DecodedHistory,
  uw: Scope,
  waits: UwWaitProjection,
  allocations: readonly ExternalRecordRef[],
): [string, string] | null {
  for (const operation of other.operations) {
    const record = operation.record
    if (
      record?.kind === 'mandate' &&
      record.payload.children.some((child) => sameScope(child.scope, uw)) &&
      !waits.requirements.some(
        (edge) =>
          edge.source.kind === 'accepted-child' && sameScope(edge.from, other.source.scope) && sameScope(edge.to, uw),
      )
    )
      return ['parent-engagement-unresolved', 'An inbound parent commitment has not been authenticated']
    if (
      record?.kind === 'debt-receipt' &&
      sameScope(record.payload.sister, uw) &&
      !allocations.some(
        (ref) =>
          ref.kind === 'debt-receipt' && ref.recordId === record.recordId && sameScope(ref.scope, other.source.scope),
      )
    )
      return ['creation-unresolved', 'An inbound sister creation receipt has not been authenticated']
  }
  return null
}

export function assessNativeOnly(input: {
  uw: Scope
  history: DecodedHistory
  node: UwNativeNode
  observation: Extract<UwCompletionObservation, { status: 'complete' }>
  waits: UwWaitProjection
  relevant: DecodedHistory['operations']
  key: string
  dependencies: Map<string, DependencyResolution>
  issue: (uw: Scope, code: string, message: string) => UwDiagnostic
  refuse: Refuse
  unresolved: (code: string, message: string) => DependencyResolution
}): DependencyResolution {
  const { uw, history, node, observation, waits, relevant, key, dependencies, issue, refuse, unresolved } = input
  const allocations: ExternalRecordRef[] = recordsOf(history)
    .filter((record) => record.kind === 'spec-identity')
    .map((record) => ({ scope: uw, kind: 'spec-identity', recordId: record.recordId }))
  for (const edge of waits.requirements) {
    if (edge.source.kind === 'accepted-child' && sameScope(edge.to, uw))
      allocations.push(edge.source.accepted.sourceAccepted)
    if (edge.source.kind === 'blocking-sister' && sameScope(edge.to, uw)) allocations.push(edge.source.receipt)
  }
  for (const other of observation.histories) {
    const problem = inboundProblem(other, uw, waits, allocations)
    if (problem) return unresolved(...problem)
  }
  const [firstAllocation, ...remainingAllocations] = allocations
  if (firstAllocation) {
    const problem = issue(uw, 'uw-before-mandate', 'Allocated or accepted UW has no own delivery mandate')
    return refuse(
      { kind: 'uw-before-mandate', witnesses: [firstAllocation, ...remainingAllocations] },
      'indeterminate',
      problem,
      false,
    )
  }
  if (relevant.length) return unresolved('history-unresolved', 'Workflow records prevent proving native-only absence')
  const basis: DependencyBasis = { kind: 'native-only', witness: { uw, history, observation } }
  if (
    isWayfinder(node) ||
    unknownWayfinderLabels(node).length ||
    node.native.state !== 'CLOSED' ||
    node.native.stateReason !== 'COMPLETED'
  )
    return refuse(
      basis,
      'not-complete',
      issue(uw, 'native-not-completed', 'Native-only dependency is not CLOSED/COMPLETED'),
      false,
    )
  const resolution: DependencyResolution = { uw, basis, state: 'satisfied', completion: null, diagnostics: [] }
  dependencies.set(key, resolution)
  return resolution
}

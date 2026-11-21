import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope } from './record-diagnostics.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { toDiagnostics } from './uw-diagnostics.ts'
import { type UwGraphObservation, validateUwGraph } from './uw-graph.ts'
import { executableGraph } from './workflow-graph.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import { historyRefusal } from './workflow-mandate-history.ts'
import { unliftedPause } from './workflow-pause.ts'

export type ParentEngagementEvidence = Readonly<{
  parent: Scope
  graph: UwGraphObservation
  histories: readonly DecodedHistory[]
}>

type Engagement = { state: 'inactive' | 'active' | 'indeterminate'; diagnostics: readonly Diagnostic[] }
const indeterminate = (message: string): Engagement => ({
  state: 'indeterminate',
  diagnostics: [diagnostic('incomplete', message)],
})
const key = (scope: Scope) => `${scope.repository}\0${scope.target}`

function parentHistory(evidence: ParentEngagementEvidence): { own: DecodedHistory } | Engagement {
  const { parent, graph, histories } = evidence
  if (!equalScope(parent, graph.root)) return indeterminate('Parent graph root does not match the requested parent')
  const graphCheck = validateUwGraph(graph)
  if (!graphCheck.ok) return { state: 'indeterminate', diagnostics: toDiagnostics(graphCheck.diagnostics) }
  const nodes = new Set(graph.nodes.map((node) => key(node.uw)))
  if (nodes.size !== graph.nodes.length || !nodes.has(key(parent)))
    return indeterminate('Parent graph has missing or duplicate nodes')
  const observed = new Map<string, DecodedHistory>()
  for (const history of histories) {
    const id = key(history.source.scope)
    if (!nodes.has(id) || observed.has(id)) return indeterminate('Parent histories have unexpected or duplicate scopes')
    observed.set(id, history)
    const problem = historyRefusal(history)
    if (problem !== null) return { state: 'indeterminate', diagnostics: problem.evidence }
  }
  if (observed.size !== nodes.size) return indeterminate('Parent graph history is incomplete')
  const own = observed.get(key(parent))
  return own === undefined ? indeterminate('Parent history is missing') : { own }
}

/** Proves native absence of mandate engagement; it never grants execution authority. */
export function assessParentInsertionEngagement(evidence: ParentEngagementEvidence): Engagement {
  const found = parentHistory(evidence)
  if (!('own' in found)) return found
  const own = found.own
  const selected = selectedMandate(own)
  if ('status' in selected) {
    if (
      selected.reason === 'missing' &&
      !own.operations.some(
        (operation) =>
          operation.authority !== 'foreign' &&
          (operation.kind === 'operator-control' || operation.claimedKinds.includes('operator-control')),
      )
    )
      return { state: 'inactive', diagnostics: selected.evidence }
    return { state: 'indeterminate', diagnostics: selected.evidence }
  }
  const pause = unliftedPause(own, selected)
  if (pause !== null) return indeterminate('Parent mandate is paused')
  const graphResult = executableGraph(selected)
  if (!graphResult.ok) return { state: 'indeterminate', diagnostics: graphResult.diagnostics }
  return { state: 'active', diagnostics: [] }
}

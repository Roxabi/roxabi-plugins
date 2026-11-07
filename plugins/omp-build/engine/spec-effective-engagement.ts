import type { DecodedHistory } from './history-schema.ts'
import { equalScope } from './record-diagnostics.ts'
import { projectNativeUwChildren } from './uw-child-admission.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { type UwGraphObservation, validateUwGraph } from './uw-graph.ts'
import { currentOwnSpecProblem } from './uw-spec-currentness.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { historyFor, mandatesOf, workflowOperationProblem } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'

type CurrentEngagement = { own: OwnSpecRef; graph: UwGraphObservation; histories: readonly DecodedHistory[] }

function refusal(input: CurrentEngagement, code: string, message: string): UwResult<never> {
  return {
    ok: false,
    diagnostics: [{ code, message, location: { kind: 'record', ref: input.own.sourceAccepted }, related: [] }],
  }
}

function unresolvedChildAuthority(history: DecodedHistory): boolean {
  const problem = workflowOperationProblem(history)
  const claims = history.operations.filter(
    (operation) =>
      operation.kind === 'mandate' ||
      operation.claimedKinds.includes('mandate') ||
      operation.kind === 'spec-identity' ||
      operation.claimedKinds.includes('spec-identity'),
  )
  return (
    problem !== null ||
    claims.some(
      (operation) => operation.authority === 'foreign' || operation.status !== 'complete' || operation.record === null,
    )
  )
}

function childEngagementProblem(child: AcceptedChildCommitment, input: CurrentEngagement): UwResult<never> | null {
  const history = historyFor(child.scope, input.histories)
  if (history === null || !history.source.complete)
    return refusal(
      input,
      'effective-child-unavailable',
      `Accepted child ${child.scope.repository} ${child.scope.target} history is unavailable`,
    )
  const node = input.graph.nodes.find((entry) => equalScope(entry.uw, child.scope))
  if (!node || currentOwnSpecProblem(node, child) !== null)
    return refusal(
      input,
      'effective-child-engagement-mismatch',
      `Accepted child ${child.scope.repository} ${child.scope.target} native snapshot or tier has changed`,
    )
  if (unresolvedChildAuthority(history))
    return refusal(
      input,
      'effective-child-unavailable',
      `Accepted child ${child.scope.repository} ${child.scope.target} has an unresolved authority claim`,
    )
  if (mandatesOf(history).length === 0) return null
  const selected = selectedMandate(history)
  if (!('kind' in selected) || selected.kind !== 'mandate')
    return refusal(
      input,
      'effective-child-unavailable',
      `Accepted child ${child.scope.repository} ${child.scope.target} has no unique active mandate`,
    )
  const current = resolveAcceptedSpec(selected, input.histories)
  if (
    !current.ok ||
    current.spec.ref.version !== child.specVersion ||
    current.spec.tier !== child.tier ||
    current.spec.snapshot.spec.version !== child.snapshot.spec.version
  )
    return refusal(
      input,
      'effective-child-engagement-mismatch',
      `Accepted child ${child.scope.repository} ${child.scope.target} version or tier has changed`,
    )
  return null
}

function stateEngagementProblem(
  state: AcceptedOwnSpec,
  parent: AcceptedOwnSpec | undefined,
  input: CurrentEngagement,
): UwResult<never> | null {
  const node = input.graph.nodes.find((entry) => equalScope(entry.uw, state.ref.uw))
  if (
    !node ||
    (parent === undefined ? node.parent !== null : node.parent === null || !equalScope(node.parent, parent.ref.uw))
  )
    return refusal(
      input,
      'effective-native-ancestry-mismatch',
      'Complete native ancestry does not match accepted inheritance',
    )
  const currentProblem = currentOwnSpecProblem(node, state)
  if (currentProblem !== null)
    return refusal(
      { ...input, own: state.ref },
      currentProblem,
      `Accepted UW ${state.ref.uw.repository} ${state.ref.uw.target} current native Spec or tier differs from its accepted state`,
    )
  const projected = projectNativeUwChildren({
    uw: state.ref.uw,
    graph: input.graph,
    accepted: { status: 'accepted', value: state },
  })
  if (!projected.ok) return { ok: false, diagnostics: [...projected.diagnostics] }
  for (const child of state.children) {
    const problem = childEngagementProblem(child, input)
    if (problem !== null) return problem
  }
  if (parent === undefined) return null
  const commitment = parent.children.find((child) => equalScope(child.scope, state.ref.uw))
  if (
    !commitment ||
    commitment.specVersion !== state.ref.version ||
    commitment.tier !== state.tier ||
    !parent.coverage?.assignments.some((assignment) =>
      assignment.children.some((child) => equalScope(child, state.ref.uw)),
    )
  )
    return refusal(
      input,
      'effective-parent-engagement-mismatch',
      'Current parent does not engage the exact child version, tier and coverage',
    )
  return null
}

export function currentEffectiveEngagementProblem(
  input: CurrentEngagement,
  states: readonly AcceptedOwnSpec[],
  controlAuthority: boolean,
): UwResult<never> | null {
  const checked = validateUwGraph(input.graph)
  if (!checked.ok) {
    const diagnostics = controlAuthority
      ? checked.diagnostics.filter((item) => item.code !== 'graph-cycle')
      : [...checked.diagnostics]
    if (diagnostics.length) return { ok: false, diagnostics }
  }
  for (const [index, state] of states.entries()) {
    const problem = stateEngagementProblem(state, states[index + 1], input)
    if (problem !== null) return problem
  }
  return null
}

import type { DecodedHistory } from './history-schema.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import { projectNativeUwChildren } from './uw-child-admission.ts'
import type { UwResult } from './uw-diagnostics.ts'
import { isWayfinder, type UwGraphObservation, unknownWayfinderLabels, validateUwGraph } from './uw-graph.ts'
import { currentOwnSpecProblem } from './uw-spec-currentness.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { historyFor, type MandateRecord, mandatesOf, workflowOperationProblem } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'
import type { AcceptedChildCommitment } from './workflow-mandate-schema.ts'
import { terminalMandate } from './workflow-terminal-mandate.ts'

type CurrentEngagement = { own: OwnSpecRef; graph: UwGraphObservation; histories: readonly DecodedHistory[] }
type EngagementRefusal = Extract<UwResult<never>, { ok: false }>
export type TerminalChildSuccession = Readonly<{ child: Scope; tip: ExternalRecordRef & { kind: 'mandate' } }>

function refusal(input: CurrentEngagement, code: string, message: string): EngagementRefusal {
  return {
    ok: false,
    diagnostics: [{ code, message, location: { kind: 'record', ref: input.own.sourceAccepted }, related: [] }],
  }
}

/** Foreign claims cannot veto a child's trusted mandate; without one they still prevent proving its absence. */
function unresolvedChildAuthority(history: DecodedHistory, managed: boolean): boolean {
  return (
    workflowOperationProblem(history) !== null ||
    history.operations.some(
      (operation) =>
        (operation.kind === 'mandate' ||
          operation.claimedKinds.includes('mandate') ||
          operation.kind === 'spec-identity' ||
          operation.claimedKinds.includes('spec-identity')) &&
        (operation.authority === 'foreign' ? !managed : operation.status !== 'complete' || operation.record === null),
    )
  )
}

/** Null proves absence of a managed child; a returned history is already checked and managed. */
function managedChildHistory(
  child: AcceptedChildCommitment,
  input: CurrentEngagement,
): DecodedHistory | EngagementRefusal | null {
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
  const managed = mandatesOf(history).length > 0
  if (unresolvedChildAuthority(history, managed))
    return refusal(
      input,
      'effective-child-unavailable',
      `Accepted child ${child.scope.repository} ${child.scope.target} has an unresolved authority claim`,
    )
  return managed ? history : null
}

function engagedChildMandate(
  history: DecodedHistory,
  parent: AcceptedOwnSpec,
  succession: TerminalChildSuccession | null,
): MandateRecord | null {
  if (succession === null) {
    const selected = selectedMandate(history)
    return 'kind' in selected && selected.kind === 'mandate' ? selected : null
  }
  const terminal = terminalMandate(history)
  const owner = parent.chain[0]
  if (!terminal.ok || !sameRef(terminal.value.ref, succession.tip) || owner?.kind !== 'mandate') return null
  const lineage = terminal.value.mandate.payload.parent
  return lineage !== null && sameRef(lineage, owner.source) ? terminal.value.mandate : null
}

function childEngagementProblem(
  child: AcceptedChildCommitment,
  input: CurrentEngagement,
  parent: AcceptedOwnSpec,
  succession: TerminalChildSuccession | null,
): UwResult<never> | null {
  const history = managedChildHistory(child, input)
  if (history === null || 'ok' in history) return history
  const terminal = succession !== null && equalScope(succession.child, child.scope) ? succession : null
  const selected = engagedChildMandate(history, parent, terminal)
  if (selected === null)
    return refusal(
      input,
      terminal === null ? 'effective-child-unavailable' : 'effective-child-succession-unconfirmed',
      terminal === null
        ? `Accepted child ${child.scope.repository} ${child.scope.target} has no unique active mandate`
        : `Accepted child ${child.scope.repository} ${child.scope.target} has no authenticated terminal engagement with this Parent`,
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
  succession: TerminalChildSuccession | null,
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
  if (isWayfinder(node) || unknownWayfinderLabels(node).length)
    return refusal(
      { ...input, own: state.ref },
      'effective-wayfinder-not-uw',
      `Accepted UW ${state.ref.uw.repository} ${state.ref.uw.target} is currently classified as a Wayfinder`,
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
    const problem = childEngagementProblem(child, input, state, succession)
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

/** No future Parent identity can preserve a child's existing mandate-bound inheritance. */
export function terminalParentChildrenProblem(
  input: CurrentEngagement,
  historical: AcceptedOwnSpec,
): EngagementRefusal | null {
  for (const child of historical.children) {
    const history = managedChildHistory(child, input)
    if (history === null) continue
    if ('ok' in history) return history
    return refusal(
      input,
      'successor-child-mandate-bound',
      `Accepted child ${child.scope.repository} ${child.scope.target} has a mandate bound to the former Parent`,
    )
  }
  return null
}

export function currentEffectiveEngagementProblem(
  input: CurrentEngagement,
  states: readonly AcceptedOwnSpec[],
  controlAuthority: boolean,
  succession: TerminalChildSuccession | null,
): UwResult<never> | null {
  const checked = validateUwGraph(input.graph)
  if (!checked.ok) {
    const diagnostics = controlAuthority
      ? checked.diagnostics.filter((item) => item.code !== 'graph-cycle')
      : [...checked.diagnostics]
    if (diagnostics.length) return { ok: false, diagnostics }
  }
  for (const [index, state] of states.entries()) {
    const problem = stateEngagementProblem(state, states[index + 1], input, index === 0 ? succession : null)
    if (problem !== null) return problem
  }
  return null
}

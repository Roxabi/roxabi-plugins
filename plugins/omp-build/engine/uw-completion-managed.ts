import { assessCauseHolds } from './cause-hold.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { Scope } from './record-values.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import { acceptedCompletionProblem } from './uw-completion-accepted.ts'
import type {
  DependencyBasis,
  DependencyResolution,
  UwCompletion,
  UwCompletionObservation,
  UwWaitProjection,
} from './uw-completion-types.ts'
import type { ObservedCommitIndex } from './uw-delivery-lineage.ts'
import { assessUwDeliveryProof } from './uw-delivery-proof.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import { isWayfinder, sameScope, type UwNativeNode } from './uw-graph.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { MandateRecord } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'

type Refuse = (
  basis: DependencyBasis,
  state: 'not-complete' | 'indeterminate' | 'abandoned',
  problem: UwDiagnostic,
  managed: boolean,
) => DependencyResolution
type Context = {
  uw: Scope
  key: string
  history: DecodedHistory
  node: UwNativeNode
  latest: MandateRecord
  observation: Extract<UwCompletionObservation, { status: 'complete' }>
  waits: UwWaitProjection
  dependencies: Map<string, DependencyResolution>
  completions: Map<string, UwCompletion>
  visiting: Set<string>
  commitIndex: UwResult<ObservedCommitIndex>
  issue: (uw: Scope, code: string, message: string) => UwDiagnostic
  refuse: Refuse
  assess: (uw: Scope) => DependencyResolution
}
type AcceptedSpec = AcceptedOwnSpec
type Effective = SpecEffective
type Complete = Extract<UwCompletion, { state: 'complete' }>

function assessChild(
  context: Context,
  basis: DependencyBasis,
  spec: AcceptedSpec,
  edge: UwWaitProjection['requirements'][number],
): DependencyResolution | Complete | null {
  const { uw, observation, visiting, key, assess, issue, refuse } = context
  if (edge.source.kind === 'native-child') {
    const childNode = observation.graph.nodes.find((candidate) => sameScope(candidate.uw, edge.to))
    if (childNode && isWayfinder(childNode)) return null
  }
  const dependency = assess(edge.to)
  if (dependency.state !== 'satisfied') {
    visiting.delete(key)
    return refuse(
      basis,
      'not-complete',
      issue(uw, 'dependency-held', `Dependency ${edge.to.repository}#${edge.to.target} is held`),
      true,
    )
  }
  if (edge.source.kind !== 'accepted-child') return null
  const completed = dependency.completion
  if (
    completed?.state !== 'complete' ||
    !spec.children.some((child) => sameScope(child.scope, edge.to) && child.specVersion === completed.spec.version)
  ) {
    visiting.delete(key)
    return refuse(
      basis,
      'indeterminate',
      issue(uw, 'child-version-mismatch', 'Accepted child completion is missing or has a different version'),
      true,
    )
  }
  return completed
}

function assessChildren(
  context: Context,
  basis: DependencyBasis,
  spec: AcceptedSpec,
): DependencyResolution | Complete[] {
  const { uw, key, visiting, waits, issue, refuse } = context
  const completedChildren: Complete[] = []
  visiting.add(key)
  for (const edge of waits.requirements.filter((entry) => sameScope(entry.from, uw))) {
    const result = assessChild(context, basis, spec, edge)
    if (result && 'basis' in result) return result
    if (result) completedChildren.push(result)
  }
  visiting.delete(key)
  if (completedChildren.length !== spec.children.length)
    return refuse(
      basis,
      'indeterminate',
      issue(uw, 'accepted-children-unresolved', 'Every accepted child must have a unique completed proof'),
      true,
    )
  return completedChildren
}

function finishProof(
  context: Context,
  basis: DependencyBasis,
  spec: AcceptedSpec,
  effective: Effective,
  completedChildren: Complete[],
): DependencyResolution {
  const { uw, key, waits, dependencies, completions, commitIndex, observation, node, issue, refuse } = context
  const firstHold = assessCauseHolds({ uw, waits, dependencies })[0]
  if (firstHold) return refuse(basis, 'not-complete', issue(uw, firstHold.code, firstHold.message), true)
  if (!commitIndex.ok)
    return refuse(
      basis,
      'indeterminate',
      commitIndex.diagnostics[0] ?? issue(uw, 'commit-observation-incomplete', 'Commit observation is unavailable'),
      true,
    )
  const proof = assessUwDeliveryProof(observation, uw, spec, effective, completedChildren, commitIndex.value)
  if (!proof.ok)
    return refuse(
      basis,
      'not-complete',
      proof.diagnostics[0] ?? issue(uw, 'delivery-unproven', 'Authenticated delivery proof is required'),
      true,
    )
  const completion: UwCompletion = {
    state: 'complete',
    uw,
    role: spec.children.length ? 'parent' : 'leaf',
    spec: spec.ref,
    versionVector: effective.versionVector,
    code: proof.value.code,
    sources: proof.value.sources,
  }
  completions.set(key, completion)
  const native = node.native
  const nativeSuccess =
    (native.state === 'OPEN' && (native.stateReason === null || native.stateReason === 'REOPENED')) ||
    (native.state === 'CLOSED' && native.stateReason === 'COMPLETED')
  const problems = nativeSuccess
    ? []
    : [
        issue(
          uw,
          'native-not-completed',
          'Native dependency state cannot be treated as success; change the native dependency explicitly',
        ),
      ]
  const resolution: DependencyResolution = {
    uw,
    basis,
    state: nativeSuccess ? 'satisfied' : 'held',
    completion,
    diagnostics: problems,
  }
  dependencies.set(key, resolution)
  return resolution
}

export function assessManagedCompletion(context: Context): DependencyResolution {
  const { uw, history, latest, observation, node, issue, refuse } = context
  const selected = selectedMandate(history)
  const mandate = 'kind' in selected && selected.kind === 'mandate' ? selected : latest
  const basis: DependencyBasis = {
    kind: 'accepted-uw',
    mandate: { scope: uw, kind: 'mandate', recordId: mandate.recordId },
  }
  if (!('kind' in selected))
    return refuse(
      basis,
      selected.reason === 'abandoned' ? 'abandoned' : 'indeterminate',
      issue(uw, selected.reason, 'No uniquely active authenticated mandate'),
      true,
    )
  const accepted = resolveAcceptedSpec(mandate, observation.histories)
  if (!accepted.ok)
    return refuse(
      basis,
      'indeterminate',
      issue(uw, accepted.reason, accepted.evidence.map((d) => d.message).join('; ')),
      true,
    )
  const acceptedProblem = acceptedCompletionProblem(uw, node, observation.graph, accepted.spec, issue)
  if (acceptedProblem) return refuse(basis, 'indeterminate', acceptedProblem, true)
  const effective = resolveSpecEffective({
    mode: 'current',
    own: accepted.spec.ref,
    histories: observation.histories,
    graph: observation.graph,
  })
  if (!effective.ok)
    return refuse(
      basis,
      'indeterminate',
      effective.diagnostics[0] ?? issue(uw, 'effective-unresolved', 'Effective Spec could not be resolved'),
      true,
    )
  const facts = observation.delivery.filter((entry) => sameScope(entry.uw, uw))
  if (facts.length !== 1)
    return refuse(
      basis,
      'indeterminate',
      issue(uw, 'delivery-facts-incomplete', 'A unique delivery observation is required'),
      true,
    )
  const children = assessChildren(context, basis, accepted.spec)
  if (!Array.isArray(children)) return children
  return finishProof(context, basis, accepted.spec, effective.value, children)
}

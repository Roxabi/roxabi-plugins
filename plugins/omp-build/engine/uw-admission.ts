import type { Scope } from './record-values.ts'
import { projectNativeUwChildren } from './uw-child-admission.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import {
  isWayfinder,
  sameScope,
  scopeKey,
  type UwCheck,
  type UwGraphObservation,
  type UwNativeNode,
  unknownWayfinderLabels,
  validateUwGraph,
} from './uw-graph.ts'
import type { SpecIdentityLedger } from './uw-identity.ts'
import { type SpecSnapshot, type UwTier, validateSpecIds } from './uw-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import type { AssessSpecExact } from './workflow-receipt-schema.ts'
export type ProposedOwnSpecResult =
  | { ok: true; snapshot: SpecSnapshot }
  | { ok: false; diagnostics: readonly UwDiagnostic[] }
export type AcceptedOwnSpecResult =
  | { status: 'accepted'; value: AcceptedOwnSpec }
  | { status: 'absent' }
  | { status: 'refused'; diagnostics: readonly UwDiagnostic[] }
export type CurrentChildrenProjection =
  | {
      ok: true
      value: readonly Pick<AssessSpecExact['proposed']['children'][number], 'scope' | 'specVersion' | 'tier'>[]
    }
  | { ok: false; diagnostics: readonly UwDiagnostic[] }
type UwAdmissionBase = {
  uw: Scope
  graph: UwGraphObservation
  proposed: ProposedOwnSpecResult
  accepted: AcceptedOwnSpecResult
  identities: SpecIdentityLedger
}
type InitialUwAdmissionInput = UwAdmissionBase & { phase: 'initial-selection' }
type TransitionUwAdmissionInput = UwAdmissionBase & {
  phase: 'delivery-transition' | 'landing'
  currentChildren: CurrentChildrenProjection
}
type UwAdmissionInput = InitialUwAdmissionInput | TransitionUwAdmissionInput
export type UwAdmission = { framed: UwCheck; deliverable: UwCheck; applicability: 'own-only' }
function diag(
  uw: Scope,
  code: string,
  message: string,
  connection: 'labels' | 'children' | 'blockers' | 'state' = 'state',
  related?: { uw: Scope; connection: 'children' | 'labels' | 'state' },
): UwDiagnostic {
  return {
    code,
    message,
    location: { kind: 'native', uw, connection },
    related: related === undefined ? [] : [{ kind: 'native', ...related }],
  }
}
function tier(node: UwNativeNode): { value: UwTier | null; diagnostics: UwDiagnostic[] } {
  const labels = node.labels.filter((label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full')
  return labels.length === 1
    ? { value: labels[0].slice(5) as UwTier, diagnostics: [] }
    : {
        value: null,
        diagnostics: [
          diag(
            node.uw,
            labels.length ? 'tier-conflicting' : 'tier-missing',
            'UW must have one native size tier',
            'labels',
          ),
        ],
      }
}
function framingDiagnostics(input: UwAdmissionInput, root: UwNativeNode | undefined): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  if (root === undefined) diagnostics.push(diag(input.uw, 'graph-incomplete', 'Selected UW is absent'))
  else if (isWayfinder(root)) {
    diagnostics.push(diag(input.uw, 'wayfinder-not-uw', 'Wayfinder is not a UW', 'labels'))
    if (root.labels.some((label) => label.startsWith('size:')))
      diagnostics.push(diag(input.uw, 'wayfinder-has-tier', 'Wayfinder has a tier', 'labels'))
  } else {
    diagnostics.push(...tier(root).diagnostics)
    if (unknownWayfinderLabels(root).length)
      diagnostics.push(diag(root.uw, 'wayfinder-unknown', 'Unknown wayfinder label', 'labels'))
  }
  if (!input.proposed.ok) return [...diagnostics, ...input.proposed.diagnostics]
  if (!input.proposed.snapshot.spec.criteria.length)
    diagnostics.push(diag(input.uw, 'criteria-missing', 'Spec has no criteria'))
  if (input.proposed.snapshot.spec.openQuestions.length)
    diagnostics.push(diag(input.uw, 'open-question', 'Spec has open questions'))
  const identities = validateSpecIds(input.proposed.snapshot.spec, input.identities)
  if (!identities.ok) diagnostics.push(...identities.diagnostics)
  return diagnostics
}

function blockerDiagnostics(root: UwNativeNode, nodes: ReadonlyMap<string, UwNativeNode>): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  for (const scope of root.blockers) {
    const blocker = nodes.get(scopeKey(scope))
    if (blocker === undefined) continue
    if (isWayfinder(blocker) || unknownWayfinderLabels(blocker).length)
      diagnostics.push(
        diag(root.uw, 'dependency-not-uw', `Blocker ${scope.target} is not a UW`, 'blockers', {
          uw: scope,
          connection: 'labels',
        }),
      )
    else if (blocker.native.state !== 'CLOSED' || blocker.native.stateReason !== 'COMPLETED')
      diagnostics.push(
        diag(
          root.uw,
          'blocker-not-completed',
          `Blocker ${scope.target} is ${blocker.native.state}/${blocker.native.stateReason ?? 'unknown'}`,
          'blockers',
          { uw: scope, connection: 'state' },
        ),
      )
  }
  return diagnostics
}

function transitionDiagnostics(
  input: UwAdmissionInput,
  root: UwNativeNode,
  nodes: ReadonlyMap<string, UwNativeNode>,
): UwDiagnostic[] {
  if (input.phase === 'initial-selection') return []
  if (input.accepted.status === 'absent') return [diag(input.uw, 'own-spec-unaccepted', 'No accepted own Spec')]
  if (input.accepted.status === 'refused') return [...input.accepted.diagnostics]
  const diagnostics: UwDiagnostic[] = []
  if (
    !sameScope(input.accepted.value.ref.uw, input.uw) ||
    (input.proposed.ok && input.accepted.value.snapshot.spec.version !== input.proposed.snapshot.spec.version)
  )
    diagnostics.push(diag(input.uw, 'material-change-pending', 'Own Spec changed'))
  const nativeTier = tier(root)
  diagnostics.push(...nativeTier.diagnostics)
  if (nativeTier.value !== null && nativeTier.value !== input.accepted.value.tier)
    diagnostics.push(diag(input.uw, 'material-change-pending', 'Tier changed', 'labels'))
  diagnostics.push(...childConcordanceDiagnostics(input, root, nodes))
  return diagnostics
}

function childConcordanceDiagnostics(
  input: TransitionUwAdmissionInput,
  root: UwNativeNode,
  nodes: ReadonlyMap<string, UwNativeNode>,
): UwDiagnostic[] {
  if (input.accepted.status !== 'accepted') return []
  const diagnostics: UwDiagnostic[] = []
  if (!input.currentChildren.ok) {
    diagnostics.push(...input.currentChildren.diagnostics)
    if (input.currentChildren.diagnostics.length === 0)
      diagnostics.push(
        diag(
          input.uw,
          'current-child-projection-incomplete',
          'Current child commitment projection is unavailable',
          'children',
        ),
      )
  }
  const membership = projectNativeUwChildren({ uw: input.uw, graph: input.graph, accepted: input.accepted })
  if (!membership.ok) diagnostics.push(...membership.diagnostics)
  for (const child of input.accepted.value.children) {
    if (root.children.some((scope) => sameScope(scope, child.scope))) {
      const native = nodes.get(scopeKey(child.scope))
      if (native !== undefined && !isWayfinder(native))
        diagnostics.push(...acceptedChildDiagnostics(input.currentChildren, input, child, native))
    }
  }
  return diagnostics
}

function acceptedChildDiagnostics(
  projection: CurrentChildrenProjection,
  input: TransitionUwAdmissionInput,
  child: AcceptedOwnSpec['children'][number],
  native: UwNativeNode,
): UwDiagnostic[] {
  const diagnostics: UwDiagnostic[] = []
  const nativeTier = tier(native)
  diagnostics.push(...nativeTier.diagnostics)
  if (nativeTier.value !== null && nativeTier.value !== child.tier)
    diagnostics.push(
      diag(
        input.uw,
        'material-change-pending',
        `Accepted child ${child.scope.target} tier drifted from ${child.tier} to ${nativeTier.value}`,
        'labels',
        { uw: child.scope, connection: 'labels' },
      ),
    )
  const current = projection.ok ? projection.value.find((entry) => sameScope(entry.scope, child.scope)) : undefined
  if (projection.ok && current === undefined)
    diagnostics.push(
      diag(
        input.uw,
        'current-child-projection-incomplete',
        `Current child ${child.scope.target} commitment projection is incomplete`,
        'children',
        { uw: child.scope, connection: 'state' },
      ),
    )
  else if (current !== undefined && current.specVersion !== child.specVersion)
    diagnostics.push(
      diag(
        input.uw,
        'material-change-pending',
        `Accepted child ${child.scope.target} Spec version drifted from ${child.specVersion} to ${current.specVersion}`,
        'children',
        { uw: child.scope, connection: 'state' },
      ),
    )
  return diagnostics
}

export function assessUwAdmission(input: UwAdmissionInput): UwAdmission {
  const root = input.graph.nodes.find((node) => sameScope(node.uw, input.uw))
  const framed = framingDiagnostics(input, root)
  const deliverable = [...framed, ...validateUwGraph(input.graph).diagnostics]
  if (root !== undefined) {
    const nodes = new Map(input.graph.nodes.map((node) => [scopeKey(node.uw), node]))
    deliverable.push(...blockerDiagnostics(root, nodes), ...transitionDiagnostics(input, root, nodes))
  }
  return {
    framed: { ok: framed.length === 0, diagnostics: framed },
    deliverable: { ok: deliverable.length === 0, diagnostics: deliverable },
    applicability: 'own-only',
  }
}

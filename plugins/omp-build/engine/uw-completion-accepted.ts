import type { Scope } from './record-values.ts'
import { projectNativeUwChildren } from './uw-child-admission.ts'
import { completionCoverageProblem } from './uw-completion-coverage.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { sameScope, type UwGraphObservation, type UwNativeNode } from './uw-graph.ts'
import { currentOwnSpecProblem } from './uw-spec-currentness.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

export function acceptedCompletionProblem(
  uw: Scope,
  node: UwNativeNode,
  graph: UwGraphObservation,
  spec: AcceptedOwnSpec,
  issue: (uw: Scope, code: string, message: string) => UwDiagnostic,
): UwDiagnostic | null {
  const currentProblem = currentOwnSpecProblem(node, spec)
  if (currentProblem) {
    const message =
      currentProblem === 'current-spec-unresolved'
        ? 'Current native own Spec cannot be resolved'
        : currentProblem === 'material-change-pending'
          ? 'Current native own Spec differs from the accepted Spec'
          : 'Native tier differs from the accepted tier'
    return issue(uw, currentProblem, message)
  }
  const nativeChildren = projectNativeUwChildren({ uw, graph, accepted: { status: 'accepted', value: spec } })
  if (!nativeChildren.ok)
    return nativeChildren.diagnostics[0] ?? issue(uw, 'children-unresolved', 'Native children are not concordant')
  for (const child of spec.children) {
    const native = nativeChildren.value.find((candidate) => sameScope(candidate.uw, child.scope))
    const childTiers =
      native?.labels.filter((label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full') ?? []
    if (childTiers.length !== 1 || childTiers[0] !== `size:${child.tier}`)
      return issue(uw, 'child-tier-mismatch', `Accepted child ${child.scope.target} tier differs from native metadata`)
  }
  const coverageProblem = completionCoverageProblem(uw, spec)
  return coverageProblem ? issue(uw, 'coverage-invalid', coverageProblem) : null
}

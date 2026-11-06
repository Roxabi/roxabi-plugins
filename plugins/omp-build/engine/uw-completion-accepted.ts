import { parseIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { Scope } from './record-values.ts'
import { projectNativeUwChildren } from './uw-child-admission.ts'
import { completionCoverageProblem } from './uw-completion-coverage.ts'
import type { UwDiagnostic } from './uw-diagnostics.ts'
import { sameScope, type UwGraphObservation, type UwNativeNode } from './uw-graph.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

export function acceptedCompletionProblem(
  uw: Scope,
  node: UwNativeNode,
  graph: UwGraphObservation,
  spec: AcceptedOwnSpec,
  issue: (uw: Scope, code: string, message: string) => UwDiagnostic,
): UwDiagnostic | null {
  if (node.raw.body !== spec.snapshot.raw.body) {
    const current = parseIssueSpecBody({ uw, raw: node.raw })
    if (current.status !== 'conformant')
      return issue(uw, 'current-spec-unresolved', 'Current native own Spec cannot be resolved')
    if (current.snapshot.spec.version !== spec.snapshot.spec.version)
      return issue(uw, 'material-change-pending', 'Current native own Spec differs from the accepted Spec')
  }
  const tiers = node.labels.filter((label) => label === 'size:S' || label === 'size:F-lite' || label === 'size:F-full')
  if (tiers.length !== 1 || tiers[0] !== `size:${spec.tier}`)
    return issue(uw, 'tier-changed', 'Native tier differs from the accepted tier')
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

import { projectNativeUwChildrenAgainstCommitments } from '../dist/contracts.js'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'

export function featureLeafStatus(
  { scope, selection }: Pick<FeatureAuthority, 'scope' | 'selection'>,
  graph: UwGraphObservation | null,
  acceptedChildCount: number | null,
): 'parent' | 'leaf' | 'unknown' {
  if (selection.status === 'applicable') {
    const { role, children } = selection.mandate.payload
    if (role === 'epic' || children.length > 0) return 'parent'
  }
  if (acceptedChildCount !== null && acceptedChildCount > 0) return 'parent'
  if (graph === null) return 'unknown'
  // A native child is positive parent evidence even before it is accepted into the Spec.
  const children = projectNativeUwChildrenAgainstCommitments({ uw: scope, graph, commitments: null })
  if (!children.ok) return 'unknown'
  if (children.value.length > 0) return 'parent'
  return acceptedChildCount === null ? 'unknown' : 'leaf'
}

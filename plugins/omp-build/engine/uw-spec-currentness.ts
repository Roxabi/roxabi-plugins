import { parseIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { UwNativeNode } from './uw-graph.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'

export function currentOwnSpecProblem(
  node: UwNativeNode,
  accepted: Pick<AcceptedOwnSpec, 'snapshot' | 'tier'>,
): 'current-spec-unresolved' | 'material-change-pending' | 'tier-changed' | null {
  if (node.raw.body !== accepted.snapshot.raw.body) {
    const current = parseIssueSpecBody({ uw: node.uw, raw: node.raw })
    if (current.status !== 'conformant') return 'current-spec-unresolved'
    if (current.snapshot.spec.version !== accepted.snapshot.spec.version) return 'material-change-pending'
  }
  let tiers = 0
  let matching = false
  for (const label of node.labels) {
    if (label.startsWith('size:')) {
      tiers++
      if (label === `size:${accepted.tier}`) matching = true
    }
  }
  return tiers === 1 && matching ? null : 'tier-changed'
}

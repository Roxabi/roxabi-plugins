import { projectNativeUwChildren } from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { AcceptedOwnSpecResult } from '../engine/uw-admission.ts'
import type { UwGraphObservation } from '../engine/uw-graph.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'

export function checkoutTarget(input: {
  uw: Scope
  graph: UwGraphObservation
  accepted: AcceptedOwnSpecResult
  branch: string
}): { ok: true; target: FeatureCheckoutTarget } | Extract<ContinueFeatureResult, { kind: 'blocked' }> {
  const children = projectNativeUwChildren({ uw: input.uw, graph: input.graph, accepted: input.accepted })
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  return {
    ok: true,
    target: children.value.length === 0 ? { kind: 'branch', branch: input.branch } : { kind: 'parent', uw: input.uw },
  }
}

import type { Scope } from '../engine/record-values.ts'
import type { NativeUwChildrenProjection } from '../engine/uw-child-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { FeatureCheckoutTarget } from './workflow-checkout.ts'

export function checkoutTarget(input: {
  uw: Scope
  children: NativeUwChildrenProjection
  branch: string
}): { ok: true; target: FeatureCheckoutTarget } | Extract<ContinueFeatureResult, { kind: 'blocked' }> {
  const children = input.children
  if (!children.ok) return { kind: 'blocked', reason: 'uw-children-unconfirmed', diagnostics: children.diagnostics }
  return {
    ok: true,
    target: children.value.length === 0 ? { kind: 'branch', branch: input.branch } : { kind: 'parent', uw: input.uw },
  }
}

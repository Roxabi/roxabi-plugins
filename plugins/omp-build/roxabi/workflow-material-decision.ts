import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { UwOperationResult } from './uw-contract.ts'

type MaterialContinuation = () => Promise<ContinueFeatureResult>

/** Authenticated own-authority acceptance before normal mandate selection. */
export async function acceptOwnMaterialDecision(
  input: ContinueFeatureInput,
  authority: FeatureAuthority,
  onAccepted: MaterialContinuation,
): Promise<ContinueFeatureResult> {
  const own = authority.context.engine.resolveOwnSpecAuthority(authority.history, authority.parentHistories)
  if (!own.ok)
    return { kind: 'blocked', reason: 'material-decision-authority-unconfirmed', diagnostics: own.diagnostics }
  return acceptMaterialDecision(input, authority.scope, onAccepted)
}

/** Existing assessment decision acceptance, followed only by the supplied lifecycle continuation. */
export async function acceptMaterialDecision(
  input: ContinueFeatureInput,
  scope: FeatureAuthority['scope'],
  onAccepted: MaterialContinuation,
): Promise<ContinueFeatureResult> {
  if (input.uw === undefined) return { kind: 'blocked', reason: 'material-decision-unavailable' }
  const material = await input.uw.acceptMaterial(scope)
  return materialDecisionResult(material, onAccepted)
}

async function materialDecisionResult(
  material: UwOperationResult,
  onAccepted: MaterialContinuation,
): Promise<ContinueFeatureResult> {
  switch (material.status) {
    case 'accepted':
      return onAccepted()
    case 'uncertain':
      return { kind: 'blocked', reason: 'material-decision-uncertain' }
    case 'refused':
      return { kind: 'blocked', reason: 'material-decision-refused', diagnostics: material.diagnostics }
    case 'partial':
      return { kind: 'blocked', reason: 'material-decision-partial', diagnostics: material.diagnostics }
    case 'written':
    case 'created':
      return { kind: 'blocked', reason: 'material-decision-not-accepted' }
  }
}

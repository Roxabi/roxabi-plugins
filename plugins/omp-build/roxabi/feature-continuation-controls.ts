import { resolveFeatureRevocation } from './feature-continuation-admission.ts'
import type { ContinueFeatureInput, ContinueFeatureResult } from './feature-contract.ts'
import type { UwOperationResult } from './uw-contract.ts'

/** An authenticated revocation record is the only durable stop. */
export async function revokeFeatureMandate(input: ContinueFeatureInput): Promise<ContinueFeatureResult> {
  const target = await resolveFeatureRevocation(input)
  if ('kind' in target) return target
  if (input.owned?.() === false) return { kind: 'blocked', reason: 'continuation-owner-revoked' }
  if (input.uw === undefined) return { kind: 'blocked', reason: 'uw-operations-required' }
  const result = await input.uw.abandon(target.scope, target.mandate)
  if (result.status === 'deferred')
    return { kind: 'blocked', reason: 'operator-confirmation-deferred', diagnostics: result.diagnostics }
  return result.status === 'abandoned' ? { kind: 'abandoned', confirmed: true } : failedAbandonment(result)
}

function failedAbandonment(
  result: Exclude<UwOperationResult, { status: 'abandoned' | 'deferred' }>,
): ContinueFeatureResult {
  return {
    kind: 'abandoned',
    confirmed: false,
    failure: { status: result.status, diagnostics: 'diagnostics' in result ? result.diagnostics : [] },
  }
}

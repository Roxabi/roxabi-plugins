import { canonicalValueDigest, ciExactSchema, failedCheckEvidenceDigest } from '../dist/contracts.js'
import type { Result } from '../engine/result.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { UwActionRequest } from './uw-action-contract.ts'
import type { ActionFactSource } from './uw-action-observe.ts'
import { actionFailure } from './uw-action-result.ts'
import type { NonPlanExpansion } from './uw-context-negative-workflow.ts'

/** Re-observe the exact failed CI identity; a changed rollup is not the same attribution slot. */
export async function validateExpandedWorkflowLive(
  source: ActionFactSource,
  request: UwActionRequest,
  origin: NonPlanExpansion,
): Promise<Result<true>> {
  if (origin.slot.action !== 'attribute-ci') return { ok: true, value: true }
  const exact = ciExactSchema.safeParse(origin.slot.exact)
  if (!exact.success || exact.data.candidateGitSHA !== request.code.head)
    return actionFailure('review-input-changed', 'Expanded CI attribution changes its candidate commit')
  const current = await readNativeCiFailureEvidence(
    source.cwd,
    exact.data.scope.repository,
    exact.data.candidateGitSHA,
    exact.data.scope,
    { gh: source.gh, failedCheckEvidenceDigest },
  )
  if (!current.ok) return actionFailure('action-input-missing', `Current CI evidence unavailable: ${current.reason}`)
  if (
    current.evidenceDigest !== exact.data.evidenceDigest ||
    canonicalValueDigest(current.failedChecks) !== canonicalValueDigest(exact.data.failedChecks) ||
    canonicalValueDigest(current.failures) !== canonicalValueDigest(exact.data.failures)
  )
    return actionFailure('review-input-changed', 'Expanded CI attribution changes failed check evidence')
  return { ok: true, value: true }
}

import type { CanonicalRecord, HistoricalReviewAssociation } from '../dist/contracts.js'
import { hashReviewInput } from '../skills/feature/review-input.ts'
import { type ConfirmedReviewSemanticContext, confirmedReviewSemanticContext } from './review-semantic-canon.ts'
import { reviewAcceptedSpecView } from './review-semantic-context.ts'

type ReviewRoot = Extract<CanonicalRecord, { kind: 'review-attempt' }>

export type RecoveryConfigIdentity = {
  productVersion: string
  version: string
  digest: string
  serialized: string
  additionalRequirements: readonly string[]
}

/** Rebuild the capture-time config identity from the historical mandate snapshot. */
export function recoveryConfigIdentityFromMandate(
  mandate: HistoricalReviewAssociation['mandate'],
): RecoveryConfigIdentity | { ok: false; reason: string } {
  const config = mandate.payload.config
  if (
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string'
  ) {
    return { ok: false, reason: 'mandate config identity is malformed' }
  }
  const raw =
    config.effective !== null && typeof config.effective === 'object' && !Array.isArray(config.effective)
      ? Reflect.get(config.effective, 'additionalRequirements')
      : undefined
  const additionalRequirements: string[] = []
  if (raw !== undefined) {
    if (!Array.isArray(raw)) return { ok: false, reason: 'mandate additional requirements are malformed' }
    for (const item of raw) {
      if (typeof item !== 'string' || item.length === 0)
        return { ok: false, reason: 'mandate additional requirements are malformed' }
      additionalRequirements.push(item)
    }
  }
  return {
    productVersion: config.productVersion,
    version: config.version,
    digest: config.digest,
    additionalRequirements,
    serialized: JSON.stringify({
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      additionalRequirements,
    }),
  }
}

/** Project a proved historical association into the shared bound semantic slot. */
export function boundSemanticFromHistoricalAssociation(
  association: HistoricalReviewAssociation,
): ConfirmedReviewSemanticContext | { ok: false; reason: string } {
  const config = recoveryConfigIdentityFromMandate(association.mandate)
  if ('ok' in config) return config
  const projected = confirmedReviewSemanticContext({
    mode: 'bound',
    binding: {
      recordId: association.binding.recordId,
      scope: { repository: association.binding.repository, target: association.binding.target },
    },
    acceptedSpec: reviewAcceptedSpecView(association.accepted),
    additionalRequirements: [...config.additionalRequirements],
    effectiveConfig: {
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      serialized: config.serialized,
    },
  })
  if ('ok' in projected) return { ok: false, reason: projected.reason }
  return projected
}

/** Reconstruct I4 from the interrupted root snapshot and a confirmed bound semantic. */
export function reconstructHistoricalReviewInput(input: {
  root: ReviewRoot
  semantic: ConfirmedReviewSemanticContext
}): string | null {
  const payload = input.root.payload
  if (
    !('subject' in payload) ||
    payload.subject.kind !== 'pull-request' ||
    !('inputSnapshot' in payload) ||
    payload.inputSnapshot === null ||
    payload.inputSnapshot.body === null
  )
    return null
  const match = input.root.target.match(/#([1-9]\d*)$/)
  if (match === null || input.root.target !== `${input.root.repository}#${match[1]}`) return null
  return hashReviewInput(
    input.root.repository,
    { pr: Number(match[1]), candidate: payload.candidateGitSHA },
    payload.inputSnapshot.body,
    input.semantic,
  )
}

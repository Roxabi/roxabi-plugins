import type { Policy, SpecRow } from '../dist/contracts.js'
import type { ReviewTier } from '../skills/dev-review/roster-contract'
import type { ReviewSemanticContext } from './review-semantic-context'

export type ReviewSemanticAssets = {
  evidencePolicy: string
  rootCauses: string
  classes: string
  smells: string
  blindSpots: string
}

export type SpecDisplay = {
  source: 'tracker-issue' | 'absent'
  issue: number | null
  body: string | null
  rows: readonly SpecRow[]
}

export type ReviewPrompts = {
  spec: string
  panel: string
  synthesis: string
  /** A display-only judgment pass. It is not a panel input or a finding source. */
  standards: { kind: 'display-only'; guidance: string }
}

export function buildReviewPrompts(input: {
  tier: ReviewTier
  policy: Policy
  spec: SpecDisplay
  semanticContext: ReviewSemanticContext
  /** Retained for caller compatibility. Never copied into task text. */
  semanticCanon: string
  assets: ReviewSemanticAssets
}): ReviewPrompts {
  if (typeof input.semanticCanon !== 'string' || input.spec.source.length === 0)
    throw new Error('review-canon-unobserved')
  if (input.semanticContext.mode !== 'standalone' && input.semanticContext.mode !== 'bound')
    throw new Error('review-semantic-unobserved')
  const policyId = input.policy.version === 'baseline' ? 'baseline' : `evidence-v1:${input.policy.acceptanceRef}`
  return {
    spec: `Judge specification obligations named by the index. Policy ${policyId}, tier ${input.tier}. Return one canonical criterion verdict per obligation and any exclusion claims. Do not read code, run a shell, or invent a satisfied row.`,
    panel: `Review only the assigned chunk named by the index. Policy ${policyId}, tier ${input.tier}. Return structured findings. Do not publish or rewrite retained evidence.`,
    synthesis: `Synthesize only the dossier named by the index. Policy ${policyId}. Reference authentic criterion verdict refs from the spec contribution. Do not read code, run a shell, invent a satisfied row, or discard retained originals.`,
    standards: {
      kind: 'display-only',
      guidance: input.assets.smells,
    },
  }
}

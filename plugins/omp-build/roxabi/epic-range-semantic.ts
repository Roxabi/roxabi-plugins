import { proofSemanticContext, reviewSemanticCanon } from '../skills/feature/proof-context'
import { withRoxabiGitHubPolicy } from './github-policy'
import type { Gh } from './review-input-contract'
import type { ReviewSemanticContext } from './review-semantic-context'
import { additionalRequirementsOf } from './workflow-overrides'

export type AcceptedEpicSemantic = {
  semanticContext: ReviewSemanticContext
  semanticCanon: string
  spec: { reference: string; body: string; digest: string; lastEditedAt: string | null }
}

export type LiveEpicSpec = {
  reference: string
  number: number
  body: string
  digest: string
  lastEditedAt: string | null
  labels: readonly string[]
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function epicSemanticCanon(semanticContext: ReviewSemanticContext): string {
  const projected = proofSemanticContext(semanticContext)
  if ('ok' in projected) throw new Error(`${projected.reason}: ${projected.error}`)
  return reviewSemanticCanon(projected)
}

/**
 * Uses EngineRecords resolveAcceptedSpec only — no payload.spec soft fallback.
 * Absent or incomplete mandate returns null; missing runtime APIs are a clean-cutover refusal.
 */
export async function acceptedEpicSemantic(
  cwd: string,
  repository: string,
  epic: number,
  live: LiveEpicSpec,
  gh: Gh,
): Promise<AcceptedEpicSemantic | null> {
  const contracts = await import('../dist/contracts.js')
  if (
    typeof contracts.githubScope !== 'function' ||
    typeof contracts.specDigest !== 'function' ||
    typeof contracts.readComposedWorkflowHistory !== 'function' ||
    typeof contracts.selectApplicableMandate !== 'function' ||
    typeof contracts.resolveAcceptedSpec !== 'function'
  ) {
    return null
  }

  let composed: Awaited<ReturnType<typeof contracts.readComposedWorkflowHistory>>
  try {
    composed = await contracts.readComposedWorkflowHistory(
      [contracts.githubScope(repository, epic)],
      withRoxabiGitHubPolicy({ cwd, gh }),
    )
  } catch {
    return null
  }

  if (!composed.ok) return null
  const history = composed.histories[0]
  if (history === undefined) return null
  const parents = composed.histories.slice(1)
  const selected = contracts.selectApplicableMandate(history, parents)
  if (selected.status !== 'applicable') return null

  const mandate = selected.mandate
  const accepted = contracts.resolveAcceptedSpec(mandate, [history, ...parents])
  if (!accepted.ok) return null

  const config = isRecord(mandate.payload) && isRecord(mandate.payload.config) ? mandate.payload.config : null
  if (
    config === null ||
    typeof config.productVersion !== 'string' ||
    typeof config.version !== 'string' ||
    typeof config.digest !== 'string'
  ) {
    return null
  }

  const requirements = additionalRequirementsOf('effective' in config ? config.effective : null)
  const effectiveSerialized = JSON.stringify({
    productVersion: config.productVersion,
    version: config.version,
    digest: config.digest,
    additionalRequirements: requirements,
  })
  const scope = contracts.githubScope(repository, epic)
  const semanticContext: ReviewSemanticContext = {
    mode: 'bound',
    binding: { recordId: mandate.recordId, scope },
    acceptedSpec: {
      reference: accepted.spec.reference,
      body: accepted.spec.body,
      digest: accepted.spec.digest,
      lastEditedAt: accepted.spec.lastEditedAt,
      chain: accepted.spec.chain,
      sourceRefs: accepted.spec.sourceRefs,
    },
    currentSpec: {
      reference: live.reference,
      number: live.number,
      body: live.body,
      digest: contracts.specDigest(live.body),
      lastEditedAt: live.lastEditedAt,
      labels: live.labels,
    },
    effectiveConfig: {
      productVersion: config.productVersion,
      version: config.version,
      digest: config.digest,
      serialized: effectiveSerialized,
    },
    additionalRequirements: requirements,
  }

  return {
    semanticContext,
    semanticCanon: epicSemanticCanon(semanticContext),
    spec: {
      reference: accepted.spec.reference,
      body: accepted.spec.body,
      digest: accepted.spec.digest,
      lastEditedAt: accepted.spec.lastEditedAt,
    },
  }
}

import { createHash } from 'node:crypto'
import { isMap, type Refusal, refuse } from '../skills/feature/review-base'

export type ConfirmedReviewSemanticContext =
  | {
      mode: 'bound'
      bindingId: string
      scope: { repository: string; target: string }
      acceptedSpec: { reference: string; body: string; digest: string }
      /** Mandate, editorial, and accept-material provenance. Not pause/resume/control. */
      chain: readonly unknown[]
      /** Mandate ref plus applied assessment/acceptance refs. Identity only, not action rights. */
      sourceRefs: readonly unknown[]
      requirements: readonly string[]
      config: { productVersion: string; version: string; digest: string; serialized: string }
    }
  | {
      mode: 'standalone'
      /** Explicit discovered Spec. Null is a complete no-tracker review, not a fallback. */
      discoveredSpec: { reference: string; body: string; digest: string } | null
    }

function semanticSha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function semanticScopeOf(value: unknown): { repository: string; target: string } | null {
  if (!isMap(value) || typeof value.repository !== 'string' || typeof value.target !== 'string') return null
  if (value.repository.length === 0 || value.target.length === 0) return null
  return { repository: value.repository, target: value.target }
}

function semanticSpecBytes(
  value: unknown,
  label: string,
): { reference: string; body: string; digest: string } | Refusal {
  if (
    !isMap(value) ||
    typeof value.body !== 'string' ||
    typeof value.reference !== 'string' ||
    value.reference.length === 0
  ) {
    return refuse('unreadable', `${label} has no reference and body`)
  }
  if (typeof value.digest !== 'string' || value.digest.length === 0)
    return refuse('unreadable', `${label} digest is missing`)
  if (value.digest !== semanticSha256(value.body))
    return refuse('unreadable', `${label} digest does not match its body`)
  return { reference: value.reference, body: value.body, digest: value.digest }
}

function semanticAcceptanceRef(
  item: Record<string, unknown>,
  scope: { repository: string; target: string },
): unknown[] | Refusal {
  if (typeof item.specDigest !== 'string' || !isMap(item.assessment))
    return refuse('unreadable', 'accept-material chain ref has no assessment')
  const assessment = semanticScopeOf(item.assessment.scope)
  if (!assessment || typeof item.assessment.recordId !== 'string' || typeof item.assessment.kind !== 'string')
    return refuse('unreadable', 'accept-material assessment ref is unreadable')
  return [
    'accept-material',
    item.recordId,
    scope.repository,
    scope.target,
    item.specDigest,
    assessment.repository,
    assessment.target,
    item.assessment.recordId,
    item.assessment.kind,
  ]
}

function semanticChainRef(item: unknown): unknown[] | Refusal {
  if (!isMap(item) || typeof item.kind !== 'string' || typeof item.recordId !== 'string' || item.recordId.length === 0)
    return refuse('unreadable', 'accepted Spec chain ref is unreadable')
  const scope = semanticScopeOf(item.scope)
  if (!scope) return refuse('unreadable', 'accepted Spec chain ref has no scope')
  if (item.kind === 'mandate') {
    if (typeof item.specDigest !== 'string') return refuse('unreadable', 'mandate chain ref has no spec digest')
    return ['mandate', item.recordId, scope.repository, scope.target, item.specDigest]
  }
  if (item.kind === 'editorial') {
    if (typeof item.acceptedDigest !== 'string' || typeof item.currentDigest !== 'string')
      return refuse('unreadable', 'editorial chain ref has no digests')
    return ['editorial', item.recordId, scope.repository, scope.target, item.acceptedDigest, item.currentDigest]
  }
  if (item.kind === 'accept-material') return semanticAcceptanceRef(item, scope)
  return refuse('unreadable', `accepted Spec chain ref kind ${item.kind} is not a spec acceptance`)
}

function semanticChainCanon(chain: unknown): unknown[] | Refusal {
  if (!Array.isArray(chain) || chain.length === 0) return refuse('unreadable', 'accepted Spec chain is missing')
  const out: unknown[] = []
  for (const item of chain) {
    const ref = semanticChainRef(item)
    if ('ok' in ref) return ref
    out.push(ref)
  }
  return out
}

function semanticSourceRefsCanon(refs: unknown): unknown[] | Refusal {
  if (!Array.isArray(refs) || refs.length === 0) return refuse('unreadable', 'accepted Spec source refs are missing')
  const out: unknown[] = []
  for (const item of refs) {
    if (
      !isMap(item) ||
      typeof item.recordId !== 'string' ||
      item.recordId.length === 0 ||
      typeof item.kind !== 'string' ||
      item.kind.length === 0
    ) {
      return refuse('unreadable', 'accepted Spec source ref is unreadable')
    }
    if (Object.keys(item).some((key) => key !== 'scope' && key !== 'recordId' && key !== 'kind'))
      return refuse('unreadable', 'accepted Spec source ref is not an external record identity')
    const scope = semanticScopeOf(item.scope)
    if (!scope) return refuse('unreadable', 'accepted Spec source ref has no scope')
    out.push([scope.repository, scope.target, item.recordId, item.kind])
  }
  return out
}

function semanticConfigOf(
  value: Record<string, unknown>,
): { productVersion: string; version: string; digest: string; serialized: string } | Refusal {
  const raw = isMap(value.effectiveConfig)
    ? value.effectiveConfig
    : isMap(value.configIdentity)
      ? value.configIdentity
      : null
  if (
    !raw ||
    typeof raw.productVersion !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.digest !== 'string' ||
    typeof raw.serialized !== 'string'
  ) {
    return refuse('unreadable', 'bound review config identity is missing')
  }
  return { productVersion: raw.productVersion, version: raw.version, digest: raw.digest, serialized: raw.serialized }
}

function standaloneConfirmedContext(value: Record<string, unknown>): ConfirmedReviewSemanticContext | Refusal {
  const partialBinding =
    value.binding !== null ||
    value.acceptedSpec !== null ||
    (value.effectiveConfig !== null && value.effectiveConfig !== undefined) ||
    (value.configIdentity !== null && value.configIdentity !== undefined)
  if (partialBinding) return refuse('unreadable', 'a partial workflow binding is not a standalone review')
  if (value.currentSpec === null) return { mode: 'standalone', discoveredSpec: null }
  const discovered = semanticSpecBytes(value.currentSpec, 'discovered Spec')
  if ('ok' in discovered) return discovered
  return { mode: 'standalone', discoveredSpec: discovered }
}

function semanticBindingOf(
  value: Record<string, unknown>,
): { id: string; scope: { repository: string; target: string } } | Refusal {
  if (!isMap(value.binding) || typeof value.binding.recordId !== 'string' || value.binding.recordId.length === 0)
    return refuse('unreadable', 'bound review has no binding record')
  const scope = semanticScopeOf(value.binding.scope)
  if (!scope) return refuse('unreadable', 'bound review has no scope')
  return { id: value.binding.recordId, scope }
}

function semanticRequirementsOf(value: Record<string, unknown>): string[] | Refusal {
  if (
    !Array.isArray(value.additionalRequirements) ||
    value.additionalRequirements.some((item) => typeof item !== 'string')
  )
    return refuse('unreadable', 'bound review requirements are not strings')
  return value.additionalRequirements
}

function boundConfirmedContext(value: Record<string, unknown>): ConfirmedReviewSemanticContext | Refusal {
  const binding = semanticBindingOf(value)
  if ('ok' in binding) return binding
  const accepted = semanticSpecBytes(value.acceptedSpec, 'accepted Spec')
  if ('ok' in accepted) return accepted
  const acceptedRecord = isMap(value.acceptedSpec) ? value.acceptedSpec : null
  const chain = semanticChainCanon(acceptedRecord?.chain)
  if ('ok' in chain) return chain
  const sourceRefs = semanticSourceRefsCanon(acceptedRecord?.sourceRefs)
  if ('ok' in sourceRefs) return sourceRefs
  const requirements = semanticRequirementsOf(value)
  if ('ok' in requirements) return requirements
  const config = semanticConfigOf(value)
  if ('ok' in config) return config
  return {
    mode: 'bound',
    bindingId: binding.id,
    scope: binding.scope,
    acceptedSpec: accepted,
    chain,
    sourceRefs,
    requirements,
    config,
  }
}

/** Project the shared resolver value. A partial binding is a refusal, never standalone. */
export function confirmedReviewSemanticContext(value: unknown): ConfirmedReviewSemanticContext | Refusal {
  if (!isMap(value) || (value.mode !== 'bound' && value.mode !== 'standalone'))
    return refuse('unreadable', 'review semantic context mode is missing')
  return value.mode === 'standalone' ? standaloneConfirmedContext(value) : boundConfirmedContext(value)
}

export type ReviewSemanticCanon = string

export function reviewSemanticCanon(semantic: ConfirmedReviewSemanticContext): ReviewSemanticCanon {
  if (semantic.mode === 'standalone') {
    return JSON.stringify(
      semantic.discoveredSpec === null
        ? ['standalone', null]
        : [
            'standalone',
            semantic.discoveredSpec.reference,
            semantic.discoveredSpec.body,
            semantic.discoveredSpec.digest,
          ],
    )
  }
  return JSON.stringify([
    'bound',
    semantic.bindingId,
    semantic.scope.repository,
    semantic.scope.target,
    semantic.acceptedSpec.reference,
    semantic.acceptedSpec.body,
    semantic.acceptedSpec.digest,
    semantic.chain,
    semantic.sourceRefs,
    [...semantic.requirements],
    semantic.config.productVersion,
    semantic.config.version,
    semantic.config.digest,
    semantic.config.serialized,
  ])
}

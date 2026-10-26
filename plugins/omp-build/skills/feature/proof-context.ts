import { createHash } from 'node:crypto'
import { type Gh, type Git, type Refusal, refuse } from './proof-base'
import type { CandidateFacts } from './proof-candidate-contract'
import type { SelectedRecord } from './proof-review-contract'
export type Deps = {
  gh: Gh
  git: Git /** Test injection. Production omits this and calls the shared resolver. */
  automationLogin?: string
  semantic?: ProofSemanticContext
}
export type Read = { repository: string }
export type PrBody = { body: string; lastEditedAt: string | null }
export type ReviewSnapshot = {
  ok: true
  input: string | null
  body: PrBody | null
  facts: CandidateFacts
  read: Read | null
  semctx: SelectedRecord | null
  assertledger: SelectedRecord | null
}

/** Confirmed semantic context. Proof hashes this; it does not resolve bindings. */
export type ProofSemanticContext =
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function scopeOf(value: unknown): { repository: string; target: string } | null {
  if (!isRecord(value) || typeof value.repository !== 'string' || typeof value.target !== 'string') return null
  if (value.repository.length === 0 || value.target.length === 0) return null
  return { repository: value.repository, target: value.target }
}

function specBytes(value: unknown, label: string): { reference: string; body: string; digest: string } | Refusal {
  if (
    !isRecord(value) ||
    typeof value.body !== 'string' ||
    typeof value.reference !== 'string' ||
    value.reference.length === 0
  ) {
    return refuse('candidate', 'unreadable', `${label} has no reference and body`)
  }
  if (typeof value.digest !== 'string' || value.digest.length === 0)
    return refuse('candidate', 'unreadable', `${label} digest is missing`)
  if (value.digest !== sha256(value.body))
    return refuse('candidate', 'unreadable', `${label} digest does not match its body`)
  return { reference: value.reference, body: value.body, digest: value.digest }
}
function acceptanceRef(
  item: Record<string, unknown>,
  scope: { repository: string; target: string },
): unknown[] | Refusal {
  if (typeof item.specDigest !== 'string' || !isRecord(item.assessment))
    return refuse('candidate', 'unreadable', 'accept-material chain ref has no assessment')
  const assessment = scopeOf(item.assessment.scope)
  if (!assessment || typeof item.assessment.recordId !== 'string' || typeof item.assessment.kind !== 'string')
    return refuse('candidate', 'unreadable', 'accept-material assessment ref is unreadable')
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
function chainRef(item: unknown): unknown[] | Refusal {
  if (
    !isRecord(item) ||
    typeof item.kind !== 'string' ||
    typeof item.recordId !== 'string' ||
    item.recordId.length === 0
  )
    return refuse('candidate', 'unreadable', 'accepted Spec chain ref is unreadable')
  const scope = scopeOf(item.scope)
  if (!scope) return refuse('candidate', 'unreadable', 'accepted Spec chain ref has no scope')
  if (item.kind === 'mandate') {
    if (typeof item.specDigest !== 'string')
      return refuse('candidate', 'unreadable', 'mandate chain ref has no spec digest')
    return ['mandate', item.recordId, scope.repository, scope.target, item.specDigest]
  }
  if (item.kind === 'editorial') {
    if (typeof item.acceptedDigest !== 'string' || typeof item.currentDigest !== 'string')
      return refuse('candidate', 'unreadable', 'editorial chain ref has no digests')
    return ['editorial', item.recordId, scope.repository, scope.target, item.acceptedDigest, item.currentDigest]
  }
  if (item.kind === 'accept-material') return acceptanceRef(item, scope)
  return refuse('candidate', 'unreadable', `accepted Spec chain ref kind ${item.kind} is not a spec acceptance`)
}
function chainCanon(chain: unknown): unknown[] | Refusal {
  if (!Array.isArray(chain) || chain.length === 0)
    return refuse('candidate', 'unreadable', 'accepted Spec chain is missing')
  const out: unknown[] = []
  for (const item of chain) {
    const ref = chainRef(item)
    if ('ok' in ref) return ref
    out.push(ref)
  }
  return out
}

/** External record identity only. These refs are not permissions or action rights. */
function sourceRefsCanon(refs: unknown): unknown[] | Refusal {
  if (!Array.isArray(refs) || refs.length === 0)
    return refuse('candidate', 'unreadable', 'accepted Spec source refs are missing')
  const out: unknown[] = []
  for (const item of refs) {
    if (
      !isRecord(item) ||
      typeof item.recordId !== 'string' ||
      item.recordId.length === 0 ||
      typeof item.kind !== 'string' ||
      item.kind.length === 0
    ) {
      return refuse('candidate', 'unreadable', 'accepted Spec source ref is unreadable')
    }
    if (Object.keys(item).some((key) => key !== 'scope' && key !== 'recordId' && key !== 'kind'))
      return refuse('candidate', 'unreadable', 'accepted Spec source ref is not an external record identity')
    const scope = scopeOf(item.scope)
    if (!scope) return refuse('candidate', 'unreadable', 'accepted Spec source ref has no scope')
    out.push([scope.repository, scope.target, item.recordId, item.kind])
  }
  return out
}

function configOf(
  value: Record<string, unknown>,
): { productVersion: string; version: string; digest: string; serialized: string } | Refusal {
  const raw = isRecord(value.effectiveConfig)
    ? value.effectiveConfig
    : isRecord(value.configIdentity)
      ? value.configIdentity
      : null
  if (
    !raw ||
    typeof raw.productVersion !== 'string' ||
    typeof raw.version !== 'string' ||
    typeof raw.digest !== 'string' ||
    typeof raw.serialized !== 'string'
  ) {
    return refuse('candidate', 'unreadable', 'bound review config identity is missing')
  }
  return {
    productVersion: raw.productVersion,
    version: raw.version,
    digest: raw.digest,
    serialized: raw.serialized,
  }
}

function standaloneContext(value: Record<string, unknown>): ProofSemanticContext | Refusal {
  const partialBinding =
    value.binding !== null ||
    value.acceptedSpec !== null ||
    (value.effectiveConfig !== null && value.effectiveConfig !== undefined) ||
    (value.configIdentity !== null && value.configIdentity !== undefined)
  if (partialBinding) return refuse('candidate', 'unreadable', 'a partial workflow binding is not a standalone review')
  if (value.currentSpec === null) return { mode: 'standalone', discoveredSpec: null }
  const discovered = specBytes(value.currentSpec, 'discovered Spec')
  if ('ok' in discovered) return discovered
  return { mode: 'standalone', discoveredSpec: discovered }
}

function bindingOf(
  value: Record<string, unknown>,
): { id: string; scope: { repository: string; target: string } } | Refusal {
  if (!isRecord(value.binding) || typeof value.binding.recordId !== 'string' || value.binding.recordId.length === 0)
    return refuse('candidate', 'unreadable', 'bound review has no binding record')
  const scope = scopeOf(value.binding.scope)
  if (!scope) return refuse('candidate', 'unreadable', 'bound review has no scope')
  return { id: value.binding.recordId, scope }
}

function requirementsOf(value: Record<string, unknown>): string[] | Refusal {
  if (
    !Array.isArray(value.additionalRequirements) ||
    value.additionalRequirements.some((item) => typeof item !== 'string')
  )
    return refuse('candidate', 'unreadable', 'bound review requirements are not strings')
  return value.additionalRequirements
}

function boundContext(value: Record<string, unknown>): ProofSemanticContext | Refusal {
  const binding = bindingOf(value)
  if ('ok' in binding) return binding
  const accepted = specBytes(value.acceptedSpec, 'accepted Spec')
  if ('ok' in accepted) return accepted
  const acceptedRecord = isRecord(value.acceptedSpec) ? value.acceptedSpec : null
  const chain = chainCanon(acceptedRecord?.chain)
  if ('ok' in chain) return chain
  const sourceRefs = sourceRefsCanon(acceptedRecord?.sourceRefs)
  if ('ok' in sourceRefs) return sourceRefs
  const requirements = requirementsOf(value)
  if ('ok' in requirements) return requirements
  const config = configOf(value)
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
export function proofSemanticContext(value: unknown): ProofSemanticContext | Refusal {
  if (!isRecord(value) || (value.mode !== 'bound' && value.mode !== 'standalone'))
    return refuse('candidate', 'unreadable', 'review semantic context mode is missing')
  return value.mode === 'standalone' ? standaloneContext(value) : boundContext(value)
}

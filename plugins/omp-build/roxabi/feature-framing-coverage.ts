import type { z } from 'zod'
import {
  acceptedMetadataOwner,
  canonicalValueDigest,
  framingAcceptedStateDigest,
  readFramingCoverageIntent,
  sameScope,
} from '../dist/contracts.js'
import type { Scope } from '../engine/record-values.ts'
import type { boundFramingCoverageIntentSchema } from '../engine/uw-framing-receipt-schema.ts'
import type { ParentCoverage } from '../engine/workflow-mandate-schema.ts'
import type { ContinueFeatureResult, ParentCoverageRequest } from './feature-contract.ts'
import { initialCoverageBasis, selectInitialCoverage } from './feature-initial-coverage.ts'
import type { UwRead } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'

export type BoundFramingCoverageIntent = z.infer<typeof boundFramingCoverageIntentSchema>
/** Discover the target's approved intent from its authenticated complete aggregate result. */
export function discoverFramingCoverageIntent(
  uw: Scope,
  read: UwRead,
): { intent: BoundFramingCoverageIntent | null } | ContinueFeatureResult {
  if (!sameScope(uw, read.uw)) return { kind: 'blocked', reason: 'parent-coverage-intent-changed' }
  const membership = read.admission.aggregate
  if (membership.status !== 'complete') return { kind: 'blocked', reason: 'framing-aggregate-incomplete' }
  if (read.observation.status !== 'complete') return { kind: 'blocked', reason: 'framing-aggregate-unreadable' }
  const result = readFramingCoverageIntent({ uw, histories: read.observation.histories, membership })
  return result.ok
    ? { intent: result.value }
    : {
        kind: 'blocked',
        reason: result.diagnostics[0]?.code ?? 'framing-aggregate-unreadable',
        diagnostics: result.diagnostics,
      }
}

/** Materialize one approved Parent's coverage only against its current complete cut. */
export async function resolveFramingCoverageIntent(input: {
  uw: Scope
  read: UwRead
  intent: BoundFramingCoverageIntent
}): Promise<{ coverage: ParentCoverage; basis: ParentCoverageRequest } | ContinueFeatureResult> {
  const { uw, read, intent } = input
  if (!matchesIntentMembership(uw, read, intent)) return { kind: 'blocked', reason: 'parent-coverage-intent-changed' }
  const recorded = discoverFramingCoverageIntent(uw, read)
  if ('kind' in recorded) return recorded
  if (recorded.intent === null || canonicalValueDigest(recorded.intent) !== canonicalValueDigest(intent))
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed' }
  const facts = await readCurrentFramingFacts({ uw, read })
  if (!facts.ok) return { kind: 'blocked', reason: 'uw-current-facts-refused', diagnostics: facts.diagnostics }
  const basis = initialCoverageBasis(uw, facts.value.currentSpec)
  if (
    basis.parent.version !== intent.parentVersion ||
    canonicalValueDigest(basis.criteria) !== canonicalValueDigest(intent.criteria) ||
    canonicalValueDigest(basis.children) !== canonicalValueDigest(intent.children) ||
    basis.inheritedOwnSpecRefs.length !== intent.ancestors.length
  )
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed', coverageRequest: basis }
  if (!(await matchesIntentAncestors(read, basis, intent)))
    return { kind: 'blocked', reason: 'parent-coverage-intent-changed' }
  const selected = selectInitialCoverage(uw, read, facts.value.currentSpec, intent.coverage, basis)
  if ('kind' in selected) return selected
  if (selected.coverage === null) return { kind: 'blocked', reason: 'parent-coverage-intent-invalid' }
  return { coverage: selected.coverage, basis }
}

function matchesIntentMembership(uw: Scope, read: UwRead, intent: BoundFramingCoverageIntent): boolean {
  const membership = read.admission.aggregate
  return (
    membership.status === 'complete' &&
    canonicalValueDigest(membership.intent) === canonicalValueDigest(intent.aggregateIntent) &&
    canonicalValueDigest(membership.result) === canonicalValueDigest(intent.aggregateResult) &&
    sameScope(uw, intent.parent) &&
    sameScope(uw, read.uw) &&
    read.observation.status === 'complete'
  )
}

async function matchesIntentAncestors(
  read: UwRead,
  basis: ParentCoverageRequest,
  intent: BoundFramingCoverageIntent,
): Promise<boolean> {
  if (read.observation.status !== 'complete' || read.observedReader === undefined) return intent.ancestors.length === 0
  for (const [index, expected] of intent.ancestors.entries()) {
    const actualRef = basis.inheritedOwnSpecRefs[index]
    if (!actualRef) return false
    const scope = expected.kind === 'accepted' ? expected.own.uw : expected.scope
    if (!sameScope(actualRef.uw, scope)) return false
    const ancestor = await read.observedReader.readUw(scope)
    if (
      ancestor.observation !== read.observation ||
      ancestor.accepted.status !== 'accepted' ||
      canonicalValueDigest(ancestor.accepted.value.ref) !== canonicalValueDigest(actualRef)
    )
      return false
    if (!matchesAcceptedAncestor(expected, ancestor.accepted.value, actualRef, read.observation.histories)) return false
  }
  return true
}

function matchesAcceptedAncestor(
  expected: BoundFramingCoverageIntent['ancestors'][number],
  accepted: Extract<UwRead['accepted'], { status: 'accepted' }>['value'],
  actualRef: ParentCoverageRequest['inheritedOwnSpecRefs'][number],
  histories: Extract<UwRead['observation'], { status: 'complete' }>['histories'],
): boolean {
  if (expected.kind === 'accepted') {
    const step = accepted.chain.at(-1)
    if (!step) return false
    const metadata = acceptedMetadataOwner(step, histories)
    return (
      metadata.ok &&
      canonicalValueDigest(expected.own) === canonicalValueDigest(actualRef) &&
      canonicalValueDigest(expected.metadata) === canonicalValueDigest(metadata.value.record)
    )
  }
  return (
    accepted.ref.version === expected.specVersion &&
    accepted.tier === expected.tier &&
    framingAcceptedStateDigest({
      spec: accepted.snapshot.spec,
      tier: accepted.tier,
      children: accepted.children,
      coverage: accepted.coverage,
    }) === expected.acceptedStateDigest
  )
}

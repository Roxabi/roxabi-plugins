import { assessCauseHolds, assessUwAdmission, canonicalValueDigest, sameScope } from '../dist/contracts.js'
import type { AcceptedOwnSpec } from '../engine/workflow-accepted-spec-types.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { FeatureAuthority } from './feature-continuation-admission.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { UwRead, UwReadPort } from './uw-contract.ts'
import { readCurrentFramingFacts } from './uw-current-facts.ts'

type FreshFramingFacts = Extract<Awaited<ReturnType<typeof readCurrentFramingFacts>>, { ok: true }>['value']
export type LeafOwnSpec = Pick<MandateRecord['payload'], 'ownSpec' | 'tier' | 'inheritedOwnSpecRefs'>

export async function freshOwnSpec(
  scope: FeatureAuthority['scope'],
  read: UwRead | null,
  reader: UwReadPort | undefined,
): Promise<LeafOwnSpec | ContinueFeatureResult> {
  if (read === null || reader === undefined) return { kind: 'blocked', reason: 'uw-read-required' }
  const facts = await freshFraming(scope, read)
  if ('kind' in facts) return facts
  if (facts.currentSpec.children.length > 0) return { kind: 'blocked', reason: 'parent-delivery-suspended' }
  return leafOwnSpec(scope, facts)
}

/** Historical framing is a factual operand; current delivery acceptance remains refused. */
export async function freshSuccessorOwnSpec(
  scope: FeatureAuthority['scope'],
  read: UwRead,
  historical: AcceptedOwnSpec,
): Promise<LeafOwnSpec | ContinueFeatureResult> {
  const facts = await freshFraming(scope, read)
  if ('kind' in facts) return facts
  const holds = assessCauseHolds({
    uw: scope,
    waits: read.completion.waits,
    dependencies: read.completion.dependencies,
  })
  if (holds.length) return { kind: 'blocked', reason: 'successor-cause-held', diagnostics: holds }
  const { currentSpec } = facts
  if (currentSpec.children.length > 0 || historical.children.length > 0)
    return { kind: 'blocked', reason: 'parent-delivery-suspended' }
  if (
    !sameScope(historical.ref.uw, scope) ||
    canonicalValueDigest(currentSpec.inheritedOwnSpecRefs) !== canonicalValueDigest(historical.inheritedOwnSpecRefs)
  )
    return { kind: 'blocked', reason: 'successor-commitments-changed' }
  return leafOwnSpec(scope, facts)
}

function leafOwnSpec(scope: FeatureAuthority['scope'], facts: FreshFramingFacts): LeafOwnSpec {
  const { currentSpec, identityAllocations } = facts
  return {
    ownSpec: {
      uw: scope,
      version: currentSpec.snapshot.spec.version,
      snapshot: currentSpec.snapshot,
      identityAllocations,
    },
    tier: currentSpec.tier,
    inheritedOwnSpecRefs: currentSpec.inheritedOwnSpecRefs,
  }
}

async function freshFraming(
  scope: FeatureAuthority['scope'],
  read: UwRead,
): Promise<FreshFramingFacts | ContinueFeatureResult> {
  if (read.admission.aggregate.status === 'held')
    return { kind: 'blocked', reason: read.admission.aggregate.code, diagnostics: read.admission.aggregate.diagnostics }
  if (!read.identity.ok)
    return { kind: 'blocked', reason: 'uw-identities-unconfirmed', diagnostics: read.identity.diagnostics }
  const initial = assessUwAdmission({
    uw: scope,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    histories: read.histories,
    catalogues: read.catalogues,
    completion: read.completion,
    phase: 'initial-selection',
  })
  if (!initial.deliverable.ok)
    return { kind: 'blocked', reason: 'uw-initial-admission-refused', diagnostics: initial.deliverable.diagnostics }
  const facts = await readCurrentFramingFacts({ uw: scope, read })
  return facts.ok
    ? facts.value
    : { kind: 'blocked', reason: 'uw-current-facts-refused', diagnostics: facts.diagnostics }
}

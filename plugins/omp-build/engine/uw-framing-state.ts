import { canonicalValueDigest } from './canonical-value.ts'
import type { UwCompletionObservation } from './uw-completion-types.ts'
import { scopeKey } from './uw-graph.ts'
import type { Spec, UwTier } from './uw-spec-schema.ts'
import type { AcceptedChildCommitment, ParentCoverage } from './workflow-mandate-schema.ts'

/** Approved own state; inherited authority is checked separately against the sealed ancestor vector. */
export function framingAcceptedStateDigest(input: {
  spec: Spec
  tier: UwTier
  children: readonly AcceptedChildCommitment[]
  coverage: ParentCoverage | null
}): string {
  return canonicalValueDigest({
    spec: input.spec,
    tier: input.tier,
    children: input.children.map(({ scope, specVersion, tier, snapshot }) => ({
      scope,
      specVersion,
      tier,
      spec: snapshot.spec,
    })),
    coverage: input.coverage,
  })
}

/** Stable digest of a complete observed cut; observation wall-clock is not a native fact. */
export function framingObservationDigest(
  observation: Extract<UwCompletionObservation, { status: 'complete' }>,
): string {
  return canonicalValueDigest({
    root: observation.root,
    nodes: [...observation.graph.nodes].sort((a, b) => scopeKey(a.uw).localeCompare(scopeKey(b.uw))),
    histories: [...observation.histories].sort((a, b) =>
      scopeKey(a.source.scope).localeCompare(scopeKey(b.source.scope)),
    ),
    catalogues: observation.catalogues,
    delivery: [...observation.delivery].sort((a, b) => scopeKey(a.uw).localeCompare(scopeKey(b.uw))),
  })
}

import type { ChildFacts } from './epic-types'

function hasCompleteAllocations(
  snapshot: { spec: { criteria: readonly { id: string }[]; invariants: readonly { id: string }[] } },
  allocations: readonly { id: string; allocationRef: { recordId: string } }[],
): boolean {
  const ids = [...snapshot.spec.criteria, ...snapshot.spec.invariants].map((item) => item.id)
  return (
    ids.length > 0 &&
    ids.every((id) =>
      allocations.some((allocation) => allocation.id === id && allocation.allocationRef.recordId !== ''),
    )
  )
}

/** An accepted own UW is required only by delivery transitions. */
export function hasAcceptedOwnUw(child: ChildFacts): boolean {
  const own = child.ownUw
  return (
    own.status === 'accepted' &&
    own.graphComplete &&
    own.accepted.children.length === 0 &&
    hasCompleteAllocations(own.accepted.snapshot, own.identityAllocations)
  )
}

/** Initial epic selection admits an observed, framed first-child UW without inventing acceptance. */
export function hasFramedOwnUw(child: ChildFacts): boolean {
  const own = child.ownUw
  return own.status === 'accepted'
    ? own.graphComplete &&
        own.accepted.children.length === 0 &&
        hasCompleteAllocations(own.accepted.snapshot, own.identityAllocations)
    : own.status === 'framed' && own.graphComplete && hasCompleteAllocations(own.snapshot, own.identityAllocations)
}

export function ownUwRefusal(child: ChildFacts): string {
  if (child.ownUw.status !== 'refused') return 'unsettled'
  return child.ownUw.diagnostics.map((diagnostic) => diagnostic.code).join(', ') || child.ownUw.reason
}

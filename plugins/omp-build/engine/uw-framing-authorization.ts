import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { UwResult } from './uw-diagnostics.ts'
import {
  conflict,
  diagnostic,
  type FramingRegistry,
  failed,
  receipts,
  reconstructFramingRegistry,
  ref,
} from './uw-framing-registry.ts'
import { sameScope } from './uw-graph.ts'
import type { FramingMemberAuthorization, SpecIdentityPayload } from './uw-identity-schema.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'framing-receipt' }>
type Intent = Extract<Receipt['payload'], { phase: 'intent' }>
type PlannedMember = Intent['proposal']['members'][number]
type FramingIdentity = Extract<SpecIdentityPayload, { format: 'omp-build-spec-identity/2' }>
function memberBindingMatches(own: DecodedHistory, authorization: FramingMemberAuthorization): boolean {
  const bindings = receipts(own).flatMap((record) =>
    record.payload.phase === 'member-binding' && sameRef(record.payload.intent, authorization.intent)
      ? [{ ref: ref(record), payload: record.payload }]
      : [],
  )
  const binding = bindings[0]
  return (
    bindings.length === 1 &&
    binding !== undefined &&
    sameRef(binding.ref, authorization.binding) &&
    binding.payload.member === authorization.member &&
    binding.payload.memberDigest === authorization.memberDigest
  )
}
function approvalProblem(
  member: PlannedMember,
  registry: FramingRegistry,
  authorization: FramingMemberAuthorization,
  payload: FramingIdentity,
): string | null {
  const approval = canonicalValueDigest(registry.confirmation)
  if (
    member.memberDigest !== authorization.memberDigest ||
    payload.proposalDigest !== member.memberDigest ||
    canonicalValueDigest(authorization.confirmation) !== approval ||
    canonicalValueDigest(payload.confirmation) !== approval ||
    canonicalValueDigest(payload.aggregate) !== canonicalValueDigest(authorization)
  )
    return 'Original approval or member digest differs from intent'
  const allocation = member.allocation
  if (
    allocation === null ||
    (payload.event === 'allocate' &&
      canonicalValueDigest(payload.allocations) !== canonicalValueDigest(allocation.assignments)) ||
    (payload.event === 'retire-proposed' &&
      canonicalValueDigest(payload.ids) !== canonicalValueDigest(allocation.retirements))
  )
    return 'Identity event differs from sealed allocation'
  return null
}
type IdentityRef = Parameters<typeof sameRef>[0]
function sameOptionalRef(left: IdentityRef | null, right: IdentityRef | null): boolean {
  return left === null || right === null ? left === right : sameRef(left, right)
}
function retiresOwnAllocation(
  own: DecodedHistory,
  uw: Scope,
  predecessor: NonNullable<FramingIdentity['predecessor']>,
  authorization: FramingMemberAuthorization,
): boolean {
  const records = own.operations.filter(
    (op) =>
      op.authority !== 'foreign' &&
      op.status === 'complete' &&
      op.record?.kind === 'spec-identity' &&
      op.record.recordId === predecessor.recordId,
  )
  const prior = records[0]?.record
  return (
    records.length === 1 &&
    prior?.kind === 'spec-identity' &&
    prior.payload.format === 'omp-build-spec-identity/2' &&
    prior.payload.event === 'allocate' &&
    sameScope(predecessor.scope, uw) &&
    predecessor.kind === 'spec-identity' &&
    canonicalValueDigest(prior.payload.aggregate) === canonicalValueDigest(authorization)
  )
}
/** /2 predecessors: allocate continues the sealed head; retire continues this member's allocate or, alone, the head. */
function predecessorProblem(
  member: PlannedMember,
  own: DecodedHistory,
  uw: Scope,
  authorization: FramingMemberAuthorization,
  payload: FramingIdentity,
): string | null {
  const allocation = member.allocation
  if (allocation === null) return 'Identity event differs from sealed allocation'
  if (payload.event === 'allocate')
    return sameOptionalRef(allocation.ledgerHead, payload.predecessor)
      ? null
      : 'Allocation predecessor differs from the sealed ledger head'
  if (payload.event !== 'retire-proposed') return null
  const predecessor = payload.predecessor
  if (predecessor === null) return 'Retirement predecessor is missing'
  if (allocation.assignments.length === 0)
    return allocation.ledgerHead !== null && sameRef(allocation.ledgerHead, predecessor)
      ? null
      : 'Retirement predecessor differs from the sealed ledger head'
  return retiresOwnAllocation(own, uw, predecessor, authorization)
    ? null
    : 'Retirement predecessor is not this member allocation'
}
export function validateFramingAuthorization(input: {
  uw: Scope
  histories: readonly DecodedHistory[]
  authorization: FramingMemberAuthorization
  payload: FramingIdentity
}): UwResult<true> {
  const { uw, histories, authorization, payload } = input
  const roots = histories.filter((history) => sameScope(history.source.scope, authorization.intent.scope))
  const owns = histories.filter((history) => sameScope(history.source.scope, uw))
  const root = roots[0]
  const own = owns[0]
  if (roots.length !== 1 || owns.length !== 1 || root === undefined || own === undefined || failed(root) || failed(own))
    return {
      ok: false,
      diagnostics: [diagnostic(uw, 'framing-registry-unreadable', 'Complete registry and member history are required')],
    }
  const registry = reconstructFramingRegistry(root, authorization.intent)
  if (!registry.ok) return registry
  const claim = registry.value.claims.get(authorization.member)
  const member = registry.value.proposal.members.find((item) => item.key === authorization.member)
  if (
    !claim ||
    !member ||
    !sameScope(claim.scope, uw) ||
    !sameRef(claim.claim, authorization.claim) ||
    !sameRef(claim.binding, authorization.binding)
  )
    return {
      ok: false,
      diagnostics: [diagnostic(uw, 'framing-binding-unregistered', 'Identity has no matching registry claim')],
    }
  if (!sameScope(uw, authorization.intent.scope) && !memberBindingMatches(own, authorization))
    return {
      ok: false,
      diagnostics: [diagnostic(uw, 'framing-binding-unregistered', 'Member binding is missing or mismatched')],
    }
  const problem =
    approvalProblem(member, registry.value, authorization, payload) ??
    predecessorProblem(member, own, uw, authorization, payload)
  return problem === null ? { ok: true, value: true } : conflict(uw, problem)
}

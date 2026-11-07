import { canonicalValueDigest } from './canonical-value.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import type { FramingReceiptRef } from './uw-framing-receipt-schema.ts'
import type { FramingMemberKey } from './uw-framing-schema.ts'
import { sameScope, scopeKey } from './uw-graph.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'framing-receipt' }>
type Intent = Extract<Receipt['payload'], { phase: 'intent' }>
type ResultPayload = Extract<Receipt['payload'], { phase: 'result' }>
export type FramingRegistry = Readonly<{
  intent: FramingReceiptRef
  proposal: Intent['proposal']
  confirmation: Intent['confirmation']
  members: ReadonlyMap<FramingMemberKey, { slot: 'existing' | 'new'; memberDigest: string }>
  claims: ReadonlyMap<FramingMemberKey, { claim: FramingReceiptRef; scope: Scope; binding: FramingReceiptRef }>
  result: FramingReceiptRef | null
  resultPayload: ResultPayload | null
}>
export function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
export function ref(record: Receipt): FramingReceiptRef {
  return {
    kind: 'framing-receipt',
    recordId: record.recordId,
    scope: { repository: record.repository, target: record.target },
  }
}
export function receipts(history: DecodedHistory): Receipt[] {
  return history.operations.flatMap((op) =>
    op.authority !== 'foreign' && op.status === 'complete' && op.record?.kind === 'framing-receipt' ? [op.record] : [],
  )
}
export function failed(history: DecodedHistory): boolean {
  return (
    !history.source.complete ||
    history.operations.some(
      (op) =>
        op.authority !== 'foreign' &&
        (op.kind === 'framing-receipt' || op.claimedKinds.includes('framing-receipt')) &&
        (op.status !== 'complete' || op.record?.kind !== 'framing-receipt'),
    )
  )
}
export function conflict(scope: Scope, message: string): UwResult<never> {
  return { ok: false, diagnostics: [diagnostic(scope, 'framing-binding-conflict', message)] }
}
type ClaimPayload = Extract<Receipt['payload'], { phase: 'member-claim' }>
type SealedMember = { slot: 'existing' | 'new'; memberDigest: string }
export type RegistryClaim = { claim: FramingReceiptRef; scope: Scope; binding: FramingReceiptRef }
type RegistryState = {
  intent: FramingReceiptRef
  sealed: Intent
  members: ReadonlyMap<FramingMemberKey, SealedMember>
  claims: Map<FramingMemberKey, RegistryClaim>
  scopes: Set<string>
  result: { ref: FramingReceiptRef; payload: ResultPayload } | null
}
function sealedIntent(all: readonly Receipt[], intent: FramingReceiptRef): UwResult<Intent> {
  const intents = all.filter((record) => record.payload.phase === 'intent')
  const matching = intents.filter((record) => sameRef(ref(record), intent))
  const entry = matching[0]
  if (matching.length !== 1 || intents.length !== 1 || entry === undefined)
    return conflict(intent.scope, 'Intent is missing or duplicated')
  const p = entry.payload
  if (p.phase !== 'intent') return conflict(intent.scope, 'Invalid intent')
  if (
    !sameScope(p.root, intent.scope) ||
    p.proposal.operationId !== p.confirmation.operationId ||
    p.proposalDigest !== p.confirmation.proposalDigest ||
    p.proposalDigest !== canonicalValueDigest(p.proposal)
  )
    return conflict(intent.scope, 'Intent proposal or original approval does not match')
  return { ok: true, value: p }
}
function sealedMembers(p: Intent, scope: Scope): UwResult<Map<FramingMemberKey, SealedMember>> {
  const members = new Map<FramingMemberKey, SealedMember>()
  for (const member of p.proposal.members) {
    const { memberDigest, ...sealedMember } = member
    if (
      members.has(member.key) ||
      member.key !== member.slot.key ||
      memberDigest !== canonicalValueDigest(sealedMember)
    )
      return conflict(scope, 'Duplicate, mismatched, or altered member')
    members.set(member.key, { slot: member.slot.kind, memberDigest })
  }
  return { ok: true, value: members }
}
function claimPlanProblem(payload: ClaimPayload, state: RegistryState): string | null {
  const member = state.members.get(payload.member)
  const planned = state.sealed.proposal.members[payload.ordinal]
  if (
    !member ||
    !planned ||
    planned.key !== payload.member ||
    member.slot !== payload.slot ||
    member.memberDigest !== payload.memberDigest ||
    state.claims.has(payload.member) ||
    state.scopes.has(scopeKey(payload.scope))
  )
    return 'Member claim conflicts with sealed plan or another claim'
  if (planned.slot.kind === 'existing' && !sameScope(planned.slot.uw, payload.scope))
    return 'Existing member claim changed scope'
  if (planned.slot.kind === 'new' && planned.slot.repository !== payload.scope.repository)
    return 'New member claim changed repository'
  if (
    payload.native.issue.repository !== payload.scope.repository ||
    payload.scope.target !== `${payload.scope.repository}#${payload.native.issue.number}`
  )
    return 'Member native observation names another issue'
  return null
}
function claimHomeProblem(payload: ClaimPayload, state: RegistryState): string | null {
  const isRoot = payload.member === state.sealed.proposal.input.root
  const binding = payload.binding
  const homed = isRoot ? binding === null : binding !== null && sameScope(binding.scope, payload.scope)
  if (isRoot !== sameScope(payload.scope, state.intent.scope) || !homed) return 'Claim has wrong binding home'
  const target = state.sealed.proposal.target
  const moved =
    (target.kind === 'existing' && !sameScope(target.uw, payload.scope)) ||
    (target.kind === 'create' && target.repository !== payload.scope.repository)
  return isRoot && moved ? 'Root claim differs from the approved target' : null
}
/** Root receipts register one result and one claim per sealed member; anything else is a conflict. */
function registerReceipt(record: Receipt, state: RegistryState): string | null {
  const payload = record.payload
  if (payload.phase === 'intent') return null
  if (!sameRef(payload.intent, state.intent)) return 'Root history contains a receipt for another intent'
  if (payload.phase === 'member-binding') return 'Member binding is homed on root'
  if (payload.phase === 'result') {
    if (state.result !== null) return 'Duplicate result'
    state.result = { ref: ref(record), payload }
    return null
  }
  const problem = claimPlanProblem(payload, state) ?? claimHomeProblem(payload, state)
  if (problem !== null) return problem
  state.scopes.add(scopeKey(payload.scope))
  state.claims.set(payload.member, {
    claim: ref(record),
    scope: payload.scope,
    binding: payload.binding ?? ref(record),
  })
  return null
}
export function reconstructFramingRegistry(root: DecodedHistory, intent: FramingReceiptRef): UwResult<FramingRegistry> {
  if (!sameScope(root.source.scope, intent.scope) || failed(root))
    return {
      ok: false,
      diagnostics: [diagnostic(intent.scope, 'framing-aggregate-unreadable', 'Complete intent history is unavailable')],
    }
  const all = receipts(root)
  const sealed = sealedIntent(all, intent)
  if (!sealed.ok) return sealed
  const members = sealedMembers(sealed.value, intent.scope)
  if (!members.ok) return members
  const state: RegistryState = {
    intent,
    sealed: sealed.value,
    members: members.value,
    claims: new Map(),
    scopes: new Set(),
    result: null,
  }
  for (const record of all) {
    const problem = registerReceipt(record, state)
    if (problem !== null) return conflict(intent.scope, problem)
  }
  return {
    ok: true,
    value: {
      intent,
      proposal: sealed.value.proposal,
      confirmation: sealed.value.confirmation,
      members: members.value,
      claims: state.claims,
      result: state.result?.ref ?? null,
      resultPayload: state.result?.payload ?? null,
    },
  }
}

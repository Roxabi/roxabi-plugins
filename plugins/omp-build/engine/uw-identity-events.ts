import type { DecodedHistory } from './history-schema.ts'
import type { RecordDraft } from './record-construction.ts'
import { equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import { validateFramingAuthorization } from './uw-framing-authorization.ts'
import type { SpecAllocationPlan } from './uw-identity.ts'
import { replaySpecIdentityHistory } from './uw-identity-replay.ts'
import {
  type FramingMemberAuthorization,
  type OperatorConfirmationEvidence,
  operatorConfirmationEvidenceSchema,
  SPEC_IDENTITY_FORMAT,
  type SpecIdentityPayload,
  specIdentityPayloadSchema,
} from './uw-identity-schema.ts'

export type SpecIdentityDraft = Extract<RecordDraft, { kind: 'spec-identity' }>
function diag(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
function identityDraft(
  uw: Scope,
  operationId: string,
  suffix: string,
  payload: SpecIdentityPayload,
): SpecIdentityDraft {
  const id = `${operationId}${suffix}`
  return {
    version: 1,
    repository: uw.repository,
    target: uw.target,
    recordId: `spec-identity:${id}`,
    runId: operationId,
    operationId: id,
    kind: 'spec-identity',
    payload,
  }
}
function confirmedIdentityEvidence(
  uw: Scope,
  input: { confirmation: OperatorConfirmationEvidence; operationId: string; proposalDigest: string },
  effects: readonly unknown[],
): UwResult<OperatorConfirmationEvidence> {
  const confirmation = operatorConfirmationEvidenceSchema.safeParse(input.confirmation)
  if (
    !confirmation.success ||
    confirmation.data.operationId !== input.operationId ||
    confirmation.data.proposalDigest !== input.proposalDigest ||
    effects.length === 0
  )
    return {
      ok: false,
      diagnostics: [diag(uw, 'operator-confirmation-required', 'Exact native confirmation is required')],
    }
  return { ok: true, value: confirmation.data }
}
export function buildSpecIdentityAllocation(input: {
  uw: Scope
  plan: SpecAllocationPlan
  proposalDigest: string
  confirmation: OperatorConfirmationEvidence
  operationId: string
}): UwResult<SpecIdentityDraft> {
  const confirmation = confirmedIdentityEvidence(input.uw, input, input.plan.assignments)
  if (!confirmation.ok) return confirmation
  const payload = specIdentityPayloadSchema.parse({
    format: SPEC_IDENTITY_FORMAT,
    predecessor: input.plan.ledgerHead,
    proposalDigest: input.proposalDigest,
    confirmation: confirmation.value,
    event: 'allocate',
    allocations: input.plan.assignments,
  })
  return { ok: true, value: identityDraft(input.uw, input.operationId, '', payload) }
}
export function buildSpecIdentityProposedRetirement(input: {
  uw: Scope
  plan: SpecAllocationPlan
  predecessor: ExternalRecordRef
  proposalDigest: string
  confirmation: OperatorConfirmationEvidence
  operationId: string
}): UwResult<SpecIdentityDraft> {
  const confirmation = confirmedIdentityEvidence(input.uw, input, input.plan.retirements)
  if (!confirmation.ok) return confirmation
  const payload = specIdentityPayloadSchema.parse({
    format: SPEC_IDENTITY_FORMAT,
    predecessor: input.predecessor,
    proposalDigest: input.proposalDigest,
    confirmation: confirmation.value,
    event: 'retire-proposed',
    ids: input.plan.retirements,
  })
  return { ok: true, value: identityDraft(input.uw, input.operationId, ':retire-proposed', payload) }
}

/** Builds an aggregate-authorized event only from the durable registry and current ledger. */
export function buildFramingSpecIdentity(input: {
  uw: Scope
  histories: readonly DecodedHistory[]
  authorization: FramingMemberAuthorization
  plan: SpecAllocationPlan
  predecessor: ExternalRecordRef | null
  event: 'allocate' | 'retire-proposed'
  operationId: string
}): UwResult<SpecIdentityDraft> {
  const own = input.histories.filter((history) => equalScope(history.source.scope, input.uw))
  if (own.length !== 1 || !own[0].source.complete)
    return {
      ok: false,
      diagnostics: [diag(input.uw, 'spec-ledger-incomplete', 'Complete unique member history is required')],
    }
  const diagnostics: UwDiagnostic[] = []
  const replay = replaySpecIdentityHistory(own[0], input.uw, diagnostics, input.histories)
  if (diagnostics.length > 0) return { ok: false, diagnostics }
  if (
    (input.predecessor === null) !== (replay.head === null) ||
    (input.predecessor !== null && replay.head !== null && !sameRef(input.predecessor, replay.head))
  )
    return {
      ok: false,
      diagnostics: [
        diag(input.uw, 'spec-ledger-conflict', 'Identity predecessor differs from the current ledger head'),
      ],
    }
  const values = input.event === 'allocate' ? input.plan.assignments : input.plan.retirements
  if (values.length === 0)
    return { ok: false, diagnostics: [diag(input.uw, 'spec-ledger-conflict', 'Identity event has no effects')] }
  const parsed = specIdentityPayloadSchema.safeParse({
    format: 'omp-build-spec-identity/2',
    predecessor: input.predecessor,
    proposalDigest: input.authorization.memberDigest,
    confirmation: input.authorization.confirmation,
    aggregate: input.authorization,
    event: input.event,
    ...(input.event === 'allocate' ? { allocations: input.plan.assignments } : { ids: input.plan.retirements }),
  })
  if (!parsed.success || parsed.data.format !== 'omp-build-spec-identity/2')
    return { ok: false, diagnostics: [diag(input.uw, 'spec-ledger-conflict', 'Invalid aggregate identity event')] }
  const authenticated = validateFramingAuthorization({
    uw: input.uw,
    histories: input.histories,
    authorization: input.authorization,
    payload: parsed.data,
  })
  if (!authenticated.ok) return authenticated
  return {
    ok: true,
    value: identityDraft(
      input.uw,
      input.operationId,
      input.event === 'allocate' ? '' : ':retire-proposed',
      parsed.data,
    ),
  }
}

import type { DecodedHistory } from './history-schema.ts'
import type { RecordDraft } from './record-construction.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { Scope } from './record-values.ts'
import type { UwDiagnostic, UwResult } from './uw-diagnostics.ts'
import { buildSpecAllocationPlan } from './uw-identity-allocation.ts'
import { replaySpecIdentityHistory, type SpecIdentityReplay } from './uw-identity-replay.ts'
import {
  type OperatorConfirmationEvidence,
  operatorConfirmationEvidenceSchema,
  SPEC_IDENTITY_FORMAT,
  type SpecIdentityPayload,
  specIdentityPayloadSchema,
} from './uw-identity-schema.ts'
import type { Spec, SpecDraft, SpecItemId } from './uw-spec.ts'
import { specDraftSchema } from './uw-spec-schema.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
export type SpecIdentityLedger = {
  uw: Scope
  head: ExternalRecordRef | null
  nextCriterion: string
  nextInvariant: string
  allocations: ReadonlyMap<SpecItemId, ExternalRecordRef>
  retired: ReadonlyMap<SpecItemId, ExternalRecordRef>
}
export type SpecAllocationPlan = {
  ledgerHead: ExternalRecordRef | null
  assignments: readonly { draftKey: string; id: SpecItemId }[]
  retirements: readonly SpecItemId[]
  spec: Spec
}
export type SpecIdentityDraft = Extract<RecordDraft, { kind: 'spec-identity' }>
function diag(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function acceptedIds(accepted: AcceptedOwnSpec | null): Set<SpecItemId> {
  return new Set(
    accepted === null
      ? []
      : [...accepted.snapshot.spec.criteria, ...accepted.snapshot.spec.invariants].map((item) => item.id),
  )
}

function replayAcceptedRetirements(
  accepted: AcceptedOwnSpec | null,
  history: DecodedHistory,
  replay: SpecIdentityReplay,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  if (accepted === null) return
  for (const step of accepted.chain) {
    if (step.kind !== 'accept-material') continue
    const operation = history.operations.find((candidate) => candidate.record?.recordId === step.source.recordId)
    const payload = operation?.record?.payload as { identityDelta?: { retired?: readonly SpecItemId[] } } | undefined
    const ids = payload?.identityDelta?.retired
    if (
      operation === undefined ||
      operation.status !== 'complete' ||
      operation.authority === 'foreign' ||
      !Array.isArray(ids)
    ) {
      diagnostics.push(diag(uw, 'spec-ledger-incomplete', `Accepted retirement ${step.source.recordId} is unreadable`))
      continue
    }
    for (const id of ids) {
      if (!replay.allocations.has(id) || replay.retired.has(id))
        diagnostics.push(diag(uw, 'spec-ledger-conflict', `Accepted retirement ${id} is invalid`))
      else replay.retired.set(id, step.source)
    }
  }
}

function validateAcceptedIds(
  active: ReadonlySet<SpecItemId>,
  replay: SpecIdentityReplay,
  uw: Scope,
  diagnostics: UwDiagnostic[],
): void {
  for (const id of active) {
    if (!replay.allocations.has(id))
      diagnostics.push(diag(uw, 'spec-ledger-conflict', `Accepted identity ${id} is unavailable`))
    if (replay.retired.get(id)?.kind === 'spec-identity')
      diagnostics.push(diag(uw, 'spec-ledger-conflict', `Accepted identity ${id} was retired as proposed`))
  }
}

export function resolveSpecIdentityLedger(input: {
  uw: Scope
  history: DecodedHistory
  accepted: AcceptedOwnSpec | null
}): UwResult<SpecIdentityLedger> {
  const diagnostics: UwDiagnostic[] = []
  if (!input.history.source.complete)
    diagnostics.push(diag(input.uw, 'spec-ledger-incomplete', 'Identity history is incomplete'))
  const replay = replaySpecIdentityHistory(input.history, input.uw, diagnostics)
  const active = acceptedIds(input.accepted)
  replayAcceptedRetirements(input.accepted, input.history, replay, input.uw, diagnostics)
  validateAcceptedIds(active, replay, input.uw, diagnostics)
  return diagnostics.length === 0
    ? {
        ok: true,
        value: {
          uw: input.uw,
          head: replay.head,
          nextCriterion: replay.nextCriterion,
          nextInvariant: replay.nextInvariant,
          allocations: replay.allocations,
          retired: replay.retired,
        },
      }
    : { ok: false, diagnostics }
}
export function prepareSpecAllocation(draft: SpecDraft, ledger: SpecIdentityLedger): UwResult<SpecAllocationPlan> {
  const parsed = specDraftSchema.safeParse(draft)
  return parsed.success
    ? buildSpecAllocationPlan(parsed.data, ledger)
    : { ok: false, diagnostics: [diag(ledger.uw, 'spec-invalid', 'Spec draft is invalid')] }
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

import type { GitHubOptions } from '../adapters/github/types.ts'
import {
  buildFramingSpecIdentity,
  buildRecord,
  buildSpecIdentityAllocation,
  buildSpecIdentityProposedRetirement,
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
} from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { SpecAllocationPlan } from '../engine/uw-identity.ts'
import type { SpecIdentityDraft } from '../engine/uw-identity-events.ts'
import type { FramingMemberAuthorization, OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import { createPublicationContextResolver } from './publication-context.ts'
import type { CreatedUwRead, CreatedUwReadPort, PreparedUwProposal } from './uw-contract.ts'
import type { FramingEffectGuard } from './uw-framing-contract.ts'
import { diagnostic, diagnostics, postEffectDiagnostics } from './uw-installed-reports.ts'

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function sameRecord(
  left: { scope: Scope; recordId: string; kind: string } | null,
  right: { scope: Scope; recordId: string; kind: string },
): boolean {
  return (
    left !== null && sameScope(left.scope, right.scope) && left.recordId === right.recordId && left.kind === right.kind
  )
}
type IdentityPublicationFailure = {
  status: 'refused' | 'partial' | 'uncertain'
  predecessor?: ExternalRecordRef
  diagnostics: readonly UwDiagnostic[]
}
type IdentityPublication = { status: 'confirmed' } | IdentityPublicationFailure
type IdentityPublicationState = {
  status: 'confirmed'
  predecessor: ExternalRecordRef | null
  knownEffect: boolean
}

function identityFailure(
  knownEffect: boolean,
  status: 'refused' | 'partial' | 'uncertain',
  values: readonly UwDiagnostic[],
): IdentityPublicationFailure {
  return { status: knownEffect ? 'partial' : status, diagnostics: values }
}
type PublishedIdentity = { status: 'confirmed'; predecessor: ExternalRecordRef } | IdentityPublicationFailure

async function publishIdentityDraft(
  uw: Scope,
  draft: UwResult<SpecIdentityDraft>,
  github: GitHubOptions,
): Promise<PublishedIdentity> {
  if (!draft.ok) return { status: 'refused', diagnostics: draft.diagnostics }
  const record = buildRecord(draft.value)
  if (!record.ok) return { status: 'refused', diagnostics: diagnostics(uw, record.diagnostics) }
  const history = await readComposedWorkflowHistory([uw], github)
  if (!history.ok) return { status: 'refused', diagnostics: diagnostics(uw, history.diagnostics) }
  const own = history.histories.find((entry) => sameScope(entry.source.scope, uw))
  if (own === undefined)
    return {
      status: 'refused',
      diagnostics: [diagnostic(uw, 'history-missing', 'Own UW history is absent before identity publication')],
    }
  const published = await publishConfirmedWorkflowRecord(
    record.value,
    github,
    createPublicationContextResolver(github, null),
  )
  if (published.status !== 'confirmed')
    return { status: published.status, diagnostics: diagnostics(uw, published.diagnostics) }
  return {
    status: 'confirmed',
    predecessor: { scope: uw, recordId: record.value.recordId, kind: 'spec-identity' },
  }
}
async function publishIdentityAllocation(
  uw: Scope,
  proposal: PreparedUwProposal,
  confirmation: OperatorConfirmationEvidence,
  github: GitHubOptions,
): Promise<IdentityPublicationState | IdentityPublicationFailure> {
  const allocation = proposal.proposal.allocation
  if (allocation.assignments.length === 0)
    return { status: 'confirmed', predecessor: allocation.ledgerHead, knownEffect: false }
  const published = await publishIdentityDraft(
    uw,
    buildSpecIdentityAllocation({
      uw,
      plan: allocation,
      proposalDigest: proposal.digest,
      confirmation,
      operationId: proposal.proposal.operationId,
    }),
    github,
  )
  return published.status === 'confirmed'
    ? { status: 'confirmed', predecessor: published.predecessor, knownEffect: true }
    : identityFailure(false, published.status, published.diagnostics)
}

async function publishIdentityRetirement(
  uw: Scope,
  proposal: PreparedUwProposal,
  confirmation: OperatorConfirmationEvidence,
  github: GitHubOptions,
  state: IdentityPublicationState,
): Promise<IdentityPublicationState | IdentityPublicationFailure> {
  const allocation = proposal.proposal.allocation
  const retirements = proposal.proposal.expected?.acceptedPredecessor === null ? allocation.retirements : []
  if (retirements.length === 0) return state
  if (state.predecessor === null)
    return identityFailure(state.knownEffect, 'refused', [
      diagnostic(uw, 'spec-ledger-conflict', 'Proposed retirement has no identity predecessor'),
    ])
  const published = await publishIdentityDraft(
    uw,
    buildSpecIdentityProposedRetirement({
      uw,
      plan: { ...allocation, retirements },
      predecessor: state.predecessor,
      proposalDigest: proposal.digest,
      confirmation,
      operationId: proposal.proposal.operationId,
    }),
    github,
  )
  return published.status === 'confirmed'
    ? { status: 'confirmed', predecessor: published.predecessor, knownEffect: true }
    : identityFailure(state.knownEffect, published.status, published.diagnostics)
}

async function confirmIdentityReadback(
  uw: Scope,
  predecessor: ExternalRecordRef | null,
  reader: CreatedUwReadPort,
): Promise<IdentityPublication> {
  try {
    const reread = await reader.readUw(uw)
    if (predecessor !== null && reread.identity.ok && sameRecord(reread.identity.value.head, predecessor))
      return { status: 'confirmed' }
  } catch (error) {
    return { status: 'partial', diagnostics: postEffectDiagnostics(uw, error) }
  }
  return {
    status: 'partial',
    diagnostics: [
      diagnostic(uw, 'write-unconfirmed', 'Identity publication was not the confirmed ledger head after read-back'),
    ],
  }
}

export function createIdentityPublisher(
  github: GitHubOptions,
  reader: CreatedUwReadPort,
  createdReader: CreatedUwReadPort,
) {
  return async ({
    uw,
    proposal,
    confirmation,
  }: {
    uw: Scope
    proposal: PreparedUwProposal
    confirmation: OperatorConfirmationEvidence
  }): Promise<IdentityPublication> => {
    const allocated = await publishIdentityAllocation(uw, proposal, confirmation, github)
    if (allocated.status !== 'confirmed') return allocated
    const retired = await publishIdentityRetirement(uw, proposal, confirmation, github, allocated)
    if (retired.status !== 'confirmed') return retired
    return retired.knownEffect
      ? confirmIdentityReadback(
          uw,
          retired.predecessor,
          proposal.proposal.operation === 'create' ? createdReader : reader,
        )
      : { status: 'confirmed' }
  }
}

/** Publish one /2 event only after validating the current member and registry histories. */
export async function publishFramingIdentity(input: {
  uw: Scope
  operationId: string
  authorization: FramingMemberAuthorization
  plan: SpecAllocationPlan
  predecessor: ExternalRecordRef | null
  event: 'allocate' | 'retire-proposed'
  github: GitHubOptions
  reader: CreatedUwReadPort
  effectId: string
  guard: FramingEffectGuard
}): Promise<PublishedIdentity> {
  let current: CreatedUwRead
  try {
    current = await input.reader.readUw(input.uw)
  } catch (error) {
    return { status: 'refused', diagnostics: postEffectDiagnostics(input.uw, error) }
  }
  if (!current.identity.ok) return { status: 'refused', diagnostics: current.identity.diagnostics }
  const draft = buildFramingSpecIdentity({
    uw: input.uw,
    histories: current.histories,
    authorization: input.authorization,
    plan: input.plan,
    predecessor: input.predecessor,
    event: input.event,
    // Each member event is its own record; the aggregate operation binds only the guard.
    operationId: input.effectId,
  })
  if (!draft.ok) return { status: 'refused', diagnostics: draft.diagnostics }
  const record = buildRecord(draft.value)
  if (!record.ok) return { status: 'refused', diagnostics: diagnostics(input.uw, record.diagnostics) }
  const point = {
    operationId: input.operationId,
    proposalDigest: input.authorization.confirmation.proposalDigest,
    member: input.authorization.member,
    effectId: input.effectId,
  }
  try {
    await input.guard.check({ ...point, at: 'before-effect' })
  } catch (error) {
    return { status: 'refused', diagnostics: [diagnostic(input.uw, 'framing-guard-refused', String(error))] }
  }
  try {
    const published = await publishConfirmedWorkflowRecord(
      record.value,
      input.github,
      createPublicationContextResolver(input.github, null),
      current.histories,
    )
    if (published.status !== 'confirmed')
      return { status: published.status, diagnostics: diagnostics(input.uw, published.diagnostics) }
  } catch (error) {
    return { status: 'uncertain', diagnostics: [diagnostic(input.uw, 'framing-publication-uncertain', String(error))] }
  }
  const predecessor: ExternalRecordRef = { scope: input.uw, recordId: record.value.recordId, kind: 'spec-identity' }
  const confirmed = await confirmIdentityReadback(input.uw, predecessor, input.reader)
  if (confirmed.status !== 'confirmed') return { ...confirmed, predecessor }
  try {
    await input.guard.check({ ...point, at: 'after-readback' })
  } catch (error) {
    return {
      status: 'partial',
      predecessor,
      diagnostics: [diagnostic(input.uw, 'framing-guard-changed', String(error))],
    }
  }
  return { status: 'confirmed', predecessor }
}

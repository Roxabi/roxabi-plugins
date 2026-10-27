import { createHash, randomUUID } from 'node:crypto'
import type { ComplexityTierResult, calculateTier } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type { IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { prepareSpecAllocation, SpecIdentityLedger } from '../engine/uw-identity.ts'
import type {
  PreparedUwProposal,
  UwCreateInput,
  UwProposal,
  UwProposalInput,
  UwRead,
  UwWritePrecondition,
} from './uw-contract.ts'

export type UwProposalPreparationPorts = {
  prepareSpecAllocation: typeof prepareSpecAllocation
  renderIssueSpecBody: typeof renderIssueSpecBody
  calculateTier: typeof calculateTier
}

type PreparedProposal = PreparedUwProposal | { diagnostics: readonly UwDiagnostic[] }

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

export function nativeIssueObservationDigest(observed: IssueWriteObservation): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        title: observed.title,
        body: observed.body,
        labels: [...observed.labels],
        parent: observed.parent,
        children: observed.children,
        blockers: observed.blockers,
      }),
    )
    .digest('hex')
}

function proposalDigest(proposal: UwProposal): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
}

function calculateProposalTier(
  input: UwProposalInput,
  ports: UwProposalPreparationPorts,
): ComplexityTierResult | { diagnostics: readonly UwDiagnostic[] } {
  try {
    return ports.calculateTier(input.factors)
  } catch (error) {
    return {
      diagnostics: [diagnostic(input.uw, 'tier-invalid', error instanceof Error ? error.message : String(error))],
    }
  }
}

function writesWithTier(
  input: UwProposalInput,
  tier: ComplexityTierResult['tier'],
  observed: IssueWriteObservation | null,
): UwProposalInput['writes'] {
  const writes = structuredClone(input.writes)
  const size = `size:${tier}`
  const add = writes.labels.add.filter((label) => !label.startsWith('size:'))
  add.push(size)
  const remove = new Set(writes.labels.remove.filter((label) => !label.startsWith('size:') || label !== size))
  for (const label of observed?.labels ?? []) {
    if (label.startsWith('size:') && label !== size) remove.add(label)
  }
  writes.labels = { add, remove: [...remove] }
  return writes
}

function assemblePlan(
  input: UwProposalInput,
  ledger: SpecIdentityLedger,
  acceptedPredecessor: UwWritePrecondition['acceptedPredecessor'],
  observed: IssueWriteObservation | null,
  operation: UwProposal['operation'],
  ports: UwProposalPreparationPorts,
): PreparedProposal {
  const allocation = ports.prepareSpecAllocation(input.draft, ledger)
  if (!allocation.ok) return { diagnostics: allocation.diagnostics }
  const calculated = calculateProposalTier(input, ports)
  if ('diagnostics' in calculated) return calculated
  const tier = input.tierOverride?.tier ?? calculated.tier
  const writes = writesWithTier(input, tier, observed)
  const proposal: UwProposal = {
    format: 'omp-build-uw-proposal/1',
    operationId: `uw-${randomUUID()}`,
    operation,
    target: { kind: 'existing', uw: structuredClone(input.uw) },
    expected:
      observed === null
        ? null
        : {
            observed: structuredClone(observed),
            nativeDigest: nativeIssueObservationDigest(observed),
            ledgerHead: structuredClone(ledger.head),
            acceptedPredecessor: structuredClone(acceptedPredecessor),
          },
    draft: structuredClone(input.draft),
    allocation: structuredClone(allocation.value),
    renderedBody: ports.renderIssueSpecBody(allocation.value.spec),
    title: input.title,
    factors: structuredClone(input.factors),
    tier,
    tierOverride:
      input.tierOverride === null || input.tierOverride === undefined
        ? input.tierOverride
        : structuredClone(input.tierOverride),
    writes,
    normalization: structuredClone(input.normalization),
    assessment: null,
  }
  return { proposal, digest: proposalDigest(proposal) }
}

export function prepareExistingProposal(
  input: UwProposalInput,
  read: UwRead,
  observed: IssueWriteObservation,
  operation: UwProposal['operation'],
  ports: UwProposalPreparationPorts,
): PreparedProposal {
  if (read.accepted.status === 'refused') return { diagnostics: read.accepted.diagnostics }
  if (!read.identity.ok) return { diagnostics: read.identity.diagnostics }
  return assemblePlan(
    input,
    read.identity.value,
    read.accepted.status === 'accepted' ? read.accepted.value.ref.sourceAccepted : null,
    observed,
    operation,
    ports,
  )
}

export function prepareCreateProposal(input: UwCreateInput, ports: UwProposalPreparationPorts): PreparedProposal {
  const provisional: UwProposalInput = {
    ...input,
    uw: { repository: input.repository, target: `${input.repository}#0` },
  }
  const ledger: SpecIdentityLedger = {
    uw: provisional.uw,
    head: null,
    nextCriterion: '1',
    nextInvariant: '1',
    allocations: new Map(),
    retired: new Map(),
  }
  const observed: IssueWriteObservation = {
    issue: { repository: input.repository, number: 0 },
    title: input.title,
    body: '',
    updatedAt: '',
    labels: [],
    parent: null,
    children: [],
    blockers: [],
  }
  const prepared = assemblePlan(provisional, ledger, null, observed, 'create', ports)
  if ('diagnostics' in prepared) return prepared
  const proposal: UwProposal = {
    ...prepared.proposal,
    target: { kind: 'create', repository: input.repository },
    expected: null,
  }
  return { proposal, digest: proposalDigest(proposal) }
}

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
import { validateNormalizationConservation } from './uw-normalization-conservation.ts'
import { historicalProjection } from './uw-normalization-internal.ts'

export type UwProposalPreparationPorts = {
  prepareSpecAllocation: typeof prepareSpecAllocation
  renderIssueSpecBody: typeof renderIssueSpecBody
  calculateTier: typeof calculateTier
}

type PreparedProposal = PreparedUwProposal | { diagnostics: readonly UwDiagnostic[] }

type ProposalAssemblyInput = Omit<UwProposalInput, 'sourceBodySha256'>

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

function parsedSourceHash(read: UwRead): string {
  return read.parsed.status === 'conformant' ? read.parsed.snapshot.raw.bodySha256 : read.parsed.raw.bodySha256
}

export function sourceBindingDiagnostics(input: UwProposalInput, read: UwRead): readonly UwDiagnostic[] {
  if (input.sourceBodySha256 !== parsedSourceHash(read))
    return [
      diagnostic(
        input.uw,
        'normalization-source-stale',
        'The current native Spec source differs from the source bound to this proposal input',
      ),
    ]
  return validateNormalizationConservation(input, read.parsed.analysis)
}

export function parentRepositoryDiagnostics(input: UwProposalInput | UwCreateInput): readonly UwDiagnostic[] {
  const parent = input.writes.relations.parent
  const repository = 'uw' in input ? input.uw.repository : input.repository
  if (parent === undefined || parent === null || parent.repository === repository) return []
  const uw = 'uw' in input ? input.uw : { repository, target: `${repository}#0` }
  return [diagnostic(uw, 'cross-repository-parent', 'A UW parent must be in the same repository as the UW')]
}

function sameRef(left: UwWritePrecondition['ledgerHead'], right: UwWritePrecondition['ledgerHead']): boolean {
  return left === null || right === null
    ? left === right
    : left.scope.repository === right.scope.repository &&
        left.scope.target === right.scope.target &&
        left.recordId === right.recordId &&
        left.kind === right.kind
}

function sameObservation(left: IssueWriteObservation, right: IssueWriteObservation): boolean {
  return nativeIssueObservationDigest(left) === nativeIssueObservationDigest(right)
}

export function staleWrite(prepared: PreparedUwProposal, read: UwRead, fresh: IssueWriteObservation): boolean {
  const expected = prepared.proposal.expected
  const historical = expected?.successorHistoryDigest === undefined ? undefined : historicalProjection(read)
  const predecessor =
    historical?.accepted.ref.sourceAccepted ??
    (read.accepted.status === 'accepted' ? read.accepted.value.ref.sourceAccepted : null)
  return (
    !read.identity.ok ||
    expected === null ||
    (expected.successorHistoryDigest === undefined
      ? read.accepted.status === 'refused'
      : historical === undefined || historical.historyDigest !== expected.successorHistoryDigest) ||
    !sameObservation(fresh, expected.observed) ||
    !sameRef(predecessor, expected.acceptedPredecessor) ||
    !sameRef(read.identity.value.head, expected.ledgerHead)
  )
}

function proposalDigest(proposal: UwProposal): string {
  return createHash('sha256').update(JSON.stringify(proposal)).digest('hex')
}

function calculateProposalTier(
  input: ProposalAssemblyInput,
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
  input: ProposalAssemblyInput,
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
  input: ProposalAssemblyInput,
  ledger: SpecIdentityLedger,
  acceptedPredecessor: UwWritePrecondition['acceptedPredecessor'],
  observed: IssueWriteObservation | null,
  operation: UwProposal['operation'],
  ports: UwProposalPreparationPorts,
  successorHistoryDigest?: string,
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
            ...(successorHistoryDigest === undefined ? {} : { successorHistoryDigest }),
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
  ports: UwProposalPreparationPorts,
  successorNormalization = false,
): PreparedProposal {
  const historical = successorNormalization ? historicalProjection(read) : undefined
  if (read.accepted.status === 'refused' && historical === undefined) return { diagnostics: read.accepted.diagnostics }
  if (successorNormalization && (historical === undefined || read.parsed.status === 'conformant'))
    return {
      diagnostics: [
        diagnostic(input.uw, 'normalization-ineligible', 'Explicit successor normalization is no longer eligible'),
      ],
    }
  if (!read.identity.ok) return { diagnostics: read.identity.diagnostics }
  return assemblePlan(
    input,
    read.identity.value,
    historical?.accepted.ref.sourceAccepted ??
      (read.accepted.status === 'accepted' ? read.accepted.value.ref.sourceAccepted : null),
    observed,
    successorNormalization || input.normalization.length > 0 ? 'normalize' : 'write',
    ports,
    historical?.historyDigest,
  )
}

export function prepareCreateProposal(input: UwCreateInput, ports: UwProposalPreparationPorts): PreparedProposal {
  const provisional: ProposalAssemblyInput = {
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

import type { calculateTier } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type {
  IssueRef,
  IssueWriteObservation,
  IssueWriteResult,
  IssueWriter,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { prepareSpecAllocation } from '../engine/uw-identity.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import type {
  OperatorPort,
  OperatorResult,
  PreparedUwProposal,
  UwCreateInput,
  UwOperationResult,
  UwOperations,
  UwProposal,
  UwProposalInput,
  UwRead,
} from './uw-contract.ts'
import { bindSuccessorWriter } from './uw-normalization-internal.ts'
import { validateNormalizationJudgement } from './uw-normalization-proposal.ts'
import {
  parentRepositoryDiagnostics,
  prepareCreateProposal,
  prepareExistingProposal,
  sourceBindingDiagnostics,
  staleWrite,
  type UwProposalPreparationPorts,
} from './uw-proposal-preparation.ts'
import { UwGraphUnavailableError } from './uw-read-port.ts'

export type IdentityPublicationResult =
  | { status: 'confirmed' }
  | { status: 'refused' | 'partial' | 'uncertain'; diagnostics: readonly UwDiagnostic[] }

export type UwOperationsPorts = {
  read(uw: Scope): Promise<UwRead>
  writer: IssueWriter
  operator: OperatorPort
  /** Engine/runtime values are loaded from the installed contracts facade by composition. */
  prepareSpecAllocation: typeof prepareSpecAllocation
  renderIssueSpecBody: typeof renderIssueSpecBody
  calculateTier: typeof calculateTier
  /** Bundled engine schema parser injected by the installed host; no source Zod dependency. */
  parseNormalization(uw: Scope, value: unknown): UwResult<NormalizationJudgement>
  /** Publishes and reads back the engine-built identity effects on the actual issue. */
  publishIdentity(input: {
    uw: Scope
    proposal: PreparedUwProposal
    confirmation: OperatorConfirmationEvidence
  }): Promise<IdentityPublicationResult>
  acceptMaterial(uw: Scope): Promise<UwOperationResult>
  /** New issues need an immediate complete UW read after their real identity is known. */
  scopeOf(issue: IssueRef): Scope
}

function issueRef(uw: Scope): IssueRef | null {
  const separator = uw.target.lastIndexOf('#')
  const number = Number(uw.target.slice(separator + 1))
  return separator < 1 || !Number.isSafeInteger(number) || number < 1 ? null : { repository: uw.repository, number }
}

function observation(read: UwRead): IssueWriteObservation | null {
  const node = read.graph.nodes.find(
    (candidate) => candidate.uw.repository === read.uw.repository && candidate.uw.target === read.uw.target,
  )
  const issue = issueRef(read.uw)
  if (node === undefined || issue === null) return null
  return {
    issue,
    title: node.title,
    body: node.raw.body,
    updatedAt: node.updatedAt,
    labels: node.labels,
    parent: node.parent === null ? null : issueRef(node.parent),
    children: node.children.flatMap((child) => {
      const ref = issueRef(child)
      return ref === null ? [] : [ref]
    }),
    blockers: node.blockers.flatMap((blocker) => {
      const ref = issueRef(blocker)
      return ref === null ? [] : [ref]
    }),
  }
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}
function postEffectDiagnostics(uw: Scope, error: unknown): readonly UwDiagnostic[] {
  if (error instanceof UwGraphUnavailableError) return error.diagnostics
  return [
    diagnostic(
      uw,
      'post-effect-read-failed',
      error instanceof Error ? error.message : 'UW read failed after durable effects',
    ),
  ]
}
async function readAfterEffect(
  status: 'written' | 'created',
  uw: Scope,
  read: () => Promise<UwRead>,
): Promise<UwOperationResult> {
  try {
    return { status, value: await read() }
  } catch (error) {
    return { status: 'partial', uw, diagnostics: postEffectDiagnostics(uw, error) }
  }
}

function issuePlan(proposal: UwProposal): NativeIssueWritePlan {
  return {
    repository: proposal.target.kind === 'existing' ? proposal.target.uw.repository : proposal.target.repository,
    title: proposal.title,
    body: proposal.renderedBody,
    labels: proposal.writes.labels,
    relations: proposal.writes.relations,
  }
}

function writeDiagnostics(uw: Scope, result: IssueWriteResult): readonly UwDiagnostic[] {
  if (result.status === 'written') return []
  return result.diagnostics.map((item) => diagnostic(uw, item.code, item.message))
}

async function commitWrite(
  input: UwProposalInput,
  prepared: PreparedUwProposal,
  confirmation: OperatorConfirmationEvidence,
  ports: UwOperationsPorts,
): Promise<UwOperationResult> {
  const freshRead = await ports.read(input.uw)
  const sourceDiagnostics = sourceBindingDiagnostics(input, freshRead)
  if (sourceDiagnostics.length > 0) return { status: 'refused', diagnostics: sourceDiagnostics }
  const freshIssue = observation(freshRead)
  const target = issueRef(input.uw)
  if (freshIssue === null || target === null || staleWrite(prepared, freshRead, freshIssue))
    return {
      status: 'refused',
      diagnostics: [
        diagnostic(
          input.uw,
          'proposal-stale',
          'UW facts or identity ledger changed after the exact proposal was shown',
        ),
      ],
    }
  const publishesIdentity =
    prepared.proposal.allocation.assignments.length > 0 ||
    (prepared.proposal.expected?.acceptedPredecessor === null && prepared.proposal.allocation.retirements.length > 0)
  let publishedIdentity = false
  if (publishesIdentity) {
    const published = await ports.publishIdentity({ uw: input.uw, proposal: prepared, confirmation })
    if (published.status !== 'confirmed')
      return published.status === 'refused'
        ? { status: 'refused', diagnostics: published.diagnostics }
        : { status: 'partial', uw: input.uw, diagnostics: published.diagnostics }
    publishedIdentity = true
  }
  const written = await ports.writer.update(target, issuePlan(prepared.proposal), freshIssue)
  if (written.status === 'written') return readAfterEffect('written', input.uw, () => ports.read(input.uw))
  if (written.status === 'partial' || publishedIdentity)
    return { status: 'partial', uw: input.uw, diagnostics: writeDiagnostics(input.uw, written) }
  return { status: 'refused', diagnostics: writeDiagnostics(input.uw, written) }
}

function creationFailure(input: UwCreateInput, created: IssueWriteResult, ports: UwOperationsPorts): UwOperationResult {
  const scope =
    created.status === 'partial'
      ? ports.scopeOf(created.issue)
      : { repository: input.repository, target: `${input.repository}#0` }
  return created.status === 'partial'
    ? { status: 'partial', uw: scope, diagnostics: writeDiagnostics(scope, created) }
    : { status: 'refused', diagnostics: writeDiagnostics(scope, created) }
}

async function commitCreate(
  input: UwCreateInput,
  prepared: PreparedUwProposal,
  confirmation: OperatorConfirmationEvidence,
  ports: UwOperationsPorts,
): Promise<UwOperationResult> {
  const created = await ports.writer.create(issuePlan(prepared.proposal))
  if (created.status === 'uncertain')
    return { status: 'uncertain', diagnostics: created.diagnostics.map(({ code, message }) => ({ code, message })) }
  if (created.status !== 'written') return creationFailure(input, created, ports)
  const uw = ports.scopeOf(created.observed.issue)
  if (prepared.proposal.allocation.assignments.length > 0) {
    const published = await ports.publishIdentity({ uw, proposal: prepared, confirmation })
    if (published.status !== 'confirmed') return { status: 'partial', uw, diagnostics: published.diagnostics }
  }
  return readAfterEffect('created', uw, () => ports.read(uw))
}

function preparedResult(
  prepared: PreparedUwProposal | { diagnostics: readonly UwDiagnostic[] },
): Result<PreparedUwProposal, UwDiagnostic> {
  return 'diagnostics' in prepared
    ? { ok: false, diagnostics: [...prepared.diagnostics] }
    : { ok: true, value: prepared }
}

function confirmedResult(confirmed: OperatorResult<UwOperationResult>): UwOperationResult {
  return confirmed.status === 'confirmed' ? confirmed.value : { status: 'refused', diagnostics: confirmed.diagnostics }
}

export function createUwOperations(ports: UwOperationsPorts): UwOperations {
  const proposalPorts: UwProposalPreparationPorts = ports
  const prepareExisting = async (
    input: UwProposalInput,
    successorNormalization = false,
  ): Promise<PreparedUwProposal | { diagnostics: readonly UwDiagnostic[] }> => {
    const parentDiagnostics = parentRepositoryDiagnostics(input)
    if (parentDiagnostics.length > 0) return { diagnostics: parentDiagnostics }
    const read = await ports.read(input.uw)
    const sourceDiagnostics = sourceBindingDiagnostics(input, read)
    if (sourceDiagnostics.length > 0) return { diagnostics: sourceDiagnostics }
    const observed = observation(read)
    if (observed === null)
      return {
        diagnostics: [
          diagnostic(input.uw, 'graph-root-missing', 'UW graph root cannot provide a complete native observation'),
        ],
      }
    return prepareExistingProposal(input, read, observed, proposalPorts, successorNormalization)
  }

  const operations: UwOperations = {
    readUw: ports.read,
    validateNormalization(request, value) {
      const parsed = ports.parseNormalization(request.uw, value)
      if (!parsed.ok) return parsed
      const diagnostics = validateNormalizationJudgement(request, parsed.value)
      return diagnostics.length === 0 ? { ok: true, value: parsed.value } : { ok: false, diagnostics: [...diagnostics] }
    },
    async prepare(input) {
      const request = structuredClone(input)
      if ('uw' in request) return preparedResult(await prepareExisting(request))
      const parentDiagnostics = parentRepositoryDiagnostics(request)
      return parentDiagnostics.length > 0
        ? { ok: false, diagnostics: [...parentDiagnostics] }
        : preparedResult(prepareCreateProposal(request, proposalPorts))
    },
    async write(input) {
      const request = structuredClone(input)
      const prepared = await prepareExisting(request)
      if ('diagnostics' in prepared) return { status: 'refused', diagnostics: prepared.diagnostics }
      return confirmedResult(
        await ports.operator.executeConfirmed(prepared, (confirmation) =>
          commitWrite(request, prepared, confirmation, ports),
        ),
      )
    },
    async create(input) {
      const request = structuredClone(input)
      const parentDiagnostics = parentRepositoryDiagnostics(request)
      if (parentDiagnostics.length > 0) return { status: 'refused', diagnostics: parentDiagnostics }
      const prepared = prepareCreateProposal(request, proposalPorts)
      if ('diagnostics' in prepared) return { status: 'refused', diagnostics: prepared.diagnostics }
      return confirmedResult(
        await ports.operator.executeConfirmed(prepared, (confirmation) =>
          commitCreate(request, prepared, confirmation, ports),
        ),
      )
    },
    acceptMaterial: ports.acceptMaterial,
  }
  bindSuccessorWriter(operations, async (input, historyDigest) => {
    const request = structuredClone(input)
    const prepared = await prepareExisting(request, true)
    if ('diagnostics' in prepared) return { status: 'refused', diagnostics: prepared.diagnostics }
    if (prepared.proposal.expected?.successorHistoryDigest !== historyDigest)
      return {
        status: 'refused',
        diagnostics: [diagnostic(input.uw, 'proposal-stale', 'Successor history changed before proposal preparation')],
      }
    return confirmedResult(
      await ports.operator.executeConfirmed(prepared, (confirmation) =>
        commitWrite(request, prepared, confirmation, ports),
      ),
    )
  })
  return operations
}

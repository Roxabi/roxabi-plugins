import type { calculateTier } from '../../issue-triage/skills/shared/domain/complexity.ts'
import type { IssueRef, IssueWriter } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { renderIssueSpecBody } from '../adapters/github-native/uw-spec.ts'
import type { CreationContext } from '../engine/cause-disposition-schema.ts'
import type { Scope } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import type { resolveSpecEffective } from '../engine/spec-effective.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { prepareSpecAllocation } from '../engine/uw-identity.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { NormalizationJudgement } from '../engine/uw-normalization-schema.ts'
import { type ActionOperationPorts, actionOperationMethods } from './uw-action-operations.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import type {
  CreatedUwRead,
  OperatorPort,
  OperatorResult,
  PreparedUwProposal,
  UwCreateInput,
  UwOperationResult,
  UwOperations,
  UwProposalInput,
  UwRead,
} from './uw-contract.ts'
import { executeFraming } from './uw-framing-executor.ts'
import type { FramingPublicationPorts } from './uw-framing-ports.ts'
import { prepareFraming } from './uw-framing-prepare.ts'
import { bindSuccessorWriter } from './uw-normalization-internal.ts'
import { validateNormalizationJudgement } from './uw-normalization-proposal.ts'
import { observation } from './uw-operation-observation.ts'
import { insertionDiagnostics } from './uw-parent-admission.ts'
import { commitCreate, commitWrite } from './uw-proposal-commit.ts'
import {
  parentRepositoryDiagnostics,
  prepareCreateProposal,
  prepareExistingProposal,
  sourceBindingDiagnostics,
  type UwProposalPreparationPorts,
} from './uw-proposal-preparation.ts'
import { reopenUw } from './uw-reopen.ts'

export type IdentityPublicationResult =
  | { status: 'confirmed' }
  | { status: 'refused' | 'partial' | 'uncertain'; diagnostics: readonly UwDiagnostic[] }

export type UwOperationsPorts = {
  abandon: UwOperations['abandon']
  closeLinked: UwOperations['closeLinked']
  read(uw: Scope): Promise<UwRead>
  readCreated(uw: Scope): Promise<CreatedUwRead>
  adjustCauseDependency: UwOperations['adjustCauseDependency']
  listReports: UwOperations['listReports']
  writer: IssueWriter
  guardParent(parent: IssueRef): Promise<void>
  guardedWriter(beforeEffect: CauseEffectGuard): IssueWriter
  causeOperations(backend: {
    prepare(
      input: UwCreateInput,
      context: CreationContext,
    ): PreparedUwProposal | { diagnostics: readonly UwDiagnostic[] }
    commit(
      input: UwCreateInput,
      prepared: PreparedUwProposal,
      confirmation: OperatorConfirmationEvidence,
      writer: IssueWriter,
      composedGuard?: CauseEffectGuard,
    ): Promise<UwOperationResult>
  }): Pick<UwOperations, 'adjudicateCause' | 'createSister' | 'promoteReport'>
  operator: OperatorPort
  resolveSpecEffective: typeof resolveSpecEffective
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
  actions?: ActionOperationPorts['actions']
  delivery?: ActionOperationPorts['delivery']
  /** Installed receipt and /2 identity publisher; without it framing refuses before any effect. */
  framingPublication?: FramingPublicationPorts
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
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
  const effective = async (uw: Scope) => {
    const read = await ports.read(uw)
    if (read.observation.status !== 'complete')
      return { ok: false as const, diagnostics: [...read.observation.diagnostics] }
    if (read.accepted.status === 'refused') return { ok: false as const, diagnostics: [...read.accepted.diagnostics] }
    if (read.accepted.status === 'absent')
      return {
        ok: false as const,
        diagnostics: [diagnostic(uw, 'accepted-unavailable', 'No accepted own Spec exists')],
      }
    return ports.resolveSpecEffective({
      mode: 'current',
      own: read.accepted.value.ref,
      histories: read.observation.histories,
      graph: read.observation.graph,
    })
  }
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

  const causes = ports.causeOperations({
    prepare: (input, context) => prepareCreateProposal(input, proposalPorts, context),
    commit: (input, prepared, confirmation, writer, composedGuard) =>
      commitCreate(input, prepared, confirmation, ports, writer, composedGuard),
  })

  const operations: UwOperations = {
    readUw: ports.read,
    prepareFraming: (input, invocation) => prepareFraming(input, invocation, ports),
    frame: (prepared, guard) => executeFraming(prepared, guard, ports),
    readEffective: effective,
    async readCoverage(uw) {
      const read = await ports.read(uw)
      if (read.observation.status !== 'complete') return { ok: false, diagnostics: [...read.observation.diagnostics] }
      if (read.accepted.status === 'refused') return { ok: false, diagnostics: [...read.accepted.diagnostics] }
      if (read.accepted.status === 'absent')
        return { ok: false, diagnostics: [diagnostic(uw, 'accepted-unavailable', 'No accepted own Spec exists')] }
      const resolved = ports.resolveSpecEffective({
        mode: 'current',
        own: read.accepted.value.ref,
        histories: read.observation.histories,
        graph: read.observation.graph,
      })
      return resolved.ok ? { ok: true, value: read.accepted.value.coverage } : resolved
    },
    async readCompletion(uw) {
      return (await ports.read(uw)).completion
    },
    reopen: (uw) => reopenUw(uw, ports),
    listReports: ports.listReports,
    closeLinked: ports.closeLinked,
    abandon: ports.abandon,
    adjustCauseDependency: ports.adjustCauseDependency,
    ...causes,
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
        : preparedResult(prepareCreateProposal(request, proposalPorts, { kind: 'operator-create' }))
    },
    async write(input) {
      const request = structuredClone(input)
      const prepared = await prepareExisting(request)
      if ('diagnostics' in prepared) return { status: 'refused', diagnostics: prepared.diagnostics }
      const parentDiagnostics = await insertionDiagnostics(prepared.proposal, ports)
      if (parentDiagnostics.length > 0) return { status: 'refused', diagnostics: parentDiagnostics }
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
      const prepared = prepareCreateProposal(request, proposalPorts, { kind: 'operator-create' })
      if ('diagnostics' in prepared) return { status: 'refused', diagnostics: prepared.diagnostics }
      const insertion = await insertionDiagnostics(prepared.proposal, ports)
      if (insertion.length > 0) return { status: 'refused', diagnostics: insertion }
      return confirmedResult(
        await ports.operator.executeConfirmed(prepared, (confirmation) =>
          commitCreate(request, prepared, confirmation, ports, ports.writer),
        ),
      )
    },
    acceptMaterial: ports.acceptMaterial,
    ...actionOperationMethods(ports),
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

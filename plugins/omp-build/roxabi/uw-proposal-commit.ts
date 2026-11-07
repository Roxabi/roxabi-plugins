import type {
  IssueWriteResult,
  IssueWriter,
  NativeIssueWritePlan,
} from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic } from '../engine/uw-diagnostics.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import type { CauseEffectGuard } from './uw-cause-guard.ts'
import type {
  PreparedUwProposal,
  UwCreateInput,
  UwOperationResult,
  UwProposal,
  UwProposalInput,
} from './uw-contract.ts'
import { issueRef, observation } from './uw-operation-observation.ts'
import type { UwOperationsPorts } from './uw-operations.ts'
import { insertionDiagnostics } from './uw-parent-admission.ts'
import { readAfterEffect } from './uw-post-effect-read.ts'
import { sourceBindingDiagnostics, staleWrite } from './uw-proposal-preparation.ts'

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
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

export async function commitWrite(
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
  const parentDiagnostics = await insertionDiagnostics(prepared.proposal, ports)
  if (parentDiagnostics.length > 0) return { status: 'refused', diagnostics: parentDiagnostics }
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
  if (created.status === 'partial') {
    const uw = ports.scopeOf(created.issue)
    return { status: 'partial', uw, diagnostics: writeDiagnostics(uw, created) }
  }
  return {
    status: 'refused',
    diagnostics:
      created.status === 'written'
        ? []
        : created.diagnostics.map(({ code, message }) => ({
            code,
            message,
            location: { kind: 'repository', repository: input.repository },
            related: [],
          })),
  }
}

export async function commitCreate(
  input: UwCreateInput,
  prepared: PreparedUwProposal,
  confirmation: OperatorConfirmationEvidence,
  ports: UwOperationsPorts,
  writer: IssueWriter,
  composedGuard?: CauseEffectGuard,
): Promise<UwOperationResult> {
  if (
    composedGuard !== undefined &&
    prepared.proposal.operation === 'create' &&
    'parentAcceptance' in prepared.proposal &&
    prepared.proposal.parentAcceptance !== null
  ) {
    await composedGuard({ primitive: 'create', created: null })
  } else {
    const parentDiagnostics = await insertionDiagnostics(prepared.proposal, ports)
    if (parentDiagnostics.length > 0) return { status: 'refused', diagnostics: parentDiagnostics }
  }
  const created = await writer.create(issuePlan(prepared.proposal))
  if (created.status === 'uncertain')
    return { status: 'uncertain', diagnostics: created.diagnostics.map(({ code, message }) => ({ code, message })) }
  if (created.status !== 'written') return creationFailure(input, created, ports)
  const uw = ports.scopeOf(created.observed.issue)
  const guardIdentityPublication = async (): Promise<UwOperationResult | null> => {
    if (composedGuard === undefined) return null
    try {
      await composedGuard({ primitive: 'patch', created: created.observed.issue })
      return null
    } catch (error) {
      return {
        status: 'partial',
        uw,
        diagnostics: [diagnostic(uw, 'cause-parent-guard', error instanceof Error ? error.message : String(error))],
      }
    }
  }
  if (prepared.proposal.allocation.assignments.length > 0) {
    const guardFailure = await guardIdentityPublication()
    if (guardFailure !== null) return guardFailure
    const published = await ports.publishIdentity({ uw, proposal: prepared, confirmation })
    if (published.status !== 'confirmed') return { status: 'partial', uw, diagnostics: published.diagnostics }
  }
  return readAfterEffect('created', uw, () => ports.readCreated(uw))
}

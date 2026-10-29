import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Gh, GitHubOptions } from '../adapters/github/types.ts'
import {
  buildRecord,
  buildSpecIdentityAllocation,
  buildSpecIdentityProposedRetirement,
  calculateTier,
  createGhIssueWritePorts,
  createIssueWriter,
  githubScope,
  normalizationJudgementSchema,
  prepareSpecAllocation,
  publishConfirmedWorkflowRecord,
  readComposedWorkflowHistory,
  renderIssueSpecBody,
  viewer,
} from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import type { UwDiagnostic, UwResult } from '../engine/uw-diagnostics.ts'
import type { SpecIdentityDraft } from '../engine/uw-identity.ts'
import type { OperatorConfirmationEvidence } from '../engine/uw-identity-schema.ts'
import { defaultGh } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import type { TrustedHostPluginPin } from './uw-action-contract.ts'
import type { OperatorPort, PreparedUwProposal, UwOperations, UwReadPort } from './uw-contract.ts'
import { createProductionActionPorts, createProductionDeliveryPorts } from './uw-input-readers.ts'
import { createInstalledMaterialOperations } from './uw-installed-material-operations.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { createUwOperations } from './uw-operations.ts'
import { createInstalledUwReadPort, UwGraphUnavailableError } from './uw-read-port.ts'

export type InstalledUwOperationsOptions = {
  cwd: string
  operator: OperatorPort
  gh?: Gh
  /** Test-only expected publisher assertion; production derives it from the authenticated viewer. */
  readAuthor?: string
  pluginPin?: TrustedHostPluginPin
  artifactsDir?: string | null
}

function diagnostic(uw: Scope, code: string, message: string): UwDiagnostic {
  return { code, message, location: { kind: 'native', uw, connection: 'state' }, related: [] }
}

function diagnostics(uw: Scope, values: readonly { code?: unknown; message?: unknown }[]): readonly UwDiagnostic[] {
  return values.map((value) =>
    diagnostic(
      uw,
      typeof value.code === 'string' ? value.code : 'uw-publication-unconfirmed',
      typeof value.message === 'string' ? value.message : 'UW publication was not confirmed',
    ),
  )
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

function scopeOf(issue: IssueRef): Scope {
  return githubScope(issue.repository, issue.number)
}

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
  const published = await publishConfirmedWorkflowRecord(record.value, own, github, null)
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
  reader: UwReadPort,
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

/** Compose the installed reader, writer, authenticated publisher, and one-command UI capability. */
export async function createInstalledUwOperations(input: InstalledUwOperationsOptions): Promise<UwOperations> {
  const gh = input.gh ?? defaultGh()
  const authenticatedAuthor = await viewer({ cwd: input.cwd, gh })
  if (input.readAuthor !== undefined && input.readAuthor !== authenticatedAuthor)
    throw new Error('uw-expected-author-mismatch')
  const github = withRoxabiGitHubPolicy({
    cwd: input.cwd,
    gh,
    readAuthor: authenticatedAuthor,
    writerLogin: authenticatedAuthor,
  })
  const reader = createInstalledUwReadPort({ cwd: input.cwd, gh, readAuthor: authenticatedAuthor })
  const completeReader = async (issue: IssueRef): Promise<IssueWriteObservation> => {
    const uw = scopeOf(issue)
    return rootObservation(uw, await reader.readUw(uw))
  }
  const writer = createIssueWriter(
    createGhIssueWritePorts({
      gh: (args) => gh(input.cwd, [...args]),
      read: completeReader,
    }),
  )
  const publishIdentity = async ({
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
    return retired.knownEffect ? confirmIdentityReadback(uw, retired.predecessor, reader) : { status: 'confirmed' }
  }
  const actionOptions = {
    cwd: input.cwd,
    gh,
    readAuthor: authenticatedAuthor,
    pluginPin: input.pluginPin,
    artifactsDir: input.artifactsDir,
  }
  const acceptMaterial = createInstalledMaterialOperations({ operator: input.operator, reader, github })
  return createUwOperations({
    read: reader.readUw,
    writer,
    operator: input.operator,
    prepareSpecAllocation,
    renderIssueSpecBody,
    calculateTier,
    parseNormalization(uw, value) {
      const parsed = normalizationJudgementSchema.safeParse(value)
      return parsed.success
        ? { ok: true, value: parsed.data }
        : {
            ok: false,
            diagnostics: [
              diagnostic(
                uw,
                'normalization-invalid',
                'Native normalization output does not match the required judgement',
              ),
            ],
          }
    },
    publishIdentity,
    acceptMaterial,
    scopeOf,
    actions: createProductionActionPorts(actionOptions),
    delivery: createProductionDeliveryPorts(actionOptions, reader.readUw),
  })
}

import type { IssueRef, IssueWriteObservation } from '../../issue-triage/skills/shared/domain/issue-write.ts'
import type { Gh } from '../adapters/github/types.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import {
  calculateTier,
  canonicalValueDigest,
  createGhIssueWritePorts,
  createIssueWriter,
  githubScope,
  normalizationJudgementSchema,
  prepareSpecAllocation,
  readUwCompletionObservation,
  readUwGraph,
  readWorkflowBinding,
  renderIssueSpecBody,
  resolveSpecEffective,
  viewer,
} from '../dist/contracts.js'
import type { ExternalRecordRef } from '../engine/record-references.ts'
import type { Scope } from '../engine/record-values.ts'
import { defaultGh } from './feature-engine.ts'
import type { NativeBatch, NativePort } from './fix-contract.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'
import { loadReviewClassCatalogues } from './review-class-catalogues.ts'
import { createUwAbandon } from './uw-abandon.ts'
import type { TrustedHostPluginPin, UwActionPorts } from './uw-action-contract.ts'
import { createCauseAdjudication } from './uw-cause-adjudication.ts'
import { createCauseAdjustment } from './uw-cause-adjustment.ts'
import { createCauseCreation } from './uw-cause-creation.ts'
import { guardedCauseWriter } from './uw-cause-guard.ts'
import { closeWriteFailure, readCloseProof } from './uw-close-linked.ts'
import type { CreatedUwReadPort, OperatorPort, UwOperationResult, UwOperations, UwReadPort } from './uw-contract.ts'
import { createIdentityPublisher } from './uw-identity-publication.ts'
import {
  createProductionActionPorts,
  createProductionDeliveryPorts,
  type ProductionReaderOptions,
} from './uw-input-readers.ts'
import { createInstalledMaterialOperations } from './uw-installed-material-operations.ts'
import { rootObservation } from './uw-installed-observation.ts'
import { diagnostic, listInstalledReports } from './uw-installed-reports.ts'
import { createUwOperations } from './uw-operations.ts'
import { createParentEngagementReadPort } from './uw-parent-engagement.ts'
import { guardParentInsertions, parentInsertionGuard } from './uw-parent-insertion.ts'
import { createInstalledUwReadPort, readCreatedUw } from './uw-read-port.ts'
import type { GitRunner } from './workflow-checkout.ts'

/** Context-owned native execution capability; absent in noninteractive consumers. */
export type UwNativeHost = {
  native: NativePort
  actionReaders: Readonly<{ git: GitRunner; createPorts(options: ProductionReaderOptions): UwActionPorts }>
  signal: AbortSignal
  onBatch(batch: NativeBatch): void
  /** Call from settlement callback; the returned fence resolves after settlement and exact mask release. */
  afterSettlement(batch: NativeBatch): Promise<void>
  onStarted(input: {
    creationOperationId: string
    assessmentStart: ExternalRecordRef & { kind: 'action-receipt' }
  }): void
}

export type InstalledUwOperationsOptions = {
  cwd: string
  operator: OperatorPort
  gh?: Gh
  /** Test-only expected publisher assertion; production derives it from the authenticated viewer. */
  readAuthor?: string
  pluginPin?: TrustedHostPluginPin
  artifactsDir?: string | null
  nativeHost?: UwNativeHost
}

function scopeOf(issue: IssueRef): Scope {
  return githubScope(issue.repository, issue.number)
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

type CloseLinkedRequest = Parameters<UwOperations['closeLinked']>[0]

async function checkCloseBinding(request: CloseLinkedRequest, github: GitHubOptions): Promise<boolean> {
  const bound = await readWorkflowBinding(request.pullRequest, github)
  if (!bound.ok || bound.value.binding.kind !== 'workflow-binding') return false
  const bindingRecord = bound.value.binding
  const binding = bindingRecord.payload
  return (
    sameScope(bound.value.history.source.scope, request.uw) &&
    sameScope(binding.mandate.scope, request.mandate.scope) &&
    request.completion.sources.some(
      (ref) =>
        ref.kind === 'workflow-binding' &&
        sameScope(ref.scope, request.pullRequest) &&
        ref.recordId === bindingRecord.recordId,
    ) &&
    binding.mandate.recordId === request.mandate.recordId &&
    binding.mandate.kind === request.mandate.kind &&
    bound.value.observed.head === request.completion.code.head
  )
}

async function confirmCloseReadback(
  request: CloseLinkedRequest,
  reader: UwReadPort,
  github: GitHubOptions,
): Promise<UwOperationResult> {
  try {
    const after = await reader.readUw(request.uw)
    const final = after.completion.completions.get(`${request.uw.repository}\0${request.uw.target}`)
    const native = rootObservation(request.uw, after).nativeState
    if (
      after.observation.status !== 'complete' ||
      native.state !== 'CLOSED' ||
      native.stateReason !== 'COMPLETED' ||
      final?.state !== 'complete' ||
      canonicalValueDigest(final) !== canonicalValueDigest(request.completion) ||
      !(await checkCloseBinding(request, github))
    )
      return {
        status: 'partial',
        uw: request.uw,
        diagnostics: [
          diagnostic(
            request.uw,
            'close-linked-readback-mismatch',
            'Close effect was written but fresh proof or binding changed',
          ),
        ],
      }
    return { status: 'written', value: after }
  } catch (error) {
    return {
      status: 'partial',
      uw: request.uw,
      diagnostics: [diagnostic(request.uw, 'close-linked-readback-failed', String(error))],
    }
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
  const createdReader: CreatedUwReadPort = {
    readUw: (uw) => readCreatedUw(uw, { cwd: input.cwd, gh, readAuthor: authenticatedAuthor }),
  }
  const completeReader = async (issue: IssueRef): Promise<IssueWriteObservation> => {
    const uw = scopeOf(issue)
    return rootObservation(uw, { graph: await readUwGraph(uw, github) })
  }
  const guardParent = parentInsertionGuard(createParentEngagementReadPort(github))
  const rawIssuePorts = createGhIssueWritePorts({
    gh: (args) => gh(input.cwd, [...args]),
    read: completeReader,
  })
  const issuePorts = guardParentInsertions(rawIssuePorts, guardParent)
  const writer = createIssueWriter(issuePorts)
  const publishIdentity = createIdentityPublisher(github, reader, createdReader)
  const actionOptions = {
    cwd: input.cwd,
    gh,
    readAuthor: authenticatedAuthor,
    pluginPin: input.pluginPin,
    artifactsDir: input.artifactsDir,
  }
  const acceptMaterial = createInstalledMaterialOperations({ operator: input.operator, reader, github })
  const closeLinked: UwOperations['closeLinked'] = async (request) => {
    const refused = (code: string, message: string) => ({
      status: 'refused' as const,
      diagnostics: [diagnostic(request.uw, code, message)],
    })
    if (
      !sameScope(request.uw, request.completion.uw) ||
      !sameScope(request.mandate.scope, request.uw) ||
      request.pullRequest.repository !== request.uw.repository ||
      !(await checkCloseBinding(request, github))
    )
      return refused(
        'close-linked-binding-changed',
        'The canonical landing binding no longer identifies this UW and reviewed head',
      )
    const proof = await readCloseProof(request, reader)
    if (!proof.ok) return proof.result
    const before = proof.read
    const expected = rootObservation(request.uw, before)
    if (expected.nativeState.state === 'CLOSED' && expected.nativeState.stateReason === 'COMPLETED')
      return { status: 'written', value: before }
    if (expected.nativeState.state !== 'OPEN')
      return refused('close-linked-state-invalid', 'The bound UW is not open or already completed')
    if (!(await checkCloseBinding(request, github)))
      return refused('close-linked-binding-changed', 'The canonical binding changed before the close effect')
    const written = await writer.setNativeState(expected.issue, { state: 'CLOSED', stateReason: 'COMPLETED' }, expected)
    if (written.status !== 'written') return closeWriteFailure(request.uw, written)
    return confirmCloseReadback(request, reader, github)
  }
  return createUwOperations({
    abandon: createUwAbandon({ operator: input.operator, reader, github }),
    closeLinked,
    read: reader.readUw,
    readCreated: createdReader.readUw,
    adjustCauseDependency: createCauseAdjustment({
      operator: input.operator,
      writer,
      github,
      readObservation: (uw, seeds) =>
        readUwCompletionObservation(
          uw,
          github,
          (histories) => loadReviewClassCatalogues({ histories, cwd: input.cwd, gh }),
          seeds,
        ),
    }),
    listReports: (uw) => listInstalledReports(uw, github),
    guardParent,
    writer,
    guardedWriter: (beforeEffect) => guardedCauseWriter(issuePorts, createIssueWriter, beforeEffect),
    causeOperations(backend) {
      return {
        adjudicateCause: createCauseAdjudication({ reader, github, operator: input.operator }),
        ...createCauseCreation({
          reader,
          nativeReader: createdReader,
          github,
          operator: input.operator,
          nativeHost: input.nativeHost,
          actionOptions,
          prepare: backend.prepare,
          commit: backend.commit,
          guardedWriter: (beforeEffect, composedParent) =>
            guardedCauseWriter(
              issuePorts,
              createIssueWriter,
              beforeEffect,
              composedParent === null ? undefined : { parent: composedParent, addChild: rawIssuePorts.addChild },
            ),
        }),
      }
    },
    operator: input.operator,
    prepareSpecAllocation,
    resolveSpecEffective,
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
    delivery: createProductionDeliveryPorts(actionOptions),
  })
}

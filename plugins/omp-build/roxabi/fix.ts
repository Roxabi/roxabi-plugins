import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  CanonicalRecord,
  DecodedHistory,
  ExternalRecordRef,
  GitHubOptions,
  RecordDraft,
  Scope,
  Submission,
} from '../dist/contracts.js'
import {
  assessFixMandate,
  buildFixOnlyMandate,
  buildRecord,
  composeChantier,
  decisionSchema,
  failedCheckEvidenceDigest,
  kindSchema,
  readNativePullRequestFacts,
  readWorkflowBinding,
  reconstructWorkflow,
  resolveAcceptedSpec,
  resolveBoundWork,
  shippedProductVersion,
  specDigest,
  validateDecisionBindings,
  validateRecordGraph,
} from '../dist/contracts.js'
import type { NativeBatch, NativeBatchController, NativeBatchResult, NativeTask } from '../omp/review-runtime'
import {
  type BoundCorrectionAction,
  type CorrectionActionBinding,
  type CorrectionEffectResult,
  createNativeCorrectionExecution,
} from './correction-execution'
import {
  type CorrectionOutcome,
  type DebtObligation,
  executeCorrectionPlan,
  groupCorrectionDebt,
} from './correction-policy'
import { createTrustedDebtFiling, type DebtFiling } from './debt-filing'
import {
  admitCorrectionCauses,
  type CauseAdmission,
  type CorrectionCause,
  type DebtEvidence,
  type FixFinding,
  type FixPolicy,
  type Json,
  orderSelectedCauses,
} from './fix-domain'
import { modelContributionPayload, nativeContributionPayload } from './native-contribution'
import { nativeFixProfileByAction } from './native-review-profiles'
import { defaultGit } from './workflow-checkout.ts'
import { readEffectiveFixConfig, readProofConfigPins, SUPPORTED_CONFIG_VERSIONS } from './workflow-config.ts'
export type FixActionResult<T> = { ok: true; value: T } | { ok: false; diagnostics: string[] }

export type FixScope = Scope

export type FixTarget = FixScope & {
  number: number
  kind: 'issue' | 'pull-request'
  state: 'open' | 'closed'
  candidateGitSHA: string | null
}
export type PublishBinding = {
  pushUrl: string
  publicationRepository: string
  localBranch: string
  destinationRef: string
  localHead: string
  expectedRemoteSHA: string | null
  defaultBranch: string
  observed: Json
}

export type TargetResolver = {
  resolveExplicit(reference: string): Promise<FixTarget | null>
  resolveContext(): Promise<FixTarget | null>
}

export type { NativeBatch, NativeBatchResult, NativeTask } from '../omp/review-runtime'
export type NativePort = Pick<NativeBatchController, 'activate' | 'active' | 'stopOwned'> & {
  announce(batch: NativeBatch): Promise<void>
}

export type ReviewStepResult = {
  action: 'fix' | 'review' | 'land' | 'stop'
  reason?: string
  reviews?: number
  remaining?: number
}

export type ReviewAuthority = {
  nextReviewStep(
    cwd: string,
    pr: number,
    options: { ciFailed?: boolean; reviewing?: boolean },
  ): Promise<ReviewStepResult>
}

type FixRecordKind =
  | 'contribution'
  | 'fix-request'
  | 'review-attempt'
  | 'decision'
  | 'correction-result'
  | 'falsification-result'
  | 'debt-receipt'
  | 'fix-result'
export type FixRecord = Extract<CanonicalRecord, { kind: FixRecordKind }>

export type RecordPublisher = { publish(record: FixRecord): Promise<FixActionResult<void>> }

export type FixIdentity = {
  runId: string
  operationId: string
  nextRecordId(kind: FixRecord['kind']): string
}

export type FixRequestInput = {
  cwd: string
  reference?: string
  contextTarget?: FixTarget
  rawOperatorRequest: Json
  scope: string
  reviewId?: string
  candidateGitSHA?: string
  policy?: FixPolicy
  identity: FixIdentity
  publishBinding: PublishBinding
  nativeTasks: NativeTask[]
  /** Same-scope confirmed mandate ids only. Cross-scope ids stay external refs, never inputs. */
  authorityInputs?: readonly string[]
  /** Production defaults to the trusted issue-triage boundary; tests may inject it. */
  debtFiling?: DebtFiling
}

export type PreparedFix = {
  target: FixTarget
  requestId: string
  inventoryId: string
  batch: NativeBatch
  sourceContributionId: string
  policy: FixPolicy
  cwd: string
  debtFiling: DebtFiling
  publishBinding: PublishBinding
}

function sameScopeAuthorityInputs(input: FixRequestInput): FixActionResult<readonly string[]> {
  const ids = input.authorityInputs ?? []
  const seen = new Set<string>()
  for (const id of ids) {
    if (!isRecordId(id) || seen.has(id)) return failure('fix-authority-input-invalid')
    seen.add(id)
  }
  return { ok: true, value: ids }
}

function failure<T>(...diagnostics: string[]): FixActionResult<T> {
  return { ok: false, diagnostics }
}
function validPublishBinding(binding: PublishBinding, target: FixTarget): boolean {
  return (
    target.candidateGitSHA !== null &&
    /^[0-9a-f]{40}$/.test(target.candidateGitSHA) &&
    binding.publicationRepository.trim().length > 0 &&
    binding.localHead === target.candidateGitSHA &&
    /^[0-9a-f]{40}$/.test(binding.localHead) &&
    binding.localBranch.trim().length > 0 &&
    binding.defaultBranch.trim().length > 0 &&
    /^refs\/heads\/.+/.test(binding.destinationRef) &&
    binding.destinationRef === `refs/heads/${binding.localBranch}` &&
    binding.localBranch !== binding.defaultBranch &&
    binding.pushUrl.trim().length > 0 &&
    (binding.expectedRemoteSHA === null || /^[0-9a-f]{40}$/.test(binding.expectedRemoteSHA))
  )
}

function isRecordId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
}

function validScope(scope: string): boolean {
  return scope.trim().length > 0 && scope.length <= 4_000
}
function targetMatches(left: FixTarget, right: FixTarget): boolean {
  return (
    left.repository === right.repository &&
    left.target === right.target &&
    left.number === right.number &&
    left.kind === right.kind
  )
}

function capturedSubmission(
  raw: Json,
  data: Json | null = null,
  attemptIndex = 0,
  partialText: string | null = null,
): Submission {
  return { attemptIndex, data, raw, partialText }
}

function record(
  identity: FixIdentity,
  scope: FixScope,
  kind: FixRecord['kind'],
  payload: Json,
  contextInputs: readonly string[] = [],
  recordId = identity.nextRecordId(kind),
): FixRecord {
  const draft = {
    version: 1,
    recordId,
    runId: identity.runId,
    operationId: `${identity.operationId}-${recordId}`,
    repository: scope.repository,
    target: scope.target,
    kind,
    payload,
  } as RecordDraft
  const parsed = buildRecord(draft, contextInputs)
  if (!parsed.ok)
    throw new Error(`fix canonical ${kind} rejected: ${parsed.diagnostics.map((item) => item.code).join(',')}`)
  return parsed.value as FixRecord
}

async function publish(publisher: RecordPublisher, item: FixRecord): Promise<FixActionResult<FixRecord>> {
  if (!isRecordId(item.recordId)) return failure('record-id-invalid')
  const saved = await publisher.publish(item)
  return saved.ok ? { ok: true, value: item } : saved
}

/** Refuses targetless, ambiguous, closed, and mismatched context before any durable write. */
export async function resolveFixTarget(
  input: Pick<FixRequestInput, 'reference' | 'contextTarget'>,
  resolver: TargetResolver,
): Promise<FixActionResult<FixTarget>> {
  const explicit = input.reference?.trim()
  const explicitTarget = explicit ? await resolver.resolveExplicit(explicit) : null
  const contextTarget = input.contextTarget ?? (explicit ? null : await resolver.resolveContext())
  if (!explicitTarget && !contextTarget) return failure('fix-target-required')
  if (explicit && !explicitTarget) return failure('fix-target-not-found')
  if (explicitTarget && contextTarget && !targetMatches(explicitTarget, contextTarget))
    return failure('fix-target-ambiguous')
  const target = explicitTarget ?? contextTarget
  if (!target) return failure('fix-target-required')
  if (target.state !== 'open') return failure('fix-target-closed')
  if (target.candidateGitSHA === null) return failure('fix-target-head-unknown')
  return { ok: true, value: target }
}

/** Every PR correction re-reads workflow authority; a stopped or CI-red PR cannot be bypassed by standalone intake. */
export async function admitReviewFix(
  target: FixTarget,
  cwd: string,
  reviewId: string | undefined,
  workflow: ReviewAuthority | undefined,
): Promise<FixActionResult<void>> {
  if (target.kind !== 'pull-request') return { ok: true, value: undefined }
  if (!workflow) return failure('review-fix-authority-unavailable')
  const next = await workflow.nextReviewStep(cwd, target.number, { reviewing: true })
  if (next.reason === 'ci-failed') return failure('ci-failed-requires-ci-correction')
  if (next.action === 'stop') return failure(`review-fix-not-authorized:${next.action}`)
  if (reviewId !== undefined && next.action !== 'fix') return failure(`review-fix-not-authorized:${next.action}`)
  return { ok: true, value: undefined }
}

/**
 * Starts the correction-only intake. It writes an operator contribution, a
 * landing:false request, and a correction inventory before native dispatch.
 */
export async function prepareStandaloneFix(
  input: FixRequestInput,
  resolver: TargetResolver,
  publisher: RecordPublisher,
  workflow?: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<PreparedFix>> {
  if (!validScope(input.scope)) return failure('fix-scope-invalid')
  const policy: FixPolicy = input.policy ?? { version: 'baseline' }
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const resolved = await resolveFixTarget(input, resolver)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (input.candidateGitSHA && input.candidateGitSHA !== target.candidateGitSHA) return failure('fix-head-mismatch')
  if (!validPublishBinding(input.publishBinding, target)) return failure('fix-publish-binding-invalid')
  if (policy.version === 'evidence-v1' && policy.acceptanceRef.trim().length === 0)
    return failure('candidate-acceptance-required')
  const authority = await admitReviewFix(target, input.cwd, input.reviewId, workflow)
  if (!authority.ok) return authority
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const linkedAuthority = sameScopeAuthorityInputs(input)
  if (!linkedAuthority.ok) return linkedAuthority
  if (input.nativeTasks.length === 0) return failure('fix-intake-tasks-required')
  const taskNames = new Set<string>()
  if (
    input.nativeTasks.some((task) => {
      const duplicate = taskNames.has(task.name)
      taskNames.add(task.name)
      return (
        duplicate ||
        !isRecordId(task.name) ||
        task.agent.trim().length === 0 ||
        task.task.trim().length === 0 ||
        task.solutionSpace.trim().length === 0
      )
    })
  )
    return failure('fix-intake-tasks-invalid')

  const source = record(input.identity, target, 'contribution', {
    content: 'operator-request',
    inventoryId: null,
    host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
    rawAttempts: [
      capturedSubmission({
        operatorRequest: input.rawOperatorRequest,
        publishBinding: input.publishBinding,
        candidateGitSHA: target.candidateGitSHA,
      }),
    ],
    native: null,
    structured: null,
    findings: null,
  })
  const savedSource = await publish(publisher, source)
  if (!savedSource.ok) return savedSource
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')

  const request = record(
    input.identity,
    target,
    'fix-request',
    {
      requestContributionId: source.recordId,
      existingReviewId: input.reviewId ?? null,
      scope: input.scope,
      landing: false,
    },
    [source.recordId, ...linkedAuthority.value],
  )
  const savedRequest = await publish(publisher, request)
  if (!savedRequest.ok) return savedRequest
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')

  const inventoryId = input.identity.nextRecordId('review-attempt')
  const inventory = record(
    input.identity,
    target,
    'review-attempt',
    {
      rootAttemptId: inventoryId,
      candidateGitSHA: target.candidateGitSHA,
      input: null,
      stage: 'initial',
      purpose: 'correction',
      requestId: request.recordId,
      policy,
      slots: input.nativeTasks.map((task) => ({
        slotId: task.name,
        phase: 'intake',
        role: task.agent,
        chunk: null,
        required: true,
        output: 'findings',
        classId: null,
        sourceFindingIds: [],
      })),
    },
    [request.recordId],
    inventoryId,
  )
  const savedInventory = await publish(publisher, inventory)
  if (!savedInventory.ok) return savedInventory

  return {
    ok: true,
    value: {
      target,
      requestId: request.recordId,
      inventoryId: inventory.recordId,
      sourceContributionId: source.recordId,
      policy,
      cwd: input.cwd,
      publishBinding: input.publishBinding,
      debtFiling: input.debtFiling ?? createTrustedDebtFiling(),
      batch: {
        operationId: input.identity.operationId,
        tasks: {
          context: `Correction intake for ${target.target}; request ${request.recordId}; scope: ${input.scope}`,
          tasks: input.nativeTasks,
        },
      },
    },
  }
}

/** Review-driven fixes consume the already-confirmed decision unchanged: no intake or synthesis. */
export async function prepareReviewBoundFix(
  input: FixRequestInput & { reviewId: string },
  resolver: TargetResolver,
  publisher: RecordPublisher,
  workflow: ReviewAuthority,
  signal?: AbortSignal,
): Promise<FixActionResult<PreparedFix>> {
  const linkedAuthority = sameScopeAuthorityInputs(input)
  if (!linkedAuthority.ok) return linkedAuthority
  if (!validScope(input.scope) || !isRecordId(input.reviewId)) return failure('review-fix-input-invalid')
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const resolved = await resolveFixTarget(input, resolver)
  if (!resolved.ok) return resolved
  const target = resolved.value
  if (input.candidateGitSHA && input.candidateGitSHA !== target.candidateGitSHA) return failure('fix-head-mismatch')
  if (!validPublishBinding(input.publishBinding, target)) return failure('fix-publish-binding-invalid')
  const authority = await admitReviewFix(target, input.cwd, input.reviewId, workflow)
  if (!authority.ok) return authority
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const source = record(input.identity, target, 'contribution', {
    content: 'operator-request',
    inventoryId: null,
    host: { origin: 'operator', phase: 'fix', role: 'operator', slotId: null, chunk: null, childId: null },
    rawAttempts: [
      capturedSubmission({
        operatorRequest: input.rawOperatorRequest,
        publishBinding: input.publishBinding,
        candidateGitSHA: target.candidateGitSHA,
      }),
    ],
    native: null,
    structured: null,
    findings: null,
  })
  const savedSource = await publish(publisher, source)
  if (!savedSource.ok) return savedSource
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const request = record(
    input.identity,
    target,
    'fix-request',
    {
      requestContributionId: source.recordId,
      existingReviewId: input.reviewId,
      scope: input.scope,
      landing: false,
    },
    [source.recordId, input.reviewId, ...linkedAuthority.value],
  )
  const savedRequest = await publish(publisher, request)
  if (!savedRequest.ok) return savedRequest
  return {
    ok: true,
    value: {
      target,
      requestId: request.recordId,
      inventoryId: input.reviewId,
      sourceContributionId: source.recordId,
      policy: input.policy ?? { version: 'baseline' },
      cwd: input.cwd,
      publishBinding: input.publishBinding,
      debtFiling: input.debtFiling ?? createTrustedDebtFiling(),
      batch: {
        operationId: input.identity.operationId,
        tasks: { context: 'review-bound correction has no intake batch', tasks: [] },
      },
    },
  }
}

export type FixIntakePublication = {
  records: FixRecord[]
  complete: boolean
  diagnostics: string[]
}

function taskSlot(
  task: NativeTask,
  phase: 'intake' | 'synthesis' | 'fix' | 'falsification',
  output: 'findings' | 'decision' | 'action-result',
) {
  return {
    slotId: task.name,
    phase,
    role: task.agent,
    chunk: null,
    required: true,
    output,
    classId: null,
    sourceFindingIds: [],
  }
}

async function publishNativeContributions(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  inventoryId: string,
  tasks: readonly NativeTask[],
  phase: 'intake' | 'synthesis' | 'fix' | 'falsification',
  output: 'findings' | 'decision' | 'action-result',
  contextInputs: readonly string[],
  result: NativeBatchResult,
): Promise<FixActionResult<FixRecord[]>> {
  if (result.batch.operationId !== identity.operationId) return failure('native-batch-operation-mismatch')
  const byExpectedId = new Map(tasks.map((task) => [task.name, taskSlot(task, phase, output)]))
  const observedExpectedIds = new Set<string>()
  const observedChildIds = new Set<string>()
  const diagnostics: string[] = []
  const records: FixRecord[] = []
  for (const child of result.children) {
    const expectedId = child.expectedId
    const knownExpected = expectedId !== null && byExpectedId.has(expectedId) && !observedExpectedIds.has(expectedId)
    const knownChild = child.id !== null && !observedChildIds.has(child.id)
    if (child.id === null) diagnostics.push('native-child-id-missing')
    else if (observedChildIds.has(child.id)) diagnostics.push(`native-child-id-duplicate:${child.id}`)
    if (expectedId === null) diagnostics.push('native-child-association-missing')
    else if (!byExpectedId.has(expectedId)) diagnostics.push(`native-slot-unknown:${expectedId}`)
    else if (observedExpectedIds.has(expectedId)) diagnostics.push(`native-slot-duplicate:${expectedId}`)
    if (child.id !== null) observedChildIds.add(child.id)
    if (expectedId !== null) observedExpectedIds.add(expectedId)
    const contributionId = identity.nextRecordId('contribution')
    const contribution = record(
      identity,
      prepared.target,
      'contribution',
      nativeContributionPayload(
        knownExpected && knownChild ? (byExpectedId.get(expectedId as string) ?? null) : null,
        child,
        inventoryId,
        contributionId,
        output,
      ),
      contextInputs,
      contributionId,
    )
    const saved = await publish(publisher, contribution)
    if (saved.ok) records.push(saved.value)
    else diagnostics.push(...saved.diagnostics.map((diagnostic) => `native-contribution-publish:${diagnostic}`))
  }
  for (const task of tasks)
    if (!observedExpectedIds.has(task.name)) diagnostics.push(`native-slot-missing:${task.name}`)
  if (!result.complete) diagnostics.push('native-batch-incomplete')
  return diagnostics.some((diagnostic) => diagnostic.startsWith('native-contribution-publish:'))
    ? failure(...diagnostics)
    : { ok: true, value: records }
}

function assessFixIntake(prepared: PreparedFix, result: NativeBatchResult, records: FixRecord[]): FixIntakePublication {
  const expected = new Set(prepared.batch.tasks.tasks.map((task) => task.name))
  const seenExpected = new Set(
    result.children.map((child) => child.expectedId).filter((id): id is string => id !== null),
  )
  const diagnostics = [
    ...[...expected].filter((id) => !seenExpected.has(id)).map((id) => `native-intake-slot-missing:${id}`),
    ...result.children.flatMap((child, index) => [
      ...(child.id === null ? ['native-intake-child-id-missing'] : []),
      ...(child.expectedId === null ? ['native-intake-child-association-missing'] : []),
      ...(child.expectedId !== null && !expected.has(child.expectedId)
        ? [`native-intake-slot-unknown:${child.expectedId}`]
        : []),
      ...(child.expectedId !== null &&
      result.children.findIndex((candidate) => candidate.expectedId === child.expectedId) !== index
        ? [`native-intake-slot-duplicate:${child.expectedId}`]
        : []),
      ...(child.id !== null && result.children.findIndex((candidate) => candidate.id === child.id) !== index
        ? [`native-intake-child-id-duplicate:${child.id}`]
        : []),
    ]),
    ...(result.complete ? [] : ['native-intake-incomplete']),
  ]
  return { records, complete: diagnostics.length === 0, diagnostics }
}

/** Preserve every native original before refusing incomplete, duplicate, or unknown intake results. */
export async function publishFixIntake(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  result: NativeBatchResult,
): Promise<FixActionResult<FixIntakePublication>> {
  const records = await publishNativeContributions(
    prepared,
    identity,
    publisher,
    prepared.inventoryId,
    prepared.batch.tasks.tasks,
    'intake',
    'findings',
    [prepared.inventoryId],
    result,
  )
  return records.ok ? { ok: true, value: assessFixIntake(prepared, result, records.value) } : records
}

export type PreparedCorrectionSynthesis = {
  inventoryId: string
  sourceContributionIds: string[]
  batch: NativeBatch
}

/** Synthesis receives full confirmed findings and their immutable raw provenance, not opaque IDs. */
export async function prepareCorrectionSynthesis(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  sourceContributions: readonly FixRecord[],
  task: NativeTask,
): Promise<FixActionResult<PreparedCorrectionSynthesis>> {
  const sourceContributionIds = sourceContributions.map((record) => record.recordId)
  if (
    sourceContributionIds.length === 0 ||
    sourceContributionIds.some((id) => !isRecordId(id)) ||
    new Set(sourceContributionIds).size !== sourceContributionIds.length
  ) {
    return failure('correction-synthesis-sources-invalid')
  }
  if (
    !isRecordId(task.name) ||
    task.agent.trim().length === 0 ||
    task.task.trim().length === 0 ||
    task.solutionSpace.trim().length === 0
  ) {
    return failure('correction-synthesis-task-invalid')
  }
  const inventoryId = identity.nextRecordId('review-attempt')
  const inventory = record(
    identity,
    prepared.target,
    'review-attempt',
    {
      rootAttemptId: prepared.inventoryId,
      candidateGitSHA: prepared.target.candidateGitSHA,
      input: null,
      stage: 'synthesis',
      purpose: 'correction',
      policy: prepared.policy,
      slots: [taskSlot(task, 'synthesis', 'decision')],
    },
    [prepared.inventoryId, ...sourceContributionIds],
    inventoryId,
  )
  const saved = await publish(publisher, inventory)
  if (!saved.ok) return saved
  return {
    ok: true,
    value: {
      inventoryId,
      sourceContributionIds,
      batch: {
        operationId: identity.operationId,
        tasks: {
          context: `Correction synthesis for ${prepared.target.target}; policy ${JSON.stringify(prepared.policy)}; confirmed contributions ${JSON.stringify(sourceContributions.map((record) => ({ recordId: record.recordId, payload: record.kind === 'contribution' ? modelContributionPayload(record.payload) : record.payload })))}`,
          tasks: [task],
        },
      },
    },
  }
}
type PreservedSynthesis = { result: NativeBatchResult; contributions: FixRecord[] }

function finalizeCorrectionSynthesis(
  prepared: PreparedFix,
  synthesis: PreparedCorrectionSynthesis,
  identity: FixIdentity,
  publisher: RecordPublisher,
  preserved: PreservedSynthesis,
  signal?: AbortSignal,
): Promise<FixActionResult<FixRecord>> {
  if (signal?.aborted) return Promise.resolve(failure('fix-run-interrupted-cleanup-unproven'))
  const expected = synthesis.batch.tasks.tasks[0]
  const child = preserved.result.children[0]
  const contribution = preserved.contributions[0]
  if (
    !expected ||
    preserved.result.children.length !== 1 ||
    !child ||
    !contribution ||
    child.id === null ||
    child.expectedId !== expected.name
  )
    return Promise.resolve(failure('correction-synthesis-identity-mismatch'))
  if (!preserved.result.complete || !child.usable || child.structured === null)
    return Promise.resolve(failure('correction-synthesis-incomplete'))
  const judgment = decisionSchema.safeParse(child.structured)
  if (!judgment.success || judgment.data.purpose !== 'correction')
    return Promise.resolve(failure('correction-synthesis-decision-invalid'))
  const sources = judgment.data.sourceContributionIds
  if (
    sources.length !== synthesis.sourceContributionIds.length ||
    new Set(sources).size !== sources.length ||
    sources.some((id) => !synthesis.sourceContributionIds.includes(id))
  ) {
    return Promise.resolve(failure('correction-synthesis-sources-mismatch'))
  }
  return publish(
    publisher,
    record(
      identity,
      prepared.target,
      'decision',
      {
        originalContributionId: contribution.recordId,
        judgment: child.structured,
      },
      [synthesis.inventoryId, contribution.recordId, ...synthesis.sourceContributionIds],
    ),
  )
}

/** Retain every synthesis submission before strict decision admission. */
export async function publishCorrectionSynthesis(
  prepared: PreparedFix,
  synthesis: PreparedCorrectionSynthesis,
  identity: FixIdentity,
  publisher: RecordPublisher,
  result: NativeBatchResult,
): Promise<FixActionResult<FixRecord>> {
  const contributions = await publishNativeContributions(
    prepared,
    identity,
    publisher,
    synthesis.inventoryId,
    synthesis.batch.tasks.tasks,
    'synthesis',
    'decision',
    [synthesis.inventoryId, ...synthesis.sourceContributionIds],
    result,
  )
  return contributions.ok
    ? finalizeCorrectionSynthesis(prepared, synthesis, identity, publisher, {
        result,
        contributions: contributions.value,
      })
    : contributions
}

function actionTask(
  name: string,
  agent: string,
  task: string,
  solutionSpace: string,
  proofEvidence?: NativeTask['proofEvidence'],
): NativeTask {
  return { name, agent, task, solutionSpace, ...(proofEvidence === undefined ? {} : { proofEvidence }) }
}

export type FixWorkflowRuntime = {
  signal: AbortSignal
  onBatch(batch: NativeBatch): void
  onStarted(batch: NativeBatch): void
  /** Re-read authority before the next native dispatch. A refusal inhibits that continuation only. */
  beforeContinuation?(): Promise<FixActionResult<void>>
  bindContinuation?(check: () => Promise<FixActionResult<void>>): void
}

function stopped<T>(runtime: FixWorkflowRuntime): FixActionResult<T> | null {
  return runtime.signal.aborted ? failure('fix-run-interrupted-cleanup-unproven') : null
}

async function dispatchNativeBatch<T>(
  native: NativePort,
  batch: NativeBatch,
  runtime: FixWorkflowRuntime,
  conserve: (result: NativeBatchResult) => Promise<FixActionResult<T>>,
  accept: boolean,
): Promise<FixActionResult<T>> {
  const fenced = stopped<T>(runtime)
  if (fenced) return fenced
  if (runtime.beforeContinuation) {
    const allowed = await runtime.beforeContinuation()
    if (!allowed.ok) return allowed
  }
  const stillFenced = stopped<T>(runtime)
  if (stillFenced) return stillFenced
  if (native.active() !== null) return failure('native-batch-already-active')
  const deferred = Promise.withResolvers<FixActionResult<T>>()
  const aborted = Promise.withResolvers<void>()
  let settled = false
  const settle = (value: FixActionResult<T>) => {
    if (!settled) {
      settled = true
      deferred.resolve(value)
    }
  }
  const onAbort = () => {
    settle(failure('fix-run-interrupted-cleanup-unproven'))
    aborted.resolve()
  }
  runtime.signal.addEventListener('abort', onAbort, { once: true })
  try {
    native.activate(batch, {
      onComplete: async (result) => {
        try {
          const conserved = await conserve(result)
          if (!conserved.ok) {
            settle(conserved)
            throw new Error(`native-batch-conservation-failed:${conserved.diagnostics.join(';')}`)
          }
          settle(conserved)
        } catch (error) {
          settle(failure(`native-batch-conservation-failed:${error instanceof Error ? error.message : String(error)}`))
          throw error
        }
      },
      onStop: async (reason, result) => {
        if (result === null) {
          settle(failure(`native-batch-stopped:${reason}`))
          return
        }
        try {
          const conserved = await conserve(result)
          if (!conserved.ok) {
            settle(conserved)
            throw new Error(`native-batch-conservation-failed:${conserved.diagnostics.join(';')}`)
          }
          settle(failure(`native-batch-stopped:${reason}`))
        } catch (error) {
          settle(failure(`native-batch-conservation-failed:${error instanceof Error ? error.message : String(error)}`))
          throw error
        }
      },
    })
    runtime.onBatch(batch)
    if (runtime.signal.aborted) {
      void native.stopOwned(batch, 'fix-run-interrupted').catch(() => undefined)
      return failure('fix-run-interrupted-cleanup-unproven')
    }
    const announced = native.announce(batch)
    void announced.catch(() => undefined)
    await Promise.race([announced, aborted.promise])
    if (runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
    if (accept) runtime.onStarted(batch)
    return await deferred.promise
  } catch (error) {
    const announcement = `native-batch-announce-failed:${error instanceof Error ? error.message : String(error)}`
    try {
      await native.stopOwned(batch, 'native-batch-announce-failed')
    } catch (archival) {
      return failure(
        announcement,
        `native-batch-archive-failed:${archival instanceof Error ? archival.message : String(archival)}`,
      )
    }
    return failure(announcement)
  } finally {
    runtime.signal.removeEventListener('abort', onAbort)
  }
}

async function bindCorrectionAction(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  runtime: FixWorkflowRuntime,
  binding: CorrectionActionBinding,
): Promise<CorrectionEffectResult<BoundCorrectionAction>> {
  if (runtime.signal.aborted) return { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] }
  const inventoryId = identity.nextRecordId('review-attempt')
  const actionInputs = [...new Set([prepared.requestId, decisionId, ...binding.contextRefs])]
  const inventory = record(
    identity,
    prepared.target,
    'review-attempt',
    {
      rootAttemptId: inventoryId,
      candidateGitSHA: prepared.target.candidateGitSHA,
      input: null,
      stage: 'initial',
      purpose: 'correction',
      requestId: prepared.requestId,
      policy: prepared.policy,
      slots: [
        taskSlot(
          binding.task,
          binding.phase === 'falsify' || binding.phase === 'restore-proof' ? 'falsification' : 'fix',
          'action-result',
        ),
      ],
    },
    actionInputs,
    inventoryId,
  )
  const saved = await publish(publisher, inventory)
  if (!saved.ok) return { ok: false, kind: 'terminal', diagnostics: saved.diagnostics }
  const batch: NativeBatch = {
    operationId: identity.operationId,
    tasks: {
      context: `Correction ${binding.phase} for decision ${decisionId}, cause ${binding.causeId}; immutable context ${binding.contextRefs.join(',')}`,
      tasks: [binding.task],
    },
  }
  runtime.onBatch(batch)
  return {
    ok: true,
    value: {
      batch,
      async conserve(result) {
        try {
          const preserved = await publishNativeContributions(
            prepared,
            identity,
            publisher,
            inventoryId,
            [binding.task],
            binding.phase === 'falsify' || binding.phase === 'restore-proof' ? 'falsification' : 'fix',
            'action-result',
            [inventoryId, ...actionInputs],
            result,
          )
          return preserved.ok
            ? { ok: true, value: { contributionIds: preserved.value.map((contribution) => contribution.recordId) } }
            : { ok: false, kind: 'terminal', diagnostics: preserved.diagnostics }
        } catch (error) {
          return {
            ok: false,
            kind: 'terminal',
            diagnostics: [
              `native-action-conservation-failed:${error instanceof Error ? error.message : String(error)}`,
            ],
          }
        }
      },
    },
  }
}

type PublishedFixArtifacts = {
  correctionIds: string[]
  falsificationIds: string[]
  debtIds: string[]
}

async function publishFixArtifacts(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  outcomes: readonly CorrectionOutcome[],
  debt: readonly DebtObligation[],
  signal?: AbortSignal,
): Promise<FixActionResult<PublishedFixArtifacts>> {
  const correctionIds: string[] = []
  const falsificationIds: string[] = []
  const debtIds: string[] = []
  const diagnostics: string[] = []
  if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  for (const outcome of outcomes) {
    if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
    const receiptInputs = [...new Set([decisionId, prepared.requestId, ...outcome.sourceContributionIds])]
    const correction = record(
      identity,
      prepared.target,
      'correction-result',
      {
        decisionId,
        causeId: outcome.cause.id,
        attempt: outcome.attempt,
        outcome: outcome.outcome,
        commitSHAs: [...outcome.commitSHAs],
        raw: {
          execution: outcome.execution,
          terminalFailure: outcome.terminalFailure,
          effectsCleanup: outcome.terminalFailure ? 'unproven' : 'not-required',
          outcome: outcome.raw,
          applyAttempts: outcome.applyAttempts.map((attempt) => ({
            round: attempt.round,
            attempt: attempt.attempt,
            result: attempt.result,
            raw: attempt.raw,
            sourceContributionIds: [...attempt.sourceContributionIds],
          })),
        },
      },
      receiptInputs,
    )
    const saved = await publish(publisher, correction)
    if (!saved.ok) {
      diagnostics.push(...saved.diagnostics)
      continue
    }
    correctionIds.push(saved.value.recordId)
    if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
    if (outcome.falsification !== null) {
      const falsification = record(
        identity,
        prepared.target,
        'falsification-result',
        {
          correctionResultId: correction.recordId,
          result: outcome.falsification.result,
          notes: outcome.falsification.notes,
          raw: outcome.falsification.raw,
        },
        [...new Set([correction.recordId, ...outcome.sourceContributionIds])],
      )
      const savedFalsification = await publish(publisher, falsification)
      if (savedFalsification.ok) falsificationIds.push(savedFalsification.value.recordId)
      else diagnostics.push(...savedFalsification.diagnostics)
    }
  }
  for (const obligation of debt) {
    if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
    const receiptId = identity.nextRecordId('debt-receipt')
    const evidence = obligation.evidence[0]
    if (evidence === undefined) {
      diagnostics.push(`debt-evidence-missing:${obligation.kind}`)
      continue
    }
    const filing = obligation.issueAdmitted
      ? await prepared.debtFiling.file({
          decisionId,
          receiptId,
          target: prepared.target,
          findingIds: obligation.findingIds,
          causeIds: obligation.causeIds,
          evidence,
          retentionDiagnostics: obligation.retentionDiagnostics,
          acceptedEvidencePolicyRef: prepared.policy.version === 'evidence-v1' ? prepared.policy.acceptanceRef : null,
          fixRequestId: prepared.requestId,
        })
      : null
    if (signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
    const disposition: 'filed' | 'deferred' | 'retained' = !obligation.issueAdmitted
      ? 'retained'
      : filing?.ok
        ? 'filed'
        : 'deferred'
    const debtRecord = record(
      identity,
      prepared.target,
      'debt-receipt',
      {
        decisionId,
        findingIds: [...obligation.findingIds],
        causeIds: [...obligation.causeIds],
        disposition,
        target: filing?.ok ? filing.value.target : null,
        evidence: {
          admissionEvidence: evidence.evidence,
          issueAdmitted: obligation.issueAdmitted,
          filing: filing === null ? null : filing.ok ? filing.value.raw : { diagnostics: filing.diagnostics },
        },
      },
      [decisionId, prepared.requestId],
      receiptId,
    )
    const saved = await publish(publisher, debtRecord)
    if (saved.ok) debtIds.push(saved.value.recordId)
    else diagnostics.push(...saved.diagnostics)
  }
  return diagnostics.length === 0
    ? { ok: true, value: { correctionIds, falsificationIds, debtIds } }
    : failure(...diagnostics)
}

function publishFinalFixResult(
  prepared: PreparedFix,
  identity: FixIdentity,
  publisher: RecordPublisher,
  decisionId: string,
  artifacts: PublishedFixArtifacts,
  candidateGitSHA: string,
): Promise<FixActionResult<FixRecord>> {
  if (!isRecordId(decisionId) || !/^[0-9a-f]{40}$/.test(candidateGitSHA))
    return Promise.resolve(failure('fix-result-binding-invalid'))
  return publish(
    publisher,
    record(
      identity,
      prepared.target,
      'fix-result',
      {
        requestId: prepared.requestId,
        decisionId,
        candidateGitSHA,
        correctionResultIds: artifacts.correctionIds,
        falsificationResultIds: artifacts.falsificationIds,
        debtReceiptIds: artifacts.debtIds,
      },
      [prepared.requestId, decisionId, ...artifacts.correctionIds, ...artifacts.falsificationIds, ...artifacts.debtIds],
    ),
  )
}

export function selectedCorrectionOrder(
  policy: FixPolicy,
  causes: readonly CorrectionCause[],
  findings: readonly FixFinding[],
): CauseAdmission[] {
  return orderSelectedCauses(admitCorrectionCauses(policy, causes, findings))
}

export type DefaultFixRequest = Omit<FixRequestInput, 'nativeTasks'> & {
  debtEvidence?: DebtEvidence
}

export type DefaultFixWorkflow = {
  resolver: TargetResolver
  publisher: RecordPublisher
  readHistory(): Promise<DecodedHistory>
  workflow?: ReviewAuthority
  native: NativePort
  runtime: FixWorkflowRuntime
}

const defaultDebtEvidence: DebtEvidence = {
  important: 'unknown',
  urgent: 'unknown',
  tooLarge: 'unknown',
  evidence: { source: 'fix-workflow', status: 'unqualified' },
}
function admitDecisionExecution(
  decision: Extract<FixRecord, { kind: 'decision' }>,
  history: DecodedHistory,
): FixActionResult<void> {
  const graph = validateRecordGraph(history)
  if (!graph.ok)
    return failure(
      `correction-execution-admission-invalid:${graph.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  const bindings = validateDecisionBindings(decision, history)
  if (!bindings.admissible)
    return failure(
      `correction-synthesis-bindings-invalid:${bindings.diagnostics.map((diagnostic) => diagnostic.code).join(',')}`,
    )
  return { ok: true, value: undefined }
}

function defaultIntakeTask(input: DefaultFixRequest): NativeTask {
  return actionTask(
    'fix-intake',
    nativeFixProfileByAction.intake,
    `Inspect only correction scope ${input.scope} for ${input.reference ?? input.contextTarget?.target ?? 'bound target'}. Preserve each original finding unchanged and return structured findings; do not classify final labels, merge causes, edit, commit, push, arm, or land.`,
    'bounded correction evidence intake',
  )
}

function defaultSynthesisTask(): NativeTask {
  return actionTask(
    'fix-synthesis',
    nativeFixProfileByAction.synthesis,
    'Synthesize one correction-purpose decision from the supplied complete contribution payloads. Preserve source IDs, original raw associations, exact policy and seven-field causes; do not edit, commit, push, arm, or land.',
    'one correction decision from admitted intake records',
  )
}

async function executeDecision(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'native' | 'publisher' | 'runtime'>,
  identity: FixIdentity,
  debtEvidence: DebtEvidence,
): Promise<FixActionResult<FixRecord>> {
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const judgment = decision.payload.judgment
  const findings: FixFinding[] = judgment.findings.map((finding) => ({
    id: finding.id,
    label: finding.label,
    usable: finding.state === 'usable',
  }))
  const admissions = selectedCorrectionOrder(prepared.policy, judgment.causes, findings)
  const executor = createNativeCorrectionExecution({
    native: product.native,
    prepared,
    operationId: identity.operationId,
    decisionId: decision.recordId,
    authorizeContinuation: async () => {
      const allowed =
        product.runtime.beforeContinuation === undefined
          ? { ok: true as const, value: undefined }
          : await product.runtime.beforeContinuation()
      return allowed.ok ? { ok: true as const, value: undefined } : allowed
    },
    signal: product.runtime.signal,
    bindAction: (binding) =>
      bindCorrectionAction(prepared, identity, product.publisher, decision.recordId, product.runtime, binding),
    onStarted: async (batch) => {
      if (product.runtime.signal.aborted) return { ok: false, kind: 'terminal', diagnostics: ['fix-run-aborted'] }
      product.runtime.onStarted(batch)
      return { ok: true, value: undefined }
    },
  })
  const plan = await executeCorrectionPlan(admissions, executor)
  const debt = groupCorrectionDebt({
    policy: prepared.policy,
    findings,
    causes: judgment.causes,
    admissions,
    outcomes: plan.outcomes,
    retainedObligations: plan.retainedObligations,
    evidenceFor: () => debtEvidence,
  })
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const artifacts = await publishFixArtifacts(
    prepared,
    identity,
    product.publisher,
    decision.recordId,
    plan.outcomes,
    debt,
    product.runtime.signal,
  )
  if (!artifacts.ok) return artifacts
  if (!plan.ok) return failure(...(plan.terminalDiagnostics ?? ['correction-terminal-cleanup-unproven']))
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const applied = plan.outcomes.some((outcome) => outcome.outcome === 'applied')
  if (applied) {
    const pushed = await executor.push()
    if (!pushed.ok) return failure(...pushed.diagnostics)
    if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  }
  const head = await executor.head()
  if (!head.ok) return failure(...head.diagnostics)
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return publishFinalFixResult(prepared, identity, product.publisher, decision.recordId, artifacts.value, head.value)
}

/** Product default: dispatch sequential native intake and synthesis outside SDK callbacks, then apply policy. */
export async function runDefaultFixWorkflow(
  product: DefaultFixWorkflow,
  input: DefaultFixRequest,
): Promise<FixActionResult<FixRecord>> {
  const prepared = await prepareStandaloneFix(
    { ...input, nativeTasks: [defaultIntakeTask(input)] },
    product.resolver,
    product.publisher,
    product.workflow,
    product.runtime.signal,
  )
  if (!prepared.ok) return prepared
  const preservedIntake = await dispatchNativeBatch<{ result: NativeBatchResult; records: FixRecord[] }>(
    product.native,
    prepared.value.batch,
    product.runtime,
    (result) =>
      publishNativeContributions(
        prepared.value,
        input.identity,
        product.publisher,
        prepared.value.inventoryId,
        prepared.value.batch.tasks.tasks,
        'intake',
        'findings',
        [prepared.value.inventoryId],
        result,
      ).then((contributions) =>
        contributions.ok ? { ok: true, value: { result, records: contributions.value } } : contributions,
      ),
    true,
  )
  if (!preservedIntake.ok) return preservedIntake
  const intake = assessFixIntake(prepared.value, preservedIntake.value.result, preservedIntake.value.records)
  if (!intake.complete) return failure(`native-intake-incomplete:${intake.diagnostics.join(';')}`)
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const synthesis = await prepareCorrectionSynthesis(
    prepared.value,
    input.identity,
    product.publisher,
    intake.records,
    defaultSynthesisTask(),
  )
  if (!synthesis.ok) return synthesis
  const preservedSynthesis = await dispatchNativeBatch<PreservedSynthesis>(
    product.native,
    synthesis.value.batch,
    product.runtime,
    async (result) => {
      const contributions = await publishNativeContributions(
        prepared.value,
        input.identity,
        product.publisher,
        synthesis.value.inventoryId,
        synthesis.value.batch.tasks.tasks,
        'synthesis',
        'decision',
        [synthesis.value.inventoryId, ...synthesis.value.sourceContributionIds],
        result,
      )
      return contributions.ok ? { ok: true, value: { result, contributions: contributions.value } } : contributions
    },
    false,
  )
  if (!preservedSynthesis.ok) return preservedSynthesis
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const decision = await finalizeCorrectionSynthesis(
    prepared.value,
    synthesis.value,
    input.identity,
    product.publisher,
    preservedSynthesis.value,
    product.runtime.signal,
  )
  if (!decision.ok) return decision
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure('correction-synthesis-history-incomplete')
    const admission = admitDecisionExecution(decision.value as Extract<FixRecord, { kind: 'decision' }>, history)
    if (!admission.ok) return admission
  } catch (error) {
    return failure(`correction-synthesis-history-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return executeDecision(
    prepared.value,
    decision.value as Extract<FixRecord, { kind: 'decision' }>,
    product,
    input.identity,
    input.debtEvidence ?? defaultDebtEvidence,
  )
}

export async function runReviewBoundFixWorkflow(
  prepared: PreparedFix,
  decision: Extract<FixRecord, { kind: 'decision' }>,
  product: Pick<DefaultFixWorkflow, 'native' | 'publisher' | 'runtime' | 'readHistory'>,
  identity: FixIdentity,
  debtEvidence: DebtEvidence = {
    important: 'unknown',
    urgent: 'unknown',
    tooLarge: 'unknown',
    evidence: { source: 'review-bound-fix', status: 'unqualified' },
  },
): Promise<FixActionResult<FixRecord>> {
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure('review-fix-history-incomplete')
    const admission = admitDecisionExecution(decision, history)
    if (!admission.ok) return admission
  } catch (error) {
    return failure(`review-fix-history-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  return executeDecision(prepared, decision, product, identity, debtEvidence)
}

const MANDATE_REFUSAL: Record<string, true> = {
  paused: true,
  abandoned: true,
  revoked: true,
  unsupported: true,
  'config-invalid': true,
  'config-drift': true,
  ambiguous: true,
  incomplete: true,
  unconfirmed: true,
  'unknown-binding': true,
  incompatible: true,
  unsafe: true,
  'materially-changed': true,
  missing: true,
  'missing-history': true,
  'material-spec': true,
  'fix-only': true,
  stale: true,
  foreign: true,
  'proof-pin-drift': true,
  unbound: true,
  conflict: true,
}

const FIX_OPERATION_KIND: Record<string, true> = {
  'fix-request': true,
  'fix-result': true,
  'correction-result': true,
  'falsification-result': true,
  'debt-receipt': true,
}

export type FixCheckpoint =
  | { status: 'not-started' }
  | { status: 'complete'; requestId: string; resultId: string; candidateGitSHA: string }
  | { status: 'live-owned'; requestId: string }
  | {
      status: 'blocked'
      reason: 'unresolved-effect' | 'ambiguous' | 'conflict' | 'incomplete-history'
      diagnostics: string[]
      startedRequestIds: string[]
    }

export type FixMandateView = {
  recordId: string
  role: 'feature' | 'epic' | 'fix-only'
  storedLanding: boolean
  repository: string
  target: string
  specBody: string | null
  parent: { scope: Scope; recordId: string; kind: string } | null
  antecedent: { scope: Scope; recordId: string; kind: string } | null
}

export type CorrectionExecutionRights = { correct: true; landing: false }

export type CiCorrectionStepClass =
  | {
      readonly status: 'attributed-correction'
      readonly action: 'fix'
      readonly reason: 'ci-failed'
      readonly reviews?: number
      readonly remaining?: number
    }
  | {
      readonly status: 'spent'
      readonly action: 'stop'
      readonly reason: 'ci-failed' | 'review-bound'
      readonly reviews?: number
    }
  | { readonly status: 'unsafe'; readonly reason: string; readonly reviews?: number }
  | { readonly status: 'refused'; readonly action: 'fix' | 'review' | 'land' | 'stop'; readonly reason?: string }

export type CiCorrectionAdmission = {
  readonly status: 'attributed-correction'
  readonly action: 'fix'
  readonly reason: 'ci-failed'
  readonly reviews?: number
  readonly remaining?: number
  readonly attributionRecordId: string
  readonly candidateGitSHA: string
  readonly scope: string
  readonly mandateRecordId: string
  readonly failedChecks: readonly string[]
}

export type CiCorrectionBound =
  | CiCorrectionAdmission
  | Exclude<CiCorrectionStepClass, { status: 'attributed-correction' }>

/** Uses the step nextReviewStep already returned. Does not count rounds or read attribution. */
export function classifyCiCorrectionStep(step: ReviewStepResult): CiCorrectionStepClass {
  if (step.action === 'fix' && step.reason === 'ci-failed') {
    return {
      status: 'attributed-correction',
      action: 'fix',
      reason: 'ci-failed',
      reviews: step.reviews,
      remaining: step.remaining,
    }
  }
  if (step.action === 'stop' && (step.reason === 'ci-failed' || step.reason === 'review-bound')) {
    return { status: 'spent', action: 'stop', reason: step.reason, reviews: step.reviews }
  }
  if (step.action === 'stop' && (step.reason === 'unsafe' || step.reason === 'head-unapproved')) {
    return { status: 'unsafe', reason: step.reason, reviews: step.reviews }
  }
  return { status: 'refused', action: step.action, reason: step.reason }
}

export type AttributedCiCorrectionInput = {
  cwd: string
  target: FixTarget
  scope: string
  branch: string | null
  base: string | null
  attributionRecordId: string
  workflow: ReviewAuthority
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  signal?: AbortSignal
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function diagnosticCodes(evidence: unknown): string[] {
  if (!Array.isArray(evidence)) return ['fix-mandate-evidence-unreadable']
  return evidence.map((item) => {
    const record = objectValue(item)
    return record !== null && typeof record.code === 'string' && record.code.length > 0
      ? record.code
      : 'fix-mandate-evidence-unreadable'
  })
}

function completeRecord(history: DecodedHistory, recordId: string): CanonicalRecord | null {
  const matches = history.operations.filter(
    (operation) => operation.status === 'complete' && operation.record?.recordId === recordId,
  )
  return matches.length === 1 ? (matches[0]?.record ?? null) : null
}

function mandateView(record: CanonicalRecord): FixActionResult<FixMandateView> {
  const payload = objectValue(record.payload)
  const permissions = objectValue(payload?.permissions)
  const role = payload?.role
  if (
    payload === null ||
    permissions === null ||
    (role !== 'feature' && role !== 'epic' && role !== 'fix-only') ||
    typeof permissions.landing !== 'boolean' ||
    permissions.correct !== true
  ) {
    return failure('fix-mandate-unrecognized')
  }
  if (role === 'fix-only' && permissions.landing !== false) return failure('fix-mandate-lands')
  const spec = objectValue(payload.spec)
  const parent = externalRef(payload.parent)
  const antecedent = externalRef(payload.antecedent)
  if (payload.parent !== null && parent === null) return failure('fix-mandate-parent-unreadable')
  if (payload.antecedent !== null && antecedent === null) return failure('fix-mandate-antecedent-unreadable')
  return {
    ok: true,
    value: {
      recordId: record.recordId,
      role,
      storedLanding: permissions.landing,
      repository: record.repository,
      target: record.target,
      specBody: spec !== null && typeof spec.body === 'string' ? spec.body : null,
      parent,
      antecedent,
    },
  }
}

function externalRef(value: unknown): { scope: Scope; recordId: string; kind: string } | null {
  const record = objectValue(value)
  const scope = objectValue(record?.scope)
  if (
    record === null ||
    scope === null ||
    typeof scope.repository !== 'string' ||
    typeof scope.target !== 'string' ||
    typeof record.recordId !== 'string' ||
    typeof record.kind !== 'string'
  ) {
    return null
  }
  return { scope: { repository: scope.repository, target: scope.target }, recordId: record.recordId, kind: record.kind }
}

function narrowSelection(
  value: unknown,
): FixActionResult<
  | { status: 'applicable'; record: CanonicalRecord; execution: CorrectionExecutionRights }
  | { status: 'missing' }
  | { status: 'refused'; reason: string }
> {
  const selection = objectValue(value)
  if (selection === null) return failure('fix-mandate-unrecognized')
  if (selection.status === 'missing') return { ok: true, value: { status: 'missing' } }
  if (selection.status === 'applicable') {
    const execution = objectValue(selection.execution)
    const record = selection.mandate
    if (!record || typeof record !== 'object' || execution === null) return failure('fix-mandate-unrecognized')
    if (execution.correct !== true || execution.landing !== false) return failure('fix-mandate-execution-denied')
    const mandate = record as CanonicalRecord
    const kind: string = mandate.kind
    if (kind !== 'mandate' || typeof mandate.recordId !== 'string') return failure('fix-mandate-unrecognized')
    return {
      ok: true,
      value: { status: 'applicable', record: mandate, execution: { correct: true, landing: false } },
    }
  }
  if (
    selection.status !== 'refused' ||
    typeof selection.reason !== 'string' ||
    MANDATE_REFUSAL[selection.reason] !== true
  ) {
    return failure('fix-mandate-unrecognized')
  }
  return { ok: true, value: { status: 'refused', reason: selection.reason } }
}

function correctionHistories(input: {
  history: DecodedHistory
  linkedIssueHistory: DecodedHistory | null
  externalHistories?: readonly DecodedHistory[]
}): DecodedHistory[] {
  const histories = [input.history]
  if (input.linkedIssueHistory !== null && input.linkedIssueHistory !== input.history)
    histories.push(input.linkedIssueHistory)
  for (const extra of input.externalHistories ?? []) {
    if (!histories.includes(extra)) histories.push(extra)
  }
  return histories
}

function acceptedSpecOf(
  mandate: CanonicalRecord,
  histories: readonly DecodedHistory[],
): FixActionResult<{ body: string; digest: string }> {
  if (mandate.kind !== 'mandate') return failure('fix-mandate-unrecognized')
  const resolved = resolveAcceptedSpec(mandate, histories)
  if (!resolved.ok) {
    if (MANDATE_REFUSAL[resolved.reason] !== true) return failure('fix-mandate-unrecognized')
    return failure(`fix-mandate-refused:${resolved.reason}`, ...diagnosticCodes(resolved.evidence))
  }
  if (resolved.spec.body.length === 0 || !/^[0-9a-f]{64}$/.test(resolved.spec.digest)) {
    return failure('fix-mandate-unrecognized')
  }
  return { ok: true, value: { body: resolved.spec.body, digest: resolved.spec.digest } }
}

function boundCorrection(
  input: { target: FixTarget; branch: string | null; base: string | null },
  histories: readonly DecodedHistory[],
  currentSpec: { body: string; digest: string } | null,
): FixActionResult<
  { status: 'standalone' } | { status: 'applicable'; recordId: string; body: string; digest: string }
> {
  if (input.target.kind !== 'pull-request') return { ok: true, value: { status: 'standalone' } }
  if (input.branch === null || input.base === null) return failure('fix-mandate-refused:unknown-binding')
  const resolved = resolveBoundWork({
    use: 'correction',
    explicitSelection: true,
    pullRequest: { repository: input.target.repository, target: input.target.target },
    histories,
    native: { branch: input.branch, base: input.base },
    currentSpec,
  })
  if (resolved.status === 'standalone') return { ok: true, value: { status: 'standalone' } }
  if (resolved.status === 'refused') {
    if (MANDATE_REFUSAL[resolved.reason] !== true) return failure('fix-mandate-unrecognized')
    return failure(`fix-mandate-refused:${resolved.reason}`, ...diagnosticCodes(resolved.evidence))
  }
  if (resolved.drift !== 'settled') return failure('fix-bound-spec-unsettled')
  const spec = resolved.acceptedSpec
  if (!resolved.permissions.correct || spec.body.length === 0 || !/^[0-9a-f]{64}$/.test(spec.digest)) {
    return failure('fix-mandate-unrecognized')
  }
  return {
    ok: true,
    value: { status: 'applicable', recordId: resolved.mandate.recordId, body: spec.body, digest: spec.digest },
  }
}

export async function resolveCorrectionMandate(input: {
  target: FixTarget
  history: DecodedHistory
  linkedIssueHistory: DecodedHistory | null
  linkedIssueScopes: readonly Scope[]
  externalHistories?: readonly DecodedHistory[]
  branch: string | null
  base: string | null
  currentSpec: { body: string; digest: string } | null
  evidenceDigest?: string | null
}): Promise<
  FixActionResult<
    | {
        status: 'applicable'
        mandate: FixMandateView
        execution: CorrectionExecutionRights
        acceptedSpec: { body: string; digest: string }
      }
    | { status: 'missing' }
  >
> {
  if (!input.history.source.complete) return failure('fix-history-incomplete')
  if (input.linkedIssueHistory && !input.linkedIssueHistory.source.complete)
    return failure('fix-parent-history-incomplete')
  const histories = correctionHistories(input)
  const bound = boundCorrection(input, histories, input.currentSpec)
  if (!bound.ok) return bound
  const assessed = assessFixMandate({
    target: {
      scope: { repository: input.target.repository, target: input.target.target },
      kind: input.target.kind,
      branch: input.branch,
      base: input.base,
    },
    history: input.history,
    linkedIssueHistory: input.linkedIssueHistory,
    linkedIssueScopes: input.target.kind === 'pull-request' ? [] : input.linkedIssueScopes,
    externalHistories: input.externalHistories ?? [],
    evidenceDigest: input.evidenceDigest ?? null,
  })
  if (assessed.status === 'refused' && assessed.reason === 'missing' && publishableMissing(input, assessed.evidence)) {
    if (bound.value.status === 'applicable') return failure('fix-mandate-refused:ambiguous')
    return { ok: true, value: { status: 'missing' } }
  }
  const selected = narrowSelection(assessed)
  if (!selected.ok) return selected
  if (selected.value.status === 'missing') {
    if (bound.value.status === 'applicable') return failure('fix-mandate-refused:ambiguous')
    return { ok: true, value: { status: 'missing' } }
  }
  if (selected.value.status === 'refused') return failure(`fix-mandate-refused:${selected.value.reason}`)
  const confirmed =
    completeRecord(input.history, selected.value.record.recordId) ??
    (input.linkedIssueHistory ? completeRecord(input.linkedIssueHistory, selected.value.record.recordId) : null)
  if (confirmed === null || JSON.stringify(confirmed) !== JSON.stringify(selected.value.record)) {
    return failure('fix-mandate-unconfirmed')
  }
  const view = mandateView(confirmed)
  if (!view.ok) return view
  const accepted = acceptedSpecOf(confirmed, histories)
  if (!accepted.ok) return accepted
  if (
    bound.value.status === 'applicable' &&
    (bound.value.recordId !== confirmed.recordId ||
      bound.value.body !== accepted.value.body ||
      bound.value.digest !== accepted.value.digest)
  ) {
    return failure('fix-mandate-unconfirmed')
  }
  return {
    ok: true,
    value: {
      status: 'applicable',
      mandate: view.value,
      execution: selected.value.execution,
      acceptedSpec: accepted.value,
    },
  }
}

function publishableMissing(
  input: { target: FixTarget; history: DecodedHistory; linkedIssueHistory: DecodedHistory | null },
  evidence: readonly { code: string; message: string }[],
): boolean {
  if (input.target.kind === 'pull-request' && input.linkedIssueHistory !== null) return false
  if (
    !input.history.source.complete ||
    mandateClaim(input.history) ||
    (input.linkedIssueHistory !== null && mandateClaim(input.linkedIssueHistory))
  ) {
    return false
  }
  return evidence.some((item) => item.code === 'missing' && item.message === 'No mandate record exists')
}

function mandateClaim(history: DecodedHistory): boolean {
  return history.operations.some(
    (operation) =>
      operation.kind === 'mandate' ||
      operation.claimedKinds.includes('mandate') ||
      operation.record?.kind === 'mandate',
  )
}

export type FixOnlyMandateDraft = {
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  candidateGitSHA: string | null
  productVersion: string
  work: { reference: string; body: string; lastEditedAt: string }
  config: { version: string; digest: string; effective: Json }
  proofPins: { sourceCommit: string; path: string; blob: string | null }[]
  parent: { scope: Scope; recordId: string; kind: string } | null
  antecedent: { scope: Scope; recordId: string; kind: string } | null
}

function mandateRef(
  ref: { scope: Scope; recordId: string; kind: string } | null,
): FixActionResult<ExternalRecordRef | null> {
  if (ref === null) return { ok: true, value: null }
  const parsed = kindSchema.safeParse(ref.kind)
  if (!parsed.success) return failure('fix-only-mandate-unrecognized')
  return { ok: true, value: { scope: ref.scope, recordId: ref.recordId, kind: parsed.data } }
}

export async function buildConfirmedFixOnlyMandate(
  draft: FixOnlyMandateDraft,
): Promise<FixActionResult<CanonicalRecord>> {
  if (draft.productVersion.length === 0) return failure('fix-product-version-unreadable')
  const parent = mandateRef(draft.parent)
  if (!parent.ok) return parent
  const antecedent = mandateRef(draft.antecedent)
  if (!antecedent.ok) return antecedent
  const built = buildFixOnlyMandate({
    scope: draft.scope,
    recordId: draft.recordId,
    runId: draft.runId,
    operationId: draft.operationId,
    branch: draft.branch,
    base: draft.base,
    lineageHead: draft.candidateGitSHA,
    productVersion: draft.productVersion,
    work: draft.work,
    config: draft.config,
    proofPins: draft.proofPins,
    parent: parent.value,
    antecedent: antecedent.value,
  })
  if (!built.ok) return failure(...diagnosticCodes(built.diagnostics).map((code) => `fix-only-mandate:${code}`))
  const view = mandateView(built.value)
  if (!view.ok) return view
  if (view.value.role !== 'fix-only' || view.value.storedLanding !== false) return failure('fix-only-mandate-lands')
  return { ok: true, value: built.value }
}

export type FixAuthorityDecision =
  | { status: 'reuse'; mandate: FixMandateView; execution: CorrectionExecutionRights; sameScope: boolean }
  | { status: 'successor'; antecedent: FixMandateView }
  | { status: 'missing' }

export async function decideFixAuthority(input: {
  target: FixTarget
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  branch: string | null
  base: string | null
  correctionScope: string
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>
}): Promise<FixActionResult<FixAuthorityDecision>> {
  const history = await input.readHistory()
  if (!history.source.complete) return failure('fix-history-incomplete')
  const checkpoint = reconstructFixCheckpoint(history, input.trustedLiveRequest)
  if (checkpoint.status === 'blocked') return failure(...checkpoint.diagnostics)
  const linked = await linkedIssueBinding(input.target, input.options)
  if (!linked.ok) return linked
  const selected = await resolveCorrectionMandate({
    target: input.target,
    history,
    linkedIssueHistory: linked.value.history,
    linkedIssueScopes: [],
    externalHistories: linked.value.externalHistories,
    branch: linked.value.branch ?? input.branch,
    base: linked.value.base ?? input.base,
    currentSpec: linked.value.currentSpec,
  })
  if (!selected.ok) return selected
  if (selected.value.status === 'missing') return { ok: true, value: { status: 'missing' } }
  if (selected.value.execution.landing !== false) return failure('fix-mandate-execution-denied')
  const mandate = selected.value.mandate
  if (mandate.role === 'fix-only') {
    if (selected.value.acceptedSpec.body !== input.correctionScope) {
      return { ok: true, value: { status: 'successor', antecedent: mandate } }
    }
  }
  return {
    ok: true,
    value: {
      status: 'reuse',
      mandate,
      execution: selected.value.execution,
      sameScope: mandate.repository === input.target.repository && mandate.target === input.target.target,
    },
  }
}

export async function confirmFixContinuation(input: {
  target: FixTarget
  options: GitHubOptions
  readHistory: () => Promise<DecodedHistory>
  branch: string | null
  base: string | null
  correctionScope: string
  boundRecordId: string
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>
}): Promise<FixActionResult<void>> {
  const again = await decideFixAuthority(input)
  if (!again.ok) return again
  if (again.value.status !== 'reuse' || again.value.mandate.recordId !== input.boundRecordId) {
    return failure('fix-mandate-changed')
  }
  if (again.value.execution.landing !== false) return failure('fix-mandate-execution-denied')
  return { ok: true, value: undefined }
}

export async function loadFixOnlyDraft(input: {
  cwd: string
  commit: string
  git: (cwd: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  scope: Scope
  recordId: string
  runId: string
  operationId: string
  branch: string | null
  base: string
  candidateGitSHA: string | null
  work: { reference: string; body: string; lastEditedAt: string }
  parent: FixMandateView['parent']
  antecedent: FixMandateView['antecedent']
}): Promise<FixActionResult<FixOnlyMandateDraft>> {
  const productVersion = shippedProductVersion()
  if (productVersion.length === 0) return failure('fix-product-version-unreadable')
  if (!/^[0-9a-f]{40}$/.test(input.commit) || input.work.body.length === 0 || input.work.lastEditedAt.length === 0) {
    return failure('fix-config-unreadable')
  }
  const config = await readEffectiveFixConfig({ cwd: input.cwd, commit: input.commit, git: input.git })
  if (!config.ok) return failure(`fix-config-${config.reason}`, ...config.diagnostics.map((item) => item.code))
  let pins: { sourceCommit: string; path: string; blob: string | null }[]
  try {
    pins = await readProofConfigPins(input.git, input.cwd, input.commit)
  } catch (error) {
    return failure(`fix-proof-pins-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  return {
    ok: true,
    value: {
      scope: input.scope,
      recordId: input.recordId,
      runId: input.runId,
      operationId: input.operationId,
      branch: input.branch,
      base: input.base,
      candidateGitSHA: input.candidateGitSHA,
      productVersion,
      work: input.work,
      config: { version: config.version, digest: config.digest, effective: config.effective as Json },
      proofPins: pins,
      parent: input.parent,
      antecedent: input.antecedent,
    },
  }
}

export function confirmPublishedMandate(history: DecodedHistory, recordId: string): FixActionResult<FixMandateView> {
  const record = completeRecord(history, recordId)
  if (record === null) return failure('fix-only-mandate-unconfirmed')
  const view = mandateView(record)
  if (!view.ok) return view
  if (view.value.role !== 'fix-only' || view.value.storedLanding !== false) return failure('fix-only-mandate-lands')
  return view
}

function correctionInventory(record: CanonicalRecord): boolean {
  return record.kind === 'review-attempt' && record.payload.purpose === 'correction'
}

function pinnedHead(record: CanonicalRecord | undefined): string | null {
  if (record?.kind !== 'contribution') return null
  const raw = record.payload.rawAttempts[0]?.raw
  const pin = objectValue(raw)?.candidateGitSHA
  return typeof pin === 'string' ? pin : null
}

/** A confirmed request may proceed only in its own live dispatch; cold starts remain unresolved. */
export function reconstructFixCheckpoint(
  history: DecodedHistory,
  trustedLiveRequest?: Extract<FixRecord, { kind: 'fix-request' }>,
): FixCheckpoint {
  if (!history.source.complete) {
    return {
      status: 'blocked',
      reason: 'incomplete-history',
      diagnostics: ['fix-history-incomplete'],
      startedRequestIds: [],
    }
  }
  const diagnostics: string[] = []
  const startedRequestIds: string[] = []
  for (const operation of history.operations) {
    const record = operation.record
    const kind = operation.kind ?? record?.kind ?? null
    const fixRelated =
      (kind !== null && FIX_OPERATION_KIND[kind] === true) || (record !== null && correctionInventory(record))
    if (!fixRelated || operation.status === 'complete') continue
    diagnostics.push(`fix-operation-${operation.status}:${kind ?? 'unknown'}`)
    if (record?.kind === 'fix-request') startedRequestIds.push(record.recordId)
  }
  if (diagnostics.length > 0) {
    const conflict = diagnostics.some(
      (item) => item.includes('conflict') || item.includes('invalid') || item.includes('legacy'),
    )
    return {
      status: 'blocked',
      reason: conflict ? 'conflict' : 'unresolved-effect',
      diagnostics,
      startedRequestIds,
    }
  }
  const byId = new Map<string, CanonicalRecord>()
  for (const operation of history.operations) {
    if (operation.status !== 'complete' || !operation.record) continue
    const prior = byId.get(operation.record.recordId)
    if (prior && JSON.stringify(prior) !== JSON.stringify(operation.record)) {
      return {
        status: 'blocked',
        reason: 'conflict',
        diagnostics: [`fix-record-conflict:${operation.record.recordId}`],
        startedRequestIds,
      }
    }
    byId.set(operation.record.recordId, operation.record)
  }
  const requests = [...byId.values()].filter((record) => record.kind === 'fix-request')
  const results = [...byId.values()].filter((record) => record.kind === 'fix-result')
  const open = requests.filter(
    (request) =>
      !results.some((result) => result.kind === 'fix-result' && result.payload.requestId === request.recordId),
  )
  if (open.length > 1) {
    return {
      status: 'blocked',
      reason: 'ambiguous',
      diagnostics: ['fix-open-request-ambiguous'],
      startedRequestIds: open.map((request) => request.recordId),
    }
  }
  if (open.length === 1) {
    const request = open[0]
    if (!request)
      return {
        status: 'blocked',
        reason: 'ambiguous',
        diagnostics: ['fix-open-request-ambiguous'],
        startedRequestIds: [],
      }
    const unresolved: Extract<FixCheckpoint, { status: 'blocked' }> = {
      status: 'blocked',
      reason: 'unresolved-effect',
      diagnostics: [
        `fix-open-request-unresolved:${request.recordId}`,
        `fix-open-request-head:${pinnedHead(byId.get(request.payload.requestContributionId)) ?? 'unpinned'}`,
      ],
      startedRequestIds: [request.recordId],
    }
    return trustedLiveRequestCheckpoint(history, unresolved, trustedLiveRequest)
      ? { status: 'live-owned', requestId: request.recordId }
      : unresolved
  }
  if (requests.length === 0) return { status: 'not-started' }
  const last = results.at(-1)
  if (last?.kind !== 'fix-result') {
    return {
      status: 'blocked',
      reason: 'unresolved-effect',
      diagnostics: ['fix-result-missing'],
      startedRequestIds: [],
    }
  }
  const referenced = [
    last.payload.decisionId,
    ...last.payload.correctionResultIds,
    ...last.payload.falsificationResultIds,
    ...last.payload.debtReceiptIds,
  ]
  const missing = referenced.filter((id) => !byId.has(id))
  if (missing.length > 0) {
    return {
      status: 'blocked',
      reason: 'unresolved-effect',
      diagnostics: missing.map((id) => `fix-result-reference-missing:${id}`),
      startedRequestIds: [],
    }
  }
  return {
    status: 'complete',
    requestId: last.payload.requestId,
    resultId: last.recordId,
    candidateGitSHA: last.payload.candidateGitSHA,
  }
}

function trustedLiveRequestCheckpoint(
  history: DecodedHistory,
  checkpoint: FixCheckpoint,
  trusted: Extract<FixRecord, { kind: 'fix-request' }> | undefined,
): boolean {
  if (
    trusted === undefined ||
    checkpoint.status !== 'blocked' ||
    checkpoint.reason !== 'unresolved-effect' ||
    checkpoint.startedRequestIds.length !== 1 ||
    checkpoint.startedRequestIds[0] !== trusted.recordId ||
    checkpoint.diagnostics.length !== 2 ||
    checkpoint.diagnostics[0] !== `fix-open-request-unresolved:${trusted.recordId}`
  )
    return false
  return history.operations.some(
    (operation) =>
      operation.status === 'complete' &&
      operation.record?.kind === 'fix-request' &&
      JSON.stringify(operation.record) === JSON.stringify(trusted),
  )
}
function liveBoundSpec(bodies: readonly { body: string }[]): { body: string; digest: string } | null {
  const body = bodies.length === 1 ? bodies[0]?.body : undefined
  if (typeof body !== 'string' || body.length === 0) return null
  return { body, digest: specDigest(body) }
}

function liveNativeBranch(value: unknown): { branch: string; base: string } | null {
  const native = objectValue(objectValue(value)?.native)
  if (
    native === null ||
    typeof native.branch !== 'string' ||
    native.branch.length === 0 ||
    typeof native.base !== 'string' ||
    native.base.length === 0
  ) {
    return null
  }
  return { branch: native.branch, base: native.base }
}

async function linkedIssueBinding(
  target: FixTarget,
  options: GitHubOptions,
): Promise<
  FixActionResult<{
    history: DecodedHistory | null
    externalHistories: DecodedHistory[]
    branch: string | null
    base: string | null
    currentSpec: { body: string; digest: string } | null
  }>
> {
  if (target.kind !== 'pull-request') {
    return { ok: true, value: { history: null, externalHistories: [], branch: null, base: null, currentSpec: null } }
  }
  const raw = await readWorkflowBinding({ repository: target.repository, target: target.target }, options)
  if (!raw.ok) {
    if (raw.status !== 'absent') {
      const foreign = raw.diagnostics.some((item) => item.code === 'foreign')
      return failure(`fix-binding-${foreign ? 'foreign' : raw.reason}`, ...raw.diagnostics.map((item) => item.code))
    }
    const native = await nativePullRequest(target, options)
    if (!native.ok) return native
    return {
      ok: true,
      value: {
        history: null,
        externalHistories: [],
        branch: native.value.branch,
        base: native.value.base,
        currentSpec: null,
      },
    }
  }
  const confirmed = confirmedWorkflowBinding(raw.value)
  if (confirmed === null) return failure('fix-binding-unreadable')
  if (!confirmed.history.source.complete) return failure('fix-parent-history-incomplete')
  const native = liveNativeBranch(raw.value)
  if (native === null) return failure('fix-binding-unreadable')
  const pullRequest = { repository: target.repository, target: target.target }
  return {
    ok: true,
    value: {
      history: confirmed.history,
      externalHistories: confirmed.histories.filter(
        (item) => !sameScope(item.source.scope, confirmed.mandateScope) && !sameScope(item.source.scope, pullRequest),
      ),
      branch: native.branch,
      base: native.base,
      currentSpec: liveBoundSpec(raw.value.linkedIssueBodies),
    },
  }
}

async function nativePullRequest(
  target: FixTarget,
  options: GitHubOptions,
): Promise<FixActionResult<{ branch: string; base: string }>> {
  try {
    const facts = await readNativePullRequestFacts(target.repository, target.number, options)
    return { ok: true, value: { branch: facts.branch, base: facts.base } }
  } catch (error) {
    return failure(`fix-binding-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
}

function sameScope(left: Scope, right: Scope): boolean {
  return left.repository === right.repository && left.target === right.target
}

function confirmedWorkflowBinding(value: unknown): {
  mandateScope: Scope
  history: DecodedHistory
  histories: DecodedHistory[]
  branch: string
  base: string
} | null {
  const envelope = objectValue(value)
  if (envelope === null) return null
  const binding = objectValue(envelope.binding)
  const payload = objectValue(binding?.payload)
  const mandate = externalRef(payload?.mandate)
  const history = decodedHistory(envelope.history)
  if (
    mandate === null ||
    history === null ||
    typeof payload?.branch !== 'string' ||
    typeof payload.base !== 'string' ||
    history.source.scope.repository !== mandate.scope.repository ||
    history.source.scope.target !== mandate.scope.target
  ) {
    return null
  }
  const histories = (Array.isArray(envelope.histories) ? envelope.histories : [history])
    .map((item) => decodedHistory(item))
    .filter((item): item is DecodedHistory => item !== null)
  return { mandateScope: mandate.scope, history, histories, branch: payload.branch, base: payload.base }
}

function decodedHistory(value: unknown): DecodedHistory | null {
  const record = objectValue(value)
  const source = objectValue(record?.source)
  const scope = objectValue(source?.scope)
  if (
    record === null ||
    !Array.isArray(record.operations) ||
    typeof scope?.repository !== 'string' ||
    typeof scope.target !== 'string'
  ) {
    return null
  }
  return record as DecodedHistory
}

function confirmedChangeAttribution(
  history: DecodedHistory,
  recordId: string,
  head: string,
  scope: Scope,
  evidenceDigest: string,
): FixActionResult<{ evidenceDigest: string }> {
  const record = completeRecord(history, recordId)
  if (record === null) return failure('ci-attribution-unconfirmed')
  const kind: string = record.kind
  if (kind !== 'action-receipt') return failure('ci-attribution-kind-mismatch')
  const payload = objectValue(record.payload)
  const structured = objectValue(payload?.structured)
  const inputs = objectValue(payload?.exactInputs)
  const inputScope = objectValue(inputs?.scope)
  if (payload === null || payload.phase !== 'result' || payload.action !== 'attribute-ci')
    return failure('ci-attribution-not-result')
  if (structured === null || structured.attribution !== 'change') return failure('ci-attribution-not-change')
  if (
    inputs === null ||
    inputs.candidateGitSHA !== head ||
    inputs.evidenceDigest !== evidenceDigest ||
    inputScope === null ||
    inputScope.repository !== scope.repository ||
    inputScope.target !== scope.target
  ) {
    return failure('ci-attribution-stale')
  }
  const failures = receiptFailures(inputs.failures)
  if (failures === null) return failure('ci-attribution-evidence-missing')
  const recomputed = evidenceDigestOf(head, scope, failures)
  if (!recomputed.ok) return recomputed
  if (recomputed.value !== evidenceDigest) return failure('ci-attribution-stale')
  return { ok: true, value: { evidenceDigest } }
}

export async function admitAttributedCiCorrection(
  input: AttributedCiCorrectionInput,
): Promise<FixActionResult<CiCorrectionBound>> {
  if (input.signal?.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  if (input.target.kind !== 'pull-request' || input.target.candidateGitSHA === null)
    return failure('ci-correction-not-pull-request')
  let step: ReviewStepResult
  try {
    step = await input.workflow.nextReviewStep(input.cwd, input.target.number, { ciFailed: true })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes('latest review record to approve the current head')) {
      return { ok: true, value: { status: 'unsafe', reason: 'head-unapproved' } }
    }
    return failure(`ci-correction-step-unreadable:${message}`)
  }
  const classified = classifyCiCorrectionStep(step)
  if (classified.status !== 'attributed-correction') return { ok: true, value: classified }
  const history = await input.readHistory()
  if (!history.source.complete) return failure('fix-history-incomplete')
  const linked = await linkedIssueBinding(input.target, input.options)
  if (!linked.ok) return linked
  const head = input.target.candidateGitSHA
  if (head === null) return failure('ci-correction-not-pull-request')
  const live = await readLiveCiEvidence(input, head)
  if (!live.ok) return live
  const mandate = await resolveCorrectionMandate({
    target: input.target,
    history,
    linkedIssueHistory: linked.value.history,
    linkedIssueScopes: [],
    externalHistories: linked.value.externalHistories,
    branch: linked.value.branch ?? input.branch,
    base: linked.value.base ?? input.base,
    currentSpec: linked.value.currentSpec,
    evidenceDigest: live.value.evidenceDigest,
  })
  if (!mandate.ok) {
    if (mandate.diagnostics.some((item) => item.includes('unsafe'))) {
      return { ok: true, value: { status: 'unsafe', reason: 'unsafe', reviews: classified.reviews } }
    }
    return mandate
  }
  if (mandate.value.status !== 'applicable' || mandate.value.execution.landing !== false) {
    return failure('ci-correction-mandate-denied')
  }
  const pullScope = { repository: input.target.repository, target: input.target.target }
  const attribution = confirmedChangeAttribution(
    history,
    input.attributionRecordId,
    head,
    pullScope,
    live.value.evidenceDigest,
  )
  if (!attribution.ok) return attribution
  const authorized = await authorizeFixAction(
    input,
    history,
    linked.value.history,
    linked.value.externalHistories,
    classified.action,
    live.value,
    mandate.value.acceptedSpec,
  )
  if (!authorized.ok) return authorized
  return {
    ok: true,
    value: {
      status: 'attributed-correction',
      action: 'fix',
      reason: 'ci-failed',
      reviews: classified.reviews,
      remaining: classified.remaining,
      attributionRecordId: input.attributionRecordId,
      candidateGitSHA: input.target.candidateGitSHA,
      scope: input.scope,
      mandateRecordId: mandate.value.mandate.recordId,
      failedChecks: authorized.value,
    },
  }
}

const execFileAsync = promisify(execFile)

async function githubText(options: GitHubOptions, cwd: string, args: string[]): Promise<string> {
  if (options.gh) return options.gh(cwd, args)
  const out = await execFileAsync('gh', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  return String(out.stdout).trim()
}

type NativeCheckFailure = {
  name: string
  source: string
  observationId: string
  conclusion: string
}

type LiveCiEvidence = {
  failedChecks: string[]
  evidenceDigest: string
  failures: NativeCheckFailure[]
}

function nonempty(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function evidenceDigestOf(
  candidateGitSHA: string,
  scope: Scope,
  failures: readonly NativeCheckFailure[],
): FixActionResult<string> {
  const digest = failedCheckEvidenceDigest({ candidateGitSHA, scope, failures })
  if (digest === null || !/^[0-9a-f]{64}$/.test(digest)) return failure('ci-native-identity-unknown')
  return { ok: true, value: digest }
}

function receiptFailures(value: unknown): NativeCheckFailure[] | null {
  if (!Array.isArray(value) || value.length === 0) return null
  const failures: NativeCheckFailure[] = []
  for (const item of value) {
    const record = objectValue(item)
    const name = nonempty(record?.name)
    const source = nonempty(record?.source)
    const observationId = nonempty(record?.observationId)
    const conclusion = nonempty(record?.conclusion)
    if (record === null || name === null || source === null || observationId === null || conclusion === null)
      return null
    failures.push({ name, source, observationId, conclusion })
  }
  return failures
}

/** Current head, pull-request scope, and native CheckRun identity. The receipt is not an input. */
async function readLiveCiEvidence(
  input: Pick<AttributedCiCorrectionInput, 'cwd' | 'target' | 'options'>,
  head: string,
): Promise<FixActionResult<LiveCiEvidence>> {
  const scope = { repository: input.target.repository, target: input.target.target }
  let headRaw: string
  try {
    headRaw = await githubText(input.options, input.cwd, [
      'pr',
      'view',
      String(input.target.number),
      '--repo',
      input.target.repository,
      '--json',
      'headRefOid',
    ])
  } catch (error) {
    return failure(`ci-checks-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  let headParsed: unknown
  try {
    headParsed = JSON.parse(headRaw)
  } catch {
    return failure('ci-checks-unreadable')
  }
  const headBody = objectValue(headParsed)
  if (headBody === null || typeof headBody.headRefOid !== 'string') return failure('ci-checks-unreadable')
  if (headBody.headRefOid !== head) return failure('ci-correction-head-moved')
  const { readNativeCiFailureEvidence } = await import('./workflow.ts')
  const read = await readNativeCiFailureEvidence(input.cwd, input.target.repository, head, scope, {
    gh: (cwd, args) => githubText(input.options, cwd, args),
    failedCheckEvidenceDigest,
  })
  if (!read.ok) return failure(read.reason)
  return {
    ok: true,
    value: {
      failedChecks: read.failedChecks,
      evidenceDigest: read.evidenceDigest,
      failures: read.failures,
    },
  }
}

async function authorizeFixAction(
  input: Pick<AttributedCiCorrectionInput, 'cwd' | 'target' | 'branch' | 'base' | 'options'>,
  history: DecodedHistory,
  linked: DecodedHistory | null,
  parents: readonly DecodedHistory[],
  reviewStep: 'fix' | 'review' | 'land' | 'stop',
  liveEvidence: LiveCiEvidence,
  acceptedSpec: { body: string; digest: string },
): Promise<FixActionResult<readonly string[]>> {
  if (input.target.state !== 'open') return failure('fix-target-closed')
  if (input.target.kind === 'pull-request' && (input.base === null || input.target.candidateGitSHA === null)) {
    return failure('fix-workflow-refused:unknown-binding')
  }
  const commit = input.target.candidateGitSHA
  if (commit === null || !/^[0-9a-f]{40}$/.test(commit)) return failure('fix-config-unreadable')
  const failedChecks = liveEvidence.failedChecks
  const git = defaultGit()
  const config = await readEffectiveFixConfig({ cwd: input.cwd, commit, git })
  if (!config.ok) return failure(`fix-config-${config.reason}`, ...config.diagnostics.map((item) => item.code))
  let proofPins: { sourceCommit: string; path: string; blob: string | null }[]
  try {
    proofPins = await readProofConfigPins(git, input.cwd, commit)
  } catch (error) {
    return failure(`fix-proof-pins-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  const productVersion = shippedProductVersion()
  if (productVersion.length === 0) return failure('fix-product-version-unreadable')
  const issue = linked ?? history
  const pullRequest = linked !== null && input.target.kind === 'pull-request' ? history : null
  const composed = composeChantier({ issue, pullRequest, parents })
  if (!composed.ok) return failure('fix-history-incomplete', ...diagnosticCodes(composed.diagnostics))
  const pullRequestFacts =
    input.target.kind === 'pull-request' && input.base !== null
      ? {
          scope: { repository: input.target.repository, target: input.target.target },
          head: commit,
          base: input.base,
          associatedIssue: linked?.source.scope ?? null,
        }
      : null
  const decision = reconstructWorkflow({
    evidence: composed.value,
    facts: {
      specDigest: acceptedSpec.digest,
      specBody: acceptedSpec.body,
      branch: input.branch,
      base: input.base,
      candidateGitSHA: commit,
      pullRequest: pullRequestFacts,
      failedChecks,
      evidenceDigest: liveEvidence.evidenceDigest,
      merged: false,
      sessionCwd: input.cwd,
      preparedWorktree: input.cwd,
      productVersion,
      configVersion: config.version,
      configDigest: config.digest,
      supportedConfigVersions: [...SUPPORTED_CONFIG_VERSIONS],
      proofPins,
      explicitSelection: true,
      explicitResume: false,
      successorAntecedent: null,
      endObligationsMet: false,
      localInhibit: null,
    },
    decisions: {
      reviewStep,
      epicStep: null,
      epicLand: null,
      ciWatchStatus: 'red',
      publish: { status: 'not-applicable', evidence: [] },
      landing: { status: 'not-applicable', evidence: [] },
      watch: { status: 'not-applicable', evidence: [] },
      proof: { admission: null, candidateGitSHA: null, input: null, applicability: 'not-applicable', evidence: [] },
    },
  })
  if (decision.status === 'action' && decision.action === 'fix') return { ok: true, value: failedChecks }
  const reason =
    decision.status === 'blocked' || decision.status === 'terminal'
      ? decision.reason
      : decision.status === 'action'
        ? decision.action
        : decision.status
  return failure(`fix-workflow-refused:${reason}`, ...diagnosticCodes(decision.evidence))
}

export async function runAdmittedCiCorrection(
  input: AttributedCiCorrectionInput,
  product: DefaultFixWorkflow & { identity: FixIdentity; publishBinding: PublishBinding; debtEvidence?: DebtEvidence },
): Promise<FixActionResult<FixRecord>> {
  const admitted = await admitAttributedCiCorrection(input)
  if (!admitted.ok) return admitted
  if (admitted.value.status !== 'attributed-correction') return failure(`ci-correction-${admitted.value.status}`)
  const mandateRecordId = admitted.value.mandateRecordId
  // Admission has already resolved the Feature mandate in its issue scope. A
  // correction request lives in the PR scope, so its canonical inputs may only
  // name the PR-local contribution that requested it.
  const evidence = record(product.identity, input.target, 'contribution', {
    content: 'operator-request',
    inventoryId: null,
    host: { origin: 'native', phase: 'fix', role: 'ci-correction', slotId: null, chunk: null, childId: null },
    rawAttempts: [
      capturedSubmission({
        attributedCiFailure: [...admitted.value.failedChecks],
        attributionRecordId: admitted.value.attributionRecordId,
        candidateGitSHA: admitted.value.candidateGitSHA,
      }),
    ],
    native: null,
    structured: null,
    findings: null,
  })
  const savedEvidence = await publish(product.publisher, evidence)
  if (!savedEvidence.ok) return savedEvidence
  const request = record(
    product.identity,
    input.target,
    'fix-request',
    {
      requestContributionId: evidence.recordId,
      existingReviewId: null,
      scope: input.scope,
      landing: false,
    },
    [evidence.recordId],
  )
  const savedRequest = await publish(product.publisher, request)
  if (!savedRequest.ok) return savedRequest
  const attributionContext = `attributed-ci ${admitted.value.attributionRecordId} ${admitted.value.candidateGitSHA} checks=${admitted.value.failedChecks.join(',')}`
  const intakeTask = actionTask(
    'ci-correction-intake',
    nativeFixProfileByAction.intake,
    `Inspect only confirmed CI attribution ${admitted.value.attributionRecordId} on ${admitted.value.candidateGitSHA}. Failed checks: ${admitted.value.failedChecks.join(', ')}. Return structured findings from that attributed failure only. Do not replay review findings. Do not edit, commit, push, arm, or land.`,
    'bounded attributed CI evidence intake',
  )
  const policy: FixPolicy = { version: 'baseline' }
  const prepared: PreparedFix = {
    target: input.target,
    requestId: request.recordId,
    inventoryId: product.identity.nextRecordId('review-attempt'),
    sourceContributionId: evidence.recordId,
    policy,
    cwd: input.cwd,
    publishBinding: product.publishBinding,
    debtFiling: createTrustedDebtFiling(),
    batch: {
      operationId: product.identity.operationId,
      tasks: { context: attributionContext, tasks: [intakeTask] },
    },
  }
  const inventory = record(
    product.identity,
    input.target,
    'review-attempt',
    {
      rootAttemptId: prepared.inventoryId,
      candidateGitSHA: input.target.candidateGitSHA,
      input: null,
      stage: 'initial',
      purpose: 'correction',
      requestId: request.recordId,
      policy,
      slots: [taskSlot(intakeTask, 'intake', 'findings')],
    },
    [request.recordId, evidence.recordId],
    prepared.inventoryId,
  )
  const savedInventory = await publish(product.publisher, inventory)
  if (!savedInventory.ok) return savedInventory
  product.runtime.bindContinuation?.(() =>
    confirmFixContinuation({
      target: input.target,
      options: input.options,
      readHistory: input.readHistory,
      branch: input.branch,
      base: input.base,
      correctionScope: input.scope,
      boundRecordId: mandateRecordId,
      trustedLiveRequest: request as Extract<FixRecord, { kind: 'fix-request' }>,
    }),
  )
  const preservedIntake = await dispatchNativeBatch<{ result: NativeBatchResult; records: FixRecord[] }>(
    product.native,
    prepared.batch,
    product.runtime,
    (result) =>
      publishNativeContributions(
        prepared,
        product.identity,
        product.publisher,
        prepared.inventoryId,
        [intakeTask],
        'intake',
        'findings',
        [evidence.recordId],
        result,
      ).then((contributions) =>
        contributions.ok ? { ok: true, value: { result, records: contributions.value } } : contributions,
      ),
    true,
  )
  if (!preservedIntake.ok) return preservedIntake
  const intake = assessFixIntake(prepared, preservedIntake.value.result, preservedIntake.value.records)
  if (!intake.complete) return failure(`native-intake-incomplete:${intake.diagnostics.join(';')}`)
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const synthesisTask = actionTask(
    'ci-correction-synthesis',
    nativeFixProfileByAction.synthesis,
    `Synthesize one correction-purpose decision only from confirmed CI attribution ${admitted.value.attributionRecordId} on ${admitted.value.candidateGitSHA} and the supplied intake records. Failed checks: ${admitted.value.failedChecks.join(', ')}. Do not replay review findings. Do not edit, commit, push, arm, or land.`,
    'one correction decision from attributed CI evidence',
  )
  const synthesis = await prepareCorrectionSynthesis(
    prepared,
    product.identity,
    product.publisher,
    intake.records,
    synthesisTask,
  )
  if (!synthesis.ok) return synthesis
  const preservedSynthesis = await dispatchNativeBatch<PreservedSynthesis>(
    product.native,
    synthesis.value.batch,
    product.runtime,
    async (result) => {
      const contributions = await publishNativeContributions(
        prepared,
        product.identity,
        product.publisher,
        synthesis.value.inventoryId,
        [synthesisTask],
        'synthesis',
        'decision',
        [synthesis.value.inventoryId, ...synthesis.value.sourceContributionIds],
        result,
      )
      return contributions.ok ? { ok: true, value: { result, contributions: contributions.value } } : contributions
    },
    false,
  )
  if (!preservedSynthesis.ok) return preservedSynthesis
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  const decision = await finalizeCorrectionSynthesis(
    prepared,
    synthesis.value,
    product.identity,
    product.publisher,
    preservedSynthesis.value,
    product.runtime.signal,
  )
  if (!decision.ok) return decision
  if (decision.value.kind !== 'decision') return failure('ci-correction-decision-invalid')
  try {
    const history = await product.readHistory()
    if (!history.source.complete) return failure('correction-synthesis-history-incomplete')
    const admission = admitDecisionExecution(decision.value, history)
    if (!admission.ok) return admission
  } catch (error) {
    return failure(`correction-synthesis-history-unreadable:${error instanceof Error ? error.message : String(error)}`)
  }
  if (product.runtime.signal.aborted) return failure('fix-run-interrupted-cleanup-unproven')
  return executeDecision(
    prepared,
    decision.value,
    product,
    product.identity,
    product.debtEvidence ?? defaultDebtEvidence,
  )
}

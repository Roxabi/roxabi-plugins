import {
  type CanonicalRecord,
  canonicalValueDigest,
  deriveRecallPlan,
  type Policy,
  type Scope,
} from '../dist/contracts.js'
import { actionRequest, confirmPreparedAction, deliveryTask, prepareRefusal } from './delivery-action.ts'
import type { PreparedReviewBatch } from './review-contract.ts'
import type { ObservedEvidence, PreparedReviewChunk } from './review-input-contract'
import { type candidateSource, createInventory, type ReviewIdentity, type ReviewSlot } from './review-records'
import type { PreparedUwAction, RecordInputRef } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'

export { finalizeReview } from './review-runner-finalize.ts'

type SourceContribution = {
  contributionId: string
  payload: Extract<CanonicalRecord, { kind: 'contribution' }>['payload']
}

type SynthesisInput = Parameters<typeof candidateSource>[0] & {
  semantic: { synthesis: string }
  policy: Policy
  observedEvidence: ObservedEvidence
  actions: Readonly<Record<string, PreparedUwAction>>
  operations: UwOperations
  chunks: readonly PreparedReviewChunk[]
  contextWindow: number
}

type StageInput = SynthesisInput & {
  semantic: { synthesis: string; panel: string }
  canonicalClasses: readonly string[]
}

function samePinnedCode(prepared: PreparedUwAction, spec: PreparedUwAction): boolean {
  const code = prepared.inputs.manifest.code
  const pinned = spec.inputs.manifest.code
  return (
    code.repository === pinned.repository &&
    code.base === pinned.base &&
    code.head === pinned.head &&
    code.referenceCommit === pinned.referenceCommit
  )
}

export async function createSynthesisBatch(input: {
  review: SynthesisInput
  identity: ReviewIdentity
  scope: Scope
  sourceContributions: readonly SourceContribution[]
  sourceContributionIds: ReadonlySet<string>
  knownSlots: Map<string, ReviewSlot>
  rootAttemptId: string
}): Promise<PreparedReviewBatch> {
  const specAction = input.review.actions.spec
  if (specAction === undefined) throw new Error('review-action-unprepared')
  if (input.sourceContributions.length === 0) throw new Error('synthesis-sources-unconfirmed')
  const stageSources: RecordInputRef[] = input.sourceContributions.map((contribution) => ({
    source: 'record',
    record: { scope: input.scope, recordId: contribution.contributionId, kind: 'contribution' },
    selector: '/payload',
    digest: canonicalValueDigest(contribution.payload),
  }))
  const preparedAction = await confirmPreparedAction(
    input.review.operations,
    actionRequest({
      actionId: `${input.rootAttemptId}:synthesis`,
      purpose: 'review',
      subject: specAction.inputs.manifest.subject,
      code: specAction.inputs.manifest.code,
      stageSources,
      expandedContext: specAction.inputs.manifest.expandedContext,
    }),
    {
      taskName: 'synthesis',
      assignedChunk: null,
      contextWindow: input.review.contextWindow,
      chunks: input.review.chunks,
    },
  )
  if (!preparedAction.ok) throw new Error(`prepare-action-unavailable:${prepareRefusal(preparedAction.diagnostics)}`)
  if (
    preparedAction.value.inputs.fingerprint !== specAction.inputs.fingerprint ||
    !samePinnedCode(preparedAction.value, specAction)
  ) {
    throw new Error('review-input-changed')
  }
  const prepared = preparedAction.value
  const task = deliveryTask({
    name: 'synthesis',
    agent: 'R-review-synthesis',
    procedure:
      'Synthesize only the dossier named by the index. Return criterion verdict references and exclusion claims. Do not read code, run a shell, or publish.',
    solutionSpace: 'one structured review decision from the dossier',
    prepared,
  })
  const slots: ReviewSlot[] = [
    {
      slotId: task.name,
      phase: 'synthesis',
      role: 'R-review-synthesis',
      chunk: null,
      required: true,
      output: 'decision',
      classId: null,
      sourceFindingIds: [...input.sourceContributionIds],
    },
  ]
  return createInventory({
    identity: input.identity,
    scope: input.scope,
    stage: 'synthesis',
    slots,
    tasks: [task],
    payload: {
      rootAttemptId: input.rootAttemptId,
      candidateGitSHA: input.review.context.candidateGitSHA,
      input: prepared.inputs.fingerprint,
      slots,
      stage: 'synthesis',
      inputFormat: 'omp-build:review-input/4',
      actionInputDigest: prepared.inputs.fingerprint,
      purpose: 'review',
      policy: input.review.policy,
    },
    observedEvidence: input.review.observedEvidence,
    knownSlots: input.knownSlots,
  })
}

export async function advanceReviewStage(input: {
  review: StageInput
  prepared: PreparedReviewBatch
  identity: ReviewIdentity
  scope: Scope
  sourceContributions: readonly SourceContribution[]
  knownSlots: Map<string, ReviewSlot>
  readHistory: () => Promise<Parameters<typeof deriveRecallPlan>[0]>
  createSynthesis: (rootAttemptId: string) => Promise<PreparedReviewBatch>
}): Promise<PreparedReviewBatch> {
  if (input.prepared.stage === 'recall') return input.createSynthesis(input.prepared.rootAttemptId)

  const recall = deriveRecallPlan(
    await input.readHistory(),
    input.prepared.rootAttemptId,
    input.review.canonicalClasses,
  )
  if (!recall.ok) {
    throw new Error(`recall-plan-refused:${recall.diagnostics.map((item) => item.code).join(',')}`)
  }
  if (recall.value.triggeredClassIds.length === 0) {
    return input.createSynthesis(input.prepared.rootAttemptId)
  }

  const specAction = input.review.actions.spec
  if (specAction === undefined) throw new Error('review-action-unprepared')
  const recallEntries = recall.value.index.filter((item) => recall.value.triggeredClassIds.includes(item.classId))
  const tasks = []
  for (const item of recallEntries) {
    const stageSources = input.sourceContributions
      .filter(
        (contribution) =>
          contribution.payload.findings?.some((finding) => item.sourceFindingIds.includes(finding.id)) ?? false,
      )
      .map(
        (contribution): RecordInputRef => ({
          source: 'record',
          record: { scope: input.scope, recordId: contribution.contributionId, kind: 'contribution' },
          selector: '/payload',
          digest: canonicalValueDigest(contribution.payload),
        }),
      )
    const prepared = await confirmPreparedAction(
      input.review.operations,
      actionRequest({
        actionId: `${input.prepared.rootAttemptId}:recall:${item.classId}`,
        purpose: 'review',
        subject: specAction.inputs.manifest.subject,
        code: specAction.inputs.manifest.code,
        stageSources,
        expandedContext: specAction.inputs.manifest.expandedContext,
      }),
      {
        taskName: `recall-${item.classId}`,
        assignedChunk: null,
        contextWindow: input.review.contextWindow,
        chunks: input.review.chunks,
      },
    )
    if (!prepared.ok) throw new Error(`prepare-action-unavailable:${prepareRefusal(prepared.diagnostics)}`)
    if (
      prepared.value.inputs.fingerprint !== specAction.inputs.fingerprint ||
      !samePinnedCode(prepared.value, specAction)
    ) {
      throw new Error('review-input-changed')
    }
    tasks.push(
      deliveryTask({
        name: `recall-${item.classId}`,
        agent: 'R-review-recall',
        procedure:
          'Recall only the class named by the index. Return structured findings. Do not read code, run a shell, or publish.',
        solutionSpace: 'verify one canonical cross-chunk review class from the index',
        prepared: prepared.value,
      }),
    )
  }
  const slots: ReviewSlot[] = tasks.map((task, index) => ({
    slotId: task.name,
    phase: 'recall',
    role: 'R-review-recall',
    chunk: null,
    required: true,
    output: 'findings',
    classId: recallEntries[index].classId,
    sourceFindingIds: recallEntries[index].sourceFindingIds,
  }))
  return createInventory({
    identity: input.identity,
    scope: input.scope,
    stage: 'recall',
    slots,
    tasks,
    payload: {
      rootAttemptId: input.prepared.rootAttemptId,
      candidateGitSHA: input.review.context.candidateGitSHA,
      input: specAction.inputs.fingerprint,
      inputFormat: 'omp-build:review-input/4',
      actionInputDigest: specAction.inputs.fingerprint,
      stage: 'recall',
      purpose: 'review',
      plan: recall.value,
      policy: input.review.policy,
      slots,
    },
    observedEvidence: input.review.observedEvidence,
    knownSlots: input.knownSlots,
  })
}

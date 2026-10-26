import {
  buildRecord,
  type CanonicalRecord,
  decisionSchema,
  deriveRecallPlan,
  type Policy,
  type RecordDraft,
  type Scope,
  validateDecision,
} from '../dist/contracts.js'
import type { NativeTask } from '../omp/review-runtime/contracts'
import { modelContributionPayload } from './native-contribution'
import type { PreparedReviewBatch, PublishedContribution } from './review-contract'
import type { ObservedEvidence } from './review-input-contract'
import { createRecallTask } from './review-panel'
import {
  candidateSource,
  createInventory,
  type ReviewIdentity,
  type ReviewSlot,
  recordBase,
  requireRecord,
} from './review-records'

type SourceContribution = {
  contributionId: string
  payload: Extract<CanonicalRecord, { kind: 'contribution' }>['payload']
}

type SynthesisInput = Parameters<typeof candidateSource>[0] & {
  semantic: { synthesis: string }
  policy: Policy
  observedEvidence: ObservedEvidence
}

type StageInput = SynthesisInput & {
  semantic: { synthesis: string; panel: string }
  canonicalClasses: readonly string[]
}

type FinalizationInput = {
  context: {
    subject: { kind: 'pull-request' } | { kind: 'epic-range'; range: string }
    candidateGitSHA: string
    input: string | null
  }
  policy: Policy
  canonicalClasses: readonly string[]
  authorize(stage: 'synthesis'): Promise<{ ok: true } | { ok: false; reason: string }>
}

export function createSynthesisBatch(input: {
  review: SynthesisInput
  identity: ReviewIdentity
  scope: Scope
  sourceContributions: readonly SourceContribution[]
  sourceContributionIds: ReadonlySet<string>
  knownSlots: Map<string, ReviewSlot>
  rootAttemptId: string
}) {
  const task: NativeTask = {
    solutionSpace: 'synthesize confirmed review contributions into one strict structured decision',
    name: 'synthesis',
    agent: 'R-review-synthesis',
    task: [
      input.review.semantic.synthesis,
      candidateSource(input.review),
      'Confirmed native source contributions (every original ID, provenance, extracted evidence, structured output, and raw attempt is authoritative):',
      JSON.stringify(
        input.sourceContributions.map(({ contributionId, payload }) => ({
          contributionId,
          payload: modelContributionPayload(payload),
        })),
      ),
    ].join('\n\n'),
  }
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
      input: input.review.context.input,
      slots,
      stage: 'synthesis',
      inputFormat: 'omp-build:review-input/3',
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
  createSynthesis: (rootAttemptId: string) => PreparedReviewBatch
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

  const recallEntries = recall.value.index.filter((item) => recall.value.triggeredClassIds.includes(item.classId))
  const tasks = recallEntries.map((item) =>
    createRecallTask({
      ...item,
      canonicalClasses: input.review.canonicalClasses,
      context: input.review.semantic.panel,
      sourceEvidence: JSON.stringify(
        input.sourceContributions
          .filter(
            (contribution) =>
              contribution.payload.findings?.some((finding) => item.sourceFindingIds.includes(finding.id)) ?? false,
          )
          .map(({ contributionId, payload }) => ({
            contributionId,
            payload: modelContributionPayload(payload),
          })),
      ),
    }),
  )
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
      input: input.review.context.input,
      inputFormat: 'omp-build:review-input/3',
      slots,
      stage: 'recall',
      purpose: 'review',
      plan: recall.value,
      policy: input.review.policy,
    },
    observedEvidence: input.review.observedEvidence,
    knownSlots: input.knownSlots,
  })
}

export async function finalizeReview(input: {
  review: FinalizationInput
  identity: ReviewIdentity
  scope: Scope
  contributions: readonly PublishedContribution[]
  inventories: readonly string[]
  readHistory: () => Promise<Parameters<typeof validateDecision>[1]>
  publish(record: CanonicalRecord, failurePrefix: string): Promise<void>
  onDecisionConfirmed(decisionId: string): void
}): Promise<void> {
  const authorization = await input.review.authorize('synthesis')
  if (!authorization.ok) throw new Error(`final-publication-refused:${authorization.reason}`)
  const contribution = input.contributions.find((item) => item.child.expectedId === 'synthesis')
  if (!contribution || contribution.child.structured === null) throw new Error('synthesis-contribution-missing')
  const judgment = decisionSchema.safeParse(contribution.child.structured)
  if (!judgment.success || judgment.data.purpose !== 'review') throw new Error('synthesis-decision-invalid')

  const decisionRecordId = input.identity.next('decision')
  const decision = requireRecord(
    buildRecord({
      ...recordBase(input.identity, input.scope, decisionRecordId),
      kind: 'decision',
      payload: { originalContributionId: contribution.id, judgment: judgment.data },
    } satisfies Extract<RecordDraft, { kind: 'decision' }>),
    'decision',
  )
  await input.publish(decision, 'decision-unconfirmed')

  const assessment = validateDecision(
    decision,
    await input.readHistory(),
    input.review.canonicalClasses,
    input.review.policy.version === 'evidence-v1' ? input.review.policy.acceptanceRef : null,
  )
  if (!assessment.admissible) {
    throw new Error(`decision-refused:${assessment.diagnostics.map((item) => item.code).join(',')}`)
  }
  input.onDecisionConfirmed(decision.recordId)
  if (input.review.context.subject.kind === 'epic-range') return

  const reviewRecordId = input.identity.next('review')
  const review = requireRecord(
    buildRecord({
      ...recordBase(input.identity, input.scope, reviewRecordId),
      kind: 'review',
      payload: {
        candidateGitSHA: input.review.context.candidateGitSHA,
        input: input.review.context.input,
        inventoryIds: [...input.inventories],
        inputFormat: 'omp-build:review-input/3',
        decisionId: decision.recordId,
      },
    } satisfies Extract<RecordDraft, { kind: 'review' }>),
    'review',
  )
  await input.publish(review, 'review-unconfirmed')
  return
}

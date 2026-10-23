import {
  buildRecord,
  type CanonicalRecord,
  decisionSchema,
  decodeHistory,
  deriveRecallPlan,
  type GitHubOptions,
  githubScope,
  type Kind,
  type Payloads,
  type Policy,
  parseRecord,
  type RecordDraft,
  type RecordProjectionConfig,
  type Result,
  type ReviewInputSnapshot,
  readGitHubHistory,
  type Scope,
  type Slot,
  validateDecision,
} from '../dist/contracts.js'
import type { NativeBatchResult, NativeChildResult, NativeTask } from '../omp/review-runtime'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'
import { modelContributionPayload, nativeContributionPayload } from './native-contribution'
import type { PreparedReviewBatch, PublishedContribution, ReviewContext, ReviewPublisher, ReviewStage } from './review'
import type { ReviewConfig } from './review-config'
import { allocateReviewPanel, createRecallTask, type ReviewChunk, type ReviewPanel } from './review-context'
import type { ObservedEvidence } from './review-inputs'

export type PreparedReviewInputs = {
  context: ReviewContext & {
    number: number
    subject: { kind: 'pull-request' } | { kind: 'epic-range'; range: string }
  }
  pr: { base: string; baseGitSHA: string }
  chunks: readonly ReviewChunk[]
  roster: Parameters<typeof allocateReviewPanel>[0]['roster']
  config: ReviewConfig
  policy: Policy
  semantic: { spec: string; panel: string; synthesis: string }
  observedEvidence: ObservedEvidence
  inputSnapshot: ReviewInputSnapshot
  canonicalClasses: readonly string[]
  /** Fresh host revalidation; it must reject a moved/stale/closed target. */
  authorize(stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }>
}

type Identity = { runId: string; operationId: string; next(kind: string): string }

type ReviewSlot = Slot

function candidateSource(input: PreparedReviewInputs): string {
  const subject =
    input.context.subject.kind === 'epic-range'
      ? `Epic range subject: ${input.context.subject.range}`
      : `Pull-request subject on base ${input.pr.base}`
  return [
    `Review target: ${input.context.repository}#${input.context.number}`,
    subject,
    `Candidate head: ${input.context.candidateGitSHA}`,
    `Base branch: ${input.pr.base}`,
    `Base commit: ${input.pr.baseGitSHA}`,
    'Complete candidate chunk material:',
    ...input.chunks.map((chunk) =>
      [
        `Chunk ${chunk.index} full diff:\n${chunk.diff}`,
        `Chunk ${chunk.index} digest:\n${chunk.digest}`,
        `Chunk ${chunk.index} candidate files:\n${chunk.files.map((file) => `${file.deleted ? 'deleted' : file.binary ? 'binary' : 'present'} ${file.path}\n${file.text ?? ''}`).join('\n\n')}`,
      ].join('\n\n'),
    ),
  ].join('\n\n')
}

function observedEvidenceContext(evidence: ObservedEvidence): string {
  return ['Captured immutable review evidence — facts, not a model claim:', JSON.stringify(evidence)].join('\n')
}

function createIdentity(context: Pick<ReviewContext, 'runId' | 'operationId'>): Identity {
  let sequence = 0
  return {
    runId: context.runId,
    operationId: context.operationId,
    next(kind) {
      sequence += 1
      return `${context.runId}-${kind}-${sequence}`
    },
  }
}

function slotsForInitial(specTask: NativeTask, panel: ReviewPanel): ReviewSlot[] {
  const spec: ReviewSlot = {
    slotId: specTask.name,
    phase: 'spec',
    role: 'R-review-spec',
    chunk: null,
    required: true,
    output: 'spec',
    classId: null,
    sourceFindingIds: [],
  }
  const panelSlots = panel.tasks.map((task) => {
    const match = /^panel-(\d+)-(.+)$/.exec(task.name)
    if (!match) throw new Error(`panel task has no canonical slot name: ${task.name}`)
    return {
      slotId: task.name,
      phase: 'panel' as const,
      role: match[2],
      chunk: Number(match[1]),
      required: true,
      output: 'findings' as const,
      classId: null,
      sourceFindingIds: [],
    }
  })
  return [spec, ...panelSlots]
}
function recordBase(identity: Identity, scope: Scope, recordId: string) {
  return {
    version: 1 as const,
    recordId,
    runId: identity.runId,
    operationId: `${identity.operationId}-${identity.next('op')}`,
    repository: scope.repository,
    target: scope.target,
  }
}

function requireRecord<K extends Kind>(
  result: Result<Extract<CanonicalRecord, { kind: K }>>,
  kind: K,
): Extract<CanonicalRecord, { kind: K }> {
  if (!result.ok)
    throw new Error(`canonical ${kind} rejected: ${result.diagnostics.map((item) => item.code).join(',')}`)
  return result.value
}

/**
 * Host-side record/stage controller. It creates only schema-validated canonical
 * records and lets model reports supply findings/decision semantics unchanged.
 */
export class CanonicalReviewRunner implements ReviewPublisher {
  readonly #scope: Scope
  readonly #identity: Identity
  readonly #publisher
  readonly #inventories: string[] = []
  #slots = new Map<string, ReviewSlot>()
  readonly #sourceContributionIds = new Set<string>()
  readonly #sourceContributions: { contributionId: string; payload: Payloads['contribution'] }[] = []
  readonly #options: GitHubOptions
  #confirmedDecisionId: string | null = null

  constructor(
    private readonly input: PreparedReviewInputs,
    options: GitHubOptions,
  ) {
    this.#scope = githubScope(input.context.repository, input.context.number)
    this.#options = withRoxabiGitHubPolicy(options)
    const projectionConfig: RecordProjectionConfig = {
      taxonomy: input.canonicalClasses,
      acceptedPolicy: input.policy.version === 'evidence-v1' ? input.policy.acceptanceRef : null,
    }
    this.#publisher = createGitHubRecordPublisher(this.#scope, this.#options, projectionConfig)
    this.#identity = createIdentity(input.context)
  }

  get context(): PreparedReviewInputs['context'] {
    return this.input.context
  }

  confirmedDecisionId(): string | null {
    return this.#confirmedDecisionId
  }

  initialBatch(): PreparedReviewBatch {
    const panel = allocateReviewPanel({
      chunks: this.input.chunks,
      roster: this.input.roster,
      config: this.input.config,
      commonContext: this.input.semantic.panel,
    })
    const specTask: NativeTask = {
      name: 'spec',
      agent: 'R-review-spec',
      solutionSpace: 'assess only supplied specification obligations',
      task: [this.input.semantic.spec, candidateSource(this.input)].join('\n\n'),
    }
    const slots = slotsForInitial(specTask, panel)
    const initialPayload: Payloads['review-attempt'] =
      this.input.context.subject.kind === 'pull-request'
        ? {
            rootAttemptId: 'pending',
            candidateGitSHA: this.input.context.candidateGitSHA,
            input: this.input.context.input,
            slots,
            stage: 'initial',
            purpose: 'review',
            tier: panel.allocation.global.tier,
            allocation: panel.allocation,
            policy: this.input.policy,
            subject: this.input.context.subject,
            inputSnapshot: this.input.inputSnapshot,
          }
        : {
            rootAttemptId: 'pending',
            candidateGitSHA: this.input.context.candidateGitSHA,
            input: this.input.context.input,
            slots,
            stage: 'initial',
            purpose: 'review',
            tier: null,
            allocation: panel.allocation,
            policy: this.input.policy,
            subject: this.input.context.subject,
            inputSnapshot: null,
          }
    return this.#inventory('initial', slots, [specTask, ...panel.tasks], initialPayload)
  }
  async authorize(context: ReviewContext, stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (
      context.repository !== this.#scope.repository ||
      context.target !== this.#scope.target ||
      context.candidateGitSHA !== this.input.context.candidateGitSHA
    )
      return { ok: false, reason: 'review-context-mismatch' }
    return this.input.authorize(stage)
  }

  async publishInventory(prepared: PreparedReviewBatch): Promise<{ ok: true } | { ok: false; reason: string }> {
    const parsed = parseRecord(prepared.inventory)
    if (!parsed.ok) return { ok: false, reason: 'inventory-invalid' }
    const saved = await this.#publisher.publish(parsed.value)
    if (!saved.ok) return { ok: false, reason: saved.diagnostics.join(',') }
    this.#inventories.push(parsed.value.recordId)
    return { ok: true }
  }

  async publishRawContribution(
    prepared: PreparedReviewBatch,
    child: NativeChildResult,
  ): Promise<PublishedContribution> {
    const slot = child.expectedId === null ? null : (this.#slots.get(child.expectedId) ?? null)
    const inventory = parseRecord(prepared.inventory)
    if (!inventory.ok) throw new Error('inventory-invalid')
    const recordId = this.#identity.next('contribution')
    const item = requireRecord(
      buildRecord({
        ...recordBase(this.#identity, this.#scope, recordId),
        kind: 'contribution',
        payload: nativeContributionPayload(slot, child, inventory.value.recordId, recordId, 'findings'),
      } satisfies Extract<RecordDraft, { kind: 'contribution' }>),
      'contribution',
    )
    const saved = await this.#publisher.publish(item)
    if (!saved.ok) throw new Error(`contribution-unconfirmed:${saved.diagnostics.join(',')}`)
    if (slot !== null && slot.phase !== 'synthesis') {
      this.#sourceContributionIds.add(item.recordId)
      this.#sourceContributions.push({ contributionId: item.recordId, payload: item.payload })
    }
    return { id: item.recordId, child }
  }

  async completeStage(
    prepared: PreparedReviewBatch,
    result: NativeBatchResult,
    contributions: readonly PublishedContribution[],
  ): Promise<PreparedReviewBatch | null> {
    if (!result.complete) throw new Error('required-native-result-incomplete')
    if (prepared.stage === 'initial') {
      const history = await this.#history()
      const recall = deriveRecallPlan(history, prepared.rootAttemptId, this.input.canonicalClasses)
      if (!recall.ok) throw new Error(`recall-plan-refused:${recall.diagnostics.map((item) => item.code).join(',')}`)
      if (recall.value.triggeredClassIds.length === 0) return this.#synthesis(prepared.rootAttemptId)
      const recallEntries = recall.value.index.filter((item) => recall.value.triggeredClassIds.includes(item.classId))
      const tasks = recallEntries.map((item) =>
        createRecallTask({
          ...item,
          canonicalClasses: this.input.canonicalClasses,
          context: this.input.semantic.panel,
          sourceEvidence: JSON.stringify(
            this.#sourceContributions
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
      return this.#inventory('recall', slots, tasks, {
        rootAttemptId: prepared.rootAttemptId,
        candidateGitSHA: this.input.context.candidateGitSHA,
        input: this.input.context.input,
        slots,
        stage: 'recall',
        purpose: 'review',
        plan: recall.value,
        policy: this.input.policy,
      })
    }
    if (prepared.stage === 'recall') return this.#synthesis(prepared.rootAttemptId)
    await this.#finalize(prepared, contributions)
    return null
  }

  async publishRequiredStop(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: false, reason: 'review-stop-requires-final-review' }
  }
  async stop(_context: ReviewContext, reason: string): Promise<void> {
    throw new Error(`review-stopped:${reason}`)
  }

  #inventory(
    stage: ReviewStage,
    slots: ReviewSlot[],
    tasks: NativeTask[],
    payload: Payloads['review-attempt'],
  ): PreparedReviewBatch {
    const recordId = this.#identity.next('review-attempt')
    const inheritedRoot = payload.rootAttemptId
    if (stage !== 'initial' && typeof inheritedRoot !== 'string') throw new Error('inventory-root-missing')
    const rootAttemptId = stage === 'initial' ? recordId : inheritedRoot
    const materialized: Payloads['review-attempt'] = { ...payload, rootAttemptId }
    const item = requireRecord(
      buildRecord({
        ...recordBase(this.#identity, this.#scope, recordId),
        kind: 'review-attempt',
        payload: materialized,
      } satisfies Extract<RecordDraft, { kind: 'review-attempt' }>),
      'review-attempt',
    )
    for (const slot of slots) this.#slots.set(slot.slotId, slot)
    return {
      stage,
      rootAttemptId,
      inventory: item,
      batch: {
        operationId: item.operationId,
        tasks: { context: observedEvidenceContext(this.input.observedEvidence), tasks },
      },
    }
  }

  #synthesis(rootAttemptId: string): PreparedReviewBatch {
    const task: NativeTask = {
      solutionSpace: 'synthesize confirmed review contributions into one strict structured decision',
      name: 'synthesis',
      agent: 'R-review-synthesis',
      task: [
        this.input.semantic.synthesis,
        candidateSource(this.input),
        'Confirmed native source contributions (every original ID, provenance, extracted evidence, structured output, and raw attempt is authoritative):',
        JSON.stringify(
          this.#sourceContributions.map(({ contributionId, payload }) => ({
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
        sourceFindingIds: [...this.#sourceContributionIds],
      },
    ]
    return this.#inventory('synthesis', slots, [task], {
      rootAttemptId,
      candidateGitSHA: this.input.context.candidateGitSHA,
      input: this.input.context.input,
      slots,
      stage: 'synthesis',
      purpose: 'review',
      policy: this.input.policy,
    })
  }

  async #finalize(_prepared: PreparedReviewBatch, contributions: readonly PublishedContribution[]): Promise<void> {
    const authorization = await this.input.authorize('synthesis')
    if (!authorization.ok) throw new Error(`final-publication-refused:${authorization.reason}`)
    const contribution = contributions.find((item) => item.child.expectedId === 'synthesis')
    if (!contribution || contribution.child.structured === null) throw new Error('synthesis-contribution-missing')
    const judgment = decisionSchema.safeParse(contribution.child.structured)
    if (!judgment.success || judgment.data.purpose !== 'review') throw new Error('synthesis-decision-invalid')
    const decisionRecordId = this.#identity.next('decision')
    const decision = requireRecord(
      buildRecord({
        ...recordBase(this.#identity, this.#scope, decisionRecordId),
        kind: 'decision',
        payload: { originalContributionId: contribution.id, judgment: judgment.data },
      } satisfies Extract<RecordDraft, { kind: 'decision' }>),
      'decision',
    )
    const publishedDecision = await this.#publisher.publish(decision)
    if (!publishedDecision.ok) throw new Error(`decision-unconfirmed:${publishedDecision.diagnostics.join(',')}`)
    const history = await this.#history()
    const assessment = validateDecision(
      decision,
      history,
      this.input.canonicalClasses,
      this.input.policy.version === 'evidence-v1' ? this.input.policy.acceptanceRef : null,
    )
    if (!assessment.admissible)
      throw new Error(`decision-refused:${assessment.diagnostics.map((item) => item.code).join(',')}`)
    this.#confirmedDecisionId = decision.recordId
    // Epic range finalization stops at the decision. Driver review consumes it
    // and publishes epic-event. Never emit a PR-final kind=review round here.
    if (this.input.context.subject.kind === 'epic-range') return
    const reviewRecordId = this.#identity.next('review')
    const review = requireRecord(
      buildRecord({
        ...recordBase(this.#identity, this.#scope, reviewRecordId),
        kind: 'review',
        payload: {
          candidateGitSHA: this.input.context.candidateGitSHA,
          input: this.input.context.input,
          inventoryIds: this.#inventories,
          decisionId: decision.recordId,
        },
      } satisfies Extract<RecordDraft, { kind: 'review' }>),
      'review',
    )
    const publishedReview = await this.#publisher.publish(review)
    if (!publishedReview.ok) throw new Error(`review-unconfirmed:${publishedReview.diagnostics.join(',')}`)
  }

  async #history() {
    return decodeHistory(await readGitHubHistory(this.#scope, this.#options))
  }
}

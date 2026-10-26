import type { GitHubOptions } from '../dist/contracts.js'
import {
  buildRecord,
  type CanonicalRecord,
  decodeHistory,
  githubScope,
  type Policy,
  parseRecord,
  type RecordDraft,
  type ReviewInputSnapshot,
  readGitHubHistory,
  type Scope,
} from '../dist/contracts.js'
import type { NativeBatchResult, NativeChildResult, NativeTask } from '../omp/review-runtime/contracts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'
import { nativeContributionPayload } from './native-contribution'
import type { ReviewConfig } from './review-config'
import type {
  PreparedReviewBatch,
  PublishedContribution,
  ReviewContext,
  ReviewPublisher,
  ReviewStage,
} from './review-contract'
import type { ObservedEvidence } from './review-input-contract'
import { allocateReviewPanel, type ReviewChunk } from './review-panel'
import {
  candidateSource,
  createInventory,
  createReviewIdentity,
  type ReviewSlot,
  recordBase,
  requireRecord,
  slotsForInitial,
} from './review-records'
import { advanceReviewStage, createSynthesisBatch, finalizeReview } from './review-runner-outcomes'

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
  /** Fresh host revalidation; it must reject a moved, stale, or closed target. */
  authorize(stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** Canonical records retain native evidence before admission interprets it. */
export class CanonicalReviewRunner implements ReviewPublisher {
  readonly #scope: Scope
  readonly #identity
  readonly #options: GitHubOptions
  readonly #publisher
  readonly #inventories: string[] = []
  readonly #slots = new Map<string, ReviewSlot>()
  readonly #sourceContributionIds = new Set<string>()
  readonly #sourceContributions: {
    contributionId: string
    payload: Extract<CanonicalRecord, { kind: 'contribution' }>['payload']
  }[] = []
  #confirmedDecisionId: string | null = null

  constructor(
    private readonly input: PreparedReviewInputs,
    options: GitHubOptions,
  ) {
    this.#scope = githubScope(input.context.repository, input.context.number)
    this.#options = withRoxabiGitHubPolicy(options)
    const projectionConfig = {
      taxonomy: input.canonicalClasses,
      acceptedPolicy: input.policy.version === 'evidence-v1' ? input.policy.acceptanceRef : null,
    }
    this.#publisher = createGitHubRecordPublisher(this.#scope, this.#options, projectionConfig)
    this.#identity = createReviewIdentity(input.context)
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
    const payload =
      this.input.context.subject.kind === 'pull-request'
        ? {
            rootAttemptId: 'pending',
            candidateGitSHA: this.input.context.candidateGitSHA,
            inputFormat: 'omp-build:review-input/3' as const,
            input: this.input.context.input,
            slots,
            stage: 'initial' as const,
            purpose: 'review' as const,
            tier: panel.allocation.global.tier,
            allocation: panel.allocation,
            policy: this.input.policy,
            subject: this.input.context.subject,
            inputSnapshot: this.input.inputSnapshot,
          }
        : {
            rootAttemptId: 'pending',
            candidateGitSHA: this.input.context.candidateGitSHA,
            inputFormat: 'omp-build:review-input/3' as const,
            input: this.input.context.input,
            slots,
            stage: 'initial' as const,
            purpose: 'review' as const,
            tier: null,
            allocation: panel.allocation,
            policy: this.input.policy,
            subject: this.input.context.subject,
            inputSnapshot: null,
          }
    return createInventory({
      identity: this.#identity,
      scope: this.#scope,
      stage: 'initial',
      slots,
      tasks: [specTask, ...panel.tasks],
      payload,
      observedEvidence: this.input.observedEvidence,
      knownSlots: this.#slots,
    })
  }

  async authorize(context: ReviewContext, stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (
      context.repository !== this.#scope.repository ||
      context.target !== this.#scope.target ||
      context.candidateGitSHA !== this.input.context.candidateGitSHA
    ) {
      return { ok: false, reason: 'review-context-mismatch' }
    }
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
    if (prepared.stage === 'synthesis') {
      await this.#finalize(prepared, contributions)
      return null
    }
    return advanceReviewStage({
      review: this.input,
      prepared,
      identity: this.#identity,
      scope: this.#scope,
      sourceContributions: this.#sourceContributions,
      knownSlots: this.#slots,
      readHistory: () => this.#history(),
      createSynthesis: (rootAttemptId) => this.#synthesis(rootAttemptId),
    })
  }

  async publishRequiredStop(): Promise<{ ok: true } | { ok: false; reason: string }> {
    return { ok: false, reason: 'review-stop-requires-final-review' }
  }

  async stop(_context: ReviewContext, reason: string): Promise<void> {
    throw new Error(`review-stopped:${reason}`)
  }

  #synthesis(rootAttemptId: string): PreparedReviewBatch {
    return createSynthesisBatch({
      review: this.input,
      identity: this.#identity,
      scope: this.#scope,
      sourceContributions: this.#sourceContributions,
      sourceContributionIds: this.#sourceContributionIds,
      knownSlots: this.#slots,
      rootAttemptId,
    })
  }

  async #finalize(_prepared: PreparedReviewBatch, contributions: readonly PublishedContribution[]): Promise<void> {
    await finalizeReview({
      review: this.input,
      identity: this.#identity,
      scope: this.#scope,
      contributions,
      inventories: this.#inventories,
      readHistory: () => this.#history(),
      publish: async (record, failurePrefix) => {
        const saved = await this.#publisher.publish(record)
        if (!saved.ok) throw new Error(`${failurePrefix}:${saved.diagnostics.join(',')}`)
      },
      onDecisionConfirmed: (decisionId) => {
        this.#confirmedDecisionId = decisionId
      },
    })
  }

  async #history() {
    return decodeHistory(await readGitHubHistory(this.#scope, this.#options))
  }
}

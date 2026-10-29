import { isDeepStrictEqual } from 'node:util'
import { gh as githubClient } from '../adapters/github/types.ts'
import type { GitHubOptions } from '../dist/contracts.js'
import {
  buildRecord,
  type CanonicalRecord,
  decodeHistory,
  githubScope,
  parseRecord,
  type RecordDraft,
  readGitHubHistory,
  type Scope,
} from '../dist/contracts.js'
import type { NativeBatchResult, NativeChildResult } from '../omp/review-runtime/contracts'
import { deliveryTask } from './delivery-action.ts'
import { withRoxabiGitHubPolicy } from './github-policy'
import { createGitHubRecordPublisher } from './github-publisher'
import { nativeContributionPayload } from './native-contribution'
import type {
  PreparedReviewBatch,
  PreparedReviewInputs,
  PublishedContribution,
  ReviewContext,
  ReviewPublisher,
  ReviewStage,
} from './review-contract'
import { allocateReviewPanel } from './review-panel'
import {
  createInventory,
  createReviewIdentity,
  observedEvidenceContext,
  type ReviewSlot,
  recordBase,
  requireRecord,
  slotsForInitial,
} from './review-records'
import { publishReviewInventory } from './review-runner-inventory'
import { advanceReviewStage, createSynthesisBatch, finalizeReview } from './review-runner-outcomes'
import { readReviewInputHistories } from './uw-input-readers.ts'

export type { PreparedReviewInputs }

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
    const actions = this.input.actions
    const specAction = actions.spec
    if (specAction === undefined) throw new Error('review-action-unprepared')
    const fingerprint = specAction.inputs.fingerprint
    const specTask = deliveryTask({
      name: 'spec',
      agent: 'R-review-spec',
      procedure:
        'Judge each accepted criterion in the index. Return one verdict per criterion, with an independent codeLink for every examined run. Missing, unknown, or unsupported executed-version linkage is not satisfied. Do not publish or implement.',
      solutionSpace: 'assess only supplied specification obligations',
      prepared: specAction,
    })
    const slots = slotsForInitial(specTask, panel).map((slot) => {
      const action = actions[slot.slotId]
      if (action === undefined) throw new Error('review-action-unprepared')
      return { ...slot, action: { actionId: action.snapshot.actionId, inputs: action.inputs } }
    })
    const panelTasks = panel.tasks.map((task) => {
      const prepared = actions[task.name]
      if (prepared === undefined || prepared.inputs.fingerprint !== fingerprint)
        throw new Error('review-action-unprepared')
      return deliveryTask({
        name: task.name,
        agent: task.agent,
        solutionSpace: task.solutionSpace,
        prepared,
        procedure: 'Review the assigned chunk named by the index. Return structured findings only. Do not publish.',
      })
    })
    const subject = this.input.context.subject
    const shared = {
      rootAttemptId: 'pending',
      candidateGitSHA: this.input.context.candidateGitSHA,
      inputFormat: 'omp-build:review-input/4' as const,
      input: specAction.inputs.fingerprint,
      actionInputDigest: specAction.inputs.fingerprint,
      slots,
      stage: 'initial' as const,
      purpose: 'review' as const,
      allocation: panel.allocation,
      policy: this.input.policy,
      inputSnapshot: specAction.inputs,
    }
    const payload =
      subject.kind === 'epic-range'
        ? { ...shared, tier: null, subject }
        : { ...shared, tier: panel.allocation.global.tier, subject }
    const tasks = [specTask, ...panelTasks]
    if (this.input.initialInventory !== undefined) {
      const inventory = this.input.initialInventory
      if (
        inventory.repository !== this.#scope.repository ||
        inventory.target !== this.#scope.target ||
        inventory.recordId !== inventory.payload.rootAttemptId ||
        inventory.payload.candidateGitSHA !== payload.candidateGitSHA ||
        inventory.payload.input !== payload.input ||
        inventory.payload.stage !== payload.stage ||
        inventory.payload.purpose !== payload.purpose ||
        !isDeepStrictEqual(inventory.payload.slots, payload.slots) ||
        JSON.stringify(inventory.payload.allocation) !== JSON.stringify(payload.allocation) ||
        JSON.stringify(inventory.payload.policy) !== JSON.stringify(payload.policy) ||
        JSON.stringify(inventory.payload.subject) !== JSON.stringify(payload.subject) ||
        !isDeepStrictEqual(inventory.payload.inputSnapshot, payload.inputSnapshot)
      ) {
        throw new Error('replacement-inventory-template-mismatch')
      }
      for (const slot of slots) this.#slots.set(slot.slotId, slot)
      return {
        stage: 'initial',
        rootAttemptId: inventory.payload.rootAttemptId,
        inventory,
        batch: {
          operationId: inventory.operationId,
          tasks: {
            context: observedEvidenceContext(this.input.observedEvidence),
            tasks,
          },
        },
      }
    }
    return createInventory({
      identity: this.#identity,
      scope: this.#scope,
      stage: 'initial',
      slots,
      tasks,
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
    return publishReviewInventory({
      prepared,
      initialInventoryId: this.input.initialInventory?.recordId,
      inventories: this.#inventories,
      readHistory: () => this.#history(),
      publish: (record) => this.#publisher.publish(record),
    })
  }
  async publishRawContribution(
    prepared: PreparedReviewBatch,
    child: NativeChildResult,
  ): Promise<PublishedContribution> {
    const inventory = parseRecord(prepared.inventory)
    if (!inventory.ok || inventory.value.kind !== 'review-attempt') throw new Error('inventory-invalid')
    const slot =
      child.expectedId !== null &&
      inventory.value.payload.slots.some((candidate) => candidate.slotId === child.expectedId)
        ? (this.#slots.get(child.expectedId) ?? null)
        : null
    const recordId = this.#identity.next('contribution')
    const item = requireRecord(
      buildRecord({
        ...recordBase(this.#identity, this.#scope, recordId),
        kind: 'contribution',
        payload: nativeContributionPayload(slot, child, inventory.value.recordId, recordId, 'findings'),
      } satisfies Extract<RecordDraft, { kind: 'contribution' }>),
      'contribution',
    )
    const saved = await this.#publisher.publish(item, [], child.canPublishContext)
    if (!saved.ok) throw new Error(`contribution-unconfirmed:${saved.diagnostics.join(',')}`)
    if (slot !== null && slot.phase !== 'synthesis' && child.contextBlock === undefined) {
      this.#sourceContributionIds.add(item.recordId)
      this.#sourceContributions.push({ contributionId: item.recordId, payload: item.payload })
    }
    return { id: item.recordId, child }
  }
  async completeStage(
    prepared: PreparedReviewBatch,
    result: NativeBatchResult,
    contributions: readonly PublishedContribution[],
    canContinue?: () => boolean,
  ): Promise<PreparedReviewBatch | null> {
    if (canContinue === undefined) throw new Error('review-continuation-unfenced')
    if (!canContinue()) return null
    if (!result.complete) throw new Error('required-native-result-incomplete')
    if (prepared.stage === 'synthesis') {
      await this.#finalize(contributions, canContinue)
      return null
    }
    if (!canContinue()) return null
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
  async #synthesis(rootAttemptId: string): Promise<PreparedReviewBatch> {
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

  async #finalize(contributions: readonly PublishedContribution[], canContinue: () => boolean): Promise<void> {
    await finalizeReview({
      review: this.input,
      identity: this.#identity,
      scope: this.#scope,
      contributions,
      inventories: this.#inventories,
      canContinue,
      readHistory: () => this.#history(),
      publish: async (record, failurePrefix, externalHistories = []) => {
        const saved = await this.#publisher.publish(record, externalHistories)
        if (!saved.ok) throw new Error(`${failurePrefix}:${saved.diagnostics.join(',')}`)
      },
      readExternalHistories: (history) =>
        readReviewInputHistories(history, {
          cwd: this.#options.cwd,
          gh: githubClient(this.#options),
          readAuthor: this.#options.readAuthor,
        }),
      onDecisionConfirmed: (decisionId) => {
        this.#confirmedDecisionId = decisionId
      },
    })
  }
  async #history() {
    return decodeHistory(await readGitHubHistory(this.#scope, this.#options))
  }
}

import type {
  Json,
  NativeBatch,
  NativeBatchCallbacks,
  NativeBatchController,
  NativeBatchResult,
  NativeChildResult,
} from '../omp/review-runtime'

export type ReviewSubject = { kind: 'pull-request' } | { kind: 'epic-range'; range: string }
export type ReviewStage = 'initial' | 'recall' | 'synthesis'

export type ReviewContext = {
  operationId: string
  runId: string
  repository: string
  target: string
  candidateGitSHA: string
  input: string | null
  subject: ReviewSubject
}

export type PreparedReviewBatch = {
  stage: ReviewStage
  rootAttemptId: string
  inventory: Json
  batch: NativeBatch
}

export type PublishedContribution = {
  id: string
  child: NativeChildResult
}

/**
 * The host owns GitHub reads, fresh review-input validation, and record writing.
 * This controller owns only the phase ordering: inventory confirmation precedes
 * dispatch; every raw native submission is persisted before interpretation; a
 * stage never advances before every required native child is terminal and valid.
 */
export type ReviewPublisher = {
  authorize(context: ReviewContext, stage: ReviewStage): Promise<{ ok: true } | { ok: false; reason: string }>
  publishInventory(prepared: PreparedReviewBatch): Promise<{ ok: true } | { ok: false; reason: string }>
  publishRawContribution(prepared: PreparedReviewBatch, child: NativeChildResult): Promise<PublishedContribution>
  completeStage(
    prepared: PreparedReviewBatch,
    result: NativeBatchResult,
    contributions: readonly PublishedContribution[],
  ): Promise<PreparedReviewBatch | null>
  /** Persist the canonical sticky `stop` payload after fresh host authorization. */
  publishRequiredStop(
    context: ReviewContext,
    stop: Json,
    options?: { writeAuthor?: string },
  ): Promise<{ ok: true } | { ok: false; reason: string }>
  stop(context: ReviewContext, reason: string, result: NativeBatchResult | null): Promise<void>
}

export type ReviewNativePort = Pick<NativeBatchController, 'activate' | 'inactive'> & {
  announce(batch: NativeBatch): Promise<void>
}

/** Durable stop entry for the trusted CI/GitHub action layer; never derives a stop itself. */
export async function persistRequiredReviewStop(
  context: ReviewContext,
  stop: Json,
  publisher: Pick<ReviewPublisher, 'authorize' | 'publishRequiredStop'>,
  options: { writeAuthor?: string } = {},
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const authorization = await publisher.authorize(context, 'synthesis')
  if (!authorization.ok) return authorization
  return publisher.publishRequiredStop(context, stop, options)
}

export class ReviewProduct {
  constructor(
    private readonly native: ReviewNativePort,
    private readonly publisher: ReviewPublisher,
    private readonly canDispatch: () => boolean = () => true,
  ) {}

  async preparePullRequestReview(context: ReviewContext, prepared: PreparedReviewBatch): Promise<void> {
    if (context.subject.kind !== 'pull-request') throw new Error('pull-request review requires a pull-request subject')
    await this.#authorizePublishAndDispatch(context, prepared)
  }

  async prepareEpicRangeReview(context: ReviewContext, prepared: PreparedReviewBatch): Promise<void> {
    if (context.subject.kind !== 'epic-range') throw new Error('epic range review requires an epic-range subject')
    if (!/^[0-9a-f]{40}\.\.[0-9a-f]{40}$/.test(context.subject.range))
      throw new Error('epic range must be an exact commit range')
    if (!context.subject.range.endsWith(context.candidateGitSHA))
      throw new Error('epic candidate must be the range tail')
    await this.#authorizePublishAndDispatch(context, prepared)
  }

  async #authorizePublishAndDispatch(context: ReviewContext, prepared: PreparedReviewBatch): Promise<void> {
    if (!this.canDispatch()) throw new Error('review-dispatch-refused:fix-run-active')
    const authorization = await this.publisher.authorize(context, prepared.stage)
    if (!authorization.ok) {
      await this.publisher.stop(context, authorization.reason, null)
      return
    }
    const publication = await this.publisher.publishInventory(prepared)
    if (!publication.ok) {
      await this.publisher.stop(context, publication.reason, null)
      return
    }

    const contributions: PublishedContribution[] = []
    const callbacks: NativeBatchCallbacks = {
      onChildResult: async (child) => {
        contributions.push(await this.publisher.publishRawContribution(prepared, child))
      },
      onComplete: async (result) => {
        const next = await this.publisher.completeStage(prepared, result, contributions)
        if (next) await this.#authorizePublishAndDispatch(context, next)
      },
      onStop: async (reason, result) => {
        await this.publisher.stop(context, reason, result)
      },
    }
    if (!this.canDispatch()) throw new Error('review-dispatch-refused:fix-run-active')
    this.native.activate(prepared.batch, callbacks)
    try {
      await this.native.announce(prepared.batch)
    } catch (error) {
      this.native.inactive()
      await this.publisher.stop(context, error instanceof Error ? error.message : String(error), null)
      throw error
    }
  }
}

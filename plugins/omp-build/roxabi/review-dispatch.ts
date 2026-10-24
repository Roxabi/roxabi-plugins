import type { Json } from '../dist/contracts.js'
import type { NativeBatchCallbacks } from '../omp/review-runtime/contracts'
import type {
  PreparedReviewBatch,
  PublishedContribution,
  ReviewContext,
  ReviewNativePort,
  ReviewPublisher,
} from './review-contract'

/** Durable stop entry: it validates the current synthesis binding before writing. */
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

type ReviewDispatchOptions = {
  canDispatch?: () => boolean
  refusalReason?: () => string
}

/**
 * Dispatches an already-bound batch. Inventory confirmation and raw child
 * retention happen before the runner may interpret a stage result.
 */
export class ReviewProduct {
  constructor(
    private readonly native: ReviewNativePort,
    private readonly publisher: ReviewPublisher,
    private readonly options: ReviewDispatchOptions = {},
  ) {}

  #assertDispatchable(): void {
    if (this.options.canDispatch?.() ?? true) return
    throw new Error(`review-dispatch-refused:${this.options.refusalReason?.() ?? 'fix-run-active'}`)
  }

  async preparePullRequestReview(context: ReviewContext, prepared: PreparedReviewBatch): Promise<void> {
    if (context.subject.kind !== 'pull-request') throw new Error('pull-request review requires a pull-request subject')
    await this.#dispatch(context, prepared)
  }

  async prepareEpicRangeReview(context: ReviewContext, prepared: PreparedReviewBatch): Promise<void> {
    if (context.subject.kind !== 'epic-range') throw new Error('epic range review requires an epic-range subject')
    if (!/^[0-9a-f]{40}\.[.][0-9a-f]{40}$/.test(context.subject.range))
      throw new Error('epic range must be an exact commit range')
    if (!context.subject.range.endsWith(context.candidateGitSHA))
      throw new Error('epic candidate must be the range tail')
    await this.#dispatch(context, prepared)
  }

  async #dispatch(context: ReviewContext, prepared: PreparedReviewBatch): Promise<void> {
    this.#assertDispatchable()
    const authorization = await this.publisher.authorize(context, prepared.stage)
    if (!authorization.ok) return this.publisher.stop(context, authorization.reason, null)
    this.#assertDispatchable()
    const publication = await this.publisher.publishInventory(prepared)
    if (!publication.ok) return this.publisher.stop(context, publication.reason, null)

    const contributions: PublishedContribution[] = []
    const callbacks: NativeBatchCallbacks = {
      onChildResult: async (child) => {
        contributions.push(await this.publisher.publishRawContribution(prepared, child))
      },
      onComplete: async (result) => {
        const next = await this.publisher.completeStage(prepared, result, contributions)
        if (next !== null) await this.#dispatch(context, next)
      },
      onStop: async (reason, result) => {
        await this.publisher.stop(context, reason, result)
      },
    }
    this.#assertDispatchable()
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

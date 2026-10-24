import type { ReviewSummary } from '../../contracts.ts'
import type { Gh, Git } from './proof-base.ts'

export type ReviewStep =
  | { action: 'review'; reviews: number; reason: 'no-review' | 'head-moved' | 'no-verdict' | 'proof-changed' }
  | { action: 'fix'; reviews: number; remaining: number; reason?: 'ci-failed' }
  | { action: 'land'; reviews: number }
  | { action: 'stop'; reviews: number; reason: 'review-bound' | 'ci-failed'; message: string }
export type ReviewStepResult = ReviewStep & { disarmed?: true }
export type ReviewStepOptions = { ciFailed?: boolean; reviewing?: boolean; gh?: Gh; git?: Git }

export declare const MAX_FIX_ROUNDS: 2
/** Pure transition from already-read records. No arm, disarm, or publication. */
export declare function reviewStep(
  records: Pick<ReviewSummary, 'reviews' | 'verdict' | 'head' | 'spent'>,
  at: { head: string | null | undefined; ciFailed?: boolean },
): ReviewStep
export declare function persistObservedCiStop(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; git?: Git },
): Promise<boolean>
/** Progress selector only. It does not admit landing; landPr and CI allow exits do. */
export declare function nextReviewStep(
  cwd: string,
  pr: number | string,
  options?: ReviewStepOptions,
): Promise<ReviewStepResult>

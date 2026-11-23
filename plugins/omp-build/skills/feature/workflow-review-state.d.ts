import type { TrustedHostPluginPin } from '../../roxabi/uw-action-contract.ts'
import type { Gh, Git } from './review-base.ts'
import type { WithdrawalBarrier } from './workflow-gate.js'

export type ReviewStep =
  | { action: 'review'; reviews: number; reason: 'no-review' | 'head-moved' | 'no-verdict' | 'review-input-changed' }
  | { action: 'fix'; reviews: number; remaining: number; reason?: 'ci-failed' }
  | { action: 'land'; reviews: number }
  | { action: 'stop'; reviews: number; reason: 'review-bound' | 'ci-failed'; message: string }
export type ReviewStepResult = ReviewStep & { disarmed?: true; barrier?: WithdrawalBarrier | null }
export type ReviewStepOptions = {
  ciFailed?: boolean
  reviewing?: boolean
  gh?: Gh
  git?: Git
  pluginPin?: TrustedHostPluginPin
}

export declare const MAX_FIX_ROUNDS: 2
export declare function persistObservedCiStop(
  cwd: string,
  pr: number | string,
  deps?: { gh?: Gh; expectedHead?: string; expectedReviewId?: string },
): Promise<boolean>
/** Progress selector only. It does not admit landing; landPr and CI allow exits do. */
export declare function nextReviewStep(
  cwd: string,
  pr: number | string,
  options?: ReviewStepOptions,
): Promise<ReviewStepResult>

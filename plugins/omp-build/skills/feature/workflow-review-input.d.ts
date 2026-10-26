import type { ConfirmedReviewSemanticContext, ReviewSemanticCanon } from '../../roxabi/review-semantic-canon.ts'
import type { Gh, Git, Refusal } from './review-base.ts'
import type { ReviewInputCapture } from './review-input.ts'

export type ReviewCapture = Extract<ReviewInputCapture, { ok: true }> & {
  semantic: ConfirmedReviewSemanticContext
  semanticCanon: ReviewSemanticCanon
}
export type ReviewInputDeps = {
  gh?: Gh
  git?: Git
  semantic?: ConfirmedReviewSemanticContext
  automationLogin?: string
}

export declare function confirmedReviewSemanticContext(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  base: string,
  automationLogin?: string,
): Promise<ConfirmedReviewSemanticContext | Refusal>
/** Read-only review input capture at the already selected head; no gate or producer writes. */
export declare function captureReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  deps?: ReviewInputDeps,
): Promise<ReviewCapture | Refusal>
/** Refuse changed inputs before posting, without replacing the retained capture. */
export declare function validateReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  input: string | null,
  deps?: Omit<ReviewInputDeps, 'semantic'>,
): Promise<{ ok: true } | Refusal>

export declare function hasFreshReviewInput(
  cwd: string,
  pr: number | string,
  records: { head: string | null; input: string | null },
  deps?: Omit<ReviewInputDeps, 'semantic'>,
): Promise<boolean>

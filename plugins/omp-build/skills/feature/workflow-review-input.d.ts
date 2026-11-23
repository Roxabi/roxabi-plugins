import type { ConfirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon.ts'
import type { Gh, Git, Refusal } from './review-base.ts'

export type ReviewInputDeps = {
  gh?: Gh
  git?: Git
  automationLogin?: string
  pluginPin?: import('../../roxabi/uw-action-contract.ts').TrustedHostPluginPin
  persistedFingerprint?: string
  selectedReviewId?: string | null
  reviewedRoot?: import('../../roxabi/uw-action-contract.ts').ReviewRootRef
}

export declare function confirmedReviewSemanticContext(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  base: string,
  automationLogin?: string,
): Promise<ConfirmedReviewSemanticContext | Refusal>
/** Refuse changed inputs before posting, without replacing the retained capture. */
export declare function validateReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  input: string | null,
  deps?: ReviewInputDeps,
): Promise<{ ok: true } | Refusal>
/** Refuse changed inputs at landing; the current head requires a fresh review. */
export declare function validateLandingReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  input: string | null,
  deps?: ReviewInputDeps,
  mergedBase?: string,
): Promise<{ ok: true } | Refusal>

export declare function hasFreshReviewInput(
  cwd: string,
  pr: number | string,
  records: { head: string | null; input: string | null; reviewId: string | null },
  deps?: ReviewInputDeps,
): Promise<boolean>

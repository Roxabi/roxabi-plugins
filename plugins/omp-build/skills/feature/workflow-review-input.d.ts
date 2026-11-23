import type { ConfirmedReviewSemanticContext } from '../../roxabi/review-semantic-canon.ts'
import type { Gh, Git, Refusal } from './review-base.ts'

export type ReviewInputDeps = {
  gh?: Gh
  git?: Git
  automationLogin?: string
  pluginPin?: import('../../roxabi/uw-action-contract.ts').TrustedHostPluginPin
  selectedReviewId?: string | null
}

export declare function confirmedReviewSemanticContext(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  base: string,
  automationLogin?: string,
): Promise<ConfirmedReviewSemanticContext | Refusal>
/** Refuse changed inputs at landing; the current head requires a fresh review. */
export declare function validateLandingReviewInput(
  cwd: string,
  pr: number | string,
  head: string,
  input: string | null,
  deps?: ReviewInputDeps,
  mergedBase?: string,
): Promise<{ ok: true } | Refusal>

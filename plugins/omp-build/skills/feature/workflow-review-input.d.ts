import type { Gh, Git, Refusal } from './proof-base.ts'
import type { CaptureReviewInput } from './proof-capture.ts'
import type { ProofSemanticContext, ReviewSemanticCanon } from './proof-context.ts'

export type ReviewCapture = Pick<
  Extract<CaptureReviewInput, { ok: true }>,
  'ok' | 'input' | 'body' | 'semctx' | 'assertledger'
> & {
  semantic: ProofSemanticContext
  semanticCanon: ReviewSemanticCanon
}
export type ReviewInputDeps = { gh?: Gh; git?: Git; semantic?: ProofSemanticContext }

export declare function confirmedReviewSemanticContext(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  base: string,
): Promise<ProofSemanticContext | Refusal>
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

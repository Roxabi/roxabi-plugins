import type { Gh, Git, Refusal } from './proof-base.ts'
import type { CaptureReviewInput } from './proof-capture.ts'
import type { ProofSemanticContext } from './proof-context.ts'
import type { ReviewSemanticCanon } from './proof-semantic-canon.ts'

export type ReviewCapture = Pick<
  Extract<CaptureReviewInput, { ok: true }>,
  'ok' | 'input' | 'body' | 'semctx' | 'assertledger'
> & {
  semantic: ProofSemanticContext
  semanticCanon: ReviewSemanticCanon
}
export type ReviewInputDeps = { gh?: Gh; git?: Git; semantic?: ProofSemanticContext; automationLogin?: string }

export declare function confirmedReviewSemanticContext(
  cwd: string,
  pr: number | string,
  ghFn: Gh,
  base: string,
  automationLogin?: string,
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

export declare function hasFreshReviewInput(
  cwd: string,
  pr: number | string,
  records: { head: string | null; input: string | null },
  deps?: Omit<ReviewInputDeps, 'semantic'>,
): Promise<boolean>

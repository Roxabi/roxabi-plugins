import { createHash } from 'node:crypto'
import type { PrBody, ProofSemanticContext } from './proof-context'
import type { Target } from './proof-review-contract'
import { reviewSemanticCanon } from './proof-semantic-canon'

/** Exact observed review inputs and the shared semantic canon. */
export function hashReviewInput(
  repository: string,
  target: Pick<Target, 'pr' | 'candidate'>,
  body: PrBody,
  semantic: ProofSemanticContext,
): string {
  const bytes = JSON.stringify([
    'omp-build:review-input/3',
    repository,
    target.pr,
    target.candidate,
    [body.body, body.lastEditedAt],
    reviewSemanticCanon(semantic),
  ])
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

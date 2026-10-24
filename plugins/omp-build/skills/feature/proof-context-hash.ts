import { createHash } from 'node:crypto'
import type { PrComment } from './proof-base'
import type { PrBody, ProofSemanticContext } from './proof-context'
import type { Target } from './proof-review-contract'
import { reviewSemanticCanon } from './proof-semantic-canon'
/** Exact observed bytes, native publication identities, and the shared semantic canon. */
export function hashReviewInput(
  repository: string,
  target: Pick<Target, 'pr' | 'candidate'>,
  body: PrBody,
  semctx: PrComment[] | null,
  assertledger: PrComment[] | null,
  semantic: ProofSemanticContext,
): string {
  const parts = (run: PrComment[] | null) =>
    run?.map((part) => [part.id, part.body, part.createdAt, part.updatedAt]) ?? null
  const bytes = JSON.stringify([
    'omp-build:review-input/2',
    repository,
    target.pr,
    target.candidate,
    [body.body, body.lastEditedAt],
    parts(semctx),
    parts(assertledger),
    reviewSemanticCanon(semantic),
  ])
  return createHash('sha256').update(bytes, 'utf8').digest('hex')
}

/** The producer command an admission refusal names; run in the normal workflow, never by admission. */
export function acquireCommand(pr: number, extra = ''): string {
  const script = new URL('./proof-acquire.ts', import.meta.url).pathname
  return `bun '${script.replace(/'/g, `'\\''`)}' --pr ${pr}${extra}`
}

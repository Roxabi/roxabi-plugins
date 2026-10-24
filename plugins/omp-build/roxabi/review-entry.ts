import { randomUUID } from 'node:crypto'
import type { GitHubOptions } from '../dist/contracts.js'
import type { PreparedReviewInputs as AssembledReviewInputs } from './review-input-contract'
import { CanonicalReviewRunner } from './review-runner'

/** Binds immutable preparation facts to one deterministic record-id sequence. */
export function createPreparedReviewRunner(
  input: AssembledReviewInputs,
  options: GitHubOptions,
  authorize: (stage: 'initial' | 'recall' | 'synthesis') => Promise<{ ok: true } | { ok: false; reason: string }>,
): CanonicalReviewRunner {
  return new CanonicalReviewRunner(
    {
      context: { ...input.context, runId: `review-${randomUUID()}`, operationId: `review-operation-${randomUUID()}` },
      pr: { base: input.pr.base, baseGitSHA: input.pr.baseGitSHA },
      chunks: input.chunks,
      roster: input.roster,
      config: input.config,
      policy: input.policy,
      semantic: input.semantic.prompts,
      observedEvidence: input.observedEvidence,
      inputSnapshot: input.inputSnapshot,
      canonicalClasses: input.config.canonicalClasses,
      authorize,
    },
    options,
  )
}

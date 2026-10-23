import { randomUUID } from 'node:crypto'

import type { GitHubOptions } from '../dist/contracts.js'
import type { PreparedReviewInputs as AssembledReviewInputs } from './review-inputs'
import { CanonicalReviewRunner } from './review-runner'

/** Binds read-only preparation facts to the concrete canonical record runner. */
export function createPreparedReviewRunner(
  input: AssembledReviewInputs,
  options: GitHubOptions,
  authorize: (stage: 'initial' | 'recall' | 'synthesis') => Promise<{ ok: true } | { ok: false; reason: string }>,
): CanonicalReviewRunner {
  const runId = `review-${randomUUID()}`
  const operationId = `review-operation-${randomUUID()}`
  return new CanonicalReviewRunner(
    {
      context: { ...input.context, runId, operationId },
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

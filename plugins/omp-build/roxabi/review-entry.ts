import { randomUUID } from 'node:crypto'
import type { CanonicalRecord, GitHubOptions } from '../dist/contracts.js'
import type { ReviewContext } from './review-contract'
import type { PreparedReviewInputs as AssembledReviewInputs } from './review-input-contract'
import { CanonicalReviewRunner } from './review-runner'

export type PreparedReviewRunnerOptions = {
  identity?: Pick<ReviewContext, 'runId' | 'operationId'>
  initialInventory?: Extract<CanonicalRecord, { kind: 'review-attempt' }>
}

/** Binds immutable preparation facts to one deterministic record-id sequence. */
export function createPreparedReviewRunner(
  input: AssembledReviewInputs,
  options: GitHubOptions,
  authorize: (stage: 'initial' | 'recall' | 'synthesis') => Promise<{ ok: true } | { ok: false; reason: string }>,
  runnerOptions: PreparedReviewRunnerOptions = {},
): CanonicalReviewRunner {
  return new CanonicalReviewRunner(
    {
      context: {
        ...input.context,
        runId: runnerOptions.identity?.runId ?? `review-${randomUUID()}`,
        operationId: runnerOptions.identity?.operationId ?? `review-operation-${randomUUID()}`,
      },
      pr: { base: input.pr.base, baseGitSHA: input.pr.baseGitSHA },
      chunks: input.chunks,
      roster: input.roster,
      config: input.config,
      policy: input.policy,
      semantic: input.semantic.prompts,
      observedEvidence: input.observedEvidence,
      inputSnapshot: input.inputSnapshot,
      canonicalClasses: input.config.canonicalClasses,
      initialInventory: runnerOptions.initialInventory,
      authorize,
    },
    options,
  )
}

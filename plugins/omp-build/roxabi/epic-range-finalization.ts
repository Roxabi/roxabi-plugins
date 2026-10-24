import type { ScopedRecordRef } from '../dist/contracts.js'
import { type EpicRangeReviewRequest, epicBindReview, epicFinalReviewRequest } from '../skills/feature/epic-driver'
import { assembleEpicRangeInputs } from './epic-range-inputs'
import {
  type AcceptedEpicSemantic,
  acceptedEpicSemantic,
  epicSemanticCanon,
  type LiveEpicSpec,
} from './epic-range-semantic'
import { withRoxabiGitHubPolicy } from './github-policy'
import type { PreparedReviewBatch, ReviewContext, ReviewPublisher } from './review-contract'
import type { Gh, Git } from './review-input-contract'
import { CanonicalReviewRunner } from './review-runner'

export type PreparedEpicReview = {
  context: ReviewContext & { readonly number: number }
  prepared: PreparedReviewBatch
  publisher: ReviewPublisher
}

/**
 * Captures mandate-bound Epic inputs, then re-authorizes the exact mandate,
 * accepted semantic canon, request, and live issue before every stage/final write.
 */
export async function prepareEpicFinalReviewMaterials(input: {
  cwd: string
  request: EpicRangeReviewRequest
  mandateRef: ScopedRecordRef
  git: Git
  gh: Gh
  contextWindow?: number
}): Promise<PreparedEpicReview> {
  const assembled = await assembleEpicRangeInputs(input)
  const context = assembled.context
  const epic = context.number
  const sameMandate = (semantic: typeof assembled.observedEvidence.semanticContext): boolean =>
    semantic !== undefined &&
    semantic.binding !== null &&
    semantic.binding.recordId === input.mandateRef.recordId &&
    semantic.binding.scope.repository === input.mandateRef.scope.repository &&
    semantic.binding.scope.target === input.mandateRef.scope.target

  const readLiveSpec = async (): Promise<LiveEpicSpec> => {
    const issue = JSON.parse(
      await input.gh(input.cwd, [
        'issue',
        'view',
        String(epic),
        '--repo',
        input.request.repository,
        '--json',
        'body,updatedAt,labels',
      ]),
    ) as unknown
    if (
      issue === null ||
      typeof issue !== 'object' ||
      Array.isArray(issue) ||
      !('body' in issue) ||
      typeof issue.body !== 'string'
    ) {
      throw new Error('epic-live-spec-unreadable')
    }
    const labels =
      'labels' in issue && Array.isArray(issue.labels)
        ? issue.labels.flatMap((label) =>
            label !== null &&
            typeof label === 'object' &&
            !Array.isArray(label) &&
            'name' in label &&
            typeof label.name === 'string'
              ? [label.name]
              : [],
          )
        : []
    const contracts = await import('../dist/contracts.js')
    return {
      reference: input.request.target,
      number: epic,
      body: issue.body,
      digest: contracts.specDigest(issue.body),
      lastEditedAt: 'updatedAt' in issue && typeof issue.updatedAt === 'string' ? issue.updatedAt : null,
      labels,
    }
  }

  const specMatches = (accepted: AcceptedEpicSemantic['spec'], live: LiveEpicSpec): boolean =>
    accepted.reference === live.reference && accepted.body === live.body && accepted.digest === live.digest

  const capturedSemantic = assembled.observedEvidence.semanticContext
  if (
    capturedSemantic === undefined ||
    capturedSemantic.mode !== 'bound' ||
    !sameMandate(capturedSemantic) ||
    capturedSemantic.acceptedSpec.reference !== capturedSemantic.currentSpec.reference ||
    capturedSemantic.acceptedSpec.body !== capturedSemantic.currentSpec.body ||
    capturedSemantic.acceptedSpec.digest !== capturedSemantic.currentSpec.digest
  ) {
    throw new Error('epic-bound-semantic-mismatch')
  }

  const originalLive = await readLiveSpec()
  const originalAccepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, originalLive, input.gh)
  if (
    originalAccepted === null ||
    originalAccepted.semanticContext.mode !== 'bound' ||
    !sameMandate(originalAccepted.semanticContext) ||
    !specMatches(originalAccepted.spec, originalLive) ||
    originalAccepted.semanticCanon !== epicSemanticCanon(capturedSemantic)
  ) {
    throw new Error('epic-bound-semantic-mismatch')
  }

  const validate = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      const current = await epicFinalReviewRequest(input.cwd, epic)
      if (
        current.repository !== input.request.repository ||
        current.target !== input.request.target ||
        current.runId !== input.request.runId ||
        current.range !== input.request.range ||
        current.candidateGitSHA !== input.request.candidateGitSHA
      ) {
        return { ok: false, reason: 'epic-range-context-mismatch' }
      }

      const live = await readLiveSpec()
      const accepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, live, input.gh)
      if (
        accepted === null ||
        capturedSemantic.mode !== 'bound' ||
        accepted.semanticContext.mode !== 'bound' ||
        !sameMandate(accepted.semanticContext) ||
        !specMatches(accepted.spec, live) ||
        accepted.semanticCanon !== epicSemanticCanon(capturedSemantic)
      ) {
        return { ok: false, reason: 'epic-bound-semantic-unreadable' }
      }

      const capturedLive = capturedSemantic.currentSpec
      if (
        live.reference !== capturedLive.reference ||
        live.body !== capturedLive.body ||
        live.digest !== capturedLive.digest
      ) {
        return { ok: false, reason: 'epic-live-spec-mismatch' }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  assembled.authorize = async () => validate()
  const runner = new CanonicalReviewRunner(assembled, withRoxabiGitHubPolicy({ cwd: input.cwd, gh: input.gh }))
  const prepared = runner.initialBatch()
  let bound = false
  const publisher: ReviewPublisher = {
    authorize: (reviewContext, stage) => runner.authorize(reviewContext, stage),
    publishInventory: (batch) => runner.publishInventory(batch),
    publishRawContribution: (batch, child) => runner.publishRawContribution(batch, child),
    async completeStage(batch, result, contributions) {
      const next = await runner.completeStage(batch, result, contributions)
      if (next !== null) return next
      const decisionId = runner.confirmedDecisionId()
      if (decisionId === null) throw new Error('epic-review-decision-unconfirmed')
      if (!bound) {
        bound = true
        await epicBindReview(input.cwd, epic, decisionId, input.request.range)
      }
      return null
    },
    publishRequiredStop: () => runner.publishRequiredStop(),
    stop: (reviewContext, reason) => runner.stop(reviewContext, reason),
  }
  return { context, prepared, publisher }
}

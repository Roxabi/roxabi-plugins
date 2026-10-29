import type { ScopedRecordRef } from '../dist/contracts.js'
import { type EpicRangeReviewRequest, epicBindReview, epicFinalReviewRequest } from '../skills/feature/epic-driver'
import { actionRequest, codePin, prepareDeliveryAction, prepareRefusal, uwSubject } from './delivery-action.ts'
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
import { allocateReviewPanel } from './review-panel.ts'
import { CanonicalReviewRunner } from './review-runner'
import type { PreparedUwAction } from './uw-action-contract.ts'
import type { UwOperations } from './uw-contract.ts'
import { readEpicLiveSpec } from './uw-spec'

export type PreparedEpicReview = {
  context: ReviewContext & { readonly number: number }
  prepared: PreparedReviewBatch
  publisher: ReviewPublisher
}

function specMatches(accepted: AcceptedEpicSemantic['spec'], live: LiveEpicSpec): boolean {
  return accepted.reference === live.reference && accepted.body === live.body && accepted.digest === live.digest
}

function sameMandate(
  semantic: Awaited<ReturnType<typeof assembleEpicRangeInputs>>['observedEvidence']['semanticContext'],
  mandateRef: ScopedRecordRef,
): boolean {
  return (
    semantic !== undefined &&
    semantic.binding !== null &&
    semantic.binding.recordId === mandateRef.recordId &&
    semantic.binding.scope.repository === mandateRef.scope.repository &&
    semantic.binding.scope.target === mandateRef.scope.target
  )
}

function capturedSemanticMatches(
  semantic: Awaited<ReturnType<typeof assembleEpicRangeInputs>>['observedEvidence']['semanticContext'],
  mandateRef: ScopedRecordRef,
): semantic is Extract<
  NonNullable<Awaited<ReturnType<typeof assembleEpicRangeInputs>>['observedEvidence']['semanticContext']>,
  { mode: 'bound' }
> {
  return (
    semantic !== undefined &&
    semantic.mode === 'bound' &&
    sameMandate(semantic, mandateRef) &&
    semantic.acceptedSpec.reference === semantic.currentSpec.reference &&
    semantic.acceptedSpec.body === semantic.currentSpec.body &&
    semantic.acceptedSpec.digest === semantic.currentSpec.digest
  )
}

function acceptedSemanticMatches(
  accepted: AcceptedEpicSemantic | null,
  live: LiveEpicSpec,
  mandateRef: ScopedRecordRef,
  captured: AcceptedEpicSemantic['semanticContext'],
): boolean {
  return (
    accepted !== null &&
    accepted.semanticContext.mode === 'bound' &&
    sameMandate(accepted.semanticContext, mandateRef) &&
    specMatches(accepted.spec, live) &&
    accepted.semanticCanon === epicSemanticCanon(captured)
  )
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
  operations: UwOperations
  pluginPin?: import('./uw-action-contract.ts').TrustedHostPluginPin
}): Promise<PreparedEpicReview> {
  const assembled = await assembleEpicRangeInputs(input)
  const context = assembled.context
  const epic = context.number
  const capturedSemantic = assembled.observedEvidence.semanticContext
  if (capturedSemantic === undefined || !capturedSemanticMatches(capturedSemantic, input.mandateRef)) {
    throw new Error('epic-bound-semantic-mismatch')
  }

  const originalLive = await readEpicLiveSpec(input.cwd, input.request.repository, input.request.target, epic, input.gh)
  const originalAccepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, originalLive, input.gh)
  if (!acceptedSemanticMatches(originalAccepted, originalLive, input.mandateRef, capturedSemantic)) {
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

      const live = await readEpicLiveSpec(input.cwd, input.request.repository, input.request.target, epic, input.gh)
      const accepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, live, input.gh)
      if (
        accepted === null ||
        capturedSemantic.mode !== 'bound' ||
        accepted.semanticContext.mode !== 'bound' ||
        !sameMandate(accepted.semanticContext, input.mandateRef) ||
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

  const pinned = codePin(
    input.request.repository,
    assembled.pr.baseGitSHA,
    assembled.context.candidateGitSHA,
    assembled.context.candidateGitSHA,
  )
  if (!pinned.ok) throw new Error('code-unobserved')
  const panel = allocateReviewPanel({
    chunks: assembled.chunks,
    roster: assembled.roster,
    config: assembled.config,
    commonContext: 'Review the assigned chunk named by the index. Return structured findings only.',
  })
  const projection = { contextWindow: assembled.contextWindow, chunks: assembled.chunks }
  const specPrepared = await prepareDeliveryAction(
    input.operations,
    actionRequest({
      actionId: `${assembled.context.operationId}:spec`,
      purpose: 'review',
      subject: uwSubject({ repository: input.request.repository, target: input.request.target }, null),
      code: pinned.code,
    }),
    { ...projection, taskName: 'spec', assignedChunk: null },
  )
  if (!specPrepared.ok) throw new Error(prepareRefusal(specPrepared.diagnostics))
  const specAction = specPrepared.value
  const actions: Record<string, PreparedUwAction> = { spec: specAction }
  for (const task of panel.tasks) {
    const match = /^panel-(\d+)-(.+)$/.exec(task.name)
    const assignedChunk = match === null ? null : Number(match[1])
    if (assignedChunk === null || !assembled.chunks.some((chunk) => chunk.index === assignedChunk)) {
      throw new Error(`panel task names an absent chunk: ${task.name}`)
    }
    const prepared = await prepareDeliveryAction(
      input.operations,
      actionRequest({
        actionId: `${assembled.context.operationId}:${task.name}`,
        purpose: 'review',
        subject: uwSubject({ repository: input.request.repository, target: input.request.target }, null),
        code: pinned.code,
      }),
      { ...projection, taskName: task.name, assignedChunk },
    )
    if (!prepared.ok) throw new Error(prepareRefusal(prepared.diagnostics))
    if (prepared.value.inputs.fingerprint !== specAction.inputs.fingerprint) throw new Error('review-input-changed')
    actions[task.name] = prepared.value
  }
  const runner = new CanonicalReviewRunner(
    {
      context: { ...assembled.context, input: specAction.inputs.fingerprint },
      pr: assembled.pr,
      chunks: assembled.chunks,
      contextWindow: assembled.contextWindow,
      roster: assembled.roster,
      config: assembled.config,
      policy: assembled.policy,
      semantic: assembled.semantic,
      observedEvidence: assembled.observedEvidence,
      inputSnapshot: specAction.inputs,
      canonicalClasses: assembled.canonicalClasses,
      actions,
      operations: input.operations,
      authorize: () => validate(),
    },
    withRoxabiGitHubPolicy({ cwd: input.cwd, gh: input.gh }),
  )
  const prepared = runner.initialBatch()
  let bound = false
  const publisher: ReviewPublisher = {
    authorize: (reviewContext, stage) => runner.authorize(reviewContext, stage),
    publishInventory: (batch, canContinue) => runner.publishInventory(batch, canContinue),
    publishRawContribution: (batch, child) => runner.publishRawContribution(batch, child),
    async completeStage(batch, result, contributions, canContinue) {
      if (canContinue === undefined) throw new Error('review-continuation-unfenced')
      if (!canContinue()) return null
      const next = await runner.completeStage(batch, result, contributions, canContinue)
      if (!canContinue()) return null
      if (next !== null) return next
      const decisionId = runner.confirmedDecisionId()
      if (decisionId === null) throw new Error('epic-review-decision-unconfirmed')
      if (!bound) {
        if (!canContinue()) return null
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

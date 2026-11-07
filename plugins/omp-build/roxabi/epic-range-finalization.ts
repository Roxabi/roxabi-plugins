import { canonicalValueDigest, type ScopedRecordRef } from '../dist/contracts.js'
import type { RecordInputRef } from '../engine/action-input-schema.ts'
import { type EpicRangeReviewRequest, epicBindReview, epicFinalReviewRequest } from '../skills/feature/epic-driver'
import { actionRequest, codePin, prepareDeliveryAction, prepareRefusal, uwSubject } from './delivery-action.ts'
import { assembleEpicRangeInputs } from './epic-range-inputs'
import {
  type AcceptedEpicSemantic,
  acceptedEpicSemantic,
  canonicalSpecMatches,
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
    canonicalSpecMatches(mandateRef.scope, semantic.acceptedSpec, semantic.currentSpec)
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
    canonicalSpecMatches(mandateRef.scope, accepted.spec, live) &&
    accepted.semanticCanon === epicSemanticCanon(captured)
  )
}
function matchesIntegration(action: PreparedUwAction, integration: RecordInputRef): boolean {
  const pins = action.inputs.manifest.deliveryData.filter((item) => item.role === 'integration')
  const first = pins[0]
  if (pins.length !== 1 || first === undefined) return false
  const { role: _role, ...pin } = first
  return canonicalValueDigest(pin) === canonicalValueDigest(integration)
}

function requestMatches(current: EpicRangeReviewRequest, requested: EpicRangeReviewRequest): boolean {
  return (
    current.repository === requested.repository &&
    current.target === requested.target &&
    current.runId === requested.runId &&
    current.range === requested.range &&
    current.candidateGitSHA === requested.candidateGitSHA &&
    canonicalValueDigest(current.integration) === canonicalValueDigest(requested.integration)
  )
}

function requirePanelChunk(assignedChunk: number | null, chunks: readonly { index: number }[], name: string): void {
  if (assignedChunk !== null && !chunks.some((chunk) => chunk.index === assignedChunk)) {
    throw new Error(`panel task names an absent chunk: ${name}`)
  }
}

function commitsMatch(
  code: PreparedUwAction['inputs']['manifest']['code'],
  baseRead: { code: number; stdout: string },
  headRead: { code: number; stdout: string },
): boolean {
  return (
    baseRead.code === 0 &&
    headRead.code === 0 &&
    baseRead.stdout.trim() === code.base &&
    headRead.stdout.trim() === code.head &&
    code.referenceCommit === code.head
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
  const initialRequest = await epicFinalReviewRequest(input.cwd, epic)
  if (canonicalValueDigest(initialRequest) !== canonicalValueDigest(input.request))
    throw new Error('epic-range-context-mismatch')
  const capturedSemantic = assembled.observedEvidence.semanticContext
  if (capturedSemantic === undefined || !capturedSemanticMatches(capturedSemantic, input.mandateRef)) {
    throw new Error('epic-bound-semantic-mismatch')
  }

  const originalLive = await readEpicLiveSpec(input.cwd, input.request.repository, input.request.target, epic, input.gh)
  const originalAccepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, originalLive, input.gh)
  if (!acceptedSemanticMatches(originalAccepted, originalLive, input.mandateRef, capturedSemantic)) {
    throw new Error('epic-bound-semantic-mismatch')
  }

  const validatePinnedIntegration = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    const code = specAction.inputs.manifest.code
    const [baseRead, headRead] = await Promise.all([
      input.git(input.cwd, ['rev-parse', '--verify', `${code.base}^{commit}`]),
      input.git(input.cwd, ['rev-parse', '--verify', `${code.head}^{commit}`]),
    ])
    if (!commitsMatch(code, baseRead, headRead)) return { ok: false, reason: 'epic-range-commits-unreadable' }
    const refreshed = await prepareDeliveryAction(
      input.operations,
      actionRequest({
        actionId: `${assembled.context.operationId}:spec`,
        purpose: 'review',
        subject: uwSubject({ repository: input.request.repository, target: input.request.target }, null),
        code: specAction.inputs.manifest.code,
      }),
      { ...projection, taskName: 'spec', assignedChunk: null },
    )
    if (
      !refreshed.ok ||
      refreshed.value.inputs.fingerprint !== specAction.inputs.fingerprint ||
      !matchesIntegration(refreshed.value, input.request.integration)
    )
      return { ok: false, reason: 'epic-integration-context-mismatch' }
    return { ok: true }
  }

  const validate = async (): Promise<{ ok: true } | { ok: false; reason: string }> => {
    try {
      const current = await epicFinalReviewRequest(input.cwd, epic)
      if (!requestMatches(current, input.request)) {
        return { ok: false, reason: 'epic-range-context-mismatch' }
      }

      const live = await readEpicLiveSpec(input.cwd, input.request.repository, input.request.target, epic, input.gh)
      const accepted = await acceptedEpicSemantic(input.cwd, input.request.repository, epic, live, input.gh)
      if (!acceptedSemanticMatches(accepted, live, input.mandateRef, capturedSemantic)) {
        return { ok: false, reason: 'epic-bound-semantic-unreadable' }
      }

      if (!specMatches(capturedSemantic.currentSpec, live)) {
        return { ok: false, reason: 'epic-live-spec-mismatch' }
      }
      return await validatePinnedIntegration()
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
  if (!matchesIntegration(specAction, input.request.integration)) throw new Error('epic-integration-context-mismatch')
  const initialAuthorization = await validate()
  if (!initialAuthorization.ok) throw new Error(initialAuthorization.reason)
  const panel = allocateReviewPanel({
    subject: assembled.context.subject,
    chunks: assembled.chunks,
    roster: assembled.roster,
    config: assembled.config,
    commonContext: 'Review the assigned chunk named by the index. Return structured findings only.',
  })
  const actions: Record<string, PreparedUwAction> = { spec: specAction }
  for (const task of panel.tasks) {
    const assignedChunk = task.assignedChunk
    requirePanelChunk(assignedChunk, assembled.chunks, task.name)
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
        await epicBindReview(input.cwd, epic, decisionId, input.request.range, canContinue)
      }
      return null
    },
    publishRequiredStop: () => runner.publishRequiredStop(),
    stop: (reviewContext, reason) => runner.stop(reviewContext, reason),
  }
  return { context, prepared, publisher }
}

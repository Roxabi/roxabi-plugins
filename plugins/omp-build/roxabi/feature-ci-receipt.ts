import { canonicalValueDigest } from '../dist/contracts.js'
import type { Diagnostic } from '../engine/record-values.ts'
import type { Result } from '../engine/result.ts'
import {
  actionRequest,
  blocks,
  codePin,
  observeSha,
  prepareDeliveryAction,
  prepareRefusal,
  uwSubject,
} from './delivery-action.ts'
import { type ModelReceiptActionInput, type ReceiptStartContext, sealReceipt } from './feature-action-receipt.ts'
import { approvedMandateContext } from './feature-approved-context.ts'
import { readNativeCiFailureEvidence } from './feature-ci-evidence.ts'
import type { ContinueFeatureResult } from './feature-contract.ts'
import type { History } from './feature-engine.ts'
import type { PreparedUwAction } from './uw-action-contract.ts'
import { matchesRequestedSubject } from './uw-action-subject.ts'

function ciPublicationParents(input: ModelReceiptActionInput, mandateHistory: History): readonly History[] {
  const mandateIsPrimary =
    input.history.source.scope.repository === mandateHistory.source.scope.repository &&
    input.history.source.scope.target === mandateHistory.source.scope.target
  const mandateIsParent = input.evidence.parents.some(
    (history) =>
      history.source.scope.repository === mandateHistory.source.scope.repository &&
      history.source.scope.target === mandateHistory.source.scope.target,
  )
  // Attribution publishes on the PR while retaining the issue mandate as an
  // external history for canonical reference validation; it never copies it.
  return mandateIsPrimary || mandateIsParent ? input.evidence.parents : [mandateHistory, ...input.evidence.parents]
}

export async function startCiAttributionReceipt(
  input: ModelReceiptActionInput,
  context: ReceiptStartContext,
): Promise<ContinueFeatureResult> {
  if (input.target.status !== 'pull-request') return { kind: 'blocked', reason: 'ci-attribution-requires-pull-request' }
  const evidence = await readNativeCiFailureEvidence(
    input.cwd,
    input.scope.repository,
    input.target.pullRequest.head,
    input.scope,
    { gh: input.gh, failedCheckEvidenceDigest: input.loaded.failedCheckEvidenceDigest },
  )
  if (!evidence.ok) return { kind: 'blocked', reason: evidence.reason }
  const exactInputs = {
    candidateGitSHA: input.target.pullRequest.head,
    scope: input.scope,
    failedChecks: evidence.failedChecks,
    evidenceDigest: evidence.evidenceDigest,
    failures: evidence.failures,
  }
  const approved = approvedMandateContext(
    input.loaded,
    input.mandate,
    input.evidence.causal?.histories ?? [context.mandateHistory, ...input.evidence.parents],
  )
  // Absent Spec context may stay soft for legitimate no-pre-PR / standalone attribution.
  // Present-invalid / ambiguous Spec chain must refuse — never collapse to prose absence.
  if (approved.status === 'invalid') {
    return { kind: 'blocked', reason: `mandate-spec-${approved.reason}`, diagnostics: approved.diagnostics }
  }
  const base = await observeSha(input.git, input.cwd, input.target.pullRequest.base)
  const pinned = codePin(
    input.scope.repository,
    base ?? '',
    input.target.pullRequest.head,
    input.target.pullRequest.head,
  )
  if (!pinned.ok) return blocks(pinned.reason)
  if (input.uw === undefined) return blocks('prepare-action-unavailable')
  const currentSubject = uwSubject(context.mandateScope, input.scope)
  const capturedSubject = input.recovery?.prepared.inputs.manifest.subject
  if (capturedSubject !== undefined && !matchesRequestedSubject(capturedSubject, currentSubject))
    return blocks('context-recovery-input-changed')
  const requestedSubject = input.recovery?.request.subject
  const subject =
    requestedSubject?.kind === 'uw' && requestedSubject.binding !== null
      ? (capturedSubject ?? currentSubject)
      : currentSubject
  const request = actionRequest({
    actionId: context.operationId,
    purpose: 'attribute-ci',
    subject,
    code: pinned.code,
    stageSources: input.recovery?.request.stageSources,
    expandedContext: input.recovery?.request.expandedContext,
    operands: { action: 'attribute-ci', exactInputs },
  })
  const prepared = await prepareCiAction(input.uw, request, input.recovery)
  if ('kind' in prepared) return prepared
  if (!prepared.ok) return blocks(prepareRefusal(prepared.diagnostics), prepared.diagnostics)
  return sealReceipt({
    loaded: input.loaded,
    history: input.history,
    scope: input.scope,
    cwd: input.cwd,
    gh: input.gh,
    parents: ciPublicationParents(input, context.mandateHistory),
    operationId: context.operationId,
    action: 'attribute-ci',
    mandate: { scope: context.mandateScope, recordId: input.mandate.recordId, kind: 'mandate' },
    exactInputs,
    native: { branch: input.target.pullRequest.branch, base: input.target.pullRequest.base },
    prepared: prepared.value,
  })
}

async function prepareCiAction(
  uw: NonNullable<ModelReceiptActionInput['uw']>,
  request: ReturnType<typeof actionRequest>,
  recovery: ModelReceiptActionInput['recovery'],
): Promise<Result<PreparedUwAction, Diagnostic> | ContinueFeatureResult> {
  if (recovery === undefined) return prepareDeliveryAction(uw, request)
  if (canonicalValueDigest(request) !== canonicalValueDigest(recovery.request)) {
    const previous = recovery.request
    const coordinates = (
      ['actionId', 'purpose', 'subject', 'code', 'stageSources', 'expandedContext', 'operands'] as const
    ).filter((key) => canonicalValueDigest(request[key] ?? null) !== canonicalValueDigest(previous[key] ?? null))
    return blocks('context-recovery-input-changed', [
      {
        code: 'context-recovery-input-changed',
        message: `Reconstructed CI request differs: ${coordinates.join(', ')}`,
      },
    ])
  }
  const verified = await uw.verifyAction(recovery.prepared.snapshot)
  if (!verified.ok)
    return blocks('context-recovery-input-changed', [
      {
        code: 'context-recovery-input-changed',
        message: 'Prepared CI action snapshot verification failed',
      },
    ])
  return { ok: true, value: recovery.prepared }
}

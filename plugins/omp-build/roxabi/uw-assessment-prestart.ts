import { actionInputDigest } from '../engine/action-input.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import { externalRecordRefSchema } from '../engine/record-references.ts'
import type { Result } from '../engine/result.ts'
import type { ContextSuccessionInspection } from '../engine/workflow-context-succession-inspection.ts'
import type { AcceptedSpecInspection, AssessmentReplayContext } from '../engine/workflow-spec-authentication.ts'
import type { ActionReplayIntent, UwActionRequest } from './uw-action-contract.ts'
import { actionFailure } from './uw-action-result.ts'
import { nonPlanExpansion } from './uw-context-negative-workflow.ts'

export function assessmentSuccessionInspection(
  proof: ContextSuccessionInspection | undefined,
): AcceptedSpecInspection | undefined {
  return proof === undefined ? undefined : { kind: 'selected-succession', succession: proof }
}

/** Reconstruct the proposal inputs only after resolving their authenticated negative origin. */
export function assessmentRecoveryReplay(
  request: UwActionRequest,
  histories: readonly DecodedHistory[],
  intent: ActionReplayIntent,
  reviewedFingerprint?: string,
  disposedStarts?: ReadonlySet<string>,
): Result<AssessmentReplayContext | undefined> {
  if (request.purpose !== 'assess-spec' || request.subject.kind !== 'uw') return { ok: true, value: undefined }
  const uw = request.subject.uw
  if (intent.kind === 'persisted') {
    if (reviewedFingerprint === undefined)
      return actionFailure('action-input-missing', 'Persisted assessment replay requires the reviewed fingerprint')
    if (!externalRecordRefSchema.safeParse(intent.start).success || intent.start.kind !== 'action-receipt')
      return actionFailure('action-input-missing', 'Persisted assessment replay requires an exact START reference')
    return {
      ok: true,
      value: { uw, actionId: request.actionId, fingerprint: reviewedFingerprint, start: intent.start },
    }
  }
  const expansion = nonPlanExpansion(request, histories, disposedStarts)
  if (!expansion.ok) return expansion
  if (expansion.value === null) return { ok: true, value: undefined }
  const { previous, negative } = expansion.value
  const manifest = { ...previous.manifest, expandedContext: [...request.expandedContext] }
  const inputs = { ...previous, manifest, fingerprint: actionInputDigest(manifest) }
  if (reviewedFingerprint !== undefined && reviewedFingerprint !== inputs.fingerprint)
    return actionFailure('action-input-missing', 'Assessment recovery inputs differ from the reviewed fingerprint')
  return {
    ok: true,
    value: {
      uw: request.subject.uw,
      actionId: request.actionId,
      fingerprint: inputs.fingerprint,
      prestart: {
        negative: {
          scope: { repository: negative.repository, target: negative.target },
          kind: 'action-receipt',
          recordId: negative.recordId,
        },
        inputs,
      },
    },
  }
}

import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { citedOperationIntegrity } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'

export type CorrectionCriterionContext = { head: string; planActionId: string; mandateId: string; specVersion: string }
type Fix = Extract<CanonicalRecord, { kind: 'fix-result' }>

export function currentCorrectionContext(
  manifest: ActionInputs['manifest'],
  fix: Fix,
  context: CorrectionCriterionContext,
): boolean {
  if (manifest.purpose !== 'correction' || manifest.spec.kind !== 'accepted') return false
  if (
    manifest.spec.effective.own.version !== context.specVersion ||
    manifest.spec.effective.own.sourceAccepted.recordId !== context.mandateId
  )
    return false
  if (manifest.subject.kind !== 'uw' || manifest.subject.pullRequest === null) return false
  return (
    manifest.subject.pullRequest.repository === fix.repository &&
    manifest.subject.pullRequest.target === fix.target &&
    manifest.code.repository === fix.repository
  )
}

export function correctionCurrentPlan(
  manifest: ActionInputs['manifest'],
  histories: readonly DecodedHistory[],
  planActionId: string,
): boolean {
  return manifest.deliveryData.some((ref) => {
    if (ref.role !== 'plan' || ref.selector !== '/payload/structured') return false
    const history = historyFor(ref.record.scope, histories)
    if (history === null || citedOperationIntegrity(history, ref.record.recordId) !== null) return false
    const result = bindExternalRef(ref.record, history)
    if (!result.ok || result.value.kind !== 'action-receipt') return false
    const payload = result.value.payload
    return (
      payload.action === 'plan' &&
      payload.phase === 'result' &&
      payload.actionId === planActionId &&
      ref.digest === canonicalValueDigest(payload.structured)
    )
  })
}

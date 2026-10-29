import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { citedOperationIntegrity } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { resolveManifestMandate } from './workflow-pr-binding.ts'

export type CorrectionCriterionContext = {
  head: string
  planActionId: string
  mandate: ExternalRecordRef
  ownSpec: OwnSpecRef
}
type Fix = Extract<CanonicalRecord, { kind: 'fix-result' }>

export function currentCorrectionContext(
  inputs: ActionInputs,
  fix: Fix,
  histories: readonly DecodedHistory[],
  context: CorrectionCriterionContext,
): boolean {
  const manifest = inputs.manifest
  if (manifest.purpose !== 'correction' || manifest.spec.kind !== 'accepted') return false
  if (!sameOwnSpecRef(manifest.spec.effective.own, context.ownSpec)) return false
  const owner = resolveManifestMandate(inputs, histories)
  if (
    !owner.ok ||
    !sameRef(
      {
        scope: { repository: owner.value.repository, target: owner.value.target },
        kind: 'mandate',
        recordId: owner.value.recordId,
      },
      context.mandate,
    )
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
  context: CorrectionCriterionContext,
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
      payload.actionId === context.planActionId &&
      sameRef(payload.mandate, context.mandate) &&
      'specDigest' in payload.exactInputs &&
      payload.exactInputs.specDigest === context.ownSpec.version &&
      ref.digest === canonicalValueDigest(payload.structured)
    )
  })
}

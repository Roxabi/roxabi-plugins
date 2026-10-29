import { canonicalValueDigest } from './action-input.ts'
import {
  type CorrectionCriterionContext,
  correctionCurrentPlan,
  currentCorrectionContext,
} from './correction-criterion-context.ts'
import { resolveHistoricalCorrectionBasis } from './correction-historical-basis.ts'
import { correctionRecord } from './correction-lineage-admission.ts'
import { genuineCorrectionSource } from './correction-native-source.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'

type Fix = Extract<CanonicalRecord, { kind: 'fix-result' }>

function correctionIdentity(fix: Fix, histories: readonly DecodedHistory[], context: CorrectionCriterionContext) {
  const receipt = fix.payload.criterionReceipt
  if (
    !receipt ||
    fix.payload.candidateGitSHA !== context.head ||
    !fix.inputs.includes(receipt.sourceContributionId) ||
    correctionRecord(fix, histories, fix.recordId, 'fix-result') === null
  )
    return null
  const request = correctionRecord(fix, histories, fix.payload.requestId, 'fix-request')
  const decision = correctionRecord(fix, histories, fix.payload.decisionId, 'decision')
  const contribution = correctionRecord(fix, histories, receipt.sourceContributionId, 'contribution')
  if (
    !request ||
    !decision ||
    !contribution ||
    !fix.inputs.includes(request.recordId) ||
    !fix.inputs.includes(decision.recordId)
  )
    return null
  const review =
    request.payload.existingReviewId === null
      ? null
      : correctionRecord(fix, histories, request.payload.existingReviewId, 'review')
  if (request.payload.existingReviewId === null) {
    if (decision.payload.judgment.purpose !== 'correction') return null
  } else if (review?.payload.decisionId !== decision.recordId || decision.payload.judgment.purpose !== 'review')
    return null
  const historical = resolveHistoricalCorrectionBasis({ contribution, histories })
  if (
    !historical.ok ||
    historical.value.requestRef.record.recordId !== request.recordId ||
    historical.value.decisionRef.record.recordId !== decision.recordId
  )
    return null
  return { receipt, request, decision, contribution, review, historical: historical.value }
}

export function admitCorrectionSourceBinding(
  fix: Fix,
  histories: readonly DecodedHistory[],
  context: CorrectionCriterionContext,
) {
  const identity = correctionIdentity(fix, histories, context)
  if (identity === null) return null
  const { receipt, request, decision, contribution, review, historical } = identity
  const source = contribution.payload
  const native = source.native
  const observation = native?.observation
  const action = source.host.action
  if (!native || !observation || !action || !genuineCorrectionSource(contribution)) return null
  const manifest = action.inputs.manifest
  if (
    !currentCorrectionContext(action.inputs, fix, histories, context) ||
    !correctionCurrentPlan(manifest, histories, context)
  )
    return null
  const inventory =
    source.inventoryId === null ? null : correctionRecord(fix, histories, source.inventoryId, 'review-attempt')
  if (
    inventory?.payload.stage !== 'initial' ||
    inventory.payload.purpose !== 'correction' ||
    inventory.payload.requestId !== request.recordId ||
    inventory.payload.actionInputDigest !== action.inputs.fingerprint ||
    !inventory.inputs.includes(decision.recordId) ||
    !contribution.inputs.includes(inventory.recordId)
  )
    return null
  const slots = inventory.payload.slots.filter(
    (slot) => slot.slotId === source.host.slotId && slot.phase === source.host.phase && slot.role === source.host.role,
  )
  const slot = slots.find(
    (item) =>
      item.output === 'action-result' &&
      item.action?.actionId === action.actionId &&
      canonicalValueDigest(item.action.inputs) === canonicalValueDigest(action.inputs),
  )
  if (
    slots.length !== 1 ||
    !slot?.correction ||
    !decision.payload.judgment.causes.some((cause) => cause.id === slot.correction?.causeId)
  )
    return null
  return {
    receipt,
    request,
    decision,
    contribution,
    review,
    historical,
    source,
    native,
    observation,
    inventory,
    correction: slot.correction,
  }
}

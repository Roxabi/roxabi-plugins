import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import { type CorrectionCriterionContext, currentCorrectionContext } from './correction-criterion-context.ts'
import { type HistoricalCorrectionBasis, resolveHistoricalCorrectionBasis } from './correction-historical-basis.ts'
import { correctionRecord, finalApplyAttempt } from './correction-lineage-admission.ts'
import { genuineCorrectionSource } from './correction-native-source.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { applyActionResultSchema } from './record-values.ts'

type Fix = Extract<CanonicalRecord, { kind: 'fix-result' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>
type Decision = Extract<CanonicalRecord, { kind: 'decision' }>
type Correction = Extract<CanonicalRecord, { kind: 'correction-result' }>
type Lineage = { correction: Correction; raw: Record<string, unknown>; appliedId: string }
type Input = {
  fix: Fix
  histories: readonly DecodedHistory[]
  context: CorrectionCriterionContext
  historical: HistoricalCorrectionBasis
  decision: Decision
  contribution: Contribution
  inventory: Inventory
  phase: string
  lineage: Lineage
}

function samePlan(left: HistoricalCorrectionBasis, right: HistoricalCorrectionBasis): boolean {
  return left.inputs.manifest.deliveryData.some(
    (ref) =>
      ref.role === 'plan' &&
      right.inputs.manifest.deliveryData.some(
        (other) => other.role === 'plan' && canonicalValueDigest(ref) === canonicalValueDigest(other),
      ),
  )
}

function validApplied(
  input: Input,
  applied: Contribution,
  inventory: Inventory,
  basis: HistoricalCorrectionBasis,
): boolean {
  const action = applied.payload.host.action
  const payload = input.lineage.correction.payload
  if (
    !action ||
    !validateActionInputs(action.inputs).ok ||
    inventory.payload.stage !== 'initial' ||
    inventory.payload.purpose !== 'correction'
  )
    return false
  if (
    inventory.payload.requestId !== input.historical.requestRef.record.recordId ||
    !inventory.inputs.includes(input.decision.recordId) ||
    !applied.inputs.includes(inventory.recordId) ||
    inventory.payload.actionInputDigest !== action.inputs.fingerprint
  )
    return false
  if (
    !currentCorrectionContext(action.inputs.manifest, input.fix, input.context) ||
    inventory.payload.candidateGitSHA !== action.inputs.manifest.code.head ||
    !samePlan(basis, input.historical)
  )
    return false
  if (
    !action.inputs.stageSources.some(
      (ref) =>
        ref.record.kind === 'decision' &&
        ref.record.recordId === input.decision.recordId &&
        ref.record.scope.repository === input.decision.repository &&
        ref.record.scope.target === input.decision.target &&
        ref.selector === '/payload' &&
        ref.digest === canonicalValueDigest(input.decision.payload),
    )
  )
    return false
  const slots = inventory.payload.slots.filter(
    (slot) =>
      slot.slotId === applied.payload.host.slotId &&
      slot.output === 'action-result' &&
      slot.phase === 'fix' &&
      slot.role === applied.payload.host.role &&
      slot.correction?.phase === 'apply' &&
      slot.correction.causeId === payload.causeId &&
      slot.action?.actionId === action.actionId &&
      canonicalValueDigest(slot.action.inputs) === canonicalValueDigest(action.inputs),
  )
  const output = applyActionResultSchema.safeParse(applied.payload.structured)
  return (
    slots.length === 1 &&
    genuineCorrectionSource(applied) &&
    output.success &&
    output.data.outcome === 'applied' &&
    output.data.commitSHAs.length === 1 &&
    output.data.commitSHAs[0] === payload.commitSHAs[0] &&
    finalApplyAttempt(input.lineage.raw, payload.attempt, applied.recordId)
  )
}

function validObservation(input: Input, applied: Contribution): boolean {
  const correction = input.lineage.correction
  const payload = correction.payload
  if (input.phase === 'apply')
    return applied.recordId === input.contribution.recordId && payload.commitSHAs[0] === input.context.head
  if (input.phase !== 'revalidate' && input.phase !== 'restore-proof') return false
  const action = input.contribution.payload.host.action
  if (
    !action ||
    !correction.inputs.includes(input.contribution.recordId) ||
    !payload.criterionObservations?.some(
      (item) => item.sourceContributionId === input.contribution.recordId && item.head === input.context.head,
    )
  )
    return false
  if (
    action.inputs.manifest.code.head !== input.context.head ||
    input.inventory.payload.candidateGitSHA !== input.context.head ||
    !input.inventory.inputs.includes(applied.recordId)
  )
    return false
  if (
    !action.inputs.stageSources.some(
      (ref) =>
        ref.record.kind === 'contribution' &&
        ref.record.recordId === applied.recordId &&
        ref.record.scope.repository === applied.repository &&
        ref.record.scope.target === applied.target &&
        ref.selector === '/payload' &&
        ref.digest === canonicalValueDigest(applied.payload),
    )
  )
    return false
  const output = applyActionResultSchema.safeParse(input.contribution.payload.structured)
  return (
    output.success &&
    output.data.outcome === 'applied' &&
    output.data.commitSHAs.length === 0 &&
    output.data.guardInventory.length === 0 &&
    output.data.proofPaths.length === 0
  )
}

export function admitAppliedCorrection(
  input: Input,
): { applied: Contribution; inventory: Inventory; basis: HistoricalCorrectionBasis } | null {
  const applied = correctionRecord(input.fix, input.histories, input.lineage.appliedId, 'contribution')
  if (!applied || applied.payload.inventoryId === null) return null
  const basis = resolveHistoricalCorrectionBasis({
    contribution: applied,
    histories: input.histories,
    expectedSubject: input.historical.inputs.manifest.subject,
  })
  if (
    !basis.ok ||
    basis.value.requestRef.record.recordId !== input.historical.requestRef.record.recordId ||
    basis.value.decisionRef.record.recordId !== input.decision.recordId ||
    basis.value.originalCandidate !== input.historical.originalCandidate
  )
    return null
  const inventory = correctionRecord(input.fix, input.histories, applied.payload.inventoryId, 'review-attempt')
  if (!inventory || !validApplied(input, applied, inventory, basis.value) || !validObservation(input, applied))
    return null
  return { applied, inventory, basis: basis.value }
}

import { canonicalValueDigest } from './action-input.ts'
import { admitAppliedCorrection } from './correction-applied-admission.ts'
import type { CorrectionCriterionContext } from './correction-criterion-context.ts'
import { admitCorrectionLineage, correctionObject as object } from './correction-lineage-admission.ts'
import { admitCorrectionSourceBinding } from './correction-source-binding.ts'
import { completeCriterionDeclarations } from './criterion-declaration-completion.ts'
import type { CriterionDeclaration } from './criterion-evidence-schema.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'

type Fix = Extract<CanonicalRecord, { kind: 'fix-result' }>
type Contribution = Extract<CanonicalRecord, { kind: 'contribution' }>
type Context = CorrectionCriterionContext

/** Resolve only a host-authenticated correction observation surviving at the requested head. */
export function resolveAdmittedCorrectionCriterionSource(
  fix: Fix,
  histories: readonly DecodedHistory[],
  context: Context,
): { criteria: CriterionDeclaration[]; contribution: Contribution; lineage: CanonicalRecord[] } | null {
  const binding = admitCorrectionSourceBinding(fix, histories, context)
  if (binding === null) return null
  const {
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
    correction,
  } = binding
  const lineage = admitCorrectionLineage(fix, histories, decision.recordId, correction.causeId)
  if (lineage === null) return null
  const { corrections, falsifications } = lineage
  const appliedAdmission = admitAppliedCorrection({
    fix,
    histories,
    context,
    historical,
    decision,
    contribution,
    inventory,
    phase: correction.phase,
    lineage,
  })
  if (appliedAdmission === null) return null
  const { applied, inventory: appliedInventory, basis: appliedBasis } = appliedAdmission
  const data = object(source.structured)
  if (!data || !Array.isArray(data.criteria)) return null
  const completed = completeCriterionDeclarations(data.criteria, {
    commandRuns: native.commandRuns,
    nativeProvenance: native.commandProvenance,
    observationProvenance: {
      kind: 'native',
      actionId: observation.actionId,
      childId: observation.childId,
      submissionIndex: observation.submissionIndex,
      toolCallIds: [],
    },
  })
  if (canonicalValueDigest(completed) !== canonicalValueDigest(receipt.criteria)) return null
  return {
    criteria: receipt.criteria,
    contribution,
    lineage: [
      ...new Map<string, CanonicalRecord>(
        [
          fix,
          request,
          decision,
          ...(review === null ? [] : [review]),
          inventory,
          contribution,
          applied,
          appliedInventory,
          ...historical.lineage,
          ...appliedBasis.lineage,
          ...corrections,
          ...falsifications,
        ].map((item) => [`${item.repository}\0${item.target}\0${item.recordId}`, item] as const),
      ).values(),
    ],
  }
}

import type { CanonicalRecord } from '../../../../contracts.ts'
import type { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { submission } from '../../../../testing/record-builders.ts'

/** Bind blocking cause judgments to the actual selected implementation record. */
export function blockingReviewRecords(
  criterion: ReturnType<typeof criterionEpicReviewGraph> | null,
): CanonicalRecord[] {
  if (criterion === null) throw new Error('Blocking epic review needs implementation evidence')
  const selection = criterion.inputs.manifest.deliveryData.find((ref) => ref.role === 'implementation')
  if (selection === undefined) throw new Error('Blocking epic review is missing implementation evidence')
  const { role: _role, ...citation } = selection
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The selected implementation record establishes this judgment',
    references: [citation],
  })
  const judgment = {
    ...criterion.decision.payload.judgment,
    causes: criterion.decision.payload.judgment.causes.map((cause) => ({
      ...cause,
      judgment: { necessary: supported(true), urgent: supported(true), tooLarge: supported(false) },
      proposedDisposition: 'fix-original' as const,
    })),
  }
  const decision = { ...criterion.decision, payload: { ...criterion.decision.payload, judgment } }
  const synthesis = {
    ...criterion.synthesisContribution,
    payload: {
      ...criterion.synthesisContribution.payload,
      structured: judgment,
      rawAttempts: [
        submission({
          id: `child-${criterion.synthesisContribution.recordId}`,
          structuredOutput: { status: 'valid', data: judgment },
        }),
      ],
    },
  }
  return criterion.records.map((record) => {
    if (record.recordId === decision.recordId) return decision
    if (record.recordId === synthesis.recordId) return synthesis
    return record
  })
}

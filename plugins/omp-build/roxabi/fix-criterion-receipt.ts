import { criterionDeclarationSchema } from '../dist/contracts.js'
import type { NativeCorrectionExecutionOptions } from './correction-execution-contract.ts'
import type { CorrectionOutcome } from './correction-policy-contract.ts'
import { completeCriterionDeclarations } from './feature-implementation-receipt.ts'

export type CorrectionCriterionSource = Parameters<
  NonNullable<NativeCorrectionExecutionOptions['onCriterionSource']>
>[0]

function eligibleSource(
  source: CorrectionCriterionSource,
  outcomes: readonly CorrectionOutcome[],
  head: string,
): string | undefined {
  const sourceId = source.contributionIds[0]
  if (source.head !== head || source.contributionIds.length !== 1 || sourceId === undefined || !source.child.usable)
    return undefined
  const observation = source.child.observationProvenance
  if (observation?.kind !== 'native' || observation.childId !== source.child.id) return undefined
  const outcome = outcomes.find((item) => item.cause.id === source.causeId && item.outcome === 'applied')
  if (outcome === undefined) return undefined
  if (source.phase !== 'apply') return sourceId
  if (outcome.commitSHAs.length !== 1 || outcome.commitSHAs[0] !== head) return undefined
  const attempt = outcome.applyAttempts.findLast((item) => item.round === outcome.attempt && item.result === 'applied')
  return attempt?.sourceContributionIds.includes(sourceId) ? sourceId : undefined
}

function completedCriteria(source: CorrectionCriterionSource) {
  const structured = source.child.structured
  if (
    structured === null ||
    typeof structured !== 'object' ||
    Array.isArray(structured) ||
    !Array.isArray(structured.criteria)
  )
    return undefined
  const parsed = criterionDeclarationSchema
    .array()
    .safeParse(completeCriterionDeclarations(structured.criteria, source.child))
  return parsed.success ? parsed.data : undefined
}

/** Select only host-validated actions that still describe the final correction head. */
export function correctionCriterionReceipt(
  sources: readonly CorrectionCriterionSource[],
  outcomes: readonly CorrectionOutcome[],
  head: string,
) {
  for (const source of [...sources].reverse()) {
    const sourceContributionId = eligibleSource(source, outcomes, head)
    if (sourceContributionId === undefined) continue
    const criteria = completedCriteria(source)
    if (criteria !== undefined) return { sourceContributionId, criteria }
  }
  return undefined
}

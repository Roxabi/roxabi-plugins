import { inventoryRoot, requiredSlotsComplete } from './history-conservation.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { diagnostic, unique } from './result.ts'

type Review = Extract<CanonicalRecord, { kind: 'review' }>
type ReviewAttempt = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function knownReviewInventories(
  review: Review,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): ReviewAttempt[] | null {
  const inventories = review.payload.inventoryIds.map((id) => records.get(id))
  if (!unique(review.payload.inventoryIds) || inventories.some((inventory) => inventory?.kind !== 'review-attempt')) {
    diagnostics.push(diagnostic('unknown-reference', `Review ${review.recordId} has unknown inventory IDs`))
    return null
  }
  return inventories.filter((inventory): inventory is ReviewAttempt => inventory?.kind === 'review-attempt')
}

function inventoriesBindReview(review: Review, inventories: ReviewAttempt[]): boolean {
  const rootIds = new Set(inventories.map((inventory) => inventory.payload.rootAttemptId))
  if (rootIds.size !== 1) return false
  for (const inventory of inventories)
    if (
      inventory.payload.purpose !== 'review' ||
      inventory.payload.candidateGitSHA !== review.payload.candidateGitSHA ||
      inventory.payload.input !== review.payload.input ||
      !review.inputs.includes(inventory.recordId)
    )
      return false
  return true
}

function validateRootInventoryList(
  review: Review,
  rootId: string,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const allForRoot: string[] = []
  for (const candidate of records.values())
    if (candidate.kind === 'review-attempt' && candidate.payload.rootAttemptId === rootId)
      allForRoot.push(candidate.recordId)
  if (
    !unique(allForRoot) ||
    allForRoot.length !== review.payload.inventoryIds.length ||
    !allForRoot.every((id) => review.payload.inventoryIds.includes(id))
  )
    diagnostics.push(diagnostic('incomplete', `Review ${review.recordId} does not list every inventory for its root`))
}

function validateReviewRoot(
  review: Review,
  rootId: string,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const root = records.get(rootId)
  if (
    root?.kind !== 'review-attempt' ||
    root.payload.stage !== 'initial' ||
    root.payload.purpose !== 'review' ||
    root.payload.subject.kind !== 'pull-request'
  )
    diagnostics.push(diagnostic('unbound', `Review ${review.recordId} is not bound to a pull-request subject`))
}

function validateReviewDecisionRoot(
  review: Review,
  decision: CanonicalRecord | undefined,
  rootId: string,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  if (decision?.kind !== 'decision') return
  const synthesisContribution = records.get(decision.payload.originalContributionId)
  const synthesisInventory =
    synthesisContribution?.kind === 'contribution' && synthesisContribution.payload.inventoryId !== null
      ? records.get(synthesisContribution.payload.inventoryId)
      : null
  const decisionRoot = synthesisInventory?.kind === 'review-attempt' ? inventoryRoot(records, synthesisInventory) : null
  if (decisionRoot?.recordId !== rootId)
    diagnostics.push(diagnostic('unbound', `Review ${review.recordId} decision belongs to another inventory root`))
}

function validateReviewInventories(
  review: Review,
  decision: CanonicalRecord | undefined,
  inventories: ReviewAttempt[],
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
  enforceAdmission: boolean,
): void {
  if (!inventoriesBindReview(review, inventories))
    diagnostics.push(diagnostic('unbound', `Review ${review.recordId} inventories do not bind one candidate`))
  const rootId = inventories[0]?.payload.rootAttemptId
  if (rootId !== undefined) {
    validateRootInventoryList(review, rootId, records, diagnostics)
    validateReviewRoot(review, rootId, records, diagnostics)
    validateReviewDecisionRoot(review, decision, rootId, records, diagnostics)
  }
  for (const inventory of inventories) requiredSlotsComplete(records, inventory, diagnostics, enforceAdmission)
}

export function validateReviewLinks(
  review: Review,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
  enforceAdmission: boolean,
): void {
  const decision = records.get(review.payload.decisionId)
  if (decision?.kind !== 'decision' || decision.payload.judgment.purpose !== 'review')
    diagnostics.push(diagnostic('unknown-reference', `Review ${review.recordId} has no review decision`))
  if (!review.inputs.includes(review.payload.decisionId))
    diagnostics.push(diagnostic('unbound', `Review ${review.recordId} does not bind its decision`))
  const inventories = knownReviewInventories(review, records, diagnostics)
  if (inventories !== null)
    validateReviewInventories(review, decision, inventories, records, diagnostics, enforceAdmission)
}

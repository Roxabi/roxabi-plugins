import { inventoryRoot, requiredSlotsComplete, sameJson } from './history-conservation.ts'
import { validateReviewLinks } from './history-graph-review-links.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { decisionSchema } from './review-schema.ts'

type Decision = Extract<CanonicalRecord, { kind: 'decision' }>

type ReviewAttempt = Extract<CanonicalRecord, { kind: 'review-attempt' }>

function validateDecisionCapture(
  decision: Decision,
  source: CanonicalRecord | undefined,
  diagnostics: Diagnostic[],
): void {
  if (source?.kind !== 'contribution' || source.payload.structured === null) return
  const structuredDecision = decisionSchema.safeParse(source.payload.structured)
  if (!structuredDecision.success || !sameJson(structuredDecision.data, decision.payload.judgment))
    diagnostics.push(
      diagnostic('unbound', `Decision ${decision.recordId} differs from its retained structured synthesis`),
    )
  const finalSubmission = source.payload.rawAttempts.reduce<(typeof source.payload.rawAttempts)[number] | null>(
    (latest, attempt) => (latest === null || attempt.attemptIndex > latest.attemptIndex ? attempt : latest),
    null,
  )
  if (
    finalSubmission?.data === null ||
    finalSubmission === null ||
    !sameJson(finalSubmission.data, decision.payload.judgment)
  )
    diagnostics.push(diagnostic('unbound', `Decision ${decision.recordId} is not its final captured model submission`))
}

function validateDecisionSources(
  decision: Decision,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  for (const sourceId of decision.payload.judgment.sourceContributionIds) {
    const contribution = records.get(sourceId)
    if (contribution?.kind !== 'contribution' || contribution.payload.content !== 'findings')
      diagnostics.push(
        diagnostic(
          'missing-contribution',
          `Decision ${decision.recordId} references non-finding contribution ${sourceId}`,
        ),
      )
  }
}

function decisionSynthesis(
  decision: Decision,
  source: CanonicalRecord | undefined,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): ReviewAttempt | null {
  if (source?.kind !== 'contribution' || source.payload.content !== 'decision' || source.payload.inventoryId === null)
    return null
  const synthesis = records.get(source.payload.inventoryId)
  if (
    synthesis?.kind !== 'review-attempt' ||
    synthesis.payload.stage !== 'synthesis' ||
    synthesis.payload.purpose !== decision.payload.judgment.purpose
  ) {
    diagnostics.push(
      diagnostic(
        'unbound',
        `Decision ${decision.recordId} synthesis contribution is not bound to a matching synthesis inventory`,
      ),
    )
    return null
  }
  return synthesis
}

function decisionInventoryRoot(
  decision: Decision,
  synthesis: ReviewAttempt,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): ReviewAttempt | null {
  const root = inventoryRoot(records, synthesis)
  if (
    root === null ||
    root.payload.purpose !== decision.payload.judgment.purpose ||
    JSON.stringify(root.payload.policy) !== JSON.stringify(decision.payload.judgment.policy)
  ) {
    diagnostics.push(
      diagnostic('unbound', `Decision ${decision.recordId} policy or purpose diverges from its root inventory`),
    )
    return null
  }
  return root
}

function validateExpectedDecisionSources(
  decision: Decision,
  root: ReviewAttempt,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  for (const candidate of records.values()) {
    if (
      candidate.kind !== 'contribution' ||
      candidate.payload.content !== 'findings' ||
      candidate.payload.inventoryId === null
    )
      continue
    const inventory = records.get(candidate.payload.inventoryId)
    if (inventory?.kind !== 'review-attempt' || inventory.payload.rootAttemptId !== root.recordId) continue
    if (!decision.payload.judgment.sourceContributionIds.includes(candidate.recordId))
      diagnostics.push(
        diagnostic(
          'missing-contribution',
          `Decision ${decision.recordId} omits source contribution ${candidate.recordId}`,
        ),
      )
  }
}

function validateDecisionSourceRoots(
  decision: Decision,
  root: ReviewAttempt,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  for (const sourceId of decision.payload.judgment.sourceContributionIds) {
    const contribution = records.get(sourceId)
    if (contribution?.kind !== 'contribution' || contribution.payload.inventoryId === null) continue
    const inventory = records.get(contribution.payload.inventoryId)
    if (inventory?.kind !== 'review-attempt' || inventory.payload.rootAttemptId !== root.recordId)
      diagnostics.push(
        diagnostic('unbound', `Decision ${decision.recordId} source ${sourceId} is outside its root inventory`),
      )
  }
}

function validateDecisionRootSlots(
  decision: Decision,
  root: ReviewAttempt,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
  enforceAdmission: boolean,
): void {
  for (const inventory of records.values())
    if (inventory.kind === 'review-attempt' && inventory.payload.rootAttemptId === root.recordId)
      requiredSlotsComplete(records, inventory, diagnostics, enforceAdmission)
  validateExpectedDecisionSources(decision, root, records, diagnostics)
  validateDecisionSourceRoots(decision, root, records, diagnostics)
}

function validateDecisionInventory(
  decision: Decision,
  source: CanonicalRecord | undefined,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
  enforceAdmission: boolean,
): void {
  const synthesis = decisionSynthesis(decision, source, records, diagnostics)
  if (synthesis === null) return
  const root = decisionInventoryRoot(decision, synthesis, records, diagnostics)
  if (root === null) return
  if (
    decision.payload.judgment.purpose === 'review' &&
    root.payload.stage === 'initial' &&
    root.payload.purpose === 'review' &&
    root.payload.subject.kind === 'pull-request' &&
    decision.payload.judgment.standards === null
  )
    diagnostics.push(
      diagnostic('incomplete', `Pull-request review decision ${decision.recordId} lacks its standards display`),
    )
  validateDecisionRootSlots(decision, root, records, diagnostics, enforceAdmission)
}

function validateDecision(
  decision: Decision,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
  enforceAdmission: boolean,
): void {
  const source = records.get(decision.payload.originalContributionId)
  if (source?.kind !== 'contribution' || source.payload.content !== 'decision')
    diagnostics.push(
      diagnostic('missing-contribution', `Decision ${decision.recordId} lacks its synthesis contribution`),
    )
  if (!decision.inputs.includes(decision.payload.originalContributionId))
    diagnostics.push(diagnostic('unbound', `Decision ${decision.recordId} does not bind its synthesis contribution`))
  validateDecisionCapture(decision, source, diagnostics)
  if (source?.kind === 'contribution' && source.payload.content === 'decision' && source.payload.inventoryId === null)
    diagnostics.push(
      diagnostic('unbound', `Decision ${decision.recordId} synthesis contribution is not bound to an inventory`),
    )
  validateDecisionSources(decision, records, diagnostics)
  validateDecisionInventory(decision, source, records, diagnostics, enforceAdmission)
}

function validateRootSlots(records: Map<string, CanonicalRecord>, diagnostics: Diagnostic[]): void {
  const slotsByRoot = new Map<string, Set<string>>()
  for (const inventory of records.values()) {
    if (inventory.kind !== 'review-attempt') continue
    const slotIds = slotsByRoot.get(inventory.payload.rootAttemptId) ?? new Set<string>()
    for (const slot of inventory.payload.slots) {
      if (slotIds.has(slot.slotId))
        diagnostics.push(
          diagnostic('duplicate-reference', `Root ${inventory.payload.rootAttemptId} repeats slot ${slot.slotId}`),
        )
      slotIds.add(slot.slotId)
    }
    slotsByRoot.set(inventory.payload.rootAttemptId, slotIds)
  }
}

function validateStop(
  record: Extract<CanonicalRecord, { kind: 'stop' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const review = records.get(record.payload.reviewId)
  if (review?.kind !== 'review')
    diagnostics.push(diagnostic('unknown-reference', `Stop ${record.recordId} references no final review`))
  if (!record.inputs.includes(record.payload.reviewId))
    diagnostics.push(diagnostic('unbound', `Stop ${record.recordId} does not bind its final review`))
}

export function validateDecisionAndReviewLinks(
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
  enforceAdmission: boolean,
): void {
  for (const record of records.values())
    if (record.kind === 'decision') validateDecision(record, records, diagnostics, enforceAdmission)
  for (const record of records.values())
    if (record.kind === 'review') validateReviewLinks(record, records, diagnostics, enforceAdmission)
  validateRootSlots(records, diagnostics)
  for (const record of records.values()) if (record.kind === 'stop') validateStop(record, records, diagnostics)
}

import { authenticatedCriterionFacts, criterionAssessmentForDecision } from './criterion-decision.ts'
import { classifyHistory } from './history-classification.ts'
import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Group, Json, Verdict } from './record-values.ts'
import { type DecisionAssessment, type FindingInspection, type Result, recordMap, unique } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { collectOriginals } from './review-decision-sources.ts'
import { groupFor } from './review-groups.ts'
import { analyzeReviewIdentity } from './review-identity.ts'
import { reviewCandidateCode, reviewInputsFromInventory } from './review-inventory-input.ts'
import { inspectContributionFindings } from './review-original-action.ts'
import { validateCauseReferences, validateFinalFindingReferences } from './review-partition.ts'
import { readReviewRecovery } from './review-recovery.ts'

export type DecisionBindings = {
  admissible: boolean
  diagnostics: Diagnostic[]
  records: ReadonlyMap<string, CanonicalRecord>
  originals: ReadonlyMap<string, Json>
  inspections: ReadonlyMap<string, FindingInspection>
}

function validateDecisionBindingsFromGraph(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
  graph: Result<CanonicalRecord[]>,
): DecisionBindings {
  const diagnostics: Diagnostic[] = graph.ok ? [] : [...graph.diagnostics]
  const records = graph.ok ? new Map(graph.value.map((entry) => [entry.recordId, entry])) : recordMap(history)
  const observed = records.get(record.recordId)
  if (observed?.kind !== 'decision' || JSON.stringify(observed) !== JSON.stringify(record))
    diagnostics.push(diagnostic('unbound', `Decision ${record.recordId} is not the observed immutable decision record`))
  const decision = record.payload.judgment
  if (!unique(decision.sourceContributionIds))
    diagnostics.push(diagnostic('duplicate-reference', `Decision ${record.recordId} repeats a source contribution`))
  const originals = collectOriginals(record, records, diagnostics)
  const inspections = new Map<string, FindingInspection>()
  for (const sourceId of decision.sourceContributionIds) {
    const source = records.get(sourceId)
    if (source?.kind !== 'contribution' || source.payload.findings === null) continue
    for (const [id, inspection] of inspectContributionFindings(source, history, catalogues))
      inspections.set(id, inspection)
  }
  const covered = validateFinalFindingReferences(record, originals, inspections, diagnostics)
  for (const sourceId of originals.keys())
    if (!covered.has(sourceId))
      diagnostics.push(
        diagnostic('missing-contribution', `Original finding ${sourceId} is not represented in decision`),
      )
  validateCauseReferences(record, diagnostics)
  return { admissible: diagnostics.length === 0, diagnostics, records, originals, inspections }
}

export function validateDecisionBindings(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
): DecisionBindings {
  return validateDecisionBindingsFromGraph(record, history, catalogues, validateRecordGraph(history))
}

export function validateRetainedUnusableLabels(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  bindings: DecisionBindings,
): Result<null> {
  const diagnostics: Diagnostic[] = []
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state !== 'unusable') continue
    for (const sourceId of finalFinding.sourceFindingIds) {
      const knownLabel = bindings.inspections.get(sourceId)?.knownLabel
      if (knownLabel === undefined) continue
      if (knownLabel !== finalFinding.label)
        diagnostics.push(
          diagnostic('malformed', `Unusable finding ${finalFinding.id} does not retain a known source label`),
        )
    }
  }
  return diagnostics.length === 0 ? { ok: true, value: null } : fail(diagnostics)
}

export type ReviewDecisionBindings = {
  review: Extract<CanonicalRecord, { kind: 'review' }>
  decision: Extract<CanonicalRecord, { kind: 'decision' }>
  bindings: DecisionBindings
}

export function validateReviewDecisionBindings(
  review: Extract<CanonicalRecord, { kind: 'review' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
): Result<ReviewDecisionBindings> {
  const recovery = readReviewRecovery(history)
  if (!recovery.ok) return fail(recovery.diagnostics)
  if (recovery.value.normalProgression === 'stopped')
    return fail([
      diagnostic('incomplete', 'An interrupted review root remains stopped pending its replacement outcome'),
    ])
  const authorityHistory = classifyHistory(history).authorityHistory
  const admissionGraph = validateRecordGraph(authorityHistory)
  if (!admissionGraph.ok) return fail(admissionGraph.diagnostics)
  const candidateDecision = recordMap(authorityHistory).get(review.payload.decisionId)
  if (candidateDecision?.kind !== 'decision')
    return fail([diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)])
  const bindings = validateDecisionBindingsFromGraph(candidateDecision, authorityHistory, catalogues, admissionGraph)
  if (!bindings.admissible) return fail(bindings.diagnostics)
  const identity = analyzeReviewIdentity(authorityHistory, bindings.records)
  if (identity.transportDiagnostics.length > 0) return fail(identity.transportDiagnostics)
  if (identity.incompleteFinal) return fail([diagnostic('incomplete', 'A final review operation is not complete')])
  if (identity.pendingRoot !== null)
    return fail([
      diagnostic(
        'incomplete',
        `Pull-request review inventory ${identity.pendingRoot.recordId} is pending completion by its own final review`,
        { rootId: identity.pendingRoot.recordId, pendingRoot: true },
      ),
    ])
  if (identity.latest === null || identity.latest.recordId !== review.recordId)
    return fail([diagnostic('unbound', `Review ${review.recordId} is not the latest canonical final review`)])
  const observedReview = bindings.records.get(review.recordId)
  if (observedReview?.kind !== 'review' || JSON.stringify(observedReview) !== JSON.stringify(review))
    return fail([diagnostic('unbound', `Review ${review.recordId} is not the observed immutable review record`)])
  const decision = bindings.records.get(review.payload.decisionId)
  if (decision?.kind !== 'decision')
    return fail([diagnostic('unknown-reference', `Review ${review.recordId} lacks its decision`)])
  const retainedLabels = validateRetainedUnusableLabels(decision, bindings)
  if (!retainedLabels.ok) return retainedLabels
  return { ok: true, value: { review: observedReview, decision, bindings } }
}

type InspectedDecisionFindings = {
  groups: Record<Group, string[]>
  findings: { id: string; inspection: FindingInspection }[]
}

function validateDecisionPolicy(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  bindings: DecisionBindings,
  acceptedPolicyRef: string | null,
  diagnostics: Diagnostic[],
): void {
  const retainedLabels = validateRetainedUnusableLabels(record, bindings)
  if (!retainedLabels.ok) diagnostics.push(...retainedLabels.diagnostics)
  const policy = record.payload.judgment.policy
  if (policy.version === 'evidence-v1' && policy.acceptanceRef !== acceptedPolicyRef)
    diagnostics.push(diagnostic('policy-not-accepted', 'Evidence policy is not independently accepted'))
}

function inspectDecisionFindings(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  bindings: DecisionBindings,
  diagnostics: Diagnostic[],
  rejected: ReadonlySet<string>,
): InspectedDecisionFindings {
  const groups: Record<Group, string[]> = { Blockers: [], Warnings: [], Suggestions: [], Praise: [] }
  const findings: { id: string; inspection: FindingInspection }[] = []
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state === 'usable' && finalFinding.label === null)
      diagnostics.push(diagnostic('malformed', `Usable finding ${finalFinding.id} has no model label`))
    for (const sourceId of finalFinding.sourceFindingIds) {
      const inspection = bindings.inspections.get(sourceId)
      if (inspection === undefined) continue
      findings.push({ id: sourceId, inspection })
      if (!inspection.usable) diagnostics.push(...inspection.diagnostics)
    }
    if (finalFinding.label !== null && !rejected.has(finalFinding.id))
      groups[groupFor(finalFinding.label)].push(finalFinding.id)
  }
  return { groups, findings }
}

function decisionVerdict(
  groups: Record<Group, string[]>,
  hasUnusable: boolean,
  diagnostics: readonly Diagnostic[],
  findingsCount: number,
): Verdict | null {
  if (hasUnusable || diagnostics.length > 0) return null
  if (groups.Blockers.length > 0) return 'Request changes'
  if (groups.Warnings.length > 0) return 'Approve with comments'
  return findingsCount > 0 ? 'Approve' : 'Approve (clean)'
}

// A caller that filters review authority must retain the original same-scope
// observation for separately authenticated delivery receipts and evidence.
export function assessDecision(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
  rejected: ReadonlySet<string> = new Set(),
): DecisionAssessment {
  const bindings = validateDecisionBindingsFromGraph(record, history, catalogues, validateRecordGraph(history))
  const diagnostics = [...bindings.diagnostics]
  validateDecisionPolicy(record, bindings, acceptedPolicyRef, diagnostics)
  const inspected = inspectDecisionFindings(record, bindings, diagnostics, rejected)
  const hasUnusable =
    record.payload.judgment.findings.some((finding) => finding.state === 'unusable') ||
    inspected.findings.some(({ inspection }) => !inspection.usable)
  const findingVerdict = decisionVerdict(
    inspected.groups,
    hasUnusable,
    diagnostics,
    record.payload.judgment.findings.length,
  )
  const review = record.payload.judgment.purpose === 'review' ? record.payload.judgment : null
  const inputs = review === null ? null : reviewInputsFromInventory(review, history)
  const facts =
    review === null
      ? { declarations: [], evidence: [], verdicts: [], diagnostics: [] }
      : authenticatedCriterionFacts(
          review,
          history,
          record.payload.originalContributionId,
          catalogues,
          externalHistories,
          deliveryHistory,
        )
  const criterion = criterionAssessmentForDecision(
    record.payload.judgment,
    inputs,
    facts,
    review === null ? null : reviewCandidateCode(review, history),
    [deliveryHistory, ...externalHistories],
  )
  diagnostics.push(...criterion.diagnostics)
  const structural = criterion.diagnostics.some(
    (item) =>
      item.code === 'malformed' ||
      item.code === 'spec-not-accepted' ||
      item.code === 'duplicate-reference' ||
      item.code === 'missing-history' ||
      item.code === 'incomplete' ||
      item.code === 'foreign' ||
      item.code === 'conflict' ||
      item.code === 'unconfirmed',
  )
  const verdict =
    findingVerdict === null || structural ? null : criterion.forceRequestChanges ? 'Request changes' : findingVerdict
  return {
    admissible: verdict !== null,
    groups: inspected.groups,
    verdict,
    findings: inspected.findings,
    diagnostics,
  }
}

export function validateDecision(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  catalogues: ReviewClassCatalogues,
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
): DecisionAssessment {
  return assessDecision(record, history, catalogues, acceptedPolicyRef, externalHistories, deliveryHistory)
}
export { validateFreshDecision } from './review-fresh-decision.ts'

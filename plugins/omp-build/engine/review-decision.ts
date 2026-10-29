import { authenticatedCriterionFacts, criterionAssessmentForDecision } from './criterion-decision.ts'
import { classifyHistory } from './history-classification.ts'
import { validateRecordGraph } from './history-graph.ts'
import type { DecodedHistory } from './history-schema.ts'
import { inspectFinding } from './producer-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Group, Json, Verdict } from './record-values.ts'
import { type DecisionAssessment, type FindingInspection, type Result, recordMap, unique } from './result.ts'
import { collectOriginals } from './review-decision-sources.ts'
import { groupFor } from './review-groups.ts'
import { analyzeReviewIdentity } from './review-identity.ts'
import { reviewCandidateCode, reviewInputsFromInventory } from './review-inventory-input.ts'
import { readReviewRecovery } from './review-recovery.ts'
import { causeSchema } from './review-schema.ts'

export type DecisionBindings = {
  admissible: boolean
  diagnostics: Diagnostic[]
  records: ReadonlyMap<string, CanonicalRecord>
  originals: ReadonlyMap<string, Json>
}

function validateFinalFindingReferences(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  originals: ReadonlyMap<string, Json>,
  diagnostics: Diagnostic[],
): Set<string> {
  const covered = new Set<string>()
  const findings = record.payload.judgment.findings
  if (!unique(findings.map((finding) => finding.id)))
    diagnostics.push(diagnostic('duplicate-reference', 'Decision repeats final finding IDs'))
  for (const finalFinding of findings) {
    if (!unique(finalFinding.sourceFindingIds))
      diagnostics.push(diagnostic('duplicate-reference', `Final finding ${finalFinding.id} repeats a source`))
    if (
      finalFinding.state === 'usable' &&
      finalFinding.sourceFindingIds.length > 1 &&
      finalFinding.mergeReason === undefined
    )
      diagnostics.push(diagnostic('malformed', `Merged finding ${finalFinding.id} lacks merge reason`))
    for (const sourceId of finalFinding.sourceFindingIds) {
      if (!originals.has(sourceId)) {
        diagnostics.push(diagnostic('unknown-reference', `Final finding ${finalFinding.id} references ${sourceId}`))
        continue
      }
      if (covered.has(sourceId))
        diagnostics.push(diagnostic('duplicate-reference', `Original finding ${sourceId} is covered more than once`))
      covered.add(sourceId)
    }
  }
  return covered
}

function validateCauseReferences(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  diagnostics: Diagnostic[],
): void {
  const decision = record.payload.judgment
  const caused = new Set<string>()
  if (!unique(decision.causes.map((cause) => cause.id)))
    diagnostics.push(diagnostic('duplicate-reference', 'Decision repeats cause IDs'))
  const finalIds = new Set(decision.findings.map((finding) => finding.id))
  for (const cause of decision.causes) {
    if (!causeSchema.safeParse(cause).success)
      diagnostics.push(diagnostic('malformed', `Cause ${cause.id} is incomplete`))
    if (!unique(cause.findingIds))
      diagnostics.push(diagnostic('duplicate-reference', `Cause ${cause.id} repeats a finding`))
    for (const findingId of cause.findingIds) {
      if (!finalIds.has(findingId))
        diagnostics.push(diagnostic('unknown-reference', `Cause ${cause.id} references unknown finding ${findingId}`))
      if (caused.has(findingId))
        diagnostics.push(diagnostic('duplicate-reference', `Finding ${findingId} belongs to more than one cause`))
      caused.add(findingId)
    }
  }
}

function validateDecisionBindingsFromGraph(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
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
  const covered = validateFinalFindingReferences(record, originals, diagnostics)
  for (const sourceId of originals.keys())
    if (!covered.has(sourceId))
      diagnostics.push(
        diagnostic('missing-contribution', `Original finding ${sourceId} is not represented in decision`),
      )
  validateCauseReferences(record, diagnostics)
  return { admissible: diagnostics.length === 0, diagnostics, records, originals }
}

export function validateDecisionBindings(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
): DecisionBindings {
  return validateDecisionBindingsFromGraph(record, history, validateRecordGraph(history, false))
}

export function validateRetainedUnusableLabels(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  bindings: DecisionBindings,
): Result<null> {
  const diagnostics: Diagnostic[] = []
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state !== 'unusable') continue
    for (const sourceId of finalFinding.sourceFindingIds) {
      const original = bindings.originals.get(sourceId)
      if (original === undefined) continue
      const knownLabel = inspectFinding(original, []).knownLabel
      if (knownLabel === null || knownLabel !== finalFinding.label)
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
  const bindings = validateDecisionBindingsFromGraph(candidateDecision, authorityHistory, admissionGraph)
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
  taxonomy: readonly string[],
  diagnostics: Diagnostic[],
): InspectedDecisionFindings {
  const groups: Record<Group, string[]> = { Blockers: [], Warnings: [], Suggestions: [], Praise: [] }
  const findings: { id: string; inspection: FindingInspection }[] = []
  for (const finalFinding of record.payload.judgment.findings) {
    if (finalFinding.state === 'usable' && finalFinding.label === null)
      diagnostics.push(diagnostic('malformed', `Usable finding ${finalFinding.id} has no model label`))
    for (const sourceId of finalFinding.sourceFindingIds) {
      const original = bindings.originals.get(sourceId)
      if (original === undefined) continue
      const inspection = inspectFinding(original, taxonomy)
      findings.push({ id: sourceId, inspection })
      if (!inspection.usable) diagnostics.push(...inspection.diagnostics)
    }
    if (finalFinding.label !== null) groups[groupFor(finalFinding.label)].push(finalFinding.id)
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
export function validateDecision(
  record: Extract<CanonicalRecord, { kind: 'decision' }>,
  history: DecodedHistory,
  taxonomy: readonly string[],
  acceptedPolicyRef: string | null,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
): DecisionAssessment {
  const bindings = validateDecisionBindingsFromGraph(record, history, validateRecordGraph(history))
  const diagnostics = [...bindings.diagnostics]
  validateDecisionPolicy(record, bindings, acceptedPolicyRef, diagnostics)
  const inspected = inspectDecisionFindings(record, bindings, taxonomy, diagnostics)
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

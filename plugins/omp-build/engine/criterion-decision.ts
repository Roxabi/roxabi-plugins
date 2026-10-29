import { z } from 'zod'
import { validateActionInputs } from './action-input.ts'
import type { ActionInputs, PinnedFileRef } from './action-input-schema.ts'
import { assessCriterionReview, assessExclusion } from './criterion-admission.ts'
import { selectedDeclarations } from './criterion-decision-selection.ts'
import type { CriterionDeclaration, CriterionEvidence, EvidenceRef } from './criterion-evidence-schema.ts'
import type { CriterionVerdict } from './criterion-verdict-schema.ts'
import { criterionVerdictSchema } from './criterion-verdict-schema.ts'
import { observationRefDiagnostics } from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { type Diagnostic, specReportSchema } from './record-values.ts'
import type { Decision } from './review-schema.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import { recordsOf } from './workflow-control.ts'

type ReviewDecision = Extract<Decision, { purpose: 'review' }>
type Inventory = Extract<CanonicalRecord, { kind: 'review-attempt' }>

export type CriterionDecisionFacts = {
  declarations: CriterionDeclaration[]
  evidence: { ref: EvidenceRef; value: CriterionEvidence }[]
  verdicts: CriterionVerdict[]
  diagnostics: Diagnostic[]
}

function sameTarget(left: CriterionVerdict['target'], right: CriterionVerdict['target']): boolean {
  return sameOwnSpecRef(left.spec, right.spec) && left.id === right.id
}

function initialInventory(records: readonly CanonicalRecord[], inventoryId: string | null): Inventory | null {
  const seen = new Set<string>()
  let current =
    records.find(
      (record): record is Inventory => record.recordId === inventoryId && record.kind === 'review-attempt',
    ) ?? null
  while (current !== null && !seen.has(current.recordId)) {
    seen.add(current.recordId)
    const payload = current.payload
    if (payload.stage === 'initial' && payload.purpose === 'review' && 'inputSnapshot' in payload) return current
    current =
      records.find(
        (record): record is Inventory => record.recordId === payload.rootAttemptId && record.kind === 'review-attempt',
      ) ?? null
  }
  return null
}

export function reviewInputsFromInventory(decision: ReviewDecision, history: DecodedHistory): ActionInputs | null {
  const records = recordsOf(history)
  const sources = records.filter(
    (record): record is Extract<CanonicalRecord, { kind: 'contribution' }> =>
      record.kind === 'contribution' && decision.sourceContributionIds.includes(record.recordId),
  )
  const roots = sources
    .map((source) => initialInventory(records, source.payload.inventoryId))
    .filter((inventory): inventory is Inventory => inventory !== null)
  const distinct = roots.filter(
    (inventory, index) => roots.findIndex((item) => item.recordId === inventory.recordId) === index,
  )
  const selected = distinct.length === 1 ? distinct[0] : null
  if (selected === null || !('inputSnapshot' in selected.payload) || selected.payload.inputSnapshot === null)
    return null
  const snapshot = selected.payload.inputSnapshot
  if (!validateActionInputs(snapshot).ok) return null
  if (selected.payload.actionInputDigest !== snapshot.fingerprint) return null
  return snapshot
}

function specRows(candidate: unknown): unknown[] {
  const report = specReportSchema.safeParse(candidate)
  if (report.success) return report.data.specRows
  if (candidate === null || typeof candidate !== 'object' || !('specRows' in candidate)) return [candidate]
  return z.object({ specRows: z.array(z.unknown()) }).safeParse(candidate).data?.specRows ?? [candidate]
}

function matchingVerdicts(rows: readonly unknown[], target: CriterionVerdict['target']): CriterionVerdict[] {
  const matches: CriterionVerdict[] = []
  for (const row of rows) {
    const parsed = criterionVerdictSchema.safeParse(row)
    if (parsed.success && sameTarget(parsed.data.target, target)) matches.push(parsed.data)
  }
  return matches
}

function verdictsForTarget(
  contribution: Extract<CanonicalRecord, { kind: 'contribution' }>,
  target: CriterionVerdict['target'],
): CriterionVerdict[] {
  const candidates: unknown[] = []
  if (contribution.payload.structured !== null) candidates.push(contribution.payload.structured)
  for (const finding of contribution.payload.findings ?? []) candidates.push(finding.data)
  return candidates.flatMap((candidate) => matchingVerdicts(specRows(candidate), target))
}

function reviewContribution(
  records: readonly CanonicalRecord[],
  contributionId: string,
  bound: ReadonlySet<string>,
): Extract<CanonicalRecord, { kind: 'contribution' }> | null {
  const contribution = records.find((record) => record.kind === 'contribution' && record.recordId === contributionId)
  if (contribution?.kind !== 'contribution' || !bound.has(contribution.recordId)) return null
  if (contribution.payload.host.role !== 'R-review-spec') return null
  return contribution
}

function appendVerdict(
  records: readonly CanonicalRecord[],
  bound: ReadonlySet<string>,
  ref: ReviewDecision['criterionVerdicts'][number],
  verdicts: CriterionVerdict[],
  diagnostics: Diagnostic[],
): void {
  const contribution = reviewContribution(records, ref.contributionId, bound)
  if (contribution === null) {
    diagnostics.push(diagnostic('malformed', `Verdict ${ref.target.id} is not an authenticated R-review-spec row`))
    return
  }
  const matches = verdictsForTarget(contribution, ref.target)
  if (matches.length !== 1) {
    diagnostics.push(
      diagnostic(
        'malformed',
        `R-review-spec contribution ${ref.contributionId} does not contain exactly one verdict for ${ref.target.id}`,
      ),
    )
    return
  }
  const verdict = matches[0]
  if (verdict === undefined || verdicts.some((item) => sameTarget(item.target, verdict.target))) {
    diagnostics.push(diagnostic('duplicate-reference', `Criterion ${ref.target.id} is cited more than once`))
    return
  }
  verdicts.push(verdict)
}

function retainedFindingIds(records: readonly CanonicalRecord[], bound: ReadonlySet<string>): Set<string> {
  const retained = new Set<string>()
  for (const record of records) {
    if (record.kind !== 'contribution' || !bound.has(record.recordId)) continue
    for (const finding of record.payload.findings ?? []) retained.add(finding.id)
  }
  return retained
}

function retainExclusions(
  decision: ReviewDecision,
  inputs: ActionInputs,
  records: readonly CanonicalRecord[],
  bound: ReadonlySet<string>,
  diagnostics: Diagnostic[],
): void {
  if (inputs.manifest.spec.kind !== 'accepted') return
  const retained = retainedFindingIds(records, bound)
  for (const claim of decision.exclusionClaims) {
    if (!retained.has(claim.sourceFindingId)) {
      diagnostics.push(diagnostic('unknown-reference', `Exclusion ${claim.sourceFindingId} is not a retained original`))
    }
    const assessed = assessExclusion({ spec: inputs.manifest.spec.effective, claim })
    if (!assessed.ok) diagnostics.push(...assessed.diagnostics)
  }
}

export function authenticatedCriterionFacts(
  decision: ReviewDecision,
  history: DecodedHistory,
  originalContributionId: string,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
): CriterionDecisionFacts {
  const records = recordsOf(history)
  const diagnostics: Diagnostic[] = []
  const inputs = reviewInputsFromInventory(decision, history)
  const selected =
    inputs === null
      ? { declarations: [], evidence: [] }
      : selectedDeclarations([deliveryHistory, ...externalHistories], inputs, diagnostics)
  const bound = new Set(decision.sourceContributionIds)
  if (originalContributionId !== null) bound.add(originalContributionId)
  const verdicts: CriterionVerdict[] = []
  for (const ref of decision.criterionVerdicts) appendVerdict(records, bound, ref, verdicts, diagnostics)
  if (inputs !== null) retainExclusions(decision, inputs, records, bound, diagnostics)
  return { declarations: selected.declarations, evidence: selected.evidence, verdicts, diagnostics }
}

function manifestPins(inputs: ActionInputs | null): PinnedFileRef[] {
  if (inputs === null) return []
  return [
    ...inputs.manifest.repositoryReferences,
    ...inputs.manifest.plugin.files,
    ...inputs.manifest.expandedContext.flatMap((ref) => (ref.source === 'git-file' ? [ref] : [])),
  ]
}

function codeLinkReferenceDiagnostics(
  verdicts: readonly CriterionVerdict[],
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
): Diagnostic[] {
  return verdicts.flatMap((verdict) =>
    verdict.examined.flatMap((row) => {
      const references =
        row.codeLink.method === 'test'
          ? [...row.codeLink.after.references, ...(row.codeLink.before?.references ?? [])]
          : row.codeLink.current.references
      return references.flatMap((ref) => observationRefDiagnostics(verdict.target.id, ref, histories, pins))
    }),
  )
}

function assessStandalone(
  decision: ReviewDecision,
  inputs: ActionInputs,
  code: { repository: string; commit: string } | null,
  diagnostics: Diagnostic[],
): { forceRequestChanges: boolean; diagnostics: Diagnostic[] } {
  if (
    inputs.manifest.spec.kind !== 'absent' ||
    inputs.manifest.subject.kind !== 'standalone-pr' ||
    inputs.manifest.spec.reason !== 'standalone-review'
  ) {
    diagnostics.push(diagnostic('malformed', 'Absent Spec is lawful only for a standalone review'))
    return { forceRequestChanges: true, diagnostics }
  }
  if (decision.criterionVerdicts.length > 0 || decision.exclusionClaims.length > 0) {
    diagnostics.push(diagnostic('malformed', 'A standalone review carries criterion verdicts or exclusion claims'))
    return { forceRequestChanges: true, diagnostics }
  }
  if (
    code === null ||
    inputs.manifest.code.repository !== code.repository ||
    inputs.manifest.code.head !== code.commit
  ) {
    diagnostics.push(diagnostic('mismatch', 'Review code does not match the manifest-selected head'))
    return { forceRequestChanges: true, diagnostics }
  }
  return { forceRequestChanges: false, diagnostics }
}

export function criterionAssessmentForDecision(
  decision: Decision,
  inputs: ActionInputs | null,
  facts: CriterionDecisionFacts,
  code: { repository: string; commit: string } | null,
  histories: readonly DecodedHistory[] = [],
): { forceRequestChanges: boolean; diagnostics: Diagnostic[] } {
  const diagnostics = [
    ...facts.diagnostics,
    ...codeLinkReferenceDiagnostics(facts.verdicts, histories, manifestPins(inputs)),
  ]
  if (decision.purpose !== 'review') return { forceRequestChanges: false, diagnostics }
  if (inputs === null) {
    diagnostics.push(diagnostic('malformed', 'Review decision lacks an authenticated action-input binding'))
    return { forceRequestChanges: true, diagnostics }
  }
  if (inputs.manifest.spec.kind === 'absent') return assessStandalone(decision, inputs, code, diagnostics)
  if (inputs.manifest.spec.kind !== 'accepted') {
    diagnostics.push(diagnostic('spec-not-accepted', 'A proposed Spec cannot approve delivery'))
    return { forceRequestChanges: true, diagnostics }
  }
  if (
    code === null ||
    inputs.manifest.code.repository !== code.repository ||
    inputs.manifest.code.head !== code.commit
  ) {
    diagnostics.push(diagnostic('mismatch', 'Review code does not match the manifest-selected head'))
    return { forceRequestChanges: true, diagnostics }
  }
  const assessment = assessCriterionReview({
    spec: inputs.manifest.spec.effective,
    code: { repository: code.repository, commit: code.commit },
    declarations: facts.declarations,
    verdicts: facts.verdicts,
    evidence: facts.evidence,
  })
  return {
    forceRequestChanges: diagnostics.length > 0 || !assessment.complete || assessment.requiresChanges,
    diagnostics: [...diagnostics, ...assessment.diagnostics],
  }
}

export function reviewCandidateCode(
  decision: ReviewDecision,
  history: DecodedHistory,
): { repository: string; commit: string } | null {
  const inputs = reviewInputsFromInventory(decision, history)
  if (inputs === null) return null
  const records = recordsOf(history)
  const inventory = records.find(
    (record) =>
      record.kind === 'review-attempt' &&
      'inputSnapshot' in record.payload &&
      record.payload.inputSnapshot?.fingerprint === inputs.fingerprint,
  )
  if (inventory?.kind !== 'review-attempt' || !('candidateGitSHA' in inventory.payload)) return null
  if (inventory.payload.candidateGitSHA !== inputs.manifest.code.head) return null
  if (inventory.payload.actionInputDigest !== inputs.fingerprint) return null
  return { repository: inputs.manifest.code.repository, commit: inventory.payload.candidateGitSHA }
}

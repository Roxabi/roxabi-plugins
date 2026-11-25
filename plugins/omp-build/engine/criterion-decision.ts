import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { assessCriterionReview } from './criterion-admission.ts'
import { selectedDeclarations } from './criterion-decision-selection.ts'
import type { CriterionDeclaration, CriterionEvidence, EvidenceRef } from './criterion-evidence-schema.ts'
import type { CriterionVerdict } from './criterion-verdict-schema.ts'
import { criterionVerdictCitationDiagnostics } from './delivery-observation-authentication.ts'
import { validateExclusionClaims } from './exclusion-claims.ts'
import { authenticateHistoricalActionInputs } from './historical-action-inputs.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameOwnSpecRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, SpecReport } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { reviewInputsFromInventory } from './review-inventory-input.ts'
import { reviewCriterionReport } from './review-original-action.ts'
import type { Decision } from './review-schema.ts'
import { recordsOf } from './workflow-control.ts'

type ReviewDecision = Extract<Decision, { purpose: 'review' }>
type VerdictSource = { contributionId: string; selector: string; digest: string }

export type CriterionDecisionFacts = {
  declarations: CriterionDeclaration[]
  evidence: { ref: EvidenceRef; value: CriterionEvidence }[]
  verdicts: CriterionVerdict[]
  verdictSources?: ReadonlyMap<CriterionVerdict, VerdictSource>
  diagnostics: Diagnostic[]
}

function sameTarget(left: CriterionVerdict['target'], right: CriterionVerdict['target']): boolean {
  return sameOwnSpecRef(left.spec, right.spec) && left.id === right.id
}

function criterionReport(
  records: readonly CanonicalRecord[],
  contributionId: string,
  decision: ReviewDecision,
  inputs: ActionInputs | null,
  history: DecodedHistory,
): SpecReport | null {
  if (inputs === null || !decision.sourceContributionIds.includes(contributionId)) return null
  const contribution = records.find((record) => record.kind === 'contribution' && record.recordId === contributionId)
  return contribution?.kind === 'contribution' ? reviewCriterionReport(contribution, history, inputs) : null
}

function appendVerdict(
  report: SpecReport | null,
  ref: ReviewDecision['criterionVerdicts'][number],
  verdicts: Map<CriterionVerdict, VerdictSource>,
  diagnostics: Diagnostic[],
): void {
  if (report === null) {
    diagnostics.push(
      diagnostic(
        'malformed',
        `Verdict ${ref.target.id} from contribution ${ref.contributionId} is not an authenticated R-review-spec row`,
      ),
    )
    return
  }
  const matches = report.specRows.flatMap((row, index) => (sameTarget(row.target, ref.target) ? [{ row, index }] : []))
  if (matches.length !== 1) {
    diagnostics.push(
      diagnostic(
        'malformed',
        `R-review-spec contribution ${ref.contributionId} does not contain exactly one verdict for ${ref.target.id}`,
      ),
    )
    return
  }
  const match = matches[0]
  if (match === undefined) return
  for (const verdict of verdicts.keys()) {
    if (!sameTarget(verdict.target, match.row.target)) continue
    diagnostics.push(diagnostic('duplicate-reference', `Criterion ${ref.target.id} is cited more than once`))
    return
  }
  verdicts.set(match.row, {
    contributionId: ref.contributionId,
    selector: `/payload/structured/specRows/${match.index}`,
    digest: canonicalValueDigest(match.row),
  })
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
  const claims = validateExclusionClaims({
    spec: inputs.manifest.spec.effective,
    claims: decision.exclusionClaims,
    findings: decision.findings,
    retained: retainedFindingIds(records, bound),
  })
  for (const errors of claims.values()) diagnostics.push(...errors)
}

export function authenticatedCriterionFacts(
  decision: ReviewDecision,
  history: DecodedHistory,
  originalContributionId: string,
  catalogues: ReviewClassCatalogues,
  externalHistories: readonly DecodedHistory[] = [],
  deliveryHistory: DecodedHistory = history,
): CriterionDecisionFacts {
  const records = recordsOf(history)
  const diagnostics: Diagnostic[] = []
  const histories = [deliveryHistory, ...externalHistories]
  const inputs = reviewInputsFromInventory(decision, history, histories)
  const selected =
    inputs === null
      ? { declarations: [], evidence: [] }
      : selectedDeclarations(histories, inputs, diagnostics, catalogues)
  const bound = new Set(decision.sourceContributionIds)
  if (originalContributionId !== null) bound.add(originalContributionId)
  const reports = new Map<string, SpecReport | null>()
  const verdictSources = new Map<CriterionVerdict, VerdictSource>()
  for (const ref of decision.criterionVerdicts) {
    let report = reports.get(ref.contributionId)
    if (report === undefined) {
      report = criterionReport(records, ref.contributionId, decision, inputs, history)
      reports.set(ref.contributionId, report)
    }
    appendVerdict(report, ref, verdictSources, diagnostics)
  }
  if (inputs !== null) retainExclusions(decision, inputs, records, bound, diagnostics)
  return { ...selected, verdicts: [...verdictSources.keys()], verdictSources, diagnostics }
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
  const diagnostics = [...facts.diagnostics]
  if (decision.purpose !== 'review') {
    diagnostics.push(
      ...facts.verdicts.flatMap((verdict) => criterionVerdictCitationDiagnostics(verdict, histories, inputs)),
    )
    return { forceRequestChanges: false, diagnostics }
  }
  if (inputs === null) {
    diagnostics.push(diagnostic('malformed', 'Review decision lacks an authenticated action-input binding'))
    return { forceRequestChanges: true, diagnostics }
  }
  const authenticated = authenticateHistoricalActionInputs(inputs, histories)
  if (!authenticated.ok) {
    diagnostics.push(...authenticated.diagnostics)
    return { forceRequestChanges: true, diagnostics }
  }
  diagnostics.push(
    ...facts.verdicts.flatMap((verdict) =>
      criterionVerdictCitationDiagnostics(verdict, histories, authenticated.value),
    ),
  )
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

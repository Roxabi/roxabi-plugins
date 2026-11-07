import { canonicalValueDigest } from './action-input.ts'
import type { RecordInputRef } from './action-input-refs.ts'
import { criterionDeclarationSchema } from './criterion-evidence-schema.ts'
import { criterionVerdictSchema } from './criterion-verdict-schema.ts'
import { sameOwnSpecRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import { type Diagnostic, type Scope, specReportSchema } from './record-values.ts'
import { resolveSpecEffective } from './spec-effective.ts'
import type { SpecEffective } from './spec-effective-schema.ts'
import type { UwCompletionAssessment, UwCompletionObservation } from './uw-completion-types.ts'
import { selectUwDeliveryReview } from './uw-delivery-proof.ts'
import { authenticatedDeliveryRecord, deliveryFailure, type SelectedDeliveryReview } from './uw-delivery-review.ts'
import type { UwDeliveryDeclaration, UwDeliveryRead, UwDeliveryVerdict } from './uw-delivery-types.ts'
import { toDiagnostics, type UwResult } from './uw-diagnostics.ts'
import { scopeKey } from './uw-graph.ts'
import { resolveAcceptedSpec } from './workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from './workflow-accepted-spec-types.ts'
import { historyFor, recordsOf } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'

function selectedValue(record: CanonicalRecord, selector: string): unknown {
  let value: unknown = record
  for (const raw of selector.split('/').slice(1)) {
    if (value === null || typeof value !== 'object') return undefined
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (!Object.hasOwn(value, key)) return undefined
    value = Object.getOwnPropertyDescriptor(value, key)?.value
  }
  return value
}

function currentAccepted(observation: UwCompletionObservation, uw: Scope): UwResult<AcceptedOwnSpec> {
  const history = historyFor(uw, observation.histories)
  if (history === null) return deliveryFailure(uw, 'delivery-history-incomplete', 'UW history is absent')
  const mandate = selectedMandate(history)
  if (!('kind' in mandate)) return deliveryFailure(uw, mandate.reason, 'No current authenticated delivery mandate')
  const accepted = resolveAcceptedSpec(mandate, observation.histories)
  return accepted.ok
    ? { ok: true, value: accepted.spec }
    : deliveryFailure(uw, accepted.reason, accepted.evidence.map((item) => item.message).join('; '))
}

function declarationRows(
  observation: UwCompletionObservation,
  selected: SelectedDeliveryReview,
): UwDeliveryDeclaration[] {
  const rows: UwDeliveryDeclaration[] = []
  const seen = new Set<string>()
  const spec = selected.inputs.manifest.spec
  if (spec.kind !== 'accepted') return rows
  const code = selected.inputs.manifest.code
  for (const pin of selected.inputs.manifest.deliveryData) {
    const evidenceIndex = pin.selector.indexOf('/evidence/')
    const selector = evidenceIndex === -1 ? pin.selector : pin.selector.slice(0, evidenceIndex)
    if (!/^\/payload\/(?:structured\/criteria|criterionReceipt\/criteria)\/\d+$/.test(selector)) continue
    const key = `${pin.record.scope.repository}\0${pin.record.scope.target}\0${pin.record.recordId}\0${selector}`
    if (seen.has(key)) continue
    const bound = authenticatedDeliveryRecord(observation, pin.record)
    if (!bound.ok) continue
    const raw = selectedValue(bound.value, selector)
    const declaration = criterionDeclarationSchema.safeParse(raw)
    if (!declaration.success || !sameOwnSpecRef(declaration.data.target.spec, spec.effective.own)) continue
    seen.add(key)
    rows.push({
      value: declaration.data,
      code: { repository: code.repository, commit: code.head },
      receipt: { source: 'record', record: pin.record, selector, digest: canonicalValueDigest(raw) },
    })
  }
  return rows
}

function reportCandidates(value: unknown, path: string): { value: unknown; path: string }[] {
  const report = specReportSchema.safeParse(value)
  return report.success
    ? report.data.specRows.map((row, index) => ({ value: row, path: `${path}/specRows/${index}` }))
    : [{ value, path }]
}

function contributionCandidates(
  record: Extract<CanonicalRecord, { kind: 'contribution' }>,
): { value: unknown; path: string }[] {
  const candidates = reportCandidates(record.payload.structured, '/payload/structured')
  for (const [index, finding] of (record.payload.findings ?? []).entries())
    candidates.push(...reportCandidates(finding.data, `/payload/findings/${index}/data`))
  return candidates
}

function verdictRows(selected: SelectedDeliveryReview): UwDeliveryVerdict[] {
  const judgment = selected.decision.payload.judgment
  if (judgment.purpose !== 'review') return []
  const records = new Map(recordsOf(selected.history).map((record) => [record.recordId, record]))
  const rows: UwDeliveryVerdict[] = []
  const code = selected.inputs.manifest.code
  for (const ref of judgment.criterionVerdicts) {
    const contribution = records.get(ref.contributionId)
    if (contribution?.kind !== 'contribution') continue
    for (const candidate of contributionCandidates(contribution)) {
      const value = criterionVerdictSchema.safeParse(candidate.value)
      if (
        !value.success ||
        value.data.target.id !== ref.target.id ||
        !sameOwnSpecRef(value.data.target.spec, ref.target.spec)
      )
        continue
      const source: RecordInputRef = {
        source: 'record',
        record: { scope: selected.history.source.scope, recordId: contribution.recordId, kind: 'contribution' },
        selector: candidate.path,
        digest: canonicalValueDigest(candidate.value),
      }
      rows.push({ value: value.data, code: { repository: code.repository, commit: code.head }, source })
    }
  }
  return rows
}

function effectiveResult(
  observation: UwCompletionObservation,
  accepted: UwResult<AcceptedOwnSpec>,
): UwResult<SpecEffective> {
  return accepted.ok
    ? resolveSpecEffective({
        mode: 'current',
        own: accepted.value.ref,
        histories: observation.histories,
        graph: observation.graph,
      })
    : accepted
}

export function projectUwDelivery(
  observation: UwCompletionObservation,
  assessment: UwCompletionAssessment,
  uw: Scope,
): UwResult<UwDeliveryRead> {
  if (observation.status === 'incomplete') return { ok: false, diagnostics: [...observation.diagnostics] }
  const accepted = currentAccepted(observation, uw)
  const effective = effectiveResult(observation, accepted)
  const diagnostics: Diagnostic[] = []
  const completion = assessment.completions.get(scopeKey(uw))
  if (completion !== undefined && completion.state !== 'complete')
    diagnostics.push(...toDiagnostics(completion.diagnostics))
  if (!accepted.ok || !effective.ok) {
    if (!effective.ok) diagnostics.push(...toDiagnostics(effective.diagnostics))
    return { ok: true, value: { uw, effective, declarations: [], verdicts: [], diagnostics } }
  }
  const selected = selectUwDeliveryReview(observation, uw, accepted.value, effective.value)
  if (!selected.ok) {
    diagnostics.push(...toDiagnostics(selected.diagnostics))
    return { ok: true, value: { uw, effective, declarations: [], verdicts: [], diagnostics } }
  }
  diagnostics.push(...selected.value.diagnostics)
  return {
    ok: true,
    value: {
      uw,
      effective,
      declarations: declarationRows(observation, selected.value),
      verdicts: verdictRows(selected.value),
      diagnostics,
    },
  }
}

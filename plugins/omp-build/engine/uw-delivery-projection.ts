import { canonicalValueDigest } from './action-input.ts'
import type { RecordInputRef } from './action-input-refs.ts'
import { criterionVerdictRequiresChanges } from './criterion-admission.ts'
import { criterionDeclarationSchema } from './criterion-evidence-schema.ts'
import { criterionVerdictCitationDiagnostics } from './delivery-observation-authentication.ts'
import {
  authenticatedReceiptActionInputs,
  recordRefDiagnostics,
  selectedRecordValue,
} from './historical-action-inputs.ts'
import { diagnostic, sameOwnSpecRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
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
import { historyFor } from './workflow-control.ts'
import { selectedMandate } from './workflow-mandate-admission.ts'

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

function declarationRecord(observation: UwCompletionObservation, pin: RecordInputRef): CanonicalRecord | null {
  const bound = authenticatedDeliveryRecord(observation, pin.record)
  if (!bound.ok || recordRefDiagnostics('Delivery declaration', pin, observation.histories).length !== 0) return null
  if (
    bound.value.kind === 'action-receipt' &&
    !authenticatedReceiptActionInputs(bound.value.payload, observation.histories)
  )
    return null
  return bound.value
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
    const record = declarationRecord(observation, pin)
    if (record === null) continue
    const raw = selectedRecordValue(record, selector)
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

function verdictRows(
  selected: SelectedDeliveryReview,
  observation: UwCompletionObservation,
  spec: SpecEffective,
  diagnostics: Diagnostic[],
): UwDeliveryVerdict[] {
  const rows: UwDeliveryVerdict[] = []
  const { repository, head } = selected.inputs.manifest.code
  const code = { repository, commit: head }
  const { declarations, evidence, verdicts, verdictSources } = selected.facts
  const input = { spec, code, declarations, evidence }
  const rowDiagnostics: Diagnostic[] = []
  for (const value of verdicts) {
    // Review inspection already retains these diagnostics; never project the rejected claim.
    if (criterionVerdictCitationDiagnostics(value, observation.histories, selected.inputs).length !== 0) continue
    const source = verdictSources?.get(value)
    const requiresChanges = criterionVerdictRequiresChanges(input, value, rowDiagnostics)
    if (source === undefined || rowDiagnostics.length !== 0 || (value.verdict === 'satisfied' && requiresChanges)) {
      rowDiagnostics.length = 0
      diagnostics.push(
        diagnostic(
          'delivery-verdict-unauthenticated',
          `Criterion ${value.target.id} verdict could not be authenticated`,
        ),
      )
      continue
    }
    rows.push({
      value,
      code,
      source: {
        source: 'record',
        record: { scope: selected.history.source.scope, recordId: source.contributionId, kind: 'contribution' },
        selector: source.selector,
        digest: source.digest,
      },
    })
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
      verdicts: verdictRows(selected.value, observation, effective.value, diagnostics),
      diagnostics,
    },
  }
}

import { canonicalValueDigest, validateActionInputs } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import { discoverCauseDispositionHeads } from './cause-heads.ts'
import { causeDispositionLineage } from './cause-lineage.ts'
import { validateCauseDispositionRecords } from './cause-record-validation.ts'
import { observationRefDiagnostics } from './delivery-observation-authentication.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { sameOwnSpecRef } from './spec-effective.ts'
import type { OwnSpecRef } from './uw-spec-schema.ts'
import { bindExternalRef, recordsOf } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Decision = Extract<CanonicalRecord, { kind: 'decision' }>
type Selection = ActionInputs['manifest']['deliveryData']
type Member = { disposition: Disposition; adjudication: Extract<CanonicalRecord, { kind: 'cause-operation' }> | null }
type Context = {
  decision: Decision
  own: OwnSpecRef
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
  selected: Selection
  pins: Selection
  historical: boolean
  validations: Map<DecodedHistory, readonly Diagnostic[]>
}

function validateMemberPin(member: Member, context: Context): Result<readonly string[]> {
  const memberPin = context.pins.find(
    (item) =>
      item.record.recordId === member.disposition.recordId &&
      equalScope(item.record.scope, member.disposition.payload.origin.uw),
  )
  if (!memberPin)
    return {
      ok: false,
      diagnostics: [diagnostic('cause-adjudication-unconfirmed', 'Review must pin the complete disposition lineage')],
    }
  const errors = observationRefDiagnostics('effective-finding-veto', memberPin, context.histories, [])
  if (errors.length) return { ok: false, diagnostics: errors }
  if (member.adjudication === null) return { ok: true, value: [] }
  const operationRef = member.disposition.payload.adjudication
  if (operationRef === null)
    return { ok: false, diagnostics: [diagnostic('cause-chain-invalid', 'Lineage operation reference is missing')] }
  const operationPin = context.selected.find(
    (item) => item.selector === '/payload' && sameRef(item.record, operationRef),
  )
  if (!operationPin)
    return {
      ok: false,
      diagnostics: [diagnostic('cause-adjudication-unconfirmed', 'Review must pin every lineage adjudication')],
    }
  const operationErrors = observationRefDiagnostics('effective-finding-veto', operationPin, context.histories, [])
  if (operationErrors.length) return { ok: false, diagnostics: operationErrors }
  const proposal = member.adjudication.payload.proposal
  if (proposal.operation !== 'adjudicate-cause')
    return { ok: false, diagnostics: [diagnostic('cause-chain-invalid', 'Lineage operation is not an adjudication')] }
  return { ok: true, value: proposal.rejectedFindingIds }
}

function lineageRejected(disposition: Disposition, history: DecodedHistory, context: Context): Result<Set<string>> {
  const lineage = causeDispositionLineage({ head: disposition, history })
  if (!lineage.ok) return lineage
  const rejected = new Set<string>()
  for (const member of lineage.value) {
    const result = validateMemberPin(member, context)
    if (!result.ok) return result
    for (const id of result.value) rejected.add(id)
  }
  return { ok: true, value: rejected }
}

function collectMatches(
  disposition: Disposition,
  rejectedIds: ReadonlySet<string>,
  context: Context,
): Result<readonly string[]> {
  const subject = disposition.payload.subject
  if (
    subject.kind !== 'cause' ||
    !equalScope(subject.decision.scope, context.decision) ||
    subject.decision.recordId === context.decision.recordId
  )
    return { ok: true, value: [] }
  const sourceHistory = context.histories.find((history) => equalScope(history.source.scope, subject.decision.scope))
  const source = sourceHistory && bindExternalRef(subject.decision, sourceHistory)
  if (!sourceHistory || !source?.ok || source.value.kind !== 'decision')
    return { ok: false, diagnostics: [diagnostic('cause-source-unconfirmed', 'Original decision is unavailable')] }
  const shared = new Set(
    source.value.payload.judgment.sourceContributionIds.filter((id) =>
      context.decision.payload.judgment.sourceContributionIds.includes(id),
    ),
  )
  const sharedOriginals = new Set(
    recordsOf(sourceHistory).flatMap((record) =>
      record.kind === 'contribution' && shared.has(record.recordId)
        ? (record.payload.findings ?? []).map((finding) => finding.id)
        : [],
    ),
  )
  const rejected = new Set<string>()
  for (const prior of subject.findings) {
    if (!rejectedIds.has(prior.id) || prior.sourceFindingIds.some((id) => !sharedOriginals.has(id))) continue
    for (const current of context.decision.payload.judgment.findings) {
      if (
        canonicalValueDigest([...current.sourceFindingIds].sort()) ===
          canonicalValueDigest([...prior.sourceFindingIds].sort()) &&
        canonicalValueDigest(current.target) === canonicalValueDigest(prior.target)
      )
        rejected.add(current.id)
    }
  }
  return { ok: true, value: [...rejected] }
}

function historicalPin(disposition: Disposition, history: DecodedHistory, context: Context): Result<readonly string[]> {
  const heads = discoverCauseDispositionHeads({ uw: disposition.payload.origin.uw, histories: context.histories })
  if (!heads.ok) return heads
  for (const head of heads.value) {
    if (!sameOwnSpecRef(head.payload.origin, disposition.payload.origin)) continue
    const lineage = causeDispositionLineage({ head, history })
    if (!lineage.ok) return lineage
    if (!lineage.value.some((member) => member.disposition.recordId === disposition.recordId)) continue
    if (head.payload.outcome.state !== 'final' || head.payload.outcome.disposition !== 'report') break
    const authenticated = lineageRejected(head, history, context)
    return authenticated.ok ? { ok: true, value: [] } : authenticated
  }
  return {
    ok: false,
    diagnostics: [diagnostic('cause-origin-mismatch', 'Selected disposition belongs to another accepted Spec')],
  }
}

function evaluatePin(pin: Selection[number], context: Context): Result<readonly string[]> {
  const pinErrors = observationRefDiagnostics('effective-finding-veto', pin, context.histories, [])
  if (pinErrors.length) return { ok: false, diagnostics: pinErrors }
  const history = context.histories.find((entry) => equalScope(entry.source.scope, pin.record.scope))
  const bound = history && bindExternalRef(pin.record, history)
  if (!history || !bound?.ok || bound.value.kind !== 'cause-disposition')
    return {
      ok: false,
      diagnostics: [diagnostic('cause-adjudication-unconfirmed', 'Selected disposition is not authenticated')],
    }
  let validation = context.validations.get(history)
  if (validation === undefined) {
    validation = validateCauseDispositionRecords({
      records: recordsOf(history),
      histories: context.histories,
      catalogues: context.catalogues,
    })
    context.validations.set(history, validation)
  }
  if (validation.length) return { ok: false, diagnostics: [...validation] }
  const disposition = bound.value
  if (!sameOwnSpecRef(disposition.payload.origin, context.own)) return historicalPin(disposition, history, context)
  if (disposition.payload.subject.kind !== 'cause' || disposition.payload.adjudication === null)
    return { ok: true, value: [] }
  if (!context.historical) {
    const heads = discoverCauseDispositionHeads({ uw: disposition.payload.origin.uw, histories: context.histories })
    if (!heads.ok) return heads
    if (!heads.value.some((head) => head.recordId === disposition.recordId)) return { ok: true, value: [] }
  }
  const rejected = lineageRejected(disposition, history, context)
  if (!rejected.ok) return rejected
  return collectMatches(disposition, rejected.value, context)
}

type EffectiveFindingInput = {
  decision: Decision
  action: ActionInputs
  histories: readonly DecodedHistory[]
  catalogues: ReviewClassCatalogues
}

function selectedRejectedFindingIds(input: EffectiveFindingInput, historical: boolean): Result<readonly string[]> {
  if (
    !validateActionInputs(input.action).ok ||
    input.action.manifest.purpose !== 'review' ||
    input.action.manifest.spec.kind !== 'accepted'
  )
    return {
      ok: false,
      diagnostics: [diagnostic('cause-context-unbound', 'A fresh accepted-Spec review action is required')],
    }
  const selected = input.action.manifest.deliveryData.filter((item) => item.role === 'cause-state')
  const pins = selected.filter((item) => item.record.kind === 'cause-disposition' && item.selector === '/payload')
  const context: Context = {
    decision: input.decision,
    own: input.action.manifest.spec.effective.own,
    histories: input.histories,
    catalogues: input.catalogues,
    selected,
    pins,
    historical,
    validations: new Map(),
  }
  const rejected = new Set<string>()
  for (const pin of pins) {
    const result = evaluatePin(pin, context)
    if (!result.ok) return result
    for (const id of result.value) rejected.add(id)
  }
  return { ok: true, value: [...rejected] }
}

export function effectiveRejectedFindingIds(input: EffectiveFindingInput): Result<readonly string[]> {
  return selectedRejectedFindingIds(input, false)
}

export function historicalRejectedFindingIds(input: EffectiveFindingInput): Result<readonly string[]> {
  return selectedRejectedFindingIds(input, true)
}

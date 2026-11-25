import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs, PinnedFileRef } from './action-input-schema.ts'
import { evidenceDigest } from './criterion-admission.ts'
import { appendCorrectionSelection } from './criterion-correction-selection.ts'
import { type CriterionSourceSelection, projectAdditiveDeclarations } from './criterion-declaration-projection.ts'
import {
  type CriterionDeclaration,
  type CriterionEvidence,
  criterionDeclarationSchema,
} from './criterion-evidence-schema.ts'
import {
  currentPlanReceipt,
  implementationReceiptEligible,
  integrationReceiptEligible,
  observationAuthenticationDiagnostics,
  planReceiptEligible,
  planReviewReceiptEligible,
} from './delivery-eligibility.ts'
import { selectedRecordValue } from './historical-action-inputs.ts'
import { authenticateHistoricalReceiptStart } from './historical-receipt-pair.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { ReviewClassCatalogues } from './review-class-catalogue.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { resolveManifestMandate } from './workflow-pr-binding.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>
type DeliveryRef = ActionInputs['manifest']['deliveryData'][number]
type CriterionSelection = CriterionSourceSelection & { declarations: CriterionDeclaration[] }

function receiptEligible(record: Receipt): boolean {
  if (record.payload.action === 'plan') return planReceiptEligible(record) && record.payload.phase === 'result'
  if (record.payload.action === 'plan-review') return planReviewReceiptEligible(record)
  return implementationReceiptEligible(record) || integrationReceiptEligible(record)
}

function receiptFor(
  histories: readonly DecodedHistory[],
  ref: ExternalRecordRef,
): { receipt: Receipt | null; code: string } {
  const history = historyFor(ref.scope, histories)
  if (history === null) return { receipt: null, code: 'missing-history' }
  const bound = bindExternalRef(ref, history)
  if (!bound.ok) return { receipt: null, code: bound.diagnostics[0]?.code ?? 'unconfirmed' }
  if (bound.value.kind !== 'action-receipt' || !receiptEligible(bound.value))
    return { receipt: null, code: 'unconfirmed' }
  return { receipt: bound.value, code: 'unconfirmed' }
}

function manifestPins(inputs: ActionInputs): PinnedFileRef[] {
  return [
    ...inputs.manifest.repositoryReferences,
    ...inputs.manifest.plugin.files,
    ...inputs.manifest.expandedContext.flatMap((ref) => (ref.source === 'git-file' ? [ref] : [])),
  ]
}

function admittedImplementation(
  receipt: Receipt,
  head: string,
  planActionId: string,
  mandate: ExternalRecordRef,
): boolean {
  const payload = receipt.payload
  if (
    (payload.action !== 'implement' && payload.action !== 'integrate') ||
    payload.phase !== 'result' ||
    !('planActionId' in payload.exactInputs)
  )
    return false
  if (
    !sameRef(payload.mandate, mandate) ||
    !('mandateId' in payload.exactInputs) ||
    payload.exactInputs.mandateId !== mandate.recordId
  )
    return false
  if (!implementationReceiptEligible(receipt) && !integrationReceiptEligible(receipt)) return false
  if (payload.admission?.remoteTip !== head) return false
  return payload.exactInputs.planActionId === planActionId
}

function appendOneEvidence(
  value: CriterionEvidence,
  ref: DeliveryRef,
  head: string,
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
  receipt: Receipt,
  diagnostics: Diagnostic[],
  evidence: CriterionSourceSelection['evidence'],
): void {
  if (value.code.commit !== head) {
    diagnostics.push(diagnostic('mismatch', `Evidence ${value.id} is not the admitted current head`))
    return
  }
  const problems = observationAuthenticationDiagnostics(value, histories, pins, receipt)
  if (problems.length !== 0) {
    diagnostics.push(...problems)
    return
  }
  evidence.push({ ref: { receipt: ref.record, evidenceId: value.id, digest: evidenceDigest(value) }, value })
}

function appendImplementation(
  ref: DeliveryRef,
  receipt: Receipt,
  history: DecodedHistory,
  head: string,
  planActionId: string,
  mandate: ExternalRecordRef,
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
  diagnostics: Diagnostic[],
  selected: CriterionSourceSelection,
): void {
  if (!admittedImplementation(receipt, head, planActionId, mandate)) {
    diagnostics.push(
      diagnostic('unconfirmed', `Delivery record ${ref.record.recordId} is not the admitted current head`),
    )
    return
  }
  const authenticated = authenticateHistoricalReceiptStart(history, receipt, histories)
  if (!authenticated.ok) {
    diagnostics.push(...authenticated.diagnostics)
    return
  }
  const raw = selectedRecordValue(receipt, ref.selector)
  if (raw === undefined || canonicalValueDigest(raw) !== ref.digest) {
    diagnostics.push(
      diagnostic('mismatch', `Delivery selector ${ref.selector} does not match its authenticated digest`),
    )
    return
  }
  const declaration = criterionDeclarationSchema.safeParse(raw)
  if (!declaration.success) return
  const { role: _role, ...source } = ref
  selected.declarationFacts.push({ value: declaration.data, receipt: source })
  if (declaration.data.verification !== 'evidence') return
  for (const value of declaration.data.evidence) {
    appendOneEvidence(value, ref, head, histories, pins, receipt, diagnostics, selected.evidence)
  }
}

function refuseUnbound(ref: DeliveryRef, code: string, diagnostics: Diagnostic[]): void {
  diagnostics.push(diagnostic(code, `Delivery record ${ref.record.recordId} is not an authenticated action receipt`))
}

function appendPlanReview(
  history: DecodedHistory,
  receipt: Receipt,
  current: Receipt,
  histories: readonly DecodedHistory[],
  diagnostics: Diagnostic[],
): void {
  const review = receipt.payload
  const plan = current.payload
  if (
    review.action !== 'plan-review' ||
    review.phase !== 'result' ||
    plan.action !== 'plan' ||
    plan.phase !== 'result' ||
    !sameRef(review.mandate, plan.mandate) ||
    review.exactInputs.specDigest !== plan.exactInputs.specDigest ||
    (plan.exactInputs.amendsReviewActionId === null
      ? review.exactInputs.draftActionId !== plan.actionId
      : review.actionId !== plan.exactInputs.amendsReviewActionId)
  ) {
    diagnostics.push(diagnostic('mismatch', `Delivery record ${receipt.recordId} does not review the current plan`))
    return
  }
  const start = authenticateHistoricalReceiptStart(history, receipt, histories)
  if (!start.ok) diagnostics.push(...start.diagnostics)
}

function appendDelivery(
  ref: DeliveryRef,
  histories: readonly DecodedHistory[],
  current: Receipt,
  head: string,
  planActionId: string,
  mandate: ExternalRecordRef,
  pins: readonly PinnedFileRef[],
  diagnostics: Diagnostic[],
  selected: CriterionSourceSelection,
): void {
  const history = historyFor(ref.record.scope, histories)
  const bound = receiptFor(histories, ref.record)
  if (bound.receipt === null || history === null) {
    refuseUnbound(ref, bound.code, diagnostics)
    return
  }
  if (ref.role === 'plan-review') {
    appendPlanReview(history, bound.receipt, current, histories, diagnostics)
    return
  }
  if (ref.role === 'plan') {
    if (!equalScope(ref.record.scope, current) || ref.record.recordId !== current.recordId) {
      diagnostics.push(diagnostic('mismatch', `Delivery record ${ref.record.recordId} is not the current plan`))
    }
    return
  }
  if (ref.role !== 'implementation' && ref.role !== 'criterion-evidence') return
  appendImplementation(ref, bound.receipt, history, head, planActionId, mandate, histories, pins, diagnostics, selected)
}

function currentPlan(
  histories: readonly DecodedHistory[],
  version: string,
  mandate: ExternalRecordRef,
  diagnostics: Diagnostic[],
): Receipt | null {
  const current = currentPlanReceipt(histories, version, mandate, diagnostics)
  if (!current.ok) {
    diagnostics.push(...current.diagnostics)
    return null
  }
  if (current.value === null) {
    diagnostics.push(diagnostic('ambiguous', 'No unique current plan is bound to the accepted Spec'))
    return null
  }
  if (current.value.payload.action !== 'plan' || current.value.payload.phase !== 'result') return null
  return current.value
}

export function selectedDeclarations(
  histories: readonly DecodedHistory[],
  inputs: ActionInputs,
  diagnostics: Diagnostic[],
  catalogues: ReviewClassCatalogues,
): CriterionSelection {
  const selected: CriterionSelection = { declarations: [], declarationFacts: [], evidence: [] }
  if (inputs.manifest.spec.kind !== 'accepted') return selected
  const owner = resolveManifestMandate(inputs, histories)
  if (!owner.ok) {
    diagnostics.push(...owner.diagnostics)
    return selected
  }
  const mandate: ExternalRecordRef = {
    scope: { repository: owner.value.repository, target: owner.value.target },
    recordId: owner.value.recordId,
    kind: 'mandate',
  }
  const current = currentPlan(histories, inputs.manifest.spec.effective.own.version, mandate, diagnostics)
  if (current === null || current.payload.action !== 'plan') return selected
  const pins = manifestPins(inputs)
  const ownSpec = inputs.manifest.spec.effective.own
  for (const ref of inputs.manifest.deliveryData) {
    if (ref.role === 'correction-lineage' || ref.role === 'cause-state') continue
    if (ref.record.kind === 'fix-result') {
      appendCorrectionSelection(
        ref,
        histories,
        inputs,
        current.payload.actionId,
        mandate,
        ownSpec,
        pins,
        diagnostics,
        selected,
        catalogues,
      )
      continue
    }
    appendDelivery(
      ref,
      histories,
      current,
      inputs.manifest.code.head,
      current.payload.actionId,
      mandate,
      pins,
      diagnostics,
      selected,
    )
  }
  selected.declarations = projectAdditiveDeclarations(selected.declarationFacts.map(({ value }) => value))
  return selected
}

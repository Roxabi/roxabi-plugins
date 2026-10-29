import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs, PinnedFileRef } from './action-input-schema.ts'
import { evidenceDigest } from './criterion-admission.ts'
import { appendCorrectionSelection } from './criterion-correction-selection.ts'
import { projectAdditiveDeclarations } from './criterion-declaration-projection.ts'
import {
  type CriterionDeclaration,
  type CriterionEvidence,
  criterionDeclarationSchema,
  type EvidenceRef,
} from './criterion-evidence-schema.ts'
import {
  currentPlanReceipt,
  implementationReceiptEligible,
  implementationStartPaired,
  observationAuthenticationDiagnostics,
  planReceiptEligible,
} from './delivery-eligibility.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, sameRef } from './record-diagnostics.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { bindExternalRef, historyFor } from './workflow-control.ts'
import { implementationOutputSchema } from './workflow-output-schema.ts'
import { resolveManifestMandate } from './workflow-pr-binding.ts'

type Receipt = Extract<CanonicalRecord, { kind: 'action-receipt' }>
type DeliveryRef = ActionInputs['manifest']['deliveryData'][number]
type SelectedEvidence = { ref: EvidenceRef; value: CriterionEvidence }[]

function pointer(value: unknown, selector: string): unknown {
  if (selector === '') return value
  let current = value
  for (const raw of selector.slice(1).split('/')) {
    const key = raw.replaceAll('~1', '/').replaceAll('~0', '~')
    if (Array.isArray(current)) {
      current = current[Number(key)]
      continue
    }
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, key)) return undefined
    current = Object.getOwnPropertyDescriptor(current, key)?.value
  }
  return current
}

function receiptEligible(record: Receipt): boolean {
  if (record.payload.action === 'plan') return planReceiptEligible(record) && record.payload.phase === 'result'
  return implementationReceiptEligible(record)
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

function declarationsAt(value: unknown): CriterionDeclaration[] {
  const output = implementationOutputSchema.safeParse(value)
  if (output.success) return [...output.data.criteria]
  const many = criterionDeclarationSchema.array().safeParse(value)
  if (many.success) return many.data
  const one = criterionDeclarationSchema.safeParse(value)
  return one.success ? [one.data] : []
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
  history: DecodedHistory,
  head: string,
  planActionId: string,
  mandate: ExternalRecordRef,
): boolean {
  const payload = receipt.payload
  if (payload.action !== 'implement' || payload.phase !== 'result' || !('planActionId' in payload.exactInputs))
    return false
  if (
    !sameRef(payload.mandate, mandate) ||
    !('mandateId' in payload.exactInputs) ||
    payload.exactInputs.mandateId !== mandate.recordId
  )
    return false
  if (!implementationReceiptEligible(receipt) || !implementationStartPaired(history, receipt)) return false
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
  evidence: SelectedEvidence,
): void {
  if (value.code.commit !== head) {
    diagnostics.push(diagnostic('mismatch', `Evidence ${value.id} is not the admitted current head`))
    return
  }
  diagnostics.push(...observationAuthenticationDiagnostics(value, histories, pins, receipt))
  evidence.push({ ref: { receipt: ref.record, evidenceId: value.id, digest: evidenceDigest(value) }, value })
}

function appendEvidence(
  declaration: CriterionDeclaration,
  receipt: Receipt,
  ref: DeliveryRef,
  head: string,
  histories: readonly DecodedHistory[],
  pins: readonly PinnedFileRef[],
  diagnostics: Diagnostic[],
  evidence: SelectedEvidence,
): void {
  if (declaration.verification !== 'evidence') return
  const payload = receipt.payload
  if (payload.action !== 'implement' || payload.phase !== 'result') return
  for (const value of declaration.evidence) {
    appendOneEvidence(value, ref, head, histories, pins, receipt, diagnostics, evidence)
  }
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
  declarations: CriterionDeclaration[],
  evidence: SelectedEvidence,
): void {
  if (!admittedImplementation(receipt, history, head, planActionId, mandate)) {
    diagnostics.push(
      diagnostic('unconfirmed', `Delivery record ${ref.record.recordId} is not the admitted current head`),
    )
    return
  }
  const selected = pointer(receipt, ref.selector)
  if (selected === undefined || canonicalValueDigest(selected) !== ref.digest) {
    diagnostics.push(
      diagnostic('mismatch', `Delivery selector ${ref.selector} does not match its authenticated digest`),
    )
    return
  }
  for (const declaration of declarationsAt(selected)) {
    declarations.push(declaration)
    appendEvidence(declaration, receipt, ref, head, histories, pins, diagnostics, evidence)
  }
}

function refuseUnbound(ref: DeliveryRef, code: string, diagnostics: Diagnostic[]): void {
  diagnostics.push(diagnostic(code, `Delivery record ${ref.record.recordId} is not an authenticated action receipt`))
}

function appendDelivery(
  ref: DeliveryRef,
  histories: readonly DecodedHistory[],
  currentRecordId: string,
  head: string,
  planActionId: string,
  mandate: ExternalRecordRef,
  pins: readonly PinnedFileRef[],
  diagnostics: Diagnostic[],
  declarations: CriterionDeclaration[],
  evidence: SelectedEvidence,
): void {
  const history = historyFor(ref.record.scope, histories)
  const bound = receiptFor(histories, ref.record)
  if (bound.receipt === null || history === null) {
    refuseUnbound(ref, bound.code, diagnostics)
    return
  }
  if (ref.role === 'plan' || ref.role === 'plan-review') {
    if (ref.record.recordId !== currentRecordId) {
      diagnostics.push(diagnostic('mismatch', `Delivery record ${ref.record.recordId} is not the current plan`))
    }
    return
  }
  if (ref.role !== 'implementation' && ref.role !== 'criterion-evidence') return
  appendImplementation(
    ref,
    bound.receipt,
    history,
    head,
    planActionId,
    mandate,
    histories,
    pins,
    diagnostics,
    declarations,
    evidence,
  )
}

function currentPlan(
  histories: readonly DecodedHistory[],
  version: string,
  mandate: ExternalRecordRef,
  diagnostics: Diagnostic[],
): Receipt | null {
  const current = currentPlanReceipt(histories, version, mandate)
  if (!current.ok || current.value === null) {
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
): { declarations: CriterionDeclaration[]; evidence: SelectedEvidence } {
  const declarations: CriterionDeclaration[] = []
  const evidence: SelectedEvidence = []
  if (inputs.manifest.spec.kind !== 'accepted') return { declarations, evidence }
  const owner = resolveManifestMandate(inputs, histories)
  if (!owner.ok) {
    diagnostics.push(...owner.diagnostics)
    return { declarations, evidence }
  }
  const mandate: ExternalRecordRef = {
    scope: { repository: owner.value.repository, target: owner.value.target },
    recordId: owner.value.recordId,
    kind: 'mandate',
  }
  const current = currentPlan(histories, inputs.manifest.spec.effective.own.version, mandate, diagnostics)
  if (current === null || current.payload.action !== 'plan') return { declarations, evidence }
  const pins = manifestPins(inputs)
  const ownSpec = inputs.manifest.spec.effective.own
  for (const ref of inputs.manifest.deliveryData) {
    if (ref.role === 'correction-lineage') continue
    if (ref.record.kind === 'fix-result') {
      appendCorrectionSelection(ref, histories, inputs, current.payload.actionId, mandate, ownSpec, pins, diagnostics, {
        declarations,
        evidence,
      })
      continue
    }
    appendDelivery(
      ref,
      histories,
      current.recordId,
      inputs.manifest.code.head,
      current.payload.actionId,
      mandate,
      pins,
      diagnostics,
      declarations,
      evidence,
    )
  }
  return { declarations: projectAdditiveDeclarations(declarations), evidence }
}

import { canonicalValueDigest } from './action-input.ts'
import type { ActionInputs } from './action-input-schema.ts'
import type { ExternalRecordRef } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { CauseJudgment } from './review-schema.ts'
import { integrationOutputSchema } from './uw-integration-schema.ts'
import { scopedRefsOf } from './workflow-record-references.ts'

type AddRef = (ref: ExternalRecordRef) => void

function addJudgment(judgment: CauseJudgment, add: AddRef): void {
  for (const dimension of [judgment.necessary, judgment.urgent, judgment.tooLarge]) {
    for (const ref of dimension.references) {
      if (ref.source === 'record') add(ref.record)
    }
  }
}

function addInputs(inputs: ActionInputs, add: AddRef): void {
  for (const ref of [...inputs.manifest.acceptedSources, ...inputs.manifest.deliveryData, ...inputs.stageSources])
    add(ref.record)
  for (const ref of inputs.manifest.expandedContext) {
    if (ref.source === 'record') add(ref.record)
  }
  if (inputs.manifest.subject.kind === 'uw' && inputs.manifest.subject.binding)
    add(inputs.manifest.subject.binding.record)
  if (inputs.manifest.spec.kind === 'accepted')
    for (const ref of inputs.manifest.spec.effective.versionVector) add(ref.sourceAccepted)
}

function addRecordReferences(record: CanonicalRecord, add: AddRef): void {
  for (const ref of scopedRefsOf(record)) add(ref)
  if (record.kind === 'cause-disposition' && record.payload.subject.kind === 'cause')
    addJudgment(record.payload.subject.cause.judgment, add)
  if (record.kind === 'cause-operation') addOperationReferences(record, add)
  if (record.kind === 'decision') {
    for (const cause of record.payload.judgment.causes) addJudgment(cause.judgment, add)
  }
  if (record.kind === 'action-receipt') addReceiptReferences(record, add)
  if (record.kind === 'review-attempt') addInventoryInputs(record, add)
}

function addReceiptReferences(record: Extract<CanonicalRecord, { kind: 'action-receipt' }>, add: AddRef): void {
  addInputs(record.payload.inputs, add)
  if (record.payload.phase !== 'result') return
  const integration = integrationOutputSchema.safeParse(record.payload.structured)
  if (!integration.success) return
  for (const child of integration.data.children) {
    add(child.spec.sourceAccepted)
    for (const ref of child.sources) add(ref)
  }
}

function addOperationReferences(record: Extract<CanonicalRecord, { kind: 'cause-operation' }>, add: AddRef): void {
  const proposal = record.payload.proposal
  if (proposal.operation !== 'adjudicate-cause') return
  for (const ref of proposal.references) {
    if (ref.source === 'record') add(ref.record)
  }
  if (proposal.judgment !== null) addJudgment(proposal.judgment, add)
}

function addInventoryInputs(record: Extract<CanonicalRecord, { kind: 'review-attempt' }>, add: AddRef): void {
  for (const slot of record.payload.slots) {
    if (slot.action) addInputs(slot.action.inputs, add)
  }
  if ('inputSnapshot' in record.payload && record.payload.inputSnapshot) addInputs(record.payload.inputSnapshot, add)
}

export function causeHistoryReferences(records: readonly CanonicalRecord[]): ExternalRecordRef[] {
  const found = new Map<string, ExternalRecordRef>()
  const add = (ref: ExternalRecordRef) => {
    found.set(canonicalValueDigest(ref), ref)
  }
  for (const record of records) addRecordReferences(record, add)
  return [...found.values()]
}

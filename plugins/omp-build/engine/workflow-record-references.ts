import { diagnostic, equalScope } from './record-diagnostics.ts'
import { type ExternalRecordRef, isWorkflowKind } from './record-references.ts'
import type { CanonicalRecord, Kind } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'

type SpecIdentityPayload = Extract<CanonicalRecord, { kind: 'spec-identity' }>['payload']
type MandatePayload = Extract<CanonicalRecord, { kind: 'mandate' }>['payload']
type OperatorControlPayload = Extract<CanonicalRecord, { kind: 'operator-control' }>['payload']
type ActionReceiptPayload = Extract<CanonicalRecord, { kind: 'action-receipt' }>['payload']
type WorkflowBindingPayload = Extract<CanonicalRecord, { kind: 'workflow-binding' }>['payload']
type ReviewInterruptionPayload = Extract<CanonicalRecord, { kind: 'review-interruption' }>['payload']
type ReviewReplacementGrantPayload = Extract<CanonicalRecord, { kind: 'review-replacement-grant' }>['payload']

export function scopedRefsOf(record: { kind: Kind; payload: unknown }): ExternalRecordRef[] {
  switch (record.kind) {
    case 'spec-identity': {
      const payload = record.payload as SpecIdentityPayload
      return payload.predecessor === null ? [] : [payload.predecessor]
    }
    case 'mandate': {
      const payload = record.payload as MandatePayload
      return [payload.parent, payload.antecedent, ...payload.ownSpec.identityAllocations].filter(
        (ref): ref is ExternalRecordRef => ref !== null,
      )
    }
    case 'operator-control': {
      const payload = record.payload as OperatorControlPayload
      const refs: Array<ExternalRecordRef | null> = [payload.mandate, payload.predecessor]
      if (payload.control === 'accept-material') refs.push(payload.assessment)
      if (payload.control === 'select-successor') refs.push(payload.successor)
      return refs.filter((ref): ref is ExternalRecordRef => ref !== null)
    }
    case 'action-receipt': {
      const payload = record.payload as ActionReceiptPayload
      const refs: ExternalRecordRef[] = [payload.mandate]
      if (payload.phase === 'result') refs.push(payload.start)
      if (payload.action === 'assess-spec') {
        refs.push(payload.exactInputs.accepted.ref.sourceAccepted, ...payload.exactInputs.identityAllocations)
      }
      return refs
    }
    case 'workflow-binding':
      return [(record.payload as WorkflowBindingPayload).mandate]
    case 'review-interruption':
      return [(record.payload as ReviewInterruptionPayload).historicalBinding]
    case 'review-replacement-grant':
      return [(record.payload as ReviewReplacementGrantPayload).binding]
    default:
      return []
  }
}

export function partitionScopedRefs(record: Pick<CanonicalRecord, 'kind' | 'payload' | 'repository' | 'target'>): {
  sameScope: ExternalRecordRef[]
  external: ExternalRecordRef[]
} {
  const scope = { repository: record.repository, target: record.target }
  const refs = scopedRefsOf(record)
  return {
    sameScope: refs.filter((ref) => equalScope(ref.scope, scope)),
    external: refs.filter((ref) => !equalScope(ref.scope, scope)),
  }
}

export function workflowInputMeaning(record: CanonicalRecord): Diagnostic | null {
  if (!isWorkflowKind(record.kind)) return null
  const { sameScope, external } = partitionScopedRefs(record)
  for (const ref of sameScope) {
    if (!record.inputs.includes(ref.recordId))
      return diagnostic('unbound', `Same-scope reference ${ref.recordId} is missing from inputs`)
  }
  for (const ref of external) {
    if (record.inputs.includes(ref.recordId) || sameScope.some((item) => item.recordId === ref.recordId))
      return diagnostic('ambiguous', `External reference ${ref.recordId} must not be an input`)
  }
  return null
}

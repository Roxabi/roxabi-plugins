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

type CauseDispositionPayload = Extract<CanonicalRecord, { kind: 'cause-disposition' }>['payload']
type CauseOperationPayload = Extract<CanonicalRecord, { kind: 'cause-operation' }>['payload']

function causeDispositionRefs(payload: CauseDispositionPayload): ExternalRecordRef[] {
  const subject = payload.subject
  return [
    payload.origin.sourceAccepted,
    ...payload.basis.versionVector.map((ref) => ref.sourceAccepted),
    payload.basis.capture?.record ?? null,
    payload.previous,
    payload.adjudication,
    subject.kind === 'cause'
      ? subject.decision
      : subject.kind === 'retained-finding'
        ? subject.contribution
        : subject.source,
  ].filter((ref): ref is ExternalRecordRef => ref !== null)
}

function causeOperationRefs(payload: CauseOperationPayload): ExternalRecordRef[] {
  const proposal = payload.proposal
  return [
    proposal.operation === 'adjudicate-cause'
      ? proposal.pending
      : proposal.creation.kind === 'sister'
        ? proposal.creation.disposition
        : proposal.creation.report,
  ]
}

function operatorControlRefs(payload: OperatorControlPayload): ExternalRecordRef[] {
  const refs: Array<ExternalRecordRef | null> =
    payload.control === 'adjust-cause-dependency'
      ? [
          payload.proposal.mandate,
          payload.proposal.predecessor,
          payload.proposal.disposition,
          payload.proposal.receipt,
          payload.proposal.accepted.sourceAccepted,
          ...payload.proposal.versionVector.map((ref) => ref.sourceAccepted),
        ]
      : [payload.mandate, payload.predecessor]
  if (payload.control === 'accept-material') {
    refs.push(payload.assessment)
    if (payload.authorization.kind === 'cause-creation')
      refs.push(payload.authorization.operation, payload.authorization.binding.identity)
  }
  if (payload.control === 'select-successor') refs.push(payload.successor)
  if (payload.control === 'resolve-interruption') refs.push(payload.start, payload.result)
  if (payload.control === 'adjust-cause-dependency') {
    for (const reference of payload.proposal.references) if (reference.source === 'record') refs.push(reference.record)
  }
  return refs.filter((ref): ref is ExternalRecordRef => ref !== null)
}

function actionReceiptRefs(payload: ActionReceiptPayload): ExternalRecordRef[] {
  const refs: ExternalRecordRef[] = payload.mandate.kind === 'absent' ? [] : [payload.mandate]
  if (payload.phase === 'result') refs.push(payload.start)
  if (payload.action === 'assess-spec') {
    refs.push(payload.exactInputs.accepted.ref.sourceAccepted, ...payload.exactInputs.identityAllocations)
    refs.push(...payload.exactInputs.accepted.inheritedOwnSpecRefs.map((ref) => ref.sourceAccepted))
    refs.push(...payload.exactInputs.proposed.inheritedOwnSpecRefs.map((ref) => ref.sourceAccepted))
    refs.push(
      ...payload.exactInputs.childOwnSources.flatMap((entry) => (entry.own === null ? [] : [entry.own.sourceAccepted])),
    )
    const operands = payload.inputs.manifest.operands
    if (operands?.action === 'assess-spec' && operands.origin.kind === 'cause-created-child')
      refs.push(
        operands.origin.creation.kind === 'sister'
          ? operands.origin.creation.disposition
          : operands.origin.creation.report,
      )
  }
  return refs
}

export function scopedRefsOf(record: { kind: Kind; payload: unknown }): ExternalRecordRef[] {
  switch (record.kind) {
    case 'review':
      return (record.payload as Extract<CanonicalRecord, { kind: 'review' }>['payload']).causeDispositionRefs ?? []
    case 'fix-request':
      return [
        (record.payload as Extract<CanonicalRecord, { kind: 'fix-request' }>['payload']).originalSpec.sourceAccepted,
      ]
    case 'correction-result':
      return [(record.payload as Extract<CanonicalRecord, { kind: 'correction-result' }>['payload']).causeDisposition]
    case 'fix-result':
      return (record.payload as Extract<CanonicalRecord, { kind: 'fix-result' }>['payload']).causeDispositionRefs
    case 'debt-receipt': {
      const p = record.payload as Extract<CanonicalRecord, { kind: 'debt-receipt' }>['payload']
      return [p.operation, p.disposition, p.decision, p.identity]
    }
    case 'cause-disposition':
      return causeDispositionRefs(record.payload as CauseDispositionPayload)
    case 'cause-operation':
      return causeOperationRefs(record.payload as CauseOperationPayload)
    case 'report-promotion': {
      const p = record.payload as Extract<CanonicalRecord, { kind: 'report-promotion' }>['payload']
      return [p.report, p.operation, p.identity]
    }
    case 'framing-receipt': {
      const payload = record.payload as Extract<CanonicalRecord, { kind: 'framing-receipt' }>['payload']
      if (payload.phase === 'intent')
        return payload.proposal.members.flatMap((member) => [
          ...member.inherited.map((own) => own.sourceAccepted),
          ...(member.allocation?.ledgerHead ? [member.allocation.ledgerHead] : []),
        ])
      if (payload.phase === 'member-binding') return [payload.intent]
      if (payload.phase === 'member-claim')
        return payload.binding === null ? [payload.intent] : [payload.intent, payload.binding]
      return [
        payload.intent,
        ...payload.claims,
        ...payload.bindings,
        ...payload.identities,
        ...payload.coverage.flatMap((coverage) =>
          coverage.ancestors.flatMap((ancestor) =>
            ancestor.kind === 'accepted' ? [ancestor.own.sourceAccepted, ancestor.metadata] : [],
          ),
        ),
      ]
    }
    case 'spec-identity': {
      const payload = record.payload as SpecIdentityPayload
      const refs = payload.predecessor === null ? [] : [payload.predecessor]
      if (payload.format === 'omp-build-spec-identity/2')
        refs.push(payload.aggregate.intent, payload.aggregate.claim, payload.aggregate.binding)
      return refs
    }
    case 'mandate': {
      const payload = record.payload as MandatePayload
      return [
        payload.parent,
        payload.antecedent,
        ...payload.ownSpec.identityAllocations,
        ...payload.inheritedOwnSpecRefs.map((ref) => ref.sourceAccepted),
      ].filter((ref): ref is ExternalRecordRef => ref !== null)
    }
    case 'operator-control':
      return operatorControlRefs(record.payload as OperatorControlPayload)
    case 'action-receipt':
      return actionReceiptRefs(record.payload as ActionReceiptPayload)
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
  if (
    !isWorkflowKind(record.kind) &&
    !['review', 'fix-request', 'correction-result', 'fix-result', 'debt-receipt'].includes(record.kind)
  )
    return null
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

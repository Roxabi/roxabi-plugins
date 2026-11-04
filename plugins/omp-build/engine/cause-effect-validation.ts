import { canonicalValueDigest } from './action-input.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { bindExternalRef } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Effect = Extract<CanonicalRecord, { kind: 'debt-receipt' | 'report-promotion' }>
type CauseOperation = Extract<CanonicalRecord, { kind: 'cause-operation' }>
type Identity = Extract<CanonicalRecord, { kind: 'spec-identity' }>
type Creation = Extract<CauseOperation['payload']['proposal'], { operation: 'create' }>

function matchingIdentity(operation: CauseOperation, identity: Identity): boolean {
  const op = operation.payload
  const proposal = op.proposal
  return (
    proposal.operation === 'create' &&
    identity.payload.event === 'allocate' &&
    identity.operationId === proposal.operationId &&
    identity.payload.proposalDigest === op.proposalDigest &&
    canonicalValueDigest(identity.payload.confirmation) === canonicalValueDigest(op.confirmation) &&
    canonicalValueDigest(identity.payload.allocations) === canonicalValueDigest(proposal.allocation.assignments)
  )
}

function sisterCreationMatches(record: Extract<Effect, { kind: 'debt-receipt' }>, proposal: Creation): boolean {
  const creation = proposal.creation
  return (
    creation.kind === 'sister' &&
    sameRef(creation.disposition, record.payload.disposition) &&
    equalScope(creation.original, record.payload.original) &&
    equalScope(record.payload.original, record) &&
    equalScope(record.payload.sister, record.payload.identity.scope) &&
    creation.relation === record.payload.relation &&
    canonicalValueDigest(creation.parent) === canonicalValueDigest(record.payload.parent)
  )
}

function sisterDispositionMatches(
  record: Extract<Effect, { kind: 'debt-receipt' }>,
  dispositions: readonly Disposition[],
): boolean {
  const disposition = dispositions.find(
    (item) =>
      item.recordId === record.payload.disposition.recordId && equalScope(item, record.payload.disposition.scope),
  )
  if (disposition?.payload.subject.kind !== 'cause' || disposition.payload.outcome.state !== 'final') return false
  const outcome = disposition.payload.outcome.disposition
  if (outcome !== 'sister-blocking' && outcome !== 'sister-after') return false
  return (
    sameRef(disposition.payload.subject.decision, record.payload.decision) &&
    disposition.payload.subject.cause.id === record.payload.causeId &&
    record.payload.relation ===
      (outcome === 'sister-blocking' ? 'original-blocked-by-sister' : 'sister-blocked-by-original')
  )
}

function reportCreationMatches(
  record: Extract<Effect, { kind: 'report-promotion' }>,
  proposal: Creation,
  dispositions: readonly Disposition[],
): boolean {
  const report = dispositions.find(
    (item) => item.recordId === record.payload.report.recordId && equalScope(item, record.payload.report.scope),
  )
  return (
    proposal.creation.kind === 'report-promotion' &&
    sameRef(proposal.creation.report, record.payload.report) &&
    equalScope(record.payload.created, record.payload.identity.scope) &&
    report?.payload.outcome.state === 'final' &&
    report.payload.outcome.disposition === 'report'
  )
}

function validateCreation(record: Effect, proposal: Creation, dispositions: readonly Disposition[]): Diagnostic[] {
  if (record.kind === 'report-promotion')
    return reportCreationMatches(record, proposal, dispositions)
      ? []
      : [
          diagnostic(
            'cause-effect-mismatch',
            `Promotion ${record.recordId} differs from its exact report and creation proposal`,
          ),
        ]
  const diagnostics: Diagnostic[] = []
  if (!sisterCreationMatches(record, proposal))
    diagnostics.push(
      diagnostic('cause-effect-mismatch', `Sister receipt ${record.recordId} differs from its exact creation proposal`),
    )
  if (!sisterDispositionMatches(record, dispositions))
    diagnostics.push(
      diagnostic('cause-effect-mismatch', `Sister receipt ${record.recordId} lacks its sister disposition`),
    )
  return diagnostics
}

function validateEffect(
  record: Effect,
  histories: readonly DecodedHistory[],
  dispositions: readonly Disposition[],
  seenEffects: Set<string>,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const effectRef = record.kind === 'debt-receipt' ? record.payload.disposition : record.payload.report
  if (!equalScope(effectRef.scope, record) || !equalScope(record.payload.operation.scope, record))
    diagnostics.push(diagnostic('cause-effect-mismatch', `Receipt ${record.recordId} is not on its original UW`))
  const operationHistory = histories.find((history) => equalScope(history.source.scope, record.payload.operation.scope))
  const identityHistory = histories.find((history) => equalScope(history.source.scope, record.payload.identity.scope))
  const operation = operationHistory && bindExternalRef(record.payload.operation, operationHistory)
  const identity = identityHistory && bindExternalRef(record.payload.identity, identityHistory)
  if (
    !operation?.ok ||
    operation.value.kind !== 'cause-operation' ||
    !identity?.ok ||
    identity.value.kind !== 'spec-identity'
  ) {
    diagnostics.push(
      diagnostic('cause-effect-unconfirmed', `Receipt ${record.recordId} lacks an authenticated operation or identity`),
    )
    return diagnostics
  }
  const op = operation.value
  if (!matchingIdentity(op, identity.value))
    diagnostics.push(
      diagnostic(
        'cause-effect-mismatch',
        `Receipt ${record.recordId} does not match the confirmed identity allocation`,
      ),
    )
  if (seenEffects.has(op.payload.confirmation.operationId))
    diagnostics.push(
      diagnostic('cause-effect-duplicate', `Creation ${op.payload.confirmation.operationId} has multiple receipts`),
    )
  seenEffects.add(op.payload.confirmation.operationId)
  if (op.payload.proposal.operation === 'create')
    diagnostics.push(...validateCreation(record, op.payload.proposal, dispositions))
  return diagnostics
}

export function validateCauseEffects(
  input: { records: readonly CanonicalRecord[]; histories: readonly DecodedHistory[] },
  dispositions: readonly Disposition[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const seenEffects = new Set<string>()
  const effectSubjects = new Set<string>()
  for (const record of input.records) {
    if (record.kind !== 'debt-receipt' && record.kind !== 'report-promotion') continue
    const effectRef = record.kind === 'debt-receipt' ? record.payload.disposition : record.payload.report
    const effectKey = canonicalValueDigest(effectRef)
    if (effectSubjects.has(effectKey))
      diagnostics.push(diagnostic('cause-effect-duplicate', `Disposition ${effectRef.recordId} has multiple effects`))
    effectSubjects.add(effectKey)
    diagnostics.push(...validateEffect(record, input.histories, dispositions, seenEffects))
  }
  return diagnostics
}

import { createHash } from 'node:crypto'
import { canonicalValueDigest } from './action-input.ts'
import type { Ref } from './cause-disposition.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, sameRef } from './record-diagnostics.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic, Scope } from './record-values.ts'
import { bindExternalRef } from './workflow-control.ts'

type Disposition = Extract<CanonicalRecord, { kind: 'cause-disposition' }>
type Promotion = Extract<CanonicalRecord, { kind: 'report-promotion' }>

export function validateInitialDisposition(
  record: Disposition,
  initialSubjects: Set<string>,
  diagnostics: Diagnostic[],
): void {
  const identity = canonicalValueDigest([record.payload.origin, record.payload.subject])
  if (initialSubjects.has(identity))
    diagnostics.push(diagnostic('cause-duplicate-initial', `Duplicate initial disposition for ${record.recordId}`))
  initialSubjects.add(identity)
  if (record.payload.adjudication !== null)
    diagnostics.push(diagnostic('cause-chain-invalid', `Initial disposition ${record.recordId} has an adjudication`))
}

export function validateDispositionSuccessor(
  record: Disposition,
  previous: Ref<'cause-disposition'>,
  scope: Scope,
  ids: ReadonlySet<string>,
  dispositions: readonly Disposition[],
  successorCount: Map<string, number>,
  diagnostics: Diagnostic[],
): void {
  if (!equalScope(previous.scope, scope) || !ids.has(previous.recordId))
    diagnostics.push(diagnostic('unknown-reference', `Disposition ${record.recordId} has no local predecessor`))
  const parent = dispositions.find((item) => item.recordId === previous.recordId)
  if (
    parent?.payload.outcome.state !== 'pending-blocking' ||
    canonicalValueDigest(parent.payload.subject) !== canonicalValueDigest(record.payload.subject) ||
    canonicalValueDigest(parent.payload.origin) !== canonicalValueDigest(record.payload.origin) ||
    record.payload.adjudication === null
  )
    diagnostics.push(diagnostic('cause-chain-invalid', `Disposition ${record.recordId} is not a valid successor`))
  successorCount.set(previous.recordId, (successorCount.get(previous.recordId) ?? 0) + 1)
}

export function diagnoseDispositionCycle(
  record: Disposition,
  dispositions: readonly Disposition[],
  diagnostics: Diagnostic[],
): void {
  const seen = new Set<string>()
  let cursor: Disposition | undefined = record
  while (cursor !== undefined && cursor.payload.previous !== null) {
    if (seen.has(cursor.recordId)) {
      diagnostics.push(diagnostic('cycle', `Disposition chain cycles at ${cursor.recordId}`))
      break
    }
    seen.add(cursor.recordId)
    cursor = dispositions.find((item) => item.recordId === cursor?.payload.previous?.recordId)
  }
}

export function validateReportPromotion(
  promotion: Promotion,
  record: Disposition,
  scope: Scope,
  history: DecodedHistory,
  diagnostics: Diagnostic[],
): void {
  const bound = bindExternalRef({ scope, recordId: promotion.recordId, kind: 'report-promotion' }, history)
  if (!bound.ok) diagnostics.push(...bound.diagnostics)
  const operation = bindExternalRef(promotion.payload.operation, history)
  if (
    !operation.ok ||
    operation.value.kind !== 'cause-operation' ||
    operation.value.payload.proposal.operation !== 'create' ||
    operation.value.payload.proposal.creation.kind !== 'report-promotion' ||
    !sameRef(operation.value.payload.proposal.creation.report, promotion.payload.report) ||
    operation.value.payload.proposal.creation.reportDigest !==
      createHash('sha256').update(JSON.stringify(record)).digest('hex') ||
    operation.value.payload.proposalDigest !==
      createHash('sha256').update(JSON.stringify(operation.value.payload.proposal)).digest('hex') ||
    operation.value.payload.confirmation.proposalDigest !== operation.value.payload.proposalDigest ||
    operation.value.payload.confirmation.operationId !== operation.value.payload.proposal.operationId ||
    !equalScope(promotion.payload.created, promotion.payload.identity.scope)
  )
    diagnostics.push(
      diagnostic(
        'cause-effect-unconfirmed',
        `Promotion ${promotion.recordId} lacks its matching local confirmed intent`,
      ),
    )
}

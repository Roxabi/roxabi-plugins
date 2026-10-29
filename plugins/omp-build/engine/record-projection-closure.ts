import { claimsReviewOrStop, type HistoryClassification } from './history-classification.ts'
import { sameJson } from './history-conservation.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, fail } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import type { Result } from './result.ts'

const trustedReviewOrStop = (operation: DecodedHistory['operations'][number]): boolean => claimsReviewOrStop(operation)

function addCollisionIndex(indexesByIdentifier: Map<string, number[]>, identifier: string | null, index: number): void {
  if (identifier === null) return
  const indexes = indexesByIdentifier.get(identifier) ?? []
  indexes.push(index)
  indexesByIdentifier.set(identifier, indexes)
}

function trustedCollisionIndexes(history: DecodedHistory, classification: HistoryClassification): Set<number> {
  const collisions = new Set<number>()
  const authorities = new Map(classification.classes.map((entry) => [entry.index, entry.authority]))
  const trusted = (index: number): boolean =>
    authorities.get(index) === 'authority' && trustedReviewOrStop(history.operations[index])
  const byOperationId = new Map<string, number[]>()
  const byRecordId = new Map<string, number[]>()
  for (const [index, operation] of history.operations.entries()) {
    addCollisionIndex(byOperationId, operation.operationId, index)
    addCollisionIndex(byRecordId, operation.recordId, index)
    if ((operation.status === 'conflict' || operation.status === 'invalid') && trusted(index)) collisions.add(index)
  }
  for (const indexes of [...byOperationId.values(), ...byRecordId.values()]) {
    if (indexes.length < 2 || !indexes.some(trusted)) continue
    for (const index of indexes) collisions.add(index)
  }
  return collisions
}

type IndexedOperation = { operation: DecodedHistory['operations'][number]; index: number }

function projectionCandidates(history: DecodedHistory, recordId: string): IndexedOperation[] {
  return history.operations
    .map((operation, index) => ({ operation, index }))
    .filter(({ operation }) => operation.recordId === recordId || operation.record?.recordId === recordId)
}

function completeProjectionRecord(
  record: CanonicalRecord,
  recordId: string,
  candidates: IndexedOperation[],
  authorities: ReadonlyMap<number, string>,
): Result<IndexedOperation[]> {
  if (candidates.length === 0)
    return fail([
      diagnostic('unknown-reference', `Projection record ${record.recordId} requires absent record ${recordId}`),
    ])
  if (candidates.some(({ index }) => authorities.get(index) === 'foreign'))
    return fail([diagnostic('unbound', `Projection record ${record.recordId} requires foreign record ${recordId}`)])
  const complete = candidates.filter(
    ({ operation }) =>
      operation.status === 'complete' && operation.record !== null && operation.record.recordId === recordId,
  )
  if (complete.length !== candidates.length)
    return fail([diagnostic('unbound', `Projection record ${record.recordId} has an ambiguous record ${recordId}`)])
  const first = complete[0]
  if (first === undefined || first.operation.record === null)
    return fail([
      diagnostic('unknown-reference', `Projection record ${record.recordId} requires incomplete record ${recordId}`),
    ])
  const canonical = first.operation.record
  if (complete.some(({ operation }) => operation.record === null || !sameJson(operation.record, canonical)))
    return fail([diagnostic('unbound', `Projection record ${record.recordId} has conflicting records for ${recordId}`)])
  return { ok: true, value: complete }
}

function includeProjectionDependencies(
  record: CanonicalRecord,
  history: DecodedHistory,
  authorities: ReadonlyMap<number, string>,
  selected: Set<number>,
  resolving: Set<string>,
  recordId: string,
): Diagnostic[] | null {
  if (resolving.has(recordId)) return null
  resolving.add(recordId)
  const complete = completeProjectionRecord(record, recordId, projectionCandidates(history, recordId), authorities)
  if (!complete.ok) return complete.diagnostics
  for (const { index } of complete.value) selected.add(index)
  const first = complete.value[0]
  if (first === undefined || first.operation.record === null)
    return [
      diagnostic('unknown-reference', `Projection record ${record.recordId} requires incomplete record ${recordId}`),
    ]
  for (const input of first.operation.record.inputs) {
    const diagnostics = includeProjectionDependencies(record, history, authorities, selected, resolving, input)
    if (diagnostics !== null) return diagnostics
  }
  return null
}

function observedProjectionRoot(
  record: CanonicalRecord,
  history: DecodedHistory,
  authorities: ReadonlyMap<number, string>,
): Result<IndexedOperation[]> {
  const candidates = projectionCandidates(history, record.recordId)
  if (candidates.some(({ index }) => authorities.get(index) !== 'authority'))
    return fail([diagnostic('unbound', `Record ${record.recordId} collides with a non-authority operation`)])
  const complete = candidates.filter(
    ({ operation }) =>
      operation.status === 'complete' && operation.record !== null && operation.record.recordId === record.recordId,
  )
  if (complete.length === 0) return { ok: true, value: [] }
  if (complete.some((entry) => recordIntegrity(entry.operation.parts, record) !== null))
    return fail([diagnostic('unconfirmed', `Record ${record.recordId} has no observed immutable native read-back`)])
  if (complete.some(({ operation }) => operation.record === null || !sameJson(operation.record, record)))
    return fail([diagnostic('unbound', `Record ${record.recordId} conflicts with its observed immutable record`)])
  return { ok: true, value: complete }
}

function projectionHistory(
  history: DecodedHistory,
  classification: HistoryClassification,
  selected: ReadonlySet<number>,
): DecodedHistory {
  const operations = [...selected].sort((left, right) => left - right).map((index) => history.operations[index])
  const operationIds = new Set(
    operations.flatMap((operation) => (operation.operationId === null ? [] : [operation.operationId])),
  )
  return {
    ...history,
    source: history.source,
    operations,
    diagnostics: [
      ...history.diagnostics.filter(
        (diagnostic) => diagnostic.operationId === undefined || operationIds.has(diagnostic.operationId),
      ),
      ...classification.authorityHistory.diagnostics.filter((diagnostic) => diagnostic.code === 'unclassified'),
    ],
  }
}

export function projectionClosure(
  record: CanonicalRecord,
  history: DecodedHistory,
  classification: HistoryClassification,
): Result<DecodedHistory> {
  const authorities = new Map(classification.classes.map((entry) => [entry.index, entry.authority]))
  const selected = new Set(trustedCollisionIndexes(history, classification))
  const root = observedProjectionRoot(record, history, authorities)
  if (!root.ok) return fail(root.diagnostics)
  for (const { index } of root.value) selected.add(index)
  const resolving = new Set<string>()
  for (const input of record.inputs) {
    const diagnostics = includeProjectionDependencies(record, history, authorities, selected, resolving, input)
    if (diagnostics !== null) return fail(diagnostics)
  }
  return { ok: true, value: projectionHistory(history, classification, selected) }
}

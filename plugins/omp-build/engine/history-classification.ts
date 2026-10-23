import type { DecodedHistory, OperationAuthority } from './history-schema.ts'
import { isWorkflowKind } from './record-references.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { diagnostic, equalScope } from './result.ts'

export type HistoryOperationClass = {
  index: number
  operationId: string | null
  authority: OperationAuthority
}
export type HistoryClassification = {
  classes: HistoryOperationClass[]
  authorityHistory: DecodedHistory
}

function stampedAuthority(operation: DecodedHistory['operations'][number]): OperationAuthority | null {
  const authority: unknown = Reflect.get(operation, 'authority')
  return authority === 'authority' || authority === 'foreign' || authority === 'accounted' ? authority : null
}

function stampedClaimedKinds(operation: DecodedHistory['operations'][number]): string[] | null {
  const claimedKinds: unknown = Reflect.get(operation, 'claimedKinds')
  if (
    !Array.isArray(claimedKinds) ||
    claimedKinds.some((kind) => typeof kind !== 'string' || kind.length === 0) ||
    new Set(claimedKinds).size !== claimedKinds.length
  )
    return null
  return claimedKinds
}

export const claimsReviewOrStop = (operation: DecodedHistory['operations'][number]): boolean =>
  stampedClaimedKinds(operation)?.some((kind) => kind === 'review' || kind === 'stop') ?? false

const operationClaimsWorkflow = (operation: DecodedHistory['operations'][number]): boolean =>
  isWorkflowKind(operation.record?.kind ?? operation.kind ?? '') ||
  (stampedClaimedKinds(operation)?.some((kind) => isWorkflowKind(kind)) ?? false)

function retainAccountedWorkflow(history: DecodedHistory, authorities: OperationAuthority[]): void {
  const collided = new Set<number>()
  const byOperationId = new Map<string, number[]>()
  history.operations.forEach((operation, index) => {
    if (operation.operationId === null) return
    const indexes = byOperationId.get(operation.operationId) ?? []
    indexes.push(index)
    byOperationId.set(operation.operationId, indexes)
  })
  for (const indexes of byOperationId.values()) {
    const reviewOrStop = indexes.some((index) => claimsReviewOrStop(history.operations[index]))
    const workflow = indexes.some((index) => operationClaimsWorkflow(history.operations[index]))
    if (reviewOrStop && workflow) for (const index of indexes) collided.add(index)
  }
  history.operations.forEach((operation, index) => {
    if (!operationClaimsWorkflow(operation) || authorities[index] === 'foreign' || collided.has(index)) return
    authorities[index] = 'accounted'
  })
}

type CompleteRecord = { index: number; record: CanonicalRecord }

function completeNativeRecord(
  operation: DecodedHistory['operations'][number],
  history: DecodedHistory,
): CanonicalRecord | null {
  if (operation.status !== 'complete' || operation.record === null) return null
  if (
    operation.operationId !== operation.record.operationId ||
    operation.recordId !== operation.record.recordId ||
    operation.kind !== operation.record.kind ||
    !equalScope(operation.record, history.source.scope) ||
    operation.parts.some((part) => part.author !== history.source.expectedAuthor)
  )
    return null
  return operation.record
}

function uniqueCompleteRecord(
  recordsById: Map<string, CompleteRecord[]>,
  operationCounts: Map<string, number>,
  recordId: string,
): CompleteRecord | null {
  const entries = recordsById.get(recordId)
  if (entries === undefined || entries.length !== 1) return null
  const entry = entries[0]
  return operationCounts.get(entry.record.operationId) === 1 ? entry : null
}

function correctionRoot(
  inventoryId: string,
  recordsById: Map<string, CompleteRecord[]>,
  operationCounts: Map<string, number>,
): string | null {
  const inventory = uniqueCompleteRecord(recordsById, operationCounts, inventoryId)
  if (inventory?.record.kind !== 'review-attempt' || inventory.record.payload.purpose !== 'correction') return null
  const payload = inventory.record.payload
  if (payload.stage === 'initial') {
    const request = uniqueCompleteRecord(recordsById, operationCounts, payload.requestId)
    return request?.record.kind === 'fix-request' &&
      payload.rootAttemptId === inventory.record.recordId &&
      inventory.record.inputs.includes(request.record.recordId)
      ? inventory.record.recordId
      : null
  }
  if (payload.stage !== 'synthesis') return null
  const root = uniqueCompleteRecord(recordsById, operationCounts, payload.rootAttemptId)
  if (
    root?.record.kind !== 'review-attempt' ||
    root.record.payload.purpose !== 'correction' ||
    root.record.payload.stage !== 'initial'
  )
    return null
  const request = uniqueCompleteRecord(recordsById, operationCounts, root.record.payload.requestId)
  return request?.record.kind === 'fix-request' &&
    root.record.inputs.includes(request.record.recordId) &&
    inventory.record.inputs.includes(root.record.recordId)
    ? root.record.recordId
    : null
}

function correctionContributionRoots(
  recordsById: Map<string, CompleteRecord[]>,
  operationCounts: Map<string, number>,
): Map<string, string> {
  const contributionRoots = new Map<string, string>()
  for (const entries of recordsById.values()) {
    if (entries.length !== 1) continue
    const entry = entries[0]
    if (entry.record.kind !== 'contribution' || entry.record.payload.inventoryId === null) continue
    const root = correctionRoot(entry.record.payload.inventoryId, recordsById, operationCounts)
    if (root !== null && entry.record.inputs.includes(entry.record.payload.inventoryId))
      contributionRoots.set(entry.record.recordId, root)
  }
  return contributionRoots
}

function accountedCorrectionIndexes(
  recordsById: Map<string, CompleteRecord[]>,
  contributionRoots: Map<string, string>,
  authorities: readonly OperationAuthority[],
): Set<number> {
  const accounted = new Set<number>()
  for (const entries of recordsById.values()) {
    if (entries.length !== 1) continue
    const entry = entries[0]
    if (authorities[entry.index] !== 'authority') continue
    if (entry.record.kind === 'contribution' && contributionRoots.has(entry.record.recordId)) {
      accounted.add(entry.index)
      continue
    }
    if (entry.record.kind !== 'decision' || entry.record.payload.judgment.purpose !== 'correction') continue
    const root = contributionRoots.get(entry.record.payload.originalContributionId)
    const sources = entry.record.payload.judgment.sourceContributionIds
    if (
      root !== undefined &&
      sources.length > 0 &&
      entry.record.inputs.includes(entry.record.payload.originalContributionId) &&
      sources.every((sourceId) => contributionRoots.get(sourceId) === root) &&
      sources.every((sourceId) => entry.record.inputs.includes(sourceId))
    )
      accounted.add(entry.index)
  }
  return accounted
}

function correctionAccountedIndexes(history: DecodedHistory, authorities: readonly OperationAuthority[]): Set<number> {
  const recordsById = new Map<string, CompleteRecord[]>()
  const operationCounts = new Map<string, number>()
  for (const [index, operation] of history.operations.entries()) {
    if (operation.operationId !== null)
      operationCounts.set(operation.operationId, (operationCounts.get(operation.operationId) ?? 0) + 1)
    const record = completeNativeRecord(operation, history)
    if (record === null) continue
    const entries = recordsById.get(record.recordId) ?? []
    entries.push({ index, record })
    recordsById.set(record.recordId, entries)
  }
  const contributionRoots = correctionContributionRoots(recordsById, operationCounts)
  return accountedCorrectionIndexes(recordsById, contributionRoots, authorities)
}

function promoteReviewDependency(
  recordId: string,
  visiting: Set<string>,
  byRecordId: Map<string, CompleteRecord[]>,
  authorities: OperationAuthority[],
  diagnostics: Diagnostic[],
): void {
  if (visiting.has(recordId)) return
  const entries = byRecordId.get(recordId)
  if (entries === undefined) return
  if (entries.length !== 1) {
    for (const entry of entries) if (authorities[entry.index] !== 'foreign') authorities[entry.index] = 'authority'
    diagnostics.push(diagnostic('duplicate-reference', `Review dependency ${recordId} is ambiguous`))
    return
  }
  const entry = entries[0]
  if (authorities[entry.index] === 'foreign') return
  authorities[entry.index] = 'authority'
  const next = new Set(visiting)
  next.add(recordId)
  for (const input of entry.record.inputs) promoteReviewDependency(input, next, byRecordId, authorities, diagnostics)
}

function promoteReviewDependencies(history: DecodedHistory, authorities: OperationAuthority[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const byRecordId = new Map<string, CompleteRecord[]>()
  for (const [index, operation] of history.operations.entries()) {
    if (operation.status !== 'complete' || operation.record === null) continue
    const entries = byRecordId.get(operation.record.recordId) ?? []
    entries.push({ index, record: operation.record })
    byRecordId.set(operation.record.recordId, entries)
  }
  for (const [index, operation] of history.operations.entries()) {
    if (authorities[index] !== 'authority' || operation.record?.kind !== 'review') continue
    for (const input of operation.record.inputs)
      promoteReviewDependency(input, new Set([operation.record.recordId]), byRecordId, authorities, diagnostics)
  }
  return diagnostics
}

export function classifyHistory(history: DecodedHistory): HistoryClassification {
  const unclassified: number[] = []
  const authorities: OperationAuthority[] = history.operations.map((operation, index) => {
    const authority = stampedAuthority(operation)
    if (authority !== null && stampedClaimedKinds(operation) !== null) return authority
    unclassified.push(index)
    return authority ?? 'authority'
  })
  const byOperationId = new Map<string, number[]>()
  history.operations.forEach((operation, index) => {
    if (operation.operationId === null) return
    const indexes = byOperationId.get(operation.operationId) ?? []
    indexes.push(index)
    byOperationId.set(operation.operationId, indexes)
  })
  for (const indexes of byOperationId.values()) {
    if (indexes.length < 2) continue
    const classifications = new Set(indexes.map((index) => authorities[index]))
    const reviewOrStop = indexes.some((index) => claimsReviewOrStop(history.operations[index]))
    if (classifications.size > 1 || (reviewOrStop && classifications.has('authority')))
      for (const index of indexes) authorities[index] = 'authority'
  }
  for (const index of correctionAccountedIndexes(history, authorities)) authorities[index] = 'accounted'
  const dependencyDiagnostics = promoteReviewDependencies(history, authorities)
  retainAccountedWorkflow(history, authorities)
  const classes = history.operations.map((operation, index) => ({
    index,
    operationId: operation.operationId,
    authority: authorities[index],
  }))
  const authorityOperationIds = new Set(
    classes
      .filter((entry) => entry.authority === 'authority' && entry.operationId !== null)
      .map((entry) => entry.operationId),
  )
  return {
    classes,
    authorityHistory: {
      ...history,
      source: history.source,
      operations: history.operations.filter((_, index) => authorities[index] === 'authority'),
      diagnostics: [
        ...history.diagnostics.filter(
          (diagnostic) => diagnostic.operationId === undefined || authorityOperationIds.has(diagnostic.operationId),
        ),
        ...dependencyDiagnostics,
        ...unclassified.map((index) =>
          diagnostic(
            'unclassified',
            `Operation ${history.operations[index].operationId ?? 'unknown'} has invalid authority or kind claims`,
          ),
        ),
      ],
    },
  }
}

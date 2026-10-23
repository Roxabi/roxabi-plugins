import { inventoryRoot, requiredSlotsComplete } from './history-conservation.ts'
import { validateContributionConservation } from './history-graph-conservation.ts'
import { validateFixLinks } from './history-graph-fixes.ts'
import { validateDecisionAndReviewLinks } from './history-graph-links.ts'
import type { DecodedHistory } from './history-schema.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { diagnostic, equalScope, fail, type Result, recordMap, unique } from './result.ts'

function validateOperation(
  operation: DecodedHistory['operations'][number],
  history: DecodedHistory,
  operationsById: Map<string, CanonicalRecord>,
  recordsById: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  if (operation.status !== 'complete' || operation.record === null) {
    diagnostics.push(
      diagnostic(
        operation.status === 'legacy' ? 'legacy-format' : operation.status,
        `Operation ${operation.operationId ?? 'unknown'} is not a complete canonical record`,
      ),
    )
    return
  }
  if (
    operation.operationId !== operation.record.operationId ||
    operation.recordId !== operation.record.recordId ||
    operation.kind !== operation.record.kind
  )
    diagnostics.push(
      diagnostic('unbound', `Observed operation metadata does not identify record ${operation.record.recordId}`),
    )
  const authorized =
    operation.record.kind === 'stop'
      ? (author: string | null) =>
          author === history.source.expectedAuthor ||
          (history.source.stopAuthor !== null && author === history.source.stopAuthor)
      : (author: string | null) => author === history.source.expectedAuthor
  if (operation.parts.some((part) => !authorized(part.author)))
    diagnostics.push(diagnostic('unbound', `Operation ${operation.operationId} has an unauthorized native author`))
  const priorOperation = operationsById.get(operation.record.operationId)
  const priorRecord = recordsById.get(operation.record.recordId)
  if (
    (priorOperation !== undefined && JSON.stringify(priorOperation) !== JSON.stringify(operation.record)) ||
    (priorRecord !== undefined && JSON.stringify(priorRecord) !== JSON.stringify(operation.record))
  )
    diagnostics.push(
      diagnostic(
        'duplicate-reference',
        `Operation ${operation.record.operationId} or record ${operation.record.recordId} appears more than once with different content`,
      ),
    )
  operationsById.set(operation.record.operationId, operation.record)
  recordsById.set(operation.record.recordId, operation.record)
}

function validateRecordReferences(
  records: Map<string, CanonicalRecord>,
  scope: DecodedHistory['source']['scope'],
  diagnostics: Diagnostic[],
): void {
  for (const record of records.values()) {
    if (!equalScope(record, scope))
      diagnostics.push(diagnostic('unbound', `Record ${record.recordId} has another scope`))
    if (!unique(record.inputs))
      diagnostics.push(diagnostic('duplicate-reference', `Record ${record.recordId} repeats an input`))
    for (const input of record.inputs)
      if (!records.has(input))
        diagnostics.push(diagnostic('unknown-reference', `Record ${record.recordId} references missing input ${input}`))
  }
}

function validateAcyclicRecords(records: Map<string, CanonicalRecord>, diagnostics: Diagnostic[]): void {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) {
      diagnostics.push(diagnostic('cycle', `Record graph contains a cycle at ${id}`))
      return
    }
    visiting.add(id)
    const current = records.get(id)
    if (current !== undefined) for (const input of current.inputs) if (records.has(input)) visit(input)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of records.keys()) visit(id)
}

function validateReviewAttempt(
  record: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const inventory = record.payload
  if (!unique(inventory.slots.map((slot) => slot.slotId)))
    diagnostics.push(diagnostic('duplicate-reference', `Inventory ${record.recordId} repeats slot IDs`))
  if (inventory.stage === 'initial') {
    if (inventory.rootAttemptId !== record.recordId)
      diagnostics.push(diagnostic('unbound', `Initial inventory ${record.recordId} does not root itself`))
    if (
      inventory.purpose === 'review' &&
      inventory.subject.kind === 'epic-range' &&
      inventory.subject.range.slice(-40) !== inventory.candidateGitSHA
    )
      diagnostics.push(
        diagnostic('unbound', `Epic range subject for ${record.recordId} does not end at the candidate SHA`),
      )
  } else {
    const root = inventoryRoot(records, record)
    if (root === null || root.payload.stage !== 'initial')
      diagnostics.push(diagnostic('unknown-reference', `Inventory ${record.recordId} has no initial root`))
    else if (
      !record.inputs.includes(root.recordId) ||
      root.payload.candidateGitSHA !== inventory.candidateGitSHA ||
      root.payload.input !== inventory.input ||
      root.payload.purpose !== inventory.purpose ||
      JSON.stringify(root.payload.policy) !== JSON.stringify(inventory.policy)
    )
      diagnostics.push(
        diagnostic('unbound', `Inventory ${record.recordId} diverges from root ${inventory.rootAttemptId}`),
      )
  }
  requiredSlotsComplete(records, record, diagnostics, false)
}

export function validateRecordGraph(history: DecodedHistory, enforceAdmission = true): Result<CanonicalRecord[]> {
  const diagnostics: Diagnostic[] = [...history.diagnostics, ...history.source.diagnostics]
  if (!history.source.complete) diagnostics.push(diagnostic('incomplete', 'History pagination is incomplete'))
  const records = recordMap(history)
  const operationsById = new Map<string, CanonicalRecord>()
  const recordsById = new Map<string, CanonicalRecord>()
  for (const operation of history.operations)
    validateOperation(operation, history, operationsById, recordsById, diagnostics)
  validateRecordReferences(records, history.source.scope, diagnostics)
  validateAcyclicRecords(records, diagnostics)
  for (const record of records.values())
    if (record.kind === 'review-attempt') validateReviewAttempt(record, records, diagnostics)
  validateContributionConservation(records, diagnostics)
  validateDecisionAndReviewLinks(records, diagnostics, enforceAdmission)
  validateFixLinks(records, diagnostics)
  return diagnostics.length === 0 ? { ok: true, value: [...records.values()] } : fail(diagnostics)
}

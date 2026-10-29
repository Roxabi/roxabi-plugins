import { inventoryRoot, requiredSlotsComplete, sameJson } from './history-conservation.ts'
import { validateContributionConservation, validateContributionRecord } from './history-graph-conservation.ts'
import { validateFixLinks } from './history-graph-fixes.ts'
import { validateDecisionAndReviewLinks, validateProspectiveLinks } from './history-graph-links.ts'
import {
  incompleteOperation,
  refuseDuplicateOperation,
  refuseMissingNativeIdentity,
  refuseOperationIdentity,
  refuseUnauthorizedAuthor,
} from './history-graph-operation.ts'
import type { DecodedHistory } from './history-schema.ts'
import { diagnostic, equalScope, fail } from './record-diagnostics.ts'
import { recordIntegrity } from './record-integrity.ts'
import type { CanonicalRecord } from './record-schema.ts'
import type { Diagnostic } from './record-values.ts'
import { type Result, recordMap, unique } from './result.ts'
import { type InitialPullRequestReviewInventory, isInitialPullRequestReviewInventory } from './review-schema.ts'

type InitialReviewInventory = Extract<
  Extract<CanonicalRecord, { kind: 'review-attempt' }>['payload'],
  { stage: 'initial' }
>

function validateOperation(
  operation: DecodedHistory['operations'][number],
  history: DecodedHistory,
  operationsById: Map<string, CanonicalRecord>,
  recordsById: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  if (incompleteOperation(operation, diagnostics)) return
  if (operation.record === null) return
  const record = operation.record
  refuseOperationIdentity(operation, diagnostics)
  refuseMissingNativeIdentity(operation, diagnostics)
  refuseUnauthorizedAuthor(operation, history, diagnostics)
  const integrity = recordIntegrity(operation.parts, record)
  if (integrity !== null) diagnostics.push(diagnostic(integrity.reason, integrity.detail))
  refuseDuplicateOperation(operation, operationsById, recordsById, diagnostics)
  operationsById.set(record.operationId, record)
  recordsById.set(record.recordId, record)
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

function validateReplacementInventory(
  record: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  inventory: InitialPullRequestReviewInventory,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const link = inventory.replacement
  if (link === undefined) return
  const root = records.get(link.rootAttemptId)
  const historicalRoot =
    root?.kind === 'review-attempt' &&
    isInitialPullRequestReviewInventory(root.payload) &&
    root.payload.replacement === undefined
      ? root
      : null
  const disposition = records.get(link.dispositionId)
  const grant = records.get(link.grantId)
  if (
    historicalRoot === null ||
    disposition?.kind !== 'review-interruption' ||
    disposition.payload.rootAttemptId !== historicalRoot.recordId ||
    grant?.kind !== 'review-replacement-grant' ||
    grant.payload.rootAttemptId !== historicalRoot.recordId ||
    grant.payload.dispositionId !== disposition.recordId ||
    grant.payload.candidateGitSHA !== inventory.candidateGitSHA ||
    grant.payload.input !== inventory.input ||
    record.recordId !== `review-replacement-inventory-${grant.recordId}` ||
    record.inputs.length !== 3 ||
    !record.inputs.includes(historicalRoot.recordId) ||
    !record.inputs.includes(disposition.recordId) ||
    !record.inputs.includes(grant.recordId)
  )
    diagnostics.push(
      diagnostic('unbound', `Replacement inventory ${record.recordId} is not exactly bound to its terminal and grant`),
    )
}

function validateInitialInventory(
  record: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  inventory: InitialReviewInventory,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  if (inventory.rootAttemptId !== record.recordId)
    diagnostics.push(diagnostic('unbound', `Initial inventory ${record.recordId} does not root itself`))
  if (isInitialPullRequestReviewInventory(inventory))
    validateReplacementInventory(record, inventory, records, diagnostics)
  if (
    inventory.purpose === 'review' &&
    inventory.subject.kind === 'epic-range' &&
    inventory.subject.range.slice(-40) !== inventory.candidateGitSHA
  )
    diagnostics.push(
      diagnostic('unbound', `Epic range subject for ${record.recordId} does not end at the candidate SHA`),
    )
}

function validateReviewAttempt(
  record: Extract<CanonicalRecord, { kind: 'review-attempt' }>,
  records: Map<string, CanonicalRecord>,
  diagnostics: Diagnostic[],
): void {
  const inventory = record.payload
  if (!unique(inventory.slots.map((slot) => slot.slotId)))
    diagnostics.push(diagnostic('duplicate-reference', `Inventory ${record.recordId} repeats slot IDs`))
  if (inventory.stage === 'initial') validateInitialInventory(record, inventory, records, diagnostics)
  else {
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

/** A prospective record is absent from observed history. It is validated structurally, never inserted as a fake read-back. */
export function validateProspectiveRecord(record: CanonicalRecord, history: DecodedHistory): Diagnostic[] {
  const observed = history.operations.flatMap((operation) =>
    operation.record !== null &&
    (operation.recordId === record.recordId || operation.record.recordId === record.recordId)
      ? [operation.record]
      : [],
  )
  if (observed.length > 0) {
    return observed.some((item) => sameJson(item, record))
      ? []
      : [diagnostic('duplicate-reference', `Record ${record.recordId} conflicts with its observed record`)]
  }
  const diagnostics: Diagnostic[] = []
  const records = new Map<string, CanonicalRecord>()
  for (const operation of history.operations) {
    if (operation.status === 'complete' && operation.record !== null)
      records.set(operation.record.recordId, operation.record)
  }
  for (const input of record.inputs) {
    if (input !== record.recordId && !records.has(input)) {
      diagnostics.push(diagnostic('unknown-reference', `Record ${record.recordId} references missing input ${input}`))
    }
  }
  records.set(record.recordId, record)
  if (record.kind === 'review-attempt') validateReviewAttempt(record, records, diagnostics)
  validateContributionRecord(record, records, diagnostics)
  validateProspectiveLinks(record, records, diagnostics)
  return diagnostics
}

import { randomUUID } from 'node:crypto'
import { bindExternalRef, canonicalValueDigest, sameScope, workflowOperationProblem } from '../dist/contracts.js'
import { type Contracts, type History, type HistoryRecord, publishRecord, type Scope } from './feature-engine.ts'
import type { Gh } from './feature-succession-binding.ts'

function authorityComments(history: History, excluded: ReadonlySet<string> = new Set()) {
  const locators = new Set(
    history.operations
      .filter((operation) => operation.authority !== 'foreign')
      .flatMap((operation) => operation.parts.map((part) => part.locator)),
  )
  return history.source.comments.filter((part) => locators.has(part.locator) && !excluded.has(part.locator))
}

export function validateSuccessorRefresh(
  original: History,
  refreshed: History,
  scope: Scope,
  successorId: string,
): { ok: true } | { ok: false; reason: string } {
  const operations = refreshed.operations.filter((operation) => operation.recordId === successorId)
  if (
    operations.length !== 1 ||
    operations[0]?.status !== 'complete' ||
    operations[0].authority !== 'accounted' ||
    !bindExternalRef({ scope, recordId: successorId, kind: 'mandate' }, refreshed).ok
  )
    return { ok: false, reason: 'successor-unconfirmed' }
  const successorParts = new Set(operations[0].parts.map((part) => part.locator))
  if (
    workflowOperationProblem(original) !== null ||
    workflowOperationProblem(refreshed) !== null ||
    original.source.expectedAuthor !== refreshed.source.expectedAuthor ||
    original.source.stopAuthor !== refreshed.source.stopAuthor ||
    !sameScope(original.source.scope, refreshed.source.scope) ||
    canonicalValueDigest(authorityComments(refreshed, successorParts)) !==
      canonicalValueDigest(authorityComments(original))
  )
    return { ok: false, reason: 'successor-ancestry-changed' }
  return { ok: true }
}

/** Publish the mandate, then prove the observed home changed only by that complete mandate. */
export async function publishAndRefreshSuccessor(
  input: {
    loaded: Contracts
    history: History
    scope: Scope
    cwd: string
    gh: Gh
    parents: readonly History[]
  },
  successorId: string,
  payload: Extract<HistoryRecord, { kind: 'mandate' }>['payload'],
) {
  const published = await publishRecord(
    input.loaded,
    input.history,
    {
      repository: input.scope.repository,
      target: input.scope.target,
      version: 1,
      recordId: successorId,
      runId: randomUUID(),
      operationId: randomUUID(),
      kind: 'mandate',
      payload,
    },
    input.gh,
    input.cwd,
    input.parents,
  )
  if (!published.ok) return { ok: false as const, reason: published.reason }
  const readOptions = {
    cwd: input.cwd,
    gh: input.gh,
    readAuthor: input.history.source.expectedAuthor,
    ...(input.history.source.stopAuthor === null ? {} : { stopAuthor: input.history.source.stopAuthor }),
  }
  const refreshed = await input.loaded.readComposedWorkflowHistory([input.scope], readOptions)
  if (!refreshed.ok || !refreshed.histories[0]) return { ok: false as const, reason: 'successor-unconfirmed' }
  const checked = validateSuccessorRefresh(input.history, refreshed.histories[0], input.scope, successorId)
  if (!checked.ok) return checked
  return { ok: true as const, history: refreshed.histories[0], readOptions }
}

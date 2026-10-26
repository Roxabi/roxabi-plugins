// Source: plugins/omp-build/roxabi/workflow.ts:505-527,638-643,1141-1197,1317-1328
import type { Gh } from '../adapters/github/types.ts'
import type { DecodedHistory } from '../engine/history-schema.ts'
import type { MandateRecord } from '../engine/workflow-control.ts'
import type { Contracts, History, Scope } from './feature-engine.ts'
import { isRecord, payload } from './feature-engine.ts'
import { withRoxabiGitHubPolicy } from './github-policy.ts'

export function mandatesInHistory(history: History): MandateRecord[] {
  return history.operations.flatMap((operation) => {
    const record = operation.record
    return operation.status === 'complete' && record?.kind === 'mandate' ? [record] : []
  })
}

function parentGrantReference(cursor: unknown): { recordId: string; scope: Scope } | null {
  if (
    !isRecord(cursor) ||
    !isRecord(cursor.scope) ||
    typeof cursor.scope.repository !== 'string' ||
    typeof cursor.scope.target !== 'string' ||
    typeof cursor.recordId !== 'string'
  ) {
    return null
  }
  return {
    recordId: cursor.recordId,
    scope: { repository: cursor.scope.repository, target: cursor.scope.target },
  }
}

function parentMandate(history: History, recordId: string): MandateRecord | undefined {
  const record = history.operations.find(
    (operation) => operation.record?.recordId === recordId && operation.record.kind === 'mandate',
  )?.record
  return record?.kind === 'mandate' ? record : undefined
}

export async function explicitParentHistories(
  loaded: Contracts,
  mandate: History['operations'][number]['record'] | null,
  options: { cwd: string; gh?: Gh },
): Promise<{ ok: true; parents: History[] } | { ok: false; reason: string }> {
  const parents: History[] = []
  const seen = new Set<string>()
  let cursor: unknown = mandate?.kind === 'mandate' ? payload(mandate).parent : null
  while (cursor !== null && cursor !== undefined) {
    const parent = parentGrantReference(cursor)
    if (parent === null) return { ok: false, reason: 'parent-grant-unreadable' }
    const key = `${parent.scope.repository}\0${parent.scope.target}\0${parent.recordId}`
    if (seen.has(key)) return { ok: false, reason: 'parent-grant-cycle' }
    seen.add(key)
    const read = await loaded.readComposedWorkflowHistory([parent.scope], options)
    if (!read.ok || !read.histories[0]) return { ok: false, reason: read.ok ? 'parent-grant-missing' : read.reason }
    const history = read.histories[0]
    parents.push(history)
    const record = parentMandate(history, parent.recordId)
    cursor = record === undefined ? null : payload(record).parent
  }
  return { ok: true, parents }
}

export async function mandateParentHistories(
  loaded: Contracts,
  history: History,
  options: { cwd: string; gh?: Gh },
): Promise<{ ok: true; parents: History[] } | { ok: false; reason: string }> {
  const parents: History[] = []
  for (const mandate of mandatesInHistory(history)) {
    const resolved = await explicitParentHistories(loaded, mandate, options)
    if (!resolved.ok) return resolved
    for (const parent of resolved.parents) {
      if (
        parents.some(
          (known) =>
            known.source.scope.repository === parent.source.scope.repository &&
            known.source.scope.target === parent.source.scope.target,
        )
      )
        continue
      parents.push(parent)
    }
  }
  return { ok: true, parents }
}

export async function readDecodedHistory(
  scope: Scope,
  cwd: string,
  gh: Gh,
): Promise<{ ok: true; history: DecodedHistory } | { ok: false; reason: string }> {
  const contracts = await import('../dist/contracts.js')
  const read = await contracts.readComposedWorkflowHistory([scope], withRoxabiGitHubPolicy({ cwd, gh }))
  if (!read.ok) return { ok: false, reason: read.reason }
  const history = read.histories[0]
  if (history === undefined) return { ok: false, reason: 'incomplete' }
  return { ok: true, history }
}

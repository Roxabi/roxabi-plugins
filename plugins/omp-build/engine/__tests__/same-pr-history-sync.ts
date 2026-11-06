import { encodeParts } from '../../adapters/github/history-encoder.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { criterionPullHistory } from '../../testing/criterion-approval.ts'
import { canonicalValueDigest } from '../action-input.ts'
import type { DecodedHistory } from '../history-schema.ts'
import type { CanonicalRecord } from '../record-schema.ts'
import { recordsOf, workflowOperationProblem } from '../workflow-control.ts'

async function readComments(cwd: string, gh: Gh, path: string) {
  const comments: { id: number; author: string; body: string; createdAt: string | null; updatedAt: string | null }[] =
    []
  for (let page = 1; ; page++) {
    const entries = JSON.parse(await gh(cwd, ['api', `${path}?per_page=100&page=${page}`]))
    if (!Array.isArray(entries)) throw new Error('Native history page is not an array')
    for (const entry of entries) {
      if (typeof entry.id !== 'number' || typeof entry.body !== 'string' || typeof entry.user?.login !== 'string')
        throw new Error('Native history comment lacks identity')
      comments.push({
        id: entry.id,
        author: entry.user.login,
        body: entry.body,
        createdAt: entry.created_at ?? null,
        updatedAt: entry.updated_at ?? null,
      })
    }
    if (entries.length < 100) break
  }
  return comments
}

async function appendMissingRecords(
  cwd: string,
  gh: Gh,
  path: string,
  current: Map<string, CanonicalRecord>,
  desired: readonly CanonicalRecord[],
) {
  for (const record of desired) {
    const existing = current.get(record.recordId)
    if (existing) {
      if (canonicalValueDigest(existing) !== canonicalValueDigest(record))
        throw new Error(`Native history already contains different ${record.recordId}`)
      continue
    }
    const encoded = encodeParts(record, `# ${record.kind}`, 65_536)
    if (!encoded.ok) throw new Error(`Cannot encode ${record.recordId}`)
    for (const body of encoded.value) await gh(cwd, ['api', '--method', 'POST', path, '-f', `body=${body}`])
    current.set(record.recordId, record)
  }
}

/** Append missing canonical records to the declared native histories without rewriting prior comments. */
export async function syncNativeHistories(cwd: string, gh: Gh, histories: readonly DecodedHistory[]) {
  async function syncHistory(desired: DecodedHistory) {
    const scope = desired.source.scope
    const match = /^(.+\/[^#]+)#(\d+)$/.exec(scope.target)
    if (
      !match ||
      match[1] !== scope.repository ||
      !desired.source.complete ||
      workflowOperationProblem(desired) !== null
    )
      throw new Error('Expected a complete same-repository native history')
    const path = `repos/${scope.repository}/issues/${match[2]}/comments`
    const comments = await readComments(cwd, gh, path)
    const observed = criterionPullHistory(scope, comments)
    const current = new Map(recordsOf(observed).map((record) => [record.recordId, record]))
    await appendMissingRecords(cwd, gh, path, current, recordsOf(desired))
  }
  for (const desired of histories) await syncHistory(desired)
}

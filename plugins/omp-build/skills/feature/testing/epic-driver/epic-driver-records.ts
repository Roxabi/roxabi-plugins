import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  type CanonicalRecord,
  canonicalSpec,
  decodeHistory,
  type History,
  type Json,
  renderIssueSpecBody,
} from '../../../../contracts.ts'
import { actionInputDigest, canonicalValueDigest } from '../../../../engine/action-input.ts'
import { acceptedActionInputs } from '../../../../testing/action-input-fixtures.ts'
import { criterionEpicReviewGraph } from '../../../../testing/criterion-range-approval.ts'
import { epicReviewGraph } from '../../../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { git, sandboxOf } from './epic-driver-sandbox.ts'

const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()
const { framedBodies } = roxabiWorkflowFixtures()

export const RUN = 'run00001'
export const ME = 'operator'

export type Comment = { body: string; author: string }
export function strictSpecBody(statement: string): string {
  const canonical = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!canonical.ok) throw new Error(`fixture Spec rejected: ${canonical.diagnostics.map((d) => d.code).join(',')}`)
  return renderIssueSpecBody(canonical.value, { complexity: 1 })
}

export function recordHistory(issue: number, comments: Comment[] = []): History {
  return {
    scope: { repository: 'o/r', target: `o/r#${issue}` },
    expectedAuthor: ME,
    stopAuthor: null,
    complete: true,
    comments: comments.map((comment, index) => ({
      locator: `o/r#${issue}:comment:${index + 1}`,
      nativeId: String(index + 1),
      body: comment.body,
      author: comment.author,
      createdAt: '2026-10-21T10:00:00Z',
      updatedAt: '2026-10-21T10:00:00Z',
    })),
    diagnostics: [],
  }
}
export function framedRecords(issue: number, records: CanonicalRecord[]): Comment[] {
  if (records.some((record) => record.repository !== 'o/r' || record.target !== `o/r#${issue}`))
    throw new Error(`fixture record does not belong to o/r#${issue}`)
  return framedBodies(records, ME, [], TEST_PROJECTION_CONFIG).map((body) => ({ body, author: ME }))
}

export function epicEvent(
  issue: number,
  id: string,
  payload: Record<string, Json>,
  inputs: string[] = [],
): CanonicalRecord {
  return {
    version: 1,
    recordId: id,
    runId: RUN,
    operationId: `op-${id}`,
    inputs,
    repository: 'o/r',
    target: `o/r#${issue}`,
    kind: 'epic-event',
    payload,
  }
}

export function issueComments(issue: number): Comment[] {
  const raw = JSON.parse(readFileSync(path.join(sandboxOf().state, `comments-${issue}.json`), 'utf8')) as {
    body: string
    user: { login: string }
  }[]
  return raw.map((comment) => ({ body: comment.body, author: comment.user.login }))
}

export function eventPayloads(issue: number): Record<string, unknown>[] {
  return decodeHistory(recordHistory(issue, issueComments(issue))).operations.flatMap((operation) =>
    operation.record?.kind === 'epic-event' ? [operation.record.payload as Record<string, unknown>] : [],
  )
}
export function pullReviewInputs(number: number, head: string) {
  const mandate = decodeHistory(recordHistory(2, issueComments(2)))
    .operations.map((operation) => operation.record)
    .find((record) => record?.kind === 'mandate')
  const binding = decodeHistory(recordHistory(number, issueComments(number)))
    .operations.map((operation) => operation.record)
    .find((record) => record?.kind === 'workflow-binding')
  if (mandate?.kind !== 'mandate' || binding?.kind !== 'workflow-binding')
    throw new Error('bound PR review fixture needs its accepted mandate and binding')
  const base = acceptedActionInputs(mandate, 'review')
  const reference = (record: typeof mandate | typeof binding) => ({
    source: 'record' as const,
    record: {
      scope: { repository: record.repository, target: record.target },
      recordId: record.recordId,
      kind: record.kind,
    },
    selector: '/payload',
    digest: canonicalValueDigest(record.payload),
  })
  const baseCommit = git(sandboxOf().epic, 'rev-parse', 'refs/remotes/origin/main')
  const manifest = {
    ...base.manifest,
    subject: {
      kind: 'uw' as const,
      uw: { repository: mandate.repository, target: mandate.target },
      pullRequest: { repository: binding.repository, target: binding.target },
      binding: reference(binding),
    },
    acceptedSources: [reference(mandate)],
    code: { repository: 'o/r', base: baseCommit, head, referenceCommit: head },
    plugin: { ...base.manifest.plugin, commit: git(import.meta.dirname, 'rev-parse', 'HEAD') },
  }
  return { ...base, manifest, fingerprint: actionInputDigest(manifest) }
}

export function epicDecisionHistory(range: string, blocking: boolean, criteriaSatisfied = false): Comment[] {
  const [baseCommit, head] = range.split('..')
  if (!baseCommit || !head) throw new Error(`invalid epic range ${range}`)
  const mandate = decodeHistory(recordHistory(1, issueComments(1)))
    .operations.map((operation) => operation.record)
    .find((record) => record?.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error('epic review fixture needs its accepted parent mandate')
  const base = acceptedActionInputs(mandate, 'review')
  const manifest = {
    ...base.manifest,
    acceptedSources: [
      {
        source: 'record' as const,
        record: {
          scope: { repository: mandate.repository, target: mandate.target },
          recordId: mandate.recordId,
          kind: mandate.kind,
        },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
    code: { repository: mandate.repository, base: baseCommit, head, referenceCommit: head },
    plugin: { ...base.manifest.plugin, commit: git(import.meta.dirname, 'rev-parse', 'HEAD') },
  }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const options = {
    mandate,
    inputs,
    head,
    range,
    prefix: `epic-${head.slice(0, 8)}`,
    blocking,
  }
  const graph = criteriaSatisfied
    ? criterionEpicReviewGraph(options)
    : epicReviewGraph({
        prefix: options.prefix,
        head,
        range,
        inputs,
        scope: { repository: 'o/r', target: 'o/r#1' },
        empty: !blocking,
      })
  const root = graph.root
  const records = graph.records
  const implementation =
    criteriaSatisfied && 'issueRecords' in graph ? graph.issueRecords.filter((record) => record.kind !== 'mandate') : []
  const parentHistory = decodeHistory(recordHistory(1, issueComments(1)))
  // Same-scope inputs must be in the encoded history, not just external histories.
  // The parent already contains these canonical frames; return only new frames.
  const seed = framedBodies([mandate], ME, [], TEST_PROJECTION_CONFIG)
  return framedBodies(
    [
      mandate,
      ...implementation,
      ...records,
      epicEvent(
        1,
        `${root.recordId}-event`,
        {
          event: 'epic-review',
          run: RUN,
          decisionId: graph.decision.recordId,
          inventoryIds: [root.recordId, graph.synthesis.recordId],
          range,
        },
        [graph.decision.recordId, root.recordId, graph.synthesis.recordId],
      ),
    ],
    ME,
    [parentHistory],
    TEST_PROJECTION_CONFIG,
  )
    .slice(seed.length)
    .map((body) => ({ body, author: ME }))
}

export { childNode, prNode } from './epic-driver-nodes.ts'
export { serveComments, serveEpic, servePr } from './epic-driver-serve.ts'

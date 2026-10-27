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
import { submission } from '../../../../testing/record-builders.ts'
import { epicReviewGraph } from '../../../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { sandboxOf } from './epic-driver-sandbox.ts'

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
  return framedBodies(
    records.map((record) => ({ ...record, repository: 'o/r', target: `o/r#${issue}` })),
    ME,
    [],
    TEST_PROJECTION_CONFIG,
  ).map((body) => ({ body, author: ME }))
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

export function epicDecisionHistory(range: string, blocking: boolean): Comment[] {
  const head = range.slice(range.indexOf('..') + 2)
  const graph = epicReviewGraph({ prefix: `epic-${head.slice(0, 8)}`, head })
  const root = {
    ...graph.root,
    payload: { ...graph.root.payload, subject: { kind: 'epic-range' as const, range } },
  }
  const panel = blocking
    ? graph.panel
    : {
        ...graph.panel,
        payload: {
          ...graph.panel.payload,
          rawAttempts: [
            submission({
              id: `child-${graph.panel.recordId}`,
              structuredOutput: { status: 'valid', data: { findings: [] } },
            }),
          ],
          structured: { findings: [] },
          findings: [],
        },
      }
  const decision = blocking
    ? graph.decision
    : {
        ...graph.decision,
        payload: { ...graph.decision.payload, judgment: { ...graph.decision.payload.judgment, findings: [] } },
      }
  const synthesisContribution = blocking
    ? graph.synthesisContribution
    : {
        ...graph.synthesisContribution,
        payload: {
          ...graph.synthesisContribution.payload,
          rawAttempts: [
            submission({
              id: `child-${graph.synthesisContribution.recordId}`,
              structuredOutput: { status: 'valid', data: decision.payload.judgment },
            }),
          ],
          structured: decision.payload.judgment,
        },
      }
  const records = graph.records.map((record) => {
    if (record.recordId === root.recordId) return root
    if (record.recordId === panel.recordId) return panel
    if (record.recordId === synthesisContribution.recordId) return synthesisContribution
    if (record.recordId === decision.recordId) return decision
    return record
  }) as CanonicalRecord[]
  return framedRecords(1, [
    ...records,
    epicEvent(
      1,
      `${root.recordId}-event`,
      {
        event: 'epic-review',
        run: RUN,
        decisionId: decision.recordId,
        inventoryIds: [root.recordId, graph.synthesis.recordId],
        range,
      },
      [decision.recordId, root.recordId, graph.synthesis.recordId],
    ),
  ])
}

export { childNode, prNode } from './epic-driver-nodes.ts'
export { serveComments, serveEpic, servePr } from './epic-driver-serve.ts'

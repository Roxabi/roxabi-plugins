import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { type CanonicalRecord, decodeHistory, encodeRecord, type History, type Json } from '../../../../contracts.ts'
import { submission } from '../../../../testing/record-builders.ts'
import { epicReviewGraph } from '../../../../testing/record-graphs.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { sandboxOf } from './epic-driver-sandbox.ts'

const { projection: TEST_PROJECTION_CONFIG } = roxabiRecordFixtures()
const { childSnapshot, epicMandate, framedBodies } = roxabiWorkflowFixtures()

export const RUN = 'run00001'
export const ME = 'operator'

export type Comment = { body: string; author: string }

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
  const comments: Comment[] = []
  for (const record of records) {
    const encoded = encodeRecord(
      { ...record, repository: 'o/r', target: `o/r#${issue}` },
      recordHistory(issue, comments),
      TEST_PROJECTION_CONFIG,
    )
    if (!encoded.ok) throw new Error(encoded.diagnostics.map((entry) => `${entry.code}: ${entry.message}`).join('; '))
    comments.push(...encoded.value.map((body) => ({ body, author: ME })))
  }
  return comments
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

export function serveComments(issue: number, comments: Comment[]): void {
  writeFileSync(
    path.join(sandboxOf().state, `comments-${issue}.json`),
    JSON.stringify(
      comments.map((comment, index) => ({
        id: index + 1,
        body: comment.body,
        user: { login: comment.author },
        created_at: '2026-10-21T10:00:00Z',
        updated_at: '2026-10-21T10:00:00Z',
      })),
    ),
  )
}

export function prNode(number: number, head: string, headSha: string, over: Record<string, unknown> = {}) {
  return {
    number,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: head,
    headRefOid: headSha,
    mergedAt: null,
    mergeCommit: null,
    autoMergeRequest: null,
    labels: { nodes: [] },
    repository: { nameWithOwner: 'o/r' },
    isCrossRepository: false,
    ...over,
  }
}

export function childNode(
  number: number,
  title: string,
  { state = 'OPEN', blockedBy = [], comments = [], prs = [] as unknown[] } = {} as {
    state?: 'OPEN' | 'CLOSED'
    blockedBy?: [number, 'OPEN' | 'CLOSED'][]
    comments?: Comment[]
    prs?: unknown[]
  },
) {
  return {
    number,
    title,
    state,
    body: '## Acceptance criteria\n\n- [ ] works\n',
    author: { login: ME },
    repository: { nameWithOwner: 'o/r' },
    labels: { nodes: [{ name: 'size:S' }] },
    blockedBy: { nodes: blockedBy.map(([n, s]) => ({ number: n, state: s, repository: { nameWithOwner: 'o/r' } })) },
    closedByPullRequestsReferences: { nodes: prs },
    comments: { nodes: [] },
    fixtureComments: comments,
    timelineItems: { nodes: [] },
  }
}

export function serveEpic(
  children: { number: number; body?: string; specBody?: string; fixtureComments?: Comment[] }[],
  epicComments: Comment[] = [],
  options: { mandate?: boolean } = {},
): void {
  const framedBody = '## Acceptance criteria\n\n- [ ] works\n'
  const mandate =
    options.mandate === false
      ? []
      : framedBodies(
          [
            epicMandate(
              { repository: 'o/r', target: 'o/r#1' },
              children.map((child) =>
                childSnapshot(
                  { repository: 'o/r', target: `o/r#${child.number}` },
                  // Accepted Spec is authority; live issue body may diverge (unframed/drift).
                  child.specBody ?? child.body ?? framedBody,
                ),
              ),
              { runId: RUN },
            ),
          ],
          ME,
        ).map((body) => ({ body, author: ME }))
  serveComments(1, [...mandate, ...epicComments])
  for (const child of children) serveComments(child.number, child.fixtureComments ?? [])
  const data = {
    data: {
      viewer: { login: ME },
      repository: {
        issue: {
          comments: { nodes: [] },
          subIssues: { pageInfo: { hasNextPage: false }, nodes: children },
        },
      },
    },
  }
  writeFileSync(path.join(sandboxOf().state, 'epic.json'), JSON.stringify(data))
}

export function servePr(number: number, view: { state: string; labels: string[]; autoMerge: boolean }, sticky = false) {
  const { state } = sandboxOf()
  writeFileSync(
    path.join(state, 'pr', `${number}.json`),
    JSON.stringify({
      state: view.state,
      labels: view.labels.map((name) => ({ name })),
      autoMergeRequest: view.autoMerge ? { enabledAt: 'x' } : null,
    }),
  )
  if (sticky) writeFileSync(path.join(state, 'pr', `${number}.sticky`), '')
}

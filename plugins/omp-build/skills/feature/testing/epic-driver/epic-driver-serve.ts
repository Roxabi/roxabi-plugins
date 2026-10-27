import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseIssueSpecBody, rawSource } from '../../../../contracts.ts'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { type Comment, ME, RUN, strictSpecBody } from './epic-driver-records.ts'
import { sandboxOf } from './epic-driver-sandbox.ts'

const { epicMandate, framedBodies, identityAllocation, ownSpecFromSnapshot } = roxabiWorkflowFixtures()

function currentSnapshot(scope: { repository: string; target: string }, body: string) {
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, body, '2026-10-21T12:00:00Z'),
  })
  if (parsed.status !== 'conformant') throw new Error(`fixture Spec ${scope.target} is ${parsed.status}`)
  return parsed.snapshot
}

function approvedChild(scope: { repository: string; target: string }, body: string) {
  const snapshot = currentSnapshot(scope, body)
  return { scope, specVersion: snapshot.spec.version, snapshot, tier: 'S' as const }
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

export function serveEpic(
  children: { number: number; body?: string; specBody?: string; fixtureComments?: Comment[] }[],
  epicComments: Comment[] = [],
  options: { mandate?: boolean } = {},
): void {
  const framedBody = strictSpecBody('works')
  const epicScope = { repository: 'o/r', target: 'o/r#1' }
  const mandate =
    options.mandate === false
      ? []
      : framedBodies(
          [
            epicMandate(
              epicScope,
              children.map((child) =>
                approvedChild(
                  { repository: 'o/r', target: `o/r#${child.number}` },
                  child.specBody ?? child.body ?? framedBody,
                ),
              ),
              {
                runId: RUN,
                body: framedBody,
                ownSpec: ownSpecFromSnapshot(epicScope, currentSnapshot(epicScope, framedBody)),
              },
            ),
          ],
          ME,
        ).map((body) => ({ body, author: ME }))
  serveComments(1, [...mandate, ...epicComments])
  for (const child of children) {
    const scope = { repository: 'o/r', target: `o/r#${child.number}` }
    const identity = framedBodies([identityAllocation(scope)], ME).map((body) => ({ body, author: ME }))
    serveComments(child.number, [...identity, ...(child.fixtureComments ?? [])])
  }
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
  const connection = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const strictIssue = (
    issue: {
      number: number
      title: string
      body: string
      state: 'OPEN' | 'CLOSED'
      labels: string[]
      subIssues: number[]
      blockedBy: number[]
    },
    parent: number | null,
  ) => ({
    data: {
      repository: {
        issue: {
          number: issue.number,
          title: issue.title,
          body: issue.body,
          updatedAt: '2026-10-21T12:00:00Z',
          state: issue.state,
          stateReason: null,
          repository: { nameWithOwner: 'o/r' },
          parent: parent === null ? null : { number: parent, repository: { nameWithOwner: 'o/r' } },
          labels: connection(issue.labels.map((name) => ({ name }))),
          subIssues: connection(issue.subIssues.map((number) => ({ number, repository: { nameWithOwner: 'o/r' } }))),
          blockedBy: connection(issue.blockedBy.map((number) => ({ number, repository: { nameWithOwner: 'o/r' } }))),
        },
      },
    },
  })
  writeFileSync(path.join(sandboxOf().state, 'epic.json'), JSON.stringify(data))
  writeFileSync(
    path.join(sandboxOf().state, 'uw-1.json'),
    JSON.stringify(
      strictIssue(
        {
          number: 1,
          title: 'epic: test',
          body: framedBody,
          state: 'OPEN',
          labels: ['size:S'],
          subIssues: children.map((child) => child.number),
          blockedBy: [],
        },
        null,
      ),
    ),
  )
  for (const child of children) {
    const node = child as typeof child & {
      title?: string
      state?: 'OPEN' | 'CLOSED'
      labels?: { nodes?: { name: string }[] }
      subIssues?: { nodes?: { number: number }[] }
      blockedBy?: { nodes?: { number: number }[] }
    }
    writeFileSync(
      path.join(sandboxOf().state, `uw-${child.number}.json`),
      JSON.stringify(
        strictIssue(
          {
            number: child.number,
            title: node.title ?? `issue #${child.number}`,
            body: child.body ?? framedBody,
            state: node.state ?? 'OPEN',
            labels: node.labels?.nodes?.map((label) => label.name) ?? ['size:S'],
            subIssues: node.subIssues?.nodes?.map((issue) => issue.number) ?? [],
            blockedBy: node.blockedBy?.nodes?.map((issue) => issue.number) ?? [],
          },
          1,
        ),
      ),
    )
  }
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

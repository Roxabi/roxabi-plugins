import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { roxabiWorkflowFixtures } from '../../../../testing/roxabi-presets.ts'
import { type Comment, ME, strictSpecBody } from './epic-driver-records.ts'
import { sandboxOf } from './epic-driver-sandbox.ts'

const { framedBodies, identityAllocation } = roxabiWorkflowFixtures()

export function serveComments(issue: number, comments: Comment[]): void {
  writeFileSync(
    path.join(sandboxOf().state, `comments-${issue}.json`),
    JSON.stringify(
      comments.map((comment, index) => ({
        id: index + 1,
        node_id: `IC_${index + 1}`,
        body: comment.body,
        user: { login: comment.author, id: comment.author === ME ? 101 : 102, type: 'User' },
        performed_via_github_app: null,
        created_at: '2026-10-21T10:00:00Z',
        updated_at: '2026-10-21T10:00:00Z',
      })),
    ),
  )
}

export function addForeignMandateClaim(issue: 1 | 2, claim: 'legacy' | 'copy'): void {
  const file = path.join(sandboxOf().state, `comments-${issue}.json`)
  const comments = JSON.parse(readFileSync(file, 'utf8'))
  const originals = comments.filter((entry: { body: string }) => entry.body.includes('kind=mandate '))
  if (originals.length === 0) throw new Error('missing mandate copy fixture')
  const bodies =
    claim === 'legacy' ? ['<!-- omp-build:mandate -->'] : originals.map((entry: { body: string }) => entry.body)
  comments.push(
    ...bodies.map((body: string, index: number) => ({
      id: 9000 + index,
      body,
      user: { login: 'intruder' },
      created_at: '2026-10-21T12:00:00Z',
      updated_at: '2026-10-21T12:00:00Z',
    })),
  )
  writeFileSync(file, JSON.stringify(comments))
}

export function serveEpic(
  children: {
    number: number
    body?: string
    stateReason?: string | null
    fixtureComments?: Comment[]
  }[],
  epicComments: Comment[],
): void {
  const framedBody = strictSpecBody('works')
  serveComments(1, epicComments)
  for (const child of children) {
    const scope = { repository: 'o/r', target: `o/r#${child.number}` }
    const identity = framedBodies([identityAllocation(scope)], ME).map((body) => ({ body, author: ME }))
    serveComments(child.number, [...identity, ...(child.fixtureComments ?? [])])
  }
  const connection = <T>(nodes: T[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const strictIssue = (
    issue: {
      number: number
      title: string
      body: string
      state: 'OPEN' | 'CLOSED'
      stateReason: string | null
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
          stateReason: issue.stateReason,
          repository: { nameWithOwner: 'o/r' },
          parent: parent === null ? null : { number: parent, repository: { nameWithOwner: 'o/r' } },
          labels: connection(issue.labels.map((name) => ({ name }))),
          subIssues: connection(issue.subIssues.map((number) => ({ number, repository: { nameWithOwner: 'o/r' } }))),
          blockedBy: connection(issue.blockedBy.map((number) => ({ number, repository: { nameWithOwner: 'o/r' } }))),
        },
      },
    },
  })
  writeFileSync(
    path.join(sandboxOf().state, 'containment-1.json'),
    JSON.stringify({
      data: {
        repository: {
          issue: {
            number: 1,
            repository: { nameWithOwner: 'o/r' },
            closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [] },
            timelineItems: { pageInfo: { hasPreviousPage: false }, nodes: [] },
          },
        },
      },
    }),
  )
  writeFileSync(
    path.join(sandboxOf().state, 'uw-1.json'),
    JSON.stringify(
      strictIssue(
        {
          number: 1,
          title: 'epic: test',
          body: framedBody,
          state: 'OPEN',
          stateReason: null,
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
      stateReason?: string | null
      labels?: { nodes?: { name: string }[] }
      subIssues?: { nodes?: { number: number }[] }
      blockedBy?: { nodes?: { number: number }[] }
      closedByPullRequestsReferences?: { nodes?: unknown[] }
      timelineItems?: { nodes?: { source?: Record<string, unknown> | null }[] }
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
            stateReason: node.stateReason ?? null,
            labels: node.labels?.nodes?.map((label) => label.name) ?? ['size:S'],
            subIssues: node.subIssues?.nodes?.map((issue) => issue.number) ?? [],
            blockedBy: node.blockedBy?.nodes?.map((issue) => issue.number) ?? [],
          },
          1,
        ),
      ),
    )
    writeFileSync(
      path.join(sandboxOf().state, `containment-${child.number}.json`),
      JSON.stringify({
        data: {
          repository: {
            issue: {
              number: child.number,
              repository: { nameWithOwner: 'o/r' },
              closedByPullRequestsReferences: {
                pageInfo: { hasNextPage: false },
                nodes: node.closedByPullRequestsReferences?.nodes ?? [],
              },
              timelineItems: {
                pageInfo: { hasPreviousPage: false },
                nodes: (node.timelineItems?.nodes ?? []).map(({ source }) => ({
                  source: source ? { __typename: 'PullRequest', ...source } : null,
                })),
              },
            },
          },
        },
      }),
    )
    writeFileSync(
      path.join(sandboxOf().state, `branch-prs-${child.number}.json`),
      JSON.stringify(node.closedByPullRequestsReferences?.nodes ?? []),
    )
  }
}

export function servePr(number: number, view: { state: string; labels: string[]; autoMerge: boolean }) {
  const { state } = sandboxOf()
  writeFileSync(
    path.join(state, 'pr', `${number}.json`),
    JSON.stringify({
      state: view.state,
      labels: view.labels.map((name) => ({ name })),
      autoMergeRequest: view.autoMerge ? { enabledAt: 'x' } : null,
    }),
  )
}

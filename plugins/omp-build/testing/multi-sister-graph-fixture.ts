import { patchFixtureIssue } from './multi-sister-issue-patch.ts'
import type { NativeWorldFacts } from './native-implementation-world.ts'

export type NativeIssue = {
  title: string
  body: string
  labels: string[]
  parent: number | null
  blockers: number[]
  state: 'OPEN' | 'CLOSED'
  stateReason: 'COMPLETED' | 'NOT_PLANNED' | 'REOPENED' | null
}

export function sisterGraphTransport(context: {
  issues: Map<number, NativeIssue>
  currentPr: number
  head: string
  base: string
  blobOid: string
  catalogueRef: { repository: string; commit: string; path: string }
  afterParentRelation?: (parent: number, child: number) => void
  deliveryPulls: () => Iterable<NativeWorldFacts['pullRequests'][number]>
  failedCheck: () => string
  linked: () => boolean
}) {
  const { issues, currentPr, head, base, blobOid } = context
  function relationRequest(args: string[], query: string): string | null {
    if (query.includes('addBlockedBy')) {
      const issueNumber = Number(args.find((arg) => arg.startsWith('issueId=node-'))?.slice(13))
      const blockingNumber = Number(args.find((arg) => arg.startsWith('blockingId=node-'))?.slice(16))
      const issue = issues.get(issueNumber)
      if (!issue || !issues.has(blockingNumber)) throw new Error('unknown dependency endpoint')
      if (!issue.blockers.includes(blockingNumber)) issue.blockers.push(blockingNumber)
      return JSON.stringify({ data: { addBlockedBy: {} } })
    }
    if (query.includes('addSubIssue')) {
      const parent = Number(args.find((arg) => arg.startsWith('parentId=node-'))?.slice(14))
      const child = Number(args.find((arg) => arg.startsWith('childId=node-'))?.slice(13))
      const issue = issues.get(child)
      if (!issue || !issues.has(parent)) throw new Error('unknown parent endpoint')
      issue.parent = parent
      context.afterParentRelation?.(parent, child)
      return JSON.stringify({ data: { addSubIssue: {} } })
    }
    return null
  }
  function graphIssue(args: string[]): string {
    const number = Number(args.find((arg) => arg.startsWith('number='))?.slice(7))
    const issue = issues.get(number)
    if (!issue) throw new Error(`unknown graph issue ${number}`)
    const node = (n: number) => ({ number: n, repository: { nameWithOwner: 'acme/app' } })
    const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            number,
            title: issue.title,
            body: issue.body,
            updatedAt: '2026-10-27T12:00:00Z',
            parent: issue.parent === null ? null : node(issue.parent),
            labels: page(issue.labels.map((name) => ({ name }))),
            subIssues: page([...issues].filter(([, item]) => item.parent === number).map(([child]) => node(child))),
            state: issue.state,
            stateReason: issue.stateReason,
            repository: { nameWithOwner: 'acme/app' },
            blockedBy: page(issue.blockers.map(node)),
          },
        },
      },
    })
  }
  function pullRequests(args: string[]): string {
    if (!args.includes('owner=acme') || !args.includes('name=app'))
      throw new Error('Undeclared pull request repository')
    const nodes = (currentPr === 44 ? [44] : [44, currentPr]).map((number) => ({
      number,
      headRefName: 'feat/42-save',
      baseRefName: 'main',
      repository: { nameWithOwner: 'acme/app' },
    }))
    for (const pull of context.deliveryPulls())
      nodes.push({
        number: Number(pull.scope.target.split('#')[1]),
        headRefName: pull.branch,
        baseRefName: pull.base,
        repository: { nameWithOwner: pull.scope.repository },
      })
    const branch = args.find((arg) => arg.startsWith('branch='))?.slice('branch='.length)
    const cursor = args.find((arg) => arg.startsWith('cursor='))?.slice('cursor='.length)
    if (cursor !== undefined && !/^[1-9]\d*$/.test(cursor)) throw new Error('Invalid pull request cursor')
    const matching = nodes.filter((node) => branch === undefined || node.headRefName === branch)
    const offset = cursor === undefined ? 0 : Number(cursor)
    const end = offset + 100
    const hasNextPage = end < matching.length
    return JSON.stringify({
      data: {
        repository: {
          pullRequests: {
            nodes: matching.slice(offset, end),
            pageInfo: { hasNextPage, endCursor: hasNextPage ? String(end) : null },
          },
        },
      },
    })
  }
  function catalogueObject(args: string[]): string {
    const expression = args.find((arg) => arg.startsWith('expression='))?.slice('expression='.length)
    const owner = args.find((arg) => arg.startsWith('owner='))?.slice('owner='.length)
    const name = args.find((arg) => arg.startsWith('name='))?.slice('name='.length)
    const matches =
      `${owner}/${name}` === context.catalogueRef.repository &&
      expression === `${context.catalogueRef.commit}:${context.catalogueRef.path}`
    return JSON.stringify({ data: { repository: { object: matches ? { oid: blobOid } : null } } })
  }
  function graphRequest(args: string[]): string {
    const query = args.find((arg) => arg.startsWith('query=')) ?? ''
    if (query.includes('pullRequests(first:100')) return pullRequests(args)
    if (query.includes('statusCheckRollup'))
      return JSON.stringify({
        data: {
          repository: {
            object: {
              statusCheckRollup: {
                contexts: {
                  nodes: [
                    {
                      __typename: 'CheckRun',
                      id: 'check-run-1',
                      name: context.failedCheck(),
                      status: 'completed',
                      conclusion: 'failure',
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        },
      })
    if (query.includes('object(expression:$expression)')) return catalogueObject(args)
    if (query.includes('closingIssuesReferences'))
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefName: 'feat/42-save',
              baseRefName: 'main',
              headRefOid: head,
              baseRefOid: base,
              closingIssuesReferences: context.linked()
                ? { totalCount: 1, nodes: [{ number: 42 }] }
                : { totalCount: 0, nodes: [] },
            },
          },
        },
      })
    return relationRequest(args, query) ?? graphIssue(args)
  }
  return graphRequest
}

export function sisterIssueTransport(issues: Map<number, NativeIssue>, createIssue: (args: string[]) => string) {
  function issueRequest(args: string[], endpoint: string): string | null {
    if (endpoint.endsWith('/issues') && args.includes('POST')) return createIssue(args)
    const match = /issues\/(\d+)$/.exec(endpoint)
    if (match) {
      const number = Number(match[1])
      if (args.includes('.node_id')) return `node-${number}`
      if (args.includes('PATCH')) return patchFixtureIssue(issues, args, number)
    }
    return editLabels(args)
  }
  function editLabels(args: string[]): string | null {
    if (args[0] !== 'issue' || args[1] !== 'edit') return null
    const issue = issues.get(Number(args[2]))
    if (!issue) throw new Error('unknown issue for label')
    const index = args.indexOf('--add-label')
    if (index >= 0) issue.labels.push(...(args[index + 1] ?? '').split(','))
    return ''
  }
  return issueRequest
}

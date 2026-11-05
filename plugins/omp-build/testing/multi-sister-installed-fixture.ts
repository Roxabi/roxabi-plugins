import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent'
import { nativeComment } from '../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../adapters/github/types.ts'
import { createOperatorConfirmation } from '../omp/omp-operator-confirmation.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { criterionImplementationRecords } from './criterion-accepted-plan.ts'
import { encodeCriterionRecords } from './criterion-approval.ts'
import { multiSisterFixture } from './multi-sister-fixture.ts'
import { patchFixtureIssue } from './multi-sister-issue-patch.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from './roxabi-presets.ts'

const artifacts = mkdtempSync(join(tmpdir(), 'omp-sister-protocol-'))
process.once('exit', () => rmSync(artifacts, { recursive: true, force: true }))

type NativeIssue = {
  title: string
  body: string
  labels: string[]
  parent: number | null
  blockers: number[]
  state: 'OPEN' | 'CLOSED'
}

/** Installed operations with a stateful GitHub transport; all records are encoded and read back. */
export async function installedMultiSisterFixture(
  count: 1 | 2 = 2,
  options: { workflow?: boolean; currentPr?: number; head?: string; base?: string; report?: boolean } = {},
) {
  const data = multiSisterFixture(count, options.report ? 'report' : 'sister-blocking')
  const head = options.head ?? 'a'.repeat(40)
  const base = options.base ?? 'b'.repeat(40)
  const prior = options.workflow
    ? encodeCriterionRecords(
        criterionImplementationRecords(data.mandate, head).filter((record) => record.kind !== 'mandate'),
        data.context.original,
        roxabiRecordFixtures().projection,
        'automation',
        [data.source],
        data.own,
      ).history
    : data.own
  const own = encodeCriterionRecords(
    data.dispositions,
    data.context.original,
    roxabiRecordFixtures().projection,
    'automation',
    [data.source],
    prior,
  ).history
  const comments = new Map<number, ReturnType<typeof nativeComment>[]>([
    [42, own.source.comments.map((item, index) => nativeComment(index + 1, item.body))],
    [44, data.source.source.comments.map((item, index) => nativeComment(100 + index, item.body))],
  ])
  const currentPr = options.currentPr ?? 44
  const currentScope = { repository: 'acme/app', target: `acme/app#${currentPr}` }
  const currentBinding = roxabiWorkflowFixtures().workflowBinding(currentScope, data.mandate, 'feat/42-save', 'main')
  if (currentPr !== 44) {
    const encoded = encodeCriterionRecords(
      [currentBinding],
      currentScope,
      roxabiRecordFixtures().projection,
      'automation',
      [own],
    )
    comments.set(
      currentPr,
      encoded.history.source.comments.map((item, index) => nativeComment(300 + index, item.body)),
    )
  }
  const issues = new Map<number, NativeIssue>([
    [42, { title: 'Original', body: data.body, labels: ['size:S'], parent: null, blockers: [], state: 'OPEN' }],
  ])
  let nextIssue = 43
  let commentId = 200
  let confirmations = 0
  let linked = true
  let failedCheck = 'unit'
  const blobOid = createHash('sha1')
    .update(`blob ${data.catalogueBytes.length}\0`)
    .update(data.catalogueBytes)
    .digest('hex')
  function commentRequest(args: string[], endpoint: string): string | null {
    const match = /issues\/(\d+)\/comments/.exec(endpoint)
    if (!match) return null
    const number = Number(match[1])
    const list = comments.get(number)
    if (!list) throw new Error(`unknown history ${number}`)
    if (!args.includes('POST')) return JSON.stringify(list)
    const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
    if (body === undefined) throw new Error('missing comment body')
    const item = nativeComment(++commentId, body)
    list.push(item)
    return JSON.stringify(item)
  }
  function createIssue(args: string[]): string {
    if (nextIssue === 44) nextIssue += 1
    const number = nextIssue++
    issues.set(number, {
      title: args.find((arg) => arg.startsWith('title='))?.slice(6) ?? '',
      body: args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '',
      labels: [],
      parent: null,
      blockers: [],
      state: 'OPEN',
    })
    comments.set(number, [])
    return String(number)
  }
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
            stateReason: issue.state === 'CLOSED' ? 'COMPLETED' : null,
            repository: { nameWithOwner: 'acme/app' },
            blockedBy: page(issue.blockers.map(node)),
          },
        },
      },
    })
  }
  function graphRequest(args: string[]): string {
    const query = args.find((arg) => arg.startsWith('query=')) ?? ''
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
                      name: failedCheck,
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
    if (query.includes('object(expression:$expression)')) {
      const expression = args.find((arg) => arg.startsWith('expression='))?.slice('expression='.length)
      const owner = args.find((arg) => arg.startsWith('owner='))?.slice('owner='.length)
      const name = args.find((arg) => arg.startsWith('name='))?.slice('name='.length)
      const matches =
        `${owner}/${name}` === data.catalogueRef.repository &&
        expression === `${data.catalogueRef.commit}:${data.catalogueRef.path}`
      return JSON.stringify({ data: { repository: { object: matches ? { oid: blobOid } : null } } })
    }
    if (query.includes('closingIssuesReferences'))
      return JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              headRefName: 'feat/42-save',
              baseRefName: 'main',
              headRefOid: head,
              baseRefOid: base,
              closingIssuesReferences: linked
                ? { totalCount: 1, nodes: [{ number: 42 }] }
                : { totalCount: 0, nodes: [] },
            },
          },
        },
      })
    return relationRequest(args, query) ?? graphIssue(args)
  }
  const gh: Gh = async (_cwd, args) => {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    if (endpoint === `repos/${data.catalogueRef.repository}/git/blobs/${blobOid}`)
      return JSON.stringify({
        sha: blobOid,
        encoding: 'base64',
        size: data.catalogueBytes.length,
        content: data.catalogueBytes.toString('base64'),
      })
    if (args[0] === 'pr' && args[1] === 'view' && args[2] === String(currentPr))
      return JSON.stringify({
        number: currentPr,
        state: 'OPEN',
        headRefOid: head,
        headRefName: 'feat/42-save',
        baseRefName: 'main',
        baseRefOid: base,
        author: { login: 'automation' },
      })
    const comment = commentRequest(args, endpoint)
    if (comment !== null) return comment
    const issue = issueRequest(args, endpoint)
    if (issue !== null) return issue
    if (args[1] === 'graphql') return graphRequest(args)
    throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
  }
  const newCommand = async () => {
    const operator = createOperatorConfirmation({
      agent: { kind: 'main', depth: 0 },
      hasUI: true,
      mode: 'tui',
      ui: {
        confirm: async () => {
          confirmations += 1
          return true
        },
      },
      localProtocolOptions: { getArtifactsDir: () => artifacts },
    } as unknown as ExtensionContext)
    return createInstalledUwOperations({ cwd: '/fixture', gh, readAuthor: 'automation', operator })
  }
  const operations = await newCommand()
  const request = (index: number) => ({
    disposition: {
      scope: data.context.original,
      recordId: data.dispositions[index].recordId,
      kind: 'cause-disposition' as const,
    },
    factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
    tierOverride: null,
    labels: { add: [], remove: [] },
  })
  return {
    ...data,
    comments,
    issues,
    gh,
    operations,
    newCommand,
    request,
    currentPr,
    currentBinding,
    setFailedCheck: (value: string) => {
      failedCheck = value
    },
    setLinked: (value: boolean) => {
      linked = value
    },
    confirmations: () => confirmations,
  }
}

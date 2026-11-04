import { expect, it } from 'vitest'
import { nativeComment, wire } from '../../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../../adapters/github/types.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { createInput, fixture } from '../../testing/uw-operations-fixture.ts'
import { createInstalledUwOperations } from '../uw-installed-operations.ts'

it('promotes a historical report with real publisher, creation, same-parent readback and receipt without fetching its old PR', async () => {
  const held = sisterRecords().held
  if (held.kind !== 'cause-disposition') throw new Error('expected disposition')
  const built = buildRecord({
    version: 1,
    repository: held.repository,
    target: held.target,
    recordId: 'historical-report',
    runId: 'historic',
    operationId: 'historical-report-op',
    kind: 'cause-disposition',
    payload: {
      ...held.payload,
      outcome: { state: 'final', disposition: 'report', blocking: false, reason: 'Retained historical work' },
    },
  })
  if (!built.ok) throw new Error('report fixture invalid')
  const report = built.value
  const comments = new Map<number, ReturnType<typeof nativeComment>[]>([
    [41, []],
    [42, [nativeComment(1, wire(report))]],
    [43, []],
  ])
  const issues = new Map<number, { title: string; body: string; labels: string[]; parent: number | null }>([
    [41, { title: 'Parent', body: '', labels: [], parent: null }],
    [42, { title: 'Original', body: '', labels: [], parent: 41 }],
  ])
  let postId = 10
  let creates = 0
  let patches = 0
  const forbidden: string[] = []
  function handleComments(endpoint: string, args: string[], number: number): string {
    if (!comments.has(number)) {
      forbidden.push(endpoint)
      throw new Error('old PR unavailable')
    }
    const list = comments.get(number) as ReturnType<typeof nativeComment>[]
    if (!args.includes('POST')) return JSON.stringify(list)
    const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
    if (body === undefined) throw new Error('missing comment body')
    const item = nativeComment(++postId, body)
    list.push(item)
    return JSON.stringify(item)
  }
  function handleGraph(args: string[]): string {
    const query = args.find((arg) => arg.startsWith('query=')) ?? ''
    if (query.includes('addSubIssue')) {
      const child = issues.get(43)
      if (!child) throw new Error('created child missing')
      child.parent = 41
      return JSON.stringify({ data: { addSubIssue: {} } })
    }
    const number = Number(args.find((arg) => arg.startsWith('number='))?.slice(7))
    const issue = issues.get(number)
    if (!issue) throw new Error(`unavailable issue ${number}`)
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
            state: 'OPEN',
            stateReason: null,
            repository: { nameWithOwner: 'acme/app' },
            parent: issue.parent === null ? null : node(issue.parent),
            labels: page(issue.labels.map((name) => ({ name }))),
            subIssues: page([...issues].filter(([, value]) => value.parent === number).map(([child]) => node(child))),
            blockedBy: page([]),
          },
        },
      },
    })
  }

  function handleLabels(args: string[]): string {
    const issue = issues.get(Number(args[2]))
    if (!issue) throw new Error('unknown issue')
    const index = args.indexOf('--add-label')
    if (index >= 0) issue.labels.push(...(args[index + 1] ?? '').split(','))
    return ''
  }

  function handlePatch(number: number, args: string[]): string {
    const issue = issues.get(number)
    if (!issue) throw new Error(`cannot patch unknown issue ${number}`)
    const fields = args.flatMap((arg, index) => (arg === '--raw-field' ? [args[index + 1] ?? ''] : []))
    if (fields.length === 0) throw new Error('empty issue patch')
    for (const field of fields) {
      if (field.startsWith('title=')) issue.title = field.slice(6)
      else if (field.startsWith('body=')) issue.body = field.slice(5)
      else throw new Error(`unexpected patch field ${field}`)
    }
    patches += 1
    return '{}'
  }

  function handleIssueApi(endpoint: string, args: string[]): string | null {
    if (endpoint.endsWith('/issues') && args.includes('POST')) {
      creates += 1
      issues.set(43, {
        title: args.find((arg) => arg.startsWith('title='))?.slice(6) ?? '',
        body: args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '',
        labels: [],
        parent: null,
      })
      return '43'
    }
    const issueMatch = /issues\/(\d+)$/.exec(endpoint)
    if (issueMatch && args.includes('PATCH')) return handlePatch(Number(issueMatch[1]), args)
    return issueMatch && args.includes('.node_id') ? `node-${issueMatch[1]}` : null
  }

  const gh: Gh = async (_cwd, args) => {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    const commentMatch = /issues\/(\d+)\/comments/.exec(endpoint)
    if (commentMatch) return handleComments(endpoint, args, Number(commentMatch[1]))
    const issueApiResult = handleIssueApi(endpoint, args)
    if (issueApiResult !== null) return issueApiResult
    if (args[0] === 'issue' && args[1] === 'edit') return handleLabels(args)
    if (args[1] === 'graphql') return handleGraph(args)
    forbidden.push(args.join(' '))
    throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
  }
  const base = fixture()
  const operations = await createInstalledUwOperations({
    cwd: '/fixture',
    gh,
    readAuthor: 'automation',
    operator: base.ports.operator,
  })
  const initial = createInput()
  const create = {
    ...initial,
    repository: 'acme/app',
    normalization: [],
    draft: {
      ...initial.draft,
      criteria: [{ kind: 'new' as const, draftKey: 'promotion', statement: 'Resolve the promoted report' }],
    },
    writes: {
      labels: { add: [], remove: [] },
      relations: {
        parent: { repository: 'acme/app', number: 41 },
        addChildren: [],
        removeChildren: [],
        addBlockers: [],
        removeBlockers: [],
      },
    },
  }
  const result = await operations.promoteReport({
    report: {
      scope: { repository: report.repository, target: report.target },
      recordId: report.recordId,
      kind: 'cause-disposition',
    },
    create,
    reason: 'Promote the retained report into separately scoped work',
  })
  expect(result.status, JSON.stringify(result)).toBe('created')
  expect(creates).toBe(1)
  expect(patches).toBe(1)
  expect(issues.get(43)?.parent).toBe(41)
  expect(comments.get(42)?.some((item) => item.body.includes('kind=report-promotion'))).toBe(true)
  expect(comments.get(43)?.some((item) => item.body.includes('kind=spec-identity'))).toBe(true)
  expect(forbidden).toEqual([])
})

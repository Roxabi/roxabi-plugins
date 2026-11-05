import { framed, nativeComment, wire } from '../adapters/__tests__/github-workflow-support.ts'
import type { Gh } from '../adapters/github/types.ts'
import { rawSource } from '../adapters/github-native/uw-spec.ts'
import { buildRecord } from '../dist/contracts.js'
import type { MandateRecord } from '../engine/workflow-control.ts'
import { createInstalledUwOperations } from '../roxabi/uw-installed-operations.ts'
import { seedHistoricalChild } from './installed-parent-guard-history.ts'
import { roxabiWorkflowFixtures } from './roxabi-presets.ts'
import { createInput, fixture, input, SOURCE_BODY } from './uw-operations-fixture.ts'

type State =
  | 'inactive'
  | 'active'
  | 'indeterminate'
  | 'partial-claim'
  | 'invalid-claim'
  | 'unsupported'
  | 'paused'
  | 'abandoned'
  | 'revoked'
  | 'unresolved-control'
  | 'history-unreadable'
  | 'graph-unreadable'
  | 'active-after-effect'
  | 'active-after-identity'
  | 'active-after-first-insertion'
type Route = 'create-parent' | 'create-children' | 'update-parent' | 'update-children'
type Issue = { title: string; body: string; labels: string[]; parent: number | null }
type NativeComment = { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }

export async function installedParentGuardFixture(
  route: Route,
  state: State,
  options: { identity?: boolean; multiple?: boolean; historicalChild?: boolean } = {},
) {
  const parent = route === 'create-children' ? 43 : 41
  const issues = new Map<number, Issue>([
    [41, { title: 'Parent', body: SOURCE_BODY, labels: [], parent: null }],
    [42, { title: 'Child', body: SOURCE_BODY, labels: [], parent: null }],
    [44, { title: 'Second child', body: SOURCE_BODY, labels: [], parent: null }],
  ])
  const comments = new Map<
    number,
    { id: number; body: string; user: { login: string }; created_at: string; updated_at: string }[]
  >([
    [41, []],
    [42, []],
    [43, []],
  ])
  const forbidden: string[] = []
  if (options.historicalChild) seedHistoricalChild(issues, comments)
  let creates = 0
  let patches = 0
  let insertions = 0
  let confirmations = 0
  let commentPosts = 0
  const activate = () => {
    const scope = { repository: 'acme/app', target: `acme/app#${parent}` }
    const fixtures = roxabiWorkflowFixtures()
    const mandate = fixtures.featureMandate(scope, { recordId: 'parent-mandate' })
    const ledger = comments.get(parent)
    if (!ledger) throw new Error('missing parent ledger')
    if (state === 'partial-claim') {
      ledger.push(
        nativeComment(
          90,
          '<!-- omp-build-record v=1 kind=mandate id=partial-mandate operationId=partial-op part=1/2 data=e30 -->',
        ),
      )
      return
    }
    if (state === 'invalid-claim') {
      ledger.push(nativeComment(90, framed('mandate', 'invalid-op', 'invalid-mandate')))
      return
    }
    const observed =
      state === 'unsupported'
        ? { ...mandate, payload: { ...mandate.payload, config: { ...mandate.payload.config, effective: {} } } }
        : mandate
    ledger.push(nativeComment(90, wire(observed)))
    const successor =
      state === 'revoked'
        ? fixtures.featureMandate(scope, {
            recordId: 'parent-successor',
            operationId: 'parent-successor-op',
            antecedent: { scope, recordId: mandate.recordId, kind: 'mandate' },
          })
        : null
    if (successor !== null) ledger.push(nativeComment(95, wire(successor)))
    appendControls(state, scope, mandate, successor, ledger)
    if (state === 'indeterminate') {
      const conflict = roxabiWorkflowFixtures().featureMandate(scope, {
        recordId: 'parent-mandate-conflicting',
        operationId: 'parent-mandate-conflicting-op',
      })
      comments.get(parent)?.push(nativeComment(91, wire(conflict)))
    }
  }
  function appendControls(
    current: State,
    scope: { repository: string; target: string },
    mandate: MandateRecord,
    successor: MandateRecord | null,
    ledger: NativeComment[],
  ) {
    const fixtures = roxabiWorkflowFixtures()
    if (current === 'paused' || current === 'unresolved-control') {
      const requested = fixtures.pauseRequested(mandate)
      ledger.push(nativeComment(92, wire(requested)))
      if (current === 'paused') ledger.push(nativeComment(93, wire(fixtures.pauseConfirmed(mandate, requested))))
    }
    if (current !== 'abandoned' && current !== 'revoked') return
    const abandoned = buildRecord({
      version: 1,
      ...scope,
      recordId: 'parent-abandon',
      runId: 'parent-run',
      operationId: 'parent-abandon-op',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'parent-abandon',
        predecessor: null,
        mandate: { scope, recordId: successor?.recordId ?? mandate.recordId, kind: 'mandate' },
      },
    })
    if (!abandoned.ok) throw new Error('invalid abandon fixture')
    ledger.push(nativeComment(94, wire(abandoned.value)))
  }
  if (
    route !== 'create-children' &&
    [
      'active',
      'indeterminate',
      'partial-claim',
      'invalid-claim',
      'unsupported',
      'paused',
      'abandoned',
      'revoked',
      'unresolved-control',
    ].includes(state)
  )
    activate()
  const graph = (args: string[]): string => {
    if (state === 'graph-unreadable') throw new Error('parent graph unavailable')
    const query = args.find((arg) => arg.startsWith('query=')) ?? ''
    if (query.includes('addSubIssue')) return insertChild(args)
    const number = Number(args.find((arg) => arg.startsWith('number='))?.slice(7))
    const issue = issues.get(number)
    if (!issue) throw new Error(`unknown issue ${number}`)
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
  function insertChild(args: string[]): string {
    const parentId = Number(args.find((arg) => arg.startsWith('parentId=node-'))?.slice(14))
    const childId = Number(args.find((arg) => arg.startsWith('childId=node-'))?.slice(13))
    const child = issues.get(childId)
    if (!issues.has(parentId) || child === undefined) throw new Error('unknown insertion')
    child.parent = parentId
    insertions += 1
    if (state === 'active-after-first-insertion' && insertions === 1) activate()
    return JSON.stringify({ data: { addSubIssue: {} } })
  }
  const gh: Gh = async (_cwd, args) => {
    if (args[0] === 'api' && args[1] === 'user') return 'automation'
    const response = issueRequest(args)
    if (response !== null) return response
    if (args[0] === 'issue' && args[1] === 'edit') return editLabels(args)
    if (args[1] === 'graphql') return graph(args)
    throw new Error(`unexpected GitHub request: ${args.join(' ')}`)
  }
  function issueRequest(args: string[]): string | null {
    const endpoint = args.find((arg) => arg.startsWith('repos/')) ?? ''
    const commentMatch = /issues\/(\d+)\/comments/.exec(endpoint)
    if (commentMatch) return commentRequest(endpoint, args, Number(commentMatch[1]))
    if (endpoint.endsWith('/issues') && args.includes('POST')) return createIssue(args)
    const issueMatch = /issues\/(\d+)$/.exec(endpoint)
    if (issueMatch && args.includes('PATCH')) return patchIssue(Number(issueMatch[1]), args)
    if (issueMatch && args.includes('.node_id')) return `node-${issueMatch[1]}`
    return null
  }
  function commentRequest(endpoint: string, args: string[], number: number): string {
    if (state === 'history-unreadable' && number === parent) throw new Error('parent history unavailable')
    const list = comments.get(number)
    if (!list) {
      forbidden.push(endpoint)
      throw new Error('unknown comment scope')
    }
    if (!args.includes('POST')) return JSON.stringify(list)
    const body = args.find((arg) => arg.startsWith('body='))?.slice(5)
    if (body === undefined) throw new Error('missing comment body')
    const item = nativeComment(100 + ++commentPosts, body)
    list.push(item)
    if (state === 'active-after-identity' && body.includes('kind=spec-identity')) activate()
    return JSON.stringify(item)
  }
  function createIssue(args: string[]): string {
    creates += 1
    issues.set(43, {
      title: args.find((arg) => arg.startsWith('title='))?.slice(6) ?? '',
      body: args.find((arg) => arg.startsWith('body='))?.slice(5) ?? '',
      labels: [],
      parent: null,
    })
    if (state === 'active-after-effect') activate()
    return '43'
  }
  function patchIssue(number: number, args: string[]): string {
    const issue = issues.get(number)
    if (!issue) throw new Error('unknown patch issue')
    for (const field of args) {
      if (field.startsWith('title=')) issue.title = field.slice(6)
      if (field.startsWith('body=')) issue.body = field.slice(5)
    }
    patches += 1
    return '{}'
  }
  function editLabels(args: string[]): string {
    const issue = issues.get(Number(args[2]))
    if (!issue) throw new Error('unknown label issue')
    const index = args.indexOf('--add-label')
    if (index >= 0) issue.labels.push(...(args[index + 1] ?? '').split(','))
    if (state === 'active-after-effect' && route.startsWith('update-')) activate()
    return ''
  }
  const confirmation = fixture({
    onConfirm: () => {
      confirmations += 1
    },
  })
  const operations = await createInstalledUwOperations({
    cwd: '/fixture',
    gh,
    readAuthor: 'automation',
    operator: confirmation.ports.operator,
  })
  const initial = options.identity ? input('new-criterion', 'Add an independently identified criterion') : createInput()
  const parentRoute = route === 'create-parent' || route === 'update-parent'
  const childRefs = [
    { repository: 'acme/app', number: 42 },
    ...(options.multiple ? [{ repository: 'acme/app', number: 44 }] : []),
  ]
  const relations = {
    addChildren: parentRoute ? [] : childRefs,
    removeChildren: [],
    addBlockers: [],
    removeBlockers: [],
    ...(parentRoute ? { parent: { repository: 'acme/app', number: 41 } } : {}),
  }
  const writes = { labels: { add: route.startsWith('update-') ? ['domain:billing'] : [], remove: [] }, relations }
  const created = { ...createInput(), repository: 'acme/app', normalization: [], writes }
  const target = route === 'update-parent' ? 42 : 41
  const updated = {
    ...initial,
    uw: { repository: 'acme/app', target: `acme/app#${target}` },
    sourceBodySha256: rawSource(`acme/app#${target}`, SOURCE_BODY, null).bodySha256,
    title: route === 'update-parent' ? 'Child' : 'Parent',
    normalization: options.identity ? initial.normalization : [],
    writes,
  }
  const run = () => (route.startsWith('update-') ? operations.write(updated) : operations.create(created))
  return {
    run,
    issues,
    comments,
    operations,
    forbidden,
    effects: () => ({ creates, patches, insertions, confirmations, commentPosts }),
  }
}

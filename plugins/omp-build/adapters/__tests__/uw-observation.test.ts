import { expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import { createReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import { assessUwCompletion } from '../../engine/uw-completion.ts'
import { scopeKey } from '../../engine/uw-graph.ts'
import { createWorkflowFixtures } from '../../testing/workflow-fixtures.ts'
import { githubScope } from '../github/transport.ts'
import { readUwCompletionObservation } from '../github-workflow/uw-observation.ts'

it('retains native graph and successful histories when a required history is unreadable', async () => {
  const root = githubScope('acme/app', 1)
  const blocker = githubScope('acme/app', 2)
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const ref = (number: number) => ({ number, repository: { nameWithOwner: 'acme/app' } })
  const observation = await readUwCompletionObservation(
    root,
    {
      cwd: '/fixture',
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        if (args[1] === 'graphql') {
          const number = Number(args.find((entry) => entry.startsWith('number='))?.slice(7))
          return JSON.stringify({
            data: {
              repository: {
                issue: {
                  number,
                  repository: { nameWithOwner: 'acme/app' },
                  title: `UW ${number}`,
                  body: '',
                  updatedAt: '2026-10-21T00:00:00Z',
                  state: 'OPEN',
                  stateReason: null,
                  parent: null,
                  labels: page([]),
                  subIssues: page([]),
                  blockedBy: page(number === 1 ? [ref(2)] : []),
                },
              },
            },
          })
        }
        if (String(args[1]).includes('/issues/2/comments')) throw new Error('blocker history unavailable')
        if (String(args[1]).includes('/issues/1/comments')) return '[]'
        throw new Error(`unexpected request ${args.join(' ')}`)
      },
    },
    async () => createReviewClassCatalogues([]),
  )
  expect(observation.status).toBe('incomplete')
  expect(observation.graph.nodes.map((node) => node.uw)).toEqual([root, blocker])
  expect(observation.histories.find((history) => history.source.scope.target === root.target)?.source.complete).toBe(
    true,
  )
  expect(observation.histories.find((history) => history.source.scope.target === blocker.target)?.source.complete).toBe(
    false,
  )
  if (observation.status === 'incomplete')
    expect(observation.diagnostics.some((entry) => entry.message.includes('blocker history unavailable'))).toBe(true)
})

it('observes unlinked candidates without turning factual seeds into dependency obligations', async () => {
  const root = githubScope('acme/app', 1)
  const managed = githubScope('acme/app', 2)
  const nativeOnly = githubScope('acme/app', 3)
  const editedAt = '2026-10-21T00:00:00Z'
  const body = '## Acceptance\n- [ ] Save keeps the selected region'
  const fixture = createWorkflowFixtures({
    productVersion: '0.18.8',
    config: { version: 'fixture/1', digest: canonicalValueDigest({}), effective: {} },
    head: 'a'.repeat(40),
    editedAt,
  })
  const mandate = fixture.featureMandate(managed, { body })
  const comments = fixture.framedBodies([mandate], 'operator').map((body, index) => ({
    id: index + 1,
    body,
    user: { login: 'operator' },
    created_at: editedAt,
    updated_at: editedAt,
  }))
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const graphResponse = (args: string[]) => {
    const numberArgument = args.find((entry) => entry.startsWith('number='))
    if (numberArgument === undefined) return JSON.stringify({ data: { repository: { pullRequests: page([]) } } })
    const number = Number(numberArgument.slice(7))
    if (![1, 2, 3].includes(number)) throw new Error(`unexpected UW ${number}`)
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            number,
            repository: { nameWithOwner: 'acme/app' },
            title: `UW ${number}`,
            body: number === 2 ? body : '',
            updatedAt: editedAt,
            state: number === 1 ? 'OPEN' : 'CLOSED',
            stateReason: number === 1 ? null : 'COMPLETED',
            parent: null,
            labels: page(number === 2 ? [{ name: 'size:S' }] : []),
            subIssues: page([]),
            blockedBy: page([]),
          },
        },
      },
    })
  }
  const observation = await readUwCompletionObservation(
    root,
    {
      cwd: '/fixture',
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        if (args[1] === 'graphql') return graphResponse(args)
        const path = String(args[1])
        if (path.includes('/issues/2/comments')) return JSON.stringify(comments)
        if (path.includes('/issues/1/comments') || path.includes('/issues/3/comments')) return '[]'
        throw new Error(`unexpected request ${args.join(' ')}`)
      },
    },
    async () => createReviewClassCatalogues([]),
    [managed, nativeOnly],
  )
  expect(observation.status).toBe('complete')
  expect(observation.delivery.map((facts) => facts.uw)).toEqual([managed])
  const assessment = assessUwCompletion(observation)
  expect(assessment.waits.requirements).toEqual([])
  expect(assessment.dependencies.get(scopeKey(managed))).toMatchObject({
    uw: managed,
    state: 'held',
    basis: { kind: 'accepted-uw' },
  })
  expect(assessment.dependencies.get(scopeKey(managed))?.diagnostics.map((entry) => entry.code)).toContain(
    'native-closure-unproven',
  )
  expect(assessment.dependencies.get(scopeKey(nativeOnly))).toMatchObject({
    uw: nativeOnly,
    state: 'satisfied',
    basis: { kind: 'native-only' },
  })
})

it('refreshes an earlier managed UW after delivery discovers additional PR histories', async () => {
  const root = githubScope('acme/app', 1)
  const sibling = githubScope('acme/app', 2)
  const editedAt = '2026-10-21T00:00:00Z'
  const body = '## Acceptance\n- [ ] Save keeps the selected region'
  const base = 'a'.repeat(40)
  const earlierHead = 'b'.repeat(40)
  const currentHead = 'c'.repeat(40)
  const fixture = createWorkflowFixtures({
    productVersion: '0.18.8',
    config: { version: 'fixture/1', digest: canonicalValueDigest({}), effective: {} },
    head: base,
    editedAt,
  })
  const first = fixture.featureMandate(root, { body, branch: 'feature/1' })
  const second = fixture.featureMandate(sibling, { body, branch: 'feature/2' })
  const firstHistory = fixture.historyFrom([first], 'operator')
  const secondHistory = fixture.historyFrom([second], 'operator')
  const binding1 = fixture.workflowBinding(githubScope('acme/app', 11), first, 'feature/1', 'main')
  const binding2 = fixture.workflowBinding(githubScope('acme/app', 12), second, 'feature/2', 'main')
  const comments = (bodies: string[]) =>
    bodies.map((body, index) => ({
      id: index + 1,
      body,
      user: { login: 'operator' },
      created_at: editedAt,
      updated_at: editedAt,
    }))
  const pages = new Map([
    [1, comments(fixture.framedBodies([first], 'operator'))],
    [2, comments(fixture.framedBodies([second], 'operator'))],
    [11, comments(fixture.framedBodies([binding1], 'operator', [firstHistory]))],
    [12, comments(fixture.framedBodies([binding2], 'operator', [secondHistory]))],
  ])
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  let firstHead = earlierHead
  const graphResponse = (args: string[]) => {
    const numberArgument = args.find((entry) => entry.startsWith('number='))
    if (numberArgument === undefined)
      return JSON.stringify({
        data: {
          repository: {
            pullRequests: page(
              [11, 12]
                .filter((number) => args.includes(`branch=feature/${number - 10}`))
                .map((number) => ({
                  number,
                  headRefName: `feature/${number - 10}`,
                  baseRefName: 'main',
                  repository: { nameWithOwner: 'acme/app' },
                })),
            ),
          },
        },
      })
    const number = Number(numberArgument.slice(7))
    if (number !== 1 && number !== 2) throw new Error(`unexpected UW ${number}`)
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            number,
            repository: { nameWithOwner: 'acme/app' },
            title: `UW ${number}`,
            body,
            updatedAt: editedAt,
            state: 'OPEN',
            stateReason: null,
            parent: null,
            labels: page([{ name: 'size:S' }]),
            subIssues: page([]),
            blockedBy: page([]),
          },
        },
      },
    })
  }
  const pullResponse = (args: string[]) => {
    const number = Number(args[2])
    if (number !== 11 && number !== 12) throw new Error(`unexpected PR ${number}`)
    // The second PR advances the independently observed first PR during this cut.
    if (number === 12) firstHead = currentHead
    return JSON.stringify({
      number,
      state: 'OPEN',
      headRefOid: number === 11 ? firstHead : base,
      headRefName: `feature/${number - 10}`,
      baseRefName: 'main',
      baseRefOid: base,
      mergeCommit: null,
      author: { login: 'operator' },
    })
  }
  const observation = await readUwCompletionObservation(
    root,
    {
      cwd: '/fixture',
      readAuthor: 'operator',
      gh: async (_cwd, args) => {
        if (args[1] === 'graphql') return graphResponse(args)
        if (args[0] === 'pr' && args[1] === 'view') return pullResponse(args)
        const match = /^repos\/acme\/app\/issues\/(\d+)\/comments\?per_page=100&page=1$/.exec(String(args[1]))
        if (match) {
          const result = pages.get(Number(match[1]))
          if (result) return JSON.stringify(result)
        }
        throw new Error(`unexpected request ${args.join(' ')}`)
      },
    },
    async () => createReviewClassCatalogues([]),
    [sibling],
  )
  expect(observation.status, JSON.stringify(observation.status === 'incomplete' ? observation.diagnostics : [])).toBe(
    'complete',
  )
  expect(observation.delivery.find((facts) => scopeKey(facts.uw) === scopeKey(root))?.pullRequests).toMatchObject([
    { pullRequest: githubScope('acme/app', 11), head: currentHead, state: 'OPEN' },
  ])
  expect(observation.delivery.find((facts) => scopeKey(facts.uw) === scopeKey(sibling))?.pullRequests).toMatchObject([
    { pullRequest: githubScope('acme/app', 12), state: 'OPEN' },
  ])
})

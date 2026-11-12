import { expect, it } from 'vitest'
import { canonicalValueDigest } from '../../engine/canonical-value.ts'
import { buildRecord, parseRecord } from '../../engine/record-construction.ts'
import { createReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import { selectWorkflowBinding } from '../../engine/workflow-pr-binding.ts'
import { createWorkflowFixtures } from '../../testing/workflow-fixtures.ts'
import { githubScope } from '../github/transport.ts'
import { createUwDeliveryFactReader } from '../github-workflow/uw-delivery-facts.ts'
import { readUwCompletionObservation } from '../github-workflow/uw-observation.ts'

const root = githubScope('acme/app', 1)
const other = githubScope('acme/app', 2)
const relevantPr = githubScope('acme/app', 11)
const unrelatedPr = githubScope('acme/app', 12)
const date = '2026-10-21T00:00:00Z'
const body = '## Acceptance\n- [ ] Save keeps the selected region'
const head = 'a'.repeat(40)
const fixture = createWorkflowFixtures({
  productVersion: '0.18.8',
  config: { version: 'fixture/1', digest: canonicalValueDigest({}), effective: {} },
  head,
  editedAt: date,
})
const current = fixture.featureMandate(root, { branch: 'feature/1', body })
const legacyFixture = createWorkflowFixtures({
  productVersion: '0.16.0',
  config: { version: 'fixture/1', digest: canonicalValueDigest({}), effective: {} },
  head,
  editedAt: date,
})
const legacyCurrent = legacyFixture.featureMandate(root, { branch: 'feature/1', body })
const legacyHistory = legacyFixture.historyFrom([legacyCurrent], 'operator')
const outside = fixture.featureMandate(other, {
  branch: 'feature/2',
  recordId: 'mandate-other',
  operationId: 'op-other',
  runId: 'run-other',
})
const currentHistory = fixture.historyFrom([current], 'operator')
const outsideHistory = fixture.historyFrom([outside], 'operator')
const currentBinding = fixture.workflowBinding(relevantPr, current, 'feature/1', 'main')
const outsideBinding = fixture.workflowBinding(unrelatedPr, outside, 'feature/2', 'main')
const rawLegacy = `<!-- omp-build-record v=1 kind=mandate id=${outside.recordId} operationId=${outside.operationId} part=1/1 data=${Buffer.from(
  JSON.stringify({ ...outside, payload: { ...outside.payload, format: 'omp-build-mandate/2' } }),
).toString('base64url')} -->\n# Legacy mandate`
const comment = (body: string, id: number, author = 'operator') => ({
  id,
  body,
  user: { login: author },
  created_at: date,
  updated_at: date,
})
const comments = (bodies: string[], author = 'operator') =>
  bodies.map((value, index) => comment(value, index + 1, author))
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })

function setup(order = [12, 11], legacy = false) {
  const pages = new Map<number, ReturnType<typeof comments>>([
    [1, comments(fixture.framedBodies([legacy ? legacyCurrent : current], 'operator'))],
    [2, comments([rawLegacy])],
    [11, comments(fixture.framedBodies([currentBinding], 'operator', [currentHistory]))],
    [12, comments(fixture.framedBodies([outsideBinding], 'operator', [outsideHistory]))],
  ])
  const requests: string[][] = []
  const options = {
    cwd: '/fixture',
    readAuthor: 'operator',
    gh: async (_cwd: string, args: string[]) => {
      requests.push(args)
      if (args[1] === 'graphql') {
        const numberArg = args.find((entry) => entry.startsWith('number='))
        if (numberArg === undefined)
          return JSON.stringify({
            data: {
              repository: {
                pullRequests: page(
                  order
                    .filter((number) => {
                      const branch = args.find((entry) => entry.startsWith('branch='))?.slice(7)
                      return branch === undefined || branch === `feature/${number - 10}`
                    })
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
        const number = Number(numberArg.slice(7))
        return JSON.stringify({
          data: {
            repository: {
              issue: {
                number,
                repository: { nameWithOwner: 'acme/app' },
                title: `UW ${number}`,
                body,
                updatedAt: date,
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
      if (args[0] === 'pr' && args[1] === 'view') {
        const number = Number(args[2])
        return JSON.stringify({
          number,
          state: 'OPEN',
          headRefOid: head,
          headRefName: `feature/${number - 10}`,
          baseRefName: 'main',
          baseRefOid: head,
          mergeCommit: null,
          author: { login: 'operator' },
        })
      }
      const match = /^repos\/acme\/app\/issues\/(\d+)\/comments\?per_page=100&page=1$/.exec(String(args[1]))
      if (match) return JSON.stringify(pages.get(Number(match[1])) ?? [])
      throw new Error(`unexpected request ${args.join(' ')}`)
    },
  }
  return { pages, options, requests, reader: createUwDeliveryFactReader(options) }
}

it.each([{ order: [12, 11] }, { order: [11, 12] }])(
  'locates only current-branch candidates in order $order',
  async ({ order }) => {
    const { reader, requests } = setup(order)
    const result = await reader.read(root, [currentHistory])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value.facts).toMatchObject({ uw: root, pullRequests: [{ pullRequest: relevantPr, state: 'OPEN' }] })
    const scopes = result.value.histories.map((history) => history.source.scope)
    expect(scopes).toContainEqual(relevantPr)
    expect(scopes).toContainEqual(root)
    expect(scopes).not.toContainEqual(unrelatedPr)
    expect(requests.some((args) => args.some((arg) => arg.includes('/issues/12/comments')))).toBe(false)
    const enumerations = requests.filter(
      (args) => args[1] === 'graphql' && !args.some((arg) => arg.startsWith('number=')),
    )
    expect(enumerations).toHaveLength(1)
    expect(enumerations[0]).toContain('branch=feature/1')
    expect(scopes).not.toContainEqual(other)
  },
)

it('keeps the completion cut complete and scoped to the current UW', async () => {
  const { options } = setup()
  const observation = await readUwCompletionObservation(root, options, async () => createReviewClassCatalogues([]))
  expect(observation.status).toBe('complete')
  expect(observation.delivery).toMatchObject([{ uw: root, pullRequests: [{ pullRequest: relevantPr }] }])
  const scopes = observation.histories.map((history) => history.source.scope)
  expect(scopes).toContainEqual(root)
  expect(scopes).toContainEqual(relevantPr)
  expect(scopes).not.toContainEqual(unrelatedPr)
  expect(scopes).not.toContainEqual(other)
})

it('retains a cached relevant home on a later read without retaining excluded candidates', async () => {
  const { reader } = setup([12, 11])
  const first = await reader.read(root, [currentHistory])
  expect(first).toMatchObject({ ok: true, value: { facts: { uw: root, pullRequests: [{ pullRequest: relevantPr }] } } })
  const second = await reader.read(root, [])
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.value.facts).toMatchObject({ uw: root, pullRequests: [{ pullRequest: relevantPr }] })
  const scopes = second.value.histories.map((history) => history.source.scope)
  expect(scopes).toContainEqual(root)
  expect(scopes).toContainEqual(relevantPr)
  expect(scopes).not.toContainEqual(unrelatedPr)
  expect(scopes).not.toContainEqual(other)
})

it('retains both predecessor and successor authority in the cached relevant home', async () => {
  const predecessor = fixture.mandateRef(current)
  const successorRef = { scope: root, recordId: 'mandate-successor', kind: 'mandate' as const }
  const successor = parseRecord({
    ...current,
    recordId: successorRef.recordId,
    operationId: 'op-successor',
    inputs: [current.recordId, ...current.inputs],
    payload: { ...current.payload, antecedent: predecessor },
  })
  if (!successor.ok) throw new Error('invalid successor fixture')
  const control = buildRecord({
    version: 1,
    ...root,
    recordId: 'select-successor',
    runId: 'run-successor',
    operationId: 'op-select-successor',
    kind: 'operator-control',
    payload: {
      control: 'select-successor',
      controlId: 'select-successor',
      mandate: predecessor,
      predecessor,
      successor: successorRef,
    },
  })
  if (!control.ok) throw new Error('invalid successor control fixture')
  const home = fixture.historyFrom([current, successor.value, control.value], 'operator')
  const successorBinding = fixture.workflowBinding(relevantPr, successor.value, 'feature/1', 'main')
  const { pages, reader } = setup([12, 11])
  pages.set(11, comments(fixture.framedBodies([currentBinding, successorBinding], 'operator', [home])))
  const first = await reader.read(root, [home])
  expect(first.ok).toBe(true)
  const second = await reader.read(root, [])
  expect(second.ok).toBe(true)
  if (!second.ok) return
  expect(second.value.facts).toMatchObject({ uw: root, pullRequests: [{ pullRequest: relevantPr }] })
  expect(
    selectWorkflowBinding({
      pullRequest: relevantPr,
      histories: second.value.histories,
      native: { branch: 'feature/1', base: 'main' },
    }),
  ).toMatchObject({ status: 'bound', mandate: successorRef })
  const retained = second.value.histories.find((history) => history.source.scope.target === root.target)
  expect(retained?.operations.map((operation) => operation.record?.recordId)).toEqual(
    expect.arrayContaining([current.recordId, successorRef.recordId, 'select-successor']),
  )
  expect(second.value.histories.map((history) => history.source.scope)).not.toContainEqual(unrelatedPr)
})

it('keeps a required blocker unreadable even when its bound PR is excluded', async () => {
  const { options } = setup([12, 11])
  const gh = options.gh
  const observation = await readUwCompletionObservation(
    root,
    {
      ...options,
      gh: async (cwd, args) => {
        if (args.some((arg) => arg.includes('/issues/2/comments'))) throw new Error('required blocker unavailable')
        const result = await gh(cwd, args)
        if (args[1] !== 'graphql' || !args.includes('number=1')) return result
        const graph = JSON.parse(result) as { data: { repository: { issue: { blockedBy: ReturnType<typeof page> } } } }
        graph.data.repository.issue.blockedBy = page([{ number: 2, repository: { nameWithOwner: 'acme/app' } }])
        return JSON.stringify(graph)
      },
    },
    async () => createReviewClassCatalogues([]),
  )
  expect(observation.status).toBe('incomplete')
  expect(observation.graph.nodes.map((node) => node.uw)).toContainEqual(other)
  expect(observation.histories.find((history) => history.source.scope.target === other.target)?.source.complete).toBe(
    false,
  )
  if (observation.status === 'incomplete') {
    expect(observation.diagnostics.map((entry) => entry.message)).toEqual(
      expect.arrayContaining([expect.stringContaining('required blocker unavailable')]),
    )
  }
  expect(observation.delivery.find((facts) => facts.uw.target === root.target)?.pullRequests).toMatchObject([
    { pullRequest: relevantPr },
  ])
  expect(observation.histories.map((history) => history.source.scope)).not.toContainEqual(unrelatedPr)
})

it('preserves an independently required legacy seed instead of globally redacting it', async () => {
  const { options } = setup([12, 11])
  const observation = await readUwCompletionObservation(root, options, async () => createReviewClassCatalogues([]), [
    other,
  ])
  const retained = observation.histories.find((history) => history.source.scope.target === other.target)
  expect(retained?.diagnostics).toEqual(
    expect.arrayContaining([expect.objectContaining({ code: 'incompatible-format' })]),
  )
})

it('refuses uncovered legacy history before reading native PRs', async () => {
  const { reader, requests } = setup([12], true)
  const result = await reader.read(root, [legacyHistory])
  expect(result).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'legacy-coverage-incomplete' })],
  })
  expect(requests).toEqual([])
})

it('uses exhaustive relevance only for an explicit uncovered legacy succession', async () => {
  const { reader, pages, requests } = setup([12, 11], true)
  const binding = legacyFixture.workflowBinding(relevantPr, legacyCurrent, 'feature/1', 'main')
  pages.set(11, comments(legacyFixture.framedBodies([binding], 'operator', [legacyHistory])))
  const result = await reader.read(root, [legacyHistory], 'legacy-succession')
  expect(result).toMatchObject({
    ok: true,
    value: { facts: { uw: root, pullRequests: [{ pullRequest: relevantPr }] } },
  })
  const enumerations = requests.filter(
    (args) => args[1] === 'graphql' && !args.some((arg) => arg.startsWith('number=')),
  )
  expect(enumerations).toHaveLength(1)
  expect(enumerations[0]?.some((arg) => arg.startsWith('branch='))).toBe(false)
  expect(requests.some((args) => args.some((arg) => arg.includes('/issues/12/comments')))).toBe(true)
  if (!result.ok) return
  expect(result.value.histories.map((history) => history.source.scope)).not.toContainEqual(unrelatedPr)
})

it('keeps explicit succession branch-filtered for a new-policy home', async () => {
  const { reader, requests } = setup()
  const result = await reader.read(root, [currentHistory], 'legacy-succession')
  expect(result).toMatchObject({
    ok: true,
    value: { facts: { uw: root, pullRequests: [{ pullRequest: relevantPr }] } },
  })
  const enumerations = requests.filter(
    (args) => args[1] === 'graphql' && !args.some((arg) => arg.startsWith('number=')),
  )
  expect(enumerations).toHaveLength(1)
  expect(enumerations[0]).toContain('branch=feature/1')
  expect(requests.some((args) => args.some((arg) => arg.includes('/issues/12/comments')))).toBe(false)
})

it.each([{ outsideFirst: false }, { outsideFirst: true }])(
  'does not exclude a mixed relevant and legacy binding chain (outside first: $outsideFirst)',
  async ({ outsideFirst }) => {
    const { reader, pages } = setup([11])
    const mixed = fixture.workflowBinding(relevantPr, outside, 'feature/1', 'main')
    const bindings = outsideFirst ? [mixed, currentBinding] : [currentBinding, mixed]
    pages.set(11, comments(fixture.framedBodies(bindings, 'operator', [currentHistory, outsideHistory])))
    const result = await reader.read(root, [currentHistory])
    expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'incompatible-format' })] })
    if (result.ok) return
    const retained = result.partial.histories.find((history) => history.source.scope.target === other.target)
    expect(retained?.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'incompatible-format' })]),
    )
  },
)

it('does not treat unresolved nonbinding work as an empty binding history', async () => {
  const { reader, pages } = setup([12], true)
  pages.set(12, [comment('<!-- omp-build-record v=1 kind=mandate id=bad operationId=bad-op part=1/2 data=e30 -->', 1)])
  const result = await reader.read(root, [legacyHistory], 'legacy-succession')
  expect(result).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ code: 'unconfirmed' })] })
})

it('accepts a clean unbound PR as absence, but not a foreign-only binding', async () => {
  const clean = setup([12], true)
  clean.pages.set(12, [])
  expect(await clean.reader.read(root, [legacyHistory], 'legacy-succession')).toMatchObject({
    ok: true,
    value: { facts: { uw: root, pullRequests: [] } },
  })
  const foreign = setup([12], true)
  foreign.pages.set(12, comments(fixture.framedBodies([outsideBinding], 'operator', [outsideHistory]), 'stranger'))
  expect(await foreign.reader.read(root, [legacyHistory], 'legacy-succession')).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'foreign' })],
  })
})

it('refuses a binding whose native branch disagrees, even when its home is unrelated', async () => {
  const { reader, pages } = setup([12], true)
  const wrong = fixture.workflowBinding(unrelatedPr, outside, 'different', 'main')
  pages.set(12, comments(fixture.framedBodies([wrong], 'operator', [outsideHistory])))
  expect(await reader.read(root, [legacyHistory], 'legacy-succession')).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'native-mismatch' })],
  })
})

it('refuses a malformed binding claim even alongside a valid unrelated claim', async () => {
  const { reader, pages } = setup([12], true)
  const existing = pages.get(12)
  if (!existing) throw new Error('missing PR fixture')
  pages.set(12, [
    ...existing,
    comment('<!-- omp-build-record v=1 kind=workflow-binding id=bad operationId=bad-op part=1/2 data=e30 -->', 100),
  ])
  expect(await reader.read(root, [legacyHistory], 'legacy-succession')).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'incomplete' })],
  })
})

it('refuses an unreadable candidate history rather than treating it as unrelated', async () => {
  const { options } = setup([12], true)
  const gh = options.gh
  const reader = createUwDeliveryFactReader({
    ...options,
    gh: async (cwd, args) => {
      if (args.some((arg) => arg.includes('/issues/12/comments'))) throw new Error('history unavailable')
      return gh(cwd, args)
    },
  })
  expect(await reader.read(root, [legacyHistory], 'legacy-succession')).toMatchObject({
    ok: false,
    diagnostics: [expect.objectContaining({ code: 'incomplete' })],
  })
})

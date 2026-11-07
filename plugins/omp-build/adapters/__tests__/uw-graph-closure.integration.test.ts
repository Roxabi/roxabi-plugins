import { describe, expect, it } from 'vitest'
import { createReviewClassCatalogues } from '../../engine/review-class-catalogue.ts'
import { assessUwCompletion } from '../../engine/uw-completion.ts'
import { scopeKey, validateUwGraph } from '../../engine/uw-graph.ts'
import { projectUwWaits } from '../../engine/uw-waits.ts'
import { type GraphFixture, graphGh } from '../../testing/uw-paginated-graph-fixture.ts'
import { githubScope } from '../github/transport.ts'
import type { Gh } from '../github/types.ts'
import { readUwCompletionObservation } from '../github-workflow/uw-observation.ts'

const root = githubScope('acme/app', 1)
const child = githubScope('acme/app', 2)
const otherParent = githubScope('acme/app', 3)
const external = githubScope('acme/service', 4)
const externalParent = githubScope('acme/service', 5)
const ref = (repository: string, number: number) => ({ repository, number })
const spec = '## Acceptance\n- [ ] Save keeps the selected region\n'
const time = '2026-10-27T12:00:00Z'

// The transport declares only GitHub responses. Collection, decoding and all
// graph and completion decisions remain production code.
async function observe(fixtures: Record<string, GraphFixture>, repeatLabels = false) {
  const graph = graphGh(fixtures, repeatLabels)
  const gh: Gh = async (cwd, args) => {
    if (args[1] === 'graphql') return graph(cwd, args)
    const match = /^repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '')
    if (!match || !Object.hasOwn(fixtures, `${match[1]}#${match[2]}`) || match[3] !== '1')
      throw new Error(`undeclared GitHub request ${args.join(' ')}`)
    return '[]'
  }
  return readUwCompletionObservation(root, { cwd: '/fixture', readAuthor: 'operator', gh }, async () =>
    createReviewClassCatalogues([]),
  )
}

const issue = (extra: GraphFixture = {}): GraphFixture => ({
  body: spec,
  updatedAt: time,
  labels: ['size:S'],
  state: 'OPEN',
  stateReason: null,
  ...extra,
})
const edge = (from: typeof root, to: typeof root, kind: 'native-child' | 'native-blocker') => ({
  from,
  to,
  source: { kind },
})

describe('collected Native graph closure', () => {
  it('satisfies an actual cross-repository blocker under a different parent only with complete native-only absence', async () => {
    const observed = await observe({
      'acme/app#1': issue({ children: [2] }),
      'acme/app#2': issue({ parent: 1, blockers: [ref('acme/service', 4)] }),
      'acme/service#4': issue({ parent: 5, state: 'CLOSED', stateReason: 'COMPLETED' }),
      'acme/service#5': issue({ children: [4] }),
    })
    expect(observed.status).toBe('complete')
    expect(validateUwGraph(observed.graph)).toEqual({ ok: true, diagnostics: [] })
    const waits = projectUwWaits(observed)
    expect(waits.requirements).toContainEqual(edge(child, external, 'native-blocker'))
    expect(waits.requirements).toContainEqual(edge(externalParent, external, 'native-child'))
    const resolution = assessUwCompletion(observed).dependencies.get(scopeKey(external))
    expect(
      observed.histories.map((history) => ({
        scope: history.source.scope,
        complete: history.source.complete,
        operations: history.operations,
        diagnostics: history.diagnostics,
      })),
    ).toEqual(
      expect.arrayContaining([
        { scope: root, complete: true, operations: [], diagnostics: [] },
        { scope: child, complete: true, operations: [], diagnostics: [] },
        { scope: external, complete: true, operations: [], diagnostics: [] },
        { scope: externalParent, complete: true, operations: [], diagnostics: [] },
      ]),
    )
    expect(resolution).toMatchObject({
      uw: external,
      state: 'satisfied',
      basis: {
        kind: 'native-only',
        witness: {
          uw: external,
          history: {
            source: { scope: external, complete: true, comments: [], diagnostics: [] },
            operations: [],
            diagnostics: [],
          },
          observation: { status: 'complete' },
        },
      },
      completion: null,
      diagnostics: [],
    })
  })

  it('retains both competing parent claims and refuses them in graph validation', async () => {
    const observed = await observe({
      'acme/app#1': issue({ children: [2], blockers: [3] }),
      'acme/app#2': issue({ parent: 1 }),
      'acme/app#3': issue({ children: [2] }),
    })
    expect(observed.status).toBe('complete')
    expect(observed.graph.status).toBe('complete')
    expect(observed.graph.nodes.find((node) => scopeKey(node.uw) === scopeKey(root))?.children).toEqual([child])
    expect(observed.graph.nodes.find((node) => scopeKey(node.uw) === scopeKey(otherParent))?.children).toEqual([child])
    expect(observed.graph.nodes.find((node) => scopeKey(node.uw) === scopeKey(child))?.parent).toEqual(root)
    const result = validateUwGraph(observed.graph)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'multiple-parents',
        location: expect.objectContaining({ kind: 'native', uw: child, connection: 'parent' }),
        related: expect.arrayContaining([
          { kind: 'native', uw: root, connection: 'children' },
          { kind: 'native', uw: otherParent, connection: 'children' },
        ]),
      }),
    )
    expect(projectUwWaits(observed).requirements).toEqual(
      expect.arrayContaining([edge(root, child, 'native-child'), edge(otherParent, child, 'native-child')]),
    )
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(child))).toMatchObject({
      state: 'held',
      basis: { kind: 'unresolved' },
    })
  })

  it('refuses a cross-repository child while permitting a cross-repository blocker', async () => {
    const observed = await observe({
      'acme/app#1': issue({ children: [ref('acme/service', 4)], blockers: [ref('acme/service', 5)] }),
      'acme/service#4': issue({ parent: ref('acme/app', 1) }),
      'acme/service#5': issue({ state: 'CLOSED', stateReason: 'COMPLETED' }),
    })
    expect(observed.status).toBe('complete')
    const result = validateUwGraph(observed.graph)
    expect(result.ok).toBe(false)
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'cross-repository-child',
        location: { kind: 'native', uw: root, connection: 'children' },
        related: [{ kind: 'native', uw: external, connection: 'parent' }],
      }),
    )
    expect(projectUwWaits(observed).requirements).toEqual(
      expect.arrayContaining([edge(root, external, 'native-child'), edge(root, externalParent, 'native-blocker')]),
    )
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(externalParent))).toMatchObject({
      state: 'held',
      basis: { kind: 'unresolved' },
    })
  })

  it('detects a reciprocal hierarchy cycle in the collected graph', async () => {
    const observed = await observe({
      'acme/app#1': issue({ parent: 2, children: [2] }),
      'acme/app#2': issue({ parent: 1, children: [1] }),
    })
    expect(observed.status).toBe('complete')
    expect(validateUwGraph(observed.graph).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'graph-cycle', location: { kind: 'native', uw: root, connection: 'state' } }),
    )
    const waits = projectUwWaits(observed)
    expect(waits.requirements).toEqual(
      expect.arrayContaining([edge(root, child, 'native-child'), edge(child, root, 'native-child')]),
    )
    expect(waits.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'wait-cycle', location: { kind: 'native', uw: root, connection: 'state' } }),
    )
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(root))).toMatchObject({ state: 'held' })
  })

  it('detects a parent waiting for a child that is explicitly blocked by that parent', async () => {
    const observed = await observe({
      'acme/app#1': issue({ children: [2] }),
      'acme/app#2': issue({ parent: 1, blockers: [1] }),
    })
    expect(observed.status).toBe('complete')
    const waits = projectUwWaits(observed)
    expect(waits.requirements).toEqual(
      expect.arrayContaining([edge(root, child, 'native-child'), edge(child, root, 'native-blocker')]),
    )
    expect(waits.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'wait-cycle',
        location: { kind: 'native', uw: root, connection: 'state' },
        related: [
          { kind: 'native', uw: root, connection: 'children' },
          { kind: 'native', uw: child, connection: 'blockers' },
        ],
      }),
    )
    expect(validateUwGraph(observed.graph).diagnostics).toContainEqual(
      expect.objectContaining({ code: 'graph-cycle', location: { kind: 'native', uw: root, connection: 'state' } }),
    )
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(child))).toMatchObject({
      state: 'held',
      basis: { kind: 'unresolved' },
    })
  })

  it('collects a blocker on the second page and classifies its actual closed state', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => index + 10)
    const fixtures: Record<string, GraphFixture> = Object.fromEntries(
      firstPage.map((number) => [`acme/app#${number}`, issue({ state: 'CLOSED', stateReason: 'COMPLETED' })]),
    )
    fixtures['acme/app#1'] = issue({ blockers: [...firstPage, ref('acme/service', 4)] })
    fixtures['acme/service#4'] = issue({ state: 'CLOSED', stateReason: 'COMPLETED' })
    const observed = await observe(fixtures)
    expect(observed.status).toBe('complete')
    expect(validateUwGraph(observed.graph)).toEqual({ ok: true, diagnostics: [] })
    expect(observed.graph.nodes.find((node) => scopeKey(node.uw) === scopeKey(root))?.blockers).toContainEqual(external)
    expect(projectUwWaits(observed).requirements).toContainEqual(edge(root, external, 'native-blocker'))
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(external))).toMatchObject({
      uw: external,
      state: 'satisfied',
      basis: { kind: 'native-only', witness: { history: { source: { scope: external, complete: true } } } },
    })
  })

  it('uses a wayfinder label on the second page when deciding whether a completed blocker is satisfied', async () => {
    const observed = await observe({
      'acme/app#1': issue({ blockers: [2] }),
      'acme/app#2': issue({
        labels: ['size:S', ...Array.from({ length: 99 }, (_, index) => `topic:${index}`), 'wayfinder:task'],
        state: 'CLOSED',
        stateReason: 'COMPLETED',
      }),
    })
    expect(observed.status).toBe('complete')
    expect(validateUwGraph(observed.graph)).toEqual({ ok: true, diagnostics: [] })
    expect(projectUwWaits(observed).requirements).toContainEqual(edge(root, child, 'native-blocker'))
    expect(observed.graph.nodes.find((node) => scopeKey(node.uw) === scopeKey(child))?.wayfinderLabels).toEqual([
      'wayfinder:task',
    ])
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(child))).toMatchObject({
      uw: child,
      state: 'held',
      basis: { kind: 'native-only' },
      diagnostics: [expect.objectContaining({ code: 'native-not-completed' })],
    })
  })

  it('retains earlier blocker and history facts but never satisfies a dependency after a repeated cursor', async () => {
    const observed = await observe(
      {
        'acme/app#1': issue({ blockers: [2] }),
        'acme/app#2': issue({
          labels: ['size:S', ...Array.from({ length: 200 }, (_, index) => `topic:${index}`)],
          state: 'CLOSED',
          stateReason: 'COMPLETED',
        }),
      },
      true,
    )
    expect(observed.status).toBe('incomplete')
    expect(observed.graph.status).toBe('incomplete')
    expect(observed.graph.nodes.find((node) => scopeKey(node.uw) === scopeKey(root))?.blockers).toEqual([child])
    expect(observed.histories.find((history) => scopeKey(history.source.scope) === scopeKey(child))).toMatchObject({
      source: { scope: child, complete: true, comments: [] },
      operations: [],
      diagnostics: [],
    })
    expect(validateUwGraph(observed.graph).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'graph-incomplete',
        location: { kind: 'native', uw: child, connection: 'labels', page: 2, cursor: 'repeat' },
        message: expect.stringContaining('repeats a cursor'),
      }),
    )
    expect(projectUwWaits(observed).requirements).toContainEqual(edge(root, child, 'native-blocker'))
    expect(assessUwCompletion(observed).dependencies.get(scopeKey(child))).toMatchObject({
      uw: child,
      state: 'held',
      basis: { kind: 'unresolved' },
      diagnostics: [expect.objectContaining({ code: 'observation-incomplete' })],
    })
  })
})

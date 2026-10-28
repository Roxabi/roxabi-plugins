import { describe, expect, it } from 'vitest'
import { assessUwAdmission } from '../../engine/uw-admission.ts'
import type { UwGraphObservation } from '../../engine/uw-graph.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { githubScope } from '../github/transport.ts'
import type { Gh } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph.ts'

const root = githubScope('acme/app', 1)
const blocker = githubScope('acme/app', 2)
const observedAt = '2026-10-27T12:00:00Z'

type Route = 'correct-open' | 'correct-completed' | 'correct-label-page' | 'wrong-first' | 'wrong-label-page'

function variable(args: string[], name: string): string | undefined {
  return args
    .flatMap((arg, index) => (arg === '-f' || arg === '-F' ? [args[index + 1] ?? ''] : []))
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function routeFixture(route: Route, requested: number, cursor: string | undefined) {
  if (requested !== 1 && requested !== 2) throw new Error(`unexpected issue #${requested}`)
  const wrong = requested === 2 && (route === 'wrong-first' || (route === 'wrong-label-page' && cursor !== undefined))
  return {
    number: wrong ? 3 : requested,
    paginate:
      requested === 2 && (route === 'wrong-label-page' || route === 'correct-label-page') && cursor === undefined,
    completed: wrong || (requested === 2 && route === 'correct-completed'),
  }
}

function responseFixture(route: Route, requested: number, cursor: string | undefined) {
  const { number, paginate, completed } = routeFixture(route, requested, cursor)
  const labels = cursor === undefined ? [{ name: 'size:S' }] : [{ name: 'foreign-page-label' }]
  const empty = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } }
  return {
    data: {
      repository: {
        issue: {
          number,
          title: `UW ${number}`,
          body: `body ${number}`,
          updatedAt: observedAt,
          state: completed ? 'CLOSED' : 'OPEN',
          stateReason: completed ? 'COMPLETED' : null,
          repository: { nameWithOwner: 'acme/app' },
          parent: null,
          labels: { nodes: labels, pageInfo: { hasNextPage: paginate, endCursor: paginate ? 'next-labels' : null } },
          subIssues: empty,
          blockedBy:
            requested === 1 ? { ...empty, nodes: [{ number: 2, repository: { nameWithOwner: 'acme/app' } }] } : empty,
        },
      },
    },
  }
}

function transport(route: Route): Gh {
  return async (_cwd, args) => {
    const requested = Number(variable(args, 'number'))
    const cursor = variable(args, 'labelsCursor')
    return JSON.stringify(responseFixture(route, requested, cursor))
  }
}

function admission(graph: UwGraphObservation) {
  const spec = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement: 'Deliver the own commitment' }],
    invariants: [],
    exclusions: [],
    openQuestions: [],
    sections: { origin: '', context: '', change: '' },
  })
  if (!spec.ok) throw new Error('invalid test spec')
  const rootNode = graph.nodes.find((node) => node.uw.target === root.target)
  if (!rootNode) throw new Error('missing test root')
  return assessUwAdmission({
    uw: root,
    graph,
    proposed: { ok: true, snapshot: { spec: spec.value, raw: rootNode.raw } },
    accepted: { status: 'absent' },
    identities: {
      uw: root,
      head: null,
      nextCriterion: '2',
      nextInvariant: '1',
      allocations: new Map([['C1', { scope: root, recordId: 'identity-C1', kind: 'spec-identity' }]]),
      retired: new Map(),
    },
    phase: 'initial-selection',
  })
}

async function read(route: Route) {
  return readUwGraph(root, { cwd: '/fixture', gh: transport(route) })
}

describe('native graph issue coordinates', () => {
  it('admits only a correctly identified completed blocker, not the same open blocker', async () => {
    const open = await read('correct-open')
    const completed = await read('correct-completed')
    expect(open.status).toBe('complete')
    expect(completed.status).toBe('complete')
    expect(admission(open).deliverable.diagnostics).toContainEqual(
      expect.objectContaining({ code: 'blocker-not-completed' }),
    )
    expect(admission(open).deliverable.ok).toBe(false)
    expect(admission(completed).deliverable.ok).toBe(true)
    const paginated = await read('correct-label-page')
    expect(paginated.status).toBe('complete')
    expect(paginated.nodes.find((node) => node.uw.target === blocker.target)?.labels).toEqual([
      'size:S',
      'foreign-page-label',
    ])
  })

  it('rejects a same-repository completed issue returned for the open blocker on its first page', async () => {
    const graph = await read('wrong-first')
    const result = admission(graph)
    expect(result.deliverable.ok).toBe(false)
    expect(graph.status).toBe('incomplete')
    if (graph.status !== 'incomplete') throw new Error('expected incomplete graph')
    expect(graph.nodes.some((node) => node.uw.target === blocker.target)).toBe(false)
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'graph-incomplete',
        location: { kind: 'native', uw: blocker, connection: 'state', page: 1 },
      }),
    )
  })

  it('rejects a different issue on a subsequent connection page without merging its labels', async () => {
    const graph = await read('wrong-label-page')
    const result = admission(graph)
    expect(result.deliverable.ok).toBe(false)
    expect(graph.status).toBe('incomplete')
    if (graph.status !== 'incomplete') throw new Error('expected incomplete graph')
    const node = graph.nodes.find((entry) => entry.uw.target === blocker.target)
    expect(node?.native).toEqual({ state: 'OPEN', stateReason: null })
    expect(node?.labels).toEqual(['size:S'])
    expect(result.deliverable.diagnostics).toContainEqual(expect.objectContaining({ code: 'blocker-not-completed' }))
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'graph-incomplete',
        location: { kind: 'native', uw: blocker, connection: 'labels', page: 2, cursor: 'next-labels' },
      }),
    )
  })
})

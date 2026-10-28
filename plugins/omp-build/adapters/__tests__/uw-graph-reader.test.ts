import { describe, expect, it } from 'vitest'
import { githubScope } from '../github/transport.ts'
import type { Gh } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph.ts'

type Fixture = {
  labels?: string[]
  children?: number[]
  blockers?: number[]
  state?: 'OPEN' | 'CLOSED'
  stateReason?: string | null
  deny?: boolean
}

function variable(args: string[], name: string): string | undefined {
  return args
    .flatMap((arg, index) => (arg === '-f' || arg === '-F' ? [args[index + 1] ?? ''] : []))
    .find((pair) => pair.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}
function page<T>(values: readonly T[], cursor: string | undefined, repeat = false) {
  const parsedCursor = cursor === undefined ? 0 : Number(cursor)
  const offset = Number.isSafeInteger(parsedCursor) && parsedCursor >= 0 ? parsedCursor : 0
  const nodes = values.slice(offset, offset + 100)
  const next = offset + nodes.length
  return {
    nodes,
    pageInfo: {
      hasNextPage: next < values.length,
      endCursor: next < values.length ? (repeat ? 'repeat' : String(next)) : null,
    },
  }
}
function graphGh(fixtures: Record<number, Fixture>, repeatLabels = false): Gh {
  return async (_cwd, args) => {
    const number = Number(variable(args, 'number'))
    const fixture = fixtures[number]
    if (!fixture || fixture.deny) throw new Error(`issue #${number} is unreadable`)
    const parent = Object.entries(fixtures).find(([, candidate]) => candidate.children?.includes(number))
    const node = (child: number) => ({ number: child, repository: { nameWithOwner: 'acme/app' } })
    return JSON.stringify({
      data: {
        repository: {
          issue: {
            number,
            title: `UW ${number}`,
            body: `body ${number}`,
            updatedAt: `2026-10-27T12:00:${String(number).padStart(2, '0')}Z`,
            state: fixture.state ?? 'OPEN',
            stateReason: fixture.stateReason ?? null,
            repository: { nameWithOwner: 'acme/app' },
            parent: parent ? node(Number(parent[0])) : null,
            labels: page(
              (fixture.labels ?? []).map((name) => ({ name })),
              variable(args, 'labelsCursor'),
              repeatLabels,
            ),
            subIssues: page((fixture.children ?? []).map(node), variable(args, 'childrenCursor')),
            blockedBy: page((fixture.blockers ?? []).map(node), variable(args, 'blockersCursor')),
          },
        },
      },
    })
  }
}

describe('readUwGraph', () => {
  it('independently exhausts >100 labels and children through the injected Gh transport', async () => {
    const children = Array.from({ length: 101 }, (_, index) => index + 2)
    const fixtures: Record<number, Fixture> = {
      1: { labels: Array.from({ length: 101 }, (_, index) => `label-${index}`), children },
    }
    for (const child of children) fixtures[child] = {}

    const graph = await readUwGraph(githubScope('acme/app', 1), { cwd: '/fixture', gh: graphGh(fixtures) })

    expect(graph).toMatchObject({ status: 'complete' })
    expect(graph.nodes).toHaveLength(102)
    expect(graph.nodes.find((node) => node.uw.target === 'acme/app#1')?.labels).toHaveLength(101)
  })

  it('retains a combined parent-child-blocker cycle as native facts for engine D8 validation', async () => {
    const graph = await readUwGraph(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { children: [2] }, 2: { blockers: [3] }, 3: { blockers: [1] } }),
    })

    expect(graph).toMatchObject({ status: 'complete' })
    expect(graph.nodes.map((node) => node.uw.target)).toEqual(['acme/app#1', 'acme/app#2', 'acme/app#3'])
    expect(graph.nodes.find((node) => node.uw.target === 'acme/app#2')?.blockers.map((node) => node.target)).toEqual([
      'acme/app#3',
    ])
  })

  it('names a repeated cursor as incomplete instead of treating the remaining labels as absent', async () => {
    const graph = await readUwGraph(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { labels: Array.from({ length: 201 }, (_, index) => `l${index}`) } }, true),
    })

    expect(graph).toMatchObject({ status: 'incomplete' })
    if (graph.status !== 'incomplete') throw new Error('expected incomplete graph')
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({ code: 'graph-incomplete' }))
  })

  it('names a distant unreadable blocker as incomplete without declaring the truncated graph acyclic', async () => {
    const graph = await readUwGraph(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { blockers: [2] }, 2: { deny: true } }),
    })

    expect(graph).toMatchObject({
      status: 'incomplete',
      nodes: [expect.objectContaining({ uw: githubScope('acme/app', 1) })],
    })
  })
})

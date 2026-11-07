import { describe, expect, it } from 'vitest'
import { validateUwGraph } from '../../engine/uw-graph.ts'
import {
  type GraphFixture as Fixture,
  graphGh,
  graphFixtureVariable as variable,
} from '../../testing/uw-paginated-graph-fixture.ts'
import { githubScope } from '../github/transport.ts'
import type { Gh } from '../github/types.ts'
import { readUwGraph } from '../github-native/uw-graph.ts'
import { readUwSubtree } from '../github-native/uw-graph-reader.ts'

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

  it('refuses an uncanonical repository identity rather than joining it to another scope', async () => {
    const graph = await readUwGraph(githubScope('Acme/App', 1), { cwd: '/fixture', gh: graphGh({ 1: {} }) })
    expect(graph.status).toBe('incomplete')
    if (graph.status !== 'incomplete') throw new Error('expected incomplete graph')
    expect(graph.nodes.some((node) => node.uw.repository === 'acme/app')).toBe(false)
    expect(graph.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          location: expect.objectContaining({ uw: githubScope('Acme/App', 1), connection: 'state' }),
        }),
      ]),
    )
  })

  it('exhausts blocker pages and retains every referenced issue', async () => {
    const blockers = Array.from({ length: 101 }, (_, index) => index + 2)
    const fixtures: Record<number, Fixture> = { 1: { blockers } }
    for (const blocker of blockers) fixtures[blocker] = {}
    const graph = await readUwGraph(githubScope('acme/app', 1), { cwd: '/fixture', gh: graphGh(fixtures) })
    expect(graph.status).toBe('complete')
    expect(graph.nodes).toHaveLength(102)
    expect(graph.nodes[0]?.blockers).toHaveLength(101)
  })

  it('retains both parent claims while holding an inconsistent hierarchy', async () => {
    const graph = await readUwGraph(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { children: [3], blockers: [2] }, 2: { children: [3] }, 3: {} }),
    })
    expect(graph.status).toBe('complete')
    expect(validateUwGraph(graph)).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'multiple-parents' })]),
    })
    expect(graph.nodes.find((node) => node.uw.target === 'acme/app#1')?.children).toEqual([githubScope('acme/app', 3)])
    expect(graph.nodes.find((node) => node.uw.target === 'acme/app#2')?.children).toEqual([githubScope('acme/app', 3)])
    expect(graph.nodes.find((node) => node.uw.target === 'acme/app#3')?.parent).toEqual(githubScope('acme/app', 1))
  })

  it('retains first-page facts but refuses changed issue metadata on a later page', async () => {
    const transport = graphGh({ 1: { labels: Array.from({ length: 101 }, (_, index) => `l${index}`) } })
    const gh: Gh = async (cwd, args) => {
      const response = JSON.parse(await transport(cwd, args))
      if (variable(args, 'labelsCursor') !== undefined) response.data.repository.issue.state = 'CLOSED'
      return JSON.stringify(response)
    }
    const graph = await readUwGraph(githubScope('acme/app', 1), { cwd: '/fixture', gh })
    expect(graph.status).toBe('incomplete')
    expect(graph.nodes[0]?.native.state).toBe('OPEN')
    expect(graph.nodes[0]?.labels).toHaveLength(101)
    if (graph.status !== 'incomplete') throw new Error('expected incomplete graph')
    expect(graph.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'graph-incomplete',
        location: expect.objectContaining({ connection: 'labels', page: 2 }),
        message: expect.stringContaining('changed between pages'),
      }),
    )
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

describe('readUwSubtree', () => {
  it('visits descendants only, without loading a parent, sibling or blocker', async () => {
    const visited: number[] = []
    const transport = graphGh({
      1: { children: [2, 4], deny: true },
      2: { children: [3], blockers: [5] },
      3: {},
      4: { deny: true },
      5: { deny: true },
    })
    const gh: Gh = async (cwd, args) => {
      visited.push(Number(variable(args, 'number')))
      return transport(cwd, args)
    }
    const graph = await readUwSubtree(githubScope('acme/app', 2), { cwd: '/fixture', gh })
    expect(graph.status).toBe('complete')
    expect(visited).toEqual([2, 3])
    expect(graph.nodes.map((node) => node.uw.target)).toEqual(['acme/app#2', 'acme/app#3'])
  })

  it('refuses an unreadable descendant rather than returning a partial subtree as complete', async () => {
    const graph = await readUwSubtree(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { children: [2] }, 2: { deny: true } }),
    })
    expect(graph.status).toBe('incomplete')
  })

  it('does not treat an unfinished child pagination as a complete subtree', async () => {
    const graph = await readUwSubtree(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { children: Array.from({ length: 201 }, (_, index) => index + 2) } }, false, true),
    })
    expect(graph.status).toBe('incomplete')
    if (graph.status !== 'incomplete') throw new Error('expected incomplete subtree')
    expect(graph.diagnostics).toContainEqual(expect.objectContaining({ code: 'graph-incomplete' }))
  })

  it('refuses child cycles instead of treating an ancestor as a descendant', async () => {
    const graph = await readUwSubtree(githubScope('acme/app', 1), {
      cwd: '/fixture',
      gh: graphGh({ 1: { children: [2] }, 2: { children: [1] } }),
    })
    expect(graph.status).toBe('incomplete')
  })
})

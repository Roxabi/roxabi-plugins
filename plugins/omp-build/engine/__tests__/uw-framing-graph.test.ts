import { expect, test } from 'vitest'
import { cycleKeys, relationGraph, scopeKey, type UwNativeNode } from '../uw-graph.ts'

const root = { repository: 'acme/project', target: 'acme/project#1' }
const child = { repository: 'acme/project', target: 'acme/project#2' }
const blocker = { repository: 'acme/project', target: 'acme/project#3' }

function node(
  uw: typeof root,
  parent: typeof root | null,
  children: readonly (typeof root)[],
  blockers: readonly (typeof root)[],
): UwNativeNode {
  return {
    uw,
    title: uw.target,
    raw: {
      reference: uw.target,
      body: '',
      bodySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      lastEditedAt: null,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
    labels: [],
    wayfinderLabels: [],
    parent,
    children,
    blockers,
    native: { state: 'OPEN', stateReason: null },
  }
}

test('planned blocker can close a cycle through observed hierarchy and blockers', () => {
  const observed = relationGraph([
    node(root, null, [child], []),
    node(child, root, [], [blocker]),
    node(blocker, null, [], []),
  ])
  expect(observed.diagnostics).toEqual([])
  expect(cycleKeys(observed.edges)).toEqual([])
  const planned = new Map(observed.edges)
  planned.set(scopeKey(blocker), [scopeKey(root)])
  expect(cycleKeys(planned)).toContain(scopeKey(root))
})

test('incompatible observations of the same node are refused', () => {
  const first = node(root, null, [], [])
  const conflicting = { ...first, title: 'different' }
  expect(relationGraph([first, conflicting]).diagnostics.map((item) => item.code)).toContain(
    'graph-conflicting-observation',
  )
})

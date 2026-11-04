import { expect, it, vi } from 'vitest'
import { history } from '../../engine/__tests__/workflow-test-support.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { UwGraphObservation, UwNativeNode } from '../../engine/uw-graph.ts'
import { sisterRecords } from '../../testing/cause-input-fixture.ts'
import { observeCauseSisters } from '../github-workflow/cause-sister-graph.ts'

const uw = { repository: 'acme/app', target: 'acme/app#42' }
const sister = { repository: 'acme/app', target: 'acme/app#43' }
const now = '2026-10-27T12:00:00.000Z'
function node(scope: Scope, completed = false): UwNativeNode {
  return {
    uw: scope,
    title: scope.target,
    raw: { reference: scope.target, body: '', bodySha256: 'a'.repeat(64), lastEditedAt: now },
    updatedAt: now,
    labels: ['size:S'],
    wayfinderLabels: [],
    parent: null,
    children: [],
    blockers: [],
    native: { state: completed ? 'CLOSED' : 'OPEN', stateReason: completed ? 'COMPLETED' : null },
  }
}
function graph(root: Scope, completed = false): UwGraphObservation {
  return { status: 'complete', root, nodes: [node(root, completed)], observedAt: now }
}

it('loads only the authenticated receipt sister when its native edge is absent', async () => {
  const { graph: source, held, operation, identity, receipt } = sisterRecords()
  const histories = [history([held, operation, receipt], uw), source.history, history([identity], sister)]
  const read = vi.fn(async (scope: Scope) => graph(scope, true))
  const observed = await observeCauseSisters(graph(uw), histories, read)
  expect(read.mock.calls).toEqual([[sister]])
  expect(observed.nodes.map((item) => item.uw)).toEqual([uw, sister])
  expect(observed.nodes[1]?.native).toEqual({ state: 'CLOSED', stateReason: 'COMPLETED' })
})

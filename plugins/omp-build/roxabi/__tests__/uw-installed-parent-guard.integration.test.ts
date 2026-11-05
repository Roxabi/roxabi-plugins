import { expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { rawSource } from '../../adapters/github-native/uw-spec.ts'
import { assessParentInsertionEngagement } from '../../dist/contracts.js'
import type { UwGraphObservation } from '../../engine/uw-graph.ts'
import { installedParentGuardFixture } from '../../testing/installed-parent-guard-fixture.ts'

it.each(['create-parent', 'create-children', 'update-parent', 'update-children'] as const)(
  'permits a confirmed ordinary %s insertion when the parent is inactive',
  async (route) => {
    const f = await installedParentGuardFixture(route, 'inactive')
    const result = await f.run()
    expect(result.status, JSON.stringify(result)).toBe(route.startsWith('update-') ? 'written' : 'created')
    expect(f.effects().confirmations).toBe(1)
    expect(f.effects().insertions).toBe(1)
    expect(f.issues.get(route === 'create-parent' ? 43 : 42)?.parent).toBe(route === 'create-children' ? 43 : 41)
  },
)
it('inserts under an inactive parent despite a descendant historical report whose source PR is unavailable', async () => {
  const f = await installedParentGuardFixture('create-parent', 'inactive', { historicalChild: true })
  const before = await f.operations.listReports({ repository: 'acme/app', target: 'acme/app#41' })
  expect(before.ok, JSON.stringify(before)).toBe(true)
  if (!before.ok) throw new Error('historical descendant report unavailable')
  expect(before.value.reports.map((item) => item.ref.recordId)).toContain('historical-child-report')
  const result = await f.run()
  expect(result.status, JSON.stringify(result)).toBe('created')
  expect(f.effects().confirmations).toBe(1)
  expect(f.effects().insertions).toBe(1)
  expect(f.issues.get(43)?.parent).toBe(41)
  expect(f.forbidden).toEqual([])
})

it.each([
  'partial-claim',
  'invalid-claim',
  'unsupported',
  'paused',
  'abandoned',
  'revoked',
  'unresolved-control',
  'history-unreadable',
  'graph-unreadable',
] as const)('denies insertion before any effect when parent engagement is %s', async (state) => {
  const f = await installedParentGuardFixture('create-parent', state)
  const result = await f.run()
  expect(result.status, JSON.stringify(result)).toBe('refused')
  expect(f.effects()).toEqual({ creates: 0, patches: 0, insertions: 0, confirmations: 0, commentPosts: 0 })
  expect(f.issues.has(43)).toBe(false)
})

it('requires one complete parent-rooted graph and one unique complete ledger per observed scope', () => {
  const parent = { repository: 'acme/app', target: 'acme/app#41' }
  const graph: UwGraphObservation = {
    status: 'complete',
    root: parent,
    observedAt: '2026-10-27T12:00:00Z',
    nodes: [
      {
        uw: parent,
        title: 'Parent',
        raw: rawSource(parent.target, '', '2026-10-27T12:00:00Z'),
        updatedAt: '2026-10-27T12:00:00Z',
        labels: [],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
    ],
  }
  const history = decodeHistory({
    scope: parent,
    expectedAuthor: 'automation',
    stopAuthor: null,
    complete: true,
    comments: [],
    diagnostics: [],
  })
  expect(assessParentInsertionEngagement({ parent, graph, histories: [history] }).state).toBe('inactive')
  expect(assessParentInsertionEngagement({ parent, graph: { ...graph, nodes: [] }, histories: [] }).state).toBe(
    'indeterminate',
  )
  expect(assessParentInsertionEngagement({ parent, graph, histories: [] }).state).toBe('indeterminate')
  expect(assessParentInsertionEngagement({ parent, graph, histories: [history, history] }).state).toBe('indeterminate')
  const changed = { ...history, source: { ...history.source, complete: false } }
  expect(assessParentInsertionEngagement({ parent, graph, histories: [history, changed] }).state).toBe('indeterminate')
  expect(assessParentInsertionEngagement({ parent, graph, histories: [changed] }).state).toBe('indeterminate')
})

it.each(['create-parent', 'update-parent', 'update-children'] as const)(
  'refuses ordinary %s before effects for active or indeterminate existing parents',
  async (route) => {
    for (const state of ['active', 'indeterminate'] as const) {
      const f = await installedParentGuardFixture(route, state)
      const result = await f.run()
      expect(result.status, JSON.stringify({ state, result })).toBe('refused')
      expect(f.effects()).toEqual({ creates: 0, patches: 0, insertions: 0, confirmations: 0, commentPosts: 0 })
      expect(f.issues.get(42)?.parent).toBeNull()
      expect(f.issues.has(43)).toBe(false)
    }
  },
)

it.each(['create-parent', 'create-children', 'update-parent', 'update-children'] as const)(
  'stops ordinary %s immediately before insertion if the parent becomes active after a native effect',
  async (route) => {
    const f = await installedParentGuardFixture(route, 'active-after-effect')
    const result = await f.run()
    expect(result.status, JSON.stringify(result)).toBe('partial')
    expect(f.effects().confirmations).toBe(1)
    expect(f.effects().creates).toBe(route.startsWith('update-') ? 0 : 1)
    expect(f.effects().insertions).toBe(0)
    expect(f.effects().patches).toBe(0)
    expect(f.effects().commentPosts).toBe(0)
    expect(f.issues.get(route === 'create-parent' ? 43 : 42)?.parent).toBeNull()
    if (!route.startsWith('update-')) expect(f.issues.has(43)).toBe(true)
    else expect(f.issues.get(route === 'update-parent' ? 42 : 41)?.labels).toContain('domain:billing')
  },
)

it.each(['update-parent', 'update-children'] as const)(
  'permits %s with a genuinely published identity when the parent remains inactive',
  async (route) => {
    const f = await installedParentGuardFixture(route, 'inactive', { identity: true })
    const result = await f.run()
    expect(result.status, JSON.stringify(result)).toBe('written')
    expect(f.effects().commentPosts).toBeGreaterThan(0)
    expect(f.effects().insertions).toBe(1)
    expect(f.issues.get(42)?.parent).toBe(41)
  },
)

it.each(['update-parent', 'update-children'] as const)(
  'refuses %s with identity allocation before any publication for a known active or indeterminate parent',
  async (route) => {
    for (const state of ['active', 'indeterminate'] as const) {
      const f = await installedParentGuardFixture(route, state, { identity: true })
      const result = await f.run()
      expect(result.status, JSON.stringify({ state, result })).toBe('refused')
      expect(f.effects()).toEqual({ creates: 0, patches: 0, insertions: 0, confirmations: 0, commentPosts: 0 })
      expect(f.issues.get(42)?.parent).toBeNull()
    }
  },
)

it.each(['update-parent', 'update-children'] as const)(
  'retains the confirmed identity effect when the %s parent activates after identity publication',
  async (route) => {
    const f = await installedParentGuardFixture(route, 'active-after-identity', { identity: true })
    const result = await f.run()
    expect(result.status, JSON.stringify(result)).toBe('partial')
    expect(f.effects().confirmations).toBe(1)
    expect(f.effects().commentPosts).toBeGreaterThan(0)
    expect(f.effects().insertions).toBe(0)
    expect(f.issues.get(42)?.parent).toBeNull()
  },
)

it.each(['create-children', 'update-children'] as const)(
  'rechecks before every %s insertion and retains the first confirmed insertion',
  async (route) => {
    const f = await installedParentGuardFixture(route, 'active-after-first-insertion', { multiple: true })
    const result = await f.run()
    expect(result.status, JSON.stringify(result)).toBe('partial')
    expect(f.effects().insertions).toBe(1)
    expect(f.issues.get(42)?.parent).toBe(route === 'create-children' ? 43 : 41)
    expect(f.issues.get(44)?.parent).toBeNull()
    expect(f.effects().patches).toBe(0)
  },
)

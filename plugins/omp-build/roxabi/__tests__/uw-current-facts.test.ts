import { describe, expect, it } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { UwGraphObservation, UwNativeNode } from '../../engine/uw-graph.ts'
import { canonicalSpec, type SpecSnapshot } from '../../engine/uw-spec.ts'
import { fixtureHostReviewClassCatalogues } from '../../testing/host-catalogue-fixture.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { observedUwWithoutPullRequests } from '../../testing/uw-completion-observation.ts'
import { freshOwnSpec } from '../feature-initial-mandate.ts'
import { readCurrentChildrenProjection, readCurrentOwnSpecFacts } from '../uw-current-facts.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

const parent: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const child: Scope = { repository: 'acme/payments', target: 'acme/payments#42' }
const time = '2026-10-27T12:00:00.000Z'
const fixtures = roxabiWorkflowFixtures()

function snapshot(uw: Scope, statement: string, openQuestions: string[] = []): SpecSnapshot {
  const result = canonicalSpec({
    format: 'omp-build-spec-content/1',
    criteria: [{ id: 'C1', statement }],
    invariants: [],
    exclusions: [],
    openQuestions,
    sections: { origin: '', context: '', change: '' },
  })
  if (!result.ok) throw new Error('invalid fixture spec')
  const parsed = parseIssueSpecBody({
    uw,
    raw: rawSource(uw.target, renderIssueSpecBody(result.value, { complexity: 5 }), time),
  })
  if (parsed.status !== 'conformant') throw new Error(`fixture spec ${parsed.status}`)
  return parsed.snapshot
}

function node(
  uw: Scope,
  value: SpecSnapshot,
  labels: string[],
  parentScope: Scope | null,
  children: Scope[],
): UwNativeNode {
  return {
    uw,
    title: uw.target,
    raw: value.raw,
    updatedAt: time,
    labels,
    wayfinderLabels: labels.filter((label) => label === 'wayfinder:research'),
    parent: parentScope,
    children,
    blockers: [],
    native: { state: 'OPEN', stateReason: null },
  }
}

async function world(options: {
  childSnapshot: SpecSnapshot
  parentSnapshot: SpecSnapshot
  childLabels?: string[]
  childIdentity?: boolean
  parentIdentity?: boolean
  olderChild?: SpecSnapshot
}) {
  const graph: Extract<UwGraphObservation, { status: 'complete' }> = {
    status: 'complete',
    root: parent,
    observedAt: time,
    nodes: [
      node(parent, options.parentSnapshot, ['size:S'], null, [child]),
      node(child, options.childSnapshot, options.childLabels ?? ['size:F-lite'], parent, []),
    ],
  }
  const empty = (scope: Scope) =>
    decodeHistory({
      scope,
      expectedAuthor: 'operator',
      stopAuthor: null,
      complete: true,
      comments: [],
      diagnostics: [],
    })
  const parentHistory =
    options.parentIdentity === false ? empty(parent) : fixtures.historyFrom([fixtures.identityAllocation(parent)])
  const childRecords = options.childIdentity === false ? [] : [fixtures.identityAllocation(child)]
  if (options.olderChild)
    childRecords.push(
      fixtures.featureMandate(child, { ownSpec: fixtures.ownSpecFromSnapshot(child, options.olderChild) }),
    )
  const childHistory = childRecords.length ? fixtures.historyFrom(childRecords) : empty(child)
  const observation = await observedUwWithoutPullRequests({
    graph,
    histories: [parentHistory, childHistory],
    catalogues: fixtureHostReviewClassCatalogues(),
  })
  const reader = createInstalledObservedUwReadPort({ observation })
  return { read: await reader.readUw(parent), childHistory, parentHistory }
}

describe('current factual UW projection', () => {
  it('uses the current native child Spec and tier, not an older child mandate', async () => {
    const own = snapshot(parent, 'Coordinate the release')
    const current = snapshot(child, 'Deploy the reconciler')
    const older = snapshot(child, 'Deploy the original reconciler')
    const { read } = await world({ parentSnapshot: own, childSnapshot: current, olderChild: older })
    const result = await readCurrentOwnSpecFacts({ uw: parent, read })
    expect(result).toMatchObject({
      ok: true,
      value: {
        currentSpec: {
          snapshot: own,
          tier: 'S',
          inheritedOwnSpecRefs: [],
          coverage: null,
          children: [{ scope: child, specVersion: current.spec.version, snapshot: current, tier: 'F-lite' }],
        },
        identityAllocations: [{ scope: parent, kind: 'spec-identity', recordId: `spec-identity:${parent.target}` }],
      },
    })
    expect(current.spec.version).not.toBe(older.spec.version)
  })

  it('projects an identity-backed child before it has an own mandate', async () => {
    const own = snapshot(parent, 'Coordinate the release')
    const current = snapshot(child, 'Deploy without a prior acceptance')
    const { read, childHistory } = await world({ parentSnapshot: own, childSnapshot: current })
    expect(childHistory.operations.some((operation) => operation.record?.kind === 'mandate')).toBe(false)
    expect(await readCurrentChildrenProjection({ uw: parent, read })).toEqual({
      ok: true,
      value: [{ scope: child, specVersion: current.spec.version, tier: 'F-lite' }],
    })
  })

  it('keeps a conformant open-question child as a fact without claiming delivery admission', async () => {
    const own = snapshot(parent, 'Coordinate the release')
    const current = snapshot(child, 'Deploy after ownership is settled', ['Who owns the rollback?'])
    const { read } = await world({ parentSnapshot: own, childSnapshot: current })
    expect(await readCurrentChildrenProjection({ uw: parent, read })).toEqual({
      ok: true,
      value: [{ scope: child, specVersion: current.spec.version, tier: 'F-lite' }],
    })
  })

  it('excludes a native wayfinder and refuses missing child identity rather than inventing one', async () => {
    const own = snapshot(parent, 'Coordinate the release')
    const current = snapshot(child, 'Research reconciliation')
    const wayfinder = await world({
      parentSnapshot: own,
      childSnapshot: current,
      childLabels: ['wayfinder:research'],
      childIdentity: false,
    })
    expect(await readCurrentChildrenProjection({ uw: parent, read: wayfinder.read })).toEqual({ ok: true, value: [] })
    const missing = await world({ parentSnapshot: own, childSnapshot: current, childIdentity: false })
    const result = await readCurrentChildrenProjection({ uw: parent, read: missing.read })
    expect(result).toMatchObject({
      ok: false,
      diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'spec-ledger-incomplete' })]),
    })
  })

  it('refuses a current own Spec without a real identity allocation', async () => {
    const own = snapshot(parent, 'Coordinate the release')
    const current = snapshot(child, 'Deploy the reconciler')
    const { read } = await world({ parentSnapshot: own, childSnapshot: current, parentIdentity: false })
    expect(await readCurrentOwnSpecFacts({ uw: parent, read })).toMatchObject({
      ok: false,
      diagnostics: [expect.objectContaining({ code: 'spec-ledger-incomplete' })],
    })
  })
  it('requires renewed parent coverage consent when an ancestor materially changes an exclusion', async () => {
    const ancestor: Scope = { repository: 'acme/payments', target: 'acme/payments#40' }
    const own = snapshot(parent, 'Coordinate the release')
    const descendant = snapshot(child, 'Deploy the reconciler')
    const content = {
      criteria: [{ id: 'C1' as const, statement: 'Deliver the release' }],
      invariants: [],
      exclusions: ['No external exports'],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }
    const initialSpec = canonicalSpec({ format: 'omp-build-spec-content/1', ...content })
    if (!initialSpec.ok) throw new Error('invalid ancestor Spec')
    const initialRaw = rawSource(ancestor.target, renderIssueSpecBody(initialSpec.value, { complexity: 5 }), time)
    const parsed = parseIssueSpecBody({ uw: ancestor, raw: initialRaw })
    if (parsed.status !== 'conformant') throw new Error('invalid ancestor snapshot')
    const initialSnapshot = parsed.snapshot
    const mandate = fixtures.epicMandate(
      ancestor,
      [
        {
          scope: parent,
          specVersion: own.spec.version,
          snapshot: own,
          tier: 'S',
        },
      ],
      { recordId: 'ancestor-mandate', ownSpec: fixtures.ownSpecFromSnapshot(ancestor, parsed.snapshot) },
    )
    const nextContent = { ...content, exclusions: ['No external exports or automated sharing'] }
    const nextSpec = canonicalSpec({ format: 'omp-build-spec-content/1', ...nextContent })
    if (!nextSpec.ok) throw new Error('invalid changed ancestor Spec')
    const accepted = mandateAssessmentState(mandate)
    const proposed = proposedAssessmentState(accepted, {
      body: renderIssueSpecBody(nextSpec.value, { complexity: 5 }),
      content: nextContent,
    })
    const childHistory = fixtures.historyFrom([fixtures.identityAllocation(child)])
    const ancestorIdentity = fixtures.identityAllocation(ancestor)
    const parentIdentityHistory = fixtures.historyFrom([fixtures.identityAllocation(parent)])
    const originalHistory = fixtures.historyFrom([ancestorIdentity, mandate], 'operator', 'operator', [
      parentIdentityHistory,
    ])
    const parentHistory = parentIdentityHistory
    const amendment = assessFixture(mandate, 'ancestor-material-change', accepted, proposed, 'material', [
      originalHistory,
      parentHistory,
    ])
    const control = acceptMaterialFixture(mandate, 'accept-ancestor-material-change', amendment)
    const changedHistory = fixtures.historyFrom(
      [ancestorIdentity, mandate, amendment.start, amendment.result, control],
      'operator',
      'operator',
      [parentHistory, childHistory],
    )
    async function readWorld(changed: boolean) {
      const graph: Extract<UwGraphObservation, { status: 'complete' }> = {
        status: 'complete',
        root: ancestor,
        observedAt: time,
        nodes: [
          node(ancestor, changed ? amendment.proposed.snapshot : initialSnapshot, ['size:S'], null, [parent]),
          node(parent, own, ['size:S'], ancestor, [child]),
          node(child, descendant, ['size:S'], parent, []),
        ],
      }
      const observation = await observedUwWithoutPullRequests({
        graph,
        histories: [changed ? changedHistory : originalHistory, parentHistory, childHistory],
        catalogues: fixtureHostReviewClassCatalogues(),
      })
      const reader = createInstalledObservedUwReadPort({ observation })
      return { reader, read: await reader.readUw(parent) }
    }
    const before = await readWorld(false)
    const prompt = await freshOwnSpec(parent, before.read, before.reader)
    expect(prompt).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-required' })
    if (!('coverageRequest' in prompt) || !prompt.coverageRequest) throw new Error('Expected coverage request')
    expect(prompt.coverageRequest.inheritedOwnSpecRefs).toHaveLength(1)
    const coverage = {
      parent: prompt.coverageRequest.parent,
      assignments: [{ criterion: 'C1' as const, children: [child] as [Scope] }],
    }
    const after = await readWorld(true)
    const continued = await freshOwnSpec(parent, after.read, after.reader, coverage, prompt.coverageRequest)
    expect(continued).toMatchObject({ kind: 'blocked', reason: 'parent-coverage-intent-changed' })
    if (!('coverageRequest' in continued) || !continued.coverageRequest) throw new Error('Expected refreshed request')
    expect(continued.coverageRequest.parent).toEqual(prompt.coverageRequest.parent)
    expect(continued.coverageRequest.inheritedOwnSpecRefs).not.toEqual(prompt.coverageRequest.inheritedOwnSpecRefs)
  })
})

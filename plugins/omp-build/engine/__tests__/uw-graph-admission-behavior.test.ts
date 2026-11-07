import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { createInstalledObservedUwReadPort } from '../../roxabi/uw-read-port.ts'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { specDigest } from '../record-digests.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { Scope } from '../record-values.ts'
import { assessUwAdmission as assessAdmission } from '../uw-admission.ts'
import { assessUwCompletion } from '../uw-completion.ts'
import { type UwGraphObservation, type UwNativeNode, validateUwGraph } from '../uw-graph.ts'
import type { SpecIdentityLedger } from '../uw-identity.ts'
import { canonicalSpec, type SpecItemId, type SpecSnapshot } from '../uw-spec.ts'
import { resolveAcceptedSpec } from '../workflow-accepted-spec.ts'
import type { AcceptedOwnSpec } from '../workflow-accepted-spec-types.ts'

const ROOT: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const CHILD: Scope = { repository: 'acme/payments', target: 'acme/payments#42' }
const BLOCKER: Scope = { repository: 'other/dependencies', target: 'other/dependencies#9' }
const OBSERVED_AT = '2026-10-27T12:00:00.000Z'
const NO_CAUSE_HISTORY = [
  decodeHistory({
    scope: ROOT,
    expectedAuthor: 'operator',
    stopAuthor: 'operator',
    complete: true,
    comments: [],
    diagnostics: [],
  }),
]

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(','))
  return result.value
}

function snapshot(
  criteria: { id: 'C1' | 'C2'; statement: string }[] = [{ id: 'C1', statement: 'Deliver the own commitment' }],
  openQuestions: string[] = [],
  source: Scope = ROOT,
): SpecSnapshot {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria,
      invariants: [],
      exclusions: [],
      openQuestions,
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const body = criteria.map(({ id, statement }) => `${id}: ${statement}`).join('\n')
  return { spec, raw: { reference: source.target, body, bodySha256: specDigest(body), lastEditedAt: OBSERVED_AT } }
}

function node(input: {
  uw: Scope
  labels?: readonly string[]
  wayfinderLabels?: readonly string[]
  parent?: Scope | null
  children?: readonly Scope[]
  blockers?: readonly Scope[]
  state?: 'OPEN' | 'CLOSED'
  stateReason?: string | null
}): UwNativeNode {
  return {
    uw: input.uw,
    title: `UW ${input.uw.target}`,
    raw: { reference: input.uw.target, body: '', bodySha256: specDigest(''), lastEditedAt: OBSERVED_AT },
    updatedAt: OBSERVED_AT,
    labels: input.labels ?? ['size:S'],
    wayfinderLabels: input.wayfinderLabels ?? [],
    parent: input.parent ?? null,
    children: input.children ?? [],
    blockers: input.blockers ?? [],
    native: { state: input.state ?? 'OPEN', stateReason: input.stateReason ?? null },
  }
}

function graph(nodes: readonly UwNativeNode[], root = ROOT): Extract<UwGraphObservation, { status: 'complete' }> {
  return { status: 'complete', root, nodes, observedAt: OBSERVED_AT }
}

function ledger(ids: readonly ('C1' | 'C2')[] = ['C1']): SpecIdentityLedger {
  const allocations = new Map<SpecItemId, ExternalRecordRef>()
  for (const id of ids) allocations.set(id, { scope: ROOT, recordId: `identity-${id}`, kind: 'spec-identity' })
  return {
    uw: ROOT,
    head: null,
    nextCriterion: String(ids.length + 1),
    nextInvariant: '1',
    allocations,
    retired: new Map(),
  }
}

function accepted(value: SpecSnapshot, children: AcceptedOwnSpec['children'] = []): AcceptedOwnSpec {
  const [first, ...otherChildren] = children
  return {
    ref: {
      uw: ROOT,
      version: value.spec.version,
      sourceAccepted: { scope: ROOT, recordId: 'mandate-41', kind: 'mandate' },
    },
    snapshot: value,
    tier: 'S',
    children,
    inheritedOwnSpecRefs: [],
    coverage:
      first !== undefined
        ? {
            parent: { uw: ROOT, version: value.spec.version },
            assignments: value.spec.criteria.map((criterion) => ({
              criterion: criterion.id,
              children: [first.scope, ...otherChildren.map((child) => child.scope)] as [Scope, ...Scope[]],
            })),
          }
        : null,
    chain: [
      {
        kind: 'mandate',
        source: { scope: ROOT, recordId: 'mandate-41', kind: 'mandate' },
        version: value.spec.version,
      },
    ],
    sourceRefs: [{ scope: ROOT, recordId: 'mandate-41', kind: 'mandate' }],
  }
}

function codes(check: { diagnostics: readonly { code: string }[] }): string[] {
  return check.diagnostics.map((diagnostic) => diagnostic.code)
}

type AdmissionInput = Parameters<typeof assessAdmission>[0]
type FixtureAdmissionInput = AdmissionInput extends infer T
  ? T extends AdmissionInput
    ? Omit<T, 'completion'> & { completion?: T['completion'] }
    : never
  : never
function assessUwAdmission(input: FixtureAdmissionInput) {
  const histories = [...input.histories]
  for (const native of input.graph.nodes) {
    if (
      !histories.some(
        (entry) =>
          entry.source.scope.repository === native.uw.repository && entry.source.scope.target === native.uw.target,
      )
    )
      histories.push(
        decodeHistory({
          scope: native.uw,
          expectedAuthor: 'operator',
          stopAuthor: 'operator',
          complete: true,
          comments: [],
          diagnostics: [],
        }),
      )
  }
  const completion =
    input.completion ??
    assessUwCompletion({
      status: input.graph.status,
      root: input.uw,
      graph: input.graph,
      histories,
      catalogues: input.catalogues,
      delivery: input.graph.nodes.map((native) => ({ uw: native.uw, pullRequests: [], integrations: [], commits: [] })),
      ...(input.graph.status === 'incomplete'
        ? {
            diagnostics: [
              input.graph.diagnostics[0] ?? {
                code: 'graph-incomplete',
                message: 'Graph is incomplete',
                location: { kind: 'native' as const, uw: input.uw, connection: 'state' as const },
                related: [],
              },
            ] as const,
          }
        : {}),
    } as Parameters<typeof assessUwCompletion>[0])
  return assessAdmission({ ...input, completion } as AdmissionInput)
}
test('refuses an accepted UW when a parser draft has no diagnostics', async () => {
  const body = renderIssueSpecBody(snapshot().spec, { complexity: 5 })
  const source = rawSource(ROOT.target, body, OBSERVED_AT)
  const parsed = parseIssueSpecBody({ uw: ROOT, raw: source })
  if (parsed.status !== 'conformant') throw new Error('expected a conformant accepted baseline')
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(ROOT, { ownSpec: fixtures.ownSpecFromSnapshot(ROOT, parsed.snapshot) })
  const history = fixtures.historyFrom([mandate])
  const draftBody = body.replace('# Invariants', '- An additional unapproved commitment\n\n# Invariants')
  const draftSource = rawSource(ROOT.target, draftBody, OBSERVED_AT)
  const draft = parseIssueSpecBody({ uw: ROOT, raw: draftSource })
  expect(draft.status).toBe('draft')
  expect(draft.diagnostics).toEqual([])

  const baseline = createInstalledObservedUwReadPort({
    observation: {
      status: 'complete',
      root: ROOT,
      graph: graph([{ ...node({ uw: ROOT }), raw: source }]),
      histories: [history],
      catalogues: fixtureReviewClassCatalogues(),
      delivery: [{ uw: ROOT, pullRequests: [], integrations: [], commits: [] }],
    },
  })
  const changed = createInstalledObservedUwReadPort({
    observation: {
      status: 'complete',
      root: ROOT,
      graph: graph([{ ...node({ uw: ROOT }), raw: draftSource }]),
      histories: [history],
      catalogues: fixtureReviewClassCatalogues(),
      delivery: [{ uw: ROOT, pullRequests: [], integrations: [], commits: [] }],
    },
  })
  const before = await baseline.readUw(ROOT)
  const read = await changed.readUw(ROOT)
  expect(before.accepted.status).toBe('accepted')
  expect(before.admission).toMatchObject({ framed: { ok: true }, deliverable: { ok: true } })
  expect(read.proposed).toEqual({ ok: false, diagnostics: [] })
  if (!read.identity.ok) throw new Error('fixture identity ledger must resolve')
  const admission = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: read.graph,
    proposed: read.proposed,
    accepted: read.accepted,
    identities: read.identity.value,
    phase: 'delivery-transition',
    currentChildren: { ok: true, value: [] },
  })
  expect(admission.framed.ok).toBe(false)
  expect(admission.deliverable.ok).toBe(false)
  expect(admission.framed.diagnostics).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: 'proposed-spec-unavailable', location: expect.objectContaining({ uw: ROOT }) }),
    ]),
  )
})

test('frames the own Spec only, requiring an explicit native tier and no open questions before accepted applicability', () => {
  const own = snapshot()
  const complete = graph([node({ uw: ROOT })])
  const initiallyFramed = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: complete,
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const landingWithoutAcceptance = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: complete,
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [] },
  })
  const unframed = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([node({ uw: ROOT, labels: [] })]),
    proposed: { ok: true, snapshot: snapshot([{ id: 'C1', statement: 'Own commitment' }], ['Who owns the rollback?']) },
    accepted: { status: 'accepted', value: accepted(own) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [] },
  })

  expect(initiallyFramed).toMatchObject({
    applicability: 'unresolved',
    framed: { ok: true },
    deliverable: { ok: true },
  })
  expect(codes(landingWithoutAcceptance.deliverable)).toContain('own-spec-unaccepted')
  expect(codes(unframed.framed)).toEqual(expect.arrayContaining(['tier-missing', 'open-question']))
})

test('lifts a dependency only when its native state is CLOSED with exactly COMPLETED', () => {
  const own = snapshot()
  const completed = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([
      node({ uw: ROOT, blockers: [BLOCKER] }),
      node({ uw: BLOCKER, state: 'CLOSED', stateReason: 'COMPLETED' }),
    ]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const notPlanned = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([
      node({ uw: ROOT, blockers: [BLOCKER] }),
      node({ uw: BLOCKER, state: 'CLOSED', stateReason: 'NOT_PLANNED' }),
    ]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const unknownReason = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([node({ uw: ROOT, blockers: [BLOCKER] }), node({ uw: BLOCKER, state: 'CLOSED', stateReason: null })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })

  expect(completed.deliverable.ok).toBe(true)
  expect(codes(notPlanned.deliverable)).toContain('blocker-not-completed')
  expect(codes(unknownReason.deliverable)).toContain('blocker-not-completed')
  const blockerDiagnostic = notPlanned.deliverable.diagnostics.find((entry) => entry.code === 'blocker-not-completed')
  expect(blockerDiagnostic).toBeDefined()
  expect(JSON.stringify(blockerDiagnostic)).toContain(BLOCKER.target)
  expect(JSON.stringify(blockerDiagnostic)).toContain('NOT_PLANNED')
})

test('does not lift a managed blocker on native completion without authenticated delivery', () => {
  const fixtures = roxabiWorkflowFixtures()
  const blockerSnapshot = snapshot([{ id: 'C1', statement: 'Deliver the blocker commitment' }], [], BLOCKER)
  const mandate = fixtures.featureMandate(BLOCKER, {
    ownSpec: fixtures.ownSpecFromSnapshot(BLOCKER, blockerSnapshot),
  })
  const blockerHistory = fixtures.historyFrom([mandate])
  expect(resolveAcceptedSpec(mandate, [blockerHistory])).toMatchObject({ ok: true })
  const observation = {
    status: 'complete' as const,
    root: ROOT,
    graph: {
      status: 'complete' as const,
      root: ROOT,
      observedAt: OBSERVED_AT,
      nodes: [
        node({ uw: ROOT, blockers: [BLOCKER] }),
        node({ uw: BLOCKER, state: 'CLOSED', stateReason: 'COMPLETED' }),
      ],
    },
    histories: [...NO_CAUSE_HISTORY, blockerHistory],
    catalogues: fixtureReviewClassCatalogues(),
    delivery: [{ uw: BLOCKER, pullRequests: [], integrations: [], commits: [] }],
  }
  const completion = assessUwCompletion(observation)

  const admission = assessUwAdmission({
    histories: observation.histories,
    catalogues: observation.catalogues,
    completion,
    uw: ROOT,
    graph: observation.graph,
    proposed: { ok: true, snapshot: snapshot() },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })

  expect(admission.deliverable.ok).toBe(false)
  expect(completion.dependencies.get(`${BLOCKER.repository}\u0000${BLOCKER.target}`)).toMatchObject({
    basis: { kind: 'accepted-uw' },
    state: 'held',
    completion: { state: expect.not.stringMatching(/^complete$/) },
  })
})

test('validates the combined hierarchy and dependency closure across repositories', () => {
  const cyclic = graph([
    node({ uw: ROOT, children: [CHILD] }),
    node({ uw: CHILD, parent: ROOT, blockers: [BLOCKER] }),
    node({ uw: BLOCKER, blockers: [ROOT] }),
  ])
  const acyclic = graph([
    node({ uw: ROOT, children: [CHILD] }),
    node({ uw: CHILD, parent: ROOT, blockers: [BLOCKER] }),
    node({ uw: BLOCKER }),
  ])
  const incompleteDistant = graph([
    node({ uw: ROOT, children: [CHILD] }),
    node({ uw: CHILD, parent: ROOT, blockers: [BLOCKER] }),
  ])

  expect(codes(validateUwGraph(cyclic))).toContain('graph-cycle')
  expect(validateUwGraph(acyclic)).toMatchObject({ ok: true })
  expect(codes(validateUwGraph(incompleteDistant))).toContain('graph-incomplete')
})

test('refuses wayfinder roots and dependencies, and retains an accepted child reclassified as non-UW before filtering', () => {
  const own = snapshot()
  const rootWayfinder = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([node({ uw: ROOT, labels: ['wayfinder:map', 'size:S'], wayfinderLabels: ['wayfinder:map'] })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const dependencyWayfinder = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([
      node({ uw: ROOT, blockers: [BLOCKER] }),
      node({
        uw: BLOCKER,
        labels: ['wayfinder:task'],
        wayfinderLabels: ['wayfinder:task'],
        state: 'CLOSED',
        stateReason: 'COMPLETED',
      }),
    ]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const childSnapshot = snapshot([{ id: 'C1', statement: 'Child commitment' }], [], CHILD)
  const reclassifiedChild = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([
      node({ uw: ROOT, children: [CHILD] }),
      node({ uw: CHILD, labels: ['wayfinder:research'], wayfinderLabels: ['wayfinder:research'], parent: ROOT }),
    ]),
    proposed: { ok: true, snapshot: own },
    accepted: {
      status: 'accepted',
      value: accepted(own, [
        { scope: CHILD, specVersion: childSnapshot.spec.version, snapshot: childSnapshot, tier: 'S' },
      ]),
    },
    identities: ledger(),
    phase: 'landing',
    currentChildren: {
      ok: true,
      value: [{ scope: CHILD, specVersion: childSnapshot.spec.version, tier: 'S' }],
    },
  })

  expect(codes(rootWayfinder.framed)).toEqual(expect.arrayContaining(['wayfinder-not-uw', 'wayfinder-has-tier']))
  expect(codes(dependencyWayfinder.deliverable)).toContain('dependency-not-uw')
  expect(codes(reclassifiedChild.deliverable)).toContain('material-change-pending')
  const drift = reclassifiedChild.deliverable.diagnostics.find((entry) => entry.code === 'material-change-pending')
  expect(drift).toBeDefined()
  expect(JSON.stringify(drift)).toContain(CHILD.target)
})

test('requires root child membership and a canonical child projection without treating missing child facts as material drift', () => {
  const own = snapshot()
  const child = snapshot([{ id: 'C1', statement: 'Child commitment' }], [], CHILD)
  const acceptedChild = { scope: CHILD, specVersion: child.spec.version, snapshot: child, tier: 'S' as const }
  const detached = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([
      node({ uw: ROOT, blockers: [CHILD] }),
      node({ uw: CHILD, state: 'CLOSED', stateReason: 'COMPLETED' }),
    ]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'accepted', value: accepted(own, [acceptedChild]) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [{ scope: CHILD, specVersion: child.spec.version, tier: 'S' }] },
  })
  const missingTier = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([node({ uw: ROOT, children: [CHILD] }), node({ uw: CHILD, labels: [], parent: ROOT })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'accepted', value: accepted(own, [acceptedChild]) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [{ scope: CHILD, specVersion: child.spec.version, tier: 'S' }] },
  })
  const unavailableProjection = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([node({ uw: ROOT, children: [CHILD] }), node({ uw: CHILD, parent: ROOT })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'accepted', value: accepted(own, [acceptedChild]) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: {
      ok: false,
      diagnostics: [
        {
          code: 'current-child-projection-incomplete',
          message: 'Current child commitment projection could not be read',
          location: { kind: 'native', uw: CHILD, connection: 'children' },
          related: [],
        },
      ],
    },
  })
  const changed = snapshot([{ id: 'C1', statement: 'Changed child commitment' }], [], CHILD)
  const changedVersion = assessUwAdmission({
    histories: NO_CAUSE_HISTORY,
    catalogues: fixtureReviewClassCatalogues(),
    uw: ROOT,
    graph: graph([node({ uw: ROOT, children: [CHILD] }), node({ uw: CHILD, parent: ROOT })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'accepted', value: accepted(own, [acceptedChild]) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [{ scope: CHILD, specVersion: changed.spec.version, tier: 'S' }] },
  })
  const versionDrift = changedVersion.deliverable.diagnostics.find((entry) => entry.code === 'material-change-pending')
  expect(versionDrift).toBeDefined()
  expect(JSON.stringify(versionDrift)).toContain(CHILD.target)
  expect(JSON.stringify(versionDrift)).toContain(child.spec.version)
  expect(JSON.stringify(versionDrift)).toContain(changed.spec.version)

  expect(codes(detached.deliverable)).toContain('material-change-pending')
  const removed = detached.deliverable.diagnostics.find((entry) => entry.code === 'material-change-pending')
  expect(removed).toBeDefined()
  expect(JSON.stringify(removed)).toContain(CHILD.target)
  expect(codes(missingTier.deliverable)).toContain('tier-missing')
  expect(codes(missingTier.deliverable)).not.toContain('material-change-pending')
  expect(codes(unavailableProjection.deliverable)).toContain('current-child-projection-incomplete')
  expect(codes(unavailableProjection.deliverable)).not.toContain('material-change-pending')
})

test('refuses competing parents and nonreciprocal hierarchy claims without collapsing their locations', () => {
  const second: Scope = { repository: ROOT.repository, target: 'acme/payments#43' }
  const observed = graph([
    node({ uw: ROOT, children: [CHILD] }),
    node({ uw: second, children: [CHILD] }),
    node({ uw: CHILD, parent: ROOT }),
  ])
  const result = validateUwGraph(observed)
  expect(codes(result)).toContain('multiple-parents')
  const conflict = result.diagnostics.find((entry) => entry.code === 'multiple-parents')
  expect(conflict?.related).toEqual(
    expect.arrayContaining([expect.objectContaining({ uw: ROOT }), expect.objectContaining({ uw: second })]),
  )
  expect(codes(result)).toContain('parent-child-conflict')
})

test('rejects hierarchy cycles even through a wayfinder', () => {
  const observed = graph([
    node({ uw: ROOT, children: [CHILD], parent: CHILD }),
    node({
      uw: CHILD,
      children: [ROOT],
      parent: ROOT,
      labels: ['wayfinder:task'],
      wayfinderLabels: ['wayfinder:task'],
    }),
  ])
  expect(codes(validateUwGraph(observed))).toContain('graph-cycle')
})

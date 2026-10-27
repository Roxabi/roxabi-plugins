import { expect, test } from 'vitest'
import { specDigest } from '../record-digests.ts'
import type { ExternalRecordRef } from '../record-references.ts'
import type { Scope } from '../record-values.ts'
import { assessUwAdmission } from '../uw-admission.ts'
import { type UwGraphObservation, type UwNativeNode, validateUwGraph } from '../uw-graph.ts'
import type { SpecIdentityLedger } from '../uw-identity.ts'
import { canonicalSpec, type SpecItemId, type SpecSnapshot } from '../uw-spec.ts'
import type { AcceptedOwnSpec } from '../workflow-accepted-spec-types.ts'

const ROOT: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const CHILD: Scope = { repository: 'acme/payments', target: 'acme/payments#42' }
const BLOCKER: Scope = { repository: 'other/dependencies', target: 'other/dependencies#9' }
const OBSERVED_AT = '2026-10-27T12:00:00.000Z'

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

function graph(nodes: readonly UwNativeNode[], root = ROOT): UwGraphObservation {
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
  return {
    ref: {
      uw: ROOT,
      version: value.spec.version,
      sourceAccepted: { scope: ROOT, recordId: 'mandate-41', kind: 'mandate' },
    },
    snapshot: value,
    tier: 'S',
    children,
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

test('frames the own Spec only, requiring an explicit native tier and no open questions before accepted applicability', () => {
  const own = snapshot()
  const complete = graph([node({ uw: ROOT })])
  const initiallyFramed = assessUwAdmission({
    uw: ROOT,
    graph: complete,
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const landingWithoutAcceptance = assessUwAdmission({
    uw: ROOT,
    graph: complete,
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [] },
  })
  const unframed = assessUwAdmission({
    uw: ROOT,
    graph: graph([node({ uw: ROOT, labels: [] })]),
    proposed: { ok: true, snapshot: snapshot([{ id: 'C1', statement: 'Own commitment' }], ['Who owns the rollback?']) },
    accepted: { status: 'accepted', value: accepted(own) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [] },
  })

  expect(initiallyFramed).toMatchObject({ applicability: 'own-only', framed: { ok: true }, deliverable: { ok: true } })
  expect(codes(landingWithoutAcceptance.deliverable)).toContain('own-spec-unaccepted')
  expect(codes(unframed.framed)).toEqual(expect.arrayContaining(['tier-missing', 'open-question']))
})

test('lifts a dependency only when its native state is CLOSED with exactly COMPLETED', () => {
  const own = snapshot()
  const completed = assessUwAdmission({
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
    uw: ROOT,
    graph: graph([node({ uw: ROOT, labels: ['wayfinder:map', 'size:S'], wayfinderLabels: ['wayfinder:map'] })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'absent' },
    identities: ledger(),
    phase: 'initial-selection',
  })
  const dependencyWayfinder = assessUwAdmission({
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
    uw: ROOT,
    graph: graph([node({ uw: ROOT, children: [CHILD] }), node({ uw: CHILD, labels: [], parent: ROOT })]),
    proposed: { ok: true, snapshot: own },
    accepted: { status: 'accepted', value: accepted(own, [acceptedChild]) },
    identities: ledger(),
    phase: 'landing',
    currentChildren: { ok: true, value: [{ scope: CHILD, specVersion: child.spec.version, tier: 'S' }] },
  })
  const unavailableProjection = assessUwAdmission({
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

import { describe, expect, it } from 'vitest'
import {
  type ParsedIssueSpec,
  parseIssueSpecBody,
  rawSource,
  renderIssueSpecBody,
} from '../../adapters/github-native/uw-spec.ts'
import type { ExternalRecordRef } from '../../engine/record-references.ts'
import type { Scope } from '../../engine/record-values.ts'
import { assessUwAdmission } from '../../engine/uw-admission.ts'
import { type UwGraphObservation, type UwNativeNode, WAYFINDER_LABELS } from '../../engine/uw-graph.ts'
import type { SpecIdentityLedger } from '../../engine/uw-identity.ts'
import { canonicalSpec, type SpecItemId, type SpecSnapshot, type UwTier } from '../../engine/uw-spec.ts'
import type { AcceptedChildCommitment } from '../../engine/workflow-mandate-schema.ts'
import type { UwRead, UwReadPort } from '../uw-contract.ts'
import { readCurrentOwnSpecFacts } from '../uw-current-facts.ts'

const PARENT: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const CHILD: Scope = { repository: 'acme/payments', target: 'acme/payments#42' }
const OBSERVED_AT = '2026-10-27T12:00:00.000Z'

type ParsedFact = { parsed: ParsedIssueSpec; snapshot: SpecSnapshot }

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(','))
  return result.value
}

function fact(scope: Scope, statement: string, openQuestions: string[] = []): ParsedFact {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement }],
      invariants: [],
      exclusions: [],
      openQuestions,
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, renderIssueSpecBody(spec, { complexity: 5 }), OBSERVED_AT),
  })
  if (parsed.status !== 'conformant') throw new Error(`expected conformant Spec, received ${parsed.status}`)
  return { parsed, snapshot: parsed.snapshot }
}

function allocation(scope: Scope, id: SpecItemId): ExternalRecordRef {
  return { scope, recordId: `identity-${scope.target}-${id}`, kind: 'spec-identity' }
}

function ledger(scope: Scope, snapshot: SpecSnapshot, retired: readonly SpecItemId[] = []): SpecIdentityLedger {
  const allocations = new Map<SpecItemId, ExternalRecordRef>()
  for (const item of [...snapshot.spec.criteria, ...snapshot.spec.invariants])
    allocations.set(item.id, allocation(scope, item.id))
  return {
    uw: scope,
    head: null,
    nextCriterion: '2',
    nextInvariant: '1',
    allocations,
    retired: new Map(retired.map((id) => [id, allocation(scope, id)])),
  }
}

function node(input: {
  scope: Scope
  fact: ParsedFact
  tier: UwTier
  parent?: Scope | null
  children?: readonly Scope[]
  labels?: readonly string[]
}): UwNativeNode {
  const labels = input.labels ?? [`size:${input.tier}`]
  return {
    uw: input.scope,
    title: `UW ${input.scope.target}`,
    raw: input.fact.snapshot.raw,
    updatedAt: OBSERVED_AT,
    labels,
    wayfinderLabels: labels.filter((label) => (WAYFINDER_LABELS as readonly string[]).includes(label)),
    parent: input.parent ?? null,
    children: input.children ?? [],
    blockers: [],
    native: { state: 'OPEN', stateReason: null },
  }
}

function graph(root: Scope, nodes: readonly UwNativeNode[]): UwGraphObservation {
  return { status: 'complete', root, nodes, observedAt: OBSERVED_AT }
}

function accepted(
  scope: Scope,
  snapshot: SpecSnapshot,
  tier: UwTier,
  children: AcceptedChildCommitment[] = [],
): Extract<UwRead['accepted'], { status: 'accepted' }> {
  const source: ExternalRecordRef = { scope, recordId: `mandate-${scope.target}`, kind: 'mandate' }
  return {
    status: 'accepted',
    value: {
      ref: { uw: scope, version: snapshot.spec.version, sourceAccepted: source },
      snapshot,
      tier,
      children,
      chain: [{ kind: 'mandate', source, version: snapshot.spec.version }],
      sourceRefs: [source],
    },
  }
}

function read(input: {
  scope: Scope
  fact: ParsedFact
  graph: UwGraphObservation
  tier: UwTier
  accepted?: UwRead['accepted']
  identity?: UwRead['identity']
}): UwRead {
  const identities = input.identity?.ok ? input.identity.value : ledger(input.scope, input.fact.snapshot)
  const proposed = { ok: true as const, snapshot: input.fact.snapshot }
  const acceptedState = input.accepted ?? { status: 'absent' as const }
  return {
    uw: input.scope,
    parsed: input.fact.parsed,
    identity: input.identity ?? { ok: true, value: identities },
    proposed,
    accepted: acceptedState,
    admission: assessUwAdmission({
      uw: input.scope,
      graph: input.graph,
      proposed,
      accepted: acceptedState,
      identities,
      phase: 'initial-selection',
    }),
    graph: input.graph,
  }
}

function reader(child: UwRead): UwReadPort {
  return { readUw: async () => child }
}

function ledgerDiagnostic(scope: Scope) {
  return {
    code: 'spec-ledger-incomplete',
    message: 'Current proposed Spec has unknown or retired identities',
    location: { kind: 'native' as const, uw: scope, connection: 'state' as const },
    related: [],
  }
}

describe('readCurrentOwnSpecFacts', () => {
  it('uses a framed child current proposed canonical version and native tier instead of its older accepted state', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const childCurrent = fact(CHILD, 'Deploy the reconciler')
    const childAccepted = fact(CHILD, 'Deploy the original reconciler')
    const parentGraph = graph(PARENT, [
      node({ scope: PARENT, fact: parent, tier: 'S', children: [CHILD] }),
      node({ scope: CHILD, fact: childCurrent, tier: 'F-lite', parent: PARENT }),
    ])
    const parentRead = read({ scope: PARENT, fact: parent, graph: parentGraph, tier: 'S' })
    const childRead = read({
      scope: CHILD,
      fact: childCurrent,
      graph: graph(CHILD, [node({ scope: CHILD, fact: childCurrent, tier: 'F-lite', parent: PARENT })]),
      tier: 'F-lite',
      accepted: accepted(CHILD, childAccepted.snapshot, 'S'),
    })

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(childRead) })

    expect(result).toEqual({
      ok: true,
      value: {
        currentSpec: {
          snapshot: parent.snapshot,
          tier: 'S',
          children: [
            {
              scope: CHILD,
              specVersion: childCurrent.snapshot.spec.version,
              snapshot: childCurrent.snapshot,
              tier: 'F-lite',
            },
          ],
        },
        identityAllocations: [allocation(PARENT, 'C1')],
      },
    })
    expect(childCurrent.snapshot.spec.version).not.toBe(childAccepted.snapshot.spec.version)
  })

  it('retains a framed child current commitment when that child has no accepted own state', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const child = fact(CHILD, 'Deploy without a prior acceptance')
    const parentRead = read({
      scope: PARENT,
      fact: parent,
      graph: graph(PARENT, [
        node({ scope: PARENT, fact: parent, tier: 'S', children: [CHILD] }),
        node({ scope: CHILD, fact: child, tier: 'F-lite', parent: PARENT }),
      ]),
      tier: 'S',
    })
    const childRead = read({
      scope: CHILD,
      fact: child,
      graph: graph(CHILD, [node({ scope: CHILD, fact: child, tier: 'F-lite', parent: PARENT })]),
      tier: 'F-lite',
    })

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(childRead) })

    expect(childRead.accepted).toEqual({ status: 'absent' })
    expect(result).toEqual({
      ok: true,
      value: {
        currentSpec: {
          snapshot: parent.snapshot,
          tier: 'S',
          children: [
            { scope: CHILD, specVersion: child.snapshot.spec.version, snapshot: child.snapshot, tier: 'F-lite' },
          ],
        },
        identityAllocations: [allocation(PARENT, 'C1')],
      },
    })
  })

  it('refuses an open-question child with the admission diagnostic and its native location', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const child = fact(CHILD, 'Deploy after ownership is settled', ['Who owns the rollback?'])
    const parentRead = read({
      scope: PARENT,
      fact: parent,
      graph: graph(PARENT, [
        node({ scope: PARENT, fact: parent, tier: 'S', children: [CHILD] }),
        node({ scope: CHILD, fact: child, tier: 'S', parent: PARENT }),
      ]),
      tier: 'S',
    })
    const childRead = read({
      scope: CHILD,
      fact: child,
      graph: graph(CHILD, [node({ scope: CHILD, fact: child, tier: 'S', parent: PARENT })]),
      tier: 'S',
    })
    const openQuestion = {
      code: 'open-question',
      message: 'Spec has open questions',
      location: { kind: 'native' as const, uw: CHILD, connection: 'state' as const },
      related: [],
    }

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(childRead) })

    expect(childRead.admission.framed).toEqual({ ok: false, diagnostics: [openQuestion] })
    expect(result).toEqual({ ok: false, diagnostics: [openQuestion] })
  })

  it('preserves an accepted refusal as a refusal instead of treating it as absent', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const child = fact(CHILD, 'Deploy only after acceptance review')
    const refusal = {
      code: 'accepted-refused',
      message: 'Accepted own Spec reconstruction was refused',
      location: { kind: 'native' as const, uw: CHILD, connection: 'state' as const },
      related: [],
    }
    const parentRead = read({
      scope: PARENT,
      fact: parent,
      graph: graph(PARENT, [
        node({ scope: PARENT, fact: parent, tier: 'S', children: [CHILD] }),
        node({ scope: CHILD, fact: child, tier: 'S', parent: PARENT }),
      ]),
      tier: 'S',
    })
    const childRead = read({
      scope: CHILD,
      fact: child,
      graph: graph(CHILD, [node({ scope: CHILD, fact: child, tier: 'S', parent: PARENT })]),
      tier: 'S',
      accepted: { status: 'refused', diagnostics: [refusal] },
    })

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(childRead) })

    expect(result).toEqual({ ok: false, diagnostics: [refusal] })
  })

  it('excludes a known wayfinder child without changing the retained accepted engine baseline', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const child = fact(CHILD, 'Research the reconciliation options')
    const retainedChild: AcceptedChildCommitment = {
      scope: CHILD,
      specVersion: child.snapshot.spec.version,
      snapshot: child.snapshot,
      tier: 'S',
    }
    const baseline = accepted(PARENT, parent.snapshot, 'S', [retainedChild])
    const parentRead = read({
      scope: PARENT,
      fact: parent,
      graph: graph(PARENT, [
        node({ scope: PARENT, fact: parent, tier: 'S', children: [CHILD] }),
        node({ scope: CHILD, fact: child, tier: 'S', parent: PARENT, labels: ['wayfinder:research'] }),
      ]),
      tier: 'S',
      accepted: baseline,
    })
    const childRead = read({
      scope: CHILD,
      fact: child,
      graph: graph(CHILD, [
        node({ scope: CHILD, fact: child, tier: 'S', parent: PARENT, labels: ['wayfinder:research'] }),
      ]),
      tier: 'S',
    })

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(childRead) })

    expect(result).toEqual({
      ok: true,
      value: {
        currentSpec: { snapshot: parent.snapshot, tier: 'S', children: [] },
        identityAllocations: [allocation(PARENT, 'C1')],
      },
    })
    expect(parentRead.accepted).toEqual(baseline)
  })

  it('refuses a proposed Spec whose current identity allocation is missing', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const parentRead = read({
      scope: PARENT,
      fact: parent,
      graph: graph(PARENT, [node({ scope: PARENT, fact: parent, tier: 'S' })]),
      tier: 'S',
      identity: {
        ok: true,
        value: { ...ledger(PARENT, parent.snapshot), allocations: new Map() },
      },
    })

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(parentRead) })

    expect(result).toEqual({ ok: false, diagnostics: [ledgerDiagnostic(PARENT)] })
  })

  it('refuses a proposed Spec whose current identity allocation is retired', async () => {
    const parent = fact(PARENT, 'Coordinate the release')
    const parentRead = read({
      scope: PARENT,
      fact: parent,
      graph: graph(PARENT, [node({ scope: PARENT, fact: parent, tier: 'S' })]),
      tier: 'S',
      identity: {
        ok: true,
        value: ledger(PARENT, parent.snapshot, ['C1']),
      },
    })

    const result = await readCurrentOwnSpecFacts({ uw: PARENT, read: parentRead, reader: reader(parentRead) })

    expect(result).toEqual({ ok: false, diagnostics: [ledgerDiagnostic(PARENT)] })
  })
})

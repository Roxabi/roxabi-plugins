import { describe, expect, it } from 'vitest'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import { type UwGraphObservation, type UwNativeNode, WAYFINDER_LABELS } from '../../engine/uw-graph.ts'
import { canonicalSpec, type SpecSnapshot } from '../../engine/uw-spec.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

const UW: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const OBSERVED_AT = '2026-10-27T12:00:00.000Z'

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((diagnostic) => diagnostic.code).join(','))
  return result.value
}

function fact(scope: Scope): SpecSnapshot {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: 'Save preserves the selected region' }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const parsed = parseIssueSpecBody({
    uw: scope,
    raw: rawSource(scope.target, renderIssueSpecBody(spec, { complexity: 5 }), OBSERVED_AT),
  })
  if (parsed.status !== 'conformant') throw new Error(`expected conformant Spec, received ${parsed.status}`)
  return parsed.snapshot
}

function graph(scope: Scope, snapshot: SpecSnapshot): UwGraphObservation {
  const labels = ['size:S']
  const node: UwNativeNode = {
    uw: scope,
    title: `In-memory UW ${scope.target}`,
    raw: snapshot.raw,
    updatedAt: OBSERVED_AT,
    labels,
    wayfinderLabels: labels.filter((label) => (WAYFINDER_LABELS as readonly string[]).includes(label)),
    parent: null,
    children: [],
    blockers: [],
    native: { state: 'OPEN', stateReason: null },
  }
  return { status: 'complete', root: scope, nodes: [node], observedAt: OBSERVED_AT }
}

function emptyHistory(scope: Scope): DecodedHistory {
  return {
    source: { scope, expectedAuthor: 'operator', stopAuthor: null, complete: true, comments: [], diagnostics: [] },
    operations: [],
    diagnostics: [],
  }
}

function copiedForeignMandate(scope: Scope, snapshot: SpecSnapshot): DecodedHistory {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope, {
    recordId: 'copied-mandate',
    operationId: 'copied-mandate-operation',
    ownSpec: fixtures.ownSpecFromSnapshot(scope, snapshot),
  })
  return fixtures.historyFrom([mandate], 'copied-author', 'operator')
}

function incompleteTrustedMandate(scope: Scope, snapshot: SpecSnapshot): DecodedHistory {
  const fixtures = roxabiWorkflowFixtures()
  const mandate = fixtures.featureMandate(scope, {
    recordId: 'trusted-mandate',
    operationId: 'trusted-mandate-operation',
    ownSpec: fixtures.ownSpecFromSnapshot(scope, snapshot),
  })
  const history = fixtures.historyFrom([mandate])
  const claim = history.operations.find((operation) => operation.recordId === mandate.recordId)
  if (claim === undefined) throw new Error('expected decoded mandate claim')
  return {
    ...history,
    operations: history.operations.map((operation) =>
      operation === claim ? { ...operation, status: 'incomplete', record: null } : operation,
    ),
  }
}

describe('createInstalledObservedUwReadPort authority boundary', () => {
  it('treats an in-memory foreign copied mandate claim as the same accepted absence as pre-mandate history', async () => {
    const snapshot = fact(UW)
    const observed = graph(UW, snapshot)
    const baseline = await createInstalledObservedUwReadPort({ graph: observed, histories: [emptyHistory(UW)] }).readUw(
      UW,
    )
    const foreignHistory = copiedForeignMandate(UW, snapshot)
    const foreign = await createInstalledObservedUwReadPort({ graph: observed, histories: [foreignHistory] }).readUw(UW)

    expect(foreignHistory.operations).toContainEqual(
      expect.objectContaining({
        operationId: 'copied-mandate-operation',
        kind: 'mandate',
        claimedKinds: expect.arrayContaining(['mandate']),
        authority: 'foreign',
      }),
    )
    expect(baseline.accepted).toEqual({ status: 'absent' })
    expect(foreign.accepted).toEqual({ status: 'absent' })
  })

  it('fails closed when the same in-memory mandate claim is trusted but unreconstructable', async () => {
    const snapshot = fact(UW)
    const history = incompleteTrustedMandate(UW, snapshot)
    const read = await createInstalledObservedUwReadPort({ graph: graph(UW, snapshot), histories: [history] }).readUw(
      UW,
    )

    expect(history.operations).toContainEqual(
      expect.objectContaining({
        operationId: 'trusted-mandate-operation',
        kind: 'mandate',
        claimedKinds: expect.arrayContaining(['mandate']),
        authority: 'accounted',
        status: 'incomplete',
        record: null,
      }),
    )
    expect(read.accepted).toMatchObject({
      status: 'refused',
      diagnostics: [expect.objectContaining({ code: 'accepted-unavailable' })],
    })
  })
})

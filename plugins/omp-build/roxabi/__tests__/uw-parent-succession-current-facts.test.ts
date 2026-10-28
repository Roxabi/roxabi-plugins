import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import { assessUwAdmission, resolveAcceptedSpec, resolveOwnSpecAuthority } from '../../dist/contracts.js'
import type { History } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { UwGraphObservation } from '../../engine/uw-graph.ts'
import { canonicalSpec } from '../../engine/uw-spec.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { freshOwnSpec } from '../feature-initial-mandate.ts'
import { readCurrentChildrenProjection, readCurrentOwnSpecFacts } from '../uw-current-facts.ts'
import { historicalProjection } from '../uw-normalization-internal.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

const parent: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const child: Scope = { repository: 'acme/payments', target: 'acme/payments#42' }
const time = '2026-10-21T00:00:00Z'

function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}

function snapshot(uw: Scope) {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: [{ id: 'C1', statement: `Deliver ${uw.target}` }],
      invariants: [],
      exclusions: [],
      openQuestions: [],
      sections: { origin: '', context: '', change: '' },
    }),
  )
  const parsed = parseIssueSpecBody({
    uw,
    raw: rawSource(uw.target, renderIssueSpecBody(spec, { complexity: 5 }), time),
  })
  if (parsed.status !== 'conformant') throw new Error('fixture Spec is not conformant')
  return parsed.snapshot
}

function history(scope: Scope, records: readonly CanonicalRecord[]) {
  const comments: History['comments'] = []
  for (const [index, record] of records.entries()) {
    const frames = must(encodeParts(record, `# ${record.kind}`, 65536))
    comments.push(
      ...frames.map((body, frame) => ({
        locator: `comment-${index}-${frame}`,
        nativeId: `${index * 10 + frame + 1}`,
        body,
        author: 'operator',
        createdAt: time,
        updatedAt: time,
      })),
    )
  }
  return decodeHistory({
    scope,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  })
}

test('abandoning a parent preserves factual child projection without restoring child delivery authority', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const parentSnapshot = snapshot(parent)
  const childSnapshot = snapshot(child)
  const childGrant = {
    scope: child,
    specVersion: childSnapshot.spec.version,
    snapshot: childSnapshot,
    tier: 'S' as const,
  }
  const p1 = fixtures.epicMandate(parent, [childGrant], {
    recordId: 'parent-p1',
    operationId: 'parent-p1-operation',
    ownSpec: fixtures.ownSpecFromSnapshot(parent, parentSnapshot),
  })
  const c1 = fixtures.featureMandate(child, {
    recordId: 'child-c1',
    operationId: 'child-c1-operation',
    ownSpec: fixtures.ownSpecFromSnapshot(child, childSnapshot),
    parent: { scope: parent, recordId: p1.recordId, kind: 'mandate' },
  })
  const abandon = must(
    buildRecord({
      version: 1,
      repository: parent.repository,
      target: parent.target,
      recordId: 'abandon-p1',
      runId: 'abandon-p1-run',
      operationId: 'abandon-p1-operation',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-p1',
        predecessor: null,
        mandate: { scope: parent, recordId: p1.recordId, kind: 'mandate' },
      },
    }),
  )
  const parentRecords = [fixtures.identityAllocation(parent), p1]
  const activeParent = history(parent, parentRecords)
  const abandonedParent = history(parent, [...parentRecords, abandon])
  const childHistory = history(child, [fixtures.identityAllocation(child), c1])
  const graph: UwGraphObservation = {
    status: 'complete',
    root: parent,
    observedAt: time,
    nodes: [
      {
        uw: parent,
        title: 'Parent',
        raw: parentSnapshot.raw,
        updatedAt: time,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [child],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
      {
        uw: child,
        title: 'Child',
        raw: childSnapshot.raw,
        updatedAt: time,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent,
        children: [],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
    ],
  }
  const activeReader = createInstalledObservedUwReadPort({ graph, histories: [activeParent, childHistory] })
  const inactiveReader = createInstalledObservedUwReadPort({ graph, histories: [abandonedParent, childHistory] })
  const activeParentRead = await activeReader.readUw(parent)
  const activeChildRead = await activeReader.readUw(child)
  expect(resolveOwnSpecAuthority(childHistory, [activeParent])).toMatchObject({ ok: true })
  expect(activeChildRead.accepted.status).toBe('accepted')
  const activeFacts = await readCurrentOwnSpecFacts({ uw: parent, read: activeParentRead, reader: activeReader })
  expect(activeFacts).toMatchObject({ ok: true, value: { currentSpec: { children: [childGrant] } } })
  expect(await freshOwnSpec(parent, activeParentRead, activeReader)).toMatchObject({ children: [childGrant] })

  expect(abandonedParent.source.complete).toBe(true)
  expect(childHistory.source.complete).toBe(true)
  expect(resolveAcceptedSpec(c1, [abandonedParent, childHistory])).toMatchObject({ ok: true })
  expect(resolveOwnSpecAuthority(childHistory, [abandonedParent])).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'abandoned' })]),
  })
  const parentRead = await inactiveReader.readUw(parent)
  const childRead = await inactiveReader.readUw(child)
  expect(childRead.accepted).toMatchObject({
    status: 'refused',
    diagnostics: [
      expect.objectContaining({ code: 'accepted-unavailable', message: expect.stringContaining('abandoned') }),
    ],
  })
  expect(childRead.proposed).toMatchObject({ ok: true, snapshot: childSnapshot })
  expect(childRead.identity).toMatchObject({ ok: true })
  expect(childRead.admission.framed).toMatchObject({ ok: true })
  expect(historicalProjection(childRead)).toMatchObject({
    accepted: { ref: { uw: child, sourceAccepted: { scope: child, recordId: c1.recordId, kind: 'mandate' } } },
  })
  if (!childRead.identity.ok) throw new Error('child identity fixture invalid')
  expect(
    assessUwAdmission({
      uw: child,
      graph,
      proposed: childRead.proposed,
      accepted: childRead.accepted,
      identities: childRead.identity.value,
      phase: 'delivery-transition',
      currentChildren: { ok: true, value: [] },
    }).deliverable,
  ).toMatchObject({ ok: false })

  const facts = await readCurrentOwnSpecFacts({ uw: parent, read: parentRead, reader: inactiveReader })
  expect(facts).toMatchObject({ ok: true, value: { currentSpec: { children: [childGrant] } } })
  expect(await freshOwnSpec(parent, parentRead, inactiveReader)).toMatchObject({ children: [childGrant] })

  if (childRead.accepted.status !== 'refused') throw new Error('child acceptance fixture must be refused')
  const syntheticRefusal = { ...activeChildRead, accepted: childRead.accepted }
  const spreadRefusal = { ...childRead }
  for (const unprovenRead of [syntheticRefusal, spreadRefusal]) {
    expect(historicalProjection(unprovenRead)).toBeUndefined()
    const reader = { readUw: async () => unprovenRead }
    const unprovenParentRead = { ...parentRead, observedReader: reader }
    const expected = { ok: false, diagnostics: childRead.accepted.diagnostics }
    expect(await readCurrentOwnSpecFacts({ uw: parent, read: unprovenParentRead, reader })).toEqual(expected)
    expect(await readCurrentChildrenProjection({ uw: parent, read: unprovenParentRead, reader })).toEqual(expected)
  }
})

import { expect, test } from 'vitest'
import { decodeHistory } from '../../adapters/github/history-codec.ts'
import { encodeParts } from '../../adapters/github/history-encoder.ts'
import { parseIssueSpecBody, rawSource, renderIssueSpecBody } from '../../adapters/github-native/uw-spec.ts'
import {
  acceptMaterialFixture,
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import type { History } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import type { Scope } from '../../engine/record-values.ts'
import type { UwGraphObservation } from '../../engine/uw-graph.ts'
import { type CriterionId, canonicalSpec, type SpecSnapshot, validateSpecIds } from '../../engine/uw-spec.ts'
import { resolveOwnSpecAuthority } from '../../engine/workflow-mandate-admission.ts'
import { roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

const uw: Scope = { repository: 'acme/payments', target: 'acme/payments#41' }
const time = '2026-10-21T00:00:00Z'
function must<T>(result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string }[] }): T {
  if (!result.ok) throw new Error(result.diagnostics.map((item) => item.code).join(','))
  return result.value
}
function snapshot(ids: readonly CriterionId[]) {
  const spec = must(
    canonicalSpec({
      format: 'omp-build-spec-content/1',
      criteria: ids.map((id) => ({ id, statement: `Commitment ${id}` })),
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
function graph(value: SpecSnapshot): UwGraphObservation {
  return {
    status: 'complete',
    root: uw,
    observedAt: time,
    nodes: [
      {
        uw,
        title: 'Fixture',
        raw: value.raw,
        updatedAt: time,
        labels: ['size:S'],
        wayfinderLabels: [],
        parent: null,
        children: [],
        blockers: [],
        native: { state: 'OPEN', stateReason: null },
      },
    ],
  }
}
function history(records: readonly CanonicalRecord[]) {
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
    scope: uw,
    expectedAuthor: 'operator',
    stopAuthor: null,
    complete: true,
    comments,
    diagnostics: [],
  })
}

test('accepted retirement survives abandonment and a compatible successor, and cannot be reused', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const original = snapshot(['C1', 'C2'])
  const own = fixtures.ownSpecFromSnapshot(uw, original)
  const allocationId = own.identityAllocations[0].recordId
  const digest = 'a'.repeat(64)
  const allocation = must(
    buildRecord({
      version: 1,
      repository: uw.repository,
      target: uw.target,
      recordId: allocationId,
      runId: allocationId,
      operationId: allocationId,
      kind: 'spec-identity',
      payload: {
        format: 'omp-build-spec-identity/1',
        predecessor: null,
        proposalDigest: digest,
        confirmation: {
          route: 'omp-native-command',
          operationId: allocationId,
          proposalDigest: digest,
          confirmedAt: time,
        },
        event: 'allocate',
        allocations: [
          { draftKey: 'one', id: 'C1' },
          { draftKey: 'two', id: 'C2' },
        ],
      },
    }),
  )
  const mandate = fixtures.featureMandate(uw, {
    recordId: 'mandate-original',
    operationId: 'op-original',
    ownSpec: own,
  })
  const initial = mandateAssessmentState(mandate)
  const retained = snapshot(['C2'])
  const assessed = assessFixture(
    mandate,
    'withdraw-c1',
    initial,
    proposedAssessmentState(initial, {
      body: retained.raw.body,
      content: {
        criteria: retained.spec.criteria,
        invariants: [],
        exclusions: [],
        openQuestions: [],
        sections: retained.spec.sections,
      },
    }),
    'material',
  )
  const acceptance = acceptMaterialFixture(mandate, 'accept-withdraw-c1', assessed)
  const abandon = must(
    buildRecord({
      version: 1,
      repository: uw.repository,
      target: uw.target,
      recordId: 'abandon-original',
      runId: 'abandon-run',
      operationId: 'abandon-operation',
      kind: 'operator-control',
      payload: {
        control: 'abandon',
        controlId: 'abandon-original',
        predecessor: null,
        mandate: { scope: uw, recordId: mandate.recordId, kind: 'mandate' },
      },
    }),
  )
  const records = [allocation, mandate, assessed.start, assessed.result, acceptance]
  const activeHistory = history(records)
  const inactiveHistory = history([...records, abandon])
  expect(activeHistory.source.complete).toBe(true)
  expect(activeHistory.operations.every((entry) => entry.status === 'complete' && entry.authority !== 'foreign')).toBe(
    true,
  )
  expect(resolveOwnSpecAuthority(activeHistory, [])).toMatchObject({ ok: true })
  expect(resolveOwnSpecAuthority(inactiveHistory, [])).toMatchObject({ ok: false })
  const active = await createInstalledObservedUwReadPort({ graph: graph(retained), histories: [activeHistory] }).readUw(
    uw,
  )
  const inactive = await createInstalledObservedUwReadPort({
    graph: graph(retained),
    histories: [inactiveHistory],
  }).readUw(uw)
  expect(active.accepted.status).toBe('accepted')
  expect(active.identity.ok && active.identity.value.retired.get('C1')?.recordId).toBe(acceptance.recordId)
  if (!inactive.identity.ok) throw new Error('inactive identity history must remain readable')
  expect(inactive.identity.value.allocations.has('C1')).toBe(true)
  expect(inactive.identity.value.allocations.has('C2')).toBe(true)
  expect.soft(inactive.identity.value.retired.get('C1')?.recordId).toBe(acceptance.recordId)
  expect.soft(validateSpecIds(original.spec, inactive.identity.value)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'spec-id-retired' })]),
  })
  const attemptedReuse = await createInstalledObservedUwReadPort({
    graph: graph(original),
    histories: [inactiveHistory],
  }).readUw(uw)
  expect.soft(attemptedReuse.admission.framed).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'spec-id-retired' })]),
  })

  const successor = fixtures.featureMandate(uw, {
    recordId: 'mandate-successor',
    operationId: 'op-successor',
    antecedent: { scope: uw, recordId: mandate.recordId, kind: 'mandate' },
    ownSpec: fixtures.ownSpecFromSnapshot(uw, retained),
  })
  const successorRead = await createInstalledObservedUwReadPort({
    graph: graph(retained),
    histories: [history([...records, abandon, successor])],
  }).readUw(uw)
  expect(successorRead.accepted.status).toBe('accepted')
  if (!successorRead.identity.ok) throw new Error('successor identity history must remain readable')
  expect.soft(successorRead.identity.value.retired.get('C1')?.recordId).toBe(acceptance.recordId)
  expect.soft(validateSpecIds(original.spec, successorRead.identity.value)).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'spec-id-retired' })]),
  })
  const successorReuse = await createInstalledObservedUwReadPort({
    graph: graph(original),
    histories: [history([...records, abandon, successor])],
  }).readUw(uw)
  expect(successorReuse.admission.framed).toMatchObject({
    ok: false,
    diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'spec-id-retired' })]),
  })
})

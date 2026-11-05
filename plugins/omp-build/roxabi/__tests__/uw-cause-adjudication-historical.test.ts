import { expect, it } from 'vitest'
import {
  assessFixture,
  mandateAssessmentState,
  proposedAssessmentState,
} from '../../engine/__tests__/workflow-spec-assessment-support.ts'
import { assessCauseDispositions } from '../../engine/cause-disposition.ts'
import type { DecodedHistory } from '../../engine/history-schema.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { resolveOwnSpecEffective } from '../../engine/spec-effective.ts'
import { resolveAcceptedSpec } from '../../engine/workflow-accepted-spec.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { fixtureCatalogueGhResponse, fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { authenticatedReview } from '../../testing/cause-input-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { roxabiRecordFixtures, roxabiWorkflowFixtures } from '../../testing/roxabi-presets.ts'
import { readAdjudicationPending } from '../uw-cause-adjudication-read.ts'
import { createInstalledObservedUwReadPort } from '../uw-read-port.ts'

function must<T>(
  result: { ok: true; value: T } | { ok: false; diagnostics: readonly { code: string; message: string }[] },
): T {
  if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
  return result.value
}

it('authenticates an unresolved Spec A hold for adjudication after Spec B is accepted', async () => {
  const fixtures = roxabiWorkflowFixtures()
  const { projection } = roxabiRecordFixtures()
  const { graph, context: fixtureContext } = authenticatedReview()
  const uw = fixtureContext.original
  const mandate = fixtures.featureMandate(uw, { recordId: 'mandate-42', body: 'Save the selected region' })
  const allocation = mandate.payload.ownSpec.identityAllocations[0]
  if (allocation === undefined) throw new Error('Expected mandate identity allocation')
  const identity = fixtures.identityAllocation(uw, allocation.recordId)
  let own = encodeCriterionRecords([identity, mandate], uw, projection, 'operator').history
  const source = encodeCriterionRecords(
    recordsOf(graph.history).filter((record) => record.kind !== 'review'),
    graph.history.source.scope,
    projection,
    'operator',
    [own],
  ).history
  const acceptedA = resolveAcceptedSpec(mandate, [own, source])
  if (!acceptedA.ok) throw new Error(`Spec A unavailable: ${acceptedA.reason}`)
  const contextA = { original: uw, effective: must(resolveOwnSpecEffective(acceptedA.spec)) }
  const decision = recordsOf(source).find(
    (record) => record.kind === 'decision' && record.recordId === graph.decision.recordId,
  )
  if (decision?.kind !== 'decision') throw new Error('Encoded review decision is missing')
  const assessment = must(
    assessCauseDispositions({
      context: contextA,
      source: { kind: 'decision', decision },
      histories: [own, source],
      catalogues: fixtureReviewClassCatalogues(),
      adjudications: [],
    }),
  )
  const payload = assessment.outcomes.find((item) => item.subject.kind === 'cause')
  if (payload?.outcome.state !== 'pending-blocking') throw new Error('Expected unresolved Spec A hold')
  const pending = must(
    buildRecord({
      version: 1,
      ...uw,
      recordId: 'historical-pending',
      runId: 'historical-run',
      operationId: 'write-historical-pending',
      kind: 'cause-disposition',
      payload,
    }),
  )
  if (pending.kind !== 'cause-disposition') throw new Error('Expected disposition')
  own = encodeCriterionRecords([pending], uw, projection, 'operator', [source], own).history
  const ref = { scope: uw, recordId: pending.recordId, kind: pending.kind }

  const histories = new Map<string, DecodedHistory>([
    [uw.target, own],
    [source.source.scope.target, source],
  ])
  const github = {
    cwd: '/fixture',
    readAuthor: 'operator',
    gh: async (_cwd: string, args: string[]) => {
      const catalogue = fixtureCatalogueGhResponse(args)
      if (catalogue !== null) return catalogue
      const match = /^repos\/acme\/app\/issues\/(\d+)\/comments\?per_page=100&page=(\d+)$/.exec(args[1] ?? '')
      if (args[0] !== 'api' || !match) throw new Error(`Unexpected GH read: ${JSON.stringify(args)}`)
      const history = histories.get(`acme/app#${match[1]}`)
      if (!history) throw new Error(`Unexpected scope: ${match[1]}`)
      const page = Number(match[2])
      return JSON.stringify(
        history.source.comments.slice((page - 1) * 100, page * 100).map((comment, index) => ({
          id: (page - 1) * 100 + index + 1,
          body: comment.body,
          user: { login: comment.author },
          created_at: comment.createdAt,
          updated_at: comment.updatedAt,
        })),
      )
    },
  }
  const reader = (raw: typeof mandate.payload.ownSpec.snapshot.raw) =>
    createInstalledObservedUwReadPort({
      graph: {
        status: 'complete',
        root: uw,
        observedAt: '2026-10-27T12:00:00.000Z',
        nodes: [
          {
            uw,
            title: 'Save the selected region',
            raw,
            updatedAt: '2026-10-27T12:00:00.000Z',
            labels: [`size:${mandate.payload.tier}`],
            wayfinderLabels: [],
            parent: null,
            children: [],
            blockers: [],
            native: { state: 'OPEN', stateReason: null },
          },
        ],
      },
      histories: [own, source],
      catalogues: fixtureReviewClassCatalogues(),
    })
  // Authenticate the original review and pending root through the same composed GitHub reader first.
  const initial = await readAdjudicationPending(ref, reader(mandate.payload.ownSpec.snapshot.raw), github)
  expect(initial.disposition).toEqual(pending)
  expect(initial.context).toEqual(contextA)

  const accepted = mandateAssessmentState(mandate)
  const proposed = proposedAssessmentState(accepted, { body: 'Editorial clarification of selected region' })
  const amendment = assessFixture(mandate, 'historical-editorial', accepted, proposed, 'editorial')
  own = encodeCriterionRecords([amendment.start, amendment.result], uw, projection, 'operator', [source], own).history
  histories.set(uw.target, own)
  const acceptedB = resolveAcceptedSpec(mandate, [own, source])
  if (!acceptedB.ok) throw new Error(`Spec B unavailable: ${acceptedB.reason}`)
  expect(acceptedB.spec.ref.version).not.toEqual(acceptedA.spec.ref.version)
  const currentReader = reader(amendment.proposed.snapshot.raw)
  const current = await currentReader.readUw(uw)
  expect(current.accepted.status).toBe('accepted')
  if (current.accepted.status !== 'accepted') throw new Error('Reader did not accept Spec B')
  expect(current.accepted.value).toEqual(acceptedB.spec)

  const historical = await readAdjudicationPending(ref, currentReader, github)
  expect(historical.disposition).toEqual(pending)
  expect(historical.disposition.payload.outcome.state).toBe('pending-blocking')
  expect(historical.context).toEqual(contextA)
})

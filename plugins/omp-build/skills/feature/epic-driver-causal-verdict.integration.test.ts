import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../../contracts.ts'
import { buildRecord } from '../../engine/record-construction.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { committedFixtureProjection } from '../../testing/committed-plugin-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../testing/criterion-range-approval.ts'
import { submission } from '../../testing/record-builders.ts'
import { contribution } from '../../testing/record-decisions.ts'
import { landedEpic } from './testing/epic-driver/epic-driver-landed-fixture.ts'
import { type EpicParentWorld, prepareEpicParentReview } from './testing/epic-driver/epic-driver-parent-review.ts'
import {
  eventPayloads,
  issueComments,
  ME,
  recordHistory,
  serveComments,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

async function causalEpicReview(world: EpicParentWorld, disposition: 'report' | 'fix-original') {
  const prepared = await prepareEpicParentReview(world)
  const { mandate, inputs, head, range, issueRecords, coverageReferences } = prepared
  const scope = { repository: 'o/r', target: 'o/r#1' }
  const initial = decodeHistory(recordHistory(1, issueComments(1)))
  const graph = criterionEpicReviewGraph({
    mandate,
    inputs,
    head,
    range,
    issueRecords,
    coverageReferences,
    prefix: `causal-${head.slice(0, 8)}`,
    blocking: true,
  })
  const projection = committedFixtureProjection(import.meta.dirname, graph.inputs)
  const findings = graph.panel.payload.findings?.map((finding) => {
    if (finding.data === null || typeof finding.data !== 'object' || Array.isArray(finding.data))
      throw new Error('Expected a structured original finding')
    return { ...finding, data: { ...finding.data, label: 'suggestion' as const } }
  })
  if (!findings?.length) throw new Error('Expected a nonblocking original finding')
  const panelStructured = { findings: findings.map((finding) => finding.data) }
  const panel = {
    ...graph.panel,
    payload: {
      ...graph.panel.payload,
      findings,
      structured: panelStructured,
      rawAttempts: [
        submission({
          id: `child-${graph.panel.recordId}`,
          structuredOutput: { status: 'valid', data: panelStructured },
        }),
      ],
    },
  }
  if (graph.decision.payload.judgment.purpose !== 'review') throw new Error('Expected review judgment')
  const selection = graph.inputs.manifest.deliveryData.find((ref) => ref.role === 'implementation')
  if (!selection) throw new Error('Expected selected implementation evidence')
  const { role: _role, ...citation } = selection
  const supported = (value: boolean) => ({
    state: 'supported' as const,
    value,
    reason: 'The selected implementation record establishes this judgment',
    references: [citation],
  })
  const judgment = {
    ...graph.decision.payload.judgment,
    findings: graph.decision.payload.judgment.findings.map((finding) => ({ ...finding, label: 'suggestion' as const })),
    causes: graph.decision.payload.judgment.causes.map((cause) => ({
      ...cause,
      judgment: {
        necessary: supported(disposition === 'fix-original'),
        urgent: supported(true),
        tooLarge: supported(false),
      },
      proposedDisposition: disposition,
    })),
  }
  const decision = { ...graph.decision, payload: { ...graph.decision.payload, judgment } }
  const synthesis = contribution({
    id: graph.synthesisContribution.recordId,
    scope,
    inventoryId: graph.synthesis.recordId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    structured: judgment,
    rawAttempts: [
      submission({
        id: `child-${graph.synthesisContribution.recordId}`,
        structuredOutput: { status: 'valid', data: judgment },
      }),
    ],
  })
  const otherHistories = prepared.observation.histories.filter(
    (history) => history.source.scope.target !== scope.target,
  )
  const before = encodeCriterionRecords(
    [graph.root, graph.spec, panel, graph.synthesis, synthesis, decision],
    scope,
    projection,
    ME,
    otherHistories,
    initial,
  )
  const authenticated = recordsOf(before.history).find((record) => record.recordId === decision.recordId)
  if (authenticated?.kind !== 'decision') throw new Error('Expected authenticated Epic decision')
  const nativeGraph = prepared.observation.graph
  const assessed = criterionDispositionRecords(
    graph.inputs,
    authenticated,
    [before.history, ...otherHistories],
    projection.catalogues,
    nativeGraph,
  )
  const persisted = encodeCriterionRecords(assessed.dispositions, scope, projection, ME, otherHistories, before.history)
  const review = buildRecord({
    ...graph.review,
    payload: {
      ...graph.review.payload,
      causeDispositionRefs: assessed.dispositions.map((record) => ({
        scope,
        kind: 'cause-disposition' as const,
        recordId: record.recordId,
      })),
    },
  })
  if (!review.ok || review.value.kind !== 'review') throw new Error('Invalid Epic review with dispositions')
  const final = encodeCriterionRecords([review.value], scope, projection, ME, otherHistories, persisted.history)
  serveComments(1, [
    ...issueComments(1),
    ...before.comments.map(({ body }) => ({ body, author: ME })),
    ...persisted.comments.map(({ body }) => ({ body, author: ME })),
    ...final.comments.map(({ body }) => ({ body, author: ME })),
  ])
  return { range, decisionId: decision.recordId, inventoryIds: [graph.root.recordId, graph.synthesis.recordId] }
}

describe('epic-driver — canonical final review history', () => {
  it.each([
    { disposition: 'report' as const, step: { action: 'post-merge' } },
    { disposition: 'fix-original' as const, step: { action: 'final-review', stage: 'fix-ticket' } },
  ])('binds and replays the effective $disposition verdict', async ({ disposition, step }) => {
    const world = await landedEpic()
    const { range, decisionId, inventoryIds } = await causalEpicReview(world, disposition)
    const stored = recordsOf(decodeHistory(recordHistory(1, issueComments(1))))
    expect(stored.filter((record) => record.kind === 'cause-disposition')).toEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          outcome: expect.objectContaining({ state: 'final', disposition }),
        }),
      }),
    ])

    const bound = drive(['review', '--decision-record', decisionId, '--range', range])
    expect(bound.code, bound.stderr).toBe(0)
    expect(eventPayloads(1)).toContainEqual(
      expect.objectContaining({
        event: 'epic-review',
        decisionId,
        dispositionIds: stored.filter((record) => record.kind === 'cause-disposition').map((record) => record.recordId),
        inventoryIds: expect.arrayContaining(inventoryIds),
        range,
      }),
    )
    const replay = drive(['next', '--dry-run'])
    expect(replay.code, replay.stderr).toBe(0)
    expect(replay.json().step).toMatchObject(step)
  })

  it('refuses initial binding when the assessed disposition is not persisted', async () => {
    const world = await landedEpic()
    const { range, decisionId } = await causalEpicReview(world, 'fix-original')
    const comments = issueComments(1)
    const operation = decodeHistory(recordHistory(1, comments)).operations.find(
      ({ record }) => record?.kind === 'cause-disposition',
    )
    expect(operation).toBeDefined()
    const removed = new Set(operation?.parts.map((part) => part.nativeId))
    serveComments(
      1,
      comments.filter((_, index) => !removed.has(String(index + 1))),
    )

    const bound = drive(['review', '--decision-record', decisionId, '--range', range])
    expect(bound.code, bound.stderr).toBe(2)
    expect(eventPayloads(1)).not.toContainEqual(expect.objectContaining({ event: 'epic-review', decisionId }))
  })
})

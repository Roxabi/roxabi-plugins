import { afterEach, describe, expect, it } from 'vitest'
import { decodeHistory } from '../../contracts.ts'
import { actionInputDigest, canonicalValueDigest } from '../../engine/action-input.ts'
import { recordsOf } from '../../engine/workflow-control.ts'
import { acceptedActionInputs } from '../../testing/action-input-fixtures.ts'
import { committedFixturePlugin, committedFixtureProjection } from '../../testing/committed-plugin-fixture.ts'
import { encodeCriterionRecords } from '../../testing/criterion-approval.ts'
import { criterionDispositionRecords } from '../../testing/criterion-dispositions.ts'
import { criterionEpicReviewGraph } from '../../testing/criterion-range-approval.ts'
import { submission } from '../../testing/record-builders.ts'
import { contribution } from '../../testing/record-decisions.ts'
import { serveBoundEpic } from './testing/epic-driver/epic-driver-bound-fixture.ts'
import { landedEpic } from './testing/epic-driver/epic-driver-landed-fixture.ts'
import {
  childNode,
  eventPayloads,
  issueComments,
  ME,
  recordHistory,
  serveComments,
} from './testing/epic-driver/epic-driver-records.ts'
import { cleanupSandbox, drive, git } from './testing/epic-driver/epic-driver-sandbox.ts'

afterEach(cleanupSandbox)

function causalEpicReview(range: string, disposition: 'report' | 'fix-original') {
  const [baseCommit, head] = range.split('..')
  if (!baseCommit || !head) throw new Error('Expected an Epic range')
  const scope = { repository: 'o/r', target: 'o/r#1' }
  const initial = decodeHistory(recordHistory(1, issueComments(1)))
  const mandate = recordsOf(initial).find((record) => record.kind === 'mandate')
  if (mandate?.kind !== 'mandate') throw new Error('Expected accepted Epic mandate')
  const base = acceptedActionInputs(mandate, 'review')
  const manifest = {
    ...base.manifest,
    acceptedSources: [
      {
        source: 'record' as const,
        record: { scope, recordId: mandate.recordId, kind: mandate.kind },
        selector: '/payload',
        digest: canonicalValueDigest(mandate.payload),
      },
    ],
    code: { repository: mandate.repository, base: baseCommit, head, referenceCommit: head },
    plugin: committedFixturePlugin(
      import.meta.dirname,
      base.manifest.plugin,
      git(import.meta.dirname, 'rev-parse', 'HEAD'),
    ),
  }
  const inputs = { ...base, manifest, fingerprint: actionInputDigest(manifest) }
  const graph = criterionEpicReviewGraph({
    mandate,
    inputs,
    head,
    range,
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
  const implementation = graph.issueRecords.filter((record) => record.kind !== 'mandate')
  const before = encodeCriterionRecords(
    [...implementation, graph.root, graph.spec, panel, graph.synthesis, synthesis, decision],
    scope,
    projection,
    ME,
    [],
    initial,
  )
  const authenticated = recordsOf(before.history).find((record) => record.recordId === decision.recordId)
  if (authenticated?.kind !== 'decision') throw new Error('Expected authenticated Epic decision')
  const assessed = criterionDispositionRecords(graph.inputs, authenticated, [before.history], projection.catalogues)
  const persisted = encodeCriterionRecords(assessed.dispositions, scope, projection, ME, [], before.history)
  serveComments(1, [
    ...issueComments(1),
    ...before.comments.map(({ body }) => ({ body, author: ME })),
    ...persisted.comments.map(({ body }) => ({ body, author: ME })),
  ])
  return { decisionId: decision.recordId, inventoryIds: [graph.root.recordId, graph.synthesis.recordId] }
}

describe('epic-driver — canonical final review history', () => {
  it.each([
    { disposition: 'report' as const, step: { action: 'post-merge' } },
    { disposition: 'fix-original' as const, step: { action: 'final-review', stage: 'fix-ticket' } },
  ])('binds and replays the effective $disposition verdict', ({ disposition, step }) => {
    const { range, merged } = landedEpic()
    serveBoundEpic(childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] }), 10, 'feat/2-first-child')
    const { decisionId, inventoryIds } = causalEpicReview(range, disposition)
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

  it('refuses initial binding when the assessed disposition is not persisted', () => {
    const { range, merged } = landedEpic()
    serveBoundEpic(childNode(2, 'feat(x): first child', { state: 'CLOSED', prs: [merged] }), 10, 'feat/2-first-child')
    const { decisionId } = causalEpicReview(range, 'fix-original')
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

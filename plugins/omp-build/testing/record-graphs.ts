import type { CanonicalRecord } from '../engine/record-schema.ts'
import type { Label } from '../engine/record-values.ts'
import { finding, reviewRoot, submission, synthesisInventory, TEST_HEAD } from './record-builders.ts'
import { contribution, decision, finalReview } from './record-decisions.ts'
import { history } from './record-history.ts'

export function reviewGraph(options: { prefix?: string; label?: Label; head?: string; empty?: boolean } = {}) {
  const prefix = options.prefix ?? 'review'
  const rootId = `${prefix}-root`
  const synthesisId = `${prefix}-synthesis`
  const panelId = `${prefix}-panel`
  const synthesisContributionId = `${prefix}-decision-source`
  const decisionId = `${prefix}-decision`
  const reviewId = `${prefix}-final`
  const head = options.head ?? TEST_HEAD
  const root = reviewRoot({ id: rootId, head })
  const specStructured = { findings: [], specRows: [] }
  const spec = contribution({
    id: `${prefix}-spec`,
    inventoryId: rootId,
    phase: 'spec',
    role: 'R-spec',
    slotId: 'spec-0',
    chunk: null,
    findings: [],
    structured: specStructured,
    rawAttempts: [
      submission({ id: `child-${prefix}-spec`, structuredOutput: { status: 'valid', data: specStructured } }),
    ],
  })
  const panelFindings = options.empty
    ? []
    : [{ id: `${panelId}:f0`, attemptIndex: 0, data: finding({ label: options.label ?? 'issue' }) }]
  const panel = contribution({ id: panelId, inventoryId: rootId, findings: panelFindings })
  const synthesis = synthesisInventory({ id: synthesisId, rootId, head })
  const reviewDecision = decision({
    id: decisionId,
    originalContributionId: synthesisContributionId,
    sourceContributionIds: [spec.recordId, panelId],
    findings: options.empty
      ? []
      : [
          {
            id: `${prefix}-finding-final`,
            label: options.label ?? 'issue',
            impactReason: 'The saved region is wrong.',
            state: 'usable',
            sourceFindingIds: [`${panelId}:f0`],
            description: 'Save the selected region rather than the stale region.',
          },
        ],
  })
  const synthesisContribution = contribution({
    id: synthesisContributionId,
    inventoryId: synthesisId,
    phase: 'synthesis',
    role: 'R-synthesis',
    slotId: 'synthesis-0',
    chunk: null,
    content: 'decision',
    rawAttempts: [
      submission({
        id: `child-${synthesisContributionId}`,
        structuredOutput: { status: 'valid', data: reviewDecision.payload.judgment },
      }),
    ],
    structured: reviewDecision.payload.judgment,
  })
  const review = finalReview({ id: reviewId, head, inventoryIds: [rootId, synthesisId], decisionId })
  const records = [root, spec, panel, synthesis, synthesisContribution, reviewDecision, review] as CanonicalRecord[]
  return {
    root,
    spec,
    panel,
    synthesis,
    synthesisContribution,
    decision: reviewDecision,
    review,
    records,
    history: history(records),
  }
}

export function epicReviewGraph(options: { prefix?: string; head?: string; empty?: boolean } = {}) {
  const graph = reviewGraph({ prefix: options.prefix ?? 'epic', head: options.head, empty: options.empty })
  const root = reviewRoot({
    id: graph.root.recordId,
    head: options.head,
    subject: { kind: 'epic-range', range: `0000000000000000000000000000000000000000..${options.head ?? TEST_HEAD}` },
  })
  const reviewDecision = {
    ...graph.decision,
    payload: { ...graph.decision.payload, judgment: { ...graph.decision.payload.judgment, standards: null } },
  }
  const synthesisContribution = {
    ...graph.synthesisContribution,
    payload: {
      ...graph.synthesisContribution.payload,
      rawAttempts: [
        submission({
          id: `child-${graph.synthesisContribution.recordId}`,
          structuredOutput: { status: 'valid', data: reviewDecision.payload.judgment },
        }),
      ],
      structured: reviewDecision.payload.judgment,
    },
  }
  const records = graph.records
    .filter((record) => record.kind !== 'review')
    .map((record) => {
      if (record.recordId === root.recordId) return root
      if (record.recordId === reviewDecision.recordId) return reviewDecision
      if (record.recordId === synthesisContribution.recordId) return synthesisContribution
      return record
    })
  return { ...graph, root, synthesisContribution, decision: reviewDecision, records, history: history(records) }
}

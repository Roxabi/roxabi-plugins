import { describe, expect, test } from 'vitest'
import { finding, reviewRoot, submission, synthesisInventory } from '../../testing/record-builders.ts'
import { contribution, decision, finalReview } from '../../testing/record-decisions.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history } from '../../testing/record-history.ts'
import { inspectFinding } from '../producer-schema.ts'
import { validateDecision, validateDecisionBindings, validateReviewDecisionBindings } from '../review-decision.ts'
import { assessmentCodes, TAXONOMY } from './record-test-support.ts'

describe('canonical finding conservation', () => {
  test('retains a known blocking label from an invalid model source and refuses admission', () => {
    const raw = { label: 'issue(blocking)', description: 'The model omitted all location evidence.' }
    const root = reviewRoot({ id: 'invalid-root' })
    const synthesis = synthesisInventory({ id: 'invalid-synthesis', rootId: root.recordId })
    const spec = contribution({
      id: 'invalid-spec',
      inventoryId: root.recordId,
      phase: 'spec',
      role: 'R-spec',
      slotId: 'spec-0',
      chunk: null,
      findings: [],
      structured: { findings: [], specRows: [] },
      rawAttempts: [
        submission({
          id: 'child-invalid-spec',
          structuredOutput: { status: 'valid', data: { findings: [], specRows: [] } },
        }),
      ],
    })
    const source = contribution({
      id: 'invalid-source',
      inventoryId: root.recordId,
      findings: [{ id: 'invalid-source:f0', attemptIndex: 0, data: raw }],
      structured: null,
    })
    const modelDecision = decision({
      id: 'invalid-decision',
      originalContributionId: 'invalid-decision-source',
      sourceContributionIds: ['invalid-spec', 'invalid-source'],
      findings: [
        {
          id: 'invalid-final',
          label: 'issue(blocking)',
          impactReason: 'The raw source names a data-loss risk.',
          state: 'unusable',
          sourceFindingIds: ['invalid-source:f0'],
        },
      ],
    })
    const decisionSource = contribution({
      id: 'invalid-decision-source',
      inventoryId: synthesis.recordId,
      phase: 'synthesis',
      role: 'R-synthesis',
      slotId: 'synthesis-0',
      chunk: null,
      content: 'decision',
      rawAttempts: [
        submission({
          id: 'child-invalid-decision-source',
          structuredOutput: { status: 'valid', data: modelDecision.payload.judgment },
        }),
      ],
      structured: modelDecision.payload.judgment,
    })
    const final = finalReview({
      id: 'invalid-final-review',
      inventoryIds: [root.recordId, synthesis.recordId],
      decisionId: modelDecision.recordId,
    })

    expect(inspectFinding(raw, TAXONOMY)).toEqual({
      usable: false,
      knownLabel: 'issue(blocking)',
      diagnostics: [{ code: 'unusable-finding', message: 'Original finding is not a strict canonical finding' }],
    })
    const retained = history([root, spec, source, synthesis, decisionSource, modelDecision, final])
    const assessment = validateDecision(modelDecision, retained, TAXONOMY, null)
    const duplicateSources = {
      ...modelDecision,
      payload: {
        ...modelDecision.payload,
        judgment: { ...modelDecision.payload.judgment, sourceContributionIds: ['invalid-source', 'invalid-source'] },
      },
    }
    const inventedSource = {
      ...modelDecision,
      payload: {
        ...modelDecision.payload,
        judgment: { ...modelDecision.payload.judgment, sourceContributionIds: ['invented-source'] },
      },
    }

    const bindings = validateDecisionBindings(modelDecision, retained)
    expect(bindings, JSON.stringify(bindings)).toMatchObject({ admissible: true })
    expect(validateDecisionBindings(duplicateSources, retained)).toMatchObject({ admissible: false })
    expect(validateDecisionBindings(inventedSource, retained)).toMatchObject({ admissible: false })
    expect(assessment).toMatchObject({
      admissible: false,
      verdict: null,
      groups: { Blockers: ['invalid-final'], Warnings: [], Suggestions: [], Praise: [] },
    })
    expect(assessment.diagnostics.map(({ code }) => code)).toContain('unusable-finding')
  })

  test('does not mechanically upgrade a valid model downgrade to the source severity', () => {
    const graph = reviewGraph({ prefix: 'downgrade', label: 'issue(blocking)' })
    const modelDecision = {
      ...graph.decision,
      payload: {
        ...graph.decision.payload,
        judgment: {
          ...graph.decision.payload.judgment,
          findings: [
            {
              ...graph.decision.payload.judgment.findings[0],
              label: 'suggestion' as const,
            },
          ],
        },
      },
    }
    const synthesis = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        rawAttempts: [
          submission({
            id: 'child-downgrade-decision-source',
            structuredOutput: { status: 'valid', data: modelDecision.payload.judgment },
          }),
        ],
        structured: modelDecision.payload.judgment,
      },
    }
    const records = graph.records.map((record) =>
      record.recordId === modelDecision.recordId
        ? modelDecision
        : record.recordId === synthesis.recordId
          ? synthesis
          : record,
    )

    expect(validateDecision(modelDecision, history(records), TAXONOMY, null)).toMatchObject({
      admissible: true,
      verdict: 'Approve with comments',
      groups: { Blockers: [], Warnings: ['downgrade-finding-final'], Suggestions: [], Praise: [] },
    })
  })

  test('maps every canonical label to its published disposition, with blockers dominating mixed reviews', () => {
    const cases = [
      ['issue', 'Blockers', 'Request changes'],
      ['issue(blocking)', 'Blockers', 'Request changes'],
      ['todo', 'Blockers', 'Request changes'],
      ['suggestion(blocking)', 'Blockers', 'Request changes'],
      ['suggestion', 'Warnings', 'Approve with comments'],
      ['suggestion(non-blocking)', 'Warnings', 'Approve with comments'],
      ['nitpick', 'Warnings', 'Approve with comments'],
      ['thought', 'Suggestions', 'Approve'],
      ['question', 'Suggestions', 'Approve'],
      ['praise', 'Praise', 'Approve'],
    ] as const

    for (const [label, group, verdict] of cases) {
      const graph = reviewGraph({ prefix: `label-${label.replaceAll(/[^a-z]/g, '-')}`, label })
      const assessment = validateDecision(graph.decision, graph.history, TAXONOMY, null)
      expect(assessment).toMatchObject({
        admissible: true,
        verdict,
        groups: { [group]: [`label-${label.replaceAll(/[^a-z]/g, '-')}-finding-final`] },
      })
    }
    const blocker = reviewGraph({ prefix: 'mixed-blocker', label: 'issue' })
    const blockerFinding = finding({ label: 'issue' })
    const warningFinding = finding({ label: 'suggestion' })
    const panel = {
      ...blocker.panel,
      payload: {
        ...blocker.panel.payload,
        findings: [
          { id: `${blocker.panel.recordId}:f0`, attemptIndex: 0, data: blockerFinding },
          { id: `${blocker.panel.recordId}:f1`, attemptIndex: 0, data: warningFinding },
        ],
        rawAttempts: [
          submission({
            id: 'child-mixed-blocker-panel',
            structuredOutput: { status: 'valid', data: { findings: [blockerFinding, warningFinding] } },
          }),
        ],
        structured: { findings: [blockerFinding, warningFinding] },
      },
    }
    const decision = {
      ...blocker.decision,
      payload: {
        ...blocker.decision.payload,
        judgment: {
          ...blocker.decision.payload.judgment,
          findings: [
            ...blocker.decision.payload.judgment.findings,
            {
              id: 'mixed-warning-final',
              label: 'suggestion' as const,
              impactReason: 'Non-blocking fixture warning.',
              state: 'usable' as const,
              sourceFindingIds: [`${blocker.panel.recordId}:f1`],
              description: 'Keep the warning visible.',
            },
          ],
        },
      },
    }
    const synthesis = {
      ...blocker.synthesisContribution,
      payload: {
        ...blocker.synthesisContribution.payload,
        rawAttempts: [
          submission({
            id: 'child-mixed-blocker-decision-source',
            structuredOutput: { status: 'valid', data: decision.payload.judgment },
          }),
        ],
        structured: decision.payload.judgment,
      },
    }
    const records = blocker.records.map((record) =>
      record.recordId === panel.recordId
        ? panel
        : record.recordId === decision.recordId
          ? decision
          : record.recordId === synthesis.recordId
            ? synthesis
            : record,
    )
    expect(validateDecision(decision, history(records), TAXONOMY, null)).toMatchObject({
      admissible: true,
      verdict: 'Request changes',
      groups: { Blockers: ['mixed-blocker-finding-final'], Warnings: ['mixed-warning-final'] },
    })
  })

  test('refuses a structurally bound final when an operation is incomplete or a newer root remains pending', () => {
    const graph = reviewGraph({ prefix: 'bound-review' })
    const incomplete = history(graph.records, {
      operations: graph.history.operations.map((entry) =>
        entry.recordId === graph.review.recordId ? { ...entry, status: 'incomplete' as const } : entry,
      ),
    })
    expect(validateReviewDecisionBindings(graph.review, incomplete).ok).toBe(false)

    const pending = reviewRoot({ id: 'pending-root', operationId: 'pending-root-operation' })
    const withPendingRoot = history([...graph.records, pending])
    expect(validateReviewDecisionBindings(graph.review, withPendingRoot).ok).toBe(false)
  })

  test('keeps distinct findings at one anchor unless the decision explicitly merges them', () => {
    const graph = reviewGraph({ prefix: 'shared-anchor' })
    const first = finding({ label: 'suggestion' })
    const second = finding({ label: 'suggestion', description: 'Widget save also drops the selected zone.' })
    const source = {
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        findings: [
          { id: 'shared-anchor-panel:f0', attemptIndex: 0, data: first },
          { id: 'shared-anchor-panel:f1', attemptIndex: 0, data: second },
        ],
        rawAttempts: [
          submission({
            id: 'child-shared-anchor-panel',
            structuredOutput: { status: 'valid', data: { findings: [first, second] } },
          }),
        ],
        structured: { findings: [first, second] },
      },
    }
    const separate = {
      ...graph.decision,
      payload: {
        ...graph.decision.payload,
        judgment: {
          ...graph.decision.payload.judgment,
          findings: [
            {
              id: 'first-final',
              label: 'suggestion' as const,
              impactReason: 'Region is lost.',
              state: 'usable' as const,
              sourceFindingIds: ['shared-anchor-panel:f0'],
              description: 'Persist the selected region.',
            },
            {
              id: 'second-final',
              label: 'suggestion' as const,
              impactReason: 'Zone is lost.',
              state: 'usable' as const,
              sourceFindingIds: ['shared-anchor-panel:f1'],
              description: 'Persist the selected zone.',
            },
          ],
        },
      },
    }
    const synthesis = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        rawAttempts: [
          submission({
            id: 'child-shared-anchor-decision-source',
            structuredOutput: { status: 'valid', data: separate.payload.judgment },
          }),
        ],
        structured: separate.payload.judgment,
      },
    }
    const records = graph.records.map((record) =>
      record.recordId === source.recordId
        ? source
        : record.recordId === separate.recordId
          ? separate
          : record.recordId === synthesis.recordId
            ? synthesis
            : record,
    )
    const implicitMerge = {
      ...separate,
      payload: {
        ...separate.payload,
        judgment: {
          ...separate.payload.judgment,
          findings: [
            {
              id: 'merged-final',
              label: 'suggestion' as const,
              impactReason: 'Both persisted fields are stale.',
              state: 'usable' as const,
              sourceFindingIds: ['shared-anchor-panel:f0', 'shared-anchor-panel:f1'],
              description: 'Persist the selected fields.',
            },
          ],
        },
      },
    }
    const mergedSynthesis = {
      ...synthesis,
      payload: {
        ...synthesis.payload,
        rawAttempts: [
          submission({
            id: 'child-shared-anchor-decision-source',
            structuredOutput: { status: 'valid', data: implicitMerge.payload.judgment },
          }),
        ],
        structured: implicitMerge.payload.judgment,
      },
    }
    const mergedRecords = records.map((record) =>
      record.recordId === implicitMerge.recordId
        ? implicitMerge
        : record.recordId === mergedSynthesis.recordId
          ? mergedSynthesis
          : record,
    )

    expect(validateDecision(separate, history(records), TAXONOMY, null)).toMatchObject({
      admissible: true,
      verdict: 'Approve with comments',
      groups: { Blockers: [], Warnings: ['first-final', 'second-final'], Suggestions: [], Praise: [] },
    })
    expect(assessmentCodes(validateDecision(implicitMerge, history(mergedRecords), TAXONOMY, null))).toContain(
      'malformed',
    )
  })

  test('refuses omitted, unknown, and multiply-covered source references', () => {
    const source = contribution({ id: 'source-set' })
    const unknown = decision({
      id: 'unknown-reference-decision',
      sourceContributionIds: ['source-set'],
      findings: [
        {
          id: 'unknown-final',
          label: 'issue',
          impactReason: 'The model cited a source never retained.',
          state: 'usable',
          sourceFindingIds: ['missing-original'],
          description: 'No source exists.',
        },
      ],
    })
    const duplicate = decision({
      id: 'duplicate-reference-decision',
      sourceContributionIds: ['source-set'],
      findings: [
        {
          id: 'first-cover',
          label: 'issue',
          impactReason: 'First.',
          state: 'usable',
          sourceFindingIds: ['source-set:f0'],
          description: 'First coverage.',
        },
        {
          id: 'second-cover',
          label: 'issue',
          impactReason: 'Second.',
          state: 'usable',
          sourceFindingIds: ['source-set:f0'],
          description: 'Second coverage.',
        },
      ],
    })

    expect(assessmentCodes(validateDecision(unknown, history([source, unknown]), TAXONOMY, null))).toEqual(
      expect.arrayContaining(['unknown-reference', 'missing-contribution']),
    )
    expect(assessmentCodes(validateDecision(duplicate, history([source, duplicate]), TAXONOMY, null))).toContain(
      'duplicate-reference',
    )
  })
})

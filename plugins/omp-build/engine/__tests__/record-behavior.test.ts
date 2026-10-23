import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import {
  actionResultSchema,
  buildRecord,
  classifyHistory,
  decodeHistory,
  deriveRecallPlan,
  deriveReviewState,
  encodeRecord,
  inspectFinding,
  parseRecord,
  producerJsonSchema,
  projectRecord,
  summarizeReviews,
  validateDecision,
  validateDecisionBindings,
  validateRecordGraph,
  validateReviewDecisionBindings,
} from '../../dist/contracts.js'
import {
  contribution,
  decision,
  encodedAdmissionReviewGraph,
  epicReviewGraph,
  finalReview,
  finding,
  history,
  NATIVE_AUTHOR,
  observedComment,
  operation,
  reviewGraph,
  reviewRoot,
  submission,
  synthesisInventory,
  TEST_HEAD,
  TEST_INPUT,
  TEST_PROJECTION_CONFIG,
  TEST_SCOPE,
} from '../../testing/records.ts'
import type { ObservedComment } from '../schemas.ts'

const TAXONOMY = ['race-condition', 'candidate/isolated-hypothesis']

function refusalCodes(result: { ok: boolean; diagnostics?: { code: string }[] }): string[] {
  if (result.ok) throw new Error('Expected a refusal')
  return result.diagnostics?.map(({ code }) => code) ?? []
}

function assessmentCodes(assessment: { diagnostics: { code: string }[] }): string[] {
  return assessment.diagnostics.map(({ code }) => code)
}

function reviewFacts(head = TEST_HEAD, ci: 'green' | 'red' | 'pending' | 'unknown' = 'green') {
  return {
    ...TEST_SCOPE,
    candidateGitSHA: head,
    input: TEST_INPUT,
    proofAdmission: { ok: true as const, value: null },
    ci,
    acceptedEvidencePolicyRef: null,
  }
}

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

describe('closed review graph', () => {
  test('refuses a decision when required slots are omitted or a slot has competing native results', () => {
    const graph = reviewGraph()
    const omittedSpec = graph.records.filter((record) => record.recordId !== graph.spec.recordId)
    const competingPanel = contribution({ id: 'competing-panel', inventoryId: graph.root.recordId })

    expect(refusalCodes(validateRecordGraph(history(omittedSpec)))).toContain('missing-contribution')
    expect(refusalCodes(validateRecordGraph(history([...graph.records, competingPanel])))).toContain(
      'duplicate-reference',
    )
  })

  test('accepts a complete epic range record but refuses to turn it into a PR landing review', () => {
    const graph = epicReviewGraph()
    const badTail = reviewRoot({
      id: graph.root.recordId,
      subject: {
        kind: 'epic-range',
        range: '0000000000000000000000000000000000000000..2222222222222222222222222222222222222222',
      },
    })
    const malformed = graph.records.map((record) => (record.recordId === badTail.recordId ? badTail : record))

    expect(validateRecordGraph(graph.history)).toMatchObject({ ok: true })
    expect(refusalCodes(validateRecordGraph(history([...graph.records, graph.review])))).toContain('unbound')
    expect(refusalCodes(validateRecordGraph(history(malformed)))).toContain('unbound')
  })

  test('never admits a standalone correction decision as a landing review', () => {
    const graph = reviewGraph({ prefix: 'correction' })
    const correctionDecision = decision({
      id: graph.decision.recordId,
      inputs: graph.decision.inputs,
      originalContributionId: graph.synthesisContribution.recordId,
      sourceContributionIds: [graph.panel.recordId],
      purpose: 'correction',
      findings: graph.decision.payload.judgment.findings,
    })
    const records = graph.records.map((record) =>
      record.recordId === correctionDecision.recordId ? correctionDecision : record,
    )

    expect(refusalCodes(validateRecordGraph(history(records)))).toContain('unknown-reference')
  })

  test('allows the expected author for any record and a configured stop-only actor for a stop', () => {
    const graph = reviewGraph({ prefix: 'stopped', empty: true })
    const durableStop = {
      ...TEST_SCOPE,
      version: 1 as const,
      recordId: 'ci-stop',
      runId: 'run-stop',
      operationId: 'op-stop',
      inputs: [graph.review.recordId],
      kind: 'stop' as const,
      payload: { reason: 'ci-failed' as const, reviewId: graph.review.recordId, detail: { ci: 'red' } },
    }
    const stopPart = observedComment({ author: 'github-actions[bot]' })
    const trustedStop = history([...graph.records, durableStop], {
      source: { ...history(graph.records).source, stopAuthor: 'github-actions[bot]' },
      operations: [...history(graph.records).operations, operation(durableStop, { parts: [stopPart] })],
    })
    const untrustedOrdinary = history(graph.records, {
      source: { ...history(graph.records).source, stopAuthor: 'github-actions[bot]' },
      operations: history(graph.records).operations.map((entry) =>
        entry.recordId === graph.root.recordId ? { ...entry, parts: [stopPart] } : entry,
      ),
    })

    expect(validateRecordGraph(history([...graph.records, durableStop]))).toMatchObject({ ok: true })
    expect(validateRecordGraph(trustedStop)).toMatchObject({ ok: true })
    expect(refusalCodes(validateRecordGraph(untrustedOrdinary))).toContain('unbound')
  })

  test('retains an invalid native submission before its operation stops but refuses its unusable source at decision admission', () => {
    const root = reviewRoot()
    const rawFinding = {
      label: 'issue(blocking)',
      description: 'The native response omitted required location evidence.',
    }
    const invalid = contribution({
      id: 'invalid-child',
      inventoryId: root.recordId,
      findings: [{ id: 'invalid-child:f0', attemptIndex: 0, data: rawFinding }],
      structured: null,
      rawAttempts: [
        submission({
          id: 'child-invalid',
          exitCode: 0,
          structuredOutput: { status: 'invalid', data: { findings: [rawFinding] }, errors: ['missing location'] },
        }),
      ],
      native: {
        completion: 'error',
        strict: 'invalid',
        raw: {
          id: 'child-invalid',
          exitCode: 0,
          structuredOutput: { status: 'invalid', data: { findings: [rawFinding] }, errors: ['missing location'] },
        },
      },
    })
    const decisionFromInvalidSource = decision({
      id: 'invalid-source-decision',
      sourceContributionIds: [invalid.recordId],
      findings: [
        {
          id: 'invalid-source-final',
          label: 'issue(blocking)',
          impactReason: 'The retained source is incomplete.',
          state: 'unusable',
          sourceFindingIds: ['invalid-child:f0'],
        },
      ],
    })
    const retained = history([root, invalid])

    expect(validateRecordGraph(retained)).toMatchObject({ ok: true })
    expect(projectRecord(invalid, retained, null)).toMatchObject({ ok: true })
    expect(
      validateDecision(decisionFromInvalidSource, history([root, invalid, decisionFromInvalidSource]), TAXONOMY, null),
    ).toMatchObject({
      admissible: false,
      verdict: null,
    })
    expect(
      assessmentCodes(
        validateDecision(
          decisionFromInvalidSource,
          history([root, invalid, decisionFromInvalidSource]),
          TAXONOMY,
          null,
        ),
      ),
    ).toContain('unusable-finding')
  })

  test('retains unassigned and competing native results until a closed review requires slot provenance and multiplicity', () => {
    const root = reviewRoot()
    const unassigned = contribution({
      id: 'unassigned-native-child',
      inventoryId: root.recordId,
      phase: null,
      role: null,
      slotId: null,
      chunk: null,
    })
    const competing = contribution({ id: 'competing-native-child', inventoryId: root.recordId })
    const unknownInventory = contribution({ id: 'unknown-inventory-child', inventoryId: 'missing-inventory' })
    const retained = history([root, unassigned, competing])
    const completed = reviewGraph({ prefix: 'slot-closure', empty: true })
    const missingProvenance = {
      ...completed.panel,
      payload: {
        ...completed.panel.payload,
        host: { ...completed.panel.payload.host, phase: null, role: null, slotId: null, chunk: null },
      },
    }
    const duplicateClosedSlot = contribution({ id: 'slot-closure-duplicate', inventoryId: completed.root.recordId })

    expect(validateRecordGraph(retained)).toMatchObject({ ok: true })
    expect(projectRecord(unassigned, retained, null)).toMatchObject({ ok: true })
    expect(projectRecord(competing, retained, null)).toMatchObject({ ok: true })
    expect(refusalCodes(validateRecordGraph(history([unknownInventory])))).toContain('unknown-reference')
    expect(
      refusalCodes(
        validateRecordGraph(
          history(
            completed.records.map((record) =>
              record.recordId === missingProvenance.recordId ? missingProvenance : record,
            ),
          ),
        ),
      ),
    ).toEqual(expect.arrayContaining(['unknown-reference', 'missing-contribution']))
    expect(refusalCodes(validateRecordGraph(history([...completed.records, duplicateClosedSlot])))).toContain(
      'duplicate-reference',
    )
  })
})

describe('recall scheduling', () => {
  test('indexes usable non-candidate findings by observed chunks and callsites only', () => {
    const root = reviewRoot({
      slots: [
        {
          slotId: 'spec-0',
          phase: 'spec',
          role: 'R-spec',
          chunk: null,
          required: true,
          output: 'spec',
          classId: null,
          sourceFindingIds: [],
        },
        {
          slotId: 'panel-0',
          phase: 'panel',
          role: 'R-adversarial',
          chunk: 0,
          required: true,
          output: 'findings',
          classId: null,
          sourceFindingIds: [],
        },
        {
          slotId: 'panel-1',
          phase: 'panel',
          role: 'R-adversarial',
          chunk: 1,
          required: true,
          output: 'findings',
          classId: null,
          sourceFindingIds: [],
        },
      ],
    })
    const recallSpecStructured = { findings: [], specRows: [] }
    const spec = contribution({
      id: 'recall-spec',
      inventoryId: root.recordId,
      phase: 'spec',
      role: 'R-spec',
      slotId: 'spec-0',
      chunk: null,
      findings: [],
      structured: recallSpecStructured,
      rawAttempts: [
        submission({ id: 'child-recall-spec', structuredOutput: { status: 'valid', data: recallSpecStructured } }),
      ],
    })
    const first = contribution({
      id: 'recall-first',
      inventoryId: root.recordId,
      findings: [
        {
          id: 'recall-first:f0',
          attemptIndex: 0,
          data: finding({
            classes: ['race-condition'],
            rawCallsites: [
              { file: 'src/a.ts', line: 10 },
              { file: 'src/b.ts', line: 20 },
            ],
          }),
        },
      ],
    })
    const second = contribution({
      id: 'recall-second',
      inventoryId: root.recordId,
      slotId: 'panel-1',
      chunk: 1,
      findings: [
        {
          id: 'recall-second:f0',
          attemptIndex: 0,
          data: finding({
            classes: ['race-condition', 'candidate/isolated-hypothesis'],
            rawCallsites: [{ file: 'src/c.ts', line: 30 }],
          }),
        },
      ],
    })
    const reviewReady = decision({
      id: 'recall-decision',
      sourceContributionIds: ['recall-spec', 'recall-first', 'recall-second'],
      originalContributionId: 'recall-synthesis-source',
      inputs: ['recall-synthesis-source', 'recall-spec', 'recall-first', 'recall-second'],
      findings: [
        {
          id: 'recall-one',
          label: 'issue',
          impactReason: 'Race.',
          state: 'usable',
          sourceFindingIds: ['recall-first:f0'],
          description: 'Synchronize writes.',
        },
        {
          id: 'recall-two',
          label: 'issue',
          impactReason: 'Race.',
          state: 'usable',
          sourceFindingIds: ['recall-second:f0'],
          description: 'Synchronize reads.',
        },
      ],
    })
    const synthesis = contribution({
      id: 'recall-synthesis-source',
      inventoryId: 'recall-synthesis',
      phase: 'synthesis',
      role: 'R-synthesis',
      slotId: 'synthesis-0',
      chunk: null,
      content: 'decision',
      rawAttempts: [
        submission({
          id: 'child-recall-synthesis-source',
          structuredOutput: { status: 'valid', data: reviewReady.payload.judgment },
        }),
      ],
      structured: reviewReady.payload.judgment,
    })
    const synthesisStage = synthesisInventory({ id: 'recall-synthesis', rootId: root.recordId })
    const records = [root, spec, first, second, synthesisStage, synthesis, reviewReady]

    expect(deriveRecallPlan(history(records), root.recordId, TAXONOMY)).toMatchObject({
      ok: true,
      value: {
        index: [
          {
            classId: 'race-condition',
            chunks: [0, 1],
            callsites: [
              { file: 'src/a.ts', line: 10 },
              { file: 'src/b.ts', line: 20 },
              { file: 'src/c.ts', line: 30 },
            ],
            sourceFindingIds: ['recall-first:f0', 'recall-second:f0'],
          },
        ],
        triggeredClassIds: ['race-condition'],
      },
    })
    expect(
      inspectFinding(
        finding({ classes: ['candidate/isolated-hypothesis'], rawCallsites: [{ file: 'src/d.ts', line: 4 }] }),
        TAXONOMY,
      ),
    ).toMatchObject({ usable: true })
  })
})

describe('review accounting and stops', () => {
  test('does not fall back to an older green review after a newer partial publication', () => {
    const green = reviewGraph({ prefix: 'green', empty: true })
    const partial = operation(green.review, {
      operationId: 'op-newer-partial',
      recordId: 'newer-partial',
      status: 'incomplete',
      record: null,
    })
    const summary = summarizeReviews(
      { ...green.history, operations: [...green.history.operations, partial] },
      TAXONOMY,
      null,
    )

    expect(summary).toMatchObject({ ok: false, knownReviews: 2, countExact: true, spent: false })
    expect(refusalCodes(summary)).toContain('incomplete')
  })

  test('refuses an abandoned newer initial review without replacing it by an older clean approval', () => {
    const older = reviewGraph({ prefix: 'older-clean', empty: true })
    const abandoned = reviewRoot({ id: 'newer-abandoned', head: TEST_HEAD })
    const interrupted = history([...older.records, abandoned])
    const delayedOlderFinal = finalReview({
      id: 'delayed-older-final',
      operationId: 'op-delayed-older-final',
      head: TEST_HEAD,
      inventoryIds: older.review.payload.inventoryIds,
      decisionId: older.decision.recordId,
    })
    const staleFinal = history([...older.records, abandoned, delayedOlderFinal])
    const resumed = reviewGraph({ prefix: 'resumed-clean', empty: true })

    expect(summarizeReviews(interrupted, TAXONOMY, null)).toMatchObject({
      ok: false,
      knownReviews: 1,
      countExact: true,
      spent: false,
    })
    expect(refusalCodes(summarizeReviews(interrupted, TAXONOMY, null))).toContain('incomplete')
    expect(deriveReviewState(interrupted, reviewFacts(), TAXONOMY)).toMatchObject({
      ok: false,
      next: 'stop',
      knownReviews: 1,
      countExact: true,
      spent: false,
    })
    expect(summarizeReviews(staleFinal, TAXONOMY, null)).toMatchObject({
      ok: false,
      knownReviews: 2,
      countExact: true,
      spent: false,
      diagnostics: [
        expect.objectContaining({
          code: 'incomplete',
          detail: { rootId: 'newer-abandoned', pendingRoot: true },
        }),
      ],
    })
    expect(summarizeReviews(history([...older.records, abandoned, ...resumed.records]), TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 2, verdict: 'Approve (clean)', spent: false },
    })
  })

  test('counts an identical publication operation once and rejects a conflicting final operation', () => {
    const green = reviewGraph({ prefix: 'duplicate-green', empty: true })
    const duplicate = operation(green.review, {
      parts: [operation(green.review).parts[0], operation(green.review).parts[0]],
    })
    const deduplicated = summarizeReviews(
      { ...green.history, operations: [...green.history.operations, duplicate] },
      TAXONOMY,
      null,
    )
    const conflict = operation(green.review, {
      operationId: 'op-conflict',
      recordId: 'conflict-review',
      status: 'conflict',
      record: null,
    })
    const conflicted = summarizeReviews(
      {
        ...green.history,
        operations: [...green.history.operations, conflict],
        diagnostics: [{ code: 'conflict', message: 'Two records claim one review operation.' }],
      },
      TAXONOMY,
      null,
    )

    expect(deduplicated).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Approve (clean)', reviewId: 'duplicate-green-final' },
    })
    expect(conflicted).toMatchObject({ ok: false, knownReviews: 2, countExact: true, spent: false })
    expect(refusalCodes(conflicted)).toContain('conflict')
    expect(summarizeReviews(history([]), TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 0, reviewId: null },
    })
  })

  test('keeps a third red review bound across a new head', () => {
    const first = reviewGraph({ prefix: 'first-red', label: 'issue(blocking)' })
    const second = reviewGraph({ prefix: 'second-red', label: 'issue(blocking)' })
    const third = reviewGraph({ prefix: 'third-red', label: 'issue(blocking)' })
    const state = deriveReviewState(
      history([...first.records, ...second.records, ...third.records]),
      reviewFacts('2222222222222222222222222222222222222222'),
      TAXONOMY,
    )

    expect(state).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { reviews: 3, verdict: 'Request changes', spent: true },
      requiredStop: { reason: 'review-bound', reviewId: 'third-red-final' },
    })
  })

  test('requires a sticky CI stop when the third review is green and CI turns red', () => {
    const first = reviewGraph({ prefix: 'first-green', empty: true })
    const second = reviewGraph({ prefix: 'second-green', empty: true })
    const third = reviewGraph({ prefix: 'third-green', empty: true })
    const state = deriveReviewState(
      history([...first.records, ...second.records, ...third.records]),
      reviewFacts(TEST_HEAD, 'red'),
      TAXONOMY,
    )

    expect(state).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { reviews: 3, verdict: 'Approve (clean)', spent: true },
      requiredStop: { reason: 'ci-failed', reviewId: 'third-green-final', detail: { reviews: 3, ci: 'red' } },
    })
  })

  test('creates a CI stop only for the latest approving review on the fresh head', () => {
    const first = reviewGraph({ prefix: 'fresh-first', empty: true, head: TEST_HEAD })
    const second = reviewGraph({ prefix: 'fresh-second', empty: true, head: TEST_HEAD })
    const third = reviewGraph({ prefix: 'fresh-third', empty: true, head: TEST_HEAD })
    const foreignHead = '2222222222222222222222222222222222222222'
    const fourth = reviewGraph({ prefix: 'foreign-fourth', empty: true, head: foreignHead })
    const records = history([...first.records, ...second.records, ...third.records, ...fourth.records])

    expect(deriveReviewState(records, reviewFacts(TEST_HEAD, 'red'), TAXONOMY)).toMatchObject({
      ok: true,
      next: 'review',
      requiredStop: null,
    })
    expect(
      deriveReviewState(
        records,
        { ...reviewFacts(foreignHead, 'red'), input: null, proofAdmission: { ok: false, diagnostics: [] } },
        TAXONOMY,
      ),
    ).toMatchObject({
      ok: true,
      next: 'stop',
      requiredStop: { reason: 'ci-failed', reviewId: 'foreign-fourth-final' },
    })
  })

  test('waits on fresh red CI before a matching third-review stop exists', () => {
    const green = reviewGraph({ prefix: 'fresh-red-ci', empty: true })

    expect(deriveReviewState(green.history, reviewFacts(TEST_HEAD, 'red'), TAXONOMY)).toMatchObject({
      ok: true,
      next: 'wait',
      requiredStop: null,
      summary: { reviews: 1, verdict: 'Approve (clean)', spent: false },
    })
  })
})

describe('immutable admission facts', () => {
  test('refuses a cross-root review, a mismatched input, and a substituted observed review', () => {
    const left = reviewGraph({ prefix: 'left' })
    const right = reviewGraph({ prefix: 'right', empty: true })
    const crossRoot = {
      ...right.review,
      inputs: [...right.synthesis.inputs, right.root.recordId, left.decision.recordId],
      payload: { ...right.review.payload, decisionId: left.decision.recordId },
    }
    const combined = [
      ...left.records,
      ...right.records.map((record) => (record.recordId === right.review.recordId ? crossRoot : record)),
    ]
    const changedInput = deriveReviewState(
      left.history,
      { ...reviewFacts(), input: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
      TAXONOMY,
    )
    const substituted = {
      ...left.review,
      payload: { ...left.review.payload, candidateGitSHA: '2222222222222222222222222222222222222222' },
    }
    const unobservedDecision = {
      ...left.decision,
      payload: { ...left.decision.payload, judgment: { ...left.decision.payload.judgment, findings: [] } },
    }

    expect(refusalCodes(validateRecordGraph(history(combined)))).toContain('unbound')
    expect(changedInput).toMatchObject({ ok: true, next: 'review' })
    expect(
      refusalCodes(projectRecord(substituted, left.history, { taxonomy: TAXONOMY, acceptedPolicy: null })),
    ).toContain('unbound')
    expect(assessmentCodes(validateDecision(unobservedDecision, left.history, TAXONOMY, null))).toContain('unbound')
  })

  test('keeps a persisted CI stop after a later green interpretation', () => {
    const green = reviewGraph({ prefix: 'persisted-green', empty: true })
    const stop = {
      ...TEST_SCOPE,
      version: 1 as const,
      recordId: 'persisted-ci-stop',
      runId: 'run-stop',
      operationId: 'op-persisted-stop',
      inputs: [green.review.recordId],
      kind: 'stop' as const,
      payload: { reason: 'ci-failed' as const, reviewId: green.review.recordId, detail: { ci: 'red' } },
    }
    const state = deriveReviewState(history([...green.records, stop]), reviewFacts(TEST_HEAD, 'green'), TAXONOMY)

    expect(state).toMatchObject({
      ok: true,
      next: 'stop',
      summary: { spent: true },
      requiredStop: { reason: 'ci-failed', reviewId: 'persisted-green-final' },
    })
  })

  test('refuses slot evidence without native child/structured output and raw finding loss', () => {
    const graph = reviewGraph({ prefix: 'evidence' })
    const malformedSlot = {
      ...graph.panel,
      payload: { ...graph.panel.payload, host: { ...graph.panel.payload.host, childId: null }, structured: null },
    }
    const lostAttempt = {
      ...graph.panel,
      payload: {
        ...graph.panel.payload,
        rawAttempts: [
          submission({
            id: 'child-evidence-panel',
            structuredOutput: {
              status: 'valid',
              data: { findings: [finding({ description: 'A raw second report was dropped.' })] },
            },
          }),
        ],
      },
    }

    const malformedRecords = graph.records.map((record) =>
      record.recordId === malformedSlot.recordId ? malformedSlot : record,
    )
    const lostAttemptRecords = graph.records.map((record) =>
      record.recordId === lostAttempt.recordId ? lostAttempt : record,
    )
    expect(refusalCodes(validateRecordGraph(history(malformedRecords))).sort()).toEqual(
      expect.arrayContaining(['malformed', 'unbound']),
    )
    expect(refusalCodes(validateRecordGraph(history(lostAttemptRecords)))).toContain('unusable-finding')
  })
})

describe('history authority classification', () => {
  test('keeps accounted raw proof out of review accounting while foreign sources cannot satisfy authority', () => {
    const graph = reviewGraph({ prefix: 'classified', empty: true })
    const proof = {
      ...TEST_SCOPE,
      version: 1 as const,
      recordId: 'classified-proof',
      runId: 'run-classified',
      operationId: 'op-classified-proof',
      inputs: [],
      kind: 'proof' as const,
      payload: { candidateGitSHA: TEST_HEAD, data: { transport: 'opaque' } },
    }
    const accounted = history([...graph.records, proof], {
      operations: [...graph.history.operations, operation(proof, { authority: 'accounted' })],
    })
    const classification = classifyHistory(accounted)

    expect(classification.authorityHistory.source).toBe(accounted.source)
    expect(classification.classes.find((entry) => entry.operationId === proof.operationId)).toMatchObject({
      authority: 'accounted',
    })
    expect(classification.authorityHistory.operations.some((entry) => entry.recordId === proof.recordId)).toBe(false)
    expect(summarizeReviews(accounted, TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { verdict: 'Approve (clean)', reviews: 1 },
    })

    const foreignPanel = history(graph.records, {
      operations: graph.history.operations.map((entry) =>
        entry.recordId === graph.panel.recordId ? { ...entry, authority: 'foreign' as const } : entry,
      ),
    })
    expect(
      classifyHistory(foreignPanel).authorityHistory.operations.some(
        (entry) => entry.recordId === graph.panel.recordId,
      ),
    ).toBe(false)
    expect(
      validateDecision(graph.decision, classifyHistory(foreignPanel).authorityHistory, TAXONOMY, null),
    ).toMatchObject({ admissible: false })
  })

  test('promotes an accounted dependency of an authority review root but refuses foreign or missing dependencies', () => {
    const graph = reviewGraph({ prefix: 'root-proof', empty: true })
    const proofResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'root-proof-evidence',
        runId: 'root-proof-run',
        operationId: 'op-root-proof-evidence',
        kind: 'proof' as const,
        payload: { candidateGitSHA: TEST_HEAD, data: { origin: 'accounted-context' } },
      } as never,
      [],
    )
    if (!proofResult.ok || proofResult.value.kind !== 'proof') throw new Error('Expected accounted proof')
    const root = { ...graph.root, inputs: [proofResult.value.recordId] }
    const records = [
      proofResult.value,
      ...graph.records.map((record) => (record.recordId === root.recordId ? root : record)),
    ]
    const recorded = history(records)
    const accounted = {
      ...recorded,
      operations: recorded.operations.map((entry) =>
        entry.recordId === proofResult.value.recordId ? { ...entry, authority: 'accounted' as const } : entry,
      ),
    }
    const foreign = {
      ...recorded,
      operations: recorded.operations.map((entry) =>
        entry.recordId === proofResult.value.recordId ? { ...entry, authority: 'foreign' as const } : entry,
      ),
    }
    const missing = history(graph.records.map((record) => (record.recordId === root.recordId ? root : record)))

    expect(summarizeReviews(accounted, TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Approve (clean)' },
    })
    expect(
      classifyHistory(accounted).authorityHistory.operations.some(
        (entry) => entry.recordId === proofResult.value.recordId,
      ),
    ).toBe(true)
    expect(summarizeReviews(foreign, TAXONOMY, null).ok).toBe(false)
    expect(summarizeReviews(missing, TAXONOMY, null).ok).toBe(false)
  })

  test('keeps a complete independent accounted correction graph out of green review accounting', () => {
    const raw: unknown = JSON.parse(
      readFileSync(new URL('./fixtures/native-correction-records.json', import.meta.url), 'utf8'),
    )
    if (!Array.isArray(raw)) throw new Error('Expected correction record array')
    const correction = raw.map((value) => {
      const parsed = parseRecord(value)
      if (!parsed.ok)
        throw new Error(`Invalid correction fixture: ${parsed.diagnostics.map(({ code }) => code).join(', ')}`)
      return parsed.value
    })
    const source = (comments: ObservedComment[]) => ({
      scope: TEST_SCOPE,
      expectedAuthor: NATIVE_AUTHOR,
      stopAuthor: null,
      complete: true,
      comments,
      diagnostics: [],
    })
    const correctionComments: ObservedComment[] = []
    const locatorsByRecordId = new Map<string, Set<string>>()
    for (const record of correction) {
      const encoded = encodeRecord(record, source(correctionComments), null)
      if (!encoded.ok)
        throw new Error(`Cannot encode correction fixture: ${encoded.diagnostics.map(({ code }) => code).join(', ')}`)
      const locators = new Set<string>()
      for (const body of encoded.value) {
        const id = String(correctionComments.length + 100)
        const locator = `correction-${id}`
        locators.add(locator)
        correctionComments.push(observedComment({ locator, nativeId: id, body, createdAt: '2026-10-21T11:00:00Z' }))
      }
      locatorsByRecordId.set(record.recordId, locators)
    }
    const green = encodedAdmissionReviewGraph({ prefix: 'green-with-correction', verdict: 'Approve (clean)' })
    const mixed = decodeHistory(source([...green.comments, ...correctionComments]))
    const request = correction.find((record) => record.kind === 'fix-request')
    if (request?.kind !== 'fix-request') throw new Error('Expected correction fix request')
    const requestLocators = locatorsByRecordId.get(request.recordId)
    if (requestLocators === undefined) throw new Error('Expected request frame locators')
    const requestFreeComments = correctionComments.filter((comment) => !requestLocators.has(comment.locator))
    const withoutRequest = decodeHistory(source([...green.comments, ...requestFreeComments]))
    const conflictingRequest = { ...request, operationId: 'op-conflicting-correction-request' }
    const conflictingFrames = encodeRecord(conflictingRequest, source(requestFreeComments), null)
    if (!conflictingFrames.ok)
      throw new Error(
        `Cannot encode conflicting request: ${conflictingFrames.diagnostics.map(({ code }) => code).join(', ')}`,
      )
    const conflictingComments = conflictingFrames.value.map((body, index) =>
      observedComment({
        locator: `correction-conflict-${index}`,
        nativeId: String(1000 + index),
        body,
        createdAt: '2026-10-21T11:01:00Z',
      }),
    )
    const ambiguous = decodeHistory(source([...green.comments, ...correctionComments, ...conflictingComments]))
    expect(withoutRequest.operations.some((entry) => entry.recordId === request.recordId)).toBe(false)
    expect(ambiguous.operations.filter((entry) => entry.recordId === request.recordId).length).toBe(2)

    expect(summarizeReviews(mixed, TAXONOMY, null)).toMatchObject({
      ok: true,
      value: { reviews: 1, verdict: 'Approve (clean)' },
    })
    expect(summarizeReviews(withoutRequest, TAXONOMY, null).ok).toBe(false)
    expect(summarizeReviews(ambiguous, TAXONOMY, null).ok).toBe(false)
  })

  test('keeps trusted unknown and incomplete final operations authoritative and refusing', () => {
    const graph = reviewGraph({ prefix: 'authority-refusal', empty: true })
    const unknown = operation(graph.review, {
      operationId: 'trusted-unknown',
      recordId: null,
      kind: 'trusted-unknown',
      claimedKinds: ['trusted-unknown'],
      record: null,
      parts: [],
    })
    const unknownHistory = history(graph.records, { operations: [...graph.history.operations, unknown] })
    const incompleteFinal = history(graph.records, {
      operations: graph.history.operations.map((entry) =>
        entry.recordId === graph.review.recordId ? { ...entry, status: 'incomplete' as const } : entry,
      ),
    })

    expect(classifyHistory(unknownHistory).classes[classifyHistory(unknownHistory).classes.length - 1]).toMatchObject({
      operationId: 'trusted-unknown',
      authority: 'authority',
    })
    expect(summarizeReviews(unknownHistory, TAXONOMY, null).ok).toBe(false)
    expect(summarizeReviews(incompleteFinal, TAXONOMY, null).ok).toBe(false)
  })

  test('refuses an operation whose runtime authority stamp is absent', () => {
    const graph = reviewGraph({ prefix: 'missing-authority', empty: true })
    const stamped = history(graph.records)
    const [first, ...remaining] = stamped.operations
    if (first === undefined) throw new Error('Expected an observed operation')
    const { authority: _authority, ...withoutAuthority } = first
    const unstamped = { ...stamped, operations: [withoutAuthority as typeof first, ...remaining] }
    const classified = classifyHistory(unstamped)

    expect(classified.authorityHistory.diagnostics.map(({ code }) => code)).toContain('unclassified')
    expect(summarizeReviews(unstamped, TAXONOMY, null).ok).toBe(false)
  })
})

describe('review projection policy context', () => {
  test('requires host policy context and does not accept candidate policy or taxonomy claims', () => {
    const graph = reviewGraph({ prefix: 'projection-context', empty: true })
    expect(refusalCodes(projectRecord(graph.review, graph.history, null))).toContain('unbound')
    expect(Reflect.apply(projectRecord, undefined, [graph.review, graph.history])).toMatchObject({ ok: false })
    expect(projectRecord(graph.review, graph.history, TEST_PROJECTION_CONFIG)).toMatchObject({ ok: true })

    const evidencePolicy = { version: 'evidence-v1' as const, acceptanceRef: 'candidate-self-acceptance' }
    const evidenceDecision = {
      ...graph.decision,
      payload: { ...graph.decision.payload, judgment: { ...graph.decision.payload.judgment, policy: evidencePolicy } },
    }
    const evidenceRoot = { ...graph.root, payload: { ...graph.root.payload, policy: evidencePolicy } }
    const evidenceSynthesis = { ...graph.synthesis, payload: { ...graph.synthesis.payload, policy: evidencePolicy } }
    const evidenceSource = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        rawAttempts: [
          submission({
            id: 'child-projection-context-decision',
            structuredOutput: { status: 'valid', data: evidenceDecision.payload.judgment },
          }),
        ],
        structured: evidenceDecision.payload.judgment,
      },
    }
    const evidenceRecords = graph.records.map((record) =>
      record.recordId === evidenceRoot.recordId
        ? evidenceRoot
        : record.recordId === evidenceSynthesis.recordId
          ? evidenceSynthesis
          : record.recordId === evidenceDecision.recordId
            ? evidenceDecision
            : record.recordId === evidenceSource.recordId
              ? evidenceSource
              : record,
    )
    expect(refusalCodes(projectRecord(graph.review, history(evidenceRecords), TEST_PROJECTION_CONFIG))).toContain(
      'policy-not-accepted',
    )

    const classified = reviewGraph({ prefix: 'projection-taxonomy' })
    const classifiedFinding = finding({
      classes: ['test-tautology'],
      rawCallsites: [{ file: 'src/widget.ts', line: 41 }],
    })
    const classifiedPanel = {
      ...classified.panel,
      payload: {
        ...classified.panel.payload,
        findings: [{ id: `${classified.panel.recordId}:f0`, attemptIndex: 0, data: classifiedFinding }],
        rawAttempts: [
          submission({
            id: 'child-projection-taxonomy-panel',
            structuredOutput: { status: 'valid', data: { findings: [classifiedFinding] } },
          }),
        ],
        structured: { findings: [classifiedFinding] },
      },
    }
    const classifiedHistory = history(
      classified.records.map((record) => (record.recordId === classifiedPanel.recordId ? classifiedPanel : record)),
    )
    expect(projectRecord(classified.review, classifiedHistory, TEST_PROJECTION_CONFIG)).toMatchObject({ ok: true })
    expect(
      refusalCodes(projectRecord(classified.review, classifiedHistory, { taxonomy: [], acceptedPolicy: null })),
    ).toContain('unknown-reference')
  })
})

describe('action-result proof and guard binding', () => {
  test('carries explicit repository proof paths, preserves failed null inventory, and binds unique guards to proof XOR', () => {
    const guard = {
      guardId: 'guard-one',
      productionGuard: 'region persists selected value',
      paths: ['src/region.ts'],
      intendedScenario: 'stale selected region reaches persistence',
    }
    const applied = {
      outcome: 'applied',
      commitSHAs: [TEST_HEAD],
      commands: [],
      guardInventory: [guard],
      proofPaths: ['src/region.ts'],
      proofToolCallId: 'bash-proof-1',
      proofUnavailableReason: null,
    }
    const proofOnlyApplied = { ...applied, guardInventory: [], proofPaths: [] }
    const failed = {
      outcome: 'failed',
      commitSHAs: [],
      commands: [],
      guardInventory: null,
      proofPaths: ['src/region.ts'],
      proofToolCallId: null,
      proofUnavailableReason: 'apply never reached a proof command',
    }
    const falsified = {
      facts: [
        {
          guardId: 'guard-one',
          removed: true,
          intendedScenario: guard.intendedScenario,
          proofFailed: true,
          proofToolCallId: 'bash-proof-2',
          proofUnavailableReason: null,
        },
      ],
      skippedReason: null,
      commands: [],
    }
    const duplicateGuards = { ...applied, guardInventory: [guard, guard] }
    const invalidAbsoluteProofPath = { ...applied, proofPaths: ['/var/tmp/proof.log'] }
    const invalidDriveRootedProofPath = { ...applied, proofPaths: ['C:\\proof.log'] }
    const invalidDotProofPath = { ...applied, proofPaths: ['./proof.log'] }
    const invalidTraversalProofPath = { ...applied, proofPaths: ['../proof.log'] }
    const invalidBackslashProofPath = { ...applied, proofPaths: ['src\\proof.log'] }
    const invalidFactProof = {
      ...falsified,
      facts: [{ ...falsified.facts[0], proofToolCallId: null, proofUnavailableReason: null }],
    }

    expect(actionResultSchema.safeParse(applied)).toMatchObject({
      success: true,
      data: { proofPaths: ['src/region.ts'], commands: [] },
    })
    expect(actionResultSchema.safeParse(proofOnlyApplied).success).toBe(true)
    expect(actionResultSchema.safeParse(failed)).toMatchObject({
      success: true,
      data: { proofPaths: ['src/region.ts'] },
    })
    expect(actionResultSchema.safeParse(falsified).success).toBe(true)
    expect(actionResultSchema.safeParse(duplicateGuards).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidAbsoluteProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidDriveRootedProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidDotProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidTraversalProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidBackslashProofPath).success).toBe(false)
    expect(actionResultSchema.safeParse(invalidFactProof).success).toBe(false)
    expect(JSON.stringify(producerJsonSchema('action-result'))).toContain('proofPaths')
  })
})

describe('buildRecord', () => {
  test('derives typed review edges then appends distinct explicit context', () => {
    const root = reviewRoot({ id: 'root-edge' })
    const synthesis = synthesisInventory({ id: 'synthesis-edge', rootId: root.recordId })
    const panel = contribution({ id: 'panel-edge', inventoryId: root.recordId })
    const judgment = decision({
      id: 'decision-edge',
      originalContributionId: 'synthesis-output',
      sourceContributionIds: ['spec-edge', panel.recordId],
    })
    const review = finalReview({
      id: 'review-edge',
      decisionId: judgment.recordId,
      inventoryIds: [root.recordId, synthesis.recordId],
    })
    const context = ['explicit-a', 'explicit-a', 'explicit-b']
    const draft = <T extends { inputs: string[] }>(record: T) => {
      const { inputs: _ignored, ...value } = record
      return value
    }

    expect(buildRecord(draft(root) as never, context)).toMatchObject({
      ok: true,
      value: { inputs: ['explicit-a', 'explicit-b'] },
    })
    expect(buildRecord(draft(synthesis) as never, context)).toMatchObject({
      ok: true,
      value: { inputs: [root.recordId, 'explicit-a', 'explicit-b'] },
    })
    expect(buildRecord(draft(panel) as never, context)).toMatchObject({
      ok: true,
      value: { inputs: [root.recordId, 'explicit-a', 'explicit-b'] },
    })
    expect(buildRecord(draft(judgment) as never, context)).toMatchObject({
      ok: true,
      value: { inputs: ['synthesis-output', 'spec-edge', panel.recordId, 'explicit-a', 'explicit-b'] },
    })
    expect(buildRecord(draft(review) as never, context)).toMatchObject({
      ok: true,
      value: { inputs: [judgment.recordId, root.recordId, synthesis.recordId, 'explicit-a', 'explicit-b'] },
    })
  })

  test('accepts semantic model objects despite key order while refusing changed values or array order', () => {
    const graph = reviewGraph({ prefix: 'semantic-json' })
    const rawJudgment = {
      purpose: 'review' as const,
      policy: { version: 'baseline' as const },
      sourceContributionIds: [graph.spec.recordId, graph.panel.recordId],
      findings: [
        {
          id: 'semantic-json-finding-final',
          label: 'issue' as const,
          impactReason: 'The saved region is wrong.',
          state: 'usable' as const,
          description: 'Save the selected region rather than the stale region.',
          sourceFindingIds: [`${graph.panel.recordId}:f0`],
        },
      ],
      causes: [],
      standards: {
        state: 'observed' as const,
        rows: [{ smell: 'State persistence', assessment: 'The save path must preserve the selected region.' }],
      },
    }
    const { inputs: _ignored, ...draft } = graph.decision
    const built = buildRecord({ ...draft, payload: { ...draft.payload, judgment: rawJudgment } } as never, [])
    if (!built.ok || built.value.kind !== 'decision') throw new Error('Expected a built decision')
    const synthesis = {
      ...graph.synthesisContribution,
      payload: {
        ...graph.synthesisContribution.payload,
        rawAttempts: [
          submission({ id: 'child-semantic-json-decision', structuredOutput: { status: 'valid', data: rawJudgment } }),
        ],
        structured: rawJudgment,
      },
    }
    const records = graph.records.map((record) =>
      record.recordId === built.value.recordId
        ? built.value
        : record.recordId === synthesis.recordId
          ? synthesis
          : record,
    )
    const retained = history(records)
    const changedLabel = {
      ...built.value,
      payload: {
        ...built.value.payload,
        judgment: {
          ...built.value.payload.judgment,
          findings: [{ ...built.value.payload.judgment.findings[0], label: 'todo' as const }],
        },
      },
    }
    const reorderedReferences = {
      ...built.value,
      payload: {
        ...built.value.payload,
        judgment: {
          ...built.value.payload.judgment,
          sourceContributionIds: [...built.value.payload.judgment.sourceContributionIds].reverse(),
        },
      },
    }

    expect(validateDecision(built.value, retained, TAXONOMY, null)).toMatchObject({
      admissible: true,
      verdict: 'Request changes',
    })
    expect(projectRecord(built.value, retained, null)).toMatchObject({ ok: true })
    expect(refusalCodes(projectRecord(changedLabel, retained, null))).toContain('unbound')
    expect(refusalCodes(projectRecord(reorderedReferences, retained, null))).toContain('unbound')
  })

  test('projects only the recursive accounted context closure and refuses absent, foreign, or ambiguous antecedents', () => {
    const firstResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'closure-proof-one',
        runId: 'closure-run',
        operationId: 'op-closure-proof-one',
        kind: 'proof' as const,
        payload: { candidateGitSHA: TEST_HEAD, data: { source: 'opaque-one' } },
      } as never,
      [],
    )
    if (!firstResult.ok || firstResult.value.kind !== 'proof') throw new Error('Expected first closure proof')
    const secondResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'closure-proof-two',
        runId: 'closure-run',
        operationId: 'op-closure-proof-two',
        kind: 'proof' as const,
        payload: { candidateGitSHA: TEST_HEAD, data: { source: 'opaque-two' } },
      } as never,
      [firstResult.value.recordId],
    )
    if (!secondResult.ok || secondResult.value.kind !== 'proof') throw new Error('Expected second closure proof')
    const targetResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'closure-event',
        runId: 'closure-run',
        operationId: 'op-closure-event',
        kind: 'epic-event' as const,
        payload: { outcome: 'opaque-context-only' },
      } as never,
      [secondResult.value.recordId],
    )
    if (!targetResult.ok) throw new Error('Expected closure event')

    const antecedents = history([firstResult.value, secondResult.value], {
      operations: [
        operation(firstResult.value, { authority: 'accounted' }),
        operation(secondResult.value, { authority: 'accounted' }),
        operation(firstResult.value, {
          operationId: 'op-unrelated-incomplete',
          recordId: 'unrelated',
          status: 'incomplete',
          record: null,
          parts: [],
          authority: 'accounted',
        }),
      ],
    })
    const foreign = history([firstResult.value, secondResult.value], {
      operations: [
        operation(firstResult.value, { authority: 'foreign' }),
        operation(secondResult.value, { authority: 'accounted' }),
      ],
    })
    const ambiguousRecord = {
      ...firstResult.value,
      payload: { ...firstResult.value.payload, data: { source: 'changed' } },
    }
    const ambiguous = history([firstResult.value, secondResult.value], {
      operations: [
        operation(firstResult.value, { authority: 'accounted' }),
        operation(ambiguousRecord, { authority: 'accounted' }),
        operation(secondResult.value, { authority: 'accounted' }),
      ],
    })
    const missing = history([secondResult.value], {
      operations: [operation(secondResult.value, { authority: 'accounted' })],
    })

    expect(projectRecord(targetResult.value, antecedents, null)).toMatchObject({
      ok: true,
      value: expect.stringContaining('opaque-context-only'),
    })
    expect(refusalCodes(projectRecord(targetResult.value, foreign, null))).toContain('unbound')
    expect(refusalCodes(projectRecord(targetResult.value, ambiguous, null))).toContain('unbound')
    expect(refusalCodes(projectRecord(targetResult.value, missing, null))).toContain('unknown-reference')
  })
})

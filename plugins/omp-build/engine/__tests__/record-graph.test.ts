import { describe, expect, test } from 'vitest'
import { finding, reviewRoot, submission, synthesisInventory, TEST_SCOPE } from '../../testing/record-builders.ts'
import { contribution, decision } from '../../testing/record-decisions.ts'
import { epicReviewGraph, reviewGraph } from '../../testing/record-graphs.ts'
import { history, observedComment, operation } from '../../testing/record-history.ts'
import { validateRecordGraph } from '../history-graph.ts'
import { inspectFinding } from '../producer-schema.ts'
import { projectRecord } from '../record-projection.ts'
import { deriveRecallPlan } from '../review-conservation.ts'
import { validateDecision } from '../review-decision.ts'
import { assessmentCodes, refusalCodes, TAXONOMY } from './record-test-support.ts'

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

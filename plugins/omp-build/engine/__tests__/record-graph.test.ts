import { describe, expect, test } from 'vitest'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { finding, reviewRoot, submission, TEST_SCOPE } from '../../testing/record-builders.ts'
import { contribution, decision } from '../../testing/record-decisions.ts'
import { epicReviewGraph, reviewGraph } from '../../testing/record-graphs.ts'
import { history, observedComment, operation } from '../../testing/record-history.ts'
import { validateRecordGraph } from '../history-graph.ts'
import { inspectFinding } from '../producer-schema.ts'
import { projectRecord } from '../record-projection.ts'
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
          target: null,
          sourceFindingIds: ['invalid-child:f0'],
        },
      ],
    })
    const retained = history([root, invalid])

    expect(validateRecordGraph(retained)).toMatchObject({ ok: true })
    expect(projectRecord(invalid, retained, null)).toMatchObject({ ok: true })
    expect(
      validateDecision(
        decisionFromInvalidSource,
        history([root, invalid, decisionFromInvalidSource]),
        fixtureReviewClassCatalogues(),
        null,
      ),
    ).toMatchObject({
      admissible: false,
      verdict: null,
    })
    expect(
      assessmentCodes(
        validateDecision(
          decisionFromInvalidSource,
          history([root, invalid, decisionFromInvalidSource]),
          fixtureReviewClassCatalogues(),
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
describe('finding inspection', () => {
  test('retains a usable finding with a candidate class', () => {
    expect(
      inspectFinding(
        finding({ classes: ['candidate/isolated-hypothesis'], rawCallsites: [{ file: 'src/d.ts', line: 4 }] }),
        TAXONOMY,
      ),
    ).toMatchObject({ usable: true })
  })
})

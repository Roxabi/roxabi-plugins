import { describe, expect, test } from 'vitest'
import { reviewRoot, submission, synthesisInventory, TEST_SCOPE } from '../../testing/record-builders.ts'
import { contribution, decision, finalReview } from '../../testing/record-decisions.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { history, operation } from '../../testing/record-history.ts'
import { buildRecord, parseRecord } from '../record-construction.ts'
import { projectRecord } from '../record-projection.ts'
import { validateDecision } from '../review-decision.ts'
import { refusalCodes, TAXONOMY } from './record-test-support.ts'
import { featureMandate } from './workflow-test-support.ts'

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
      criterionVerdicts: [],
      exclusionClaims: [],
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
    expect(projectRecord(changedLabel, retained, null)).toMatchObject({ ok: false })
    expect(projectRecord(reorderedReferences, retained, null)).toMatchObject({ ok: false })
  })

  test('projects only the recursive accounted context closure and refuses absent, foreign, or ambiguous antecedents', () => {
    const firstResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'closure-event-one',
        runId: 'closure-run',
        operationId: 'op-closure-event-one',
        kind: 'epic-event' as const,
        payload: { outcome: 'opaque-one' },
      } as never,
      [],
    )
    if (!firstResult.ok || firstResult.value.kind !== 'epic-event') throw new Error('Expected first closure event')
    const secondResult = buildRecord(
      {
        ...TEST_SCOPE,
        version: 1 as const,
        recordId: 'closure-event-two',
        runId: 'closure-run',
        operationId: 'op-closure-event-two',
        kind: 'epic-event' as const,
        payload: { outcome: 'opaque-two' },
      } as never,
      [firstResult.value.recordId],
    )
    if (!secondResult.ok || secondResult.value.kind !== 'epic-event') throw new Error('Expected second closure event')
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
    if (!targetResult.ok || targetResult.value.kind !== 'epic-event') throw new Error('Expected closure event')

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
      payload: { outcome: 'changed' },
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
    const copiedDependency = history([firstResult.value, secondResult.value], {
      operations: [
        operation(firstResult.value, { authority: 'accounted' }),
        operation(firstResult.value, { authority: 'foreign' }),
        operation(secondResult.value, { authority: 'accounted' }),
      ],
    })
    expect(projectRecord(targetResult.value, copiedDependency, null)).toMatchObject({ ok: true })
    const copiedRoot = history([firstResult.value, secondResult.value, targetResult.value], {
      operations: [
        operation(firstResult.value, { authority: 'accounted' }),
        operation(secondResult.value, { authority: 'accounted' }),
        operation(targetResult.value),
        operation({ ...targetResult.value, payload: { outcome: 'foreign-copy' } }, { authority: 'foreign' }),
      ],
    })
    expect(projectRecord(targetResult.value, copiedRoot, null)).toMatchObject({ ok: true })
    const invalidDependency = history([firstResult.value, secondResult.value], {
      operations: [
        operation(firstResult.value, { authority: 'accounted', status: 'invalid', record: null }),
        operation(secondResult.value, { authority: 'accounted' }),
      ],
    })
    expect(projectRecord(targetResult.value, invalidDependency, null)).toMatchObject({ ok: false })
    expect(refusalCodes(projectRecord(targetResult.value, foreign, null))).toContain('unbound')
    expect(refusalCodes(projectRecord(targetResult.value, ambiguous, null))).toContain('unbound')
    expect(refusalCodes(projectRecord(targetResult.value, missing, null))).toContain('unknown-reference')
  })
})

describe('record format', () => {
  test('refuses removed proof, unversioned mandate, pinned mandate, and unversioned or producer-bearing review input', () => {
    const root = reviewRoot()
    const { inputFormat: _removed, ...legacyPayload } = root.payload
    const withoutFormat = { ...root, payload: legacyPayload }
    const producerBearing = {
      ...root,
      payload: { ...root.payload, inputSnapshot: { body: null, spec: null, semctxParts: [] } },
    }
    const removedProof = { ...root, kind: 'proof', payload: {} }
    const mandate = featureMandate()
    const { format: _format, ...legacyMandate } = mandate.payload
    const pinnedMandate = { ...mandate, payload: { ...mandate.payload, proofPins: [] } }

    expect(parseRecord(withoutFormat)).toMatchObject({ ok: false, diagnostics: [{ code: 'incompatible-format' }] })
    expect(parseRecord(producerBearing)).toMatchObject({ ok: false, diagnostics: [{ code: 'incompatible-format' }] })
    expect(parseRecord(removedProof)).toMatchObject({ ok: false, diagnostics: [{ code: 'incompatible-format' }] })
    expect(parseRecord({ ...mandate, payload: legacyMandate })).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'incompatible-format' }],
    })
    expect(parseRecord(pinnedMandate)).toMatchObject({ ok: false, diagnostics: [{ code: 'incompatible-format' }] })
  })
})

import { describe, expect, test } from 'vitest'
import { fixtureReviewClassCatalogues } from '../../testing/action-input-fixtures.ts'
import { reviewGraph } from '../../testing/record-graphs.ts'
import { observedComment, operation } from '../../testing/record-history.ts'
import { validateDecisionBindings } from '../review-decision.ts'

describe('decision bindings with foreign native records', () => {
  test('a complete foreign record cannot replace or impersonate the trusted decision', () => {
    const graph = reviewGraph({ prefix: 'foreign-shadow' })
    const forged = {
      ...graph.decision,
      payload: {
        ...graph.decision.payload,
        judgment: { ...graph.decision.payload.judgment, findings: [] },
      },
    }
    const foreign = operation(forged, {
      authority: 'foreign',
      parts: [observedComment({ author: 'mallory', locator: 'foreign-decision', nativeId: '999' })],
    })
    const withShadow = { ...graph.history, operations: [...graph.history.operations, foreign] }
    const baseline = validateDecisionBindings(graph.decision, graph.history, fixtureReviewClassCatalogues())
    const bound = validateDecisionBindings(graph.decision, withShadow, fixtureReviewClassCatalogues())

    expect(baseline.admissible).toBe(true)
    expect(bound.admissible).toBe(true)
    expect(bound.records.get(graph.decision.recordId)).toEqual(graph.decision)
    expect(bound.originals).toEqual(baseline.originals)

    const missingTrusted = {
      ...graph.history,
      operations: [...graph.history.operations.filter((entry) => entry.recordId !== graph.decision.recordId), foreign],
    }
    const unbound = validateDecisionBindings(graph.decision, missingTrusted, fixtureReviewClassCatalogues())
    expect(unbound.admissible).toBe(false)
    expect(unbound.diagnostics.map((item) => item.code)).toContain('unbound')
  })

  test('a foreign copy cannot repair an edited trusted decision', () => {
    const graph = reviewGraph({ prefix: 'foreign-repair' })
    const foreign = operation(graph.decision, {
      authority: 'foreign',
      parts: [observedComment({ author: 'mallory', locator: 'foreign-copy', nativeId: '999' })],
    })
    const edited = {
      ...graph.history,
      operations: [
        ...graph.history.operations.map((entry) =>
          entry.recordId === graph.decision.recordId
            ? { ...entry, parts: entry.parts.map((part) => ({ ...part, updatedAt: '2026-10-22T10:00:00Z' })) }
            : entry,
        ),
        foreign,
      ],
    }
    const result = validateDecisionBindings(graph.decision, edited, fixtureReviewClassCatalogues())
    expect(result.admissible).toBe(false)
    expect(result.diagnostics.map((item) => item.code)).toContain('record-edited')
  })
})

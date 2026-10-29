import { describe, expect, test } from 'vitest'
import {
  BODY,
  binding,
  featureMandate,
  SCOPE as WORKFLOW_SCOPE,
  history as workflowHistory,
} from '../engine/__tests__/workflow-test-support.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { proveHistoricalReviewAssociation } from '../engine/review-recovery.ts'
import { reviewRoot, TEST_INPUT_SNAPSHOT } from '../testing/record-builders.ts'
import { boundSemanticFromHistoricalAssociation, reconstructHistoricalReviewInput } from './review-recovery-input.ts'

describe('review recovery input reconstruction', () => {
  test('round-trips I4 from historical association, config identity, and root snapshot', () => {
    const mandated = featureMandate()
    const historicalBinding = binding(mandated)
    const association = proveHistoricalReviewAssociation({
      root: {
        ...reviewRoot({ id: 'input-interrupted-root' }),
        repository: WORKFLOW_SCOPE.repository,
        target: WORKFLOW_SCOPE.target,
      },
      bindings: [historicalBinding as Extract<CanonicalRecord, { kind: 'workflow-binding' }>],
      mandates: [mandated],
      histories: [workflowHistory([mandated, historicalBinding])],
    })
    expect(association).toMatchObject({ ok: true })
    if (!association.ok) return

    const semantic = boundSemanticFromHistoricalAssociation(association.value)
    expect(semantic).toMatchObject({ mode: 'bound' })
    if ('ok' in semantic) return

    const root = {
      ...reviewRoot({
        id: 'input-interrupted-root',
        input: '0'.repeat(64),
        inputSnapshot: TEST_INPUT_SNAPSHOT,
        head: '1111111111111111111111111111111111111111',
      }),
      repository: WORKFLOW_SCOPE.repository,
      target: WORKFLOW_SCOPE.target,
    }
    expect(reconstructHistoricalReviewInput({ root, semantic })).toBeNull()
    expect(association.value.accepted.snapshot.raw.body).toBe(BODY)
  })
})

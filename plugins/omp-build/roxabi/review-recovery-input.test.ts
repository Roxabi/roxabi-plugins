import { describe, expect, test } from 'vitest'
import {
  BODY,
  binding,
  featureMandate,
  SCOPE as WORKFLOW_SCOPE,
  history as workflowHistory,
} from '../engine/__tests__/workflow-test-support.ts'
import type { CanonicalRecord } from '../engine/record-schema.ts'
import { confirmHistoricalReviewInputMatch, proveHistoricalReviewAssociation } from '../engine/review-recovery.ts'
import { hashReviewInput } from '../skills/feature/review-input.ts'
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

    const body = TEST_INPUT_SNAPSHOT.body
    expect(body).not.toBeNull()
    if (body === null) return
    const digest = hashReviewInput(
      WORKFLOW_SCOPE.repository,
      { pr: 42, candidate: '1111111111111111111111111111111111111111' },
      body,
      semantic,
    )
    const root = {
      ...reviewRoot({
        id: 'input-interrupted-root',
        input: digest,
        inputSnapshot: TEST_INPUT_SNAPSHOT,
        head: '1111111111111111111111111111111111111111',
      }),
      repository: WORKFLOW_SCOPE.repository,
      target: WORKFLOW_SCOPE.target,
    }
    const reconstructed = reconstructHistoricalReviewInput({ root, semantic })
    expect(reconstructed).toBe(digest)
    expect(confirmHistoricalReviewInputMatch(root, reconstructed ?? '')).toMatchObject({ ok: true })
    expect(association.value.accepted.body).toBe(BODY)
  })
})

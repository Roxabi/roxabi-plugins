import { describe, expect, it } from 'vitest'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { matchesContextNegative, matchesPlanReviewNegative } from './feature-context-negative.ts'

const inputs = {
  format: 'omp-build-action-input-binding/1',
  fingerprint: 'sealed',
  manifest: { purpose: 'plan' },
  stageSources: [],
} as unknown as ActionInputs
const child = {
  contextBlock: { action: { actionId: 'old-action', inputs }, missing: [] },
} as unknown as NativeChildResult

describe('context negative binding', () => {
  it('accepts only the original action and sealed inputs', () => {
    expect(matchesContextNegative(child, 'old-action', structuredClone(inputs))).toBe(true)
    expect(matchesContextNegative(child, 'new-action', inputs)).toBe(false)
    expect(matchesContextNegative(child, 'old-action', { ...inputs, fingerprint: 'other' })).toBe(false)
    expect(matchesContextNegative({} as NativeChildResult, 'old-action', inputs)).toBe(false)
  })
  it('authenticates plan-review negatives against their declared slot, not the batch identity', () => {
    const reviewChild = { ...child, expectedId: 'architect' }
    const slot = {
      slotId: 'architect',
      specialist: 'R-workflow-plan-architect' as const,
      action: { actionId: 'old-action', inputs },
    }
    expect(matchesPlanReviewNegative(reviewChild, [slot])).toBe(true)
    expect(matchesPlanReviewNegative(reviewChild, [{ ...slot, action: { ...slot.action, actionId: 'other' } }])).toBe(
      false,
    )
    expect(matchesPlanReviewNegative({ ...reviewChild, expectedId: 'adversarial' }, [slot])).toBe(false)
  })
})

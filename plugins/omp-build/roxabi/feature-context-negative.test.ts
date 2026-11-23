import { describe, expect, it } from 'vitest'
import type { ActionInputs } from '../engine/action-input-schema.ts'
import type { NativeChildResult } from '../omp/review-runtime/contracts.ts'
import { matchesContextNegative } from './feature-context-negative.ts'

const inputs = {
  format: 'omp-build-action-input-binding/1',
  fingerprint: 'sealed',
  manifest: { purpose: 'assess-spec' },
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
})

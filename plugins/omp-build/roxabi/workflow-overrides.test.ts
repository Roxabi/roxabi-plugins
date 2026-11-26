import { describe, expect, it } from 'vitest'
import { parseWorkflowOverride } from './workflow-overrides.ts'

describe('parseWorkflowOverride', () => {
  it('accepts a valid review alongside a collection key elsewhere', () => {
    const text = 'extra: { [a, b]: value }\nreview: { additional_requirements: [Review the evidence] }'
    expect(parseWorkflowOverride(text)).toEqual({ ok: true, additionalRequirements: ['Review the evidence'] })
  })

  it.each(['', ' # nothing to configure\n'])('treats YAML without a document as unsupported (%j)', (text) => {
    expect(parseWorkflowOverride(text)).toMatchObject({ ok: false, reason: 'unsupported' })
  })

  it('rejects signed hex as a requirement because it is a number', () => {
    expect(parseWorkflowOverride('review: { additional_requirements: [+0x10] }')).toMatchObject({
      ok: false,
      reason: 'unsupported',
    })
  })
})

import { expect, it } from 'vitest'
import { reviewRoot } from '../../testing/record-builders.ts'
import { parseRecord } from '../record-construction.ts'

it('continues to read an ordinary legacy correction slot', () => {
  const root = reviewRoot({ id: 'correction-inventory' })
  const correction = { phase: 'apply', causeId: 'RC-1', context: { attempt: 1 } }
  const parsed = parseRecord({
    ...root,
    inputs: ['request'],
    payload: {
      rootAttemptId: root.recordId,
      candidateGitSHA: root.payload.candidateGitSHA,
      inputFormat: root.payload.inputFormat,
      input: root.payload.input,
      actionInputDigest: root.payload.actionInputDigest,
      slots: [
        {
          slotId: 'correction-0',
          phase: 'fix',
          role: 'implementer',
          chunk: null,
          required: true,
          output: 'action-result',
          classId: null,
          sourceFindingIds: [],
          correction,
        },
      ],
      stage: 'initial',
      purpose: 'correction',
      requestId: 'request',
      policy: root.payload.policy,
    },
  })
  expect(parsed.ok, JSON.stringify(parsed)).toBe(true)
  if (!parsed.ok || parsed.value.kind !== 'review-attempt') throw new Error('Expected a correction inventory')
  expect(parsed.value.payload.slots[0]?.correction).toEqual(correction)
})

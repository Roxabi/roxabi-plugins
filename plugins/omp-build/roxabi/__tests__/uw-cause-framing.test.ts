import { expect, it } from 'vitest'
import type { CauseSisterInput } from '../../engine/cause-disposition-schema.ts'
import type { CanonicalRecord } from '../../engine/record-schema.ts'
import { frameSister } from '../uw-cause-operations.ts'

const original = { repository: 'acme/app', target: 'acme/app#2' }
const parent = { repository: 'acme/app', target: 'acme/app#1' }
const input: CauseSisterInput = {
  disposition: { scope: original, recordId: 'disposition', kind: 'cause-disposition' },
  factors: { files: 1, risk: 1, architecture: 1, unknowns: 1, domains: 1 },
  tierOverride: null,
  labels: { add: [], remove: [] },
}
function record(disposition: 'sister-after' | 'sister-blocking') {
  return {
    repository: original.repository,
    target: original.target,
    recordId: 'disposition',
    payload: {
      origin: { uw: original },
      subject: {
        kind: 'cause',
        decision: { recordId: 'decision' },
        cause: {
          id: 'cause',
          title: 'Repair',
          mechanism: 'Mechanism',
          failure: 'Failure',
          fix: 'Fix',
          paths: ['src/a'],
          restored: 'Restored',
          proof: 'Proof',
        },
      },
      outcome: { state: 'final', disposition, blocking: disposition === 'sister-blocking', reason: 'Evidence' },
    },
  } as unknown as Extract<CanonicalRecord, { kind: 'cause-disposition' }>
}

it('frames sister-after with a fresh criterion and an original blocker under the same parent', () => {
  const plan = frameSister(record('sister-after'), input, parent)
  expect(plan.writes.relations).toMatchObject({
    parent: { repository: 'acme/app', number: 1 },
    addBlockers: [{ repository: 'acme/app', number: 2 }],
  })
  expect(plan.draft.criteria).toEqual([{ kind: 'new', draftKey: 'restored', statement: 'Restored\n\nProof: Proof' }])
  expect(plan.draft.sections.origin).toContain('disposition')
})

it('does not reverse the dependency for a blocking sister', () => {
  expect(frameSister(record('sister-blocking'), input, parent).writes.relations.addBlockers).toEqual([])
})

it('refuses a disposition reference that does not name the supplied source', () => {
  expect(() =>
    frameSister(record('sister-after'), { ...input, disposition: { ...input.disposition, recordId: 'other' } }, parent),
  ).toThrow('cause-disposition-mismatch')
})

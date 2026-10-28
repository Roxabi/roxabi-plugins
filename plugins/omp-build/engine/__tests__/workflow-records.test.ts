import { describe, expect, test } from 'vitest'
import { parseRecord } from '../record-construction.ts'
import { scopedRefsOf } from '../workflow-record-references.ts'
import { mandate, PARENT } from './workflow-test-support.ts'

describe('workflow records', () => {
  test('derives same-scope inputs and keeps external references out of inputs', () => {
    const parent = mandate({ recordId: 'parent-mandate', scope: PARENT })
    const child = mandate({ parent })
    const identity = child.payload.ownSpec.identityAllocations[0]
    if (identity === undefined) throw new Error('fixture has no own Spec identity allocation')
    expect(child.inputs).toEqual([identity.recordId])
    expect(scopedRefsOf(child)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ recordId: parent.recordId, kind: 'mandate' }),
        expect.objectContaining({ recordId: identity.recordId, kind: 'spec-identity' }),
      ]),
    )
    expect(parseRecord({ ...child, inputs: [parent.recordId] }).ok).toBe(false)
  })
})

import { describe, expect, test } from 'vitest'
import { parseRecord } from '../record-construction.ts'
import { scopedRefsOf } from '../workflow-record-references.ts'
import { mandate, must, PARENT } from './workflow-test-support.ts'

describe('workflow records', () => {
  test('derives same-scope inputs and keeps external references out of inputs', () => {
    const parent = must(
      parseRecord({
        ...mandate({ recordId: 'parent-mandate' }),
        repository: PARENT.repository,
        target: PARENT.target,
        operationId: 'op-parent',
      }),
    )
    const child = mandate({ parent })
    expect(child.inputs).not.toContain(parent.recordId)
    expect(scopedRefsOf(child)).toEqual([expect.objectContaining({ recordId: parent.recordId, kind: 'mandate' })])
    expect(parseRecord({ ...child, inputs: [parent.recordId] }).ok).toBe(false)
  })
})

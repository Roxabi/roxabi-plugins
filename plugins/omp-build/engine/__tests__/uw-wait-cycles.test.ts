import { describe, expect, it } from 'vitest'
import type { WaitRequirement } from '../uw-completion-types.ts'
import { waitCycleDiagnostics } from '../uw-wait-cycles.ts'

const a = { repository: 'acme/one', target: 'acme/one#1' }
const b = { repository: 'acme/one', target: 'acme/one#2' }
const c = { repository: 'acme/two', target: 'acme/two#1' }
const disposition = { scope: a, kind: 'cause-disposition' as const, recordId: 'cause' }
const receipt = { scope: a, kind: 'debt-receipt' as const, recordId: 'receipt' }

describe('combined wait cycle checking', () => {
  it('reports a cycle through causal, native blocker and native child edges', () => {
    const edges: WaitRequirement[] = [
      { from: a, to: b, source: { kind: 'blocking-sister', disposition, receipt, control: null } },
      { from: b, to: c, source: { kind: 'native-blocker' } },
      { from: c, to: a, source: { kind: 'native-child' } },
    ]
    const result = waitCycleDiagnostics(edges)
    expect(result).toHaveLength(1)
    expect(result[0]?.message).toContain('blocking-sister')
    expect(result[0]?.message).toContain('native-blocker')
    expect(result[0]?.message).toContain('native-child')
  })

  it('does not confuse equal issue numbers from different repositories', () => {
    const edges: WaitRequirement[] = [
      { from: a, to: c, source: { kind: 'native-blocker' } },
      { from: c, to: b, source: { kind: 'native-child' } },
    ]
    expect(waitCycleDiagnostics(edges)).toEqual([])
  })

  it('keeps a separate native floor after removing a causal edge', () => {
    const edges: WaitRequirement[] = [
      { from: a, to: b, source: { kind: 'native-blocker' } },
      { from: b, to: a, source: { kind: 'native-blocker' } },
    ]
    expect(waitCycleDiagnostics(edges)).toHaveLength(1)
  })
})

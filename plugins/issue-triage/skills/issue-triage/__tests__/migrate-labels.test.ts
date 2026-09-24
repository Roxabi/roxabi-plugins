import { describe, expect, it } from 'vitest'
import { secondPassIsNoop } from '../lib/init'
import { applyRelabels, migrateLabel, missingCanonical, planRelabels, proseBlockedBy } from '../lib/migrate-labels'

describe('migrateLabel', () => {
  const cases: [string, { add: string | null; remove: boolean }][] = [
    ['size: XS', { add: 'size:S', remove: true }],
    ['size:XS', { add: 'size:S', remove: true }],
    ['size: xs', { add: 'size:S', remove: true }],
    ['Size: S', { add: 'size:S', remove: true }],
    ['size:S', { add: null, remove: false }],
    ['size: M', { add: 'size:F-lite', remove: true }],
    ['size:M', { add: 'size:F-lite', remove: true }],
    ['size:  L', { add: 'size:F-full', remove: true }],
    ['size: XL', { add: 'size:F-full', remove: true }],
    ['size:xl', { add: 'size:F-full', remove: true }],
    ['size:F-lite', { add: null, remove: false }],
    ['size: custom', { add: null, remove: false }],
    ['priority: urgent', { add: 'P0-critical', remove: true }],
    ['priority:critical', { add: 'P0-critical', remove: true }],
    ['Priority: High', { add: 'P1-high', remove: true }],
    ['priority: medium', { add: 'P2-medium', remove: true }],
    ['priority:low', { add: 'P3-low', remove: true }],
    ['priority: P2', { add: null, remove: false }],
    ['ready-for-agent', { add: null, remove: true }],
    ['Ready-for-agent', { add: null, remove: true }],
    ['bug', { add: null, remove: false }],
  ]

  for (const [input, expected] of cases) {
    it(`maps ${JSON.stringify(input)}`, () => {
      expect(migrateLabel(input)).toEqual(expected)
    })
  }
})

describe('planRelabels', () => {
  it('leaves an already-canonical issue untouched', () => {
    expect(planRelabels([{ number: 1, labels: ['size:S', 'P1-high', 'bug'] }])).toEqual([])
  })

  it('is a no-op on the labels a first pass would write', () => {
    const before = [
      { number: 7, labels: ['size: M', 'priority: high', 'ready-for-agent', 'bug'], body: 'Blocked by: #3' },
    ]
    const first = planRelabels(before)
    expect(first).toEqual([
      { number: 7, add: ['size:F-lite', 'P1-high'], remove: ['size: M', 'priority: high', 'ready-for-agent'] },
    ])
    const after = applyRelabels(before, first)
    expect(planRelabels(after)).toEqual([])
    expect(after[0].body).toBe('Blocked by: #3')
    expect(proseBlockedBy(before)).toEqual([7])
    expect(missingCanonical(['size:S', 'bug'])).toContain('size:F-lite')
    expect(
      missingCanonical([
        'size:S',
        'size:F-lite',
        'size:F-full',
        'P0-critical',
        'P1-high',
        'P2-medium',
        'P3-low',
        'reviewed',
        'epic',
      ]),
    ).toEqual([])
    expect(
      secondPassIsNoop(before, ['bug'], first, [
        'size:S',
        'size:F-lite',
        'size:F-full',
        'P0-critical',
        'P1-high',
        'P2-medium',
        'P3-low',
        'reviewed',
        'epic',
      ]),
    ).toBe(true)
  })
})

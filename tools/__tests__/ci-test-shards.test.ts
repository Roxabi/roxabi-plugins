import { describe, expect, it } from 'vitest'
import { partition, verifyCoverage } from '../ci-test-shards'

describe('integration shard planning', () => {
  it('assigns every file once deterministically using median for unknown files', () => {
    const files = ['d', 'a', 'c', 'b', 'e']
    const times = { a: 10, b: 6, c: 2 }
    const shards = partition(files, times, 2)
    expect(shards).toEqual([
      ['a', 'e'],
      ['b', 'd', 'c'],
    ])
    expect(partition([...files].reverse(), times, 2)).toEqual(shards)
    expect(shards.flat().sort()).toEqual([...files].sort())
    expect(partition(['c', 'a', 'b'], {}, 2)).toEqual([['a', 'c'], ['b']])
  })
})

describe('coverage verification', () => {
  const plan = {
    expected: [
      { project: 'unit' as const, file: 'unit.ts' },
      { project: 'integration' as const, file: 'one.ts' },
      { project: 'integration' as const, file: 'two.ts' },
    ],
    shards: [['one.ts'], ['two.ts']],
  }
  const result = (name: string, status = 'passed') => ({ name, status, startTime: 1000, endTime: 3500 })
  const report = (...testResults: { name: string; status: string; startTime: number; endTime: number }[]) => ({
    success: true,
    testResults,
  })
  const reports = () => [
    report(result('/repo/unit.ts')),
    report(result('/repo/one.ts')),
    report(result('/repo/two.ts')),
  ]

  it('accepts exact coverage and extracts seconds', () => {
    expect(verifyCoverage(plan, reports(), '/repo')).toEqual({ 'one.ts': 2.5, 'two.ts': 2.5 })
  })

  it('rejects missing reports and missing files', () => {
    expect(() => verifyCoverage(plan, [reports()[0], undefined, reports()[2]], '/repo')).toThrow('Missing report')
    expect(() => verifyCoverage(plan, [reports()[0], report(), reports()[2]], '/repo')).toThrow('Missing files')
  })

  it('rejects duplicate, unknown, misplaced and failed files', () => {
    const [unit, one, two] = reports()
    expect(() => verifyCoverage(plan, [unit, report(result('one.ts'), result('one.ts')), two], '/repo')).toThrow(
      'Duplicate',
    )
    expect(() => verifyCoverage(plan, [unit, report(result('unknown.ts')), two], '/repo')).toThrow('Unknown')
    expect(() => verifyCoverage(plan, [unit, two, one], '/repo')).toThrow('misplaced')
    expect(() => verifyCoverage(plan, [unit, report(result('one.ts', 'failed')), two], '/repo')).toThrow('Failed file')
    expect(() => verifyCoverage(plan, [unit, { ...one, success: false }, two], '/repo')).toThrow('Failed')
  })
})

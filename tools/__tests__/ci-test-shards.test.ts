import { describe, expect, it } from 'vitest'
import { literalIncludes, parseTimings, partition, verifyCoverage } from '../ci-test-shards'

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

  it('rejects unsafe glob syntax in test paths', () => {
    for (const char of ['|', '*', '{', ' ']) {
      expect(() => literalIncludes(JSON.stringify([`test${char}.integration.test.ts`]))).toThrow('Unsafe')
    }
    expect(literalIncludes('["plugins/a-b.test.ts"]')).toEqual(['plugins/a-b.test.ts'])
  })

  it('ignores malformed timing caches and invalid entries', () => {
    for (const json of ['{', 'null', '[]', '123']) {
      expect(parseTimings(json)).toEqual({ timings: {}, warning: true })
    }
    expect(parseTimings('{"ok":2,"zero":0,"negative":-1,"infinite":1e999,"text":"4"}')).toEqual({
      timings: { ok: 2 },
      warning: true,
    })
    expect(parseTimings('{"ok":2}')).toEqual({ timings: { ok: 2 }, warning: false })
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
  const result = (file: string, project: 'unit' | 'integration' = 'integration', state = 'passed') => ({
    file,
    project,
    state,
    passed: 1,
    failed: 0,
    skipped: 0,
    pending: 0,
    duration: 2500,
  })
  const report = (...modules: ReturnType<typeof result>[]) => ({ success: true, modules })
  const reports = () => [
    report(result('/repo/unit.ts', 'unit')),
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
    expect(() => verifyCoverage(plan, [unit, report(result('one.ts', 'integration', 'failed')), two], '/repo')).toThrow(
      'Failed file',
    )
    expect(() => verifyCoverage(plan, [unit, { ...one, success: false }, two], '/repo')).toThrow('Failed')
  })

  it('rejects an entirely skipped file but accepts a partially skipped file', () => {
    const [unit, one, two] = reports()
    const module = one.modules[0]
    expect(() => verifyCoverage(plan, [unit, report({ ...module, passed: 0, skipped: 2 }), two], '/repo')).toThrow(
      'no passing tests',
    )
    expect(verifyCoverage(plan, [unit, report({ ...module, passed: 1, skipped: 1 }), two], '/repo')).toEqual({
      'one.ts': 2.5,
      'two.ts': 2.5,
    })
  })
})

import { describe, expect, it, vi } from 'vitest'
import {
  classifyDensity,
  computeHotfixDensity,
  type Deps,
  fetchHotfixPrShas,
  formatResult,
  type HotfixDensityResult,
  isHotfix,
  listCommitsSince,
  resolveAnchor,
  THRESHOLD_GREEN,
  THRESHOLD_PAUSE,
  THRESHOLD_WARN,
} from '../lib/hotfix-density'

// ─── Threshold constants ───────────────────────────────────────────────────────

describe('threshold constants', () => {
  it('exports correct green threshold', () => {
    expect(THRESHOLD_GREEN).toBe(0.2)
  })

  it('exports correct warn threshold', () => {
    expect(THRESHOLD_WARN).toBe(0.4)
  })

  it('exports correct pause threshold equal to warn', () => {
    expect(THRESHOLD_PAUSE).toBe(THRESHOLD_WARN)
  })
})

// ─── classifyDensity ──────────────────────────────────────────────────────────

describe('classifyDensity', () => {
  it('returns green for 0', () => {
    expect(classifyDensity(0)).toBe('green')
  })

  it('returns green for density just below THRESHOLD_GREEN', () => {
    expect(classifyDensity(0.19)).toBe('green')
  })

  it('returns warn at exactly THRESHOLD_GREEN (boundary)', () => {
    expect(classifyDensity(0.2)).toBe('warn')
  })

  it('returns warn for mid-range density', () => {
    expect(classifyDensity(0.3)).toBe('warn')
  })

  it('returns warn for density just below THRESHOLD_WARN', () => {
    expect(classifyDensity(0.39)).toBe('warn')
  })

  it('returns pause at exactly THRESHOLD_WARN (boundary)', () => {
    expect(classifyDensity(0.4)).toBe('pause')
  })

  it('returns pause for density above THRESHOLD_WARN', () => {
    expect(classifyDensity(0.6)).toBe('pause')
  })

  it('returns pause for density = 1.0', () => {
    expect(classifyDensity(1.0)).toBe('pause')
  })
})

// ─── isHotfix ─────────────────────────────────────────────────────────────────

describe('isHotfix', () => {
  it('returns true for fix: prefix (lowercase)', () => {
    expect(isHotfix('abc', 'fix: correct null check', new Set())).toBe(true)
  })

  it('returns true for Fix: prefix (case-insensitive)', () => {
    expect(isHotfix('abc', 'Fix: something', new Set())).toBe(true)
  })

  it('returns true for FIX: prefix (uppercase)', () => {
    expect(isHotfix('abc', 'FIX: uppercase', new Set())).toBe(true)
  })

  it('returns false for feat: prefix', () => {
    expect(isHotfix('abc', 'feat: add feature', new Set())).toBe(false)
  })

  it('returns false for chore: prefix', () => {
    expect(isHotfix('abc', 'chore: update deps', new Set())).toBe(false)
  })

  it('returns false for title containing fix but not at start', () => {
    expect(isHotfix('abc', 'feat: prefix fix in middle', new Set())).toBe(false)
  })

  it('returns true if sha is in hotfixPrShas set', () => {
    const shas = new Set(['sha123'])
    expect(isHotfix('sha123', 'feat: any title', shas)).toBe(true)
  })

  it('returns false if sha not in hotfixPrShas and title is not fix:', () => {
    const shas = new Set(['other-sha'])
    expect(isHotfix('sha999', 'docs: update readme', shas)).toBe(false)
  })

  it('returns true for union: both fix: and in set', () => {
    const shas = new Set(['sha123'])
    expect(isHotfix('sha123', 'fix: also in set', shas)).toBe(true)
  })
})

// ─── resolveAnchor ────────────────────────────────────────────────────────────

function makeRunDeps(responses: Record<string, string | Error>): Pick<Deps, 'run'> {
  return {
    run: vi.fn(async (cmd: string[]) => {
      const key = cmd.join(' ')
      // Find the first key that the joined command contains
      for (const [pattern, response] of Object.entries(responses)) {
        if (key.includes(pattern)) {
          if (response instanceof Error) throw response
          return response
        }
      }
      throw new Error(`Unexpected command: ${key}`)
    }),
  }
}

describe('resolveAnchor', () => {
  it('returns tag source when a version tag is present', async () => {
    const deps = makeRunDeps({
      'git tag --list': 'dev-core/v1.2.3 2026-05-01T10:00:00+02:00\n',
    })
    const result = await resolveAnchor(undefined, deps)
    expect(result.anchorSource).toBe('tag')
    expect(result.anchorDate).toContain('2026-05-01')
    expect(result.anchorWarn).toBeUndefined()
  })

  it('returns tag source for bare vX.Y.Z tag', async () => {
    const deps = makeRunDeps({
      'git tag --list': 'v0.5.0 2026-04-10T08:00:00+02:00\n',
    })
    const result = await resolveAnchor(undefined, deps)
    expect(result.anchorSource).toBe('tag')
  })

  it('returns first matching tag when multiple tags present', async () => {
    const deps = makeRunDeps({
      'git tag --list': 'dev-core/v2.0.0 2026-06-01T10:00:00+02:00\ndev-core/v1.9.0 2026-05-01T10:00:00+02:00\n',
    })
    const result = await resolveAnchor(undefined, deps)
    expect(result.anchorSource).toBe('tag')
    expect(result.anchorDate).toContain('2026-06-01')
  })

  it('falls through to promotion-merge when no tags found', async () => {
    const deps = makeRunDeps({
      'git tag --list': '',
      'git log': 'abc1234 2026-05-10 12:00:00 +0200',
    })
    const result = await resolveAnchor(undefined, deps)
    expect(result.anchorSource).toBe('promotion-merge')
    expect(result.anchorDate).toContain('2026-05-10')
    expect(result.anchorWarn).toBeUndefined()
  })

  it('falls through to fallback-30d when both tag and promotion-merge fail', async () => {
    const deps = makeRunDeps({
      'git tag --list': '',
      'git log': '',
    })
    const result = await resolveAnchor(undefined, deps)
    expect(result.anchorSource).toBe('fallback-30d')
    expect(result.anchorWarn).toBeTruthy()
    // anchorDate should be approximately 30 days ago
    const now = Date.now()
    const anchor = new Date(result.anchorDate).getTime()
    const diffDays = (now - anchor) / (1000 * 60 * 60 * 24)
    expect(diffDays).toBeGreaterThan(29)
    expect(diffDays).toBeLessThan(31)
  })

  it('falls through to fallback-30d when git commands throw', async () => {
    const deps = {
      run: vi.fn().mockRejectedValue(new Error('git not found')),
    }
    const result = await resolveAnchor(undefined, deps)
    expect(result.anchorSource).toBe('fallback-30d')
    expect(result.anchorWarn).toBeTruthy()
  })
})

// ─── listCommitsSince ────────────────────────────────────────────────────────

describe('listCommitsSince', () => {
  it('parses commit lines into sha+title objects', async () => {
    const deps = makeRunDeps({
      'git log': 'abc1234\tfeat: add feature\ndef5678\tfix: patch null\n',
    })
    const commits = await listCommitsSince('2026-05-01', undefined, deps)
    expect(commits).toHaveLength(2)
    expect(commits[0]).toEqual({ sha: 'abc1234', title: 'feat: add feature' })
    expect(commits[1]).toEqual({ sha: 'def5678', title: 'fix: patch null' })
  })

  it('returns empty array for empty git output', async () => {
    const deps = makeRunDeps({
      'git log': '',
    })
    const commits = await listCommitsSince('2026-05-01', undefined, deps)
    expect(commits).toHaveLength(0)
  })

  it('returns empty array when git throws', async () => {
    const deps = { run: vi.fn().mockRejectedValue(new Error('no repo')) }
    const commits = await listCommitsSince('2026-05-01', undefined, deps)
    expect(commits).toHaveLength(0)
  })

  it('handles line without tab gracefully', async () => {
    const deps = makeRunDeps({
      'git log': 'abc1234\n',
    })
    const commits = await listCommitsSince('2026-05-01', undefined, deps)
    expect(commits).toHaveLength(1)
    expect(commits[0]).toEqual({ sha: 'abc1234', title: '' })
  })
})

// ─── fetchHotfixPrShas ───────────────────────────────────────────────────────

describe('fetchHotfixPrShas', () => {
  it('returns a set of SHAs from gh output', async () => {
    const deps = makeRunDeps({
      'gh pr list': 'sha111\nsha222\nsha333\n',
    })
    const shas = await fetchHotfixPrShas('2026-05-01', deps)
    expect(shas.has('sha111')).toBe(true)
    expect(shas.has('sha222')).toBe(true)
    expect(shas.has('sha333')).toBe(true)
    expect(shas.size).toBe(3)
  })

  it('returns empty set for empty gh output', async () => {
    const deps = makeRunDeps({
      'gh pr list': '',
    })
    const shas = await fetchHotfixPrShas('2026-05-01', deps)
    expect(shas.size).toBe(0)
  })

  it('returns empty set when gh throws (graceful degradation)', async () => {
    const deps = { run: vi.fn().mockRejectedValue(new Error('no auth')) }
    const shas = await fetchHotfixPrShas('2026-05-01', deps)
    expect(shas.size).toBe(0)
  })

  it('uses only the first 10 chars of anchorDate for --search date filter', async () => {
    const runMock = vi.fn().mockResolvedValue('')
    const deps = { run: runMock }
    await fetchHotfixPrShas('2026-05-01T10:00:00Z', deps)
    const callArgs: string[] = runMock.mock.calls[0][0]
    const searchArg = callArgs[callArgs.indexOf('--search') + 1]
    expect(searchArg).toContain('merged:>=2026-05-01')
  })
})

// ─── computeHotfixDensity — integration paths ─────────────────────────────────

function makeDepsForIntegration(opts: { tags?: string; promoLog?: string; commits?: string; prShas?: string }): Deps {
  return {
    run: vi.fn(async (cmd: string[]) => {
      const joined = cmd.join(' ')
      if (joined.includes('git tag --list')) return opts.tags ?? ''
      if (joined.includes('git log') && joined.includes('main') && joined.includes('merges')) {
        return opts.promoLog ?? ''
      }
      if (joined.includes('git log') && joined.includes('main..staging')) return opts.commits ?? ''
      if (joined.includes('gh pr list')) return opts.prShas ?? ''
      throw new Error(`Unexpected cmd: ${joined}`)
    }),
  }
}

describe('computeHotfixDensity', () => {
  it('returns green result for zero commits', async () => {
    const deps = makeDepsForIntegration({
      tags: 'dev-core/v1.0.0 2026-05-01T10:00:00+02:00\n',
      commits: '',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.total).toBe(0)
    expect(result.hotfixCount).toBe(0)
    expect(result.density).toBe(0)
    expect(result.gauge).toBe('green')
    expect(result.anchorSource).toBe('tag')
  })

  it('returns green gauge for <20% hotfix density', async () => {
    const deps = makeDepsForIntegration({
      tags: 'v1.0.0 2026-05-01T10:00:00+02:00\n',
      // 1 fix out of 10 = 10%
      commits: [
        'sha01\tfix: one fix',
        'sha02\tfeat: feature a',
        'sha03\tfeat: feature b',
        'sha04\tfeat: feature c',
        'sha05\tfeat: feature d',
        'sha06\tfeat: feature e',
        'sha07\tchore: cleanup',
        'sha08\tdocs: update readme',
        'sha09\trefactor: small refactor',
        'sha10\ttest: add tests',
      ].join('\n'),
      prShas: '',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.total).toBe(10)
    expect(result.hotfixCount).toBe(1)
    expect(result.density).toBeCloseTo(0.1)
    expect(result.gauge).toBe('green')
  })

  it('returns warn gauge for 20–40% hotfix density', async () => {
    const deps = makeDepsForIntegration({
      tags: 'v1.0.0 2026-05-01T10:00:00+02:00\n',
      // 3 fix out of 10 = 30%
      commits: [
        'sha01\tfix: first',
        'sha02\tfix: second',
        'sha03\tfix: third',
        'sha04\tfeat: a',
        'sha05\tfeat: b',
        'sha06\tfeat: c',
        'sha07\tchore: d',
        'sha08\tdocs: e',
        'sha09\trefactor: f',
        'sha10\ttest: g',
      ].join('\n'),
      prShas: '',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.hotfixCount).toBe(3)
    expect(result.gauge).toBe('warn')
  })

  it('returns pause gauge for >40% hotfix density', async () => {
    const deps = makeDepsForIntegration({
      tags: 'v1.0.0 2026-05-01T10:00:00+02:00\n',
      // 5 fix out of 10 = 50%
      commits: [
        'sha01\tfix: a',
        'sha02\tfix: b',
        'sha03\tfix: c',
        'sha04\tfix: d',
        'sha05\tfix: e',
        'sha06\tfeat: f',
        'sha07\tfeat: g',
        'sha08\tchore: h',
        'sha09\tdocs: i',
        'sha10\ttest: j',
      ].join('\n'),
      prShas: '',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.hotfixCount).toBe(5)
    expect(result.gauge).toBe('pause')
  })

  it('classifies hotfix from PR label (sha in hotfixPrShas)', async () => {
    const deps = makeDepsForIntegration({
      tags: 'v1.0.0 2026-05-01T10:00:00+02:00\n',
      // feat commit but PR has hotfix label
      commits: ['prsha1\tfeat: should be classified hotfix via label', 'sha02\tfeat: normal feature'].join('\n'),
      prShas: 'prsha1',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.hotfixCount).toBe(1)
    expect(result.total).toBe(2)
    expect(result.density).toBeCloseTo(0.5)
    expect(result.gauge).toBe('pause')
  })

  it('uses fallback-30d when no tags or promotion merge, emits anchorWarn', async () => {
    const deps = makeDepsForIntegration({
      tags: '',
      promoLog: '',
      commits: 'sha01\tfeat: something\n',
      prShas: '',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.anchorSource).toBe('fallback-30d')
    expect(result.anchorWarn).toBeTruthy()
  })

  it('uses promotion-merge when no tags but promo commit found', async () => {
    const deps = makeDepsForIntegration({
      tags: '',
      promoLog: 'abcdef 2026-05-15 09:00:00 +0200',
      commits: '',
    })
    const result = await computeHotfixDensity(undefined, deps)
    expect(result.anchorSource).toBe('promotion-merge')
    expect(result.anchorWarn).toBeUndefined()
  })
})

// ─── formatResult ─────────────────────────────────────────────────────────────

describe('formatResult', () => {
  const baseResult: HotfixDensityResult = {
    total: 10,
    hotfixCount: 1,
    density: 0.1,
    gauge: 'green',
    anchorDate: '2026-05-01T10:00:00Z',
    anchorSource: 'tag',
  }

  it('formats green result with OK signal', () => {
    const out = formatResult(baseResult)
    expect(out).toContain('1/10')
    expect(out).toContain('10%')
    expect(out).toContain('OK')
  })

  it('formats warn result with WARN signal', () => {
    const result: HotfixDensityResult = {
      ...baseResult,
      hotfixCount: 3,
      density: 0.3,
      gauge: 'warn',
    }
    const out = formatResult(result)
    expect(out).toContain('3/10')
    expect(out).toContain('30%')
    expect(out).toContain('WARN')
    expect(out).toContain('/checkup')
  })

  it('formats pause result with PAUSE recommended signal', () => {
    const result: HotfixDensityResult = {
      ...baseResult,
      hotfixCount: 5,
      density: 0.5,
      gauge: 'pause',
    }
    const out = formatResult(result)
    expect(out).toContain('5/10')
    expect(out).toContain('50%')
    expect(out).toContain('PAUSE')
    expect(out).toContain('/checkup')
  })

  it('appends anchorWarn note when present', () => {
    const result: HotfixDensityResult = {
      ...baseResult,
      anchorSource: 'fallback-30d',
      anchorWarn: 'No release tag found — using 30-day window',
    }
    const out = formatResult(result)
    expect(out).toContain('note:')
    expect(out).toContain('30-day window')
  })

  it('does not append note when anchorWarn absent', () => {
    const out = formatResult(baseResult)
    expect(out).not.toContain('note:')
  })

  it('formats zero commits result', () => {
    const result: HotfixDensityResult = {
      total: 0,
      hotfixCount: 0,
      density: 0,
      gauge: 'green',
      anchorDate: '2026-05-01',
      anchorSource: 'tag',
    }
    const out = formatResult(result)
    expect(out).toContain('0/0')
    expect(out).toContain('0%')
    expect(out).toContain('OK')
  })
})

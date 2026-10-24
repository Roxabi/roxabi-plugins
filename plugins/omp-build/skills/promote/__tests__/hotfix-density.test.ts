import { describe, expect, it, vi } from 'vitest'
import { createExtensionApiStub } from '../../../omp/__tests__/extension-api-stub'
import ompBuildExtension from '../../../omp/index'
import { computeHotfixDensity } from '../lib/hotfix-density'
import {
  classifyDensity,
  formatResult,
  type HotfixDensityResult,
  isHotfix,
  THRESHOLD_GREEN,
  THRESHOLD_PAUSE,
  THRESHOLD_WARN,
} from '../lib/hotfix-density-domain'
import { fetchHotfixPrShas, listCommitsSince, resolveAnchor } from '../lib/hotfix-density-readback'
import { commandResponses, promoteReadback } from './promote-test-support'

describe('density thresholds', () => {
  it('keeps the threshold contract', () => {
    expect(THRESHOLD_GREEN).toBe(0.2)
    expect(THRESHOLD_WARN).toBe(0.4)
    expect(THRESHOLD_PAUSE).toBe(THRESHOLD_WARN)
  })

  it.each([
    [0, 'green'],
    [0.19, 'green'],
    [0.2, 'warn'],
    [0.39, 'warn'],
    [0.4, 'pause'],
    [1, 'pause'],
  ] as const)('classifies %s as %s', (density, gauge) => {
    expect(classifyDensity(density)).toBe(gauge)
  })
})

describe('hotfix classification', () => {
  it('uses the title-or-merged-label union', () => {
    expect(isHotfix('title', 'fix: correct null check', new Set())).toBe(true)
    expect(isHotfix('label', 'feat: addition', new Set(['label']))).toBe(true)
    expect(isHotfix('other', 'feat: prefix fix in middle', new Set(['label']))).toBe(false)
  })
})

describe('anchor resolution', () => {
  it('uses the newest release tag with its provenance', async () => {
    const deps = commandResponses({
      'git tag --list': 'omp-build/v2.0.0 2026-06-01T10:00:00+02:00\nomp-build/v1.9.0 2026-05-01T10:00:00+02:00\n',
    })
    await expect(resolveAnchor(undefined, deps)).resolves.toEqual({
      anchorDate: '2026-06-01T10:00:00+02:00',
      anchorSource: 'tag',
    })
  })

  it('uses the promotion merge when tag readback has no release', async () => {
    const deps = commandResponses({ 'git tag --list': '', 'git log': 'abc1234 2026-05-10 12:00:00 +0200' })
    await expect(resolveAnchor(undefined, deps)).resolves.toEqual({
      anchorDate: '2026-05-10 12:00:00 +0200',
      anchorSource: 'promotion-merge',
    })
  })

  it('falls back to the bounded window after unavailable readback', async () => {
    const result = await resolveAnchor(undefined, { run: vi.fn().mockRejectedValue(new Error('git not found')) })
    expect(result.anchorSource).toBe('fallback-30d')
    expect(result.anchorWarn).toBeTruthy()
    const ageDays = (Date.now() - new Date(result.anchorDate).getTime()) / (1000 * 60 * 60 * 24)
    expect(ageDays).toBeGreaterThan(29)
    expect(ageDays).toBeLessThan(31)
  })
})

describe('external readback', () => {
  it('parses staging commits and preserves a title-less commit', async () => {
    const commits = await listCommitsSince(
      '2026-05-01',
      undefined,
      commandResponses({ 'git log': 'abc1234\tfeat: add feature\ndef5678\tfix: patch null\nno-title\n' }),
    )
    expect(commits).toEqual([
      { sha: 'abc1234', title: 'feat: add feature' },
      { sha: 'def5678', title: 'fix: patch null' },
      { sha: 'no-title', title: '' },
    ])
  })

  it('uses one date-bounded merged-PR query and degrades on failure', async () => {
    const run = vi.fn().mockResolvedValue('sha111\nsha222\n')
    await expect(fetchHotfixPrShas('2026-05-01T10:00:00Z', { run })).resolves.toEqual(new Set(['sha111', 'sha222']))
    const query = run.mock.calls[0][0] as string[]
    expect(query).toContain('label:hotfix merged:>=2026-05-01')
    await expect(
      fetchHotfixPrShas('2026-05-01', { run: vi.fn().mockRejectedValue(new Error('no auth')) }),
    ).resolves.toEqual(new Set())
  })
})

describe('computeHotfixDensity', () => {
  it('does not query labels for an empty commit window', async () => {
    const deps = promoteReadback({ tags: 'omp-build/v1.0.0 2026-05-01T10:00:00+02:00\n', commits: '' })
    await expect(computeHotfixDensity(undefined, deps)).resolves.toMatchObject({
      total: 0,
      hotfixCount: 0,
      density: 0,
      gauge: 'green',
      anchorSource: 'tag',
    })
    expect(deps.run).toHaveBeenCalledTimes(2)
  })

  it.each([
    [
      'green',
      [
        'sha01\tfix: one fix',
        'sha02\tfeat: feature a',
        'sha03\tfeat: feature b',
        'sha04\tfeat: feature c',
        'sha05\tfeat: feature d',
        'sha06\tfeat: feature e',
      ].join('\n'),
      '',
      6,
      1,
    ],
    [
      'warn',
      [
        'labelled01\tfeat: feature a',
        'labelled02\tfeat: feature b',
        'sha03\tfeat: feature c',
        'sha04\tfeat: feature d',
        'sha05\tfeat: feature e',
        'sha06\tfeat: feature f',
      ].join('\n'),
      'labelled01\nlabelled02',
      6,
      2,
    ],
    [
      'pause',
      ['labelled\tfeat: labeled hotfix', 'sha02\tfix: second', 'sha03\tfeat: a', 'sha04\tfeat: b'].join('\n'),
      'labelled',
      4,
      2,
    ],
  ] as const)(
    'returns %s for title-only, label-only, and combined hotfix evidence',
    async (gauge, commits, prShas, total, hotfixCount) => {
      const result = await computeHotfixDensity(
        undefined,
        promoteReadback({ tags: 'v1.0.0 2026-05-01T10:00:00+02:00\n', commits, prShas }),
      )
      expect(result).toMatchObject({ total, hotfixCount, gauge, anchorSource: 'tag' })
    },
  )

  it('retains fallback provenance', async () => {
    const result = await computeHotfixDensity(undefined, promoteReadback({ commits: 'sha01\tfeat: something\n' }))
    expect(result.anchorSource).toBe('fallback-30d')
    expect(result.anchorWarn).toBeTruthy()
  })

  it('retains promotion-merge provenance', async () => {
    const result = await computeHotfixDensity(
      undefined,
      promoteReadback({ promoLog: 'abcdef 2026-05-15 09:00:00 +0200', commits: '' }),
    )
    expect(result).toMatchObject({ anchorSource: 'promotion-merge', anchorDate: '2026-05-15 09:00:00 +0200' })
  })
})

function slashCommands(text: string): string[] {
  return [...text.matchAll(/(?<![\w/])\/[A-Za-z][\w-]*/g)].map(([command]) => command)
}

const SHIPPED = new Set<string>()
ompBuildExtension(createExtensionApiStub({ registerCommand: (name) => SHIPPED.add(`/${name}`) }))

describe('formatResult', () => {
  const baseResult: HotfixDensityResult = {
    total: 10,
    hotfixCount: 1,
    density: 0.1,
    gauge: 'green',
    anchorDate: '2026-05-01T10:00:00Z',
    anchorSource: 'tag',
  }

  it.each([
    ['green', 1, 0.1, 'OK'],
    ['warn', 3, 0.3, 'WARN'],
    ['pause', 5, 0.5, 'PAUSE'],
  ] as const)('renders %s without a dead command', (gauge, hotfixCount, density, signal) => {
    const output = formatResult({ ...baseResult, gauge, hotfixCount, density })
    expect(output).toContain(`${hotfixCount}/10`)
    expect(output).toContain(signal)
    expect(slashCommands(output).filter((command) => !SHIPPED.has(command))).toEqual([])
  })

  it('adds fallback provenance only when present', () => {
    expect(formatResult({ ...baseResult, anchorWarn: 'No release tag found — using 30-day window' })).toContain('note:')
    expect(formatResult(baseResult)).not.toContain('note:')
  })
})

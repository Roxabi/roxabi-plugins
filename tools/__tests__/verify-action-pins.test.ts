import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildGovernedPairs,
  findInlinePins,
  findUngovernedPins,
  type InlinePin,
  parseInlinePins,
  parsePins,
} from '../verify-action-pins'

// ─── parsePins ───────────────────────────────────────────────────────────────

describe('parsePins', () => {
  it('parses name/action/sha/tag from an ACTION_PINS-shaped source', () => {
    const source = [
      'export const ACTION_PINS = {',
      "  checkout: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10', // v6",
      '} as const',
    ].join('\n')
    expect(parsePins(source)).toEqual([
      { name: 'checkout', action: 'actions/checkout', sha: 'df4cb1c069e1874edd31b4311f1884172cec0e10', tag: 'v6' },
    ])
  })

  it('returns an empty array when nothing matches', () => {
    expect(parsePins('export const ACTION_PINS = {} as const')).toEqual([])
  })
})

// ─── parseInlinePins ─────────────────────────────────────────────────────────

describe('parseInlinePins', () => {
  it('matches a literal uses: owner/repo@<sha>', () => {
    const source = '      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10  # v6\n'
    expect(parseInlinePins(source)).toEqual([
      { action: 'actions/checkout', ref: 'df4cb1c069e1874edd31b4311f1884172cec0e10' },
    ])
  })

  it('matches a floating tag ref (F3 — an unpinned action must not be invisible)', () => {
    const source = '      - uses: actions/checkout@v3\n'
    expect(parseInlinePins(source)).toEqual([{ action: 'actions/checkout', ref: 'v3' }])
  })

  it('does NOT match an ACTION_PINS template-interpolation ref', () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: emitter template syntax — intentionally a plain string
    const source = '      - uses: ${ACTION_PINS.checkout}\n'
    expect(parseInlinePins(source)).toEqual([])
  })

  it('finds every literal pin across a multi-line source, skipping template refs', () => {
    const source = [
      '      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: emitter template syntax — intentionally a plain string
      '      - uses: ${ACTION_PINS.setupBun}',
      '      - uses: owner/repo@v3',
    ].join('\n')
    expect(parseInlinePins(source)).toEqual([
      { action: 'actions/checkout', ref: 'df4cb1c069e1874edd31b4311f1884172cec0e10' },
      { action: 'owner/repo', ref: 'v3' },
    ])
  })
})

// ─── findInlinePins ──────────────────────────────────────────────────────────

describe('findInlinePins', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const fixtureRelPath = 'tools/__tests__/.tmp-inline-pins-fixture.ts'
  const fixtureAbsPath = path.join(repoRoot, fixtureRelPath)

  afterEach(() => {
    if (fs.existsSync(fixtureAbsPath)) fs.rmSync(fixtureAbsPath)
  })

  it('reads a file relative to the repo root and attaches its path to each pin', () => {
    fs.writeFileSync(fixtureAbsPath, '      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10\n')
    expect(findInlinePins([fixtureRelPath])).toEqual([
      { file: fixtureRelPath, action: 'actions/checkout', ref: 'df4cb1c069e1874edd31b4311f1884172cec0e10' },
    ])
  })
})

// ─── buildGovernedPairs / findUngovernedPins ────────────────────────────────

describe('findUngovernedPins', () => {
  const governedPairs = buildGovernedPairs([
    { name: 'checkout', action: 'owner/repo', sha: 'abc1234deadbeefabc1234deadbeefabc1234de', tag: 'v6' },
  ])

  it('does not flag a correctly governed action+sha pair', () => {
    const pins: InlinePin[] = [{ file: 'f.ts', action: 'owner/repo', ref: 'abc1234deadbeefabc1234deadbeefabc1234de' }]
    expect(findUngovernedPins(pins, governedPairs)).toEqual([])
  })

  it('flags a floating tag on an otherwise-governed action (F3)', () => {
    const pins: InlinePin[] = [{ file: 'f.ts', action: 'owner/repo', ref: 'v3' }]
    expect(findUngovernedPins(pins, governedPairs)).toEqual(pins)
  })

  it('flags a right-SHA-wrong-action pin (F2)', () => {
    const pins: InlinePin[] = [
      { file: 'f.ts', action: 'WRONG-ORG/wrong-action', ref: 'abc1234deadbeefabc1234deadbeefabc1234de' },
    ]
    expect(findUngovernedPins(pins, governedPairs)).toEqual(pins)
  })

  it('comparison is case-insensitive on both action and ref', () => {
    const pins: InlinePin[] = [{ file: 'f.ts', action: 'OWNER/REPO', ref: 'ABC1234DEADBEEFABC1234DEADBEEFABC1234DE' }]
    expect(findUngovernedPins(pins, governedPairs)).toEqual([])
  })

  it('does not flag anything when there are no inline pins', () => {
    expect(findUngovernedPins([], governedPairs)).toEqual([])
  })
})

// ─── Regression pins — mutation-confirmed real bugs ─────────────────────────

describe('regression — F2: right SHA, wrong action must be flagged', () => {
  it('WRONG-ORG/wrong-action@<a real governed sha> is ungoverned', () => {
    const pins = parsePins(
      [
        'export const ACTION_PINS = {',
        "  dependabotFetchMetadata: 'dependabot/fetch-metadata@25dd0e34f4fe68f24cc83900b1fe3fe149efef98', // v3.1.0",
        '} as const',
      ].join('\n'),
    )
    const governedPairs = buildGovernedPairs(pins)
    const inline: InlinePin[] = [
      { file: 'x.ts', action: 'WRONG-ORG/wrong-action', ref: '25dd0e34f4fe68f24cc83900b1fe3fe149efef98' },
    ]
    expect(findUngovernedPins(inline, governedPairs)).toEqual(inline)
  })
})

describe('regression — F3: floating tag must not be invisible to the parser', () => {
  it('parseInlinePins captures a bare tag ref that the old hex-only regex matched nothing on', () => {
    expect(parseInlinePins('      - uses: owner/repo@v3\n')).toEqual([{ action: 'owner/repo', ref: 'v3' }])
  })
})

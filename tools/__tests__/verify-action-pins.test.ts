import * as fs from 'node:fs'
import * as path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  buildGovernedPairs,
  EMITTER_PATHS,
  findFloatingWorkflowPins,
  findInlinePins,
  findUngovernedPins,
  type InlinePin,
  parseInlinePins,
  parsePins,
  RENDER_MODULES,
  renderInlinePins,
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

// ─── findFloatingWorkflowPins (committed workflows: SHA-or-fail) ──────────────

describe('findFloatingWorkflowPins', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')
  const dirRel = 'tools/__tests__/.tmp-floating-fixture'
  const dirAbs = path.join(repoRoot, dirRel)

  afterEach(() => {
    if (fs.existsSync(dirAbs)) fs.rmSync(dirAbs, { recursive: true, force: true })
  })

  it('flags a committed workflow pinned to a floating tag, ignores SHA-pinned ones', () => {
    fs.mkdirSync(dirAbs, { recursive: true })
    fs.writeFileSync(
      path.join(dirAbs, 'pinned.yml'),
      '      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10  # v6\n',
    )
    fs.writeFileSync(path.join(dirAbs, 'floating.yml'), '      - uses: actions/checkout@v6\n')
    // context-lint.yml shipped exactly this floating ref unnoticed (#375 FU-3).
    expect(findFloatingWorkflowPins(dirRel)).toEqual([
      { file: `${dirRel}/floating.yml`, action: 'actions/checkout', ref: 'v6' },
    ])
  })

  it('accepts a SHA-pinned action that is NOT in ACTION_PINS — governance is not this check', () => {
    fs.mkdirSync(dirAbs, { recursive: true })
    // setup-python is never emitted by a generator (ungoverned) but IS SHA-pinned: legitimate
    // in a committed workflow. This is the exact case findUngovernedPins would wrongly flag.
    fs.writeFileSync(
      path.join(dirAbs, 'ok.yml'),
      '      - uses: actions/setup-python@ece7cb06caefa5fff74198d8649806c4678c61a1\n',
    )
    expect(findFloatingWorkflowPins(dirRel)).toEqual([])
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

// ─── F4: every uses:-emitting file is scanned, no invisible bypass ──────────

describe('regression — F4: emitter list scans every uses:-emitting file', () => {
  it('includes github-infra.ts and workflow-pins.ts (APP_MINT_STEP moved here, #369)', () => {
    expect(EMITTER_PATHS).toContain('plugins/dev-core/skills/shared/adapters/github-infra.ts')
    expect(EMITTER_PATHS).toContain('plugins/dev-core/skills/shared/workflows/workflow-pins.ts')
  })
})

// ─── F12: rendered-output scan catches a concat pin the source scan misses ──

describe('regression — F12: rendered generators expose pins the source scan cannot', () => {
  const repoRoot = path.resolve(__dirname, '..', '..')

  it('renders every zero-arity generator and every rendered pin is governed', async () => {
    const pins = parsePins(
      fs.readFileSync(path.join(repoRoot, 'plugins/dev-core/skills/shared/workflows/workflow-pins.ts'), 'utf-8'),
    )
    const governed = buildGovernedPairs(pins)
    const { pins: rendered, rendered: names, warnings } = await renderInlinePins(RENDER_MODULES)
    expect(warnings).toEqual([]) // a zero-arity generator that throws is a real regression
    expect(names.length).toBeGreaterThan(0)
    expect(findUngovernedPins(rendered, governed)).toEqual([])
  })

  it('a concat pin, invisible to the source scan, is flagged once rendered', () => {
    // Concat builds a pin at runtime, so no `uses: owner/repo@ref` literal exists in source —
    // findInlinePins sees nothing. The pin only appears in the rendered YAML, where it is caught.
    const renderedConcat = '      - uses: actions/cache@v4\n'
    const pins = parseInlinePins(renderedConcat).map((p) => ({ file: 'gen()', ...p }))
    const governed = buildGovernedPairs(
      parsePins(
        "export const ACTION_PINS = {\n  checkout: 'actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10', // v6\n} as const",
      ),
    )
    expect(findUngovernedPins(pins, governed)).toEqual(pins)
  })
})

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type ArtifactState, classifyFinalize, type FinalizeInput, type FinalizeVerdict } from '../lib/finalize'

const FINALIZE_TS = fileURLToPath(new URL('../lib/finalize.ts', import.meta.url))

// classifyFinalize is a PURE function judging the finalize action AROUND price.sh
// output (it does NOT compute versions). It takes the derived version, the tag
// floor (base), the three witnesses, and the per-artifact tag/release state, and
// returns { action, warnings, reason }. Spec 353 S11 / D4 / D7 / D16.

// ─── helpers ───────────────────────────────────────────────────────────────────

const DERIVED = '0.25.0'

/**
 * A well-formed promote: 2 parents, non-empty payload (derived !== base), every
 * witness agreeing with the derivation, tag+release both absent (a fresh cut).
 * Overrides let each test isolate a single dimension.
 */
function makeInput(overrides: Partial<FinalizeInput> = {}): FinalizeInput {
  return {
    parentCount: 2,
    isPromote: true,
    derived: DERIVED,
    base: '0.24.1',
    witnesses: { title: DERIVED, heading: DERIVED, versionFile: DERIVED },
    tagState: 'absent',
    releaseState: 'absent',
    ...overrides,
  }
}

// ─── Structural REFUSE precedence (S11 / D7) ────────────────────────────────────

describe('classifyFinalize — structural REFUSE', () => {
  it('refuses when the merge has ≠2 parents (M^2 undefined — squash/fast-forward)', () => {
    const one = classifyFinalize(makeInput({ parentCount: 1 }))
    expect(one.action).toBe('refuse')
    expect(one.reason).toMatch(/parent/i)

    const three = classifyFinalize(makeInput({ parentCount: 3 }))
    expect(three.action).toBe('refuse')
    expect(three.reason).toMatch(/parent/i)
  })

  it('refuses when the merge is not a promote (by PR metadata, D8)', () => {
    const v = classifyFinalize(makeInput({ isPromote: false }))
    expect(v.action).toBe('refuse')
    expect(v.reason).toMatch(/promote/i)
  })

  it('refuses on an empty payload (derived == base, nothing to release — D16/D18)', () => {
    const v = classifyFinalize(makeInput({ derived: '0.24.1', base: '0.24.1' }))
    expect(v.action).toBe('refuse')
    expect(v.reason).toMatch(/empty|nothing/i)
  })

  it('gives each structural failure a distinct reason', () => {
    const reasons = new Set([
      classifyFinalize(makeInput({ parentCount: 1 })).reason,
      classifyFinalize(makeInput({ isPromote: false })).reason,
      classifyFinalize(makeInput({ derived: '0.24.1', base: '0.24.1' })).reason,
    ])
    expect(reasons.size).toBe(3)
  })

  it('structural REFUSE takes precedence over an otherwise taggable state', () => {
    // tag absent (would be 'tag'), witnesses all agree — but ≠2 parents wins.
    const v = classifyFinalize(makeInput({ parentCount: 1, tagState: 'absent' }))
    expect(v.action).toBe('refuse')
  })

  it('structural REFUSE takes precedence over drift', () => {
    // both structural (empty payload) and drift (tag elsewhere) hold — structural wins.
    const v = classifyFinalize(makeInput({ derived: '0.24.1', base: '0.24.1', tagState: 'points-elsewhere' }))
    expect(v.action).toBe('refuse')
    expect(v.reason).toMatch(/empty|nothing/i)
  })
})

// ─── Witness disagreement is a WARN, not a REFUSE (D4 / D7) ─────────────────────

describe('classifyFinalize — witness disagreement is a WARN', () => {
  it('tags the DERIVED version even when all three witnesses disagree', () => {
    const v = classifyFinalize(
      makeInput({
        witnesses: { title: '0.24.9', heading: '0.24.8', versionFile: '0.22.3' },
      }),
    )
    // A witness cannot veto the authority — the merge already shipped.
    expect(v.action).toBe('tag')
    expect(v.warnings.length).toBe(3)
  })

  it('names each disagreeing witness in the warnings', () => {
    const v = classifyFinalize(
      makeInput({
        witnesses: { title: '0.24.9', heading: '0.24.8', versionFile: '0.22.3' },
      }),
    )
    expect(v.warnings.some((w) => /title/i.test(w))).toBe(true)
    expect(v.warnings.some((w) => /heading/i.test(w))).toBe(true)
    expect(v.warnings.some((w) => /version.?file/i.test(w))).toBe(true)
  })

  it('warns only for the witnesses that actually disagree', () => {
    const v = classifyFinalize(
      makeInput({
        witnesses: { title: '0.24.9', heading: DERIVED, versionFile: DERIVED },
      }),
    )
    expect(v.action).toBe('tag')
    expect(v.warnings.length).toBe(1)
    expect(v.warnings.some((w) => /title/i.test(w))).toBe(true)
  })

  it('does not warn on an absent (null) witness — version_files: [] leaves no file witness', () => {
    const v = classifyFinalize(
      makeInput({
        witnesses: { title: DERIVED, heading: DERIVED, versionFile: null },
      }),
    )
    expect(v.action).toBe('tag')
    expect(v.warnings).toEqual([])
  })

  it('emits no warnings when every witness agrees with the derivation', () => {
    const v = classifyFinalize(makeInput())
    expect(v.action).toBe('tag')
    expect(v.warnings).toEqual([])
  })
})

// ─── Per-artifact idempotence (D16) ─────────────────────────────────────────────

describe('classifyFinalize — per-artifact idempotence', () => {
  it('noop when both tag and release already point at M', () => {
    const v = classifyFinalize(makeInput({ tagState: 'points-at-M', releaseState: 'points-at-M' }))
    expect(v.action).toBe('noop')
    expect(v.warnings).toEqual([])
  })

  it('create-release when the tag points at M but the release is absent', () => {
    const v = classifyFinalize(makeInput({ tagState: 'points-at-M', releaseState: 'absent' }))
    expect(v.action).toBe('create-release')
  })

  it('tag when the tag is absent (release absent)', () => {
    const v = classifyFinalize(makeInput({ tagState: 'absent', releaseState: 'absent' }))
    expect(v.action).toBe('tag')
  })

  it('tag when the tag is absent even if the release somehow points at M', () => {
    // tagState=absent → 'tag' regardless of releaseState (S11 / D16).
    const v = classifyFinalize(makeInput({ tagState: 'absent', releaseState: 'points-at-M' }))
    expect(v.action).toBe('tag')
  })

  it('refuses (drift) when the tag points elsewhere (≠ M)', () => {
    const v = classifyFinalize(makeInput({ tagState: 'points-elsewhere', releaseState: 'absent' }))
    expect(v.action).toBe('refuse')
    expect(v.reason).toMatch(/drift|elsewhere|point/i)
  })

  it('refuses (drift) when the release points elsewhere (≠ M)', () => {
    const v = classifyFinalize(makeInput({ tagState: 'points-at-M', releaseState: 'points-elsewhere' }))
    expect(v.action).toBe('refuse')
    expect(v.reason).toMatch(/drift|elsewhere|point/i)
  })

  it('drift REFUSE holds even when every witness agrees (idempotence ≠ drift)', () => {
    const v = classifyFinalize(
      makeInput({
        tagState: 'points-elsewhere',
        releaseState: 'points-at-M',
        witnesses: { title: DERIVED, heading: DERIVED, versionFile: DERIVED },
      }),
    )
    expect(v.action).toBe('refuse')
  })
})

// ─── Shape ──────────────────────────────────────────────────────────────────────

describe('classifyFinalize — verdict shape', () => {
  it('always returns { action, warnings[], reason }', () => {
    const v: FinalizeVerdict = classifyFinalize(makeInput())
    expect(['tag', 'create-release', 'noop', 'refuse']).toContain(v.action)
    expect(Array.isArray(v.warnings)).toBe(true)
    expect(typeof v.reason).toBe('string')
  })

  const states: ArtifactState[] = ['absent', 'points-at-M', 'points-elsewhere']
  it('accepts every ArtifactState for tag and release without throwing', () => {
    for (const tagState of states) {
      for (const releaseState of states) {
        expect(() => classifyFinalize(makeInput({ tagState, releaseState }))).not.toThrow()
      }
    }
  })
})

// ─── CLI wiring — the EXECUTED verdict IS the tested classifier (F2/#369) ────────
// /promote --finalize runs `bun run lib/finalize.ts`; this proves that path returns exactly
// what classifyFinalize returns, so the tested code and the executed code cannot diverge.

function toArgv(input: FinalizeInput): string[] {
  return [
    '--parent-count',
    String(input.parentCount),
    '--is-promote',
    String(input.isPromote),
    '--derived',
    input.derived,
    '--base',
    input.base,
    '--witness-title',
    input.witnesses.title ?? '',
    '--witness-heading',
    input.witnesses.heading ?? '',
    '--witness-file',
    input.witnesses.versionFile ?? '',
    '--tag-state',
    input.tagState,
    '--release-state',
    input.releaseState,
  ]
}

function runFinalizeCli(input: FinalizeInput): { action: string; reason: string; warnings: string[]; code: number } {
  const r = spawnSync('bun', ['run', FINALIZE_TS, ...toArgv(input)], { encoding: 'utf8' })
  const lines = (r.stdout ?? '').split('\n')
  const field = (k: string): string => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1) ?? ''
  return {
    action: field('action'),
    reason: field('reason'),
    warnings: lines.filter((l) => l.startsWith('warning=')).map((l) => l.slice('warning='.length)),
    code: r.status ?? -1,
  }
}

describe('finalize.ts CLI matches classifyFinalize', () => {
  const cases: Array<[string, FinalizeInput]> = [
    ['clean tag', makeInput()],
    ['structural refuse (1 parent)', makeInput({ parentCount: 1 })],
    ['structural refuse (empty payload)', makeInput({ derived: '0.24.1', base: '0.24.1' })],
    ['drift refuse (tag elsewhere)', makeInput({ tagState: 'points-elsewhere' })],
    ['witness WARN, still acts', makeInput({ witnesses: { title: '9.9.9', heading: DERIVED, versionFile: null } })],
    ['green no-op', makeInput({ tagState: 'points-at-M', releaseState: 'points-at-M' })],
  ]

  it.each(cases)('%s → CLI verdict == pure verdict', (_label, input) => {
    const expected = classifyFinalize(input)
    const got = runFinalizeCli(input)
    expect(got.action).toBe(expected.action)
    expect(got.reason).toBe(expected.reason)
    expect(got.warnings).toEqual(expected.warnings)
    expect(got.code).toBe(expected.action === 'refuse' ? 1 : 0)
  })
})

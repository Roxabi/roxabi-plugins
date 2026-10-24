import { describe, expect, it } from 'vitest'
import { parseRosterConfig } from '../roster-config'
import { defaultConfig, gate, roster, useRosterWorkspace } from './roster.fixture'

useRosterWorkspace()

describe('overrides', () => {
  it('R-security-auditor never + path hit → ¬spawn stack:never', () => {
    const out = roster({
      delta: ['src/auth/token.ts'],
      config: defaultConfig({ overrides: { 'R-security-auditor': 'never' } }),
    })
    expect(out.spawn_security_auditor).toBe(false)
    expect(out.agents).not.toContain('R-security-auditor')
    expect(gate(out, 'R-security-auditor')).toMatchObject({ spawn: false, reason: 'stack:never' })
  })

  it('R-architect always at F-lite → spawn', () => {
    const out = roster({
      delta: ['src/foo.ts'],
      tier: 'F-lite',
      config: defaultConfig({ overrides: { 'R-architect': 'always' } }),
    })
    expect(out.agents).toContain('R-architect')
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: true, reason: 'stack:always' })
  })

  it('R-adversarial never → still spawned with floor + warning', () => {
    const out = roster({
      config: defaultConfig({ overrides: { 'R-adversarial': 'never' } }),
    })
    expect(out.agents).toContain('R-adversarial')
    expect(gate(out, 'R-adversarial')).toMatchObject({ spawn: true, reason: 'floor' })
    expect(out.warnings).toContain('R-adversarial cannot be disabled')
  })
})

describe('parseRosterConfig', () => {
  it('active block parses', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 3
    agents:
      R-security-auditor: default
      R-tester: always
`)
    expect(cfg.maxAgents).toBe(3)
    expect(cfg.overrides['R-security-auditor']).toBe('default')
    expect(cfg.overrides['R-tester']).toBe('always')
    expect(cfg.warnings).toEqual([])
  })

  it('comments and quotes are tolerated', () => {
    const cfg = parseRosterConfig(`
review: # top
  roster:
    max_agents: "8" # cap
    agents:
      R-tester: "always" # quoted
`)
    expect(cfg.maxAgents).toBe(8)
    expect(cfg.overrides['R-tester']).toBe('always')
    expect(cfg.warnings).toEqual([])
  })

  it('absent review block uses the max_agents=3 default', () => {
    const cfg = parseRosterConfig('runtime: bun\nbackend:\n  path: apps/api\n')
    expect(cfg).toEqual({ maxAgents: 3, axialOverride: 'default', overrides: {}, warnings: [] })
  })

  it('max_agents 0 clamps to 1 with a warning', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    max_agents: 0\n')
    expect(cfg.maxAgents).toBe(1)
    expect(cfg.warnings).toContain('max_agents < 1; clamped to 1')
  })

  // The key still has a real input — a project carrying it must be told. What it
  // no longer has is a value anyone can read: the review-wide cap it fed is gone
  // (#535 F4), so the warning is the whole observable effect.
  it('max_agents_review is a deprecated no-op: warning only, no field, no clamping', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    max_agents_review: 6\n')
    expect(Object.hasOwn(cfg, 'maxAgentsReview')).toBe(false)
    expect(cfg.warnings).toContain('max_agents_review is deprecated and ignored; use the per-chunk max_agents cap')
    const negative = parseRosterConfig('review:\n  roster:\n    max_agents_review: -3\n')
    expect(negative.warnings).toContain('max_agents_review is deprecated and ignored; use the per-chunk max_agents cap')
    expect(negative.warnings.some((w) => w.includes('clamped'))).toBe(false)
  })

  it('removed confidence and recall knobs are accepted only as deprecated no-ops', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    verify_below_confidence: 20
    recall_min_delta: 5
`)
    expect(Object.hasOwn(cfg, 'verifyBelowConfidence')).toBe(false)
    expect(Object.hasOwn(cfg, 'recallMinDelta')).toBe(false)
    expect(cfg.warnings.some((w) => w.startsWith('verify_below_confidence is deprecated'))).toBe(true)
    expect(cfg.warnings.some((w) => w.startsWith('recall_min_delta is deprecated'))).toBe(true)
  })

  it('removed overrides emit deprecations; axial gets a mode-specific override and phase agents stay ignored', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    agents:
      R-axial-adr-review: always
      R-recall: never
      R-finding-verifier: always
      R-options: always
`)
    expect(cfg.axialOverride).toBe('always')
    expect(cfg.overrides['R-architect']).toBeUndefined()
    expect(cfg.overrides['R-recall']).toBeUndefined()
    expect(cfg.overrides['R-finding-verifier']).toBeUndefined()
    expect(cfg.overrides['R-options']).toBeUndefined()
    for (const agent of ['R-axial-adr-review', 'R-recall', 'R-finding-verifier', 'R-options']) {
      expect(cfg.warnings).toContain(`deprecated roster agent override: ${agent}`)
    }
    expect(cfg.warnings).toContain('R-recall override ignored; recall is no longer a roster agent')
    expect(cfg.warnings).toContain('R-finding-verifier override ignored; confidence-only finding removal was retired')
    expect(cfg.warnings).toContain('R-options override ignored; options is an /R-analyze host-native worker')
  })

  it.each([
    ['legacy before canonical', '      R-axial-adr-review: always\n      R-architect: default'],
    ['canonical before legacy', '      R-architect: default\n      R-axial-adr-review: always'],
  ])('parses legacy axial mode independently of canonical key order: %s', (_label, agents) => {
    const cfg = parseRosterConfig(`review:\n  roster:\n    agents:\n${agents}\n`)
    expect(cfg.axialOverride).toBe('always')
    expect(cfg.overrides['R-architect']).toBe('default')
    expect(cfg.warnings).toContain('R-axial-adr-review override applies to R-architect axial mode only; rename the key')
  })

  it.each([
    ['legacy before canonical', '      R-axial-adr-review: always\n      R-architect: never'],
    ['canonical before legacy', '      R-architect: never\n      R-axial-adr-review: always'],
  ])('canonical architect override has deterministic global precedence: %s', (_label, agents) => {
    const cfg = parseRosterConfig(`review:\n  roster:\n    agents:\n${agents}\n`)
    expect(cfg.axialOverride).toBe('always')
    expect(cfg.overrides['R-architect']).toBe('never')
    expect(cfg.warnings).toContain(
      'conflicting R-architect (never) and R-axial-adr-review (always) overrides; R-architect takes global precedence',
    )
  })

  it('misindented legacy key warns and is not parsed', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    max_agents: 3\n      recall_min_delta: 10\n')
    expect(cfg.warnings).toContain('unrecognised roster key at indent 6: recall_min_delta')
  })

  it('misspelled or dedented roster blocks warn instead of silently applying', () => {
    const misspelled = parseRosterConfig('review:\n  rooster:\n    max_agents: 9\n')
    const dedented = parseRosterConfig('review:\n  other: 1\nroster:\n  max_agents: 9\n')
    expect(misspelled.maxAgents).toBe(3)
    expect(dedented.maxAgents).toBe(3)
    expect(misspelled.warnings).toContain('review.roster missing')
    expect(dedented.warnings).toContain('review.roster missing')
  })

  it('sequence and flow agent mappings warn instead of silently empty overrides', () => {
    for (const text of [
      'review:\n  roster:\n    agents:\n      - R-tester\n',
      'review:\n  roster:\n    agents: {R-tester: always}\n',
    ]) {
      const cfg = parseRosterConfig(text)
      expect(cfg.overrides).toEqual({})
      expect(cfg.warnings).toContain(
        'roster agents block present but no key: value entries recognised (sequence or flow mapping?)',
      )
    }
  })

  it('duplicate top-level review keeps the first block and warns', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    max_agents: 2\nreview:\n  roster:\n    max_agents: 9\n')
    expect(cfg.maxAgents).toBe(2)
    expect(cfg.warnings).toContain('duplicate top-level review: block ignored')
  })

  it('parse faults warn and use current defaults', () => {
    const poison = {
      trim: () => 'x',
      replace: () => {
        throw new Error('boom')
      },
    } as unknown as string
    const cfg = parseRosterConfig(poison)
    expect(cfg.maxAgents).toBe(3)
    expect(cfg.overrides).toEqual({})
    expect(cfg.warnings).toEqual(['review.roster parse failed: boom; using defaults'])
  })

  it('four-space and tab indentation parse', () => {
    const spaces = parseRosterConfig('review:\n    roster:\n        max_agents: 6\n')
    const tabs = parseRosterConfig('review:\n\troster:\n\t\tmax_agents: 5\n\t\tagents:\n\t\t\tR-tester: never\n')
    expect(spaces.maxAgents).toBe(6)
    expect(tabs.maxAgents).toBe(5)
    expect(tabs.overrides['R-tester']).toBe('never')
  })
})

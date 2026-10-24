import { describe, expect, it } from 'vitest'
import type { ComputeRosterInput, GateRow } from '../roster-contract'
import { allocateReview, computeRoster } from '../roster-selection'
import { defaultConfig, emptyPaths, gate, roster, useRosterWorkspace } from './roster.fixture'

useRosterWorkspace()

function allocateShared(partial: Partial<ComputeRosterInput> = {}): ComputeRosterInput {
  return {
    delta: ['src/foo.ts'],
    tier: 'F-full',
    chunks: 1,
    claims: [],
    pricedClaimOk: true,
    specDraft: false,
    axialAdr: false,
    stackPaths: emptyPaths(),
    config: defaultConfig(),
    ...partial,
  }
}

describe('cap', () => {
  it('default cap is at most 3 total agents per chunk', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/__tests__/x.ts', 'adapters/x.ts', 'Dockerfile'],
      axialAdr: true,
    })
    expect(out.max_agents).toBe(3)
    expect(out.agents.length).toBeLessThanOrEqual(3)
    expect(out.candidates).toEqual(['R-adversarial', 'R-security-auditor', 'R-architect', 'R-devops', 'R-tester'])
    expect(out.agents).toEqual(['R-adversarial', 'R-security-auditor', 'R-architect'])
    expect(out.capped).toEqual(['R-devops', 'R-tester'])
    for (const name of out.capped) {
      expect(gate(out, name)).toEqual({ agent: name, spawn: false, reason: 'capped', forced: false })
    }
    expect(out.warnings).toContain('roster: 2 agent(s) dropped by max_agents: R-devops, R-tester')
  })

  it('devops outranks tester for the last slot', () => {
    const out = roster({ delta: ['src/auth/token.ts', 'Dockerfile', 'tests/a.test.ts'] })
    expect(out.agents).toEqual(['R-adversarial', 'R-security-auditor', 'R-devops'])
    expect(out.capped).toEqual(['R-tester'])
  })

  it('forced R-architect survives max_agents 2 when path_hit ∧ R-tester also trip', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/foo.test.ts'],
      config: defaultConfig({ maxAgents: 2, overrides: { 'R-architect': 'always' } }),
    })
    expect(out.agents).toContain('R-architect')
    expect(out.agents).toEqual(['R-adversarial', 'R-architect'])
    expect(out.capped.length).toBeGreaterThan(0)
    expect(out.capped).toEqual(['R-security-auditor', 'R-tester'])
    expect(out.warnings).toContain('roster: 2 agent(s) dropped by max_agents: R-security-auditor, R-tester')
  })

  it('|forced| > max_agents raises cap and keeps every forced agent', () => {
    const out = roster({
      delta: ['src/foo.ts'],
      config: defaultConfig({
        maxAgents: 1,
        overrides: { 'R-architect': 'always', 'R-devops': 'always' },
      }),
    })
    expect(out.agents).toEqual(['R-adversarial', 'R-devops', 'R-architect'])
    expect(out.capped).toEqual(['R-tester'])
    expect(out.max_agents).toBe(3)
    expect(out.warnings).toContain('max_agents (1) < forced agents (3) — cap raised to 3')
  })

  it('capped ≠ ∅ always yields dropped-by-max_agents warning', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/foo.test.ts'],
      config: defaultConfig({ maxAgents: 1 }),
    })
    expect(out.capped.length).toBeGreaterThan(0)
    expect(out.warnings.some((w) => w.startsWith('roster:') && w.includes('dropped by max_agents:'))).toBe(true)
  })

  // The axial reason carries a mode prefix (`axial:stack:always`), so an equality
  // test against `stack:always` silently unforces the pin the operator wrote:
  // `always` held in structural mode and dropped in axial mode (#535 F5).
  it('always survives the cap in axial mode too — forced is a flag, not a spelling', () => {
    const out = roster({
      delta: ['adapters/x.ts', 'src/auth/token.ts', 'src/foo.test.ts'],
      axialAdr: true,
      config: defaultConfig({ maxAgents: 2, overrides: { 'R-architect': 'always' } }),
    })
    expect(gate(out, 'R-architect')).toEqual({
      agent: 'R-architect',
      spawn: true,
      reason: 'axial:stack:always',
      forced: true,
    })
    expect(out.agents).toEqual(['R-adversarial', 'R-architect'])
    expect(out.capped).toEqual(['R-security-auditor', 'R-tester'])
  })
})

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

describe('allocateReview', () => {
  it('keeps R-architect in every architecture chunk', () => {
    const chunkDeltas = Array.from({ length: 5 }, (_, i) => [`docs/architecture/model${i}.md`])
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({ delta: chunkDeltas.flat(), chunks: 5 }),
    })
    for (const agents of out.chunk_agents) {
      expect(agents).toEqual(['R-adversarial', 'R-architect'])
      expect(agents).toHaveLength(2)
    }
  })

  it('keeps R-architect in axial and structural chunks under the per-chunk cap', () => {
    const chunkDeltas = [['adapters/model.ts'], ['docs/architecture/model.md']]
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({ delta: chunkDeltas.flat(), chunks: 2, axialAdr: true }),
    })
    expect(out.chunk_agents).toEqual([
      ['R-adversarial', 'R-architect', 'R-tester'],
      ['R-adversarial', 'R-architect'],
    ])
    expect(out.chunk_agents.every((agents) => agents.length <= 3)).toBe(true)
  })

  it('mixed devops+architect: each chunk spawns only what its own paths fired', () => {
    const out = allocateReview({
      chunkDeltas: [['Dockerfile'], ['docs/architecture/model.md']],
      shared: allocateShared({ delta: ['Dockerfile', 'docs/architecture/model.md'], chunks: 2 }),
    })
    expect(out.chunk_agents[0]).toContain('R-devops')
    expect(out.chunk_agents[0]).not.toContain('R-architect')
    expect(out.chunk_agents[1]).toContain('R-architect')
    expect(out.chunk_agents[1]).not.toContain('R-devops')
  })

  it('capped is the per-chunk union, not global xor (mixed Δ, max_agents=1)', () => {
    const out = allocateReview({
      chunkDeltas: [['Dockerfile'], ['docs/architecture/model.md']],
      shared: allocateShared({
        delta: ['Dockerfile', 'docs/architecture/model.md'],
        chunks: 2,
        config: defaultConfig({ maxAgents: 1 }),
      }),
    })
    expect(out.global.capped).toEqual(['R-devops', 'R-architect'])
    expect(out.capped).toEqual(['R-devops', 'R-architect'])
  })

  // SKILL.md Phase 3 sets AXIAL MODE from the architect's gate reason. Read off
  // `global`, every chunk is axial: the structural chunk would be told to run the
  // complete axial ADR procedure for an ADR delta it does not carry (#535 F1).
  it('chunk_gates carry each chunk’s own architect reason; global carries the Δ-wide one', () => {
    const chunkDeltas = [['adapters/model.ts'], ['docs/architecture/model.md']]
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({ delta: chunkDeltas.flat(), chunks: 2, axialAdr: true }),
    })
    const chunkReason = (i: number): string | undefined =>
      out.chunk_gates[i].find((row) => row.agent === 'R-architect')?.reason
    expect(chunkReason(0)).toMatch(/^axial/)
    expect(chunkReason(1)).toBe('structure')
    expect(out.global.gates.find((row) => row.agent === 'R-architect')?.reason).toMatch(/^axial/)
  })

  // The same divergence on the cap verdict: the Δ-wide roster drops two roles it
  // has no room for, while every chunk spawns its own within the per-chunk cap.
  it('chunk_gates report the chunk cap verdict, not the review-wide one', () => {
    const chunkDeltas = [['src/auth/login.ts'], ['src/a.test.ts'], ['Dockerfile'], ['docs/architecture/model.md']]
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({ delta: chunkDeltas.flat(), chunks: 4 }),
    })
    expect(out.global.capped).toEqual(['R-tester', 'R-architect'])
    expect(out.capped).toEqual([])
    const row = (i: number, agent: string): GateRow | undefined => out.chunk_gates[i].find((r) => r.agent === agent)
    expect(out.chunk_agents[1]).toContain('R-tester')
    expect(row(1, 'R-tester')).toEqual({ agent: 'R-tester', spawn: true, reason: 'test-delta', forced: false })
    expect(row(3, 'R-architect')).toEqual({ agent: 'R-architect', spawn: true, reason: 'structure', forced: false })
    expect(out.global.gates.find((r) => r.agent === 'R-tester')?.reason).toBe('capped')
  })

  // What the removed review-wide cap claimed to guard: nothing collapses instances
  // across chunks. Five auth chunks spawn five floors and five auditors — ten
  // instances against a per-chunk cap of 3, so no review-wide ceiling exists.
  it('no review-wide cap collapses per-chunk instances', () => {
    const chunkDeltas = Array.from({ length: 5 }, (_, i) => [`src/auth/login${i}.ts`])
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({ delta: chunkDeltas.flat(), chunks: 5 }),
    })
    expect(out.chunk_agents.filter((c) => c.includes('R-adversarial'))).toHaveLength(5)
    expect(out.chunk_agents.reduce((n, c) => n + c.length, 0)).toBe(15)
    expect(out.capped).toEqual([])
  })

  it('per-chunk cap keeps the same specialist in more than one chunk', () => {
    const chunkDeltas = [['src/a.test.ts'], ['src/auth/login.ts', 'src/auth/login.test.ts']]
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({
        delta: chunkDeltas.flat(),
        chunks: 2,
        config: defaultConfig({ maxAgents: 2 }),
      }),
    })
    expect(out.chunk_agents[0]).toEqual(['R-adversarial', 'R-tester'])
    expect(out.chunk_agents[1]).toEqual(['R-adversarial', 'R-security-auditor'])
    expect(out.chunk_agents.every((agents) => agents.length <= 2)).toBe(true)
    const dropped = out.warnings.filter((w) => w.includes('dropped by max_agents:'))
    expect(dropped.every((w, i) => dropped.indexOf(w) === i)).toBe(true)
    expect(dropped.some((w) => w.includes('R-tester'))).toBe(true)
  })

  it('single-chunk allocateReview ≡ computeRoster.agents', () => {
    const delta = ['src/app.ts']
    const shared = allocateShared({ delta, chunks: 1 })
    const a = allocateReview({ chunkDeltas: [delta], shared })
    const c = computeRoster(shared)
    expect(a.agents).toEqual(c.agents)
    expect(a.chunk_agents).toEqual([c.agents])
  })
})

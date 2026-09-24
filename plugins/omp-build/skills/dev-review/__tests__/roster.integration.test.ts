import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentOverride,
  allocateReview,
  type ComputeRosterInput,
  computeRoster,
  type GateRow,
  hasAxialAdr,
  infraHit,
  parsePricedFences,
  parseRosterConfig,
  pathHit,
  type RosterConfig,
  type StackPaths,
  structureHit,
} from '../roster'

const ROSTER = fileURLToPath(new URL('../roster.ts', import.meta.url))
const RUNNING_AS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'roster-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function writeSpec(body: string): string {
  const p = join(dir, 'spec.md')
  writeFileSync(
    p,
    `---
title: test
status: approved
---

## Success Criteria

${body}
`,
  )
  return p
}

function defaultConfig(overrides: Partial<RosterConfig> = {}): RosterConfig {
  return {
    maxAgents: 3,
    axialOverride: 'default',
    overrides: {},
    warnings: [],
    ...overrides,
  }
}

function emptyPaths(): StackPaths {
  return { frontendPath: '', sharedUi: '', backendPath: '' }
}

function roster(partial: Partial<ComputeRosterInput> = {}) {
  return computeRoster({
    delta: ['src/foo.ts'],
    tier: 'F-lite',
    chunks: 1,
    claims: [],
    pricedClaimOk: true,
    specDraft: false,
    axialAdr: false,
    stackPaths: emptyPaths(),
    config: defaultConfig(),
    ...partial,
  })
}

function gate(out: ReturnType<typeof computeRoster>, agent: string) {
  return out.gates.find((g) => g.agent === agent)
}

describe('parsePricedFences', () => {
  it('ssot-only claim validates without prose stems', () => {
    const spec = writeSpec(`
\`\`\`yaml
claim: [ssot]
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const parsed = parsePricedFences(readFileSync(spec, 'utf-8'))
    expect(parsed.pricedClaimOk).toBe(true)
    expect(parsed.claims).toContain('ssot')
  })

  it('path_hit when delta touches auth path', () => {
    expect(pathHit(['src/auth/login.ts'])).toBe(true)
    expect(pathHit(['plugins/dev-core/skills/foo.ts'])).toBe(false)
  })
})

describe('default roster', () => {
  it('plain TS diff at F-lite arms the tester, not a second specialist', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'F-lite' })
    expect(out.agents).toEqual(['R-adversarial', 'R-tester'])
  })
})

describe('R-security-auditor', () => {
  it('src/auth/token.ts → spawn', () => {
    const out = roster({ delta: ['src/auth/token.ts'] })
    expect(out.path_hit).toBe(true)
    expect(out.spawn_security_auditor).toBe(true)
    expect(out.agents).toContain('R-security-auditor')
    expect(gate(out, 'R-security-auditor')).toMatchObject({ spawn: true, reason: 'path-hit' })
  })

  it('claim tags on non-security Δ do not spawn (cut)', () => {
    const spec = writeSpec(`
- [ ] SC

\`\`\`yaml
claim: [fail-closed]
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const parsed = parsePricedFences(readFileSync(spec, 'utf-8'))
    const out = roster({
      delta: ['plugins/dev-core/skills/foo.ts'],
      claims: parsed.claims,
      pricedClaimOk: parsed.pricedClaimOk,
    })
    expect(out.path_hit).toBe(false)
    expect(out.claims).toContain('fail-closed')
    expect(out.spawn_security_auditor).toBe(false)
    expect(out.agents).toEqual(['R-adversarial', 'R-tester'])
  })

  it('priced fence without valid claim → priced_claim_ok false ∧ ¬spawn', () => {
    const spec = writeSpec(`
\`\`\`yaml
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const parsed = parsePricedFences(readFileSync(spec, 'utf-8'))
    expect(parsed.pricedClaimOk).toBe(false)
    const out = roster({
      delta: ['skills/foo.ts'],
      claims: parsed.claims,
      pricedClaimOk: parsed.pricedClaimOk,
    })
    expect(out.priced_claim_ok).toBe(false)
    expect(out.spawn_security_auditor).toBe(false)
  })

  it('CLI exits 2 on invalid priced fence and prints JSON', () => {
    const spec = writeSpec(`
\`\`\`yaml
priced: "x"
not: "y"
oracles: ["z"]
\`\`\`
`)
    const diff = join(dir, 'delta.txt')
    writeFileSync(diff, 'skills/foo.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', diff, '--spec', spec, '--json', '--stack', join(dir, 'missing.yml')],
      { encoding: 'utf8' },
    )
    expect(proc.status).toBe(2)
    const json = JSON.parse(proc.stdout) as { priced_claim_ok: boolean; spawn_security_auditor: boolean }
    expect(json.priced_claim_ok).toBe(false)
    expect(json.spawn_security_auditor).toBe(false)
  })
})

describe('R-tester', () => {
  it('test file in Δ → spawn on that evidence alone', () => {
    const out = roster({ delta: ['src/__tests__/foo.ts'] })
    expect(out.delta_test_hit).toBe(true)
    expect(out.agents).toContain('R-tester')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: true, reason: 'test-delta' })
  })

  it('arms on every changed-test spelling with no second input', () => {
    for (const path of ['src/foo.test.ts', 'src/foo.spec.ts', 'tests/test_x.py', 'pkg/x_test.go']) {
      const out = roster({ delta: [path] })
      expect({ path, agents: out.agents }).toEqual({ path, agents: ['R-adversarial', 'R-tester'] })
    }
  })

  // The gate dev-core held shut with `--oracle-ok` is gone, not defaulted: no
  // `oracle` reason survives in the JSON, and nothing warns about a missing flag.
  it('emits no oracle reason, field, or undecided warning', () => {
    const out = roster({ delta: ['src/foo.test.ts'] })
    expect(out.gates.filter((g) => g.reason.includes('oracle'))).toEqual([])
    expect(out.warnings.filter((w) => w.includes('oracle'))).toEqual([])
    expect(Object.hasOwn(out, 'oracle_ok')).toBe(false)
  })

  it('size S source with no test file stays cold', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'S' })
    expect(out.delta_test_hit).toBe(false)
    expect(out.agents).not.toContain('R-tester')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: false, reason: 'no-test-delta' })
  })
})

describe('infra', () => {
  it('.github/workflows/ci.yml at F-lite → R-devops without R-architect or R-tester', () => {
    const out = roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-lite' })
    expect(out.agents).toContain('R-devops')
    expect(out.agents).not.toContain('R-architect')
    expect(out.agents).not.toContain('R-tester')
    expect(gate(out, 'R-devops')).toMatchObject({ spawn: true, reason: 'infra' })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
  })

  it('the same infra Δ at F-full has the same tier-independent route', () => {
    const out = roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-full' })
    expect(out.agents).toEqual(['R-adversarial', 'R-devops'])
  })

  it('plain non-infra Δ at F-full does not add R-architect', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'F-full' })
    expect(out.agents).toEqual(['R-adversarial', 'R-tester'])
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
  })
})

describe('R-product-lead', () => {
  it('never appears in agents nor gates', () => {
    const out = roster()
    expect(out.agents).not.toContain('R-product-lead')
    expect(out.gates.some((g) => g.agent === 'R-product-lead')).toBe(false)
  })

  it('R-product-lead: always stack override warns and does not spawn', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    agents:
      R-product-lead: always
`)
    expect(cfg.warnings).toContain('R-product-lead is not part of the review roster — Phase 2 covers spec compliance')
    expect(cfg.overrides['R-product-lead']).toBeUndefined()
    const out = roster({ config: cfg })
    expect(out.agents).not.toContain('R-product-lead')
    expect(out.gates.some((g) => g.agent === 'R-product-lead')).toBe(false)
  })
})

// ADR-020 §7: the two domain roles and the fixer are cut. A project that still
// pins one has to hear about it — a pin dropped as an `unknown roster agent`
// reads like a typo, and the operator fixes the spelling instead of the panel.
describe('cut roles', () => {
  it('never appear in agents, candidates, or gates — whatever the Δ', () => {
    const deltas = [
      ['anywhere/App.tsx'],
      ['src/web/util.ts'],
      ['apps/api/user.ts'],
      ['apps/web/a.tsx', 'apps/api/a.ts'],
    ]
    const cut = ['R-frontend-dev', 'R-backend-dev', 'R-fixer']
    for (const delta of deltas) {
      const out = roster({ delta, stackPaths: { frontendPath: 'apps/web', sharedUi: '', backendPath: 'apps/api' } })
      const named = [...out.agents, ...out.candidates, ...out.gates.map((g) => g.agent)]
      expect({ delta, found: named.filter((a) => cut.includes(a)) }).toEqual({ delta, found: [] })
    }
  })

  it('a stack override naming a domain role warns and is dropped, never silently ignored', () => {
    for (const agent of ['R-frontend-dev', 'R-backend-dev']) {
      const cfg = parseRosterConfig(`review:\n  roster:\n    agents:\n      ${agent}: always\n`)
      expect(cfg.warnings).toContain(`deprecated roster agent override: ${agent}`)
      expect(cfg.warnings).toContain(
        `${agent} override ignored; the domain roles are cut — R-adversarial owns their concerns`,
      )
      expect(cfg.warnings).not.toContain(`unknown roster agent: ${agent}`)
      expect(cfg.overrides[agent]).toBeUndefined()
      expect(roster({ delta: ['anywhere/App.tsx'], config: cfg }).agents).toEqual(['R-adversarial', 'R-tester'])
    }
  })

  it('R-fixer is a deprecated key here too — /fix applies inline', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      R-fixer: always\n')
    expect(cfg.warnings).toContain('R-fixer override ignored; /fix applies findings inline, it spawns no fixer')
    expect(cfg.overrides['R-fixer']).toBeUndefined()
  })

  it('a frontend-only or backend-only diff is reviewed by the floor alone', () => {
    const paths = { frontendPath: 'apps/web', sharedUi: '', backendPath: 'apps/api' }
    expect(roster({ delta: ['anywhere/App.tsx'] }).agents).toEqual(['R-adversarial', 'R-tester'])
    expect(roster({ delta: ['apps/web/a.tsx'], stackPaths: paths }).agents).toEqual(['R-adversarial', 'R-tester'])
    expect(roster({ delta: ['apps/api/user.ts'], stackPaths: paths }).agents).toEqual(['R-adversarial', 'R-tester'])
  })
})

describe('axial', () => {
  it('axial ADR present + adapters/x.ts → R-architect axial mode at F-lite', () => {
    const adr = join(dir, 'adr')
    mkdirSync(adr)
    writeFileSync(join(adr, '0001-foo.md'), '---\naxial: true\n---\n')
    expect(hasAxialAdr(adr)).toBe(true)
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: true, tier: 'F-lite' })
    expect(out.agents).toContain('R-architect')
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: true, reason: 'axial:adr-delta' })
  })

  it('no ADR and no structural signal leaves R-architect cold', () => {
    expect(hasAxialAdr(join(dir, 'missing'))).toBe(false)
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: false })
    expect(out.agents).not.toContain('R-architect')
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
  })

  it('legacy never disables axial mode but preserves structural review', () => {
    const out = roster({
      delta: ['docs/architecture/model.md'],
      axialAdr: true,
      config: defaultConfig({ axialOverride: 'never' }),
    })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: true, reason: 'structure' })
  })

  it('legacy always enables axial mode for a plain delta', () => {
    const out = roster({ config: defaultConfig({ axialOverride: 'always' }) })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
    expect(out.agents).not.toContain('R-architect')
  })

  it('legacy always + ADR + adapters path still spawns axial', () => {
    const out = roster({
      delta: ['adapters/x.ts'],
      axialAdr: true,
      config: defaultConfig({ axialOverride: 'always' }),
    })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: true, reason: 'axial:stack:always' })
    expect(out.agents).toContain('R-architect')
  })

  it('legacy always on plain delta does not starve security under max_agents=3', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/foo.test.ts'],
      config: defaultConfig({ maxAgents: 3, axialOverride: 'always' }),
    })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
    expect(out.agents).not.toContain('R-architect')
    expect(out.agents).toContain('R-security-auditor')
    expect(out.agents).toEqual(['R-adversarial', 'R-security-auditor', 'R-tester'])
  })

  it('canonical never takes global precedence over legacy axial always', () => {
    const out = roster({
      config: defaultConfig({ axialOverride: 'always', overrides: { 'R-architect': 'never' } }),
    })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'stack:never' })
  })
})

describe('structural signals', () => {
  it('explicit architecture and workspace graph files route to R-architect', () => {
    for (const path of ['docs/architecture/adr/001.md', 'turbo.json', 'pnpm-workspace.yaml']) {
      expect(structureHit([path], emptyPaths()), path).toBe(true)
      expect(roster({ delta: [path] }).agents, path).toContain('R-architect')
    }
  })

  it('plugins/dev-core/skills/adr path is not a structural signal alone', () => {
    expect(structureHit(['plugins/dev-core/skills/adr/SKILL.md'], emptyPaths())).toBe(false)
    const out = roster({ delta: ['plugins/dev-core/skills/adr/SKILL.md'] })
    expect(out.agents).not.toContain('R-architect')
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
  })

  it('configured frontend + backend crossing is structural; one domain alone is not', () => {
    const stackPaths = { frontendPath: 'apps/web', sharedUi: '', backendPath: 'apps/api' }
    expect(structureHit(['apps/web/a.tsx', 'apps/api/a.ts'], stackPaths)).toBe(true)
    expect(structureHit(['apps/web/a.tsx'], stackPaths)).toBe(false)
  })
})

describe('reproduced roster misses', () => {
  it('arms the tester and not the architect on a metalyde service file', () => {
    const out = roster({
      delta: ['src/lib/services/budget.ts'],
      tier: 'F-lite',
      stackPaths: { frontendPath: 'src', sharedUi: '', backendPath: 'src' },
    })
    expect(out.agents).toContain('R-tester')
    expect(out.agents).not.toContain('R-architect')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: true, reason: 'untested-change' })
  })

  it('arms architect and tester on a shared-root engine file at F-full', () => {
    const out = roster({
      delta: ['packages/core/src/flows/engine.ts'],
      tier: 'F-full',
      stackPaths: { frontendPath: '', sharedUi: '', backendPath: '', sharedRoots: ['packages/core'] },
    })
    expect(out.agents).toEqual(expect.arrayContaining(['R-architect', 'R-tester']))
    expect(gate(out, 'R-architect')?.reason).toBe('structure')
  })

  it('arms the architect on an ADR path outside docs/architecture', () => {
    const out = roster({ delta: ['docs/kit/architecture/adr/0016-new.md'] })
    expect(out.agents).toContain('R-architect')
    expect(out.agents).not.toContain('R-tester')
  })

  it('maps a spaced legacy tier to F-lite instead of exiting', () => {
    const spec = writeSpec('- [ ] ok')
    const list = join(dir, 'delta.txt')
    writeFileSync(list, 'src/app.ts\n')
    const run = spawnSync(
      'bash',
      [join(fileURLToPath(new URL('../roster.sh', import.meta.url))), '--diff-list', list, '--tier', ' M', '--json'],
      {
        encoding: 'utf8',
      },
    )
    expect(run.status).toBe(0)
    expect(JSON.parse(run.stdout).tier).toBe('F-lite')
    expect(run.stderr).toContain('F-lite')
    void spec
  })
})

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

describe('pathHit', () => {
  // Authored from the requirement (exact TOKEN_SET membership), not the tokenizer.
  const mustHitNew = [
    'src/authService/index.ts',
    'src/api/v2/AuthController.ts',
    'src/jwtVerify.ts',
    'src/authGuard.ts',
    'src/SessionManager.ts',
    'src/oauth2/client.ts',
    'src/saml2/sp.ts',
    'apps/api/src/middleware/authenticate.ts',
    'src/webauthn/register.ts',
    'src/encryption/aes.ts',
    'src/AUTHZ/policy.ts',
    'src/oAuth2/cb.ts',
  ]
  const mustHitRegression = [
    'src/oauth/provider.ts',
    'src/session/token.ts',
    'src/jwt/sign.ts',
    'src/login/password.ts',
    'api/rbac.ts',
    'src/auth/x.ts',
    'infra/tls-cert.ts',
    'x/authz.ts',
  ]
  const mustNotHit = [
    'src/author.ts',
    'docs/AUTHORS.md',
    'src/authoring/page.tsx',
    'lib/tokenizer.ts',
    'test/latest.ts',
    'src/designer.ts',
    'src/constructor/x.ts',
    'lib/valueOf.ts',
    'a/toString.ts',
    'x/hasOwnProperty.ts',
    'y/__proto__/z.ts',
    'src/tokenService.ts',
    'lib/mysecretstuff.ts',
    'brand/tokens.css',
    'brand/design-tokens.json',
    'docs/secretariat.md',
    'src/credentialing/board.ts',
    'src/cryptocurrency/price.ts',
  ]

  it('must-hit-new: case/digit split + new tokens', () => {
    for (const p of mustHitNew) {
      expect(pathHit([p]), p).toBe(true)
    }
  })

  it('must-hit-regression: separator-token hits still fire', () => {
    for (const p of mustHitRegression) {
      expect(pathHit([p]), p).toBe(true)
    }
  })

  it('packages/crypto-prices/index.ts hits via crypto token — accepted over-match', () => {
    expect(pathHit(['packages/crypto-prices/index.ts'])).toBe(true)
  })

  it('must-not-hit: substring, prototype keys, naked token, unanchored stem stay cold', () => {
    for (const p of mustNotHit) {
      expect(pathHit([p]), p).toBe(false)
    }
  })

  it('brand/tokens.css does not spawn security-auditor', () => {
    const css = roster({ delta: ['brand/tokens.css'] })
    expect(css.path_hit).toBe(false)
    expect(css.spawn_security_auditor).toBe(false)
    const auth = roster({ delta: ['apps/app/src/auth/login.ts'] })
    expect(auth.path_hit).toBe(true)
    expect(auth.spawn_security_auditor).toBe(true)
  })
})

describe('prototype keys are not table members', () => {
  it('a bogus agent named after an Object.prototype key warns and is ignored', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      const cfg = parseRosterConfig(`review:\n  roster:\n    agents:\n      ${key}: always\n`)
      expect(cfg.warnings).toContain(`unknown roster agent: ${key}`)
      expect(cfg.overrides[key]).toBeUndefined()
    }
  })

  it('a bogus override value named after an Object.prototype key warns and is ignored', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      R-tester: constructor\n')
    expect(cfg.warnings.join(' ')).toMatch(/invalid override for R-tester/)
    expect(cfg.overrides['R-tester']).toBeUndefined()
  })

  it('parseRosterConfig returns a null-prototype overrides table', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      R-tester: always\n')
    expect(Object.getPrototypeOf(cfg.overrides)).toBeNull()
  })

  // The safety must live in applyOverride, not in how a caller happened to build the config:
  // an inherited `never` must never suppress a gate that fired.
  it('inherited override properties are ignored by applyOverride', () => {
    const overrides: Record<string, AgentOverride> = Object.create({ 'R-architect': 'never' })
    const out = roster({
      delta: ['docs/architecture/model.md'],
      tier: 'F-full',
      config: defaultConfig({ overrides }),
    })
    expect(out.agents).toContain('R-architect')
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: true, reason: 'structure' })
  })
})

describe('infraHit', () => {
  // Requirement: CI/CD, containers, IaC, deploy, host/config-as-code. ¬app source, docs, manifests.
  const mustHit = [
    'scripts/x.sh',
    'apps/web/scripts/build.sh',
    '.github/workflows/ci.yml',
    'lefthook.yml',
    'wrangler.toml',
    'deploy/hook.sh',
    'deploy.sh',
    'Dockerfile',
    'docker-compose.yml',
    'Makefile',
    'Justfile',
    'main.tf',
    'k8s/deploy.yml',
    'helm/Chart.yaml',
    'terraform/main.tf',
    '.gitlab-ci.yml',
    '.gitlab-ci.yaml',
    '.circleci/config.yml',
    'makefile',
    'GNUmakefile',
    'vars.tfvars',
    'Containerfile',
    'ansible/site.yml',
    '.buildkite/pipeline.yml',
    'serverless.yml',
    'Taskfile.yml',
    'charts/app/values.yaml',
    'charts/values.yaml',
    'charts/app/nested/values.yml',
    'Vagrantfile',
    'Pulumi.yaml',
    '.dockerignore',
    'infra/main.bicep',
    'skaffold.yaml',
  ]
  const mustNotHit = ['src/app.ts', 'README.md', 'package.json', 'apps/web/src/main.tsx']

  it('CI/CD, containers, IaC, deploy, host/config-as-code hit', () => {
    for (const p of mustHit) {
      expect({ path: p, hit: infraHit([p]) }).toEqual({ path: p, hit: true })
    }
  })

  it('application source, docs, package manifests miss', () => {
    for (const p of mustNotHit) {
      expect({ path: p, hit: infraHit([p]) }).toEqual({ path: p, hit: false })
    }
  })

  it('nested scripts/ at F-lite → R-devops not R-architect', () => {
    const out = roster({ delta: ['apps/web/scripts/build.sh'], tier: 'F-lite' })
    expect(out.agents).toContain('R-devops')
    expect(out.agents).not.toContain('R-architect')
    expect(gate(out, 'R-devops')).toMatchObject({ spawn: true, reason: 'infra' })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'no-structure' })
  })
})

describe('hasAxialAdr errors', () => {
  it('ENOENT is warning-free', () => {
    const warnings: string[] = []
    expect(hasAxialAdr(join(dir, 'missing'), warnings)).toBe(false)
    expect(warnings).toEqual([])
  })

  it('ENOTDIR (file, not dir) is warning-free', () => {
    const file = join(dir, 'not-a-dir')
    writeFileSync(file, 'x')
    const warnings: string[] = []
    expect(hasAxialAdr(file, warnings)).toBe(false)
    expect(warnings).toEqual([])
  })

  it('unreadable dir warns', () => {
    const adr = join(dir, 'locked')
    mkdirSync(adr)
    writeFileSync(join(adr, 'x.md'), 'axial: true\n')
    chmodSync(adr, 0)
    const warnings: string[] = []
    try {
      expect(hasAxialAdr(adr, warnings)).toBe(false)
      expect(warnings.some((w) => w.startsWith('axial ADR dir unreadable:'))).toBe(true)
    } finally {
      chmodSync(adr, 0o700)
    }
  })

  it('unreadable member file continues and finds sibling axial: true', () => {
    if (RUNNING_AS_ROOT) return
    const adr = join(dir, 'adr')
    mkdirSync(adr)
    const locked = join(adr, '0001-locked.md')
    writeFileSync(locked, 'not axial\n')
    writeFileSync(join(adr, '0002-real.md'), 'axial: true\n')
    chmodSync(locked, 0o000)
    const warnings: string[] = []
    try {
      expect(hasAxialAdr(adr, warnings)).toBe(true)
      expect(warnings.some((w) => w.includes(locked) && w.includes('unreadable'))).toBe(true)
    } finally {
      chmodSync(locked, 0o644)
    }
  })
})

describe('filesystem error policy', () => {
  it('unreadable stack.yml warns naming the file and applies defaults', () => {
    if (RUNNING_AS_ROOT) return
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/foo.ts\n')
    const stack = join(dir, 'stack.yml')
    writeFileSync(stack, 'review:\n  roster:\n    max_agents: 9\n    verify_below_confidence: 10\n')
    chmodSync(stack, 0o000)
    try {
      const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--stack', stack, '--json'], { encoding: 'utf8' })
      expect(proc.status).toBe(0)
      const json = JSON.parse(proc.stdout) as {
        max_agents: number
        warnings: string[]
      }
      expect(json.max_agents).toBe(3)
      expect(Object.hasOwn(json, 'verify_below_confidence')).toBe(false)
      expect(json.warnings.some((w) => w.includes(stack) && w.includes('unreadable'))).toBe(true)
    } finally {
      chmodSync(stack, 0o644)
    }
  })

  it('--diff-list that is a directory warns and exits 1', () => {
    const asDir = join(dir, 'not-a-file')
    mkdirSync(asDir)
    const proc = spawnSync('bun', [ROSTER, '--diff-list', asDir, '--json'], { encoding: 'utf8' })
    expect(proc.status).toBe(1)
    expect(proc.stderr).toContain(asDir)
    expect(proc.stderr).toMatch(/unreadable/)
  })
})

// An absent contract drops every roster override in silence: a project pinning
// `R-security-auditor: always` would run a reduced panel believing it complete.
describe('absent project contract', () => {
  // Runs from a repo root with no --stack, i.e. the resolver default.
  function runInRepo(repoRoot: string): { status: number | null; warnings: string[]; securityAuditor: boolean } {
    const delta = join(repoRoot, 'delta.txt')
    writeFileSync(delta, 'src/foo.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--json'], { cwd: repoRoot, encoding: 'utf8' })
    const json = JSON.parse(proc.stdout) as { warnings: string[]; spawn_security_auditor: boolean }
    expect(Array.isArray(json.warnings), proc.stdout).toBe(true)
    return { status: proc.status, warnings: json.warnings, securityAuditor: json.spawn_security_auditor }
  }

  const PINNED = 'review:\n  roster:\n    agents:\n      R-security-auditor: always\n'

  it('no contract anywhere → warns that overrides are ignored, still exits 0', () => {
    const out = runInRepo(dir)
    expect(out.status).toBe(0)
    expect(out.warnings.some((w) => w.includes('.dev/stack.yml') && w.includes('not found'))).toBe(true)
  })

  it('contract still at the legacy location → override dropped, warning names .claude/stack.yml', () => {
    mkdirSync(join(dir, '.claude'))
    writeFileSync(join(dir, '.claude/stack.yml'), PINNED)
    const out = runInRepo(dir)
    expect(out.status).toBe(0)
    expect(out.securityAuditor).toBe(false)
    const legacy = out.warnings.filter((w) => w.includes('.claude/stack.yml'))
    expect(legacy, out.warnings.join(' | ')).toHaveLength(1)
    expect(legacy[0]).toContain('.dev/stack.yml')
  })

  it('migrated contract → override honoured and no not-found noise', () => {
    mkdirSync(join(dir, '.dev'))
    writeFileSync(join(dir, '.dev/stack.yml'), PINNED)
    const out = runInRepo(dir)
    expect(out.status).toBe(0)
    expect(out.securityAuditor).toBe(true)
    expect(out.warnings.some((w) => w.includes('not found'))).toBe(false)
  })
})

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

  it('CLI --chunk-list twice produces chunk_agents length 2', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/b.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/b.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--chunk-list', c1, '--tier', 'F-full', '--json'],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as {
      chunk_agents: string[][]
      agents: string[]
      chunks: number
    }
    expect(json.chunk_agents).toHaveLength(2)
    expect(json.chunks).toBe(2)
  })

  it('two --chunk-list files without --chunks derive chunks=2', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/b.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/b.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--chunk-list', c1, '--tier', 'F-full', '--json'],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { chunks: number; chunk_agents: string[][] }
    expect(json.chunks).toBe(2)
    expect(json.chunk_agents).toHaveLength(2)
  })

  it('--chunks disagrees with --chunk-list count: warning + file count wins', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/b.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/b.ts\n')
    const proc = spawnSync(
      'bun',
      [
        ROSTER,
        '--diff-list',
        delta,
        '--chunk-list',
        c0,
        '--chunk-list',
        c1,
        '--chunks',
        '1',
        '--tier',
        'F-full',
        '--json',
      ],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { chunks: number; warnings: string[] }
    expect(json.chunks).toBe(2)
    expect(json.warnings.some((w) => w.includes('disagrees'))).toBe(true)
    expect(json.warnings).toContain('--chunks 1 disagrees with 2 --chunk-list file(s); using 2')
  })

  it('empty --chunk-list file exits 1', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\n')
    const empty = join(dir, 'empty.txt')
    writeFileSync(empty, '\n\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', empty, '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status).toBe(1)
    expect(proc.stderr).toMatch(/empty --chunk-list/)
  })

  it('chunk path absent from --diff-list warns', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\n')
    const c0 = join(dir, 'c0.txt')
    writeFileSync(c0, 'src/a.ts\nsrc/missing.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--tier', 'F-full', '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain('chunk path not in --diff-list: src/missing.ts')
  })

  it('path in two chunks warns duplicate chunk path', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\n')
    const c0 = join(dir, 'c0.txt')
    const c1 = join(dir, 'c1.txt')
    writeFileSync(c0, 'src/a.ts\n')
    writeFileSync(c1, 'src/a.ts\n')
    const proc = spawnSync(
      'bun',
      [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--chunk-list', c1, '--tier', 'F-full', '--json'],
      { encoding: 'utf8' },
    )
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain('duplicate chunk path: src/a.ts')
  })

  // The reverse direction of the scope check: a Δ path in no chunk is reviewed by
  // nobody. Chunk→Δ alone left this undetected.
  it('delta path covered by no chunk warns', () => {
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, 'src/a.ts\nsrc/orphan.ts\n')
    const c0 = join(dir, 'c0.txt')
    writeFileSync(c0, 'src/a.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--tier', 'F-full', '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain('1 delta path(s) in no chunk: src/orphan.ts')
  })

  it('uncovered delta paths are aggregated, first 5 named', () => {
    const paths = Array.from({ length: 8 }, (_, i) => `src/orphan${i}.ts`)
    const delta = join(dir, 'delta.txt')
    writeFileSync(delta, `src/a.ts\n${paths.join('\n')}\n`)
    const c0 = join(dir, 'c0.txt')
    writeFileSync(c0, 'src/a.ts\n')
    const proc = spawnSync('bun', [ROSTER, '--diff-list', delta, '--chunk-list', c0, '--tier', 'F-full', '--json'], {
      encoding: 'utf8',
    })
    expect(proc.status, proc.stderr).toBe(0)
    const json = JSON.parse(proc.stdout) as { warnings: string[] }
    expect(json.warnings).toContain(`8 delta path(s) in no chunk: ${paths.slice(0, 5).join(', ')} (+3 more)`)
    expect(json.warnings.filter((w) => w.includes('in no chunk')).length).toBe(1)
  })
})

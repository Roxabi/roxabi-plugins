import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseRosterConfig } from '../roster-config'
import { hasAxialAdr } from '../roster-files'
import { pathHit, structureHit } from '../roster-signals'
import { parsePricedFences } from '../roster-spec'
import { defaultConfig, dir, emptyPaths, gate, ROSTER, roster, useRosterWorkspace, writeSpec } from './roster.fixture'

useRosterWorkspace()

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
    expect(pathHit(['plugins/example/skills/foo.ts'])).toBe(false)
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
      delta: ['plugins/example/skills/foo.ts'],
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

  it('R-fixer remains a deprecated roster key', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      R-fixer: always\n')
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

  it('a plugin skill path is not a structural signal alone', () => {
    expect(structureHit(['plugins/example/skills/adr/SKILL.md'], emptyPaths())).toBe(false)
    const out = roster({ delta: ['plugins/example/skills/adr/SKILL.md'] })
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

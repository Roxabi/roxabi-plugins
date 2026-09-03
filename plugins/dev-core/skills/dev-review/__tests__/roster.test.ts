import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type AgentOverride,
  type ComputeRosterInput,
  computeRoster,
  hasAxialAdr,
  infraHit,
  parsePricedFences,
  parseRosterConfig,
  parseStackPaths,
  pathHit,
  type RosterConfig,
  type StackPaths,
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
    maxAgents: 4,
    verifyBelowConfidence: 90,
    recallMinDelta: 50,
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
    oracleOk: 'missing',
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
  it('plain TS diff at F-lite is exactly adversarial', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'F-lite' })
    expect(out.agents).toEqual(['adversarial'])
  })
})

describe('security-auditor', () => {
  it('src/auth/token.ts → spawn', () => {
    const out = roster({ delta: ['src/auth/token.ts'] })
    expect(out.path_hit).toBe(true)
    expect(out.spawn_security_auditor).toBe(true)
    expect(out.agents).toContain('security-auditor')
    expect(gate(out, 'security-auditor')).toMatchObject({ spawn: true, reason: 'path-hit' })
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
    expect(out.agents).toEqual(['adversarial'])
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

describe('tester', () => {
  it('test file in Δ + oracleOk false → spawn', () => {
    const out = roster({ delta: ['src/__tests__/foo.ts'], oracleOk: 'false' })
    expect(out.delta_test_hit).toBe(true)
    expect(out.agents).toContain('tester')
    expect(gate(out, 'tester')).toMatchObject({ spawn: true, reason: 'oracle-false' })
  })

  it('test file + missing → ¬spawn, oracle-unknown, warning', () => {
    const out = roster({ delta: ['src/foo.test.ts'], oracleOk: 'missing' })
    expect(out.agents).not.toContain('tester')
    expect(gate(out, 'tester')).toMatchObject({ spawn: false, reason: 'oracle-unknown' })
    expect(out.warnings).toContain('tester gate undecided: re-run roster.sh with --oracle-ok')
  })

  it("test file + 'true' → ¬spawn", () => {
    const out = roster({ delta: ['src/foo.spec.ts'], oracleOk: 'true' })
    expect(out.agents).not.toContain('tester')
    expect(gate(out, 'tester')).toMatchObject({ spawn: false, reason: 'oracle-ok' })
  })

  it("no test file + 'false' → ¬spawn", () => {
    const out = roster({ delta: ['src/foo.ts'], oracleOk: 'false' })
    expect(out.delta_test_hit).toBe(false)
    expect(out.agents).not.toContain('tester')
    expect(gate(out, 'tester')).toMatchObject({ spawn: false, reason: 'no-test-delta' })
  })
})

describe('infra', () => {
  it('.github/workflows/ci.yml at F-lite → neither architect nor devops nor backend-dev', () => {
    const out = roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-lite' })
    expect(out.agents).not.toContain('architect')
    expect(out.agents).not.toContain('devops')
    expect(out.agents).not.toContain('backend-dev')
    expect(gate(out, 'devops')).toMatchObject({ spawn: false, reason: 'tier' })
    expect(gate(out, 'architect')).toMatchObject({ spawn: false, reason: 'tier' })
  })

  it('same Δ at F-full → exactly devops (no architect, no backend-dev)', () => {
    const out = roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-full' })
    expect(out.agents).toEqual(['adversarial', 'devops'])
    expect(out.agents).not.toContain('architect')
    expect(out.agents).not.toContain('backend-dev')
  })

  it('non-infra Δ at F-full → exactly architect', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'F-full' })
    expect(out.agents).toEqual(['adversarial', 'architect'])
    expect(out.agents).not.toContain('devops')
  })
})

describe('product-lead', () => {
  it('never appears in agents nor gates', () => {
    const out = roster()
    expect(out.agents).not.toContain('product-lead')
    expect(out.gates.some((g) => g.agent === 'product-lead')).toBe(false)
  })

  it('product-lead: always stack override warns and does not spawn', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    agents:
      product-lead: always
`)
    expect(cfg.warnings).toContain('product-lead is not part of the review roster — Phase 2 covers spec compliance')
    expect(cfg.overrides['product-lead']).toBeUndefined()
    const out = roster({ config: cfg })
    expect(out.agents).not.toContain('product-lead')
    expect(out.gates.some((g) => g.agent === 'product-lead')).toBe(false)
  })
})

describe('frontend-dev', () => {
  it('frontend.path set → prefix gate', () => {
    const paths = parseStackPaths('frontend:\n  path: src/web\n')
    expect(paths.frontendPath).toBe('src/web')
    const hit = roster({
      delta: ['src/web/util.ts'],
      stackPaths: { frontendPath: paths.frontendPath, sharedUi: '', backendPath: '' },
    })
    expect(hit.agents).toContain('frontend-dev')
  })

  it('both paths empty → FE_EXT gate', () => {
    const hit = roster({ delta: ['anywhere/App.tsx'] })
    expect(hit.agents).toContain('frontend-dev')
    const miss = roster({ delta: ['anywhere/app.ts'] })
    expect(miss.agents).not.toContain('frontend-dev')
  })

  it('.tsx outside a configured frontend.path → ¬spawn', () => {
    const out = roster({
      delta: ['other/App.tsx'],
      stackPaths: { frontendPath: 'src/web', sharedUi: '', backendPath: '' },
    })
    expect(out.agents).not.toContain('frontend-dev')
  })
})

describe('axial', () => {
  it('axial ADR present + adapters/x.ts → spawn', () => {
    const adr = join(dir, 'adr')
    mkdirSync(adr)
    writeFileSync(join(adr, '0001-foo.md'), '---\naxial: true\n---\n')
    expect(hasAxialAdr(adr)).toBe(true)
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: true })
    expect(out.agents).toContain('axial-adr-review')
    expect(gate(out, 'axial-adr-review')).toMatchObject({ spawn: true, reason: 'path-hit' })
  })

  it('no ADR dir → ¬spawn with no-axial-adr', () => {
    expect(hasAxialAdr(join(dir, 'missing'))).toBe(false)
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: false })
    expect(out.agents).not.toContain('axial-adr-review')
    expect(gate(out, 'axial-adr-review')).toMatchObject({ spawn: false, reason: 'no-axial-adr' })
  })
})

describe('recall', () => {
  it('chunks 2 + 10 files → recall_eligible false', () => {
    const delta = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`)
    const out = roster({ delta, chunks: 2 })
    expect(out.recall_eligible).toBe(false)
    expect(out.recall_reason).toBe('delta-below-min')
  })

  it('chunks 2 + 60 files → true', () => {
    const delta = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`)
    const out = roster({ delta, chunks: 2 })
    expect(out.recall_eligible).toBe(true)
  })

  it('single chunk + 60 files → false', () => {
    const delta = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`)
    const out = roster({ delta, chunks: 1 })
    expect(out.recall_eligible).toBe(false)
    expect(out.recall_reason).toBe('single-chunk')
  })
})

describe('cap', () => {
  it('6 gate-passing agents with max_agents 3 → priority truncate', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/__tests__/x.ts', 'adapters/x.ts', 'src/ui/App.tsx', 'src/api/foo.ts'],
      oracleOk: 'false',
      axialAdr: true,
      stackPaths: { frontendPath: 'src/ui', sharedUi: '', backendPath: 'src/api' },
      config: defaultConfig({ maxAgents: 3 }),
    })
    expect(out.agents).toEqual(['adversarial', 'security-auditor', 'tester'])
    expect(out.agents).toHaveLength(3)
    expect(out.capped).toEqual(['axial-adr-review', 'frontend-dev', 'backend-dev'])
    for (const name of out.capped) {
      expect(gate(out, name)).toEqual({ agent: name, spawn: false, reason: 'capped' })
    }
    expect(out.warnings).toContain(
      'roster: 3 agent(s) dropped by max_agents: axial-adr-review, frontend-dev, backend-dev',
    )
  })

  it('forced architect survives max_agents 2 when path_hit ∧ tester also trip', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/foo.test.ts'],
      oracleOk: 'false',
      config: defaultConfig({ maxAgents: 2, overrides: { architect: 'always' } }),
    })
    expect(out.agents).toContain('architect')
    expect(out.agents).toEqual(['adversarial', 'architect'])
    expect(out.capped.length).toBeGreaterThan(0)
    expect(out.capped).toEqual(['security-auditor', 'tester'])
    expect(out.warnings).toContain('roster: 2 agent(s) dropped by max_agents: security-auditor, tester')
  })

  it('|forced| > max_agents raises cap and keeps every forced agent', () => {
    const out = roster({
      delta: ['src/foo.ts'],
      config: defaultConfig({
        maxAgents: 1,
        overrides: { architect: 'always', devops: 'always' },
      }),
    })
    expect(out.agents).toEqual(['adversarial', 'devops', 'architect'])
    expect(out.capped).toEqual([])
    expect(out.max_agents).toBe(3)
    expect(out.warnings).toContain('max_agents (1) < forced agents (3) — cap raised to 3')
  })

  it('capped ≠ ∅ always yields dropped-by-max_agents warning', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/foo.test.ts'],
      oracleOk: 'false',
      config: defaultConfig({ maxAgents: 1 }),
    })
    expect(out.capped.length).toBeGreaterThan(0)
    expect(out.warnings.some((w) => w.startsWith('roster:') && w.includes('dropped by max_agents:'))).toBe(true)
  })
})

describe('overrides', () => {
  it('security-auditor never + path hit → ¬spawn stack:never', () => {
    const out = roster({
      delta: ['src/auth/token.ts'],
      config: defaultConfig({ overrides: { 'security-auditor': 'never' } }),
    })
    expect(out.spawn_security_auditor).toBe(false)
    expect(out.agents).not.toContain('security-auditor')
    expect(gate(out, 'security-auditor')).toMatchObject({ spawn: false, reason: 'stack:never' })
  })

  it('architect always at F-lite → spawn', () => {
    const out = roster({
      delta: ['src/foo.ts'],
      tier: 'F-lite',
      config: defaultConfig({ overrides: { architect: 'always' } }),
    })
    expect(out.agents).toContain('architect')
    expect(gate(out, 'architect')).toMatchObject({ spawn: true, reason: 'stack:always' })
  })

  it('adversarial never → still spawned with floor + warning', () => {
    const out = roster({
      config: defaultConfig({ overrides: { adversarial: 'never' } }),
    })
    expect(out.agents).toContain('adversarial')
    expect(gate(out, 'adversarial')).toMatchObject({ spawn: true, reason: 'floor' })
    expect(out.warnings).toContain('adversarial cannot be disabled')
  })
})

describe('parseRosterConfig', () => {
  it('full block parses', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 4
    verify_below_confidence: 90
    recall_min_delta: 50
    agents:
      security-auditor: default
      tester: default
`)
    expect(cfg.maxAgents).toBe(4)
    expect(cfg.verifyBelowConfidence).toBe(90)
    expect(cfg.recallMinDelta).toBe(50)
    expect(cfg.overrides['security-auditor']).toBe('default')
    expect(cfg.overrides.tester).toBe('default')
    expect(cfg.warnings).toEqual([])
  })

  it('comments and quotes tolerated', () => {
    const cfg = parseRosterConfig(`
review: # top
  roster:
    max_agents: "8"  # cap
    verify_below_confidence: '70'
    recall_min_delta: 40
    agents:
      tester: "always"  # quoted
`)
    expect(cfg.maxAgents).toBe(8)
    expect(cfg.verifyBelowConfidence).toBe(70)
    expect(cfg.recallMinDelta).toBe(40)
    expect(cfg.overrides.tester).toBe('always')
    expect(cfg.warnings).toEqual([])
  })

  it('absent review block → defaults with no warnings', () => {
    const cfg = parseRosterConfig('runtime: bun\nbackend:\n  path: apps/api\n')
    expect(cfg).toEqual({
      maxAgents: 4,
      verifyBelowConfidence: 90,
      recallMinDelta: 50,
      overrides: {},
      warnings: [],
    })
  })

  it('max_agents 0 → clamped to 1 + warning', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 0
`)
    expect(cfg.maxAgents).toBe(1)
    expect(cfg.warnings).toContain('max_agents < 1; clamped to 1')
  })

  it('verify_below_confidence > 90 clamped to 90', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    verify_below_confidence: 99
`)
    expect(cfg.verifyBelowConfidence).toBe(90)
    expect(cfg.warnings).toContain('verify_below_confidence > 90; clamped to 90')
  })

  it('verify_below_confidence < 0 clamped to 0', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    verify_below_confidence: -5
`)
    expect(cfg.verifyBelowConfidence).toBe(0)
    expect(cfg.warnings).toContain('verify_below_confidence < 0; clamped to 0')
  })

  it('recall_min_delta < 0 clamped to 0 + warning', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    recall_min_delta: -5
`)
    expect(cfg.recallMinDelta).toBe(0)
    expect(cfg.warnings).toContain('recall_min_delta < 0; clamped to 0')
  })

  it('recall_min_delta: 0 with chunks 2 and 1 file is eligible', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    recall_min_delta: 0
`)
    expect(cfg.recallMinDelta).toBe(0)
    expect(cfg.warnings).toEqual([])
    const out = roster({ delta: ['src/foo.ts'], chunks: 2, config: cfg })
    expect(out.recall_eligible).toBe(true)
    expect(out.recall_reason).toBe('multi-chunk')
  })

  it('misindented verify_below_confidence warns and is not applied', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 3
      verify_below_confidence: 10
`)
    expect(cfg.maxAgents).toBe(3)
    expect(cfg.verifyBelowConfidence).toBe(90)
    expect(cfg.warnings).toContain('unrecognised roster key at indent 6: verify_below_confidence')
  })

  it('misspelled rooster: warns instead of silent defaults', () => {
    const cfg = parseRosterConfig(`
review:
  rooster:
    max_agents: 9
`)
    expect(cfg.maxAgents).toBe(4)
    expect(cfg.warnings).toContain('review.roster missing')
  })

  it('dedented top-level roster: warns', () => {
    const cfg = parseRosterConfig(`
review:
  other: 1
roster:
  max_agents: 9
`)
    expect(cfg.maxAgents).toBe(4)
    expect(cfg.warnings).toContain('review.roster missing')
  })

  it('agents sequence items warn instead of silent empty overrides', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    agents:
      - tester
      - architect
`)
    expect(cfg.overrides).toEqual({})
    expect(cfg.warnings).toContain(
      'roster agents block present but no key: value entries recognised (sequence or flow mapping?)',
    )
  })

  it('agents flow mapping warns instead of silent empty overrides', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    agents: {tester: always}
`)
    expect(cfg.overrides).toEqual({})
    expect(cfg.warnings).toContain(
      'roster agents block present but no key: value entries recognised (sequence or flow mapping?)',
    )
  })

  it('duplicate top-level review: block ignored', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 2
review:
  roster:
    max_agents: 9
`)
    expect(cfg.maxAgents).toBe(2)
    expect(cfg.warnings).toContain('duplicate top-level review: block ignored')
  })

  it('parse fault warns instead of silent defaults', () => {
    const poison = {
      trim: () => 'x',
      replace() {
        throw new Error('boom')
      },
    } as unknown as string
    const cfg = parseRosterConfig(poison)
    expect(cfg.maxAgents).toBe(4)
    expect(cfg.verifyBelowConfidence).toBe(90)
    expect(cfg.overrides).toEqual({})
    expect(cfg.warnings).toEqual(['review.roster parse failed: boom; using defaults'])
  })

  it('4-space-indent roster block parses', () => {
    const cfg = parseRosterConfig(`
review:
    roster:
        max_agents: 6
        agents:
            tester: always
`)
    expect(cfg.maxAgents).toBe(6)
    expect(cfg.overrides.tester).toBe('always')
    expect(cfg.warnings).toEqual([])
  })

  it('tab-indented roster block parses', () => {
    const cfg = parseRosterConfig('review:\n\troster:\n\t\tmax_agents: 5\n\t\tagents:\n\t\t\ttester: never\n')
    expect(cfg.maxAgents).toBe(5)
    expect(cfg.overrides.tester).toBe('never')
    expect(cfg.warnings).toEqual([])
  })
})

describe('pathHit', () => {
  // Authored from C1 requirement lists, not from the tokenizer implementation.
  const mustHitNew = [
    'src/authService/index.ts',
    'src/api/v2/AuthController.ts',
    'src/jwtVerify.ts',
    'src/authGuard.ts',
    'src/SessionManager.ts',
    'src/tokenService.ts',
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
    'lib/mysecretstuff.ts',
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
  ]

  it('must-hit-new: case/digit split + new tokens', () => {
    for (const p of mustHitNew) {
      expect(pathHit([p]), p).toBe(true)
    }
  })

  it('must-hit-regression: separator-token and stem hits still fire', () => {
    for (const p of mustHitRegression) {
      expect(pathHit([p]), p).toBe(true)
    }
  })

  it('must-not-hit: substring and prototype keys stay cold', () => {
    for (const p of mustNotHit) {
      expect(pathHit([p]), p).toBe(false)
    }
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
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      tester: constructor\n')
    expect(cfg.warnings.join(' ')).toMatch(/invalid override for tester/)
    expect(cfg.overrides.tester).toBeUndefined()
  })

  it('parseRosterConfig returns a null-prototype overrides table', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    agents:\n      tester: always\n')
    expect(Object.getPrototypeOf(cfg.overrides)).toBeNull()
  })

  // The safety must live in applyOverride, not in how a caller happened to build the config:
  // an inherited `never` must never suppress a gate that fired.
  it('inherited override properties are ignored by applyOverride', () => {
    const overrides: Record<string, AgentOverride> = Object.create({ architect: 'never' })
    const out = roster({
      delta: ['src/app.ts'],
      tier: 'F-full',
      config: defaultConfig({ overrides }),
    })
    expect(out.agents).toContain('architect')
    expect(gate(out, 'architect')).toMatchObject({ spawn: true, reason: 'structure' })
  })
})

describe('infraHit', () => {
  const patterns: [string, string][] = [
    ['scripts/', 'scripts/x.sh'],
    ['scripts/ nested', 'apps/web/scripts/build.sh'],
    ['.github/', '.github/workflows/ci.yml'],
    ['.github/ nested', 'apps/web/.github/workflows/ci.yml'],
    ['lefthook', 'lefthook.yml'],
    ['lefthook nested', 'apps/web/lefthook.yml'],
    ['wrangler', 'wrangler.toml'],
    ['wrangler nested', 'apps/web/wrangler.toml'],
    ['deploy/', 'deploy/hook.sh'],
    ['deploy/ nested', 'apps/web/deploy/hook.sh'],
    ['deploy.sh', 'deploy.sh'],
    ['deploy.sh nested', 'apps/web/deploy.sh'],
    ['Dockerfile', 'Dockerfile'],
    ['Dockerfile nested', 'apps/web/Dockerfile'],
    ['docker-compose', 'docker-compose.yml'],
    ['docker-compose nested', 'apps/web/docker-compose.yml'],
    ['Makefile', 'Makefile'],
    ['Makefile nested', 'apps/web/Makefile'],
    ['Justfile', 'Justfile'],
    ['Justfile nested', 'apps/web/Justfile'],
    ['*.tf', 'main.tf'],
    ['*.tf nested', 'apps/web/main.tf'],
    ['k8s/', 'k8s/deploy.yml'],
    ['k8s/ nested', 'apps/web/k8s/deploy.yml'],
    ['helm/', 'helm/Chart.yaml'],
    ['helm/ nested', 'apps/web/helm/Chart.yaml'],
    ['terraform/', 'terraform/main.tf'],
    ['terraform/ nested', 'apps/web/terraform/main.tf'],
    ['.gitlab-ci.yml', '.gitlab-ci.yml'],
    ['.gitlab-ci.yml nested', 'apps/web/.gitlab-ci.yml'],
    ['.circleci/', '.circleci/config.yml'],
    ['.circleci/ nested', 'apps/web/.circleci/config.yml'],
  ]

  it('root and monorepo-nested spelling of each pattern', () => {
    for (const [label, p] of patterns) {
      expect({ label, path: p, hit: infraHit([p]) }).toEqual({ label, path: p, hit: true })
    }
  })

  it('nested scripts/ at F-full → devops not architect', () => {
    const out = roster({ delta: ['apps/web/scripts/build.sh'], tier: 'F-full' })
    expect(out.agents).toContain('devops')
    expect(out.agents).not.toContain('architect')
    expect(gate(out, 'devops')).toMatchObject({ spawn: true, reason: 'infra' })
    expect(gate(out, 'architect')).toMatchObject({ spawn: false, reason: 'infra' })
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
        verify_below_confidence: number
        warnings: string[]
      }
      expect(json.max_agents).toBe(4)
      expect(json.verify_below_confidence).toBe(90)
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

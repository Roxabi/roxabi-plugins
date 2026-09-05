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
    maxAgentsReview: 0,
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
  it('plain TS diff at F-lite is exactly R-adversarial', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'F-lite' })
    expect(out.agents).toEqual(['R-adversarial'])
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
    expect(out.agents).toEqual(['R-adversarial'])
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
  it('test file in Δ + oracleOk false → spawn', () => {
    const out = roster({ delta: ['src/__tests__/foo.ts'], oracleOk: 'false' })
    expect(out.delta_test_hit).toBe(true)
    expect(out.agents).toContain('R-tester')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: true, reason: 'oracle-false' })
  })

  it('test file + missing → ¬spawn, oracle-unknown, warning', () => {
    const out = roster({ delta: ['src/foo.test.ts'], oracleOk: 'missing' })
    expect(out.agents).not.toContain('R-tester')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: false, reason: 'oracle-unknown' })
    expect(out.warnings).toContain('R-tester gate undecided: re-run roster.sh with --oracle-ok')
  })

  it("test file + 'true' → ¬spawn", () => {
    const out = roster({ delta: ['src/foo.spec.ts'], oracleOk: 'true' })
    expect(out.agents).not.toContain('R-tester')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: false, reason: 'oracle-ok' })
  })

  it("no test file + 'false' → ¬spawn", () => {
    const out = roster({ delta: ['src/foo.ts'], oracleOk: 'false' })
    expect(out.delta_test_hit).toBe(false)
    expect(out.agents).not.toContain('R-tester')
    expect(gate(out, 'R-tester')).toMatchObject({ spawn: false, reason: 'no-test-delta' })
  })
})

describe('infra', () => {
  it('.github/workflows/ci.yml at F-lite → neither R-architect nor R-devops nor R-backend-dev', () => {
    const out = roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-lite' })
    expect(out.agents).not.toContain('R-architect')
    expect(out.agents).not.toContain('R-devops')
    expect(out.agents).not.toContain('R-backend-dev')
    expect(gate(out, 'R-devops')).toMatchObject({ spawn: false, reason: 'tier' })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'tier' })
  })

  it('same Δ at F-full → exactly R-devops (no R-architect, no R-backend-dev)', () => {
    const out = roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-full' })
    expect(out.agents).toEqual(['R-adversarial', 'R-devops'])
    expect(out.agents).not.toContain('R-architect')
    expect(out.agents).not.toContain('R-backend-dev')
  })

  it('non-infra Δ at F-full → exactly R-architect', () => {
    const out = roster({ delta: ['src/foo.ts'], tier: 'F-full' })
    expect(out.agents).toEqual(['R-adversarial', 'R-architect'])
    expect(out.agents).not.toContain('R-devops')
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

describe('R-frontend-dev', () => {
  it('frontend.path set → prefix gate', () => {
    const paths = parseStackPaths('frontend:\n  path: src/web\n')
    expect(paths.frontendPath).toBe('src/web')
    const hit = roster({
      delta: ['src/web/util.ts'],
      stackPaths: { frontendPath: paths.frontendPath, sharedUi: '', backendPath: '' },
    })
    expect(hit.agents).toContain('R-frontend-dev')
  })

  it('both paths empty → FE_EXT gate', () => {
    const hit = roster({ delta: ['anywhere/App.tsx'] })
    expect(hit.agents).toContain('R-frontend-dev')
    const miss = roster({ delta: ['anywhere/app.ts'] })
    expect(miss.agents).not.toContain('R-frontend-dev')
  })

  it('.tsx outside a configured frontend.path → ¬spawn', () => {
    const out = roster({
      delta: ['other/App.tsx'],
      stackPaths: { frontendPath: 'src/web', sharedUi: '', backendPath: '' },
    })
    expect(out.agents).not.toContain('R-frontend-dev')
  })
})

describe('axial', () => {
  it('axial ADR present + adapters/x.ts → spawn', () => {
    const adr = join(dir, 'adr')
    mkdirSync(adr)
    writeFileSync(join(adr, '0001-foo.md'), '---\naxial: true\n---\n')
    expect(hasAxialAdr(adr)).toBe(true)
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: true })
    expect(out.agents).toContain('R-axial-adr-review')
    expect(gate(out, 'R-axial-adr-review')).toMatchObject({ spawn: true, reason: 'path-hit' })
  })

  it('no ADR dir → ¬spawn with no-axial-adr', () => {
    expect(hasAxialAdr(join(dir, 'missing'))).toBe(false)
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: false })
    expect(out.agents).not.toContain('R-axial-adr-review')
    expect(gate(out, 'R-axial-adr-review')).toMatchObject({ spawn: false, reason: 'no-axial-adr' })
  })
})

describe('R-recall', () => {
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
    expect(out.agents).toEqual(['R-adversarial', 'R-security-auditor', 'R-tester'])
    expect(out.agents).toHaveLength(3)
    expect(out.capped).toEqual(['R-axial-adr-review', 'R-frontend-dev', 'R-backend-dev'])
    for (const name of out.capped) {
      expect(gate(out, name)).toEqual({ agent: name, spawn: false, reason: 'capped' })
    }
    expect(out.warnings).toContain(
      'roster: 3 agent(s) dropped by max_agents: R-axial-adr-review, R-frontend-dev, R-backend-dev',
    )
  })

  it('forced R-architect survives max_agents 2 when path_hit ∧ R-tester also trip', () => {
    const out = roster({
      delta: ['src/auth/token.ts', 'src/foo.test.ts'],
      oracleOk: 'false',
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
  it('full block parses', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 4
    verify_below_confidence: 90
    recall_min_delta: 50
    agents:
      R-security-auditor: default
      R-tester: default
`)
    expect(cfg.maxAgents).toBe(4)
    expect(cfg.verifyBelowConfidence).toBe(90)
    expect(cfg.recallMinDelta).toBe(50)
    expect(cfg.overrides['R-security-auditor']).toBe('default')
    expect(cfg.overrides['R-tester']).toBe('default')
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
      R-tester: "always"  # quoted
`)
    expect(cfg.maxAgents).toBe(8)
    expect(cfg.verifyBelowConfidence).toBe(70)
    expect(cfg.recallMinDelta).toBe(40)
    expect(cfg.overrides['R-tester']).toBe('always')
    expect(cfg.warnings).toEqual([])
  })

  it('absent review block → defaults with no warnings', () => {
    const cfg = parseRosterConfig('runtime: bun\nbackend:\n  path: apps/api\n')
    expect(cfg).toEqual({
      maxAgents: 4,
      maxAgentsReview: 0,
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

  it('max_agents_review defaults to 0', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents: 4
`)
    expect(cfg.maxAgentsReview).toBe(0)
    expect(cfg.warnings).toEqual([])
  })

  it('max_agents_review < 0 clamped to 0 + warning', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents_review: -3
`)
    expect(cfg.maxAgentsReview).toBe(0)
    expect(cfg.warnings).toContain('max_agents_review < 0; clamped to 0')
  })

  it('max_agents_review is a recognised key', () => {
    const cfg = parseRosterConfig(`
review:
  roster:
    max_agents_review: 6
`)
    expect(cfg.maxAgentsReview).toBe(6)
    expect(cfg.warnings).toEqual([])
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
      - R-tester
      - R-architect
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
    agents: {R-tester: always}
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
            R-tester: always
`)
    expect(cfg.maxAgents).toBe(6)
    expect(cfg.overrides['R-tester']).toBe('always')
    expect(cfg.warnings).toEqual([])
  })

  it('tab-indented roster block parses', () => {
    const cfg = parseRosterConfig('review:\n\troster:\n\t\tmax_agents: 5\n\t\tagents:\n\t\t\tR-tester: never\n')
    expect(cfg.maxAgents).toBe(5)
    expect(cfg.overrides['R-tester']).toBe('never')
    expect(cfg.warnings).toEqual([])
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
      delta: ['src/app.ts'],
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

  it('nested scripts/ at F-full → R-devops not R-architect', () => {
    const out = roster({ delta: ['apps/web/scripts/build.sh'], tier: 'F-full' })
    expect(out.agents).toContain('R-devops')
    expect(out.agents).not.toContain('R-architect')
    expect(gate(out, 'R-devops')).toMatchObject({ spawn: true, reason: 'infra' })
    expect(gate(out, 'R-architect')).toMatchObject({ spawn: false, reason: 'infra' })
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

function allocateShared(partial: Partial<ComputeRosterInput> = {}): ComputeRosterInput {
  return {
    delta: ['src/foo.ts'],
    tier: 'F-full',
    chunks: 1,
    oracleOk: 'missing',
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
  it('5 identical F-full app chunks collapse architect to chunk 0', () => {
    const chunkDeltas = Array.from({ length: 5 }, (_, i) => [`src/app${i}.ts`])
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({ delta: chunkDeltas.flat(), chunks: 5 }),
    })
    expect(out.chunk_agents[0]).toEqual(['R-adversarial', 'R-architect'])
    expect(out.collapsed).toContain('R-architect')
    for (let i = 1; i < 5; i++) {
      expect(out.chunk_agents[i]).toEqual(['R-adversarial'])
    }
  })

  it('mixed devops+architect both kept — collapse is per-agent, not xor on full Δ', () => {
    const out = allocateReview({
      chunkDeltas: [['Dockerfile'], ['src/app.ts']],
      shared: allocateShared({ delta: ['Dockerfile', 'src/app.ts'], chunks: 2 }),
    })
    expect(out.chunk_agents[0]).toContain('R-devops')
    expect(out.chunk_agents[0]).not.toContain('R-architect')
    expect(out.chunk_agents[1]).toContain('R-architect')
    expect(out.chunk_agents[1]).not.toContain('R-devops')
    expect(out.collapsed).toEqual([])
  })

  it('capped is the per-chunk union, not global xor (mixed Δ, max_agents=1)', () => {
    const out = allocateReview({
      chunkDeltas: [['Dockerfile'], ['src/app.ts']],
      shared: allocateShared({
        delta: ['Dockerfile', 'src/app.ts'],
        chunks: 2,
        config: defaultConfig({ maxAgents: 1 }),
      }),
    })
    expect(out.global.capped).toEqual(['R-devops'])
    expect(out.capped).toEqual(['R-devops', 'R-architect'])
  })

  it('max_agents_review=6 drops gated names into capped_review; adversarial count equals chunk count', () => {
    const chunkDeltas = Array.from({ length: 5 }, (_, i) => [`src/auth/login${i}.ts`])
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({
        delta: chunkDeltas.flat(),
        chunks: 5,
        config: defaultConfig({ maxAgentsReview: 6 }),
      }),
    })
    const advCount = out.chunk_agents.filter((c) => c.includes('R-adversarial')).length
    expect(advCount).toBe(5)
    expect(out.capped_review.length).toBeGreaterThan(0)
    expect(out.chunk_agents.reduce((n, c) => n + c.length, 0)).toBe(6)
  })

  it('max_agents_review=0 never populates capped_review after collapse', () => {
    const chunkDeltas = Array.from({ length: 5 }, (_, i) => [`src/app${i}.ts`])
    const out = allocateReview({
      chunkDeltas,
      shared: allocateShared({
        delta: chunkDeltas.flat(),
        chunks: 5,
        config: defaultConfig({ maxAgentsReview: 0 }),
      }),
    })
    expect(out.capped_review).toEqual([])
    expect(out.collapsed).toContain('R-architect')
  })

  it('single-chunk allocateReview ≡ computeRoster.agents (no collapse)', () => {
    const delta = ['src/app.ts']
    const shared = allocateShared({ delta, chunks: 1 })
    const a = allocateReview({ chunkDeltas: [delta], shared })
    const c = computeRoster(shared)
    expect(a.agents).toEqual(c.agents)
    expect(a.collapsed).toEqual([])
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
    const json = JSON.parse(proc.stdout) as { chunk_agents: string[][]; agents: string[]; collapsed: string[] }
    expect(json.chunk_agents).toHaveLength(2)
  })
})

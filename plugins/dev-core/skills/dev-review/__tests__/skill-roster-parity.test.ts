import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeRoster, DISPATCHABLE, PHASE_AGENTS, parseRosterConfig } from '../roster'

const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const text = readFileSync(SKILL, 'utf-8')

const section = (from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to))

const dispatch = section('### Agent dispatch', '### R-security-auditor scoping')
const phase4 = section('## Phase 4', '## Phase 6')
const phase6 = section('## Phase 6', '## Phase 8')

/** Agent names as documented in the `### Agent dispatch` table, in table order. */
function documentedAgents(): string[] {
  const rows = dispatch.split('\n').filter((l) => l.startsWith('| **'))
  return rows.map((l) => l.match(/^\| \*\*(R-[a-z-]+)\*\*/)?.[1] ?? '')
}

const roster = (over: Partial<Parameters<typeof computeRoster>[0]> = {}) =>
  computeRoster({
    delta: ['src/app.ts'],
    tier: 'F-lite',
    chunks: 1,
    oracleOk: 'missing',
    claims: [],
    pricedClaimOk: true,
    specDraft: false,
    axialAdr: false,
    stackPaths: { frontendPath: '', sharedUi: '', backendPath: '' },
    config: parseRosterConfig(null),
    ...over,
  })

/**
 * The SKILL dispatch table was deliberately demoted to "documentation of the oracle's
 * gates, ¬an independent decision surface". That is only safe while something mechanically
 * keeps the documentation true — substring assertions cannot, so these compare the
 * documented rows against what `computeRoster` actually decides.
 */
describe('dispatch table ≡ oracle (doc/behaviour parity)', () => {
  it('documents exactly the oracle agent set (Lane A + R-recall)', () => {
    // R-finding-verifier is documented in Phase 4, not the dispatch table.
    const expected = [...DISPATCHABLE, ...PHASE_AGENTS.filter((a) => a !== 'R-finding-verifier')]
    expect(documentedAgents()).toEqual(expected)
  })

  it('R-frontend-dev: documented stack-path-then-extension gate matches', () => {
    expect(dispatch).toContain('`{frontend.path}` ∨ `{shared.ui}` non-empty')
    const configured = { frontendPath: 'src/web', sharedUi: '', backendPath: '' }
    // paths configured → prefix gate, and an FE extension OUTSIDE them must not fire
    expect(roster({ delta: ['src/web/App.tsx'], stackPaths: configured }).agents).toContain('R-frontend-dev')
    expect(roster({ delta: ['src/other/App.tsx'], stackPaths: configured }).agents).not.toContain('R-frontend-dev')
    expect(roster({ delta: ['src/other/app.ts'] }).agents).not.toContain('R-frontend-dev')
  })

  // Driven from the table cell, not hand-picked: a hand-picked `.tsx` case stayed green
  // when `.svelte` was dropped from FE_EXT_RE — the exact drift this suite must catch.
  it('R-frontend-dev: EVERY extension the table documents actually fires', () => {
    const row = dispatch.split('\n').find((l) => l.startsWith('| **R-frontend-dev**')) ?? ''
    const exts = [...row.matchAll(/`(\.[a-z]+)`/g)].map((m) => m[1])
    expect(exts.length).toBeGreaterThanOrEqual(6)
    for (const ext of exts) {
      const delta = [`src/other/Comp${ext}`]
      expect({ ext, spawns: roster({ delta }).agents.includes('R-frontend-dev') }).toEqual({ ext, spawns: true })
    }
  })

  // Same rule for the infra set: each documented token must actually route to R-devops.
  it('R-devops: EVERY infra token the table documents actually fires at τ=F-full', () => {
    const row = dispatch.split('\n').find((l) => l.startsWith('| **R-devops**')) ?? ''
    const cell = row.match(/Δ ∩ \{([^}]+)\}/)?.[1] ?? ''
    const samples: Record<string, string> = {
      'scripts/': 'scripts/build.sh',
      '.github/': '.github/workflows/ci.yml',
      'lefthook.yml': 'lefthook.yml',
      wrangler: 'wrangler.toml',
      deploy: 'deploy/run.ts',
      Dockerfile: 'Dockerfile',
    }
    const tokens = cell
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    expect(tokens.length).toBeGreaterThanOrEqual(6)
    for (const token of tokens) {
      const sample = samples[token]
      // A token documented but not sampled here is a coverage hole, not a pass.
      expect({ token, sampled: Boolean(sample) }).toEqual({ token, sampled: true })
      const agents = roster({ delta: [sample], tier: 'F-full' }).agents
      expect({ token, 'R-devops': agents.includes('R-devops') }).toEqual({ token, 'R-devops': true })
    }
  })

  it('R-backend-dev: documented `{backend.path}` gate matches, empty → never', () => {
    expect(dispatch).toContain('`{backend.path}` non-empty ∧ Δ ∩ that prefix ≠ ∅')
    const configured = { frontendPath: '', sharedUi: '', backendPath: 'api' }
    expect(roster({ delta: ['api/foo.ts'], stackPaths: configured }).agents).toContain('R-backend-dev')
    expect(roster({ delta: ['src/foo.ts'], stackPaths: configured }).agents).not.toContain('R-backend-dev')
    // empty backend.path → never, even on a path that looks backend-ish
    expect(roster({ delta: ['api/foo.ts'] }).agents).not.toContain('R-backend-dev')
  })

  it('R-axial-adr-review: documented ∃ axial ADR ∧ Δ ∩ structural dirs matches', () => {
    expect(dispatch).toContain('∃ axial ADR')
    for (const d of ['infrastructure/x.ts', 'adapters/x.ts', 'domains/x.ts', 'stages/x.ts']) {
      expect(roster({ delta: [d], axialAdr: true }).agents).toContain('R-axial-adr-review')
    }
    // ADR present but Δ misses the structural dirs, and vice versa
    expect(roster({ delta: ['src/app.ts'], axialAdr: true }).agents).not.toContain('R-axial-adr-review')
    expect(roster({ delta: ['adapters/x.ts'], axialAdr: false }).agents).not.toContain('R-axial-adr-review')
  })

  it('R-recall: documented multi-chunk ∧ |Δ| > recall_min_delta matches', () => {
    expect(dispatch).toContain('|chunks|>1 ∧ |Δ| > recall_min_delta')
    const big = Array.from({ length: 60 }, (_, i) => `src/f${i}.ts`)
    const small = Array.from({ length: 10 }, (_, i) => `src/f${i}.ts`)
    expect(roster({ delta: big, chunks: 2 }).recall_eligible).toBe(true)
    expect(roster({ delta: small, chunks: 2 }).recall_eligible).toBe(false)
    expect(roster({ delta: big, chunks: 1 }).recall_eligible).toBe(false)
    // strict `>`: |Δ| exactly at the threshold is NOT eligible
    const atThreshold = Array.from({ length: 50 }, (_, i) => `src/f${i}.ts`)
    expect(roster({ delta: atThreshold, chunks: 2 }).recall_eligible).toBe(false)
  })

  it('adversarial-always: documented "always" holds for the oracle floor', () => {
    expect(dispatch).toMatch(/\| \*\*R-adversarial\*\* \| \*\*always\*\*/)
    expect(roster().agents).toEqual(['R-adversarial'])
  })

  it('R-tester: documented `delta_test_hit ∧ oracle_ok=false` matches the gate', () => {
    expect(dispatch).toContain('`delta_test_hit ∧ oracle_ok=false`')
    const tests = ['src/__tests__/a.test.ts']
    expect(roster({ delta: tests, oracleOk: 'false' }).agents).toContain('R-tester')
    expect(roster({ delta: tests, oracleOk: 'true' }).agents).not.toContain('R-tester')
    expect(roster({ delta: tests, oracleOk: 'missing' }).agents).not.toContain('R-tester')
  })

  it('R-devops/R-architect: documented τ=F-full xor on infra matches the gates', () => {
    expect(dispatch).toContain('τ=F-full ∧ Δ ∩ infra = ∅')
    const infra = ['.github/workflows/ci.yml']
    const plain = ['src/app.ts']
    expect(roster({ delta: infra, tier: 'F-full' }).agents).toEqual(['R-adversarial', 'R-devops'])
    expect(roster({ delta: plain, tier: 'F-full' }).agents).toEqual(['R-adversarial', 'R-architect'])
    // τ≠F-full → neither, whatever the paths
    const lite = roster({ delta: infra }).agents
    expect(lite).not.toContain('R-devops')
    expect(lite).not.toContain('R-architect')
  })

  it('R-security-auditor: documented `path_hit` only — no claim-tag spawn', () => {
    expect(dispatch).toMatch(/\*\*`path_hit`\*\* only/)
    expect(roster({ delta: ['src/oauth/provider.ts'] }).spawn_security_auditor).toBe(true)
    expect(roster({ delta: ['src/app.ts'], claims: ['fail-closed'] }).spawn_security_auditor).toBe(false)
  })

  it('R-product-lead is absent from both the table and the oracle', () => {
    expect(dispatch).not.toMatch(/R-product-lead/)
    expect(roster().gates.some((g) => g.agent === 'R-product-lead')).toBe(false)
  })
})

describe('roster oracle wiring documented in the SKILL', () => {
  it('invokes roster.sh, never the old claim-roster name', () => {
    expect(text).toContain('roster.sh')
    expect(text).not.toMatch(/claim-roster/)
  })

  it('consumes warnings[] and review_halt — no silent channel', () => {
    expect(text).toMatch(/∀ w ∈ warnings\[\] → echo into the review output/)
    expect(text).toMatch(/review_halt: true → HALT/)
  })

  it('documents all three exit codes', () => {
    expect(text).toMatch(/Exit: `0` ok · `1` usage\/IO error/)
    expect(text).toContain('`2` σ priced-fence hygiene')
  })

  it('Skip line keys off spawn_security_auditor', () => {
    expect(text).toMatch(/R-security-auditor → \*\*`¬spawn_security_auditor`\*\*/)
  })
})

/**
 * The filter and the cap are the two mechanisms that remove coverage. Neither may act
 * silently, and neither may reach a blocking finding.
 */
describe('removal mechanisms are bounded and disclosed', () => {
  it('F_low excludes blocking labels', () => {
    expect(phase4).toContain('¬blocks(f)')
    expect(phase4).toMatch(/NEVER sent to the filter and never enter `F_dropped`/)
  })

  it('the filter fails open', () => {
    expect(phase4).toContain('fail-open')
  })

  it('verify_below_confidence is clamped by the oracle, not by prose', () => {
    expect(phase4).toMatch(/clamped to `\[0, 90\]`/)
    const cfg = parseRosterConfig('review:\n  roster:\n    verify_below_confidence: 101\n')
    expect(cfg.verifyBelowConfidence).toBe(90)
    expect(cfg.warnings.join(' ')).toMatch(/verify_below_confidence/)
  })

  it('removals are disclosed in the always-run phase, not only in the PR comment', () => {
    expect(phase4).toContain('Disclose removals')
    expect(phase4).toContain('Filtered by finding-verifier')
    expect(phase4).toMatch(/Roster capped by max_agents/)
    // Phase 6 may only copy what Phase 4 already rendered
    expect(phase6).toMatch(/cop(y|ies)/i)
  })

  it('a forced agent survives max_agents, and truncation always warns', () => {
    const cfg = parseRosterConfig('review:\n  roster:\n    max_agents: 2\n    agents:\n      R-architect: always\n')
    const out = roster({
      delta: ['src/auth/token.ts', 'src/__tests__/a.test.ts'],
      oracleOk: 'false',
      config: cfg,
    })
    expect(out.agents).toContain('R-adversarial')
    expect(out.agents).toContain('R-architect')
    expect(out.capped.length).toBeGreaterThan(0)
    expect(out.warnings.join(' ')).toMatch(/dropped by max_agents/)
  })
})

/**
 * /R-fix Phase 1 parses Conventional Comments from every PR comment body. A dropped
 * finding rendered in `<label>: <desc>` shape would be re-ingested by /R-fix and defeat
 * the keep/drop filter — so the disclosure block stays table-shaped AND /R-fix strips it.
 */
describe('F_dropped disclosure — cross-skill contract with /R-fix', () => {
  const fix = readFileSync(fileURLToPath(new URL('../../fix/SKILL.md', import.meta.url)), 'utf-8')

  it('dev-review renders F_dropped as a table, never as Conventional Comments', () => {
    expect(phase4).toContain('| Dropped | Location | C | Reason |')
  })

  it('fix strips the filtered block before parsing findings', () => {
    expect(fix).toContain('Filtered by finding-verifier')
    expect(fix).toMatch(/strip/i)
  })
})

/**
 * Cutting the panel to adversarial-alone only holds if R-adversarial stops deferring to
 * siblings that are no longer spawned. Every sibling-drop MUST be conditional on the
 * roster, and the dispatch payload MUST carry that roster.
 */
describe('R-adversarial coverage — no drop to unspawned siblings', () => {
  const adversarialMd = readFileSync(
    fileURLToPath(new URL('../../../agents/R-adversarial.md', import.meta.url)),
    'utf-8',
  )

  it('dispatch payload injects the spawned roster', () => {
    expect(text).toContain('Spawned roster (this review): {agents[]}')
  })

  it('R-adversarial gates every sibling drop on roster membership', () => {
    expect(adversarialMd).toContain('Sibling rule — one rule, all siblings')
    expect(adversarialMd).toMatch(/only when that sibling is in the roster/)
    expect(adversarialMd).toMatch(/R-product-lead.*¬in the `\/R-dev-review` roster at all/)
    expect(adversarialMd).not.toMatch(/vacuous-guard angle \(→ R-tester\)/)
  })
})

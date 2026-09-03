import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeRoster, DISPATCHABLE, PHASE_AGENTS, parseRosterConfig } from '../roster'

const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const text = readFileSync(SKILL, 'utf-8')

const section = (from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to))

const dispatch = section('### Agent dispatch', '### Security-auditor scoping')
const phase4 = section('## Phase 4', '## Phase 6')
const phase6 = section('## Phase 6', '## Phase 8')

/** Agent names as documented in the `### Agent dispatch` table, in table order. */
function documentedAgents(): string[] {
  const rows = dispatch.split('\n').filter((l) => l.startsWith('| **'))
  return rows.map((l) => l.match(/^\| \*\*([a-z-]+)\*\*/)?.[1] ?? '')
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
  it('documents exactly the oracle agent set (Lane A + recall)', () => {
    // finding-verifier is documented in Phase 4, not the dispatch table.
    const expected = [...DISPATCHABLE, ...PHASE_AGENTS.filter((a) => a !== 'finding-verifier')]
    expect(documentedAgents()).toEqual(expected)
  })

  it('every documented agent is a gate the oracle actually emits', () => {
    const emitted = new Set(roster().gates.map((g) => g.agent))
    for (const agent of documentedAgents()) expect(emitted).toContain(agent)
  })

  it('adversarial-always: documented "always" holds for the oracle floor', () => {
    expect(dispatch).toMatch(/\| \*\*adversarial\*\* \| \*\*always\*\*/)
    expect(roster().agents).toEqual(['adversarial'])
  })

  it('tester: documented `delta_test_hit ∧ oracle_ok=false` matches the gate', () => {
    expect(dispatch).toContain('`delta_test_hit ∧ oracle_ok=false`')
    const tests = ['src/__tests__/a.test.ts']
    expect(roster({ delta: tests, oracleOk: 'false' }).agents).toContain('tester')
    expect(roster({ delta: tests, oracleOk: 'true' }).agents).not.toContain('tester')
    expect(roster({ delta: tests, oracleOk: 'missing' }).agents).not.toContain('tester')
  })

  it('devops/architect: documented τ=F-full xor on infra matches the gates', () => {
    expect(dispatch).toContain('τ=F-full ∧ Δ ∩ infra = ∅')
    const infra = ['.github/workflows/ci.yml']
    const plain = ['src/app.ts']
    expect(roster({ delta: infra, tier: 'F-full' }).agents).toEqual(['adversarial', 'devops'])
    expect(roster({ delta: plain, tier: 'F-full' }).agents).toEqual(['adversarial', 'architect'])
    // τ≠F-full → neither, whatever the paths
    const lite = roster({ delta: infra }).agents
    expect(lite).not.toContain('devops')
    expect(lite).not.toContain('architect')
  })

  it('security-auditor: documented `path_hit` only — no claim-tag spawn', () => {
    expect(dispatch).toMatch(/\*\*`path_hit`\*\* only/)
    expect(roster({ delta: ['src/oauth/provider.ts'] }).spawn_security_auditor).toBe(true)
    expect(roster({ delta: ['src/app.ts'], claims: ['fail-closed'] }).spawn_security_auditor).toBe(false)
  })

  it('product-lead is absent from both the table and the oracle', () => {
    expect(dispatch).not.toMatch(/product-lead/)
    expect(roster().gates.some((g) => g.agent === 'product-lead')).toBe(false)
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
    expect(text).toMatch(/security-auditor → \*\*`¬spawn_security_auditor`\*\*/)
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
    const cfg = parseRosterConfig('review:\n  roster:\n    max_agents: 2\n    agents:\n      architect: always\n')
    const out = roster({
      delta: ['src/auth/token.ts', 'src/__tests__/a.test.ts'],
      oracleOk: 'false',
      config: cfg,
    })
    expect(out.agents).toContain('adversarial')
    expect(out.agents).toContain('architect')
    expect(out.capped.length).toBeGreaterThan(0)
    expect(out.warnings.join(' ')).toMatch(/dropped by max_agents/)
  })
})

/**
 * /fix Phase 1 parses Conventional Comments from every PR comment body. A dropped
 * finding rendered in `<label>: <desc>` shape would be re-ingested by /fix and defeat
 * the keep/drop filter — so the disclosure block stays table-shaped AND /fix strips it.
 */
describe('F_dropped disclosure — cross-skill contract with /fix', () => {
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
 * Cutting the panel to adversarial-alone only holds if adversarial stops deferring to
 * siblings that are no longer spawned. Every sibling-drop MUST be conditional on the
 * roster, and the dispatch payload MUST carry that roster.
 */
describe('adversarial coverage — no drop to unspawned siblings', () => {
  const adversarial = readFileSync(fileURLToPath(new URL('../../../agents/adversarial.md', import.meta.url)), 'utf-8')

  it('dispatch payload injects the spawned roster', () => {
    expect(text).toContain('Spawned roster (this review): {agents[]}')
  })

  it('adversarial gates every sibling drop on roster membership', () => {
    expect(adversarial).toContain('Sibling rule — one rule, all siblings')
    expect(adversarial).toMatch(/only when that sibling is in the roster/)
    expect(adversarial).toMatch(/product-lead.*¬in the `\/dev-review` roster at all/)
    expect(adversarial).not.toMatch(/vacuous-guard angle \(→ tester\)/)
  })
})

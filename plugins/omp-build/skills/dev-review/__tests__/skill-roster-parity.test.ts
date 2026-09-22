import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeRoster, DISPATCHABLE, PHASE_AGENTS, parseRosterConfig } from '../roster'

/**
 * The dispatch table and the oracle are two spellings of one decision. Nothing
 * else compares them: the table is prose the model reads, the gates are code the
 * shell runs, and a cut that updates one and not the other leaves a panel that
 * documents a role it never spawns — or spawns one it never documents.
 *
 * That is exactly how the five-role cut could have half-landed (#492, #488
 * finding 4), so the pairing is pinned here row by row.
 */
const SKILL = fileURLToPath(new URL('../SKILL.md', import.meta.url))
const text = readFileSync(SKILL, 'utf-8')

const section = (from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to))
const dispatch = section('### Agent dispatch', '### R-security-auditor scoping')

function documentedAgents(): string[] {
  return dispatch
    .split('\n')
    .filter((line) => line.startsWith('| **'))
    .map((line) => line.match(/^\| \*\*(R-[a-z-]+)\*\*/)?.[1] ?? '')
}

function dispatchRow(agent: string): string {
  return dispatch.split('\n').find((line) => line.startsWith(`| **${agent}**`)) ?? ''
}

const roster = (over: Partial<Parameters<typeof computeRoster>[0]> = {}) =>
  computeRoster({
    delta: ['src/app.ts'],
    tier: 'F-lite',
    chunks: 1,
    claims: [],
    pricedClaimOk: true,
    specDraft: false,
    axialAdr: false,
    stackPaths: { frontendPath: '', sharedUi: '', backendPath: '' },
    config: parseRosterConfig(null),
    ...over,
  })

describe('dispatch table ≡ roster oracle', () => {
  it('documents exactly the five durable review roles', () => {
    expect(documentedAgents()).toEqual([...DISPATCHABLE])
    expect(DISPATCHABLE).toHaveLength(5)
    expect(PHASE_AGENTS).toEqual([])
  })

  it('documents the adversarial floor', () => {
    expect(dispatchRow('R-adversarial')).toContain('always')
    expect(roster().agents).toEqual(['R-adversarial'])
  })

  it('documents tier-independent infra routing to R-devops', () => {
    const row = dispatchRow('R-devops')
    expect(row).toContain('infra')
    expect(row).not.toContain('F-full')
    expect(roster({ delta: ['.github/workflows/ci.yml'], tier: 'F-lite' }).agents).toContain('R-devops')
  })

  it('documents axial as an R-architect mode and not a separate role', () => {
    const row = dispatchRow('R-architect')
    expect(row.toLowerCase()).toContain('axial')
    expect(dispatch).not.toContain('R-axial-adr-review')
    const out = roster({ delta: ['adapters/x.ts'], axialAdr: true, tier: 'F-lite' })
    expect(out.agents).toContain('R-architect')
    expect(out.gates.find((gate) => gate.agent === 'R-architect')?.reason).toMatch(/^axial:/)
  })

  it('does not document or implement blanket F-full architect routing', () => {
    expect(dispatchRow('R-architect')).not.toContain('F-full non-infra')
    expect(roster({ delta: ['src/app.ts'], tier: 'F-full' }).agents).toEqual(['R-adversarial'])
  })

  it('documents R-tester on changed-test evidence alone, with no oracle handshake', () => {
    const row = dispatchRow('R-tester')
    expect(row).toContain('delta_test_hit')
    expect(row).not.toContain('oracle')
    const out = roster({ delta: ['src/app.test.ts'] })
    expect(out.agents).toEqual(['R-adversarial', 'R-tester'])
    expect(out.gates.find((gate) => gate.agent === 'R-tester')?.reason).toBe('test-delta')
  })

  it('keeps security path-only routing', () => {
    expect(dispatchRow('R-security-auditor')).toContain('path_hit')
    expect(roster({ delta: ['src/auth/login.ts'] }).agents).toContain('R-security-auditor')
    expect(roster({ delta: ['src/app.ts'], claims: ['fail-closed'] }).agents).not.toContain('R-security-auditor')
  })

  it('documents no cut role as a dispatch row, and implements none', () => {
    for (const cut of ['R-frontend-dev', 'R-backend-dev', 'R-fixer']) {
      expect(dispatchRow(cut), cut).toBe('')
      expect(documentedAgents(), cut).not.toContain(cut)
      expect(
        roster({ delta: ['src/App.tsx', 'apps/api/x.ts'] }).gates.map((g) => g.agent),
        cut,
      ).not.toContain(cut)
    }
  })

  it('says where the cut roles’ concerns land instead of inventing a replacement', () => {
    expect(dispatch).toMatch(/R-frontend-dev[^\n]*cut|cut[^\n]*R-frontend-dev/)
    expect(dispatch).toMatch(/R-adversarial floor|floor through the sibling-drop/)
  })
})

describe('roster wiring and compatibility documentation', () => {
  it('invokes roster.sh and consumes per-chunk output and warnings', () => {
    expect(text).toContain('roster.sh')
    expect(text).toContain('chunk_agents')
    expect(text).toContain('warnings[]')
    expect(text).toContain('review_halt')
  })

  it('presents max_agents=3 as the per-chunk model', () => {
    expect(text).toMatch(/max_agents[^\n]*default[^\n]*3|default[^\n]*3[^\n]*max_agents/i)
    expect(text).toMatch(/per-chunk|par chunk/i)
  })

  it('mentions max_agents_review only as deprecated compatibility', () => {
    expect(text).toMatch(/max_agents_review[^\n]*deprecat|deprecat[^\n]*max_agents_review/i)
  })

  it('keeps always/never overrides and the immutable floor documented', () => {
    expect(text).toContain('always')
    expect(text).toContain('never')
    expect(text).toMatch(/R-adversarial[^\n]*(floor|cannot be disabled)/i)
  })

  it('does not use recall or finding-verifier as dispatch manifests', () => {
    expect(dispatch).not.toContain('R-recall')
    expect(dispatch).not.toContain('R-finding-verifier')
  })
})

describe('OMP wiring — names that must resolve, sources that must not', () => {
  /**
   * The one legal mention of a removed surface: a line that documents it as
   * removed. Same device as `agents/__tests__/roster.test.ts` — "no `oracle_ok`
   * field" is documentation, `--oracle-ok "$OK"` in a fence is a live caller,
   * and a standalone `no` is what tells them apart.
   */
  const STATED_ABSENT = /^.*\bno\b.*$/gm
  const live = text.replace(STATED_ABSENT, '')

  // A prefixed agent name is an `Unknown agent` preflight failure, i.e. a panel
  // that silently does not run (omp://task-agent-discovery.md § Agent lookup).
  it('spawns bare agent names — no plugin prefix anywhere in the body', () => {
    expect(text).not.toContain('dev-core:')
    expect(text).not.toContain('subagent_type')
    expect(text).toMatch(/Agent names are bare/)
    for (const agent of DISPATCHABLE) {
      expect(text, agent).toContain(`\`${agent}\``)
      expect(text, agent).not.toContain(`:${agent}`)
    }
  })

  it('names no cut role as a spawn target', () => {
    for (const cut of ['R-frontend-dev', 'R-backend-dev', 'R-fixer']) {
      expect(live, cut).not.toContain(cut)
      expect(text, cut).not.toContain(`agent: "${cut}"`)
    }
  })

  it('carries no live falsify-oracle surface', () => {
    for (const token of ['--oracle-ok', 'run-falsify', 'oracle_ok', 'artifacts/reviews']) {
      expect(live, token).not.toContain(token)
    }
  })

  // ADR-020 §4: the tracker issue is the spec, and its `size:` label is the only
  // source of τ. Reading frontmatter from a file that no longer exists would make
  // every review F-lite without saying so.
  it('reads τ from the size: label and nothing else', () => {
    expect(text).toContain('size:')
    expect(text).toMatch(/only[^\n]*source of τ|size:[^\n]*label is the \*\*only\*\*/i)
    expect(live).not.toContain('artifacts/specs')
    expect(live).not.toMatch(/status:\s*validated/)
    expect(text).toMatch(/defaults to F-lite|τ := `?F-lite/)
  })

  it('resolves bundled assets through skill:// and never a plugin-root token', () => {
    expect(text).toContain('skill://dev-review/roster.sh')
    expect(text).toContain('skill://dev-review/review-classes.yml')
    expect(text).not.toContain('CLAUDE_PLUGIN_ROOT')
    expect(text).not.toContain('CLAUDE_SKILL_DIR')
  })
})

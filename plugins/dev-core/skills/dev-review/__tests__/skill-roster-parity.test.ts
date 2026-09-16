import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { computeRoster, DISPATCHABLE, PHASE_AGENTS, parseRosterConfig } from '../roster'

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
    oracleOk: 'missing',
    claims: [],
    pricedClaimOk: true,
    specDraft: false,
    axialAdr: false,
    stackPaths: { frontendPath: '', sharedUi: '', backendPath: '' },
    config: parseRosterConfig(null),
    ...over,
  })

describe('dispatch table ≡ roster oracle', () => {
  it('documents exactly the seven durable review roles', () => {
    expect(documentedAgents()).toEqual([...DISPATCHABLE])
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

  it('keeps frontend/backend gates tied to configured domain paths', () => {
    const paths = { frontendPath: 'apps/web', sharedUi: '', backendPath: 'apps/api' }
    expect(roster({ delta: ['apps/web/App.tsx'], stackPaths: paths }).agents).toContain('R-frontend-dev')
    expect(roster({ delta: ['apps/api/user.ts'], stackPaths: paths }).agents).toContain('R-backend-dev')
  })

  it('keeps tester behind oracle-false and after the dominant domain', () => {
    expect(dispatchRow('R-tester')).toContain('oracle')
    const out = roster({
      delta: ['apps/web/a.tsx', 'apps/web/b.tsx', 'apps/api/a.ts', 'tests/a.test.ts'],
      oracleOk: 'false',
      stackPaths: { frontendPath: 'apps/web', sharedUi: '', backendPath: 'apps/api' },
    })
    expect(out.agents).toEqual(['R-adversarial', 'R-frontend-dev', 'R-tester'])
  })

  it('keeps security path-only routing', () => {
    expect(dispatchRow('R-security-auditor')).toContain('path_hit')
    expect(roster({ delta: ['src/auth/login.ts'] }).agents).toContain('R-security-auditor')
    expect(roster({ delta: ['src/app.ts'], claims: ['fail-closed'] }).agents).not.toContain('R-security-auditor')
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

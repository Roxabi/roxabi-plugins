import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { dir, ROSTER, useRosterWorkspace } from './roster.fixture'

useRosterWorkspace()

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

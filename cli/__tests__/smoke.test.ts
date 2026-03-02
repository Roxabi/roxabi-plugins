import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'bun'
import { resolve } from 'node:path'

// Resolve repo root from this test file's location: cli/__tests__/ → ../../ → repo root
const REPO_ROOT = resolve(import.meta.dir, '../..')

describe('roxabi CLI smoke', () => {
  it('prints usage with no args', () => {
    const r = spawnSync(['bun', 'run', 'cli/index.ts'], { cwd: REPO_ROOT, stdout: 'pipe', stderr: 'pipe' })
    const out = new TextDecoder().decode(r.stdout)
    expect(out).toContain('workspace')
    expect(out).toContain('issues')
  })

  it('dashboard --help prints usage without hanging', () => {
    const r = spawnSync(['bun', 'run', 'cli/index.ts', 'dashboard', '--help'], {
      cwd: REPO_ROOT,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(r.stdout)
    expect(out).toContain('--port')
    expect(out).toContain('--poll')
    expect(r.exitCode).toBe(0)
  })
})

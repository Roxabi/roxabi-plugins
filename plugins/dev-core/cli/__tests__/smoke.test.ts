import { describe, expect, it } from 'bun:test'
import { resolve } from 'node:path'
import { spawnSync } from 'bun'

const CLI = resolve(import.meta.dir, '../index.ts')

describe('roxabi CLI smoke', () => {
  it('prints usage with no args', () => {
    const r = spawnSync(['bun', CLI], { stdout: 'pipe', stderr: 'pipe' })
    const out = new TextDecoder().decode(r.stdout)
    expect(out).toContain('workspace')
    expect(out).toContain('issues')
  })

  it('dashboard --help prints usage without hanging', () => {
    const r = spawnSync(['bun', CLI, 'dashboard', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const out = new TextDecoder().decode(r.stdout)
    expect(out).toContain('--port')
    expect(out).toContain('--poll')
    expect(r.exitCode).toBe(0)
  })
})

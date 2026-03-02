import { describe, it, expect } from 'bun:test'
import { spawnSync } from 'bun'
describe('roxabi CLI smoke', () => {
  it('prints usage with no args', () => {
    const r = spawnSync(['bun', 'run', 'cli/index.ts'], { cwd: '/home/mickael/projects/roxabi-2', stdout: 'pipe', stderr: 'pipe' })
    // This will fail until cli/index.ts exists — that is expected (RED)
    const out = new TextDecoder().decode(r.stdout)
    expect(out).toContain('workspace')
    expect(out).toContain('issues')
  })
})

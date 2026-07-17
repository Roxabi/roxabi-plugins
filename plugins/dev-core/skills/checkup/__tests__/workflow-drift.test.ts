import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateCiYml } from '../../../../dev-init/skills/init/lib/workflows'
import { checkWorkflowDrift } from '../workflow-drift'

describe('checkWorkflowDrift', () => {
  let tmpDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-drift-'))
    process.chdir(tmpDir)
    fs.mkdirSync('.claude', { recursive: true })
    fs.mkdirSync('.github/workflows', { recursive: true })
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when ci.yml matches generator output for stack.yml', async () => {
    fs.writeFileSync(
      '.claude/stack.yml',
      `runtime: bun
commands:
  lint: bun lint
  typecheck: bun typecheck
deploy:
  platform: none
`,
    )
    fs.writeFileSync(
      '.github/workflows/ci.yml',
      generateCiYml({ stack: 'bun', test: 'none', deploy: 'none', lint: true, typecheck: true }),
    )

    const checks = await checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('pass')
    expect(ci?.detail).toContain('matches generator')
  })

  it('warns when on-disk ci.yml differs from generator', async () => {
    fs.writeFileSync('.claude/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')
    fs.writeFileSync('.github/workflows/ci.yml', 'name: CI\non: push\njobs: {}\n')

    const checks = await checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('warn')
  })

  it('skips drift check when workflow file is absent', async () => {
    fs.writeFileSync('.claude/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')

    const checks = await checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('skip')
  })

  it('degrades to skip when dev-init is not installed', async () => {
    const prevRoot = process.env.CLAUDE_PLUGIN_ROOT
    const prevHome = process.env.HOME
    // Both resolution paths must miss: plugin root (flat siblings + derived cache) and the ~/.claude fallback.
    process.env.CLAUDE_PLUGIN_ROOT = path.join(tmpDir, 'plugins', 'dev-core')
    process.env.HOME = tmpDir
    try {
      fs.writeFileSync('.claude/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')

      const checks = await checkWorkflowDrift()
      expect(checks).toHaveLength(1)
      expect(checks[0].status).toBe('skip')
      expect(checks[0].detail).toContain('dev-init')
    } finally {
      if (prevRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT
      else process.env.CLAUDE_PLUGIN_ROOT = prevRoot
      if (prevHome === undefined) delete process.env.HOME
      else process.env.HOME = prevHome
    }
  })
})

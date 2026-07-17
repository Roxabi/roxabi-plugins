import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateCiYml } from '../../shared/workflows/workflows'
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

  it('passes when ci.yml matches generator output for stack.yml', () => {
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

    const checks = checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('pass')
    expect(ci?.detail).toContain('matches generator')
  })

  it('warns when on-disk ci.yml differs from generator', () => {
    fs.writeFileSync('.claude/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')
    fs.writeFileSync('.github/workflows/ci.yml', 'name: CI\non: push\njobs: {}\n')

    const checks = checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('warn')
  })

  it('skips drift check when workflow file is absent', () => {
    fs.writeFileSync('.claude/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')

    const checks = checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('skip')
  })
})

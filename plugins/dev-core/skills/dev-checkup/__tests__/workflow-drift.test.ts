import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateCiYml } from '../../shared/workflows/workflow-generators'
import { checkWorkflowDrift } from '../workflow-drift'

describe('checkWorkflowDrift', () => {
  let tmpDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-drift-'))
    process.chdir(tmpDir)
    fs.mkdirSync('.dev', { recursive: true })
    fs.mkdirSync('.github/workflows', { recursive: true })
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when ci.yml matches generator output for stack.yml', () => {
    fs.writeFileSync(
      '.dev/stack.yml',
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
    fs.writeFileSync('.dev/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')
    fs.writeFileSync('.github/workflows/ci.yml', 'name: CI\non: push\njobs: {}\n')

    const checks = checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('warn')
  })

  it('skips drift check when workflow file is absent', () => {
    fs.writeFileSync('.dev/stack.yml', 'runtime: bun\ndeploy:\n  platform: none\n')

    const checks = checkWorkflowDrift()
    const ci = checks.find((c) => c.name === 'drift:ci.yml')
    expect(ci?.status).toBe('skip')
  })

  // ── Trunk-mode double-writer guards (#371 N10/N11) — hard fails, not warns ──

  const TRUNK_STACK = 'runtime: bun\nrelease:\n  model: trunk\n  component: roxabi-plugins\n'

  describe('release-model guards — N10 release-please collision', () => {
    it('FAILS when model==trunk and release-please.yml is present (two release writers)', () => {
      fs.writeFileSync('.dev/stack.yml', TRUNK_STACK)
      fs.writeFileSync('.github/workflows/release-please.yml', 'name: release-please\non: push\njobs: {}\n')
      const c = checkWorkflowDrift().find((x) => x.name === 'release-model:release-please-collision')
      expect(c?.status).toBe('fail')
    })

    it('does not fire on trunk when release-please.yml is absent', () => {
      fs.writeFileSync('.dev/stack.yml', TRUNK_STACK)
      expect(checkWorkflowDrift().find((x) => x.name === 'release-model:release-please-collision')).toBeUndefined()
    })

    it('is inert on staging-train even with release-please.yml present', () => {
      fs.writeFileSync('.dev/stack.yml', 'runtime: bun\n') // no release block → staging-train
      fs.writeFileSync('.github/workflows/release-please.yml', 'name: release-please\non: push\njobs: {}\n')
      expect(checkWorkflowDrift().find((x) => x.name === 'release-model:release-please-collision')).toBeUndefined()
    })
  })
})

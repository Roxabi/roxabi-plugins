import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateAutoReleaseYml, generateCiYml } from '../../shared/workflows/workflow-generators'
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

  // ── Trunk-mode double-writer guards (#371 N10/N11) — hard fails, not warns ──

  const TRUNK_STACK = 'runtime: bun\nrelease:\n  model: trunk\n  component: roxabi-plugins\n'

  describe('release-model guards — N10 release-please collision', () => {
    it('FAILS when model==trunk and release-please.yml is present (two release writers)', () => {
      fs.writeFileSync('.claude/stack.yml', TRUNK_STACK)
      fs.writeFileSync('.github/workflows/release-please.yml', 'name: release-please\non: push\njobs: {}\n')
      const c = checkWorkflowDrift().find((x) => x.name === 'release-model:release-please-collision')
      expect(c?.status).toBe('fail')
    })

    it('does not fire on trunk when release-please.yml is absent', () => {
      fs.writeFileSync('.claude/stack.yml', TRUNK_STACK)
      expect(checkWorkflowDrift().find((x) => x.name === 'release-model:release-please-collision')).toBeUndefined()
    })

    it('is inert on staging-train even with release-please.yml present', () => {
      fs.writeFileSync('.claude/stack.yml', 'runtime: bun\n') // no release block → staging-train
      fs.writeFileSync('.github/workflows/release-please.yml', 'name: release-please\non: push\njobs: {}\n')
      expect(checkWorkflowDrift().find((x) => x.name === 'release-model:release-please-collision')).toBeUndefined()
    })
  })

  describe('release-model guards — N11 auto-release missing/drifted', () => {
    it('FAILS when model==trunk and auto-release.yml is absent', () => {
      fs.writeFileSync('.claude/stack.yml', TRUNK_STACK)
      const c = checkWorkflowDrift().find((x) => x.name === 'release-model:auto-release')
      expect(c?.status).toBe('fail')
    })

    it('FAILS (not warns) when auto-release.yml is present but drifted from the generator', () => {
      fs.writeFileSync('.claude/stack.yml', TRUNK_STACK)
      fs.writeFileSync('.github/workflows/auto-release.yml', 'name: Auto Release\non: push\njobs: {}\n')
      const c = checkWorkflowDrift().find((x) => x.name === 'release-model:auto-release')
      expect(c?.status).toBe('fail')
    })

    it('passes when the committed auto-release.yml matches the generator', () => {
      fs.writeFileSync('.claude/stack.yml', TRUNK_STACK)
      fs.writeFileSync(
        '.github/workflows/auto-release.yml',
        generateAutoReleaseYml({
          stack: 'bun',
          test: 'none',
          deploy: 'none',
          release: { model: 'trunk', component: 'roxabi-plugins' },
        }),
      )
      const c = checkWorkflowDrift().find((x) => x.name === 'release-model:auto-release')
      expect(c?.status).toBe('pass')
    })

    it('does not run the auto-release check on staging-train', () => {
      fs.writeFileSync('.claude/stack.yml', 'runtime: bun\n')
      expect(checkWorkflowDrift().find((x) => x.name === 'release-model:auto-release')).toBeUndefined()
    })
  })
})

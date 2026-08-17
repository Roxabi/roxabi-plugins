import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { generateCiYml } from '../../shared/workflows/workflow-generators'
import { checkLandingPath } from '../doctor-local'

describe('checkLandingPath', () => {
  let tmpDir: string
  let prevCwd: string

  beforeEach(() => {
    prevCwd = process.cwd()
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'landing-path-'))
    process.chdir(tmpDir)
    fs.mkdirSync('.github/workflows', { recursive: true })
  })

  afterEach(() => {
    process.chdir(prevCwd)
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('passes when ci.yml has a classify job on push', () => {
    fs.writeFileSync('.github/workflows/ci.yml', generateCiYml({ stack: 'bun', test: 'vitest', deploy: 'none' }))
    const { checks } = checkLandingPath()
    const ci = checks.find((c) => c.name === 'landing:ci.yml')
    expect(ci?.status).toBe('pass')
  })

  it('warns when ci.yml pushes without classify', () => {
    fs.writeFileSync('.github/workflows/ci.yml', 'name: CI\non:\n  push:\n    branches: [main]\njobs:\n  ci: {}\n')
    const { checks } = checkLandingPath()
    const ci = checks.find((c) => c.name === 'landing:ci.yml')
    expect(ci?.status).toBe('warn')
    expect(ci?.detail).toContain('without classify')
  })

  it('skips absent workflows', () => {
    const { checks } = checkLandingPath()
    expect(checks.every((c) => c.status === 'skip')).toBe(true)
  })
})

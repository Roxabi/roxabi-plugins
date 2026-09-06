import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readStackYml } from '../doctor-shared'

/**
 * Doctor tests run the script as a subprocess in a controlled tmp directory.
 * We create fake executables (gh, git) to control checkPrereqs output.
 * This is the Bun-compatible approach since vi.resetModules() is not available in Bun 1.3.9.
 */

// Resolve bun's actual binary path so subprocess env can find it
const bunBin = Bun.spawnSync(['which', 'bun'], { stdout: 'pipe' })
const bunBinPath = new TextDecoder().decode(bunBin.stdout).trim()
const bunBinDir = path.dirname(bunBinPath)

function makeFakeExec(tmpDir: string, name: string, script: string) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return p
}

function runDoctor(tmpDir: string, args: string[] = []) {
  const doctorPath = path.resolve(__dirname, '../doctor.ts')
  const proc = Bun.spawnSync([bunBinPath, 'run', doctorPath, ...args], {
    cwd: tmpDir,
    env: {
      HOME: os.homedir(),
      PATH: `${tmpDir}:${bunBinDir}:${process.env.PATH ?? ''}`,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    stdout: new TextDecoder().decode(proc.stdout),
    stderr: new TextDecoder().decode(proc.stderr),
    exitCode: proc.exitCode,
  }
}

describe('doctor', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-test-'))

    // Create fake gh — simulates a properly authenticated gh CLI
    makeFakeExec(
      tmpDir,
      'gh',
      [
        'case "$*" in',
        '  "--version") echo "gh version 2.40.0"; exit 0 ;;',
        '  "auth status") exit 0 ;;',
        '  "auth token") echo "ghp_test"; exit 0 ;;',
        '  "project list"*) echo \'{"projects":[{"id":"PVT_123"}]}\'; exit 0 ;;',
        '  "label list"*) echo \'[]\'; exit 0 ;;',
        '  "api"*) echo \'{"data":{"node":{"workflows":{"nodes":[]}}}}\'; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )

    // Create fake git — returns a known remote URL
    makeFakeExec(
      tmpDir,
      'git',
      ['if [ "$1" = "remote" ]; then echo "git@github.com:TestOrg/test-repo.git"; exit 0; fi', 'exit 0'].join('\n'),
    )

    // Create .env with GH_PROJECT_ID
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'GITHUB_REPO=TestOrg/test-repo\nGH_PROJECT_ID=PVT_123\nSTATUS_FIELD_ID=F1\nSIZE_FIELD_ID=F2\nPRIORITY_FIELD_ID=F3\n',
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GitHub section emits GITHUB_REPO check', () => {
    // Arrange + Act
    const result = runDoctor(tmpDir)

    // Assert: output contains the GITHUB_REPO check name
    expect(result.stdout).toContain('GITHUB_REPO')
    // Assert: ProjectV2 board checks are gone
    expect(result.stdout).not.toContain('GH_PROJECT_ID')
    // Assert: clean exit (or exit 1 due to missing artifacts — both are fine)
    expect([0, 1]).toContain(result.exitCode)
  })

  it('outputs JSON when --json flag is passed', () => {
    // Arrange + Act
    const result = runDoctor(tmpDir, ['--json'])

    // Assert: stdout is valid JSON array
    expect(result.stdout.trim()).toBeTruthy()
    const parsed = JSON.parse(result.stdout) as unknown[]
    expect(Array.isArray(parsed)).toBe(true)
    // Assert: JSON contains a GitHub section
    const githubSection = (parsed as Array<{ name: string }>).find((s) => s.name === 'GitHub')
    expect(githubSection).toBeDefined()
  })

  it('skips GitHub checks when gh not available', () => {
    // Arrange: replace gh with a failing stub so checkPrereqs reports gh not installed
    makeFakeExec(tmpDir, 'gh', 'exit 127')

    // Act
    const result = runDoctor(tmpDir)

    // Assert: GITHUB_REPO still appears in output (as a skipped check)
    expect(result.stdout).toContain('GITHUB_REPO')
    // Assert: the ⏭ skip icon appears in the GitHub section (gh not available skips all checks)
    expect(result.stdout).toContain('⏭')
  })

  describe('CI permissions', () => {
    function writeWorkflow(dir: string, content: string) {
      const wfDir = path.join(dir, '.github', 'workflows')
      fs.mkdirSync(wfDir, { recursive: true })
      fs.writeFileSync(path.join(wfDir, 'ci.yml'), content)
    }

    it('warns when a job has job-level permissions without contents: read and uses actions/checkout', () => {
      // Arrange
      writeWorkflow(
        tmpDir,
        [
          'name: CI',
          'on: [push]',
          'jobs:',
          '  merge-reports:',
          '    runs-on: ubuntu-latest',
          '    permissions:',
          '      actions: read',
          '    steps:',
          '      - uses: actions/checkout@v4',
        ].join('\n'),
      )

      // Act
      const result = runDoctor(tmpDir)

      // Assert
      expect(result.stdout).toContain('CI permissions')
      expect(result.stdout).toContain('merge-reports')
      expect(result.stdout).toContain('contents: read')
    })

    it('passes when a job with job-level permissions includes contents: read', () => {
      // Arrange
      writeWorkflow(
        tmpDir,
        [
          'name: CI',
          'on: [push]',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    permissions:',
          '      contents: read',
          '      actions: read',
          '    steps:',
          '      - uses: actions/checkout@v4',
        ].join('\n'),
      )

      // Act
      const result = runDoctor(tmpDir)

      // Assert
      expect(result.stdout).toContain('CI permissions')
      expect(result.stdout).toContain('no missing contents: read')
    })

    it('passes when a job uses permissions: read-all shorthand', () => {
      // Arrange
      writeWorkflow(
        tmpDir,
        [
          'name: CI',
          'on: [push]',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    permissions: read-all',
          '    steps:',
          '      - uses: actions/checkout@v4',
        ].join('\n'),
      )

      // Act
      const result = runDoctor(tmpDir)

      // Assert
      expect(result.stdout).toContain('CI permissions')
      expect(result.stdout).toContain('no missing contents: read')
    })

    it('passes when a job has no job-level permissions block (inherits top-level)', () => {
      // Arrange: top-level permissions only — job inherits, no override
      writeWorkflow(
        tmpDir,
        [
          'name: CI',
          'on: [push]',
          'permissions:',
          '  contents: read',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
        ].join('\n'),
      )

      // Act
      const result = runDoctor(tmpDir)

      // Assert
      expect(result.stdout).toContain('CI permissions')
      expect(result.stdout).toContain('no missing contents: read')
    })

    it('skips CI permissions check when no workflow files exist', () => {
      // Arrange: no .github/workflows directory in tmpDir by default

      // Act
      const result = runDoctor(tmpDir)

      // Assert
      expect(result.stdout).toContain('CI permissions')
      expect(result.stdout).toContain('no local workflow files found')
    })
  })

  describe('legacy contract layout', () => {
    function projectChecks(dir: string) {
      const sections = JSON.parse(runDoctor(dir, ['--json']).stdout) as Array<{
        name: string
        checks: Array<{ name: string; status: string; detail: string }>
      }>
      return sections.find((s) => s.name === 'Project')?.checks ?? []
    }

    it('warns with the git mv migration when the contract still sits in .claude/', () => {
      // Arrange: un-migrated repo — contract in .claude/, no .dev/ counterpart
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, '.claude', 'stack.yml'), 'runtime: bun\n')
      fs.writeFileSync(path.join(tmpDir, '.claude', 'dev-core.yml'), 'github_repo: TestOrg/test-repo\n')

      // Act
      const layout = projectChecks(tmpDir).find((c) => c.name === 'contract layout')

      // Assert: warn naming the migration for both orphaned files
      expect(layout?.status).toBe('warn')
      expect(layout?.detail).toContain('git mv .claude/stack.yml .dev/')
      expect(layout?.detail).toContain('git mv .claude/dev-core.yml .dev/')
    })

    it('stays silent when the contract lives in .dev/, even with a .claude/ leftover', () => {
      // Arrange: migrated repo that kept a non-contract leftover behind
      fs.mkdirSync(path.join(tmpDir, '.dev'), { recursive: true })
      fs.mkdirSync(path.join(tmpDir, '.claude'), { recursive: true })
      fs.writeFileSync(path.join(tmpDir, '.dev', 'stack.yml'), 'runtime: bun\n')
      fs.writeFileSync(path.join(tmpDir, '.claude', 'stack.yml'), 'runtime: bun\n')

      // Act + Assert
      expect(projectChecks(tmpDir).map((c) => c.name)).not.toContain('contract layout')
    })

    it('stays silent when no contract exists at either location', () => {
      // Arrange: bare repo (tmpDir has neither .dev/ nor .claude/)

      // Act + Assert
      expect(projectChecks(tmpDir).map((c) => c.name)).not.toContain('contract layout')
    })
  })
})

describe('readStackYml — release passthrough (Model B / #371)', () => {
  let origCwd: string
  let tmp: string

  beforeEach(() => {
    origCwd = process.cwd()
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stackinfo-release-'))
    fs.mkdirSync(path.join(tmp, '.dev'), { recursive: true })
    process.chdir(tmp)
  })

  afterEach(() => {
    process.chdir(origCwd)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('surfaces release {model, component} from .dev/stack.yml', () => {
    fs.writeFileSync('.dev/stack.yml', 'release:\n  model: trunk\n  component: roxabi-plugins\n')
    expect(readStackYml().release).toEqual({ model: 'trunk', component: 'roxabi-plugins' })
  })

  it('release is null when the stack has no release: block', () => {
    fs.writeFileSync('.dev/stack.yml', 'runtime: bun\n')
    expect(readStackYml().release).toBeNull()
  })

  it('defaults an absent model to staging-train when a release: block exists', () => {
    fs.writeFileSync('.dev/stack.yml', 'release:\n  component: foo\n')
    expect(readStackYml().release).toEqual({ model: 'staging-train', component: 'foo' })
  })
})

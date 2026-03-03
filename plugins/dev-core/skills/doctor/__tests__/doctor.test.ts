import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

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
    makeFakeExec(tmpDir, 'gh', [
      'case "$*" in',
      '  "--version") echo "gh version 2.40.0"; exit 0 ;;',
      '  "auth status") exit 0 ;;',
      '  "auth token") echo "ghp_test"; exit 0 ;;',
      '  "project list"*) echo \'{"projects":[{"id":"PVT_123"}]}\'; exit 0 ;;',
      '  "label list"*) echo \'[]\'; exit 0 ;;',
      '  "api"*) echo \'{"data":{"node":{"workflows":{"nodes":[]}}}}\'; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'))

    // Create fake git — returns a known remote URL
    makeFakeExec(tmpDir, 'git', [
      'if [ "$1" = "remote" ]; then echo "git@github.com:TestOrg/test-repo.git"; exit 0; fi',
      'exit 0',
    ].join('\n'))

    // Create .env with GH_PROJECT_ID
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'GITHUB_REPO=TestOrg/test-repo\nGH_PROJECT_ID=PVT_123\nSTATUS_FIELD_ID=F1\nSIZE_FIELD_ID=F2\nPRIORITY_FIELD_ID=F3\n',
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('GH_PROJECT_ID check present in GitHub section output', () => {
    // Arrange + Act
    const result = runDoctor(tmpDir)

    // Assert: output contains the GH_PROJECT_ID check name
    expect(result.stdout).toContain('GH_PROJECT_ID')
    // Assert: old PROJECT_ID check name is not present
    expect(result.stdout).not.toMatch(/^\s*PROJECT_ID\s/m)
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

    // Assert: GH_PROJECT_ID still appears in output (as a skipped check)
    expect(result.stdout).toContain('GH_PROJECT_ID')
    // Assert: the ⏭ skip icon appears in the GitHub section (gh not available skips all checks)
    expect(result.stdout).toContain('⏭')
  })
})

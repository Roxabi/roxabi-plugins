import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Branch protection trufflehog context drift tests.
 * Uses the subprocess + fake-gh approach from doctor.test.ts:
 * we put a shell script named `gh` on PATH that returns controlled JSON per API call.
 */

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

/** Write a minimal fake gh that handles auth, token, project list, label list, graphql,
 *  and delegates branch-protection calls to a caller-supplied case block. */
function makeFakeGh(tmpDir: string, branchProtectionCases: string) {
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
      '  "repo view"*) echo "false"; exit 0 ;;',
      '  "api graphql"*) echo \'{"data":{"node":{"workflows":{"nodes":[]}}}}\'; exit 0 ;;',
      // Catch-all for rulesets, workflows listing, secrets, etc.
      '  "api"*"/rulesets"*) echo ""; exit 0 ;;',
      '  "api"*"/contents/.github/workflows"*"secret-scan.yml"*)',
      branchProtectionCases,
      '  "api"*) echo ""; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  )
}

describe('branch protection trufflehog context check', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bp-context-test-'))

    // Fake git — returns a known remote URL
    makeFakeExec(
      tmpDir,
      'git',
      [
        'if [ "$1" = "remote" ]; then echo "git@github.com:TestOrg/test-repo.git"; exit 0; fi',
        'exit 0',
      ].join('\n'),
    )

    // Write .env with required config
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'GITHUB_REPO=TestOrg/test-repo\nGH_PROJECT_ID=PVT_123\nSTATUS_FIELD_ID=F1\nSIZE_FIELD_ID=F2\nPRIORITY_FIELD_ID=F3\n',
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('warns when secret-scan.yml probe is ok and trufflehog missing from required contexts', () => {
    // Arrange: secret-scan.yml present (exit 0), branches exist, protection ok,
    // but required contexts only contain "ci" — no "trufflehog"
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
        '  "repo view"*) echo "false"; exit 0 ;;',
        '  "api graphql"*) echo \'{"data":{"node":{"workflows":{"nodes":[]}}}}\'; exit 0 ;;',
        '  "api"*"/rulesets"*) echo ""; exit 0 ;;',
        // secret-scan.yml probe — present
        '  "api"*"secret-scan.yml") echo \'{"name":"secret-scan.yml"}\'; exit 0 ;;',
        // branch existence checks
        '  "api"*"/branches/main") echo \'{"name":"main"}\'; exit 0 ;;',
        '  "api"*"/branches/staging") exit 1 ;;',
        // branch protection (plain call — no --jq)
        '  "api"*"/branches/main/protection") echo \'{"required_status_checks":{"contexts":["ci"]}}\'; exit 0 ;;',
        // contexts query (--jq flag present)
        '  "api"*"/branches/main/protection"*"--jq"*) echo \'["ci"]\'; exit 0 ;;',
        '  "api"*) echo ""; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )

    // Act
    const result = runDoctor(tmpDir)

    // Assert: warn emitted for trufflehog context drift on main
    expect(result.stdout).toContain('main:trufflehog-context')
    expect(result.stdout).toContain('trufflehog missing from required checks')
    expect([0, 1]).toContain(result.exitCode)
  })

  it('does not warn when secret-scan.yml probe is ok and trufflehog is in required contexts', () => {
    // Arrange: secret-scan.yml present, contexts include "trufflehog"
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
        '  "repo view"*) echo "false"; exit 0 ;;',
        '  "api graphql"*) echo \'{"data":{"node":{"workflows":{"nodes":[]}}}}\'; exit 0 ;;',
        '  "api"*"/rulesets"*) echo ""; exit 0 ;;',
        // secret-scan.yml probe — present
        '  "api"*"secret-scan.yml") echo \'{"name":"secret-scan.yml"}\'; exit 0 ;;',
        // branch existence checks
        '  "api"*"/branches/main") echo \'{"name":"main"}\'; exit 0 ;;',
        '  "api"*"/branches/staging") exit 1 ;;',
        // branch protection (plain call)
        '  "api"*"/branches/main/protection") echo \'{"required_status_checks":{"contexts":["ci","trufflehog"]}}\'; exit 0 ;;',
        // contexts query (--jq flag)
        '  "api"*"/branches/main/protection"*"--jq"*) echo \'["ci","trufflehog"]\'; exit 0 ;;',
        '  "api"*) echo ""; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )

    // Act
    const result = runDoctor(tmpDir)

    // Assert: no trufflehog-context warn for main
    expect(result.stdout).not.toContain('main:trufflehog-context')
    expect([0, 1]).toContain(result.exitCode)
  })

  it('does not emit trufflehog-context check when secret-scan.yml probe returns not-ok', () => {
    // Arrange: secret-scan.yml absent (exit 1) — drift check must be skipped entirely
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
        '  "repo view"*) echo "false"; exit 0 ;;',
        '  "api graphql"*) echo \'{"data":{"node":{"workflows":{"nodes":[]}}}}\'; exit 0 ;;',
        '  "api"*"/rulesets"*) echo ""; exit 0 ;;',
        // secret-scan.yml probe — absent
        '  "api"*"secret-scan.yml") exit 1 ;;',
        // branch existence checks
        '  "api"*"/branches/main") echo \'{"name":"main"}\'; exit 0 ;;',
        '  "api"*"/branches/staging") exit 1 ;;',
        // branch protection (plain call)
        '  "api"*"/branches/main/protection") echo \'{"required_status_checks":{"contexts":[]}}\'; exit 0 ;;',
        '  "api"*) echo ""; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )

    // Act
    const result = runDoctor(tmpDir)

    // Assert: no trufflehog-context check emitted at all
    expect(result.stdout).not.toContain('trufflehog-context')
    expect([0, 1]).toContain(result.exitCode)
  })
})

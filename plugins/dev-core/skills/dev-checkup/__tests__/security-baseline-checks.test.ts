import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

/**
 * Security-baseline checks integration tests.
 * Same subprocess + fake-gh approach as branch-protection-context.test.ts:
 * a shell script named `gh` on PATH returns controlled JSON per API call,
 * the doctor runs end-to-end, assertions read the formatted output.
 */

const bunBin = Bun.spawnSync(['which', 'bun'], { stdout: 'pipe' })
const bunBinPath = new TextDecoder().decode(bunBin.stdout).trim()
const bunBinDir = path.dirname(bunBinPath)

function makeFakeExec(tmpDir: string, name: string, script: string) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
  return p
}

function runDoctor(tmpDir: string) {
  const doctorPath = path.resolve(__dirname, '../doctor.ts')
  const proc = Bun.spawnSync([bunBinPath, 'run', doctorPath], {
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

function fakeGh(
  tmpDir: string,
  opts: { meta: string; rulesets?: string; rulesetDetail?: string; actionsPerms?: string },
) {
  makeFakeExec(
    tmpDir,
    'gh',
    [
      'case "$*" in',
      '  "--version") echo "gh version 2.40.0"; exit 0 ;;',
      '  "auth status") exit 0 ;;',
      '  "auth token") echo "ghp_test"; exit 0 ;;',
      `  "api repos/TestOrg/test-repo/rulesets") echo '${opts.rulesets ?? '[]'}'; exit 0 ;;`,
      `  "api repos/TestOrg/test-repo/rulesets/42") echo '${opts.rulesetDetail ?? '{}'}'; exit 0 ;;`,
      `  "api repos/TestOrg/test-repo/actions/permissions/workflow") echo '${opts.actionsPerms ?? '{}'}'; exit 0 ;;`,
      `  "api repos/TestOrg/test-repo") echo '${opts.meta}'; exit 0 ;;`,
      '  "api"*"/branches/"*) exit 1 ;;',
      '  "api"*) echo ""; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  )
}

describe('security baseline checks (doctor integration)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-baseline-test-'))
    makeFakeExec(
      tmpDir,
      'git',
      ['if [ "$1" = "remote" ]; then echo "git@github.com:TestOrg/test-repo.git"; exit 0; fi', 'exit 0'].join('\n'),
    )
    fs.writeFileSync(path.join(tmpDir, '.env'), 'GITHUB_REPO=TestOrg/test-repo\n')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('flags every misconfiguration: scanning off, wrong ruleset target, write token, pr-head checkout, no trufflehog', () => {
    fakeGh(tmpDir, {
      meta: '{"visibility":"public","default_branch":"staging","security_and_analysis":{"secret_scanning":{"status":"disabled"},"secret_scanning_push_protection":{"status":"disabled"}}}',
      rulesets: '[{"id":42,"name":"PR_Main"}]',
      rulesetDetail:
        '{"rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["squash"]}}],"conditions":{"ref_name":{"include":["refs/heads/main"]}}}',
      actionsPerms: '{"default_workflow_permissions":"write","can_approve_pull_request_reviews":true}',
    })
    fs.writeFileSync(path.join(tmpDir, '.pre-commit-config.yaml'), 'repos: []\n')
    fs.mkdirSync(path.join(tmpDir, '.github/workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.github/workflows/auto-merge.yml'),
      [
        'on:',
        '  pull_request_target:',
        'jobs:',
        '  merge:',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '        with:',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression syntax — intentionally a plain string
        '          ref: ${{ github.event.pull_request.head.sha }}',
      ].join('\n'),
    )

    const result = runDoctor(tmpDir)

    expect(result.stdout).toContain('disabled — free for public repos')
    expect(result.stdout).toContain('push protection')
    expect(result.stdout).toContain('default branch is staging')
    expect(result.stdout).toContain('merge commit not in allowed_merge_methods')
    expect(result.stdout).toContain('write token')
    expect(result.stdout).toContain('can approve PRs')
    expect(result.stdout).toContain('not found in .pre-commit-config.yaml')
    expect(result.stdout).toContain('no CI workflow runs trufflehog/gitleaks')
    expect(result.stdout).toContain('checks out or fetches PR-head code')
    expect(result.exitCode).toBe(1)
  })

  it('passes a fully hardened repo: scanning on, ~DEFAULT_BRANCH ruleset, read token, trufflehog everywhere', () => {
    fakeGh(tmpDir, {
      meta: '{"visibility":"public","default_branch":"staging","security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}',
      rulesets: '[{"id":42,"name":"PR_Main"}]',
      rulesetDetail:
        '{"rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["merge"]}}],"conditions":{"ref_name":{"include":["~DEFAULT_BRANCH"]}}}',
      actionsPerms: '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}',
    })
    fs.writeFileSync(path.join(tmpDir, '.pre-commit-config.yaml'), 'repos:\n  - repo: trufflehog\n')
    fs.mkdirSync(path.join(tmpDir, '.github/workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.github/workflows/secret-scan.yml'),
      'on: [push]\njobs:\n  scan:\n    steps:\n      - run: trufflehog git file://.\n',
    )

    const result = runDoctor(tmpDir)

    expect(result.stdout).toContain('covers default branch (staging)')
    expect(result.stdout).toContain('merge commit enabled')
    expect(result.stdout).toContain('read-only')
    expect(result.stdout).toContain('configured in .pre-commit-config.yaml')
    expect(result.stdout).toContain('secret scan present in CI workflows')
    expect(result.stdout).toContain('no workflow uses pull_request_target')
    expect(result.stdout).not.toContain('disabled — free for public repos')
  })

  it('skips secret scanning on private free-plan repos and warns manual review on glob ruleset targets', () => {
    fakeGh(tmpDir, {
      meta: '{"visibility":"private","default_branch":"main"}',
      rulesets: '[{"id":42,"name":"PR_Main"}]',
      rulesetDetail:
        '{"rules":[{"type":"pull_request","parameters":{"allowed_merge_methods":["merge"]}}],"conditions":{"ref_name":{"include":["refs/heads/*"]}}}',
      actionsPerms: '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}',
    })

    const result = runDoctor(tmpDir)

    expect(result.stdout).toContain('private repo without GH Advanced Security')
    expect(result.stdout).toContain('review manually')
    expect(result.stdout).not.toContain('default branch is main — default branch unprotected')
  })
})

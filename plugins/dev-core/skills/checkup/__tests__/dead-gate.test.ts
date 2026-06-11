import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { detectUnsafeTokenInTriggeredWorkflow } from '../doctor-github'

/**
 * Dead Gate detector — acceptance tests.
 *
 * AC-1: github.token / secrets.GITHUB_TOKEN in push-triggered steps → flagged as 'dead'
 * AC-2: secrets.PAT in push-triggered steps → flagged as 'pat-warn' (not 'dead')
 * AC-3: App token via actions/create-github-app-token → steps.<id>.outputs.token → NOT flagged
 * AC-4: Push-gate merge-relative history: 0 push runs + ≥N merges → fail (integration via subprocess)
 * AC-5: findings appear in 'Dead Gates' Section
 */

// ── Unit tests: detectUnsafeTokenInTriggeredWorkflow ──────────────────────────

describe('detectUnsafeTokenInTriggeredWorkflow', () => {
  describe('AC-1: github.token / GITHUB_TOKEN → flagged as dead', () => {
    it('flags github.token in env of push-triggered step', () => {
      const content = [
        'name: Auto Merge',
        'on:',
        '  push:',
        '    branches: [staging]',
        'jobs:',
        '  merge:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Trigger merge',
        '        uses: some/action@v1',
        '        with:',
        '          token: ${{ github.token }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'auto-merge.yml')

      expect(issues).toHaveLength(1)
      expect(issues[0].kind).toBe('dead')
      expect(issues[0].token).toContain('github.token')
      expect(issues[0].file).toBe('auto-merge.yml')
      expect(issues[0].job).toBe('merge')
    })

    it('flags secrets.GITHUB_TOKEN in env of push-triggered step', () => {
      const content = [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Push changes',
        '        run: git push',
        '        env:',
        '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'ci.yml')

      expect(issues).toHaveLength(1)
      expect(issues[0].kind).toBe('dead')
      expect(issues[0].token).toContain('secrets.GITHUB_TOKEN')
    })

    it('flags github.token in compact on: [push] form', () => {
      const content = [
        'name: CI',
        'on: [push, pull_request]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Deploy',
        '        run: deploy.sh',
        '        env:',
        '          TOKEN: ${{ github.token }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'ci.yml')

      expect(issues.some((i) => i.kind === 'dead')).toBe(true)
    })

    it('flags github.token in workflow_run-triggered step (bot trigger)', () => {
      const content = [
        'name: Bot Workflow',
        'on:',
        '  workflow_run:',
        '    workflows: [CI]',
        '    types: [completed]',
        'jobs:',
        '  bot:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Comment',
        '        uses: some-action@v1',
        '        with:',
        '          token: ${{ github.token }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'bot.yml')

      expect(issues.some((i) => i.kind === 'dead')).toBe(true)
    })
  })

  describe('AC-2: secrets.PAT → warn (not dead)', () => {
    it('flags secrets.PAT as pat-warn, not dead', () => {
      const content = [
        'name: Auto Merge',
        'on:',
        '  push:',
        '    branches: [staging]',
        'jobs:',
        '  merge:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Trigger',
        '        uses: some/action@v1',
        '        with:',
        '          token: ${{ secrets.PAT }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'auto-merge.yml')

      expect(issues).toHaveLength(1)
      expect(issues[0].kind).toBe('pat-warn')
      // Must NOT be classified as dead
      expect(issues.some((i) => i.kind === 'dead')).toBe(false)
    })
  })

  describe('AC-3: App token via actions/create-github-app-token → NOT flagged', () => {
    it('does not flag steps.<id>.outputs.token (App token pattern)', () => {
      const content = [
        'name: Auto Merge',
        'on:',
        '  push:',
        '    branches: [staging]',
        'jobs:',
        '  merge:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Mint app token (roxabi-ci)',
        '        id: app',
        '        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
        '        with:',
        '          app-id: ${{ vars.ROXABI_CI_APP_ID }}',
        '          private-key: ${{ secrets.ROXABI_CI_APP_PRIVATE_KEY }}',
        '      - name: Trigger merge',
        '        uses: some/action@v1',
        '        with:',
        '          token: ${{ steps.app.outputs.token }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'auto-merge.yml')

      // Zero issues — App token is the canonical safe pattern
      expect(issues).toHaveLength(0)
    })

    it('does not false-positive on steps.<custom-id>.outputs.token', () => {
      const content = [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Mint token',
        '        id: roxabi-ci',
        '        uses: actions/create-github-app-token@v3',
        '        with:',
        '          app-id: ${{ vars.APP_ID }}',
        '          private-key: ${{ secrets.PRIVATE_KEY }}',
        '      - name: Push',
        '        run: git push',
        '        env:',
        '          GH_TOKEN: ${{ steps.roxabi-ci.outputs.token }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'ci.yml')

      expect(issues.filter((i) => i.kind === 'dead')).toHaveLength(0)
    })
  })

  describe('edge cases', () => {
    it('does not flag push-triggered workflows with no token usage at all', () => {
      const content = [
        'name: CI',
        'on: push',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - run: bun test',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'ci.yml')

      expect(issues).toHaveLength(0)
    })

    it('does not flag non-push-triggered workflows using github.token (pull_request only)', () => {
      const content = [
        'name: PR Lint',
        'on:',
        '  pull_request:',
        '    types: [opened, synchronize]',
        'jobs:',
        '  lint:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Comment',
        '        uses: some/action@v1',
        '        with:',
        '          token: ${{ github.token }}',
      ].join('\n')

      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'pr-lint.yml')

      // pull_request events ARE re-triggered — only push/bot-triggered is the dead-gate
      expect(issues).toHaveLength(0)
    })

    it('returns empty array for empty content', () => {
      const issues = detectUnsafeTokenInTriggeredWorkflow('', 'empty.yml')
      expect(issues).toHaveLength(0)
    })
  })
})

// ── Integration tests: checkDeadGates section via subprocess ─────────────────

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

describe('checkDeadGates (integration via subprocess)', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-gate-test-'))

    // Fake git: returns known remote
    makeFakeExec(
      tmpDir,
      'git',
      ['if [ "$1" = "remote" ]; then echo "git@github.com:TestOrg/test-repo.git"; exit 0; fi', 'exit 0'].join('\n'),
    )

    // Fake gh: authenticated, repo exists + is old enough, 0 push runs, N merges
    makeFakeExec(
      tmpDir,
      'gh',
      [
        'case "$*" in',
        '  "--version") echo "gh version 2.40.0"; exit 0 ;;',
        '  "auth status") exit 0 ;;',
        '  "auth token") echo "ghp_test"; exit 0 ;;',
        // repo view: return old creation date so grace window passes
        '  "repo view"*"createdAt"*) echo "2020-01-01T00:00:00Z"; exit 0 ;;',
        // branches staging/main: exist
        '  "api repos/TestOrg/test-repo/branches/staging") echo "{}"; exit 0 ;;',
        '  "api repos/TestOrg/test-repo/branches/main") echo "{}"; exit 0 ;;',
        // push run count: return 0 (no push runs landed)
        '  "run list"*"--event" "push"*"--json" "databaseId"*) echo "0"; exit 0 ;;',
        // merge commit count: ≥5 merges
        '  "api repos/TestOrg/test-repo/commits"*) echo "7"; exit 0 ;;',
        '  "label list"*) echo "[]"; exit 0 ;;',
        '  "api"*) echo "{}"; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )

    // .env for GITHUB_REPO
    fs.writeFileSync(
      path.join(tmpDir, '.env'),
      'GITHUB_REPO=TestOrg/test-repo\nGH_PROJECT_ID=PVT_123\nSTATUS_FIELD_ID=F1\nSIZE_FIELD_ID=F2\nPRIORITY_FIELD_ID=F3\n',
    )
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('AC-5: Dead Gates section appears in output', () => {
    const result = runDoctor(tmpDir)
    expect(result.stdout).toContain('Dead Gates')
  })

  it('AC-4 + AC-5: flags push-gate dead gate in JSON output', () => {
    // Write a push-triggered workflow with unsafe token
    const wfDir = path.join(tmpDir, '.github', 'workflows')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(
      path.join(wfDir, 'ci.yml'),
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [staging]',
        'jobs:',
        '  build:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Push',
        '        run: git push',
        '        env:',
        '          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}',
      ].join('\n'),
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{ name: string; checks: Array<{ status: string }> }>

    const deadGatesSection = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGatesSection).toBeDefined()
    // Should have at least one fail (token taxonomy)
    const hasFail = deadGatesSection?.checks.some((c) => c.status === 'fail')
    expect(hasFail).toBe(true)
  })

  it('AC-3: does not flag App token in push-triggered workflow', () => {
    const wfDir = path.join(tmpDir, '.github', 'workflows')
    fs.mkdirSync(wfDir, { recursive: true })
    fs.writeFileSync(
      path.join(wfDir, 'auto-merge.yml'),
      [
        'name: Auto Merge',
        'on:',
        '  push:',
        '    branches: [staging]',
        'jobs:',
        '  merge:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Mint app token',
        '        id: app',
        '        uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1',
        '        with:',
        '          app-id: ${{ vars.ROXABI_CI_APP_ID }}',
        '          private-key: ${{ secrets.ROXABI_CI_APP_PRIVATE_KEY }}',
        '      - name: Merge',
        '        uses: some/action@v1',
        '        with:',
        '          token: ${{ steps.app.outputs.token }}',
      ].join('\n'),
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ status: string; detail?: string }>
    }>

    const deadGatesSection = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGatesSection).toBeDefined()

    // Token taxonomy check must NOT contain a 'dead' fail about this workflow
    const tokenFails = deadGatesSection?.checks.filter((c) => c.status === 'fail' && c.detail?.includes('DEAD GATE'))
    expect(tokenFails).toHaveLength(0)
  })

  it('AC-1 (read-only): doctor does not mutate repo or run state', () => {
    // Read-only: running doctor twice produces the same output
    const result1 = runDoctor(tmpDir, ['--json'])
    const result2 = runDoctor(tmpDir, ['--json'])

    // Both runs parse successfully
    expect(() => JSON.parse(result1.stdout)).not.toThrow()
    expect(() => JSON.parse(result2.stdout)).not.toThrow()

    // Outputs are identical (no state written between runs)
    expect(result1.stdout).toBe(result2.stdout)
  })
})

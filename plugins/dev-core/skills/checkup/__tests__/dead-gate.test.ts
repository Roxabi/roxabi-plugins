import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  aggregateJobStats,
  classifyDormancy,
  DORMANCY_MIN_RUNS,
  detectUnsafeTokenInTriggeredWorkflow,
  isJobRequired,
  type JobRunStats,
  type ParsedJob,
  parseRequiredContexts,
  parseWorkflowJobs,
  type RunRecord,
} from '../doctor-github'

/**
 * Dead Gate detector — acceptance tests.
 *
 * Spec criterion → test mapping (spec: artifacts/specs/288-conditional-job-skip-rate-spec.mdx)
 *
 * | Spec criterion       | Label | Test location(s)                                       |
 * |----------------------|-------|--------------------------------------------------------|
 * | Token taxonomy dead  | AC-1  | detectUnsafeToken > AC-1 (unit)                        |
 * | Token taxonomy warn  | AC-2  | detectUnsafeToken > AC-2 (unit)                        |
 * | App token safe       | AC-3  | detectUnsafeToken > AC-3 (unit) + AC-3 integration     |
 * | Push-gate history    | AC-4  | integration > AC-4                                     |
 * | Section render       | AC-5  | integration > AC-5                                     |
 * | Wiring-warn          | AC-6  | integration > dormant_wiring WARN + unit AC-7d/7e      |
 * | Required-fail        | AC-7  | integration > AC-10 + unit > isJobRequired (matrix leg)|
 * | Conditional-ok       | AC-8  | integration > AC-11 (conditional_ok → not flagged)     |
 * | Grace window         | AC-9  | integration > SC3 grace window                         |
 * | Render contract      | AC-10 | integration > AC-10 (named check, sub-grouped)         |
 * | Req-ctx resolution   | AC-11 | unit > parseRequiredContexts AC-9a/b/c/d/e/f           |
 * | Parser               | —     | unit > parseWorkflowJobs AC-6a–6f                      |
 * | Eligibility          | —     | unit > aggregateJobStats AC-8a–8e                      |
 * | Clean state          | —     | integration > clean state (all jobs execute)           |
 * | --repo correctness   | —     | unit > --repo correctness (source inspection)          |
 *
 * Note: test-file AC labels (AC-6…AC-11 below) differ from spec AC labels above;
 * the mapping table is the authoritative cross-reference.
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

  describe('AC-3b (review #296): job-level env + no safe-token masking', () => {
    it('flags github.token declared at JOB-LEVEL env (not in a step)', () => {
      const content = [
        'name: Release',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  publish:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      GH_TOKEN: ${{ github.token }}',
        '    steps:',
        '      - run: gh release create',
      ].join('\n')
      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'release.yml')
      const dead = issues.filter((i) => i.kind === 'dead')
      expect(dead).toHaveLength(1)
      expect(dead[0].step).toBe('(job-level env)')
    })

    it('flags a dead token even when a safe App token is present in the same step (no masking)', () => {
      const content = [
        'name: Auto Merge',
        'on:',
        '  push:',
        '    branches: [staging]',
        'jobs:',
        '  merge:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - name: Mixed',
        '        run: gh pr merge',
        '        env:',
        '          APP: ${{ steps.app.outputs.token }}',
        '          GH_TOKEN: ${{ github.token }}',
      ].join('\n')
      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'auto-merge.yml')
      expect(issues.filter((i) => i.kind === 'dead')).toHaveLength(1)
    })

    it('flags secrets.PAT at job-level env as pat-warn', () => {
      const content = [
        'name: Sync',
        'on: push',
        'jobs:',
        '  sync:',
        '    runs-on: ubuntu-latest',
        '    env:',
        '      GH_TOKEN: ${{ secrets.PAT }}',
        '    steps:',
        '      - run: git push',
      ].join('\n')
      const issues = detectUnsafeTokenInTriggeredWorkflow(content, 'sync.yml')
      expect(issues.filter((i) => i.kind === 'pat-warn')).toHaveLength(1)
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
        // push run count (scalar): countPushRuns uses `--json databaseId --jq length` → return 0.
        // The `--jq` anchor keeps this from also answering fetchJobHistory's `--json databaseId,conclusion`
        // (array) call — distinct shapes must not collide (#288 review #5).
        '  "run list"*"--event"*"push"*"--json databaseId --jq"*) echo "0"; exit 0 ;;',
        // job-history list (array shape): defensive — pushCount=0 short-circuits before this fires,
        // but answer with a valid empty array so a future pushCount>0 fixture never gets "0".
        '  "run list"*"--json databaseId,conclusion"*) echo "[]"; exit 0 ;;',
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

  it('AC-4: flags push-gate dead gate in JSON output (push-gate history sentinel)', () => {
    // Write a push-triggered workflow using a safe App token so that token taxonomy passes —
    // only the push-gate history sub-check (0 push runs + ≥5 merges) can produce a fail.
    // This isolates AC-4: a regression in push-gate logic stays visible even if token taxonomy passes.
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
        '      - name: Mint app token',
        '        id: app',
        '        uses: actions/create-github-app-token@v1',
        '        with:',
        '          app-id: ${{ vars.APP_ID }}',
        '          private-key: ${{ secrets.APP_PRIVATE_KEY }}',
        '      - name: Push',
        '        run: git push',
        '        env:',
        '          GH_TOKEN: ${{ steps.app.outputs.token }}',
      ].join('\n'),
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ name?: string; status: string; detail?: string }>
    }>

    const deadGatesSection = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGatesSection).toBeDefined()
    // Must have a push-gate history fail with the canonical sentinel phrase
    const pushGateFail = deadGatesSection?.checks.find(
      (c) => c.status === 'fail' && c.detail?.includes('never actually runs on pushes'),
    )
    expect(pushGateFail).toBeDefined()
  })

  it('SC3 grace window: a recently-added workflow is NOT flagged as a dead push-gate', () => {
    // Override gh so the workflow's created_at is recent (< GRACE_DAYS). Even with an OLD
    // repo + 0 push runs + ≥5 merges, a brand-new workflow has 0 runs because it is new,
    // not dead — the per-workflow grace window must skip it.
    makeFakeExec(
      tmpDir,
      'gh',
      [
        'case "$*" in',
        '  "--version") echo "gh version 2.40.0"; exit 0 ;;',
        '  "auth status") exit 0 ;;',
        '  "auth token") echo "ghp_test"; exit 0 ;;',
        '  "repo view"*"createdAt"*) echo "2020-01-01T00:00:00Z"; exit 0 ;;',
        '  "api repos/TestOrg/test-repo/branches/staging") echo "{}"; exit 0 ;;',
        '  "api repos/TestOrg/test-repo/branches/main") echo "{}"; exit 0 ;;',
        // scalar push-run count (anchored on `--jq`) vs array job-history shape — see #288 review #5.
        '  "run list"*"--event"*"push"*"--json databaseId --jq"*) echo "0"; exit 0 ;;',
        '  "run list"*"--json databaseId,conclusion"*) echo "[]"; exit 0 ;;',
        '  "api repos/TestOrg/test-repo/actions/workflows/"*) date -u -d "2 days ago" +%Y-%m-%dT%H:%M:%SZ; exit 0 ;;',
        '  "api repos/TestOrg/test-repo/commits"*) echo "7"; exit 0 ;;',
        '  "label list"*) echo "[]"; exit 0 ;;',
        '  "api"*) echo "{}"; exit 0 ;;',
        '  *) exit 0 ;;',
        'esac',
      ].join('\n'),
    )
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
        '          GH_TOKEN: ${{ steps.app.outputs.token }}',
      ].join('\n'),
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ name?: string; status: string; detail?: string }>
    }>
    const deadGatesSection = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGatesSection).toBeDefined()
    const pushGateFail = deadGatesSection?.checks.find(
      (c) => c.status === 'fail' && c.detail?.includes('never actually runs on pushes'),
    )
    expect(pushGateFail).toBeUndefined()
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
      checks: Array<{ name?: string; status: string; detail?: string }>
    }>

    const deadGatesSection = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGatesSection).toBeDefined()

    // Token taxonomy check (name === 'token taxonomy') must NOT flag this workflow as a dead gate.
    // Scope to the taxonomy check only — push-gate history checks use the same phrase but are separate.
    const tokenTaxonomyCheck = deadGatesSection?.checks.find((c) => c.name === 'token taxonomy')
    expect(tokenTaxonomyCheck).toBeDefined()
    expect(tokenTaxonomyCheck?.status).not.toBe('fail')
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

  // ── AC-10: dormant_required job → fail check in Doctor output ─────────────────
  it('AC-10: dormant required job emits fail check in Dead Gates section', () => {
    // Workflow with a single required job that appears in required contexts
    fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  build:',
        '    name: Build',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo ok',
      ].join('\n'),
    )

    // Fake gh: repo is old, ci.yml has push runs on main, branch exists,
    // required contexts return "Build", run list returns 5 runs all with build job skipped
    makeFakeExec(
      tmpDir,
      'gh',
      `#!/bin/sh
ARGS="$*"
# repo created_at (old repo — more than 14 days)
if echo "$ARGS" | grep -q 'repos/TestOrg/test-repo$'; then
  echo '{"created_at":"2020-01-01T00:00:00Z","visibility":"public"}'
  exit 0
fi
# branch protection required contexts (dual-root: top-level contexts array)
if echo "$ARGS" | grep -q 'required_status_checks$'; then
  echo '{"contexts":["Build"],"checks":[]}'
  exit 0
fi
# ruleset required status checks (empty)
if echo "$ARGS" | grep -q 'rules/branches/main$' || echo "$ARGS" | grep -q 'rules/branches/staging$'; then
  echo '[]'
  exit 0
fi
# branch exists check
if echo "$ARGS" | grep -q 'branches/main$' || echo "$ARGS" | grep -q 'branches/staging$'; then
  echo '{"name":"main"}'
  exit 0
fi
# workflow created_at (old)
if echo "$ARGS" | grep -q 'workflows/ci.yml$'; then
  echo '{"created_at":"2020-01-01T00:00:00Z"}'
  exit 0
fi
if echo "$ARGS" | grep -q 'workflows/auto-merge.yml$' || echo "$ARGS" | grep -q 'workflows/pr-title.yml$' || echo "$ARGS" | grep -q 'workflows/deploy-preview.yml$'; then
  echo '{"created_at":"2020-01-01T00:00:00Z"}'
  exit 0
fi
# countPushRuns: \`gh run list ... --json databaseId --jq length\` → scalar count (ci.yml alive, others 0).
# (Distinct from fetchJobHistory below, which asks for --json databaseId,conclusion and wants an array.)
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'length'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then echo '5'; else echo '0'; fi
  exit 0
fi
# fetchJobHistory: \`gh run list ... --json databaseId,conclusion\` → run array (ci.yml has 5 push runs).
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'databaseId,conclusion'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then
    echo '[{"databaseId":1,"conclusion":"success"},{"databaseId":2,"conclusion":"success"},{"databaseId":3,"conclusion":"success"},{"databaseId":4,"conclusion":"success"},{"databaseId":5,"conclusion":"success"}]'
  else
    echo '[]'
  fi
  exit 0
fi
# any other run list → empty
if echo "$ARGS" | grep -q 'run list'; then
  echo '[]'
  exit 0
fi
# run view — build job conclusion is skipped in all 5 runs
if echo "$ARGS" | grep -q 'run view'; then
  echo '{"conclusion":"success","jobs":[{"name":"Build","conclusion":"skipped"}]}'
  exit 0
fi
# merge commits
if echo "$ARGS" | grep -q 'log' || echo "$ARGS" | grep -q 'commits'; then
  echo '[{"sha":"abc"},{"sha":"def"},{"sha":"ghi"},{"sha":"jkl"},{"sha":"mno"}]'
  exit 0
fi
echo '{}'
exit 0`,
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ name: string; status: string; detail: string }>
    }>
    const deadGates = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGates).toBeDefined()

    // Non-vacuous: the detector MUST run (fake countPushRuns returns 5 for ci.yml) and flag the
    // required Build job that skips every run → fail, sub-grouped by job (#579 signature).
    const dormantCheck = deadGates?.checks.find((c) => c.name.includes('Build') && c.name.includes('dormancy'))
    expect(dormantCheck).toBeDefined()
    expect(dormantCheck?.status).toBe('fail')
    expect(dormantCheck?.detail).toContain('required status check')
    expect(dormantCheck?.name).toContain('ci.yml:main:Build')
  })

  // ── AC-11: conditional_ok job → not flagged ────────────────────────────────────
  it('AC-11: conditional_ok job (has if:, not required) is not flagged', () => {
    fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  deploy:',
        '    name: Deploy',
        '    if: github.ref == "refs/heads/main"',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo deploy',
      ].join('\n'),
    )

    // Fake gh: no required contexts, deploy job always skipped
    makeFakeExec(
      tmpDir,
      'gh',
      `#!/bin/sh
ARGS="$*"
if echo "$ARGS" | grep -q 'repos/TestOrg/test-repo$'; then
  echo '{"created_at":"2020-01-01T00:00:00Z","visibility":"public"}'
  exit 0
fi
if echo "$ARGS" | grep -q 'required_status_checks$'; then
  echo '{"contexts":[],"checks":[]}'
  exit 0
fi
if echo "$ARGS" | grep -q 'rules/branches'; then
  echo '[]'
  exit 0
fi
if echo "$ARGS" | grep -q 'branches/main$' || echo "$ARGS" | grep -q 'branches/staging$'; then
  echo '{"name":"main"}'
  exit 0
fi
if echo "$ARGS" | grep -q 'workflows'; then
  echo '{"created_at":"2020-01-01T00:00:00Z"}'
  exit 0
fi
# countPushRuns (--jq length) → scalar; fetchJobHistory (--json databaseId,conclusion) → array.
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'length'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then echo '5'; else echo '0'; fi
  exit 0
fi
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'databaseId,conclusion'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then
    echo '[{"databaseId":1,"conclusion":"success"},{"databaseId":2,"conclusion":"success"},{"databaseId":3,"conclusion":"success"},{"databaseId":4,"conclusion":"success"},{"databaseId":5,"conclusion":"success"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if echo "$ARGS" | grep -q 'run list'; then
  echo '[]'
  exit 0
fi
if echo "$ARGS" | grep -q 'run view'; then
  echo '{"conclusion":"success","jobs":[{"name":"Deploy","conclusion":"skipped"}]}'
  exit 0
fi
echo '{}'
exit 0`,
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ name: string; status: string }>
    }>
    const deadGates = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGates).toBeDefined()

    // True negative: the harness demonstrably runs the detector (proven by AC-10, which uses the
    // same fake-gh mechanism and DOES flag a required dormant job). Here the only job is a
    // conditional `if:` job that is not required and skips every run → conditional_ok → no Check.
    const deployDormant = deadGates?.checks.find((c) => c.name.includes('Deploy') && c.name.includes('dormancy'))
    expect(deployDormant).toBeUndefined()
  })

  // ── Clean state (spec criterion): every job executes → no dormancy finding ──────
  it('clean state: a workflow whose jobs all execute produces no dormancy finding', () => {
    fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  build:',
        '    name: Build',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo ok',
      ].join('\n'),
    )

    // Fake gh: every workflow is alive (countPushRuns=5 → push-gate B never fails), the Build
    // job executes in every run → classifyDormancy returns alive → sub-check C emits nothing.
    makeFakeExec(
      tmpDir,
      'gh',
      `#!/bin/sh
ARGS="$*"
if echo "$ARGS" | grep -q 'repos/TestOrg/test-repo$'; then
  echo '{"created_at":"2020-01-01T00:00:00Z","visibility":"public"}'; exit 0
fi
if echo "$ARGS" | grep -q 'required_status_checks$'; then
  echo '{"contexts":[],"checks":[]}'; exit 0
fi
if echo "$ARGS" | grep -q 'rules/branches'; then
  echo '[]'; exit 0
fi
if echo "$ARGS" | grep -q 'branches/main$' || echo "$ARGS" | grep -q 'branches/staging$'; then
  echo '{"name":"main"}'; exit 0
fi
if echo "$ARGS" | grep -q 'workflows'; then
  echo '{"created_at":"2020-01-01T00:00:00Z"}'; exit 0
fi
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'length'; then
  echo '5'; exit 0
fi
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'databaseId,conclusion'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then
    echo '[{"databaseId":1,"conclusion":"success"},{"databaseId":2,"conclusion":"success"},{"databaseId":3,"conclusion":"success"},{"databaseId":4,"conclusion":"success"},{"databaseId":5,"conclusion":"success"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if echo "$ARGS" | grep -q 'run list'; then echo '[]'; exit 0; fi
if echo "$ARGS" | grep -q 'run view'; then
  echo '{"conclusion":"success","jobs":[{"name":"Build","conclusion":"success"}]}'; exit 0
fi
echo '{}'
exit 0`,
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ name: string; status: string; detail?: string }>
    }>
    const deadGates = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGates).toBeDefined()
    // No per-job dormancy Check when every job executes.
    expect(deadGates?.checks.find((c) => c.name.includes('dormancy'))).toBeUndefined()
    // Section is fully healthy: no fail or warn from any sub-check (A token-taxonomy, B push-gate, C dormancy).
    expect(deadGates?.checks.filter((c) => c.status === 'fail' || c.status === 'warn')).toHaveLength(0)
    // (Note: sub-check A always emits a token-taxonomy Check, so the `checks.length === 0` fallback
    // in checkDeadGates is defensively unreachable here; clean-state is signalled by the absence of
    // fail/warn findings, with token-taxonomy reporting pass.)
    expect(deadGates?.checks.find((c) => c.name === 'token taxonomy')?.status).toBe('pass')
  })

  // ── dormant_wiring WARN render (spec AC-6 at integration level) ─────────────────
  it('AC-6 (render): an unconditional job skipped every run → warn check in Dead Gates section', () => {
    fs.mkdirSync(path.join(tmpDir, '.github', 'workflows'), { recursive: true })
    fs.writeFileSync(
      path.join(tmpDir, '.github', 'workflows', 'ci.yml'),
      [
        'name: CI',
        'on:',
        '  push:',
        '    branches: [main]',
        'jobs:',
        '  lint:',
        '    name: Lint',
        '    needs: [build]',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - run: echo lint',
      ].join('\n'),
    )

    // Fake gh: ci.yml alive, Lint not a required context, Lint skipped in every run (broken needs).
    // No job-level if: → classifyDormancy returns dormant_wiring → warn.
    makeFakeExec(
      tmpDir,
      'gh',
      `#!/bin/sh
ARGS="$*"
if echo "$ARGS" | grep -q 'repos/TestOrg/test-repo$'; then
  echo '{"created_at":"2020-01-01T00:00:00Z","visibility":"public"}'; exit 0
fi
if echo "$ARGS" | grep -q 'required_status_checks$'; then
  echo '{"contexts":[],"checks":[]}'; exit 0
fi
if echo "$ARGS" | grep -q 'rules/branches'; then
  echo '[]'; exit 0
fi
if echo "$ARGS" | grep -q 'branches/main$' || echo "$ARGS" | grep -q 'branches/staging$'; then
  echo '{"name":"main"}'; exit 0
fi
if echo "$ARGS" | grep -q 'workflows'; then
  echo '{"created_at":"2020-01-01T00:00:00Z"}'; exit 0
fi
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'length'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then echo '5'; else echo '0'; fi
  exit 0
fi
if echo "$ARGS" | grep -q 'run list' && echo "$ARGS" | grep -q 'databaseId,conclusion'; then
  if echo "$ARGS" | grep -q 'ci.yml'; then
    echo '[{"databaseId":1,"conclusion":"success"},{"databaseId":2,"conclusion":"success"},{"databaseId":3,"conclusion":"success"},{"databaseId":4,"conclusion":"success"},{"databaseId":5,"conclusion":"success"}]'
  else
    echo '[]'
  fi
  exit 0
fi
if echo "$ARGS" | grep -q 'run list'; then echo '[]'; exit 0; fi
if echo "$ARGS" | grep -q 'run view'; then
  echo '{"conclusion":"success","jobs":[{"name":"Lint","conclusion":"skipped"}]}'; exit 0
fi
echo '{}'
exit 0`,
    )

    const result = runDoctor(tmpDir, ['--json'])
    const parsed = JSON.parse(result.stdout) as Array<{
      name: string
      checks: Array<{ name: string; status: string; detail: string }>
    }>
    const deadGates = parsed.find((s) => s.name === 'Dead Gates')
    expect(deadGates).toBeDefined()
    const lintDormant = deadGates?.checks.find((c) => c.name.includes('Lint') && c.name.includes('dormancy'))
    expect(lintDormant).toBeDefined()
    expect(lintDormant?.status).toBe('warn')
    expect(lintDormant?.detail).toContain('dead wiring')
    expect(lintDormant?.name).toContain('ci.yml:main:Lint')
  })
})

// ─── AC-6: parseWorkflowJobs ────────────────────────────────────────────────

describe('parseWorkflowJobs', () => {
  it('AC-6a: parses job id, displayName, hasIf=false, matrixEmpty=false, needs', () => {
    const yaml = [
      'jobs:',
      '  build:',
      '    name: Build App',
      '    runs-on: ubuntu-latest',
      '    needs: [lint]',
      '    steps:',
      '      - run: echo ok',
    ].join('\n')
    const jobs = parseWorkflowJobs(yaml)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe('build')
    expect(jobs[0].displayName).toBe('Build App')
    expect(jobs[0].hasIf).toBe(false)
    expect(jobs[0].matrixEmpty).toBe(false)
    expect(jobs[0].needs).toEqual(['lint'])
  })

  it('AC-6b: uses job id as displayName when name: is absent', () => {
    const yaml = ['jobs:', '  deploy:', '    runs-on: ubuntu-latest', '    steps:', '      - run: echo deploy'].join(
      '\n',
    )
    const jobs = parseWorkflowJobs(yaml)
    expect(jobs).toHaveLength(1)
    expect(jobs[0].id).toBe('deploy')
    expect(jobs[0].displayName).toBe('deploy')
  })

  it('AC-6c: hasIf=true when job has an if: condition', () => {
    const yaml = [
      'jobs:',
      '  release:',
      '    if: github.ref == "refs/heads/main"',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo release',
    ].join('\n')
    const jobs = parseWorkflowJobs(yaml)
    expect(jobs[0].hasIf).toBe(true)
  })

  it('AC-6d: matrixEmpty=true when matrix has an empty array axis', () => {
    const yaml = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        os: []',
      '    runs-on: ${{ matrix.os }}',
      '    steps:',
      '      - run: echo test',
    ].join('\n')
    const jobs = parseWorkflowJobs(yaml)
    expect(jobs[0].matrixEmpty).toBe(true)
  })

  it('AC-6e: matrixEmpty=false for non-empty matrix', () => {
    const yaml = [
      'jobs:',
      '  test:',
      '    strategy:',
      '      matrix:',
      '        os: [ubuntu-latest, windows-latest]',
      '    runs-on: ${{ matrix.os }}',
      '    steps:',
      '      - run: echo test',
    ].join('\n')
    const jobs = parseWorkflowJobs(yaml)
    expect(jobs[0].matrixEmpty).toBe(false)
  })

  it('AC-6f: needs as string (single dep) parsed as array', () => {
    const yaml = [
      'jobs:',
      '  e2e:',
      '    needs: build',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - run: echo e2e',
    ].join('\n')
    const jobs = parseWorkflowJobs(yaml)
    expect(jobs[0].needs).toContain('build')
  })
})

// ─── AC-7: classifyDormancy ──────────────────────────────────────────────────

describe('classifyDormancy', () => {
  const job: ParsedJob = { id: 'build', displayName: 'Build', hasIf: false, matrixEmpty: false, needs: [] }

  it('AC-7a: considered < minRuns → alive', () => {
    const stats: JobRunStats = { considered: 3, executed: 0, skipped: 3 }
    expect(classifyDormancy(job, stats, true, 5)).toBe('alive')
  })

  it('AC-7b: executed > 0 → alive', () => {
    const stats: JobRunStats = { considered: 10, executed: 2, skipped: 8 }
    expect(classifyDormancy(job, stats, true, 5)).toBe('alive')
  })

  it('AC-7c: executed == 0, considered >= minRuns, isRequired → dormant_required', () => {
    const stats: JobRunStats = { considered: 5, executed: 0, skipped: 5 }
    expect(classifyDormancy(job, stats, true, 5)).toBe('dormant_required')
  })

  it('AC-7d: executed == 0, considered >= minRuns, matrixEmpty, not required → dormant_wiring', () => {
    const matrixJob: ParsedJob = { ...job, matrixEmpty: true }
    const stats: JobRunStats = { considered: 5, executed: 0, skipped: 5 }
    expect(classifyDormancy(matrixJob, stats, false, 5)).toBe('dormant_wiring')
  })

  it('AC-7e: executed == 0, considered >= minRuns, no if, not required, not matrixEmpty → dormant_wiring', () => {
    const stats: JobRunStats = { considered: 5, executed: 0, skipped: 5 }
    expect(classifyDormancy(job, stats, false, 5)).toBe('dormant_wiring')
  })

  it('AC-7f: executed == 0, considered >= minRuns, has if, not required → conditional_ok', () => {
    const ifJob: ParsedJob = { ...job, hasIf: true }
    const stats: JobRunStats = { considered: 5, executed: 0, skipped: 5 }
    expect(classifyDormancy(ifJob, stats, false, 5)).toBe('conditional_ok')
  })
})

// ─── AC-8: aggregateJobStats ─────────────────────────────────────────────────

describe('aggregateJobStats', () => {
  const job: ParsedJob = { id: 'build', displayName: 'Build', hasIf: false, matrixEmpty: false, needs: [] }

  it('AC-8a: skipped and cancelled runs excluded from eligible set', () => {
    const runs: RunRecord[] = [
      { runConclusion: 'skipped', jobs: [{ name: 'Build', conclusion: 'success' }] },
      { runConclusion: 'cancelled', jobs: [{ name: 'Build', conclusion: 'success' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'success' }] },
    ]
    const stats = aggregateJobStats(job, runs)
    // Only the third run is eligible; considered = 1, executed = 1
    expect(stats.considered).toBe(1)
    expect(stats.executed).toBe(1)
  })

  it('AC-8b: absent job (job not present in run) does not count toward considered', () => {
    const runs: RunRecord[] = [
      { runConclusion: 'success', jobs: [] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'success' }] },
    ]
    const stats = aggregateJobStats(job, runs)
    // First run: eligible but job absent → not considered
    // Second run: eligible + job present → considered + executed
    expect(stats.considered).toBe(1)
    expect(stats.executed).toBe(1)
  })

  it('AC-8c: skipped job conclusion does not count as executed', () => {
    const runs: RunRecord[] = [
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'skipped' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'skipped' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'skipped' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'skipped' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'skipped' }] },
    ]
    const stats = aggregateJobStats(job, runs)
    expect(stats.considered).toBe(5)
    expect(stats.executed).toBe(0)
    expect(stats.skipped).toBe(5)
  })

  it('AC-8d: matrix leg matching via displayName prefix', () => {
    // Matrix leg: "Build (ubuntu-latest)" matches job with displayName "Build"
    const runs: RunRecord[] = [
      { runConclusion: 'success', jobs: [{ name: 'Build (ubuntu-latest)', conclusion: 'success' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build (windows-latest)', conclusion: 'skipped' }] },
    ]
    const stats = aggregateJobStats(job, runs)
    // Both runs have a matching leg → both considered; 1 executed (ubuntu), 1 skipped (windows)
    expect(stats.considered).toBe(2)
    expect(stats.executed).toBe(1)
    expect(stats.skipped).toBe(1)
  })

  it('AC-8e: exact name match (no matrix leg) works', () => {
    const runs: RunRecord[] = [{ runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'success' }] }]
    const stats = aggregateJobStats(job, runs)
    expect(stats.considered).toBe(1)
    expect(stats.executed).toBe(1)
  })

  it('AC-8f (#288 review #2): null/empty conclusion (in-progress) does not count as executed', () => {
    // A run still in progress reports a null (here empty-string) conclusion. Counting it as
    // executed would fail-open and mask a dormant required gate, so it must land in `skipped`.
    const runs: RunRecord[] = [
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: '' }] },
      { runConclusion: 'success', jobs: [{ name: 'Build', conclusion: 'skipped' }] },
    ]
    const stats = aggregateJobStats(job, runs)
    expect(stats.considered).toBe(2)
    expect(stats.executed).toBe(0)
    expect(stats.skipped).toBe(2)
  })

  it('AC-8g (#288 review #3): a sibling job sharing the matrix prefix is not absorbed', () => {
    // The matrix parent "Build" never runs its own leg (always skipped → dormant), while a SEPARATE
    // static job literally named "Build (debug)" runs every time. Without sibling exclusion the
    // sibling's success masks the parent's dormancy. With it, the parent is correctly all-skipped.
    const runs: RunRecord[] = Array.from({ length: 6 }, () => ({
      runConclusion: 'success',
      jobs: [
        { name: 'Build (linux)', conclusion: 'skipped' }, // parent's real matrix leg — dormant
        { name: 'Build (debug)', conclusion: 'success' }, // a separate job that shares the prefix
      ],
    }))
    const withExclusion = aggregateJobStats(job, runs, new Set(['Build (debug)']))
    expect(withExclusion.considered).toBe(6)
    expect(withExclusion.executed).toBe(0) // sibling success must NOT mask the parent's dormancy
    expect(withExclusion.skipped).toBe(6)

    // Backward-compatible default: the legacy 2-arg call keeps the greedy prefix match (documents
    // the prior behavior the caller now guards against by passing sibling names).
    const greedy = aggregateJobStats(job, runs)
    expect(greedy.executed).toBe(6)
  })
})

// ─── isJobRequired (#288 review #1): matrix-leg-aware required-context match ──

describe('isJobRequired', () => {
  it('matches a non-matrix job by exact display name', () => {
    expect(isJobRequired('Build', new Set(['Build', 'Lint']))).toBe(true)
  })

  it('matches a matrix job via any registered leg context (the bare parent name is never required)', () => {
    // GitHub registers one required context per matrix leg ("Build (ubuntu-latest)"), never "Build".
    const required = new Set(['Build (ubuntu-latest)', 'Build (windows-latest)'])
    expect(isJobRequired('Build', required)).toBe(true)
  })

  it('does not false-positive on an unrelated context that merely shares a prefix substring', () => {
    // "Build-extras" shares the "Build" prefix but is not a matrix leg (no " (") → not required.
    expect(isJobRequired('Build', new Set(['Build-extras', 'lint (fast)']))).toBe(false)
  })

  it('returns false when the required set is empty (fail-open: nothing escalates)', () => {
    expect(isJobRequired('Build', new Set())).toBe(false)
  })
})

// ─── AC-9: parseRequiredContexts ─────────────────────────────────────────────

describe('parseRequiredContexts', () => {
  it('AC-9a: classic dual-root form — top-level contexts array', () => {
    const json = JSON.stringify({ contexts: ['ci', 'Build'], checks: [] })
    const result = parseRequiredContexts(json)
    expect(result.has('ci')).toBe(true)
    expect(result.has('Build')).toBe(true)
  })

  it('AC-9b: classic dual-root form — top-level checks array with context field', () => {
    const json = JSON.stringify({ contexts: [], checks: [{ context: 'trufflehog' }] })
    const result = parseRequiredContexts(json)
    expect(result.has('trufflehog')).toBe(true)
  })

  it('AC-9c: ruleset form — required_status_checks rule with contexts array', () => {
    const json = JSON.stringify([
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'ci' }, { context: 'lint' }] },
      },
    ])
    const result = parseRequiredContexts(json)
    expect(result.has('ci')).toBe(true)
    expect(result.has('lint')).toBe(true)
  })

  it('AC-9d: empty / 404 response (empty string) → empty set (fail-open)', () => {
    const result = parseRequiredContexts('')
    expect(result.size).toBe(0)
  })

  it('AC-9e: malformed JSON → empty set (fail-open)', () => {
    const result = parseRequiredContexts('not json at all')
    expect(result.size).toBe(0)
  })

  it('AC-9f: union of contexts + checks in dual-root form', () => {
    const json = JSON.stringify({ contexts: ['Build'], checks: [{ context: 'lint' }] })
    const result = parseRequiredContexts(json)
    expect(result.has('Build')).toBe(true)
    expect(result.has('lint')).toBe(true)
    expect(result.size).toBe(2)
  })
})

// ─── --repo correctness (spec criterion, source inspection) ──────────────────
// `gh run list` / `gh run view` MUST carry `--repo owner/repo` (cron-safe from any cwd), whereas
// `gh api` MUST NOT (it embeds owner/repo in the path and errors on `--repo`). The latter is a
// regression guard: an earlier draft passed `--repo` to fetchRequiredContexts' `gh api` calls,
// which fail-open silently and disabled the AC-7 (dormant_required) escalation in production.

describe('--repo correctness', () => {
  const source = fs.readFileSync(new URL('../doctor-github.ts', import.meta.url), 'utf8')

  const bodyOf = (fnName: string): string => {
    // Match `export function` and `export async function` alike — and stop the body at the next
    // export of either form, so an async export never gets swallowed into the prior body.
    const start = source.search(new RegExp(`export (?:async )?function ${fnName}\\b`))
    expect(start).toBeGreaterThan(-1)
    const rest = source.slice(start + 1)
    const next = rest.search(/\nexport (?:async )?(function|interface|type|const) /)
    return next === -1 ? rest : rest.slice(0, next)
  }

  it('fetchJobHistory passes --repo on every gh run list / gh run view call', () => {
    const body = bodyOf('fetchJobHistory')
    expect(body).toContain("'list'")
    expect(body).toContain("'view'")
    const repoCount = (body.match(/'--repo'/g) ?? []).length
    expect(repoCount).toBeGreaterThanOrEqual(2)
  })

  it('fetchRequiredContexts does NOT pass --repo on gh api calls (gh api rejects --repo → fail-open)', () => {
    const body = bodyOf('fetchRequiredContexts')
    expect(body).toContain("'api'")
    expect(body).not.toContain("'--repo'")
  })
})

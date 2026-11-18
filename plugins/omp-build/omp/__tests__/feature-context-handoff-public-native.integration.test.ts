import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { cleanupFeatureRecoveryRoots, featureFixture } from '../../testing/feature-recovery-fixture.ts'
import { git } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/feature-context-handoff-public-native-worker.ts')
const planner = resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')

afterEach(cleanupFeatureRecoveryRoots)

type PublicNativeReport = {
  mode: 'public-same-session-handoff'
  called: boolean
  dispatches: string[]
  handoffDispatches: string[]
  children: string[]
  errors: unknown[]
  outsidePath: string
  outsideExistsAfterProduce: boolean
  outsideRealPathAfterProduce: string
  checkoutPorcelainAfterProduce: string
  negativeRecordId: string
  retainedNegative: string
  retainedAfter: string | null
  changedVersion: string
  material: unknown
  abandonNotifications: string[]
  newNotifications: string[]
  continuationInhibited: boolean
  planStartRecordId: string
  planResultRecordId: string
  planReviewStartRecordId: string
  planReviewResultRecordId: string
  syntheticConfirmation: boolean
}

it('same-session public abandon then context-handoff new settles fresh plan and plan-review through installed host', () => {
  const { box, checkout: originalCheckout } = featureFixture('mandate')
  const worktreeRoot = join(box.root, 'context-worktrees')
  const checkout = join(worktreeRoot, 'app', 'feat-42-save')
  mkdirSync(join(worktreeRoot, 'app'), { recursive: true })
  git(box, box.principal, ['worktree', 'move', originalCheckout, checkout])
  const outsidePath = join(box.root, 'outside', 'fictional-outside-effect.txt')
  const gh = join(box.root, 'bin', 'gh')
  unlinkSync(gh)
  symlinkSync(fault, gh)
  mkdirSync(join(box.root, 'gh-config'))
  mkdirSync(join(box.root, 'outside'), { recursive: true })
  const env: NodeJS.ProcessEnv = {
    ...box.env,
    HOME: box.root,
    GH_CONFIG_DIR: join(box.root, 'gh-config'),
    GH_SIM_STATE: box.stateFile,
    RECOVERY_TEST_CREDENTIAL: 'fixture-model-only',
    OMP_WORKTREE_DIR: worktreeRoot,
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'])
    delete env[key]

  const prepared = spawnSync(bun, [planner, checkout, 'positive-both'], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(prepared.status, `Planning failed: ${prepared.stderr}\n${prepared.stdout}`).toBe(0)
  expect(JSON.parse(prepared.stdout).selected).toMatchObject({ kind: 'action', node: 'plan' })

  const child = spawnSync(bun, [worker, checkout, box.root, box.stateFile, outsidePath], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 55_000,
  })
  expect(child.status, `signal=${child.signal} error=${String(child.error)}\n${child.stderr}\n${child.stdout}`).toBe(0)
  const line = child.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"'))
  if (line === undefined) throw new Error(`public-native-worker-report-missing:\n${child.stderr}\n${child.stdout}`)
  const report = JSON.parse(line) as PublicNativeReport

  expect(report.mode).toBe('public-same-session-handoff')
  expect(report.syntheticConfirmation).toBe(true)
  expect(report.called).toBe(true)
  expect(report.errors).toEqual([])
  expect(report.outsideExistsAfterProduce).toBe(true)
  expect(report.outsideRealPathAfterProduce.startsWith(`${realpathSync(checkout)}/`)).toBe(false)
  expect(report.checkoutPorcelainAfterProduce).toBe('')
  expect(report.retainedAfter).toBe(report.retainedNegative)

  // F5 discrimination: public delivery must activate and settle plan/review, not stop as continuation-inhibited.
  expect(report.continuationInhibited).toBe(false)
  expect(report.handoffDispatches.length).toBeGreaterThanOrEqual(2)
  expect(report.planStartRecordId.length).toBeGreaterThan(0)
  expect(report.planResultRecordId.length).toBeGreaterThan(0)
  expect(report.planReviewStartRecordId.length).toBeGreaterThan(0)
  expect(report.planReviewResultRecordId.length).toBeGreaterThan(0)
  expect(report.planStartRecordId).not.toBe(report.planResultRecordId)
  expect(report.planReviewStartRecordId).not.toBe(report.planReviewResultRecordId)
}, 60_000)

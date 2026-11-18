import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, realpathSync, symlinkSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { NativeToolObservation } from '../../engine/native-tool-observation-schema.ts'
import { cleanupFeatureRecoveryRoots, featureFixture } from '../../testing/feature-recovery-fixture.ts'
import { git } from '../../testing/sandbox/sandbox-repository.ts'

const bun = execFileSync('which', ['bun'], { encoding: 'utf8' }).trim()
const worker = resolve(import.meta.dirname, '../../testing/context-external-effect-worker.ts')
const planner = resolve(import.meta.dirname, '../../testing/feature-planner-context-runner.ts')
const fault = resolve(import.meta.dirname, '../../testing/fix-recovery-gh-fault.ts')

afterEach(cleanupFeatureRecoveryRoots)

type WorkerReport = {
  mode: 'attributed-success' | 'recreate-preselection'
  called: boolean
  dispatches: string[]
  children: string[]
  errors: unknown[]
  outsidePath: string
  outsideExistsAfterProduce: boolean
  outsideRealPathAfterProduce: string
  outsideExistsAfterCleanup: boolean
  checkoutPorcelainAfterProduce: string
  negativeRecordId: string
  retainedNegative: string
  retainedAfter: string | null
  observedTools: NativeToolObservation | null
  structured: unknown
  continueWithoutHandoff: { kind: string; reason?: string }
  unresolvedHandoff: { kind: string; reason?: string }
  coldContinue: { kind: string; reason?: string }
  coldWaivesEffects: boolean
  recreateBeforeSelection: { kind: string; reason?: string } | null
  publicationAfterRecreate: {
    mandateRecordIds: string[]
    selectSuccessorRecordIds: string[]
    selectSuccessorPublished: boolean
  } | null
  changedVersion: string
  material: unknown
  selected: { kind: string; node?: string; reason?: string }
  planned: { kind?: string; node?: string; published?: boolean; planned?: false; skipped?: boolean; reason?: string }
  genuineSdkNegative: boolean
  adapterHandoffContinuation: boolean
}

function runOutsideEffectWorker(mode: WorkerReport['mode']): WorkerReport {
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
  // Material reassessment authenticates prior frames: prepare the plan through
  // the maintained capture path, not eligiblePlan's generic configuration pin.
  const prepared = spawnSync(bun, [planner, checkout, 'positive-both'], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  })
  expect(prepared.status, `Planning failed: ${prepared.stderr}\n${prepared.stdout}`).toBe(0)
  expect(JSON.parse(prepared.stdout).selected).toMatchObject({ kind: 'action', node: 'plan' })
  const child = spawnSync(bun, [worker, checkout, box.root, box.stateFile, outsidePath, mode], {
    cwd: checkout,
    env,
    encoding: 'utf8',
    timeout: 55_000,
  })
  expect(child.status, `signal=${child.signal} error=${String(child.error)}\n${child.stderr}\n${child.stdout}`).toBe(0)
  const line = child.stdout
    .trim()
    .split('\n')
    .findLast((item) => item.startsWith('{"mode"') || item.startsWith('{"called"'))
  if (line === undefined) throw new Error(`outside-effect-worker-report-missing:\n${child.stderr}\n${child.stdout}`)
  const report = JSON.parse(line) as WorkerReport
  expect(report.mode).toBe(mode)
  expect(report.genuineSdkNegative).toBe(true)
  expect(report.called).toBe(true)
  expect(report.dispatches).toEqual(['outside-effect-native'])
  expect(report.children).toHaveLength(1)
  expect(report.errors).toEqual([])
  expect(report.outsideExistsAfterProduce).toBe(true)
  expect(report.outsidePath).toBe(outsidePath)
  expect(report.outsideRealPathAfterProduce.startsWith(`${realpathSync(checkout)}/`)).toBe(false)
  expect(report.checkoutPorcelainAfterProduce).toBe('')
  expect(report.structured).toMatchObject({
    outcome: 'blocked',
    commitSHAs: [],
    commands: [],
    reason: expect.stringMatching(/unreconciled outside-effect/i),
  })
  expect(report.observedTools).toMatchObject({
    format: 'omp-build-native-tool-observation/1',
    scope: 'guarded-tool-admission',
    boundary: 'closed',
    closedBy: 'settlement-fence',
  })
  const bash = report.observedTools?.calls.filter((call) => call.toolName === 'bash') ?? []
  expect(bash).toHaveLength(1)
  expect(bash[0]).toMatchObject({
    completion: 'returned',
    isError: false,
    exitCode: 0,
    inputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
    resultDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
  })
  expect(report.continueWithoutHandoff).toMatchObject({ kind: 'blocked' })
  expect(report.unresolvedHandoff).toMatchObject({ kind: 'blocked', reason: expect.stringMatching(/unresolved/i) })
  expect(report.coldWaivesEffects).toBe(false)
  expect(report.coldContinue).toMatchObject({ kind: 'blocked' })
  expect(report.outsideExistsAfterCleanup).toBe(false)
  expect(report.retainedAfter).toBe(report.retainedNegative)
  return report
}

it('conserves a genuine outside-effect SDK negative and only admits attributed host-verified succession', () => {
  const report = runOutsideEffectWorker('attributed-success')
  expect(report.adapterHandoffContinuation).toBe(true)
  expect(report.recreateBeforeSelection).toBeNull()
  expect(report.selected, JSON.stringify(report.selected)).toMatchObject({ kind: 'action', node: 'plan' })
  expect(report.planned).toMatchObject({ published: true, reviewPublished: true })
}, 60_000)

it('refuses the final preselection observation when the named outside file is recreated after three conserved samples', () => {
  const report = runOutsideEffectWorker('recreate-preselection')
  expect(report.recreateBeforeSelection).toMatchObject({
    kind: 'blocked',
    reason: expect.stringMatching(/preselection/i),
  })
  expect(report.publicationAfterRecreate).not.toBeNull()
  expect(report.publicationAfterRecreate?.selectSuccessorPublished).toBe(false)
  expect(report.publicationAfterRecreate?.selectSuccessorRecordIds).toEqual([])
  // Partial successor mandate may exist after premandate publish; never treat that as authority adoption.
  expect(report.selected).toMatchObject({
    kind: 'skipped',
    reason: 'isolated-attributed-success-required-after-partial-preselection-refuse',
  })
  expect(report.planned).toMatchObject({
    skipped: true,
    reason: expect.stringMatching(/partial-successor-mandate-without-select-successor/),
  })
}, 60_000)
